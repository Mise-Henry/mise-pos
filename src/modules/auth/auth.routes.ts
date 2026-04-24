// ============================================================
//  MISE — Auth Routes
//  POST /auth/login
//  POST /auth/login/pin
//  POST /auth/refresh
//  POST /auth/logout
//  POST /auth/logout/all
//  GET  /auth/me
//  POST /auth/change-password
//  POST /auth/change-pin
// ============================================================

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  loginWithEmail,
  loginWithPin,
  refreshAccessToken,
  logout,
  logoutAllDevices,
  getMe,
  changePassword,
  changePin,
} from "./auth.service";
import {
  loginEmailSchema,
  loginPinSchema,
  refreshTokenSchema,
  changePasswordSchema,
  changePinSchema,
  loginEmailJsonSchema,
  loginPinJsonSchema,
  refreshJsonSchema,
} from "./auth.schema";

export async function authRoutes(fastify: FastifyInstance) {
  // ── POST /auth/login ───────────────────────────────────────
  fastify.post(
    "/login",
    { schema: loginEmailJsonSchema },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = loginEmailSchema.parse(req.body);
      const ip = req.ip ?? req.headers["x-forwarded-for"]?.toString();

      const result = await loginWithEmail(
        fastify,
        body.email,
        body.password,
        body.device,
        ip
      );

      return reply.code(200).send({
        success: true,
        data: result,
      });
    }
  );

  // ── POST /auth/login/pin ───────────────────────────────────
  // Used by POS terminals — faster login via 4-digit PIN
  fastify.post(
    "/login/pin",
    { schema: loginPinJsonSchema },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = loginPinSchema.parse(req.body);
      const ip = req.ip ?? req.headers["x-forwarded-for"]?.toString();

      const result = await loginWithPin(
        fastify,
        body.branchId,
        body.pin,
        body.device,
        ip
      );

      return reply.code(200).send({
        success: true,
        data: result,
      });
    }
  );

  // ── POST /auth/refresh ─────────────────────────────────────
  fastify.post(
    "/refresh",
    { schema: refreshJsonSchema },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = refreshTokenSchema.parse(req.body);
      const tokens = await refreshAccessToken(fastify, body.refreshToken);

      return reply.code(200).send({
        success: true,
        data: tokens,
      });
    }
  );

  // ── POST /auth/logout ──────────────────────────────────────
  // Requires valid access token
  fastify.post(
    "/logout",
    { onRequest: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.user as any;
      await logout(user.sessionId);

      return reply.code(200).send({
        success: true,
        message: "Logged out successfully",
      });
    }
  );

  // ── POST /auth/logout/all ──────────────────────────────────
  // Revoke ALL sessions for the user (e.g. phone lost)
  fastify.post(
    "/logout/all",
    { onRequest: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.user as any;
      await logoutAllDevices(user.sub);

      return reply.code(200).send({
        success: true,
        message: "All sessions revoked",
      });
    }
  );

  // ── GET /auth/me ───────────────────────────────────────────
  fastify.get(
    "/me",
    { onRequest: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.user as any;
      const data = await getMe(user.sub);

      return reply.code(200).send({
        success: true,
        data,
      });
    }
  );

  // ── POST /auth/change-password ─────────────────────────────
  fastify.post(
    "/change-password",
    { onRequest: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.user as any;
      const body = changePasswordSchema.parse(req.body);

      await changePassword(user.sub, body.currentPassword, body.newPassword);

      return reply.code(200).send({
        success: true,
        message: "Password updated. Please log in again.",
      });
    }
  );

  // ── POST /auth/change-pin ──────────────────────────────────
  fastify.post(
    "/change-pin",
    { onRequest: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.user as any;
      const body = changePinSchema.parse(req.body);

      await changePin(user.sub, body.pin);

      return reply.code(200).send({
        success: true,
        message: "PIN updated successfully",
      });
    }
  );
}
