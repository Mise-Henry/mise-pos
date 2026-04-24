// ============================================================
//  MISE — Table & Reservation Routes
//
//  SECTIONS
//    GET    /tables/sections           — list sections
//    POST   /tables/sections           — create section
//    PATCH  /tables/sections/:id       — update section
//    DELETE /tables/sections/:id       — delete section
//
//  FLOOR PLAN
//    GET    /tables/floor-plan         — full floor plan with status
//    POST   /tables/floor-plan         — save positions (drag-drop)
//
//  TABLES
//    GET    /tables                    — list tables
//    GET    /tables/:id                — table + active order + reservations
//    POST   /tables                    — create table
//    PATCH  /tables/:id                — update table metadata
//    DELETE /tables/:id                — soft delete
//    PATCH  /tables/:id/status         — change status (state machine)
//    POST   /tables/merge              — merge tables
//    POST   /tables/transfer           — transfer order between tables
//
//  RESERVATIONS
//    GET    /tables/reservations       — list (filterable by date/table)
//    GET    /tables/reservations/upcoming  — next 4 hours
//    GET    /tables/reservations/:id   — single reservation
//    POST   /tables/reservations       — create reservation
//    PATCH  /tables/reservations/:id   — update reservation
//    POST   /tables/reservations/:id/confirm  — confirm
//    POST   /tables/reservations/:id/cancel   — cancel
// ============================================================

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireRole, requirePermission } from "../middleware/auth.middleware";
import {
  getFloorPlan, getTables, getTableById,
  createTable, updateTable, deleteTable,
  updateTableStatus, mergeTables, transferTable,
  saveFloorPlan, getSections, createSection,
  updateSection, deleteSection, TableError,
} from "../table/table.service";
import {
  getReservations, getReservationById, createReservation,
  updateReservation, cancelReservation, confirmReservation,
  getUpcomingReservations,
} from "../reservation/reservation.service";

// ── Zod schemas ───────────────────────────────────────────────

const SectionSchema = z.object({
  name:      z.string().min(1),
  sortOrder: z.number().int().min(0).optional(),
});

const TableSchema = z.object({
  sectionId: z.string().optional(),
  name:      z.string().min(1).max(20),
  capacity:  z.number().int().min(1).max(50),
  shape:     z.enum(["rectangle", "circle", "square"]).optional(),
  posX:      z.number().optional(),
  posY:      z.number().optional(),
  width:     z.number().positive().optional(),
  height:    z.number().positive().optional(),
});

const TableStatusSchema = z.object({
  status: z.enum(["AVAILABLE", "OCCUPIED", "RESERVED", "CLEANING", "INACTIVE"]),
  note:   z.string().optional(),
});

const MergeSchema = z.object({
  tableIds:       z.array(z.string()).min(2),
  primaryTableId: z.string(),
});

const TransferSchema = z.object({
  fromTableId: z.string(),
  toTableId:   z.string(),
});

const FloorPlanSaveSchema = z.object({
  positions: z.array(z.object({
    tableId: z.string(),
    posX:    z.number(),
    posY:    z.number(),
    width:   z.number().positive().optional(),
    height:  z.number().positive().optional(),
  })).min(1),
});

const ReservationSchema = z.object({
  tableId:    z.string(),
  guestName:  z.string().min(1),
  guestPhone: z.string().optional(),
  guestCount: z.number().int().min(1),
  reservedAt: z.string().datetime(),
  notes:      z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────

function handleError(err: unknown, reply: any) {
  if (err instanceof TableError) {
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

export async function tableRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);

  const getBranch = (req: any) => req.user.branchId!;

  // ─── SECTIONS ────────────────────────────────────────────────

  fastify.get("/sections", async (req, reply) => {
    try { return reply.send(await getSections(getBranch(req))); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/sections", { preHandler: [requireRole("MANAGER")] }, async (req, reply) => {
    const dto = validate(SectionSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createSection(getBranch(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/sections/:id", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    const dto = validate(SectionSchema.partial().extend({ isActive: z.boolean().optional() }), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateSection(getBranch(req), req.params.id, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.delete("/sections/:id", { preHandler: [requireRole("ADMIN")] }, async (req: any, reply) => {
    try { return reply.send(await deleteSection(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  // ─── FLOOR PLAN ───────────────────────────────────────────────

  // Full floor plan — primary endpoint for the POS seating screen
  fastify.get("/floor-plan", async (req, reply) => {
    try { return reply.send(await getFloorPlan(getBranch(req))); }
    catch (err) { return handleError(err, reply); }
  });

  // Save table positions after drag-drop rearrangement
  fastify.post("/floor-plan", { preHandler: [requireRole("MANAGER")] }, async (req, reply) => {
    const dto = validate(FloorPlanSaveSchema, req.body, reply);
    if (!dto) return;
    try { return reply.send(await saveFloorPlan(getBranch(req), dto.positions)); }
    catch (err) { return handleError(err, reply); }
  });

  // ─── TABLES ───────────────────────────────────────────────────

  fastify.get("/", async (req: any, reply) => {
    const sectionId = req.query?.sectionId;
    try { return reply.send(await getTables(getBranch(req), sectionId)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/:id", async (req: any, reply) => {
    try { return reply.send(await getTableById(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/", { preHandler: [requireRole("MANAGER")] }, async (req, reply) => {
    const dto = validate(TableSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createTable(getBranch(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/:id", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    const dto = validate(TableSchema.partial().extend({ isActive: z.boolean().optional() }), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateTable(getBranch(req), req.params.id, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.delete("/:id", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    try { return reply.send(await deleteTable(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  // Status transition (state machine enforced in service)
  fastify.patch(
    "/:id/status",
    { preHandler: [requirePermission("tables:update_status")] },
    async (req: any, reply) => {
      const dto = validate(TableStatusSchema, req.body, reply);
      if (!dto) return;
      try { return reply.send(await updateTableStatus(getBranch(req), req.params.id, dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // Merge tables (e.g. push two tables together for a large party)
  fastify.post("/merge", { preHandler: [requireRole("MANAGER")] }, async (req, reply) => {
    const dto = validate(MergeSchema, req.body, reply);
    if (!dto) return;
    try { return reply.send(await mergeTables(getBranch(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  // Transfer order to different table
  fastify.post(
    "/transfer",
    { preHandler: [requirePermission("tables:update_status")] },
    async (req, reply) => {
      const dto = validate(TransferSchema, req.body, reply);
      if (!dto) return;
      try { return reply.send(await transferTable(getBranch(req), dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  // ─── RESERVATIONS ─────────────────────────────────────────────

  fastify.get("/reservations/upcoming", async (req: any, reply) => {
    const hours = req.query?.hours ? parseInt(req.query.hours) : 4;
    try { return reply.send(await getUpcomingReservations(getBranch(req), hours)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/reservations", async (req: any, reply) => {
    const q = req.query as any;
    try {
      return reply.send(await getReservations(getBranch(req), {
        date:     q.date,
        tableId:  q.tableId,
        upcoming: q.upcoming === "true",
        page:     q.page  ? parseInt(q.page)  : 1,
        limit:    q.limit ? parseInt(q.limit) : 50,
      }));
    } catch (err) { return handleError(err, reply); }
  });

  fastify.get("/reservations/:id", async (req: any, reply) => {
    try { return reply.send(await getReservationById(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/reservations", async (req, reply) => {
    const dto = validate(ReservationSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createReservation(getBranch(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/reservations/:id", async (req: any, reply) => {
    const dto = validate(ReservationSchema.partial().extend({
      isConfirmed: z.boolean().optional(),
      isCancelled: z.boolean().optional(),
    }), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateReservation(getBranch(req), req.params.id, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/reservations/:id/confirm", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    try { return reply.send(await confirmReservation(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/reservations/:id/cancel", async (req: any, reply) => {
    try { return reply.send(await cancelReservation(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });
}
