// ============================================================
//  MISE — Auth Validation Schemas (Zod)
// ============================================================

import { z } from "zod";

export const loginEmailSchema = z.object({
  email:    z.string().email("Valid email required"),
  password: z.string().min(1, "Password required"),
  device:   z.string().optional(),
});

export const loginPinSchema = z.object({
  branchId: z.string().cuid("Valid branch ID required"),
  pin:      z.string().length(4).regex(/^\d{4}$/, "PIN must be 4 digits"),
  device:   z.string().optional(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token required"),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8, "Password must be at least 8 characters"),
});

export const changePinSchema = z.object({
  pin: z.string().length(4).regex(/^\d{4}$/, "PIN must be 4 digits"),
});

// Fastify JSON Schema equivalents (for route-level validation)
export const loginEmailJsonSchema = {
  body: {
    type: "object",
    required: ["email", "password"],
    properties: {
      email:    { type: "string", format: "email" },
      password: { type: "string", minLength: 1 },
      device:   { type: "string" },
    },
  },
};

export const loginPinJsonSchema = {
  body: {
    type: "object",
    required: ["branchId", "pin"],
    properties: {
      branchId: { type: "string" },
      pin:      { type: "string", minLength: 4, maxLength: 4 },
      device:   { type: "string" },
    },
  },
};

export const refreshJsonSchema = {
  body: {
    type: "object",
    required: ["refreshToken"],
    properties: {
      refreshToken: { type: "string" },
    },
  },
};
