// ============================================================
//  MISE — KDS Service (Kitchen Display System)
//  The KDS shows all active kitchen tickets, ordered by time.
//  Kitchen staff mark items ready from here.
// ============================================================

import { PrismaClient } from "@prisma/client";
import { wsManager } from "../websocket/ws.manager";
import { OrderError } from "../order/order.service";

const prisma = new PrismaClient();

// ── Get kitchen queue ─────────────────────────────────────────
// Returns all SENT / IN_PROGRESS items grouped by order.
// This is the primary endpoint the KDS screen polls/subscribes to.

export async function getKitchenQueue(branchId: string) {
  const orders = await prisma.order.findMany({
    where: {
      branchId,
      status: { in: ["SENT", "IN_PROGRESS", "READY"] },
    },
    include: {
      table:     { select: { id: true, name: true, section: { select: { name: true } } } },
      createdBy: { select: { firstName: true, lastName: true } },
      items: {
        where:   { status: { in: ["SENT", "IN_PROGRESS", "READY"] } },
        orderBy: [
          { courseNumber: "asc" },
          { sentAt:       "asc" },
        ],
        include: { modifiers: { where: { price: { gt: 0 } } } },
      },
    },
    orderBy: { sentToKitchenAt: "asc" }, // oldest first
  });

  // Annotate with elapsed time (how long the ticket has been waiting)
  const now = Date.now();
  return orders.map((order) => ({
    ...order,
    elapsedSeconds: order.sentToKitchenAt
      ? Math.floor((now - order.sentToKitchenAt.getTime()) / 1000)
      : 0,
    isUrgent: order.sentToKitchenAt
      ? (now - order.sentToKitchenAt.getTime()) > 15 * 60 * 1000 // >15 min
      : false,
    items: order.items.map((item) => ({
      ...item,
      elapsedSeconds: item.sentAt
        ? Math.floor((now - item.sentAt.getTime()) / 1000)
        : 0,
    })),
  }));
}

// ── Mark item as in progress ──────────────────────────────────

export async function startItem(branchId: string, orderId: string, itemId: string) {
  return updateKdsItemStatus(branchId, orderId, itemId, "IN_PROGRESS");
}

// ── Mark item as ready ────────────────────────────────────────

export async function markItemReady(branchId: string, orderId: string, itemId: string) {
  return updateKdsItemStatus(branchId, orderId, itemId, "READY");
}

// ── Mark entire order as ready ────────────────────────────────

export async function markOrderReady(branchId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where:   { id: orderId, branchId },
    include: { items: true, table: { select: { name: true } } },
  });
  if (!order) throw new OrderError("NOT_FOUND", "Order not found", 404);

  // Mark all active kitchen items as ready
  await prisma.orderItem.updateMany({
    where: { orderId, status: { in: ["SENT", "IN_PROGRESS"] } },
    data:  { status: "READY" },
  });

  await prisma.order.update({
    where: { id: orderId },
    data:  { status: "READY" },
  });

  // Notify all POS terminals that this order is ready to serve
  wsManager.broadcast(branchId, "KDS_ITEM_READY", {
    orderId,
    orderNumber: order.orderNumber,
    tableName:   order.table?.name,
    message:     "Order ready for service",
  });

  return { orderId, status: "READY" };
}

// ── Mark item as served (from waiter side) ────────────────────

export async function markItemServed(branchId: string, orderId: string, itemId: string) {
  return updateKdsItemStatus(branchId, orderId, itemId, "SERVED");
}

// ── Get order history for KDS (last N completed orders) ───────

export async function getKdsHistory(branchId: string, limit = 20) {
  return prisma.order.findMany({
    where:   {
      branchId,
      status:   { in: ["DELIVERED", "CLOSED"] },
      closedAt: { gte: new Date(Date.now() - 4 * 60 * 60 * 1000) }, // last 4h
    },
    include: {
      table: { select: { name: true } },
      items: {
        where:   { status: { in: ["SERVED", "READY"] } },
        orderBy: { courseNumber: "asc" },
      },
    },
    orderBy: { closedAt: "desc" },
    take:    limit,
  });
}

// ── Internal: update a single KDS item status ─────────────────

async function updateKdsItemStatus(
  branchId: string,
  orderId: string,
  itemId: string,
  status: "IN_PROGRESS" | "READY" | "SERVED"
) {
  const order = await prisma.order.findFirst({ where: { id: orderId, branchId } });
  if (!order) throw new OrderError("NOT_FOUND", "Order not found", 404);

  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new OrderError("NOT_FOUND", "Item not found", 404);

  // Validate KDS transition
  const validPrev: Record<string, string[]> = {
    IN_PROGRESS: ["SENT"],
    READY:       ["SENT", "IN_PROGRESS"],
    SERVED:      ["READY"],
  };

  if (!validPrev[status]?.includes(item.status)) {
    throw new OrderError(
      "INVALID_TRANSITION",
      `Cannot move item from ${item.status} to ${status}`,
      409
    );
  }

  await prisma.orderItem.update({
    where: { id: itemId },
    data:  {
      status,
      ...(status === "SERVED" && { servedAt: new Date() }),
    },
  });

  // Update order status if all items match
  if (status === "IN_PROGRESS") {
    await prisma.order.update({
      where: { id: orderId },
      data:  { status: "IN_PROGRESS" },
    });
  }

  wsManager.broadcast(branchId, "ITEM_STATUS_CHANGED", {
    orderId,
    orderNumber: order.orderNumber,
    itemId,
    itemName:    item.name,
    status,
  });

  return { itemId, orderId, status };
}
