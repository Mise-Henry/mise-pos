// ============================================================
//  MISE — Shift Service
//  Handles: shift open/close, Z-reports, cash reconciliation,
//           hourly sales breakdown, payment method totals.
// ============================================================

import { PrismaClient } from "@prisma/client";
import { PaymentError } from "../payment/payment.service";
import type { OpenShiftDto, CloseShiftDto, ShiftSummary } from "../../types/payment.types";
import type { PaymentMethod } from "../../types/payment.types";

const prisma = new PrismaClient();

// ── Open shift ────────────────────────────────────────────────

export async function openShift(branchId: string, openedById: string, dto: OpenShiftDto) {
  // Enforce one open shift per branch at a time
  const existing = await prisma.shift.findFirst({
    where: { branchId, closedAt: null },
  });

  if (existing) {
    throw new PaymentError(
      "SHIFT_ALREADY_OPEN",
      `A shift is already open (opened at ${existing.openedAt.toISOString()}). Close it first.`,
      409
    );
  }

  if (dto.openingFloat < 0) {
    throw new PaymentError("INVALID_FLOAT", "Opening float cannot be negative");
  }

  const shift = await prisma.shift.create({
    data: {
      branchId,
      openedById,
      openingFloat: dto.openingFloat,
      notes:        dto.note ?? null,
    },
    include: {
      openedBy: { select: { firstName: true, lastName: true } },
    },
  });

  await prisma.auditLog.create({
    data: {
      userId:     openedById,
      action:     "SHIFT_OPENED",
      entityType: "Shift",
      entityId:   shift.id,
      newValue:   { openingFloat: dto.openingFloat },
    },
  });

  return shift;
}

// ── Get current open shift ────────────────────────────────────

export async function getCurrentShift(branchId: string) {
  const shift = await prisma.shift.findFirst({
    where:   { branchId, closedAt: null },
    include: { openedBy: { select: { firstName: true, lastName: true } } },
  });

  if (!shift) throw new PaymentError("NO_OPEN_SHIFT", "No shift is currently open", 404);
  return shift;
}

// ── Close shift with Z-report ─────────────────────────────────

export async function closeShift(
  branchId: string,
  closedById: string,
  dto: CloseShiftDto
): Promise<ShiftSummary> {
  const shift = await prisma.shift.findFirst({
    where:   { branchId, closedAt: null },
    include: {
      openedBy: { select: { firstName: true, lastName: true } },
    },
  });

  if (!shift) throw new PaymentError("NO_OPEN_SHIFT", "No open shift found", 404);

  if (dto.closingCash < 0) {
    throw new PaymentError("INVALID_AMOUNT", "Closing cash cannot be negative");
  }

  // Check for unclosed orders
  const openOrders = await prisma.order.count({
    where: {
      branchId,
      status:    { notIn: ["CLOSED", "CANCELLED", "VOID"] },
      createdAt: { gte: shift.openedAt },
    },
  });

  if (openOrders > 0) {
    throw new PaymentError(
      "OPEN_ORDERS_EXIST",
      `${openOrders} order(s) still open. Close all orders before ending shift.`,
      409
    );
  }

  // Build Z-report summary
  const summary = await buildShiftSummary(branchId, shift.id, shift.openedAt);

  // Cash variance: actual counted vs expected
  const expectedCash   = Number(shift.openingFloat) + (summary.byPaymentMethod["CASH"] ?? 0);
  const cashVariance   = roundMoney(dto.closingCash - expectedCash);

  const finalSummary: ShiftSummary = {
    ...summary,
    closedAt:     new Date().toISOString(),
    openingFloat: Number(shift.openingFloat),
    closingCash:  dto.closingCash,
    expectedCash: roundMoney(expectedCash),
    cashVariance,
  };

  // Persist shift close + summary
  await prisma.$transaction(async (tx) => {
    await tx.shift.update({
      where: { id: shift.id },
      data: {
        closedById,
        closedAt:    new Date(),
        closingCash: dto.closingCash,
        notes:       dto.note ?? null,
        summary:     finalSummary as any,
      },
    });

    await tx.auditLog.create({
      data: {
        userId:     closedById,
        action:     "SHIFT_CLOSED",
        entityType: "Shift",
        entityId:   shift.id,
        newValue:   {
          closingCash:  dto.closingCash,
          expectedCash: expectedCash,
          variance:     cashVariance,
          netSales:     finalSummary.totals.netSales,
        },
      },
    });
  });

  return finalSummary;
}

// ── Get shift by ID (historical Z-reports) ────────────────────

export async function getShift(branchId: string, shiftId: string) {
  const shift = await prisma.shift.findFirst({
    where:   { id: shiftId, branchId },
    include: {
      openedBy: { select: { firstName: true, lastName: true } },
      closedBy: { select: { firstName: true, lastName: true } },
    },
  });
  if (!shift) throw new PaymentError("NOT_FOUND", "Shift not found", 404);
  return shift;
}

// ── List shifts ───────────────────────────────────────────────

export async function getShifts(branchId: string, page = 1, limit = 20) {
  const [items, total] = await prisma.$transaction([
    prisma.shift.findMany({
      where:   { branchId },
      include: {
        openedBy: { select: { firstName: true, lastName: true } },
        closedBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { openedAt: "desc" },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.shift.count({ where: { branchId } }),
  ]);
  return { items, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
}

// ── Live shift summary (mid-shift reporting) ──────────────────

export async function getLiveShiftSummary(branchId: string): Promise<ShiftSummary> {
  const shift = await getCurrentShift(branchId);
  return buildShiftSummary(branchId, shift.id, shift.openedAt);
}

// ── Build shift summary ───────────────────────────────────────

async function buildShiftSummary(
  branchId: string,
  shiftId: string,
  since: Date
): Promise<ShiftSummary> {
  const shift = await prisma.shift.findUnique({
    where:   { id: shiftId },
    include: { openedBy: { select: { firstName: true, lastName: true } } },
  });
  if (!shift) throw new PaymentError("NOT_FOUND", "Shift not found", 404);

  // All closed orders during this shift
  const orders = await prisma.order.findMany({
    where: {
      branchId,
      status:    "CLOSED",
      closedAt:  { gte: since },
    },
    include: {
      payments:  { where: { status: "COMPLETED" } },
      discounts: true,
    },
  });

  // Refunds
  const refundPayments = await prisma.payment.findMany({
    where: {
      order: { branchId },
      status:     "REFUNDED",
      createdAt:  { gte: since },
    },
  });

  // Aggregate totals
  let grossSales    = 0;
  let discountTotal = 0;
  let taxTotal      = 0;
  const byMethod: Partial<Record<PaymentMethod, number>> = {};

  for (const order of orders) {
    grossSales    += Number(order.subtotal) + Number(order.taxAmount);
    discountTotal += Number(order.discountAmount);
    taxTotal      += Number(order.taxAmount);

    for (const p of order.payments) {
      const m = p.method as PaymentMethod;
      byMethod[m] = roundMoney((byMethod[m] ?? 0) + Number(p.amount));
    }
  }

  const refundTotal = refundPayments.reduce((s, p) => s + Math.abs(Number(p.amount)), 0);
  const netSales    = roundMoney(grossSales - discountTotal - refundTotal);

  // Hourly breakdown
  const hourlyMap: Record<string, { sales: number; orders: number }> = {};
  for (const order of orders) {
    const hour = new Date(order.closedAt!).toISOString().slice(0, 13) + ":00"; // "2026-04-24T19:00"
    if (!hourlyMap[hour]) hourlyMap[hour] = { sales: 0, orders: 0 };
    hourlyMap[hour].sales  = roundMoney(hourlyMap[hour].sales + Number(order.total));
    hourlyMap[hour].orders += 1;
  }

  const hourlyBreakdown = Object.entries(hourlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, data]) => ({ hour, ...data }));

  return {
    shiftId:      shiftId,
    openedAt:     shift.openedAt.toISOString(),
    openedBy:     `${shift.openedBy.firstName} ${shift.openedBy.lastName}`,
    openingFloat: Number(shift.openingFloat),
    expectedCash: roundMoney(Number(shift.openingFloat) + (byMethod["CASH"] ?? 0)),
    totals: {
      orderCount:   orders.length,
      grossSales:   roundMoney(grossSales),
      discountTotal: roundMoney(discountTotal),
      taxTotal:     roundMoney(taxTotal),
      netSales,
      refundTotal:  roundMoney(refundTotal),
    },
    byPaymentMethod: byMethod as Record<PaymentMethod, number>,
    hourlyBreakdown,
  };
}

function roundMoney(n: number) {
  return Math.round(n * 100) / 100;
}
