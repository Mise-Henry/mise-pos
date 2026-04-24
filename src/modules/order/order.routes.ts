// ============================================================
//  MISE — Order & KDS Routes
//
//  ORDERS
//    GET    /orders                         — list (paginated)
//    GET    /orders/active                  — all open orders
//    GET    /orders/:id                     — single order detail
//    POST   /orders                         — create order
//    PATCH  /orders/:id                     — update metadata
//    DELETE /orders/:id/cancel              — cancel order
//    POST   /orders/:id/void                — void closed order (MANAGER)
//
//  ORDER ITEMS
//    POST   /orders/:id/items               — add item
//    PATCH  /orders/:id/items/:itemId       — update item
//    DELETE /orders/:id/items/:itemId       — remove item
//    POST   /orders/:id/send                — send to kitchen
//    PATCH  /orders/:id/items/:itemId/status — update item status
//
//  DISCOUNTS
//    POST   /orders/:id/discounts           — apply discount
//    DELETE /orders/:id/discounts/:did      — remove discount
//
//  SPLIT BILL
//    GET    /orders/:id/split-preview       — split preview
//
//  KDS
//    GET    /kds/queue                      — kitchen queue
//    GET    /kds/history                    — recent completed
//    POST   /kds/:orderId/items/:itemId/start   — mark in progress
//    POST   /kds/:orderId/items/:itemId/ready   — mark ready
//    POST   /kds/:orderId/items/:itemId/served  — mark served
//    POST   /kds/:orderId/ready                 — mark whole order ready
//
//  WEBSOCKET
//    WS     /ws                             — real-time event stream
// ============================================================

import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { z } from "zod";
import { authenticate, requireRole, requirePermission } from "../middleware/auth.middleware";
import { verifyAccessToken } from "../../config/jwt.config";
import { wsManager } from "../websocket/ws.manager";
import {
  getOrders, getActiveOrders, getOrderById,
  createOrder, updateOrder, addItem, updateItem,
  removeItem, sendToKitchen, updateItemStatus,
  applyDiscount, removeDiscount, closeOrder,
  cancelOrder, voidOrder, getSplitBillPreview,
  OrderError,
} from "../order/order.service";
import {
  getKitchenQueue, startItem, markItemReady,
  markItemServed, markOrderReady, getKdsHistory,
} from "../kds/kds.service";

// ── Zod schemas ───────────────────────────────────────────────

const CreateOrderSchema = z.object({
  tableId:         z.string().optional(),
  type:            z.enum(["DINE_IN", "TAKEAWAY", "DELIVERY", "ONLINE"]).optional(),
  guestCount:      z.number().int().min(1).max(50).optional(),
  notes:           z.string().max(500).optional(),
  deliveryName:    z.string().optional(),
  deliveryPhone:   z.string().optional(),
  deliveryAddress: z.string().optional(),
});

const AddItemSchema = z.object({
  productId:    z.string().min(1),
  quantity:     z.number().int().min(1).max(99).optional(),
  notes:        z.string().max(200).optional(),
  courseNumber: z.number().int().min(1).max(5).optional(),
  modifierIds:  z.array(z.string()).optional(),
});

const UpdateItemSchema = z.object({
  quantity:     z.number().int().min(1).max(99).optional(),
  notes:        z.string().max(200).optional(),
  courseNumber: z.number().int().min(1).max(5).optional(),
});

const SendToKitchenSchema = z.object({
  itemIds: z.array(z.string()).optional(),
});

const ItemStatusSchema = z.object({
  status: z.enum(["PENDING", "SENT", "IN_PROGRESS", "READY", "SERVED", "CANCELLED", "VOID"]),
});

const DiscountSchema = z.object({
  templateId: z.string().optional(),
  name:       z.string().min(1),
  type:       z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
  value:      z.number().positive(),
});

const CancelSchema = z.object({
  reason: z.string().min(1, "Reason is required for cancellation"),
});

const VoidSchema = z.object({
  reason: z.string().min(1, "Reason is required for void"),
});

const RemoveItemSchema = z.object({
  reason: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────

function handleError(err: unknown, reply: any) {
  if (err instanceof OrderError) {
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

export async function orderRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);

  const getBranch  = (req: any) => req.user.branchId!;
  const getUserId  = (req: any) => req.user.userId;

  // ─── ORDERS ──────────────────────────────────────────────────

  fastify.get("/", async (req: any, reply) => {
    const q = req.query as any;
    try {
      return reply.send(await getOrders(getBranch(req), {
        status:   q.status,
        tableId:  q.tableId,
        type:     q.type,
        dateFrom: q.dateFrom,
        dateTo:   q.dateTo,
        search:   q.search,
        page:     q.page  ? parseInt(q.page)  : 1,
        limit:    q.limit ? parseInt(q.limit) : 50,
      }));
    } catch (err) { return handleError(err, reply); }
  });

  fastify.get("/active", async (req, reply) => {
    try { return reply.send(await getActiveOrders(getBranch(req))); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/:id", async (req: any, reply) => {
    try { return reply.send(await getOrderById(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/", { preHandler: [requirePermission("orders:create")] }, async (req, reply) => {
    const dto = validate(CreateOrderSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createOrder(getBranch(req), getUserId(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/:id", { preHandler: [requirePermission("orders:update")] }, async (req: any, reply) => {
    const dto = validate(CreateOrderSchema.partial(), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateOrder(getBranch(req), req.params.id, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  // ─── ORDER ITEMS ─────────────────────────────────────────────

  fastify.post(
    "/:id/items",
    { preHandler: [requirePermission("orders:update")] },
    async (req: any, reply) => {
      const dto = validate(AddItemSchema, req.body, reply);
      if (!dto) return;
      try { return reply.status(201).send(await addItem(getBranch(req), req.params.id, dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.patch(
    "/:id/items/:itemId",
    { preHandler: [requirePermission("orders:update")] },
    async (req: any, reply) => {
      const dto = validate(UpdateItemSchema, req.body, reply);
      if (!dto) return;
      try {
        return reply.send(await updateItem(getBranch(req), req.params.id, req.params.itemId, dto));
      } catch (err) { return handleError(err, reply); }
    }
  );

  fastify.delete(
    "/:id/items/:itemId",
    { preHandler: [requirePermission("orders:update")] },
    async (req: any, reply) => {
      const dto = validate(RemoveItemSchema, req.body ?? {}, reply);
      if (!dto) return;
      try {
        return reply.send(
          await removeItem(getBranch(req), req.params.id, req.params.itemId, getUserId(req), dto.reason)
        );
      } catch (err) { return handleError(err, reply); }
    }
  );

  // Send pending items to kitchen
  fastify.post(
    "/:id/send",
    { preHandler: [requirePermission("orders:update")] },
    async (req: any, reply) => {
      const dto = validate(SendToKitchenSchema, req.body ?? {}, reply);
      if (!dto) return;
      try { return reply.send(await sendToKitchen(getBranch(req), req.params.id, dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // Update item status (waiter marks served)
  fastify.patch(
    "/:id/items/:itemId/status",
    { preHandler: [requirePermission("orders:update")] },
    async (req: any, reply) => {
      const dto = validate(ItemStatusSchema, req.body, reply);
      if (!dto) return;
      try {
        return reply.send(
          await updateItemStatus(getBranch(req), req.params.id, req.params.itemId, dto.status)
        );
      } catch (err) { return handleError(err, reply); }
    }
  );

  // ─── DISCOUNTS ────────────────────────────────────────────────

  fastify.post(
    "/:id/discounts",
    { preHandler: [requirePermission("discounts:apply")] },
    async (req: any, reply) => {
      const dto = validate(DiscountSchema, req.body, reply);
      if (!dto) return;
      try {
        return reply.status(201).send(
          await applyDiscount(getBranch(req), req.params.id, getUserId(req), dto)
        );
      } catch (err) { return handleError(err, reply); }
    }
  );

  fastify.delete(
    "/:id/discounts/:discountId",
    { preHandler: [requireRole("MANAGER")] },
    async (req: any, reply) => {
      try {
        return reply.send(
          await removeDiscount(getBranch(req), req.params.id, req.params.discountId, getUserId(req))
        );
      } catch (err) { return handleError(err, reply); }
    }
  );

  // ─── CLOSE / CANCEL / VOID ────────────────────────────────────

  fastify.post(
    "/:id/close",
    { preHandler: [requirePermission("orders:close")] },
    async (req: any, reply) => {
      try { return reply.send(await closeOrder(getBranch(req), req.params.id, getUserId(req))); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.post(
    "/:id/cancel",
    { preHandler: [requirePermission("orders:update")] },
    async (req: any, reply) => {
      const dto = validate(CancelSchema, req.body, reply);
      if (!dto) return;
      try {
        return reply.send(
          await cancelOrder(getBranch(req), req.params.id, getUserId(req), dto.reason)
        );
      } catch (err) { return handleError(err, reply); }
    }
  );

  fastify.post(
    "/:id/void",
    { preHandler: [requireRole("MANAGER")] },
    async (req: any, reply) => {
      const dto = validate(VoidSchema, req.body, reply);
      if (!dto) return;
      try {
        return reply.send(
          await voidOrder(getBranch(req), req.params.id, getUserId(req), dto.reason)
        );
      } catch (err) { return handleError(err, reply); }
    }
  );

  // ─── SPLIT BILL ───────────────────────────────────────────────

  fastify.get("/:id/split-preview", async (req: any, reply) => {
    try { return reply.send(await getSplitBillPreview(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });
}

// ── KDS Routes ────────────────────────────────────────────────

export async function kdsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);
  const getBranch = (req: any) => req.user.branchId!;

  fastify.get("/queue", async (req, reply) => {
    try { return reply.send(await getKitchenQueue(getBranch(req))); }
    catch (err) { if (err instanceof OrderError) return reply.status(err.statusCode).send({ error: err.code, message: err.message }); throw err; }
  });

  fastify.get("/history", async (req: any, reply) => {
    const limit = req.query?.limit ? parseInt(req.query.limit) : 20;
    try { return reply.send(await getKdsHistory(getBranch(req), limit)); }
    catch (err) { if (err instanceof OrderError) return reply.status(err.statusCode).send({ error: err.code, message: err.message }); throw err; }
  });

  fastify.post("/:orderId/items/:itemId/start", async (req: any, reply) => {
    try { return reply.send(await startItem(getBranch(req), req.params.orderId, req.params.itemId)); }
    catch (err) { if (err instanceof OrderError) return reply.status(err.statusCode).send({ error: err.code, message: err.message }); throw err; }
  });

  fastify.post("/:orderId/items/:itemId/ready", async (req: any, reply) => {
    try { return reply.send(await markItemReady(getBranch(req), req.params.orderId, req.params.itemId)); }
    catch (err) { if (err instanceof OrderError) return reply.status(err.statusCode).send({ error: err.code, message: err.message }); throw err; }
  });

  fastify.post("/:orderId/items/:itemId/served", async (req: any, reply) => {
    try { return reply.send(await markItemServed(getBranch(req), req.params.orderId, req.params.itemId)); }
    catch (err) { if (err instanceof OrderError) return reply.status(err.statusCode).send({ error: err.code, message: err.message }); throw err; }
  });

  fastify.post("/:orderId/ready", async (req: any, reply) => {
    try { return reply.send(await markOrderReady(getBranch(req), req.params.orderId)); }
    catch (err) { if (err instanceof OrderError) return reply.status(err.statusCode).send({ error: err.code, message: err.message }); throw err; }
  });
}

// ── WebSocket Route ───────────────────────────────────────────

export async function wsRoutes(fastify: FastifyInstance) {
  fastify.get("/ws", { websocket: true }, (socket, req) => {
    const connectionId = randomUUID();
    let branchId = "unknown";

    // Auth via query param: /ws?token=eyJ...
    const token = (req.query as any)?.token;
    if (!token) {
      socket.send(JSON.stringify({ error: "UNAUTHORIZED", message: "Token required" }));
      socket.close();
      return;
    }

    try {
      const payload = verifyAccessToken(token);
      branchId = payload.branchId ?? "unknown";

      wsManager.register(connectionId, {
        ws:       socket as any,
        branchId: payload.branchId ?? "",
        role:     payload.role,
        userId:   payload.sub,
        device:   (req.query as any)?.device ?? "Unknown",
      });

      // Send welcome
      socket.send(JSON.stringify({
        event:    "CONNECTED",
        branchId: payload.branchId,
        message:  "Real-time connection established",
        ts:       new Date().toISOString(),
      }));
    } catch {
      socket.send(JSON.stringify({ error: "INVALID_TOKEN", message: "Invalid or expired token" }));
      socket.close();
      return;
    }

    // Ping/pong keepalive
    const pingInterval = setInterval(() => {
      if (socket.readyState === 1) {
        socket.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30_000);

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Clients can send { event: "PING" } to check connection
        if (msg.event === "PING") {
          socket.send(JSON.stringify({ event: "PONG", ts: new Date().toISOString() }));
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on("close", () => {
      clearInterval(pingInterval);
      wsManager.unregister(connectionId);
    });

    socket.on("error", () => {
      clearInterval(pingInterval);
      wsManager.unregister(connectionId);
    });
  });

  // WebSocket stats (admin only)
  fastify.get("/ws/stats", async (_req, reply) => {
    return reply.send(wsManager.getStats());
  });
}
