// ============================================================
//  MISE — Receipt Service
//  Generates structured receipt data, stores it, handles
//  print triggers and email/SMS delivery.
// ============================================================

import { PrismaClient } from "@prisma/client";
import { PaymentError } from "../payment/payment.service";
import type { ReceiptData, SendReceiptDto } from "../../types/payment.types";

const prisma = new PrismaClient();

// ── Generate receipt number ───────────────────────────────────

async function generateReceiptNumber(branchId: string): Promise<string> {
  const today  = new Date();
  const prefix = today.toISOString().slice(0, 10).replace(/-/g, ""); // 20260424
  const count  = await prisma.receipt.count({
    where: { branchId, createdAt: { gte: new Date(today.toDateString()) } },
  });
  return `RCP-${prefix}-${String(count + 1).padStart(4, "0")}`;
}

// ── Build receipt data ────────────────────────────────────────

export async function buildReceiptData(
  branchId: string,
  orderId: string
): Promise<ReceiptData> {
  const order = await prisma.order.findFirst({
    where:   { id: orderId, branchId },
    include: {
      table:     { include: { section: true } },
      createdBy: true,
      closedBy:  true,
      items: {
        where:   { status: { notIn: ["CANCELLED", "VOID"] } },
        include: { modifiers: true, product: true },
        orderBy: [{ courseNumber: "asc" }, { createdAt: "asc" }],
      },
      discounts: true,
      payments:  { where: { status: "COMPLETED" }, orderBy: { createdAt: "asc" } },
    },
  });

  if (!order) throw new PaymentError("NOT_FOUND", "Order not found", 404);

  const branch = await prisma.branch.findUnique({
    where:   { id: branchId },
    include: { organization: true },
  });
  if (!branch) throw new PaymentError("NOT_FOUND", "Branch not found", 404);

  const cashier = order.closedBy ?? order.createdBy;

  const items = order.items.map((item) => {
    const modifierTotal = item.modifiers.reduce((s, m) => s + Number(m.price), 0);
    const unitPrice     = Number(item.price) + modifierTotal;
    return {
      name:      item.name,
      quantity:  item.quantity,
      unitPrice: parseFloat(unitPrice.toFixed(2)),
      modifiers: item.modifiers.map((m) =>
        m.price > 0 ? `+ ${m.name} (+${Number(m.price).toFixed(2)})` : `+ ${m.name}`
      ),
      lineTotal: parseFloat((unitPrice * item.quantity).toFixed(2)),
    };
  });

  const payments = order.payments.map((p) => ({
    method:   p.method as any,
    amount:   Number(p.amount),
    tendered: p.tendered ? Number(p.tendered) : undefined,
    change:   p.change   ? Number(p.change)   : undefined,
  }));

  return {
    receiptNo:     "", // filled in on save
    orderNumber:   order.orderNumber,
    branchName:    branch.name,
    branchAddress: branch.address ?? "",
    date:          (order.closedAt ?? order.createdAt).toISOString(),
    cashier:       `${cashier.firstName} ${cashier.lastName}`,
    tableName:     order.table?.name ?? null,
    items,
    subtotal:      Number(order.subtotal),
    taxAmount:     Number(order.taxAmount),
    discountAmount: Number(order.discountAmount),
    total:         Number(order.total),
    payments,
    footer:        `Thank you for dining at ${branch.organization.name}!`,
  };
}

// ── Save receipt to DB ────────────────────────────────────────

export async function createReceipt(branchId: string, orderId: string) {
  // Idempotent — return existing receipt if already created
  const existing = await prisma.receipt.findUnique({ where: { orderId } });
  if (existing) return existing;

  const data      = await buildReceiptData(branchId, orderId);
  const receiptNo = await generateReceiptNumber(branchId);
  data.receiptNo  = receiptNo;

  const receipt = await prisma.receipt.create({
    data: {
      orderId,
      branchId,
      receiptNo,
      content: data as any,
    },
  });

  return receipt;
}

// ── Get receipt ───────────────────────────────────────────────

export async function getReceipt(branchId: string, orderId: string) {
  const receipt = await prisma.receipt.findFirst({
    where: { orderId, branchId },
  });

  if (!receipt) {
    // Auto-generate if missing (e.g. order was closed before receipt was triggered)
    return createReceipt(branchId, orderId);
  }

  return receipt;
}

// ── Send receipt ──────────────────────────────────────────────

export async function sendReceipt(
  branchId: string,
  orderId: string,
  dto: SendReceiptDto
) {
  const receipt = await getReceipt(branchId, orderId);
  const results: Record<string, string> = {};

  if (dto.email) {
    // In production: plug in Nodemailer / SendGrid / AWS SES
    // await emailService.send({ to: dto.email, subject: `Receipt ${receipt.receiptNo}`, ... })
    await prisma.receipt.update({
      where: { id: receipt.id },
      data:  { emailedTo: dto.email },
    });
    results.email = `Receipt queued for ${dto.email}`;
  }

  if (dto.phone) {
    // In production: plug in Twilio / Netgsm / iletimerkezi
    // await smsService.send({ to: dto.phone, message: formatSmsReceipt(receipt) })
    results.sms = `SMS receipt queued for ${dto.phone}`;
  }

  if (dto.print) {
    // In production: send ESC/POS commands to receipt printer
    // await printerService.print(branchId, receipt)
    await prisma.receipt.update({
      where: { id: receipt.id },
      data:  { printedAt: new Date() },
    });
    results.print = "Print job sent to receipt printer";
  }

  return { receiptNo: receipt.receiptNo, actions: results };
}

// ── Format receipt as plain text (for thermal printer) ────────

export function formatReceiptText(data: ReceiptData): string {
  const LINE  = "─".repeat(42);
  const lines: string[] = [];

  const center = (s: string) => s.padStart(Math.floor((42 + s.length) / 2)).padEnd(42);
  const row    = (l: string, r: string) =>
    l.padEnd(42 - r.length) + r;

  lines.push(center(data.branchName));
  lines.push(center(data.branchAddress));
  lines.push(LINE);
  lines.push(`Receipt:  ${data.receiptNo}`);
  lines.push(`Order:    ${data.orderNumber}`);
  lines.push(`Date:     ${new Date(data.date).toLocaleString("tr-TR")}`);
  lines.push(`Cashier:  ${data.cashier}`);
  if (data.tableName) lines.push(`Table:    ${data.tableName}`);
  lines.push(LINE);

  for (const item of data.items) {
    lines.push(`${item.name}`);
    for (const mod of item.modifiers) lines.push(`  ${mod}`);
    lines.push(row(`  ${item.quantity} x ${item.unitPrice.toFixed(2)}`, item.lineTotal.toFixed(2)));
  }

  lines.push(LINE);
  lines.push(row("Subtotal",       data.subtotal.toFixed(2)));
  lines.push(row("Tax (KDV)",      data.taxAmount.toFixed(2)));

  if (data.discountAmount > 0) {
    lines.push(row("Discount",     `-${data.discountAmount.toFixed(2)}`));
  }

  lines.push(LINE);
  lines.push(row("TOTAL",          data.total.toFixed(2)));
  lines.push(LINE);

  for (const p of data.payments) {
    lines.push(row(p.method,        p.amount.toFixed(2)));
    if (p.tendered) lines.push(row("  Tendered",  p.tendered.toFixed(2)));
    if (p.change)   lines.push(row("  Change",    p.change.toFixed(2)));
  }

  lines.push(LINE);
  lines.push(center(data.footer));
  lines.push("");

  return lines.join("\n");
}
