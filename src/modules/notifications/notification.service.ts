// ============================================================
//  MISE — Notifications Service
//  SMS:   Twilio (international) + Netgsm (Turkey)
//  Email: Nodemailer with SMTP / Gmail / SendGrid
// ============================================================

import type { SmsDto, EmailDto, ReceiptEmailDto } from "../../types/integration.types";
import { PrismaClient } from "@prisma/client";
import { buildReceiptData, formatReceiptText } from "../receipt/receipt.service";

const prisma = new PrismaClient();

export class NotificationError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = "NotificationError";
  }
}

// ============================================================
//  SMS
// ============================================================

type SmsProvider = "twilio" | "netgsm" | "mock";

function getSmsProvider(): SmsProvider {
  return (process.env.SMS_PROVIDER as SmsProvider) ?? "mock";
}

export async function sendSms(dto: SmsDto): Promise<{ provider: string; messageId: string }> {
  const provider = getSmsProvider();

  switch (provider) {
    case "twilio":  return twilioSms(dto);
    case "netgsm":  return netgsmSms(dto);
    case "mock":
    default:
      console.log(`[SMS MOCK] To: ${dto.to}\n${dto.message}`);
      return { provider: "mock", messageId: `mock-${Date.now()}` };
  }
}

// ── Twilio ────────────────────────────────────────────────────

async function twilioSms(dto: SmsDto): Promise<{ provider: string; messageId: string }> {
  const Twilio = (await import("twilio")).default;
  const client = new Twilio(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_AUTH_TOKEN!
  );

  try {
    const message = await client.messages.create({
      body: dto.message,
      from: process.env.TWILIO_FROM!,
      to:   dto.to,
    });
    return { provider: "twilio", messageId: message.sid };
  } catch (err: any) {
    throw new NotificationError("TWILIO_ERROR", err.message);
  }
}

// ── Netgsm (Turkey) ───────────────────────────────────────────

async function netgsmSms(dto: SmsDto): Promise<{ provider: string; messageId: string }> {
  const axios = (await import("axios")).default;

  // Normalize Turkish phone number
  const phone = dto.to.replace(/^\+90/, "0").replace(/\D/g, "");

  try {
    const { data } = await axios.get("https://api.netgsm.com.tr/sms/send/get/", {
      params: {
        usercode: process.env.NETGSM_USER_CODE,
        password: process.env.NETGSM_PASSWORD,
        gsmno:    phone,
        message:  dto.message,
        msgheader: process.env.NETGSM_HEADER ?? "MISEPOS",
      },
      timeout: 10_000,
    });

    // Netgsm returns "00 XXXXXXXX" on success (code 00 = sent)
    const [code, msgId] = String(data).trim().split(" ");
    if (!["00", "01", "02"].includes(code)) {
      throw new NotificationError("NETGSM_ERROR", `Netgsm error code: ${code}`);
    }
    return { provider: "netgsm", messageId: msgId ?? code };
  } catch (err: any) {
    if (err instanceof NotificationError) throw err;
    throw new NotificationError("NETGSM_ERROR", err.message);
  }
}

// ── SMS receipt (short format for mobile) ────────────────────

export async function sendSmsReceipt(phone: string, branchId: string, orderId: string): Promise<void> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, branchId },
    include: { table: true },
  });
  if (!order) return;

  const message = [
    `MISE - Fiş`,
    `Sipariş: ${order.orderNumber}`,
    order.table ? `Masa: ${order.table.name}` : null,
    `Toplam: ₺${Number(order.total).toFixed(2)}`,
    `Tarih: ${new Date().toLocaleString("tr-TR")}`,
    `Teşekkürler!`,
  ].filter(Boolean).join("\n");

  await sendSms({ to: phone, message });
}

// ============================================================
//  EMAIL
// ============================================================

type EmailProvider = "smtp" | "sendgrid" | "mock";

function getEmailProvider(): EmailProvider {
  return (process.env.EMAIL_PROVIDER as EmailProvider) ?? "mock";
}

export async function sendEmail(dto: EmailDto): Promise<{ provider: string; messageId: string }> {
  const provider = getEmailProvider();

  switch (provider) {
    case "smtp":      return smtpEmail(dto);
    case "sendgrid":  return sendgridEmail(dto);
    case "mock":
    default:
      console.log(`[EMAIL MOCK] To: ${dto.to}\nSubject: ${dto.subject}`);
      return { provider: "mock", messageId: `mock-${Date.now()}` };
  }
}

// ── Nodemailer SMTP ───────────────────────────────────────────

async function smtpEmail(dto: EmailDto): Promise<{ provider: string; messageId: string }> {
  const nodemailer = await import("nodemailer");

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST!,
    port:   parseInt(process.env.SMTP_PORT ?? "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER!,
      pass: process.env.SMTP_PASS!,
    },
  });

  const info = await transporter.sendMail({
    from:    dto.from ?? `"Mise" <${process.env.SMTP_USER}>`,
    to:      Array.isArray(dto.to) ? dto.to.join(", ") : dto.to,
    subject: dto.subject,
    html:    dto.html,
    text:    dto.text,
  });

  return { provider: "smtp", messageId: info.messageId };
}

// ── SendGrid ──────────────────────────────────────────────────

async function sendgridEmail(dto: EmailDto): Promise<{ provider: string; messageId: string }> {
  const sgMail = (await import("@sendgrid/mail")).default;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

  const [response] = await sgMail.send({
    to:      dto.to,
    from:    dto.from ?? process.env.SENDGRID_FROM!,
    subject: dto.subject,
    html:    dto.html,
    text:    dto.text,
  });

  return { provider: "sendgrid", messageId: response.headers["x-message-id"] as string ?? "" };
}

// ── Receipt email (HTML formatted) ───────────────────────────

export async function sendReceiptEmail(dto: ReceiptEmailDto): Promise<void> {
  const receiptData = await buildReceiptData(dto.branchId, dto.orderId);
  const plainText   = formatReceiptText(receiptData);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Courier New', monospace; background: #f5f5f5; padding: 20px; }
    .receipt { background: white; max-width: 400px; margin: 0 auto; padding: 24px;
                border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
    h2 { text-align: center; margin: 0 0 8px; font-size: 18px; }
    .divider { border: none; border-top: 1px dashed #ccc; margin: 12px 0; }
    .row { display: flex; justify-content: space-between; margin: 4px 0; font-size: 13px; }
    .total { font-weight: bold; font-size: 16px; margin-top: 8px; }
    .footer { text-align: center; margin-top: 16px; font-size: 12px; color: #666; }
    pre { white-space: pre-wrap; font-size: 12px; }
  </style>
</head>
<body>
  <div class="receipt">
    <h2>${receiptData.branchName}</h2>
    <p style="text-align:center;font-size:12px;color:#666">${receiptData.branchAddress}</p>
    <hr class="divider">
    <div class="row"><span>Receipt:</span><span>${receiptData.receiptNo}</span></div>
    <div class="row"><span>Order:</span><span>${receiptData.orderNumber}</span></div>
    <div class="row"><span>Date:</span><span>${new Date(receiptData.date).toLocaleString("tr-TR")}</span></div>
    <div class="row"><span>Cashier:</span><span>${receiptData.cashier}</span></div>
    ${receiptData.tableName ? `<div class="row"><span>Table:</span><span>${receiptData.tableName}</span></div>` : ""}
    <hr class="divider">
    ${receiptData.items.map((i) => `
      <div class="row"><span><strong>${i.name}</strong></span></div>
      ${i.modifiers.map((m) => `<div class="row" style="color:#888"><span>  ${m}</span></div>`).join("")}
      <div class="row"><span>  ${i.quantity} × ₺${i.unitPrice.toFixed(2)}</span><span>₺${i.lineTotal.toFixed(2)}</span></div>
    `).join("")}
    <hr class="divider">
    <div class="row"><span>Subtotal</span><span>₺${receiptData.subtotal.toFixed(2)}</span></div>
    <div class="row"><span>Tax (KDV)</span><span>₺${receiptData.taxAmount.toFixed(2)}</span></div>
    ${receiptData.discountAmount > 0 ? `<div class="row" style="color:green"><span>Discount</span><span>-₺${receiptData.discountAmount.toFixed(2)}</span></div>` : ""}
    <hr class="divider">
    <div class="row total"><span>TOTAL</span><span>₺${receiptData.total.toFixed(2)}</span></div>
    <hr class="divider">
    ${receiptData.payments.map((p) => `
      <div class="row"><span>${p.method}</span><span>₺${p.amount.toFixed(2)}</span></div>
      ${p.change ? `<div class="row"><span>  Change</span><span>₺${p.change.toFixed(2)}</span></div>` : ""}
    `).join("")}
    <div class="footer">${receiptData.footer}</div>
  </div>
</body>
</html>`;

  await sendEmail({
    to:      dto.to,
    subject: `Receipt ${receiptData.receiptNo} — ${receiptData.branchName}`,
    html,
    text:    plainText,
  });

  // Mark receipt as emailed
  await prisma.receipt.updateMany({
    where: { orderId: dto.orderId },
    data:  { emailedTo: dto.to },
  });
}
