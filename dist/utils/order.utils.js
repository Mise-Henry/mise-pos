// ============================================================
//  MISE — Order Utilities
// ============================================================

import { PrismaClient } from "@prisma/client";
import type { OrderTotals } from "../types/order.types";

const prisma = new PrismaClient();

// ── Order number generator ────────────────────────────────────
// Generates sequential human-readable order numbers per branch.
// Format: ORD-0001, ORD-0002, ... resets daily.

export async function generateOrderNumber(branchId: string): Promise<string> {
  const today     = new Date();
  const dateStr   = today.toISOString().slice(0, 10); // YYYY-MM-DD
  const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
  const endOfDay   = new Date(`${dateStr}T23:59:59.999Z`);

  const count = await prisma.order.count({
    where: {
      branchId,
      createdAt: { gte: startOfDay, lte: endOfDay },
    },
  });

  const seq = String(count + 1).padStart(4, "0");
  return `ORD-${seq}`;
}

// ── Calculate order totals ────────────────────────────────────
// Recomputes subtotal, tax, and total from live order items.
// Call after every add/remove/modifier change.

export async function calculateOrderTotals(orderId: string): Promise<OrderTotals> {
  const items = await prisma.orderItem.findMany({
    where:   { orderId, status: { notIn: ["CANCELLED", "VOID"] } },
    include: { modifiers: true },
  });

  const discounts = await prisma.orderDiscount.findMany({ where: { orderId } });

  let subtotal = 0;
  let taxAmount = 0;

  for (const item of items) {
    const modifierTotal = item.modifiers.reduce(
      (sum, m) => sum + Number(m.price),
      0
    );
    const lineBase = (Number(item.price) + modifierTotal) * item.quantity;
    const lineTax  = lineBase * (Number(item.taxRate) / 100);

    subtotal  += lineBase;
    taxAmount += lineTax;
  }

  const discountAmount = discounts.reduce(
    (sum, d) => sum + Number(d.amount),
    0
  );

  const total = Math.max(0, subtotal + taxAmount - discountAmount);

  return {
    subtotal:       parseFloat(subtotal.toFixed(2)),
    taxAmount:      parseFloat(taxAmount.toFixed(2)),
    discountAmount: parseFloat(discountAmount.toFixed(2)),
    total:          parseFloat(total.toFixed(2)),
  };
}

// ── Apply and persist totals ──────────────────────────────────

export async function syncOrderTotals(orderId: string): Promise<OrderTotals> {
  const totals = await calculateOrderTotals(orderId);

  await prisma.order.update({
    where: { id: orderId },
    data: {
      subtotal:       totals.subtotal,
      taxAmount:      totals.taxAmount,
      discountAmount: totals.discountAmount,
      total:          totals.total,
    },
  });

  return totals;
}

// ── Calculate discount amount from template ───────────────────

export function calculateDiscountAmount(
  type: "PERCENTAGE" | "FIXED_AMOUNT",
  value: number,
  subtotal: number
): number {
  if (type === "PERCENTAGE") {
    return parseFloat(((subtotal * value) / 100).toFixed(2));
  }
  return parseFloat(Math.min(value, subtotal).toFixed(2));
}
