// ============================================================
//  MISE — Auth Middleware
//  Provides: fastify.authenticate  (verifies JWT)
//            fastify.authorize     (checks permission)
//            fastify.requireRoles  (checks role)
// ============================================================

import {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  preHandlerHookHandler,
} from "fastify";
import { JwtPayload, Permission, hasPermission } from "../types/auth.types";
import { prisma } from "../config/prisma";

// Augment Fastify types
declare module "fastify" {
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
    authorize: (permission: Permission) => preHandlerHookHandler;
    requireRoles: (...roles: string[]) => preHandlerHookHandler;
  }
  interface FastifyRequest {
    user: JwtPayload;
  }
}

import fp from "fastify-plugin";

async function registerAuthMiddleware(fastify: FastifyInstance) {
  // ── authenticate ────────────────────────────────────────────
  // Verifies JWT, attaches decoded payload to req.user
  // Also validates that the session still exists in DB
  fastify.decorate(
    "authenticate",
    async function (req: FastifyRequest, reply: FastifyReply) {
      try {
        // Verify JWT signature and expiry
        await req.jwtVerify();
        const payload = req.user as JwtPayload;

        // Check session hasn't been revoked
        const session = await prisma.session.findUnique({
          where: { id: payload.sessionId },
        });

        if (!session || session.expiresAt < new Date()) {
          return reply.code(401).send({
            success: false,
            error: "Session expired. Please log in again.",
          });
        }
      } catch (err: any) {
        return reply.code(401).send({
          success: false,
          error: err.message ?? "Unauthorized",
        });
      }
    }
  );

  // ── authorize ────────────────────────────────────────────────
  // Usage: { onRequest: [fastify.authenticate, fastify.authorize("orders:write")] }
  fastify.decorate(
    "authorize",
    function (permission: Permission): preHandlerHookHandler {
      return async function (req: FastifyRequest, reply: FastifyReply) {
        const user = req.user as JwtPayload;

        if (!hasPermission(user.role, permission)) {
          return reply.code(403).send({
            success: false,
            error: `Forbidden. Required permission: ${permission}`,
          });
        }
      };
    }
  );

  // ── requireRoles ─────────────────────────────────────────────
  // Usage: { onRequest: [fastify.authenticate, fastify.requireRoles("ADMIN","MANAGER")] }
  fastify.decorate(
    "requireRoles",
    function (...roles: string[]): preHandlerHookHandler {
      return async function (req: FastifyRequest, reply: FastifyReply) {
        const user = req.user as JwtPayload;

        if (!roles.includes(user.role)) {
          return reply.code(403).send({
            success: false,
            error: `Forbidden. Required roles: ${roles.join(", ")}`,
          });
        }
      };
    }
  );
}
export default fp(registerAuthMiddleware);

export async function authenticate(req: any, reply: any) {
  return req.jwtVerify();
}

export function requireRole(...roles: string[]) {
  return async function(req: any, reply: any) {
    if (!roles.includes(req.user?.role)) {
      return reply.code(403).send({ success: false, error: "Forbidden" });
    }
  };
}

export function requirePermission(...perms: string[]) {
  return async function(req: any, reply: any) {
    if (!perms.some(p => req.user?.permissions?.includes(p))) {
      return reply.code(403).send({ success: false, error: "Forbidden" });
    }
  };
}
