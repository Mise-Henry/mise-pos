// ============================================================
//  MISE — Payment, Receipt & Shift Routes
//
//  PAYMENTS
//    GET    /payments/orders/:orderId          — order payment status
//    POST   /payments/orders/:orderId          — process payment
//    POST   /payments/orders/:orderId/split    — split payment
//    POST   /payments/orders/:orderId/refund   — refund
//
//  RECEIPTS
//    GET    /payments/receipts/:orderId        — get/generate receipt
//    GET    /payments/receipts/:orderId/text   — plain text (thermal)
//    POST   /payments/receipts/:orderId/send   — email/SMS/print
//
//  SHIFTS
//    GET    /payments/shifts                   — list shifts
//    GET    /payments/shifts/current           — current open shift
//    GET    /payments/shifts/live              — live summary mid-shift
//    GET    /payments/shifts/:shiftId          — historical shift
//    POST   /payments/shifts/open              — open shift
//    POST   /payments/shifts/close             — close shift + Z-report
// ============================================================

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireRole, requirePermission } from "../../middleware/auth.middleware";
import {
  getOrderPayments, processPayment, processSplitPayment,
  refundPayment, PaymentError,
} from "../payment/payment.service";
import {
  getReceipt, sendReceipt, formatReceiptText, buildReceiptData,
} from "../receipt/receipt.service";
import {
  openShift, closeShift, getCurrentShift,
  getLiveShiftSummary, getShifts, getShift,
} from "../shift/shift.service";

// ── Zod schemas ───────────────────────────────────────────────

const PaymentSchema = z.object({
  method:    z.enum(["CASH", "CREDIT_CARD", "DEBIT_CARD", "ONLINE", "VOUCHER", "MIXED"]),
  amount:    z.number().positive(),
  tendered:  z.number().positive().optional(),
  reference: z.string().optional(),
  note:      z.string().optional(),
});

const SplitPaymentSchema = z.object({
  payments: z.array(z.object({
    method:    z.enum(["CASH", "CREDIT_CARD", "DEBIT_CARD", "ONLINE", "VOUCHER"]),
    amount:    z.number().positive(),
    tendered:  z.number().positive().optional(),
    reference: z.string().optional(),
  })).min(2, "Split payment requires at least 2 payment methods"),
});

const RefundSchema = z.object({
  paymentId: z.string().min(1),
  amount:    z.number().positive().optional(),
  reason:    z.string().min(1, "Refund reason is required"),
});

const SendReceiptSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  print: z.boolean().optional(),
}).refine(
  (d) => d.email || d.phone || d.print,
  "At least one of: email, phone, print must be specified"
);

const OpenShiftSchema = z.object({
  openingFloat: z.number().min(0),
  note:         z.string().optional(),
});

const CloseShiftSchema = z.object({
  closingCash: z.number().min(0),
  note:        z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────

function handleError(err: unknown, reply: any) {
  if (err instanceof PaymentError) {
    return reply.status(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

function validate<T>(schema: z.ZodSchema<T>, data: unknown, reply: any): T | null {
  const r = schema.safeParse(data);
  if (!r.success) {
    reply.status(400).send({
      error:   "VALIDATION_ERROR",
      message: r.error.issues[0].message,
      details: r.error.issues,
    });
    return null;
  }
  return r.data;
}

// ── Route registration ────────────────────────────────────────

export async function paymentRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);

  const getBranch = (req: any) => req.user.branchId!;
  const getUserId = (req: any) => req.user.userId;

  // ─── PAYMENTS ─────────────────────────────────────────────────

  // Get payment status + remaining due for an order
  fastify.get(
    "/orders/:orderId",
    { preHandler: [requirePermission("payments:read")] },
    async (req: any, reply) => {
      try { return reply.send(await getOrderPayments(getBranch(req), req.params.orderId)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // Process a single payment (cash or card)
  fastify.post(
    "/orders/:orderId",
    { preHandler: [requirePermission("payments:create")] },
    async (req: any, reply) => {
      const dto = validate(PaymentSchema, req.body, reply);
      if (!dto) return;
      try {
        const result = await processPayment(getBranch(req), req.params.orderId, getUserId(req), dto);

        // Auto-generate receipt on full payment
        if (result.isFullyPaid) {
          try {
            const { createReceipt } = await import("../receipt/receipt.service");
            await createReceipt(getBranch(req), req.params.orderId);
          } catch { /* non-blocking */ }
        }

        return reply.status(201).send(result);
      } catch (err) { return handleError(err, reply); }
    }
  );

  // Split payment (cash + card, multiple cards, etc.)
  fastify.post(
    "/orders/:orderId/split",
    { preHandler: [requirePermission("payments:create")] },
    async (req: any, reply) => {
      const dto = validate(SplitPaymentSchema, req.body, reply);
      if (!dto) return;
      try {
        const results = await processSplitPayment(getBranch(req), req.params.orderId, getUserId(req), dto);

        // Auto-generate receipt
        if (results.at(-1)?.isFullyPaid) {
          try {
            const { createReceipt } = await import("../receipt/receipt.service");
            await createReceipt(getBranch(req), req.params.orderId);
          } catch { /* non-blocking */ }
        }

        return reply.status(201).send(results);
      } catch (err) { return handleError(err, reply); }
    }
  );

  // Refund (manager only)
  fastify.post(
    "/orders/:orderId/refund",
    { preHandler: [requireRole("MANAGER")] },
    async (req: any, reply) => {
      const dto = validate(RefundSchema, req.body, reply);
      if (!dto) return;
      try {
        return reply.send(await refundPayment(getBranch(req), req.params.orderId, getUserId(req), dto));
      } catch (err) { return handleError(err, reply); }
    }
  );

  // ─── RECEIPTS ─────────────────────────────────────────────────

  // Get receipt (or auto-generate)
  fastify.get(
    "/receipts/:orderId",
    { preHandler: [requirePermission("receipts:create")] },
    async (req: any, reply) => {
      try { return reply.send(await getReceipt(getBranch(req), req.params.orderId)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // Plain-text receipt (for thermal ESC/POS printers)
  fastify.get(
    "/receipts/:orderId/text",
    { preHandler: [requirePermission("receipts:create")] },
    async (req: any, reply) => {
      try {
        const data = await buildReceiptData(getBranch(req), req.params.orderId);
        const text = formatReceiptText(data);
        return reply
          .header("Content-Type", "text/plain; charset=utf-8")
          .send(text);
      } catch (err) { return handleError(err, reply); }
    }
  );

  // Send receipt via email / SMS / print
  fastify.post(
    "/receipts/:orderId/send",
    { preHandler: [requirePermission("receipts:create")] },
    async (req: any, reply) => {
      const dto = validate(SendReceiptSchema, req.body, reply);
      if (!dto) return;
      try { return reply.send(await sendReceipt(getBranch(req), req.params.orderId, dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // ─── SHIFTS ───────────────────────────────────────────────────

  // List historical shifts
  fastify.get(
    "/shifts",
    { preHandler: [requireRole("MANAGER")] },
    async (req: any, reply) => {
      const page  = req.query?.page  ? parseInt(req.query.page)  : 1;
      const limit = req.query?.limit ? parseInt(req.query.limit) : 20;
      try { return reply.send(await getShifts(getBranch(req), page, limit)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // Current open shift
  fastify.get(
    "/shifts/current",
    { preHandler: [requirePermission("shifts:read")] },
    async (req, reply) => {
      try { return reply.send(await getCurrentShift(getBranch(req))); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // Live Z-report snapshot (mid-shift)
  fastify.get(
    "/shifts/live",
    { preHandler: [requirePermission("shifts:read")] },
    async (req, reply) => {
      try { return reply.send(await getLiveShiftSummary(getBranch(req))); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // Single historical shift + its Z-report
  fastify.get(
    "/shifts/:shiftId",
    { preHandler: [requireRole("MANAGER")] },
    async (req: any, reply) => {
      try { return reply.send(await getShift(getBranch(req), req.params.shiftId)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // Open shift (start of day)
  fastify.post(
    "/shifts/open",
    { preHandler: [requirePermission("shifts:*")] },
    async (req, reply) => {
      const dto = validate(OpenShiftSchema, req.body, reply);
      if (!dto) return;
      try { return reply.status(201).send(await openShift(getBranch(req), getUserId(req), dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // Close shift (end of day — generates Z-report)
  fastify.post(
    "/shifts/close",
    { preHandler: [requireRole("MANAGER")] },
    async (req, reply) => {
      const dto = validate(CloseShiftSchema, req.body, reply);
      if (!dto) return;
      try { return reply.send(await closeShift(getBranch(req), getUserId(req), dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );
}
