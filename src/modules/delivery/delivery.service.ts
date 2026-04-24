// ============================================================
//  MISE — Delivery Platform Integration
//  Ingests orders from Yemeksepeti, Getir, Trendyol Yemek.
//  Each platform sends a webhook; we normalize, validate,
//  and create a standard POS order.
// ============================================================

import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import type { DeliveryOrder, DeliveryPlatform } from "../../types/integration.types";

const prisma = new PrismaClient();

export class DeliveryError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

// ── Platform webhook signature verification ───────────────────

export function verifyYemeksepeti(payload: string, signature: string): boolean {
  const secret   = process.env.YEMEKSEPETI_WEBHOOK_SECRET ?? "";
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function verifyGetir(payload: string, signature: string): boolean {
  const secret   = process.env.GETIR_WEBHOOK_SECRET ?? "";
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function verifyTrendyol(payload: string, apiKey: string, supplierId: string): boolean {
  const expected = `${process.env.TRENDYOL_API_KEY}:${process.env.TRENDYOL_API_SECRET}`;
  const header   = `${apiKey}:${supplierId}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

// ── Normalizers — convert each platform format to our schema ──

export function normalizeYemeksepeti(raw: any): DeliveryOrder {
  return {
    platformOrderId: String(raw.orderId ?? raw.id),
    platform:        "yemeksepeti",
    customerName:    raw.customer?.name ?? "Yemeksepeti Customer",
    customerPhone:   raw.customer?.phone ?? "",
    deliveryAddress: [
      raw.address?.street,
      raw.address?.district,
      raw.address?.city,
    ].filter(Boolean).join(", "),
    items: (raw.orderItems ?? raw.items ?? []).map((i: any) => ({
      name:     i.name ?? i.productName,
      quantity: i.quantity ?? i.count ?? 1,
      price:    Number(i.price ?? i.unitPrice ?? 0),
      notes:    i.note ?? i.specialInstructions ?? null,
    })),
    subtotal:    Number(raw.subtotal ?? raw.orderAmount ?? 0),
    deliveryFee: Number(raw.deliveryFee ?? raw.deliveryCost ?? 0),
    total:       Number(raw.total ?? raw.totalAmount ?? 0),
    estimatedDeliveryMinutes: Number(raw.estimatedDeliveryTime ?? 30),
    rawPayload: raw,
  };
}

export function normalizeGetir(raw: any): DeliveryOrder {
  return {
    platformOrderId: String(raw.id ?? raw.orderId),
    platform:        "getir",
    customerName:    `${raw.client?.firstName ?? ""} ${raw.client?.lastName ?? ""}`.trim() || "Getir Customer",
    customerPhone:   raw.client?.phone ?? "",
    deliveryAddress: raw.deliveryAddress?.fullAddress ?? raw.address ?? "",
    items: (raw.products ?? raw.items ?? []).map((i: any) => ({
      name:     i.name ?? i.productName,
      quantity: i.count ?? i.quantity ?? 1,
      price:    Number(i.price ?? 0),
      notes:    i.note ?? null,
    })),
    subtotal:    Number(raw.totalPrice ?? 0),
    deliveryFee: Number(raw.deliveryFee ?? 0),
    total:       Number(raw.totalAmount ?? raw.totalPrice ?? 0),
    estimatedDeliveryMinutes: Number(raw.deliveryTime ?? 25),
    rawPayload: raw,
  };
}

export function normalizeTrendyol(raw: any): DeliveryOrder {
  const order = raw.order ?? raw;
  return {
    platformOrderId: String(order.id ?? order.orderNumber),
    platform:        "trendyol",
    customerName:    order.customer?.fullName ?? "Trendyol Customer",
    customerPhone:   order.customer?.phone ?? "",
    deliveryAddress: order.shipmentAddress?.fullAddress ?? "",
    items: (order.lines ?? order.orderItems ?? []).map((i: any) => ({
      name:     i.productName ?? i.name,
      quantity: i.quantity ?? 1,
      price:    Number(i.price ?? i.unitPrice ?? 0),
      notes:    i.note ?? null,
    })),
    subtotal:    Number(order.totalPrice ?? 0),
    deliveryFee: Number(order.deliveryFee ?? 0),
    total:       Number(order.grossAmount ?? order.totalPrice ?? 0),
    estimatedDeliveryMinutes: 35,
    rawPayload: raw,
  };
}

// ── Create POS order from delivery order ──────────────────────
// Maps delivery platform items to our products by name matching.
// If a product isn't found, it's created as a generic line item.

export async function createOrderFromDelivery(
  branchId:      string,
  delivery:      DeliveryOrder
): Promise<{ orderId: string; orderNumber: string; matched: number; unmatched: number }> {
  // Check for duplicate (idempotent)
  const existing = await (prisma as any).deliveryOrder?.findFirst({
    where: { platformOrderId: delivery.platformOrderId, platform: delivery.platform },
  });
  if (existing) {
    return {
      orderId:     existing.orderId,
      orderNumber: existing.orderNumber ?? "",
      matched:     0,
      unmatched:   0,
    };
  }

  // Generate order number
  const today    = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const count    = await prisma.order.count({ where: { branchId, createdAt: { gte: new Date(new Date().toDateString()) } } });
  const orderNum = `ORD-${String(count + 1).padStart(4, "0")}`;

  // Match delivery items to our product catalogue
  let matched   = 0;
  let unmatched = 0;

  const order = await prisma.$transaction(async (tx) => {
    const newOrder = await tx.order.create({
      data: {
        branchId,
        orderNumber:     orderNum,
        type:            "DELIVERY",
        status:          "DRAFT",
        guestCount:      1,
        deliveryName:    delivery.customerName,
        deliveryPhone:   delivery.customerPhone,
        deliveryAddress: delivery.deliveryAddress,
        notes:           `${delivery.platform.toUpperCase()} order #${delivery.platformOrderId}`,
        subtotal:        delivery.subtotal,
        taxAmount:       0,
        discountAmount:  0,
        total:           delivery.total,
        createdById:     "system",
      },
    });

    for (const item of delivery.items) {
      // Try to find product by name (case-insensitive)
      const product = await tx.product.findFirst({
        where: {
          branchId,
          isActive:    true,
          name:        { contains: item.name, mode: "insensitive" },
        },
      });

      if (product) {
        matched++;
        await tx.orderItem.create({
          data: {
            orderId:     newOrder.id,
            productId:   product.id,
            name:        product.name,
            price:       product.price,
            taxRate:     product.taxRate,
            quantity:    item.quantity,
            notes:       item.notes ?? null,
            courseNumber: 1,
            status:      "PENDING",
          },
        });
      } else {
        unmatched++;
        // Create a placeholder product for unrecognized items
        await tx.orderItem.create({
          data: {
            orderId:   newOrder.id,
            productId: await getOrCreatePlaceholderProduct(tx, branchId),
            name:      `[${delivery.platform.toUpperCase()}] ${item.name}`,
            price:     item.price,
            taxRate:   8,
            quantity:  item.quantity,
            notes:     item.notes ?? null,
            courseNumber: 1,
            status:    "PENDING",
          },
        });
      }
    }

    return newOrder;
  });

  // Log the delivery order
  await (prisma as any).auditLog?.create({
    data: {
      userId:     "system",
      action:     "DELIVERY_ORDER_RECEIVED",
      entityType: "Order",
      entityId:   order.id,
      newValue:   {
        platform:        delivery.platform,
        platformOrderId: delivery.platformOrderId,
        total:           delivery.total,
        matched,
        unmatched,
      },
    },
  });

  return { orderId: order.id, orderNumber: orderNum, matched, unmatched };
}

// ── Accept / reject order on platform ────────────────────────
// Each platform has an API to confirm or reject the incoming order.

export async function acceptDeliveryOrder(platform: DeliveryPlatform, platformOrderId: string): Promise<void> {
  const axios = (await import("axios")).default;

  switch (platform) {
    case "yemeksepeti":
      await axios.post(
        `${process.env.YEMEKSEPETI_API_URL}/orders/${platformOrderId}/accept`,
        {},
        { headers: { Authorization: `Bearer ${process.env.YEMEKSEPETI_API_KEY}` } }
      );
      break;

    case "getir":
      await axios.put(
        `${process.env.GETIR_API_URL}/integration/orders/${platformOrderId}/status`,
        { status: "Accepted" },
        { headers: { Authorization: `Bearer ${process.env.GETIR_API_KEY}` } }
      );
      break;

    case "trendyol":
      await axios.put(
        `${process.env.TRENDYOL_API_URL}/suppliers/${process.env.TRENDYOL_SUPPLIER_ID}/orders/${platformOrderId}/status`,
        { status: "Picking" },
        {
          auth: {
            username: process.env.TRENDYOL_API_KEY!,
            password: process.env.TRENDYOL_API_SECRET!,
          },
        }
      );
      break;
  }
}

// ── Helper: get or create placeholder product ─────────────────

async function getOrCreatePlaceholderProduct(tx: any, branchId: string): Promise<string> {
  const placeholder = await tx.product.findFirst({
    where: { branchId, sku: "DELIVERY_PLACEHOLDER" },
  });

  if (placeholder) return placeholder.id;

  // Find or create a "Delivery Items" category
  let cat = await tx.category.findFirst({
    where: { branchId, name: "Delivery Items" },
  });

  if (!cat) {
    cat = await tx.category.create({
      data: { branchId, name: "Delivery Items", sortOrder: 999 },
    });
  }

  const product = await tx.product.create({
    data: {
      branchId,
      categoryId:  cat.id,
      name:        "Delivery Item",
      price:       0,
      taxRate:     8,
      sku:         "DELIVERY_PLACEHOLDER",
      isAvailable: false,   // not shown on POS menu
    },
  });

  return product.id;
}
