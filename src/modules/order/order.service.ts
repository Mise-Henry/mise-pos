// ============================================================
//  MISE — Order Service
//  Full order lifecycle: create → add items → send to kitchen
//  → serve → close. Includes discounts, void, split bill.
// ============================================================

import { PrismaClient } from "@prisma/client";
import { wsManager } from "../websocket/ws.manager";
import {
  generateOrderNumber,
  syncOrderTotals,
  calculateDiscountAmount,
} from "../../utils/order.utils";
import type {
  CreateOrderDto,
  UpdateOrderDto,
  AddItemDto,
  UpdateItemDto,
  ApplyDiscountDto,
  SplitBillDto,
  SendToKitchenDto,
  OrderQueryParams,
  OrderStatus,
  ItemStatus,
} from "../../types/order.types";
import { ORDER_STATUS_TRANSITIONS } from "../../types/order.types";

const prisma = new PrismaClient();

// ── Custom error ──────────────────────────────────────────────

export class OrderError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "OrderError";
  }
}

// ── Full order include (reused across queries) ─────────────────

const ORDER_INCLUDE = {
  table:    { select: { id: true, name: true, section: { select: { name: true } } } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  closedBy:  { select: { id: true, firstName: true, lastName: true } },
  items: {
    where:   { status: { notIn: ["VOID"] as any[] } },
    orderBy: [
      { courseNumber: "asc" as const },
      { createdAt:    "asc" as const },
    ],
    include: {
      product:   { select: { id: true, name: true, preparationTime: true } },
      modifiers: true,
    },
  },
  discounts: true,
  payments:  true,
} as const;

// ── Helpers ───────────────────────────────────────────────────

async function assertOrder(branchId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, branchId },
  });
  if (!order) throw new OrderError("NOT_FOUND", "Order not found", 404);
  return order;
}

function assertNotClosed(order: { status: string }) {
  if (["CLOSED", "CANCELLED", "VOID"].includes(order.status)) {
    throw new OrderError(
      "ORDER_CLOSED",
      `Cannot modify a ${order.status.toLowerCase()} order`,
      409
    );
  }
}

// ── List orders ───────────────────────────────────────────────

export async function getOrders(branchId: string, params: OrderQueryParams = {}) {
  const {
    status,
    tableId,
    type,
    dateFrom,
    dateTo,
    search,
    page  = 1,
    limit = 50,
  } = params;

  const where: any = {
    branchId,
    ...(tableId && { tableId }),
    ...(type    && { type }),
    ...(search  && { orderNumber: { contains: search, mode: "insensitive" } }),
    ...(status  && {
      status: Array.isArray(status)
        ? { in: status }
        : status,
    }),
    ...(dateFrom || dateTo
      ? {
          createdAt: {
            ...(dateFrom && { gte: new Date(dateFrom) }),
            ...(dateTo   && { lte: new Date(dateTo)   }),
          },
        }
      : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: {
        table:     { select: { id: true, name: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        _count:    { select: { items: true } },
      },
      orderBy: { createdAt: "desc" },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.order.count({ where }),
  ]);

  return { items, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
}

// ── Active orders (for floor plan / KDS) ─────────────────────

export async function getActiveOrders(branchId: string) {
  return prisma.order.findMany({
    where:   {
      branchId,
      status: { notIn: ["CLOSED", "CANCELLED", "VOID"] },
    },
    include: ORDER_INCLUDE,
    orderBy: { createdAt: "asc" },
  });
}

// ── Get single order ──────────────────────────────────────────

export async function getOrderById(branchId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where:   { id: orderId, branchId },
    include: ORDER_INCLUDE,
  });
  if (!order) throw new OrderError("NOT_FOUND", "Order not found", 404);
  return order;
}

// ── Create order ──────────────────────────────────────────────

export async function createOrder(
  branchId: string,
  createdById: string,
  dto: CreateOrderDto
) {
  // Validate table
  if (dto.tableId) {
    const table = await prisma.table.findFirst({
      where: { id: dto.tableId, branchId, isActive: true },
    });
    if (!table) throw new OrderError("NOT_FOUND", "Table not found", 404);

    if (table.status === "INACTIVE") {
      throw new OrderError("TABLE_INACTIVE", "Table is inactive");
    }

    // Check for existing open order on this table
    const existingOrder = await prisma.order.findFirst({
      where: {
        tableId: dto.tableId,
        status:  { notIn: ["CLOSED", "CANCELLED", "VOID"] },
      },
    });
    if (existingOrder) {
      throw new OrderError(
        "TABLE_HAS_ORDER",
        `Table already has open order ${existingOrder.orderNumber}`,
        409
      );
    }
  }

  const orderNumber = await generateOrderNumber(branchId);

  const order = await prisma.$transaction(async (tx) => {
    const newOrder = await tx.order.create({
      data: {
        branchId,
        tableId:         dto.tableId    ?? null,
        orderNumber,
        type:            dto.type       ?? "DINE_IN",
        guestCount:      dto.guestCount ?? 1,
        notes:           dto.notes      ?? null,
        status:          "DRAFT",
        createdById,
        deliveryName:    dto.deliveryName    ?? null,
        deliveryPhone:   dto.deliveryPhone   ?? null,
        deliveryAddress: dto.deliveryAddress ?? null,
        subtotal:        0,
        taxAmount:       0,
        discountAmount:  0,
        total:           0,
      },
      include: ORDER_INCLUDE,
    });

    // Auto-set table as OCCUPIED
    if (dto.tableId) {
      await tx.table.update({
        where: { id: dto.tableId },
        data:  { status: "OCCUPIED" },
      });
    }

    return newOrder;
  });

  // Broadcast to all branch terminals
  wsManager.broadcast(branchId, "ORDER_CREATED", {
    orderId:     order.id,
    orderNumber: order.orderNumber,
    tableId:     order.tableId,
    tableName:   order.table?.name,
    type:        order.type,
  });

  return order;
}

// ── Update order metadata ─────────────────────────────────────

export async function updateOrder(
  branchId: string,
  orderId: string,
  dto: UpdateOrderDto
) {
  const order = await assertOrder(branchId, orderId);
  assertNotClosed(order);

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      ...(dto.guestCount      !== undefined && { guestCount:      dto.guestCount }),
      ...(dto.notes           !== undefined && { notes:           dto.notes }),
      ...(dto.deliveryName    !== undefined && { deliveryName:    dto.deliveryName }),
      ...(dto.deliveryPhone   !== undefined && { deliveryPhone:   dto.deliveryPhone }),
      ...(dto.deliveryAddress !== undefined && { deliveryAddress: dto.deliveryAddress }),
    },
    include: ORDER_INCLUDE,
  });

  wsManager.broadcast(branchId, "ORDER_UPDATED", { orderId, orderNumber: updated.orderNumber });
  return updated;
}

// ── Add item to order ─────────────────────────────────────────

export async function addItem(
  branchId: string,
  orderId: string,
  dto: AddItemDto
) {
  const order = await assertOrder(branchId, orderId);
  assertNotClosed(order);

  // Fetch product — validate it belongs to this branch and is available
  const product = await prisma.product.findFirst({
    where: { id: dto.productId, branchId, isActive: true },
  });
  if (!product) throw new OrderError("NOT_FOUND", "Product not found", 404);

  if (!product.isAvailable) {
    throw new OrderError("PRODUCT_UNAVAILABLE", `${product.name} is currently unavailable (86'd)`);
  }

  // Validate and fetch modifiers
  let modifierData: Array<{ modifierId: string; name: string; price: number }> = [];
  if (dto.modifierIds?.length) {
    const modifiers = await prisma.modifier.findMany({
      where: { id: { in: dto.modifierIds }, isActive: true },
    });

    if (modifiers.length !== dto.modifierIds.length) {
      throw new OrderError("NOT_FOUND", "One or more modifiers not found");
    }

    modifierData = modifiers.map((m) => ({
      modifierId: m.id,
      name:       m.name,
      price:      Number(m.price),
    }));
  }

  const quantity = dto.quantity ?? 1;

  const item = await prisma.orderItem.create({
    data: {
      orderId,
      productId:    dto.productId,
      name:         product.name,         // snapshot
      price:        product.price,        // snapshot
      taxRate:      product.taxRate,      // snapshot
      quantity,
      notes:        dto.notes      ?? null,
      courseNumber: dto.courseNumber ?? 1,
      status:       "PENDING",
      modifiers:    modifierData.length
        ? {
            create: modifierData.map((m) => ({
              modifierId: m.modifierId,
              name:       m.name,
              price:      m.price,
            })),
          }
        : undefined,
    },
    include: {
      product:   { select: { id: true, name: true, preparationTime: true } },
      modifiers: true,
    },
  });

  // Recalculate totals
  await syncOrderTotals(orderId);

  wsManager.broadcast(branchId, "ORDER_UPDATED", {
    orderId,
    event:    "ITEM_ADDED",
    itemId:   item.id,
    itemName: item.name,
    quantity,
  });

  return item;
}

// ── Update item (quantity, notes, course) ─────────────────────

export async function updateItem(
  branchId: string,
  orderId: string,
  itemId: string,
  dto: UpdateItemDto
) {
  const order = await assertOrder(branchId, orderId);
  assertNotClosed(order);

  const item = await prisma.orderItem.findFirst({
    where: { id: itemId, orderId },
  });
  if (!item) throw new OrderError("NOT_FOUND", "Order item not found", 404);

  if (["READY", "SERVED"].includes(item.status)) {
    throw new OrderError(
      "ITEM_ALREADY_SERVED",
      "Cannot modify an item that is ready or already served"
    );
  }

  if (dto.quantity !== undefined && dto.quantity < 1) {
    throw new OrderError("INVALID_QUANTITY", "Quantity must be at least 1. Use remove to delete the item.");
  }

  const updated = await prisma.orderItem.update({
    where: { id: itemId },
    data: {
      ...(dto.quantity     !== undefined && { quantity:     dto.quantity }),
      ...(dto.notes        !== undefined && { notes:        dto.notes }),
      ...(dto.courseNumber !== undefined && { courseNumber: dto.courseNumber }),
    },
    include: { modifiers: true },
  });

  await syncOrderTotals(orderId);
  wsManager.broadcast(branchId, "ORDER_UPDATED", { orderId, event: "ITEM_UPDATED", itemId });

  return updated;
}

// ── Remove item ───────────────────────────────────────────────

export async function removeItem(
  branchId: string,
  orderId: string,
  itemId: string,
  removedById: string,
  reason?: string
) {
  const order = await assertOrder(branchId, orderId);
  assertNotClosed(order);

  const item = await prisma.orderItem.findFirst({
    where: { id: itemId, orderId },
  });
  if (!item) throw new OrderError("NOT_FOUND", "Order item not found", 404);

  // Items already sent to kitchen must be VOID (audit trail), not deleted
  const requiresVoid = ["SENT", "IN_PROGRESS", "READY"].includes(item.status);

  await prisma.$transaction(async (tx) => {
    await tx.orderItem.update({
      where: { id: itemId },
      data:  { status: requiresVoid ? "VOID" : "CANCELLED" },
    });

    // Log void to audit trail
    if (requiresVoid) {
      await tx.auditLog.create({
        data: {
          userId:     removedById,
          action:     "ORDER_ITEM_VOIDED",
          entityType: "OrderItem",
          entityId:   itemId,
          oldValue:   { status: item.status, name: item.name, quantity: item.quantity },
          newValue:   { status: "VOID", reason: reason ?? "No reason given" },
        },
      });
    }
  });

  await syncOrderTotals(orderId);
  wsManager.broadcast(branchId, "ORDER_UPDATED", { orderId, event: "ITEM_REMOVED", itemId });
  wsManager.broadcastToKitchen(branchId, "ITEM_STATUS_CHANGED", {
    orderId,
    itemId,
    status: requiresVoid ? "VOID" : "CANCELLED",
    reason,
  });

  return { message: "Item removed", voided: requiresVoid };
}

// ── Send to kitchen ───────────────────────────────────────────

export async function sendToKitchen(
  branchId: string,
  orderId: string,
  dto: SendToKitchenDto = {}
) {
  const order = await assertOrder(branchId, orderId);
  assertNotClosed(order);

  if (order.status === "CANCELLED") {
    throw new OrderError("ORDER_CANCELLED", "Order is cancelled");
  }

  // Find items to send
  const where: any = {
    orderId,
    status: "PENDING",
    ...(dto.itemIds?.length && { id: { in: dto.itemIds } }),
  };

  const pendingItems = await prisma.orderItem.findMany({ where });

  if (pendingItems.length === 0) {
    throw new OrderError("NO_PENDING_ITEMS", "No pending items to send to kitchen");
  }

  const now = new Date();

  await prisma.$transaction([
    // Mark items as SENT
    prisma.orderItem.updateMany({
      where: { id: { in: pendingItems.map((i) => i.id) } },
      data:  { status: "SENT", sentAt: now },
    }),
    // Update order status
    prisma.order.update({
      where: { id: orderId },
      data:  {
        status:           "SENT",
        sentToKitchenAt:  order.sentToKitchenAt ?? now, // only set first time
      },
    }),
  ]);

  const updatedOrder = await getOrderById(branchId, orderId);

  // Broadcast to KDS screens
  wsManager.broadcastToKitchen(branchId, "ORDER_SENT_TO_KITCHEN", {
    orderId,
    orderNumber: order.orderNumber,
    tableId:     order.tableId,
    tableName:   updatedOrder.table?.name,
    items: pendingItems.map((i) => ({
      id:           i.id,
      name:         i.name,
      quantity:     i.quantity,
      notes:        i.notes,
      courseNumber: i.courseNumber,
    })),
  });

  // Broadcast to all POS terminals
  wsManager.broadcast(branchId, "ORDER_SENT_TO_KITCHEN", {
    orderId,
    orderNumber: order.orderNumber,
    itemCount:   pendingItems.length,
  });

  return updatedOrder;
}

// ── Update item status (from KDS) ─────────────────────────────

export async function updateItemStatus(
  branchId: string,
  orderId: string,
  itemId: string,
  status: ItemStatus
) {
  const order = await assertOrder(branchId, orderId);

  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new OrderError("NOT_FOUND", "Item not found", 404);

  await prisma.orderItem.update({
    where: { id: itemId },
    data: {
      status,
      ...(status === "SERVED" && { servedAt: new Date() }),
    },
  });

  // Check if all items are ready → update order status
  if (status === "READY") {
    const nonReadyItems = await prisma.orderItem.count({
      where: {
        orderId,
        status: { notIn: ["READY", "SERVED", "CANCELLED", "VOID"] },
      },
    });

    if (nonReadyItems === 0) {
      await prisma.order.update({
        where: { id: orderId },
        data:  { status: "READY" },
      });

      wsManager.broadcast(branchId, "KDS_ITEM_READY", {
        orderId,
        orderNumber: order.orderNumber,
        tableName:   (await prisma.table.findUnique({ where: { id: order.tableId ?? "" } }))?.name,
        message:     "All items ready",
      });
    }
  }

  wsManager.broadcast(branchId, "ITEM_STATUS_CHANGED", {
    orderId,
    itemId,
    itemName: item.name,
    status,
  });

  return { itemId, status };
}

// ── Apply discount ────────────────────────────────────────────

export async function applyDiscount(
  branchId: string,
  orderId: string,
  appliedById: string,
  dto: ApplyDiscountDto
) {
  const order = await assertOrder(branchId, orderId);
  assertNotClosed(order);

  // Recalculate subtotal first
  const totals = await syncOrderTotals(orderId);

  const amount = calculateDiscountAmount(dto.type, dto.value, totals.subtotal);

  if (amount <= 0) {
    throw new OrderError("INVALID_DISCOUNT", "Discount amount must be greater than zero");
  }

  const discount = await prisma.orderDiscount.create({
    data: {
      orderId,
      name:        dto.name,
      type:        dto.type,
      value:       dto.value,
      amount,
      appliedById,
    },
  });

  // Audit log — discounts require a paper trail
  await prisma.auditLog.create({
    data: {
      userId:     appliedById,
      action:     "DISCOUNT_APPLIED",
      entityType: "Order",
      entityId:   orderId,
      newValue:   { name: dto.name, type: dto.type, value: dto.value, amount },
    },
  });

  await syncOrderTotals(orderId);
  wsManager.broadcast(branchId, "ORDER_UPDATED", { orderId, event: "DISCOUNT_APPLIED", amount });

  return discount;
}

// ── Remove discount ───────────────────────────────────────────

export async function removeDiscount(
  branchId: string,
  orderId: string,
  discountId: string,
  removedById: string
) {
  const order = await assertOrder(branchId, orderId);
  assertNotClosed(order);

  const discount = await prisma.orderDiscount.findFirst({
    where: { id: discountId, orderId },
  });
  if (!discount) throw new OrderError("NOT_FOUND", "Discount not found", 404);

  await prisma.orderDiscount.delete({ where: { id: discountId } });

  await prisma.auditLog.create({
    data: {
      userId:     removedById,
      action:     "DISCOUNT_REMOVED",
      entityType: "Order",
      entityId:   orderId,
      oldValue:   { name: discount.name, amount: Number(discount.amount) },
    },
  });

  await syncOrderTotals(orderId);
  return { message: "Discount removed" };
}

// ── Close order ───────────────────────────────────────────────

export async function closeOrder(
  branchId: string,
  orderId: string,
  closedById: string
) {
  const order = await assertOrder(branchId, orderId);

  if (["CLOSED", "CANCELLED", "VOID"].includes(order.status)) {
    throw new OrderError("ALREADY_CLOSED", `Order is already ${order.status.toLowerCase()}`);
  }

  // Verify fully paid
  const totals = await syncOrderTotals(orderId);
  const payments = await prisma.payment.findMany({
    where: { orderId, status: "COMPLETED" },
  });
  const paidTotal = payments.reduce((sum, p) => sum + Number(p.amount), 0);

  if (paidTotal < totals.total - 0.01) { // 0.01 tolerance for float rounding
    throw new OrderError(
      "UNPAID_BALANCE",
      `Order total is ${totals.total.toFixed(2)} but only ${paidTotal.toFixed(2)} has been paid`,
      409
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data:  { status: "CLOSED", closedById, closedAt: new Date() },
    });

    // Free the table
    if (order.tableId) {
      await tx.table.update({
        where: { id: order.tableId },
        data:  { status: "CLEANING" },
      });
    }
  });

  wsManager.broadcast(branchId, "ORDER_CLOSED", {
    orderId,
    orderNumber: order.orderNumber,
    tableId:     order.tableId,
    total:       totals.total,
  });

  return getOrderById(branchId, orderId);
}

// ── Cancel order ──────────────────────────────────────────────

export async function cancelOrder(
  branchId: string,
  orderId: string,
  cancelledById: string,
  reason: string
) {
  const order = await assertOrder(branchId, orderId);

  if (["CLOSED", "CANCELLED", "VOID"].includes(order.status)) {
    throw new OrderError("ALREADY_FINAL", `Order is already ${order.status.toLowerCase()}`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data:  { status: "CANCELLED", closedById: cancelledById, closedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        userId:     cancelledById,
        action:     "ORDER_CANCELLED",
        entityType: "Order",
        entityId:   orderId,
        oldValue:   { status: order.status },
        newValue:   { status: "CANCELLED", reason },
      },
    });

    if (order.tableId) {
      await tx.table.update({
        where: { id: order.tableId },
        data:  { status: "AVAILABLE" },
      });
    }
  });

  wsManager.broadcast(branchId, "ORDER_CANCELLED", {
    orderId,
    orderNumber: order.orderNumber,
    tableId:     order.tableId,
    reason,
  });

  return { message: `Order ${order.orderNumber} cancelled` };
}

// ── Void order (post-close, manager only) ─────────────────────

export async function voidOrder(
  branchId: string,
  orderId: string,
  voidedById: string,
  reason: string
) {
  const order = await assertOrder(branchId, orderId);

  if (order.status !== "CLOSED") {
    throw new OrderError("NOT_CLOSED", "Only closed orders can be voided", 409);
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data:  { status: "VOID" },
    });

    await tx.auditLog.create({
      data: {
        userId:     voidedById,
        action:     "ORDER_VOIDED",
        entityType: "Order",
        entityId:   orderId,
        oldValue:   { status: "CLOSED", total: order.total },
        newValue:   { status: "VOID",   reason },
      },
    });
  });

  return { message: `Order ${order.orderNumber} voided` };
}

// ── Get split bill preview ────────────────────────────────────

export async function getSplitBillPreview(branchId: string, orderId: string) {
  const order = await getOrderById(branchId, orderId);
  const totals = await syncOrderTotals(orderId);

  return {
    orderId,
    orderNumber:   order.orderNumber,
    items:         order.items,
    totals,
    suggestedSplits: {
      byItem:  "Split by item — each guest pays for what they ordered",
      equally: `Split equally — each guest pays ${(totals.total / (order.guestCount || 1)).toFixed(2)}`,
    },
  };
}
