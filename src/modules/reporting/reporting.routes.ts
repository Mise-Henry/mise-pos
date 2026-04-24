// ============================================================
//  MISE — Reporting Routes
//
//  GET /reports/dashboard           — KPI overview cards
//  GET /reports/sales               — sales report + timeline
//  GET /reports/products            — product performance
//  GET /reports/staff               — staff performance
//  GET /reports/tables              — table utilisation
//  GET /reports/costs               — COGS + margin analysis
//
//  All endpoints accept these query params:
//    period   — today|yesterday|week|month|quarter|year|custom
//    dateFrom — YYYY-MM-DD  (required when period=custom)
//    dateTo   — YYYY-MM-DD  (required when period=custom)
//    groupBy  — hour|day|week|month  (auto-selected if omitted)
// ============================================================

import type { FastifyInstance } from "fastify";
import { authenticate, requireRole } from "../middleware/auth.middleware";
import { getDashboard } from "./dashboard.service";
import {
  getSalesReport, getProductReport,
  getStaffReport, getTableReport, getCostReport,
} from "./reports.service";

export class ReportError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
  }
}

function parseParams(query: any) {
  return {
    period:   query.period,
    dateFrom: query.dateFrom,
    dateTo:   query.dateTo,
    groupBy:  query.groupBy,
  };
}

function handleError(err: unknown, reply: any) {
  if (err instanceof ReportError) {
    return reply.status(err.statusCode).send({ error: err.code, message: err.message });
  }
  if (err instanceof Error && err.message.includes("dateFrom and dateTo")) {
    return reply.status(400).send({ error: "INVALID_PARAMS", message: err.message });
  }
  throw err;
}

export async function reportingRoutes(fastify: FastifyInstance) {
  // All report routes require MANAGER minimum
  fastify.addHook("preHandler", authenticate);
  fastify.addHook("preHandler", requireRole("MANAGER") as any);

  const getBranch = (req: any) => req.user.branchId!;

  // ── Dashboard ─────────────────────────────────────────────────

  fastify.get("/dashboard", async (req: any, reply) => {
    try {
      return reply.send(await getDashboard(getBranch(req), parseParams(req.query)));
    } catch (err) { return handleError(err, reply); }
  });

  // ── Sales ─────────────────────────────────────────────────────

  fastify.get("/sales", async (req: any, reply) => {
    try {
      return reply.send(await getSalesReport(getBranch(req), parseParams(req.query)));
    } catch (err) { return handleError(err, reply); }
  });

  // ── Products ──────────────────────────────────────────────────

  fastify.get("/products", async (req: any, reply) => {
    try {
      return reply.send(await getProductReport(getBranch(req), parseParams(req.query)));
    } catch (err) { return handleError(err, reply); }
  });

  // ── Staff ─────────────────────────────────────────────────────

  fastify.get("/staff", async (req: any, reply) => {
    try {
      return reply.send(await getStaffReport(getBranch(req), parseParams(req.query)));
    } catch (err) { return handleError(err, reply); }
  });

  // ── Tables ────────────────────────────────────────────────────

  fastify.get("/tables", async (req: any, reply) => {
    try {
      return reply.send(await getTableReport(getBranch(req), parseParams(req.query)));
    } catch (err) { return handleError(err, reply); }
  });

  // ── Cost / Margin ─────────────────────────────────────────────

  fastify.get("/costs", async (req: any, reply) => {
    try {
      return reply.send(await getCostReport(getBranch(req), parseParams(req.query)));
    } catch (err) { return handleError(err, reply); }
  });
}
