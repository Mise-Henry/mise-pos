// ============================================================
//  MISE — Organization & Multi-Branch Routes
//
//  GET    /org                         — org details + branches
//  PATCH  /org                         — update org settings
//  GET    /org/analytics               — cross-branch summary
//  GET    /org/plan                    — subscription plan
//
//  GET    /org/branches                — list branches
//  GET    /org/branches/:id            — branch detail
//  POST   /org/branches                — create branch
//  PATCH  /org/branches/:id            — update branch
//
//  GET    /org/users                   — all users (org-wide)
//  POST   /org/users                   — create user
//  PATCH  /org/users/:id               — update user
// ============================================================

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireRole } from "../middleware/auth.middleware";
import {
  getOrganization, updateOrganization,
  getBranches, getBranchById, createBranch, updateBranch,
  getOrgUsers, createUser, updateUser,
  getCrossBranchSummary, getSubscriptionPlan, OrgError,
} from "./organization.service";

const OrgUpdateSchema = z.object({
  name:     z.string().min(1).optional(),
  phone:    z.string().optional(),
  email:    z.string().email().optional(),
  address:  z.string().optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().optional(),
  locale:   z.string().optional(),
});

const BranchSchema = z.object({
  name:    z.string().min(1),
  address: z.string().optional(),
  phone:   z.string().optional(),
  taxId:   z.string().optional(),
});

const UserCreateSchema = z.object({
  branchId:  z.string().optional(),
  email:     z.string().email(),
  password:  z.string().min(8),
  firstName: z.string().min(1),
  lastName:  z.string().min(1),
  role:      z.enum(["ADMIN", "MANAGER", "WAITER", "CASHIER", "KITCHEN"]),
  pin:       z.string().regex(/^\d{4,6}$/).optional(),
});

const UserUpdateSchema = z.object({
  firstName: z.string().optional(),
  lastName:  z.string().optional(),
  branchId:  z.string().optional(),
  role:      z.enum(["ADMIN", "MANAGER", "WAITER", "CASHIER", "KITCHEN"]).optional(),
  isActive:  z.boolean().optional(),
  password:  z.string().min(8).optional(),
  pin:       z.string().regex(/^\d{4,6}$/).optional(),
});

function handleError(err: unknown, reply: any) {
  if (err instanceof OrgError) {
    return reply.status(err.statusCode).send({ error: err.code, message: err.message });
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

export async function orgRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticate);
  fastify.addHook("preHandler", requireRole("ADMIN") as any);

  const getOrg = (req: any) => req.user.orgId;

  fastify.get("/", async (req, reply) => {
    try { return reply.send(await getOrganization(getOrg(req))); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/", async (req, reply) => {
    const dto = validate(OrgUpdateSchema, req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateOrganization(getOrg(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/plan", async (req, reply) => {
    try { return reply.send(await getSubscriptionPlan(getOrg(req))); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/analytics", async (req: any, reply) => {
    const q        = req.query as any;
    const dateFrom = q.dateFrom ? new Date(q.dateFrom) : new Date(Date.now() - 30 * 86400000);
    const dateTo   = q.dateTo   ? new Date(q.dateTo)   : new Date();
    try { return reply.send(await getCrossBranchSummary(getOrg(req), dateFrom, dateTo)); }
    catch (err) { return handleError(err, reply); }
  });

  // ── Branches ──────────────────────────────────────────────

  fastify.get("/branches", async (req, reply) => {
    try { return reply.send(await getBranches(getOrg(req))); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/branches/:id", async (req: any, reply) => {
    try { return reply.send(await getBranchById(getOrg(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/branches", { preHandler: [requireRole("SUPER_ADMIN") as any] }, async (req, reply) => {
    const dto = validate(BranchSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createBranch(getOrg(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/branches/:id", async (req: any, reply) => {
    const dto = validate(BranchSchema.partial().extend({ isActive: z.boolean().optional() }), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateBranch(getOrg(req), req.params.id, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  // ── Users ─────────────────────────────────────────────────

  fastify.get("/users", async (req, reply) => {
    try { return reply.send(await getOrgUsers(getOrg(req))); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/users", async (req, reply) => {
    const dto = validate(UserCreateSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createUser(getOrg(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/users/:id", async (req: any, reply) => {
    const dto = validate(UserUpdateSchema, req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateUser(getOrg(req), req.params.id, dto)); }
    catch (err) { return handleError(err, reply); }
  });
}
