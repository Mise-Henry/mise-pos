// ============================================================
//  MISE — Master Server Entry Point
//  Registers all modules: auth, menu, tables, orders, KDS,
//  payments, reports, inventory, org, integrations + WebSocket
// ============================================================

import Fastify from "fastify";
import cors        from "@fastify/cors";
import rateLimit   from "@fastify/rate-limit";
import websocket   from "@fastify/websocket";

// ── Route modules ─────────────────────────────────────────────
import { authRoutes }         from "./modules/auth/auth.routes";
import { menuRoutes }         from "./modules/menu/menu.routes";
import { tableRoutes }        from "./modules/table/table.routes";
import { orderRoutes, kdsRoutes, wsRoutes } from "./modules/order/order.routes";
import { paymentRoutes }      from "./modules/payment/payment.routes";
import { reportingRoutes }    from "./modules/reporting/reporting.routes";
import { inventoryRoutes }    from "./modules/inventory/inventory.routes";
import { orgRoutes }          from "./modules/organization/organization.routes";
import { integrationRoutes }  from "./modules/integration.routes";

// ── Auth middleware plugin ────────────────────────────────────
import authPlugin from "./middleware/auth.middleware";

const server = Fastify({
  logger: {
    level: process.env.NODE_ENV === "production" ? "warn" : "info",
    ...(process.env.NODE_ENV !== "production" && {
      transport: { target: "pino-pretty", options: { colorize: true } },
    }),
  },
});

async function bootstrap() {
  // ── Plugins ────────────────────────────────────────────────
  await server.register(cors, {
    origin:      process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:5173"],
    credentials: true,
  });

  await server.register(rateLimit, {
    max:        100,
    timeWindow: "1 minute",
  });

  await server.register(websocket);
  await server.register(authPlugin);

  // ── Health check ───────────────────────────────────────────
  server.get("/health", async () => ({
    status:    "ok",
    version:   "1.0.0",
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV ?? "development",
  }));

  // ── Routes ─────────────────────────────────────────────────
  await server.register(authRoutes,        { prefix: "/auth"         });
  await server.register(menuRoutes,        { prefix: "/menu"         });
  await server.register(tableRoutes,       { prefix: "/tables"       });
  await server.register(orderRoutes,       { prefix: "/orders"       });
  await server.register(kdsRoutes,         { prefix: "/kds"          });
  await server.register(paymentRoutes,     { prefix: "/payments"     });
  await server.register(reportingRoutes,   { prefix: "/reports"      });
  await server.register(inventoryRoutes,   { prefix: "/inventory"    });
  await server.register(orgRoutes,         { prefix: "/org"          });
  await server.register(integrationRoutes, { prefix: "/integrations" });
  await server.register(wsRoutes);  // /ws WebSocket endpoint

  // ── Global error handler ───────────────────────────────────
  server.setErrorHandler((error, _req, reply) => {
    server.log.error(error);

    if (error.validation) {
      return reply.status(400).send({
        error:   "VALIDATION_ERROR",
        message: "Invalid request data",
        details: error.validation,
      });
    }

    return reply.status(error.statusCode ?? 500).send({
      error:   "INTERNAL_ERROR",
      message: process.env.NODE_ENV === "production"
        ? "Something went wrong"
        : error.message,
    });
  });

  // ── Not found handler ──────────────────────────────────────
  server.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: "NOT_FOUND", message: "Route not found" });
  });

  // ── Start ──────────────────────────────────────────────────
  const PORT = parseInt(process.env.PORT ?? "3001", 10);
  const HOST = process.env.HOST ?? "0.0.0.0";

  await server.listen({ port: PORT, host: HOST });

  console.log("\n╔══════════════════════════════════════╗");
  console.log("║        MISE — API Server        ║");
  console.log("╠══════════════════════════════════════╣");
  console.log(`║  http://localhost:${PORT}              ║`);
  console.log(`║  ws://localhost:${PORT}/ws             ║`);
  console.log(`║  Env: ${(process.env.NODE_ENV ?? "development").padEnd(29)}║`);
  console.log("╚══════════════════════════════════════╝\n");
}

bootstrap().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
