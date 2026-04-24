// ============================================================
//  MISE — Outbound Webhook Service
//  Signs payloads with HMAC-SHA256, delivers via HTTP POST,
//  retries on failure (exponential backoff, max 5 attempts).
// ============================================================

import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import type { WebhookEvent } from "../../types/integration.types";

const prisma = new PrismaClient();

export class WebhookError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "WebhookError";
  }
}

// ── Register a webhook endpoint ────────────────────────────────

export async function registerWebhook(branchId: string, dto: {
  url:    string;
  events: WebhookEvent[];
}) {
  const secret = crypto.randomBytes(32).toString("hex");

  return (prisma as any).webhookEndpoint?.create({
    data: {
      branchId,
      url:      dto.url,
      events:   dto.events,
      secret,
      isActive: true,
    },
    select: { id: true, url: true, events: true, secret: true, isActive: true },
  });
}

export async function getWebhooks(branchId: string) {
  return (prisma as any).webhookEndpoint?.findMany({
    where:   { branchId, isActive: true },
    select:  { id: true, url: true, events: true, isActive: true, createdAt: true },
  }) ?? [];
}

export async function deleteWebhook(branchId: string, webhookId: string) {
  return (prisma as any).webhookEndpoint?.update({
    where: { id: webhookId },
    data:  { isActive: false },
  });
}

// ── Dispatch event to all registered endpoints ─────────────────

export async function dispatchWebhook(
  branchId: string,
  event:    WebhookEvent,
  payload:  Record<string, any>
): Promise<void> {
  const endpoints = await (prisma as any).webhookEndpoint?.findMany({
    where: { branchId, isActive: true },
  }) ?? [];

  const matchingEndpoints = endpoints.filter(
    (ep: any) => ep.events.includes(event) || ep.events.includes("*")
  );

  if (matchingEndpoints.length === 0) return;

  const body      = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
  const deliveries = matchingEndpoints.map((ep: any) =>
    deliverWebhook(ep, event, body)
  );

  // Fire all deliveries concurrently — non-blocking
  await Promise.allSettled(deliveries);
}

// ── Deliver a single webhook with retry ───────────────────────

async function deliverWebhook(
  endpoint: { id: string; url: string; secret: string },
  event:    WebhookEvent,
  body:     string,
  attempt   = 1,
  maxAttempts = 5
): Promise<void> {
  const signature = crypto
    .createHmac("sha256", endpoint.secret)
    .update(body)
    .digest("hex");

  try {
    const { default: axios } = await import("axios");

    const response = await axios.post(endpoint.url, body, {
      headers: {
        "Content-Type":          "application/json",
        "X-Mise-Event":         event,
        "X-Mise-Signature":     `sha256=${signature}`,
        "X-Mise-Delivery-Id":   crypto.randomUUID(),
        "X-Mise-Timestamp":     String(Date.now()),
      },
      timeout: 10_000,
    });

    // Log success
    await (prisma as any).auditLog?.create({
      data: {
        userId:     "system",
        action:     "WEBHOOK_DELIVERED",
        entityType: "WebhookEndpoint",
        entityId:   endpoint.id,
        newValue:   { event, statusCode: response.status, attempt },
      },
    }).catch(() => {});

  } catch (err: any) {
    const statusCode = err.response?.status;
    const isRetryable = !statusCode || statusCode >= 500 || statusCode === 429;

    if (isRetryable && attempt < maxAttempts) {
      // Exponential backoff: 5s, 25s, 125s, 625s
      const delayMs = Math.pow(5, attempt) * 1000;
      console.warn(`[Webhook] Retry ${attempt}/${maxAttempts} for ${endpoint.url} in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
      return deliverWebhook(endpoint, event, body, attempt + 1, maxAttempts);
    }

    // Log failure
    await (prisma as any).auditLog?.create({
      data: {
        userId:     "system",
        action:     "WEBHOOK_FAILED",
        entityType: "WebhookEndpoint",
        entityId:   endpoint.id,
        newValue:   { event, error: err.message, statusCode, attempt },
      },
    }).catch(() => {});

    console.error(`[Webhook] Failed delivery to ${endpoint.url}: ${err.message}`);
  }
}

// ── Verify incoming webhook signature (for delivery platforms) ──

export function verifyIncomingWebhook(
  secret:    string,
  payload:   string,
  signature: string
): boolean {
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Get recent webhook deliveries ─────────────────────────────

export async function getWebhookDeliveries(branchId: string, limit = 50) {
  return (prisma as any).auditLog?.findMany({
    where: {
      action:     { in: ["WEBHOOK_DELIVERED", "WEBHOOK_FAILED"] },
      entityType: "WebhookEndpoint",
    },
    orderBy: { createdAt: "desc" },
    take:    limit,
  }) ?? [];
}
