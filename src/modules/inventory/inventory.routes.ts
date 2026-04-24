// ============================================================
//  MISE — Inventory Routes
//
//  STOCK ITEMS
//    GET    /inventory/stock                        — list + filter
//    GET    /inventory/stock/levels                 — stock level report
//    GET    /inventory/stock/alerts                 — low stock alerts
//    GET    /inventory/stock/consumption            — consumption report
//    GET    /inventory/stock/:id                    — item + recent movements
//    POST   /inventory/stock                        — create item
//    PATCH  /inventory/stock/:id                    — update item
//    DELETE /inventory/stock/:id                    — soft delete
//    POST   /inventory/stock/adjust                 — bulk physical count
//    POST   /inventory/stock/waste                  — log waste
//    POST   /inventory/stock/:id/movement           — manual movement
//
//  RECIPES
//    GET    /inventory/recipes/:productId           — get recipe
//    PUT    /inventory/recipes/:productId           — set/replace recipe
//    DELETE /inventory/recipes/:productId           — clear recipe
//
//  MOVEMENTS
//    GET    /inventory/movements                    — movement log
//
//  SUPPLIERS
//    GET    /inventory/suppliers                    — list
//    GET    /inventory/suppliers/:id                — detail
//    POST   /inventory/suppliers                    — create
//    PATCH  /inventory/suppliers/:id                — update
//    DELETE /inventory/suppliers/:id                — soft delete
//
//  PURCHASE ORDERS
//    GET    /inventory/purchase-orders              — list
//    GET    /inventory/purchase-orders/:id          — detail
//    POST   /inventory/purchase-orders              — create
//    POST   /inventory/purchase-orders/:id/send     — mark sent
//    POST   /inventory/purchase-orders/:id/receive  — receive stock
//    POST   /inventory/purchase-orders/:id/cancel   — cancel
// ============================================================

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireRole, requirePermission } from "../middleware/auth.middleware";
import {
  getStockItems, getStockItemById, createStockItem,
  updateStockItem, deleteStockItem, getStockLevels,
  getLowStockAlerts, getMovements, createMovement,
  logWaste, bulkAdjust, getRecipe, setRecipe,
  removeRecipe, getConsumptionReport, InventoryError,
} from "../inventory/inventory.service";
import {
  getSuppliers, getSupplierById, createSupplier,
  updateSupplier, deleteSupplier,
} from "../supplier/supplier.service";
import {
  getPurchaseOrders, getPurchaseOrderById, createPurchaseOrder,
  sendPurchaseOrder, receivePurchaseOrder, cancelPurchaseOrder,
} from "../purchase/purchase.service";

// ── Zod schemas ───────────────────────────────────────────────

const UNITS = ["KG", "GRAM", "LITER", "ML", "PIECE", "PORTION"] as const;

const StockItemSchema = z.object({
  name:       z.string().min(1),
  unit:       z.enum(UNITS),
  currentQty: z.number().min(0).optional(),
  minQty:     z.number().min(0).optional(),
  cost:       z.number().positive().optional(),
  supplierId: z.string().optional(),
  note:       z.string().optional(),
});

const MovementSchema = z.object({
  stockItemId: z.string().min(1),
  type:        z.enum(["PURCHASE", "CONSUMPTION", "WASTE", "ADJUSTMENT", "TRANSFER"]),
  quantity:    z.number().refine((n) => n !== 0, "Quantity cannot be zero"),
  note:        z.string().optional(),
  unitCost:    z.number().positive().optional(),
});

const WasteSchema = z.object({
  stockItemId: z.string().min(1),
  quantity:    z.number().positive(),
  reason:      z.string().min(1),
});

const BulkAdjustSchema = z.object({
  adjustments: z.array(z.object({
    stockItemId: z.string().min(1),
    actualQty:   z.number().min(0),
    note:        z.string().optional(),
  })).min(1),
});

const RecipeSchema = z.object({
  ingredients: z.array(z.object({
    stockItemId: z.string().min(1),
    quantity:    z.number().positive(),
  })).min(1),
});

const SupplierSchema = z.object({
  name:        z.string().min(1),
  contactName: z.string().optional(),
  phone:       z.string().optional(),
  email:       z.string().email().optional().or(z.literal("")),
  address:     z.string().optional(),
  taxId:       z.string().optional(),
  note:        z.string().optional(),
});

const PurchaseOrderSchema = z.object({
  supplierId:   z.string().min(1),
  expectedDate: z.string().datetime().optional(),
  note:         z.string().optional(),
  lines: z.array(z.object({
    stockItemId: z.string().min(1),
    orderedQty:  z.number().positive(),
    unitCost:    z.number().positive(),
  })).min(1),
});

const ReceivePoSchema = z.object({
  lines: z.array(z.object({
    purchaseLineId: z.string().min(1),
    receivedQty:    z.number().min(0),
    unitCost:       z.number().positive().optional(),
  })).min(1),
  note: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────

function handleError(err: unknown, reply: any) {
  if (err instanceof InventoryError) {
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

// ── Routes ────────────────────────────────────────────────────

export async function inventoryRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);
  fastify.addHook("preHandler", requireRole("MANAGER") as any);

  const getBranch = (req: any) => req.user.branchId!;
  const getUserId = (req: any) => req.user.userId;

  // ─── STOCK ITEMS ─────────────────────────────────────────────

  fastify.get("/stock", async (req: any, reply) => {
    const q = req.query as any;
    try {
      return reply.send(await getStockItems(getBranch(req), {
        search:     q.search,
        lowStock:   q.lowStock === "true",
        supplierId: q.supplierId,
        isActive:   q.isActive !== "false",
        page:       q.page  ? parseInt(q.page)  : 1,
        limit:      q.limit ? parseInt(q.limit) : 50,
      }));
    } catch (err) { return handleError(err, reply); }
  });

  fastify.get("/stock/levels", async (req, reply) => {
    try { return reply.send(await getStockLevels(getBranch(req))); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/stock/alerts", async (req, reply) => {
    try { return reply.send(await getLowStockAlerts(getBranch(req))); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/stock/consumption", async (req: any, reply) => {
    const { dateFrom, dateTo } = req.query as any;
    if (!dateFrom || !dateTo) {
      return reply.status(400).send({ error: "MISSING_PARAMS", message: "dateFrom and dateTo are required" });
    }
    try { return reply.send(await getConsumptionReport(getBranch(req), dateFrom, dateTo)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/stock/:id", async (req: any, reply) => {
    try { return reply.send(await getStockItemById(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/stock", async (req, reply) => {
    const dto = validate(StockItemSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createStockItem(getBranch(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/stock/:id", async (req: any, reply) => {
    const dto = validate(StockItemSchema.partial().extend({ isActive: z.boolean().optional() }), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateStockItem(getBranch(req), req.params.id, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.delete("/stock/:id", async (req: any, reply) => {
    try { return reply.send(await deleteStockItem(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  // Bulk physical count (stock take)
  fastify.post("/stock/adjust", async (req, reply) => {
    const dto = validate(BulkAdjustSchema, req.body, reply);
    if (!dto) return;
    try { return reply.send(await bulkAdjust(getBranch(req), getUserId(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  // Log waste
  fastify.post("/stock/waste", async (req, reply) => {
    const dto = validate(WasteSchema, req.body, reply);
    if (!dto) return;
    try { return reply.send(await logWaste(getBranch(req), getUserId(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  // Manual movement (purchase, transfer, etc.)
  fastify.post("/stock/:id/movement", async (req: any, reply) => {
    const dto = validate(MovementSchema, { ...req.body, stockItemId: req.params.id }, reply);
    if (!dto) return;
    try { return reply.send(await createMovement(getBranch(req), getUserId(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  // ─── RECIPES ──────────────────────────────────────────────────

  fastify.get("/recipes/:productId", async (req: any, reply) => {
    try { return reply.send(await getRecipe(getBranch(req), req.params.productId)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.put("/recipes/:productId", async (req: any, reply) => {
    const dto = validate(RecipeSchema, req.body, reply);
    if (!dto) return;
    try { return reply.send(await setRecipe(getBranch(req), req.params.productId, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.delete("/recipes/:productId", async (req: any, reply) => {
    try { return reply.send(await removeRecipe(getBranch(req), req.params.productId)); }
    catch (err) { return handleError(err, reply); }
  });

  // ─── MOVEMENTS LOG ────────────────────────────────────────────

  fastify.get("/movements", async (req: any, reply) => {
    const q = req.query as any;
    try {
      return reply.send(await getMovements(getBranch(req), {
        stockItemId: q.stockItemId,
        type:        q.type,
        dateFrom:    q.dateFrom,
        dateTo:      q.dateTo,
        page:        q.page  ? parseInt(q.page)  : 1,
        limit:       q.limit ? parseInt(q.limit) : 50,
      }));
    } catch (err) { return handleError(err, reply); }
  });

  // ─── SUPPLIERS ────────────────────────────────────────────────

  fastify.get("/suppliers", async (req, reply) => {
    try { return reply.send(await getSuppliers(getBranch(req))); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/suppliers/:id", async (req: any, reply) => {
    try { return reply.send(await getSupplierById(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/suppliers", async (req, reply) => {
    const dto = validate(SupplierSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createSupplier(getBranch(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/suppliers/:id", async (req: any, reply) => {
    const dto = validate(SupplierSchema.partial().extend({ isActive: z.boolean().optional() }), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateSupplier(getBranch(req), req.params.id, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.delete("/suppliers/:id", async (req: any, reply) => {
    try { return reply.send(await deleteSupplier(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  // ─── PURCHASE ORDERS ──────────────────────────────────────────

  fastify.get("/purchase-orders", async (req: any, reply) => {
    const q = req.query as any;
    try {
      return reply.send(await getPurchaseOrders(
        getBranch(req), q.status, q.page ? parseInt(q.page) : 1, q.limit ? parseInt(q.limit) : 20
      ));
    } catch (err) { return handleError(err, reply); }
  });

  fastify.get("/purchase-orders/:id", async (req: any, reply) => {
    try { return reply.send(await getPurchaseOrderById(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/purchase-orders", async (req, reply) => {
    const dto = validate(PurchaseOrderSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createPurchaseOrder(getBranch(req), getUserId(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/purchase-orders/:id/send", async (req: any, reply) => {
    try { return reply.send(await sendPurchaseOrder(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/purchase-orders/:id/receive", { preHandler: [requireRole("ADMIN") as any] }, async (req: any, reply) => {
    const dto = validate(ReceivePoSchema, req.body, reply);
    if (!dto) return;
    try { return reply.send(await receivePurchaseOrder(getBranch(req), req.params.id, getUserId(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/purchase-orders/:id/cancel", async (req: any, reply) => {
    const body = req.body as any;
    if (!body?.reason) return reply.status(400).send({ error: "VALIDATION_ERROR", message: "reason is required" });
    try { return reply.send(await cancelPurchaseOrder(getBranch(req), req.params.id, body.reason)); }
    catch (err) { return handleError(err, reply); }
  });
}
