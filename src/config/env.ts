// ============================================================
//  MISE — Env Config (validated at startup)
// ============================================================

import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL:           z.string().url(),
  JWT_SECRET:             z.string().min(32),
  JWT_REFRESH_SECRET:     z.string().min(32),
  JWT_EXPIRES_IN:         z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  PORT:                   z.coerce.number().default(3001),
  HOST:                   z.string().default("0.0.0.0"),
  NODE_ENV:               z.enum(["development", "production", "test"]).default("development"),
  REDIS_URL:              z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
