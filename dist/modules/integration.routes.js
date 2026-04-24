// ============================================================
//  MISE — Integration Routes
//
//  PAYMENT GATEWAY
//    POST /integrations/gateway/charge        — charge card
//    POST /integrations/gateway/refund        — refund
//    POST /integrations/gateway/:provider/webhook — provider callback
//
//  DELIVERY PLATFORMS
//    POST /integrations/delivery/yemeksepeti  — inbound webhook
//    POST /integrations/delivery/getir        — inbound webhook
//    POST /integrations/delivery/trendyol     — inbound webhook
//    POST /integrations/delivery/:platform/:orderId/accept
//
//  FISCAL / PRINTER
//    GET  /integrations/fiscal/devices        — list devices
//    POST /integrations/fiscal/devices        — register device
//    POST /integrations/fiscal/print          — print receipt
//
//  NOTIFICATIONS
//    POST /integrations/notify/sms            — send SMS
//    POST /integrations/notify/email          — send email
//    POST /integrations/notify/receipt-email  — send receipt email
//    POST /integrations/notify/receipt-sms    — send receipt SMS
//
//  WEBHOOKS (outbound)
//    GET  /integrations/webhooks              — list endpoints
//    POST /integrations/webhooks              — register endpoint
//    DELETE /integrations/webhooks/:id        — remove endpoint
//    GET  /integrations/webhooks/deliveries   — delivery log
// ============================================================

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.middleware";
import { chargeCard, refundCharge, GatewayError } from "../payment-gateway/gateway.service";
import {
  normalizeYemeksepeti, normalizeGetir, normalizeTrendyol,
  verifyYemeksepeti, verifyGetir, verifyTrendyol,
  createOrderFromDelivery, acceptDeliveryOrder, DeliveryError,
} from "../delivery/delivery.service";
import { submitFiscalReceipt, getFiscalDevices, createFiscalDevice, FiscalError } from "../fiscal/fiscal.service";
import { sendSms, sendEmail, sendReceiptEmail, sendSmsReceipt, NotificationError } from "../notifications/notification.service";
import {
  registerWebhook, getWebhooks, deleteWebhook,
  dispatchWebhook, getWebhookDeliveries,
} from "../webhooks/webhook.service";

// ── Schemas ───────────────────────────────────────────────────

const ChargeSchema = z.object({
  orderId:     z.string().min(1),
  amount:      z.number().positive(),
  currency:    z.string().default("TRY"),
  description: z.string().default("POS Payment"),
  card: z.object({
    number:   z.string().min(13),
    expMonth: z.number().int().min(1).max(12),
    expYear:  z.number().int().min(2024),
    cvc:      z.string().min(3).max(4),
    holder:   z.string().min(1),
  }).optional(),
  returnUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const RefundSchema = z.object({
  transactionId: z.string().min(1),
  amount:        z.number().positive().optional(),
  reason:        z.string().min(1),
});

const SmsSchema = z.object({
  to:      z.string().min(1),
  message: z.string().min(1).max(160),
});

const EmailSchema = z.object({
  to:      z.union([z.string().email(), z.array(z.string().email())]),
  subject: z.string().min(1),
  html:    z.string().min(1),
  text:    z.string().optional(),
});

const ReceiptEmailSchema = z.object({
  to:      z.string().email(),
  orderId: z.string().min(1),
});

const ReceiptSmsSchema = z.object({
  phone:   z.string().min(1),
  orderId: z.string().min(1),
});

const FiscalPrintSchema = z.object({
  deviceId:  z.string().min(1),
  orderId:   z.string().min(1),
  receiptNo: z.string().min(1),
  lines: z.array(z.object({
    description: z.string(),
    quantity:    z.number().positive(),
    unitPrice:   z.number().min(0),
    taxRate:     z.number().min(0),
    total:       z.number().min(0),
  })).min(1),
  subtotal:      z.number().min(0),
  taxAmount:     z.number().min(0),
  total:         z.number().min(0),
  paymentMethod: z.string(),
  cashier:       z.string(),
});

const FiscalDeviceSchema = z.object({
  name:       z.string().min(1),
  deviceType: z.enum(["epson_tm", "ingenico", "verifone", "mock"]),
  serialNo:   z.string().min(1),
  address:    z.string().min(1),
});

const WebhookSchema = z.object({
  url:    z.string().url(),
  events: z.array(z.enum([
    "order.created", "order.sent_to_kitchen", "order.closed",
    "order.cancelled", "payment.completed", "payment.refunded",
    "inventory.low_stock", "shift.closed",
  ])).min(1),
});

// ── Error handler ─────────────────────────────────────────────

function handleError(err: unknown, reply: any) {
  if (err instanceof GatewayError || err instanceof DeliveryError ||
      err instanceof FiscalError  || err instanceof NotificationError) {
    return reply.status((err as any).statusCode ?? 400).send({ error: err.name, message: err.message });
  }
  throw err;
}

function validate<T>(schema: z.ZodSchema<T>, data: unknown, reply: any): T | null {
  const r = schema.safeParse(data);
  if (!r.success) {
    reply.status(400).send({ error: "VALIDATION_ERROR", message: r.error.issues[0].message });
    return null;
  }
  return r.data;
}

// ── Route registration ────────────────────────────────────────

export async function integrationRoutes(fastify: FastifyInstance) {
  const getBranch = (req: any) => req.user.branchId!;

  // ─── PAYMENT GATEWAY ──────────────────────────────────────────

  fastify.post("/gateway/charge",
    { preHandler: [authenticate, requireRole("CASHIER") as any] },
    async (req, reply) => {
      const dto = validate(ChargeSchema, req.body, reply);
      if (!dto) return;
      try { return reply.send(await chargeCard(dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.post("/gateway/refund",
    { preHandler: [authenticate, requireRole("MANAGER") as any] },
    async (req, reply) => {
      const dto = validate(RefundSchema, req.body, reply);
      if (!dto) return;
      try { return reply.send(await refundCharge(dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // Gateway webhook callbacks (no auth — verified by signature)
  fastify.post("/gateway/stripe/webhook", async (req: any, reply) => {
    // Stripe sends raw body — signature verified by Stripe SDK
    const sig = req.headers["stripe-signature"];
    if (!sig) return reply.status(400).send({ error: "Missing signature" });
    // Handle Stripe events (payment_intent.succeeded, etc.)
    return reply.status(200).send({ received: true });
  });

  fastify.post("/gateway/iyzico/webhook", async (req, reply) => {
    // İyzico callback after 3DS
    return reply.status(200).send({ status: "ok" });
  });

  fastify.post("/gateway/paytr/webhook", async (req, reply) => {
    // PayTR notification
    return reply.status(200).send("OK");
  });

  // ─── DELIVERY PLATFORMS ───────────────────────────────────────
  // These endpoints receive webhooks from delivery platforms.
  // No standard auth — each platform uses its own signature.

  fastify.post("/delivery/yemeksepeti", async (req: any, reply) => {
    const sig     = req.headers["x-yemeksepeti-signature"] ?? "";
    const payload = JSON.stringify(req.body);

    if (process.env.NODE_ENV === "production" && !verifyYemeksepeti(payload, sig as string)) {
      return reply.status(401).send({ error: "Invalid signature" });
    }

    try {
      const branchId = req.headers["x-branch-id"] as string ?? process.env.DEFAULT_BRANCH_ID!;
      const order    = normalizeYemeksepeti(req.body);
      const result   = await createOrderFromDelivery(branchId, order);
      await acceptDeliveryOrder("yemeksepeti", order.platformOrderId);
      return reply.send({ ...result, platform: "yemeksepeti" });
    } catch (err) { return handleError(err, reply); }
  });

  fastify.post("/delivery/getir", async (req: any, reply) => {
    const sig     = req.headers["x-getir-signature"] ?? "";
    const payload = JSON.stringify(req.body);

    if (process.env.NODE_ENV === "production" && !verifyGetir(payload, sig as string)) {
      return reply.status(401).send({ error: "Invalid signature" });
    }

    try {
      const branchId = req.headers["x-branch-id"] as string ?? process.env.DEFAULT_BRANCH_ID!;
      const order    = normalizeGetir(req.body);
      const result   = await createOrderFromDelivery(branchId, order);
      await acceptDeliveryOrder("getir", order.platformOrderId);
      return reply.send({ ...result, platform: "getir" });
    } catch (err) { return handleError(err, reply); }
  });

  fastify.post("/delivery/trendyol", async (req: any, reply) => {
    const apiKey     = req.headers["x-api-key"]     as string ?? "";
    const supplierId = req.headers["x-supplier-id"] as string ?? "";

    if (process.env.NODE_ENV === "production" && !verifyTrendyol("", apiKey, supplierId)) {
      return reply.status(401).send({ error: "Invalid credentials" });
    }

    try {
      const branchId = req.headers["x-branch-id"] as string ?? process.env.DEFAULT_BRANCH_ID!;
      const order    = normalizeTrendyol(req.body);
      const result   = await createOrderFromDelivery(branchId, order);
      return reply.send({ ...result, platform: "trendyol" });
    } catch (err) { return handleError(err, reply); }
  });

  fastify.post("/delivery/:platform/:orderId/accept",
    { preHandler: [authenticate, requireRole("MANAGER") as any] },
    async (req: any, reply) => {
      try {
        await acceptDeliveryOrder(req.params.platform, req.params.orderId);
        return reply.send({ message: "Order accepted on platform" });
      } catch (err) { return handleError(err, reply); }
    }
  );

  // ─── FISCAL ──────────────────────────────────────────────────

  fastify.get("/fiscal/devices",
    { preHandler: [authenticate, requireRole("MANAGER") as any] },
    async (req, reply) => {
      try { return reply.send(await getFiscalDevices(getBranch(req))); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.post("/fiscal/devices",
    { preHandler: [authenticate, requireRole("ADMIN") as any] },
    async (req, reply) => {
      const dto = validate(FiscalDeviceSchema, req.body, reply);
      if (!dto) return;
      try { return reply.status(201).send(await createFiscalDevice(getBranch(req), dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.post("/fiscal/print",
    { preHandler: [authenticate, requireRole("CASHIER") as any] },
    async (req, reply) => {
      const dto = validate(FiscalPrintSchema, req.body, reply);
      if (!dto) return;
      try { return reply.send(await submitFiscalReceipt(getBranch(req), dto.deviceId, dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // ─── NOTIFICATIONS ────────────────────────────────────────────

  fastify.post("/notify/sms",
    { preHandler: [authenticate, requireRole("MANAGER") as any] },
    async (req, reply) => {
      const dto = validate(SmsSchema, req.body, reply);
      if (!dto) return;
      try { return reply.send(await sendSms(dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.post("/notify/email",
    { preHandler: [authenticate, requireRole("MANAGER") as any] },
    async (req, reply) => {
      const dto = validate(EmailSchema, req.body, reply);
      if (!dto) return;
      try { return reply.send(await sendEmail(dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.post("/notify/receipt-email",
    { preHandler: [authenticate, requireRole("CASHIER") as any] },
    async (req, reply) => {
      const dto = validate(ReceiptEmailSchema, req.body, reply);
      if (!dto) return;
      try {
        await sendReceiptEmail({ ...dto, branchId: getBranch(req) });
        return reply.send({ message: `Receipt emailed to ${dto.to}` });
      } catch (err) { return handleError(err, reply); }
    }
  );

  fastify.post("/notify/receipt-sms",
    { preHandler: [authenticate, requireRole("CASHIER") as any] },
    async (req, reply) => {
      const dto = validate(ReceiptSmsSchema, req.body, reply);
      if (!dto) return;
      try {
        await sendSmsReceipt(dto.phone, getBranch(req), dto.orderId);
        return reply.send({ message: `Receipt SMS sent to ${dto.phone}` });
      } catch (err) { return handleError(err, reply); }
    }
  );

  // ─── WEBHOOKS (outbound) ──────────────────────────────────────

  fastify.get("/webhooks",
    { preHandler: [authenticate, requireRole("ADMIN") as any] },
    async (req, reply) => {
      try { return reply.send(await getWebhooks(getBranch(req))); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.post("/webhooks",
    { preHandler: [authenticate, requireRole("ADMIN") as any] },
    async (req, reply) => {
      const dto = validate(WebhookSchema, req.body, reply);
      if (!dto) return;
      try { return reply.status(201).send(await registerWebhook(getBranch(req), dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.delete("/webhooks/:id",
    { preHandler: [authenticate, requireRole("ADMIN") as any] },
    async (req: any, reply) => {
      try { return reply.send(await deleteWebhook(getBranch(req), req.params.id)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.get("/webhooks/deliveries",
    { preHandler: [authenticate, requireRole("ADMIN") as any] },
    async (req, reply) => {
      try { return reply.send(await getWebhookDeliveries(getBranch(req))); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // ── Test webhook dispatch (dev only) ─────────────────────────
  if (process.env.NODE_ENV !== "production") {
    fastify.post("/webhooks/test",
      { preHandler: [authenticate, requireRole("ADMIN") as any] },
      async (req: any, reply) => {
        const { event = "order.created", payload = { test: true } } = req.body ?? {};
        await dispatchWebhook(getBranch(req), event, payload);
        return reply.send({ message: `Dispatched test event: ${event}` });
      }
    );
  }
}
