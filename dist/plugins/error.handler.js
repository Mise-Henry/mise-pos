// ============================================================
//  MISE — Global Error Handler
// ============================================================

import { FastifyInstance, FastifyError } from "fastify";
import { ZodError } from "zod";

export function registerErrorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError | any, req, reply) => {
    // Zod validation errors
    if (error instanceof ZodError) {
      return reply.code(400).send({
        success: false,
        error: "Validation failed",
        details: error.flatten().fieldErrors,
      });
    }

    // Custom thrown errors (e.g. { statusCode: 401, message: "..." })
    if (error.statusCode && error.message) {
      return reply.code(error.statusCode).send({
        success: false,
        error: error.message,
      });
    }

    // Fastify validation errors (JSON Schema)
    if (error.validation) {
      return reply.code(400).send({
        success: false,
        error: "Invalid request",
        details: error.validation,
      });
    }

    // JWT errors
    if (error.code === "FST_JWT_NO_AUTHORIZATION_IN_HEADER") {
      return reply.code(401).send({
        success: false,
        error: "Authorization header required",
      });
    }

    // Default 500
    fastify.log.error(error);
    return reply.code(500).send({
      success: false,
      error: "Internal server error",
    });
  });
}
