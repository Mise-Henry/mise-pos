// ============================================================
//  MISE — Payment Service
//  Handles: cash, card, split payments, refunds, change calc
// ============================================================

import { PrismaClient } from "@prisma/client";
import { wsManager } from "../websocket/ws.manager";
import { syncOrderTotals } from "../../utils/order.utils";
import type {
  ProcessPaymentDto,
  SplitPaymentDto,
  RefundPaymentDto,
  PaymentResult,
  PaymentMethod,
} from "../../types/payment.types";

const prisma = new PrismaClient();

export class PaymentError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

// ── Helpers ───────────────────────────────────────────────────

async function assertOrder(branchId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, branchId },
  });
  if (!order) throw new PaymentError("NOT_FOUND", "Order not found", 404);
  return order;
}

async function getAmountPaid(orderId: string): Promise<number> {
  const payments = await prisma.payment.findMany({
    where: { orderId, status: "COMPLETED" },
  });
  return payments.reduce((sum, p) => sum + Number(p.amount), 0);
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Get payment status for an order ──────────────────────────

export async function getOrderPayments(branchId: string, orderId: string) {
  await assertOrder(branchId, orderId);

  const [payments, totals] = await Promise.all([
    prisma.payment.findMany({
      where:   { orderId },
      orderBy: { createdAt: "asc" },
    }),
    syncOrderTotals(orderId),
  ]);

  const paidAmount    = payments
    .filter((p) => p.status === "COMPLETED")
    .reduce((sum, p) => sum + Number(p.amount), 0);

  const refundedAmount = payments
    .filter((p) => p.status === "REFUNDED")
    .reduce((sum, p) => sum + Number(p.amount), 0);

  return {
    payments,
    totals,
    paidAmount:     roundMoney(paidAmount),
    refundedAmount: roundMoney(refundedAmount),
    remainingDue:   roundMoney(Math.max(0, totals.total - paidAmount)),
    isFullyPaid:    paidAmount >= totals.total - 0.01,
  };
}

// ── Process single payment ────────────────────────────────────

export async function processPayment(
  branchId: string,
  orderId: string,
  processedById: string,
  dto: ProcessPaymentDto
): Promise<PaymentResult> {
  const order = await assertOrder(branchId, orderId);

  if (["CLOSED", "CANCELLED", "VOID"].includes(order.status)) {
    throw new PaymentError("ORDER_CLOSED", `Cannot process payment for a ${order.status.toLowerCase()} order`);
  }

  const totals    = await syncOrderTotals(orderId);
  const alreadyPaid = await getAmountPaid(orderId);
  const remaining = roundMoney(totals.total - alreadyPaid);

  if (remaining <= 0) {
    throw new PaymentError("ALREADY_PAID", "Order is already fully paid", 409);
  }

  if (dto.amount <= 0) {
    throw new PaymentError("INVALID_AMOUNT", "Payment amount must be greater than zero");
  }

  // Amount cannot exceed what's still owed
  const payAmount = roundMoney(Math.min(dto.amount, remaining));

  // Cash: validate tendered ≥ amount
  let change = 0;
  if (dto.method === "CASH") {
    const tendered = dto.tendered ?? dto.amount;
    if (tendered < payAmount) {
      throw new PaymentError(
        "INSUFFICIENT_TENDER",
        `Tendered ${tendered.toFixed(2)} is less than amount due ${payAmount.toFixed(2)}`
      );
    }
    change = roundMoney(tendered - payAmount);
  }

  const payment = await prisma.payment.create({
    data: {
      orderId,
      method:      dto.method,
      status:      "COMPLETED",
      amount:      payAmount,
      tendered:    dto.method === "CASH" ? (dto.tendered ?? dto.amount) : null,
      change:      dto.method === "CASH" ? change : null,
      reference:   dto.reference ?? null,
      processedAt: new Date(),
    },
  });

  // Audit log
  await prisma.auditLog.create({
    data: {
      userId:     processedById,
      action:     "PAYMENT_PROCESSED",
      entityType: "Order",
      entityId:   orderId,
      newValue:   {
        paymentId: payment.id,
        method:    dto.method,
        amount:    payAmount,
        change,
      },
    },
  });

  const newRemaining = roundMoney(remaining - payAmount);
  const isFullyPaid  = newRemaining <= 0.01;

  // Auto-close order when fully paid
  if (isFullyPaid) {
    await prisma.order.update({
      where: { id: orderId },
      data:  {
        status:    "CLOSED",
        closedById: processedById,
        closedAt:  new Date(),
      },
    });

    // Free the table
    if (order.tableId) {
      await prisma.table.update({
        where: { id: order.tableId },
        data:  { status: "CLEANING" },
      });
    }

    wsManager.broadcast(branchId, "ORDER_CLOSED", {
      orderId,
      orderNumber: order.orderNumber,
      tableId:     order.tableId,
      total:       totals.total,
      method:      dto.method,
    });
  }

  return {
    paymentId:    payment.id,
    method:       dto.method,
    status:       "COMPLETED",
    amount:       payAmount,
    tendered:     dto.method === "CASH" ? (dto.tendered ?? dto.amount) : undefined,
    change:       dto.method === "CASH" ? change : undefined,
    reference:    dto.reference,
    remainingDue: newRemaining,
    isFullyPaid,
  };
}

// ── Split payment ─────────────────────────────────────────────
// Process multiple payment methods in one transaction.

export async function processSplitPayment(
  branchId: string,
  orderId: string,
  processedById: string,
  dto: SplitPaymentDto
): Promise<PaymentResult[]> {
  const order = await assertOrder(branchId, orderId);

  if (["CLOSED", "CANCELLED", "VOID"].includes(order.status)) {
    throw new PaymentError("ORDER_CLOSED", `Order is ${order.status.toLowerCase()}`);
  }

  const totals    = await syncOrderTotals(orderId);
  const alreadyPaid = await getAmountPaid(orderId);
  const remaining = roundMoney(totals.total - alreadyPaid);

  // Validate total of split payments matches or covers remaining
  const splitTotal = dto.payments.reduce((sum, p) => sum + p.amount, 0);
  if (splitTotal < remaining - 0.01) {
    throw new PaymentError(
      "INSUFFICIENT_PAYMENT",
      `Split total ${splitTotal.toFixed(2)} does not cover remaining ${remaining.toFixed(2)}`
    );
  }

  // Validate each cash tender
  for (const p of dto.payments) {
    if (p.method === "CASH" && p.tendered !== undefined && p.tendered < p.amount) {
      throw new PaymentError(
        "INSUFFICIENT_TENDER",
        `Cash tender ${p.tendered} is less than split amount ${p.amount}`
      );
    }
  }

  const results: PaymentResult[] = [];

  await prisma.$transaction(async (tx) => {
    let runningRemaining = remaining;

    for (const p of dto.payments) {
      const payAmount = roundMoney(Math.min(p.amount, runningRemaining));
      if (payAmount <= 0) continue;

      const change = p.method === "CASH"
        ? roundMoney((p.tendered ?? p.amount) - payAmount)
        : 0;

      const payment = await tx.payment.create({
        data: {
          orderId,
          method:      p.method,
          status:      "COMPLETED",
          amount:      payAmount,
          tendered:    p.method === "CASH" ? (p.tendered ?? p.amount) : null,
          change:      p.method === "CASH" ? change : null,
          reference:   p.reference ?? null,
          processedAt: new Date(),
        },
      });

      runningRemaining = roundMoney(runningRemaining - payAmount);

      results.push({
        paymentId:    payment.id,
        method:       p.method,
        status:       "COMPLETED",
        amount:       payAmount,
        tendered:     p.method === "CASH" ? (p.tendered ?? p.amount) : undefined,
        change:       p.method === "CASH" ? change : undefined,
        reference:    p.reference,
        remainingDue: runningRemaining,
        isFullyPaid:  runningRemaining <= 0.01,
      });
    }

    // Close order if fully covered
    if (runningRemaining <= 0.01) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status:     "CLOSED",
          closedById: processedById,
          closedAt:   new Date(),
        },
      });

      if (order.tableId) {
        await tx.table.update({
          where: { id: order.tableId },
          data:  { status: "CLEANING" },
        });
      }
    }

    await tx.auditLog.create({
      data: {
        userId:     processedById,
        action:     "SPLIT_PAYMENT_PROCESSED",
        entityType: "Order",
        entityId:   orderId,
        newValue:   { payments: dto.payments, total: splitTotal },
      },
    });
  });

  wsManager.broadcast(branchId, "ORDER_CLOSED", {
    orderId,
    orderNumber: order.orderNumber,
    total:       totals.total,
    splitCount:  dto.payments.length,
  });

  return results;
}

// ── Refund payment ────────────────────────────────────────────

export async function refundPayment(
  branchId: string,
  orderId: string,
  refundedById: string,
  dto: RefundPaymentDto
) {
  const order = await assertOrder(branchId, orderId);

  const payment = await prisma.payment.findFirst({
    where: { id: dto.paymentId, orderId },
  });
  if (!payment) throw new PaymentError("NOT_FOUND", "Payment not found", 404);

  if (payment.status === "REFUNDED") {
    throw new PaymentError("ALREADY_REFUNDED", "Payment has already been refunded");
  }

  const refundAmount = dto.amount ?? Number(payment.amount);
  if (refundAmount > Number(payment.amount)) {
    throw new PaymentError(
      "REFUND_EXCEEDS_PAYMENT",
      `Refund amount ${refundAmount} exceeds payment ${payment.amount}`
    );
  }

  const isFullRefund = refundAmount >= Number(payment.amount) - 0.01;

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: dto.paymentId },
      data:  { status: isFullRefund ? "REFUNDED" : "PARTIAL" },
    });

    // Create a negative payment record for the refund
    await tx.payment.create({
      data: {
        orderId,
        method:      payment.method,
        status:      "REFUNDED",
        amount:      -refundAmount,
        reference:   `REFUND:${payment.id}`,
        processedAt: new Date(),
      },
    });

    // Reopen order if it was closed
    if (order.status === "CLOSED") {
      await tx.order.update({
        where: { id: orderId },
        data:  { status: "DELIVERED" },
      });
    }

    await tx.auditLog.create({
      data: {
        userId:     refundedById,
        action:     "PAYMENT_REFUNDED",
        entityType: "Payment",
        entityId:   dto.paymentId,
        oldValue:   { status: payment.status, amount: Number(payment.amount) },
        newValue:   { refundAmount, reason: dto.reason },
      },
    });
  });

  return {
    paymentId:    dto.paymentId,
    refundAmount,
    isFullRefund,
    reason:       dto.reason,
    message:      `Refund of ${refundAmount.toFixed(2)} processed`,
  };
}

// ── Get payment methods summary for an order ──────────────────

export async function getPaymentSummary(branchId: string, orderId: string) {
  const info = await getOrderPayments(branchId, orderId);

  const byMethod: Partial<Record<PaymentMethod, number>> = {};
  for (const p of info.payments) {
    if (p.status === "COMPLETED") {
      const method = p.method as PaymentMethod;
      byMethod[method] = (byMethod[method] ?? 0) + Number(p.amount);
    }
  }

  return { ...info, byMethod };
}
