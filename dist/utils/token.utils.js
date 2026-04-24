// ============================================================
//  MISE — Token Utilities
// ============================================================

import { FastifyInstance } from "fastify";
import { JwtPayload, RefreshPayload, TokenPair } from "../types/auth.types";
import { env } from "../config/env";

// Parse duration string to seconds (e.g. "15m" → 900)
export function parseDurationToSeconds(duration: string): number {
  const units: Record<string, number> = {
    s: 1, m: 60, h: 3600, d: 86400, w: 604800,
  };
  const match = duration.match(/^(\d+)([smhdw])$/);
  if (!match) return 900;
  return parseInt(match[1]) * (units[match[2]] ?? 60);
}

export async function generateTokenPair(
  fastify: FastifyInstance,
  payload: Omit<JwtPayload, "iat" | "exp">
): Promise<TokenPair> {
  const accessToken = fastify.jwt.sign(payload, {
    expiresIn: env.JWT_EXPIRES_IN,
  });

  const refreshPayload: RefreshPayload = {
    sub: payload.sub,
    sessionId: payload.sessionId,
  };

  // Sign refresh token with a different secret via options
  const refreshToken = fastify.jwt.sign(refreshPayload, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
    // Use a distinct key for refresh tokens
    key: env.JWT_REFRESH_SECRET,
  } as any);

  return {
    accessToken,
    refreshToken,
    expiresIn: parseDurationToSeconds(env.JWT_EXPIRES_IN),
  };
}

export function verifyRefreshToken(
  fastify: FastifyInstance,
  token: string
): RefreshPayload {
  return fastify.jwt.verify<RefreshPayload>(token, {
    key: env.JWT_REFRESH_SECRET,
  } as any);
}
