// ============================================================
//  MISE — JWT Plugin
// ============================================================

import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import { FastifyInstance } from "fastify";
import { env } from "../config/env";

export const jwtPlugin = fp(async (fastify: FastifyInstance) => {
  fastify.register(jwt, {
    secret: env.JWT_SECRET,
    // Decode options
    decode: { complete: true },
    sign: {
      algorithm: "HS256",
      expiresIn: env.JWT_EXPIRES_IN,
    },
    verify: {
      algorithms: ["HS256"],
    },
  });
});
