// ============================================================
//  MISE — WebSocket Manager
//  Real-time pub/sub for KDS, POS terminals, and admin screens.
//  All clients in the same branch receive the same events.
// ============================================================

import type { WebSocket } from "@fastify/websocket";
import type { WsEvent, WsEventType } from "../types/order.types";

interface WsClient {
  ws:       WebSocket;
  branchId: string;
  role:     string;
  userId:   string;
  device:   string;
}

class WebSocketManager {
  private clients = new Map<string, WsClient>(); // connectionId → client

  // ── Register a new connection ────────────────────────────────

  register(connectionId: string, client: WsClient) {
    this.clients.set(connectionId, client);
    console.log(
      `[WS] +client ${connectionId} | branch=${client.branchId} role=${client.role} device=${client.device}`
    );
  }

  // ── Remove a connection ──────────────────────────────────────

  unregister(connectionId: string) {
    const client = this.clients.get(connectionId);
    if (client) {
      this.clients.delete(connectionId);
      console.log(`[WS] -client ${connectionId} | branch=${client.branchId}`);
    }
  }

  // ── Broadcast to all clients in a branch ─────────────────────

  broadcast(branchId: string, event: WsEventType, payload: Record<string, any>) {
    const message: WsEvent = {
      event,
      branchId,
      payload,
      ts: new Date().toISOString(),
    };

    const raw = JSON.stringify(message);
    let sent = 0;

    for (const [id, client] of this.clients) {
      if (client.branchId !== branchId) continue;
      try {
        if (client.ws.readyState === 1 /* OPEN */) {
          client.ws.send(raw);
          sent++;
        } else {
          // Clean up dead connections
          this.clients.delete(id);
        }
      } catch {
        this.clients.delete(id);
      }
    }

    console.log(`[WS] broadcast ${event} → branch=${branchId} sent=${sent}`);
  }

  // ── Broadcast only to KDS screens ────────────────────────────

  broadcastToKitchen(branchId: string, event: WsEventType, payload: Record<string, any>) {
    const message: WsEvent = { event, branchId, payload, ts: new Date().toISOString() };
    const raw = JSON.stringify(message);

    for (const [id, client] of this.clients) {
      if (client.branchId !== branchId) continue;
      if (client.role !== "KITCHEN" && client.role !== "MANAGER") continue;
      try {
        if (client.ws.readyState === 1) {
          client.ws.send(raw);
        } else {
          this.clients.delete(id);
        }
      } catch {
        this.clients.delete(id);
      }
    }
  }

  // ── Connection count (health / diagnostics) ──────────────────

  getStats() {
    const byBranch: Record<string, number> = {};
    for (const client of this.clients.values()) {
      byBranch[client.branchId] = (byBranch[client.branchId] ?? 0) + 1;
    }
    return { total: this.clients.size, byBranch };
  }
}

// Singleton — one WsManager for the whole server process
export const wsManager = new WebSocketManager();
