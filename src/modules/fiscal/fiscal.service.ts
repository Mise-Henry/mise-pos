// ============================================================
//  MISE — Fiscal Printer / Yazarkasa Service
//  Supports: Epson TM series via network ESC/POS
//            Mock driver for development
//  Turkish GİB ÖKC (Ödeme Kaydedici Cihaz) integration
//  would use the official GİB API — shown as a stub below.
// ============================================================

import net from "net";
import { PrismaClient } from "@prisma/client";
import type { FiscalReceiptDto, FiscalSubmitResult } from "../../types/integration.types";

const prisma = new PrismaClient();

export class FiscalError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = "FiscalError";
  }
}

// ── ESC/POS command constants ─────────────────────────────────

const ESC  = 0x1b;
const GS   = 0x1d;
const LF   = 0x0a;
const CR   = 0x0d;

const CMD = {
  INIT:       Buffer.from([ESC, 0x40]),
  BOLD_ON:    Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF:   Buffer.from([ESC, 0x45, 0x00]),
  CENTER:     Buffer.from([ESC, 0x61, 0x01]),
  LEFT:       Buffer.from([ESC, 0x61, 0x00]),
  RIGHT:      Buffer.from([ESC, 0x61, 0x02]),
  DOUBLE_H:   Buffer.from([GS,  0x21, 0x10]),
  NORMAL:     Buffer.from([GS,  0x21, 0x00]),
  CUT:        Buffer.from([GS,  0x56, 0x41, 0x05]),
  FEED:       (lines: number) => Buffer.from([ESC, 0x64, lines]),
};

// ── Build ESC/POS receipt buffer ──────────────────────────────

function buildReceiptBuffer(dto: FiscalReceiptDto, branchName: string, branchAddress: string): Buffer {
  const buffers: Buffer[] = [];

  const text = (s: string) => Buffer.from(s + "\n", "latin1");
  const line = (char = "─") => text(char.repeat(42));

  const col = (left: string, right: string, width = 42) => {
    const space = Math.max(1, width - left.length - right.length);
    return text(left + " ".repeat(space) + right);
  };

  // Header
  buffers.push(CMD.INIT, CMD.CENTER, CMD.BOLD_ON, CMD.DOUBLE_H);
  buffers.push(text(branchName.slice(0, 30)));
  buffers.push(CMD.NORMAL, CMD.BOLD_OFF);
  buffers.push(text(branchAddress.slice(0, 42)));
  buffers.push(CMD.LEFT);
  buffers.push(line());

  // Receipt info
  buffers.push(text(`Fiş No:   ${dto.receiptNo}`));
  buffers.push(text(`Sipariş:  ${dto.orderId}`));
  buffers.push(text(`Tarih:    ${new Date().toLocaleString("tr-TR")}`));
  buffers.push(text(`Kasiyer:  ${dto.cashier}`));
  buffers.push(line());

  // Items
  for (const line_ of dto.lines) {
    buffers.push(CMD.BOLD_ON);
    buffers.push(text(line_.description.slice(0, 30)));
    buffers.push(CMD.BOLD_OFF);
    const qty      = `${line_.quantity} x ${line_.unitPrice.toFixed(2)}`;
    const total    = line_.total.toFixed(2);
    buffers.push(col(`  ${qty}`, total));
    if (line_.taxRate > 0) {
      buffers.push(text(`  KDV %${line_.taxRate}`));
    }
  }

  buffers.push(line());

  // Totals
  buffers.push(col("Ara Toplam:", dto.subtotal.toFixed(2)));
  buffers.push(col("KDV:",        dto.taxAmount.toFixed(2)));

  buffers.push(CMD.BOLD_ON, CMD.DOUBLE_H);
  buffers.push(col("TOPLAM:",     dto.total.toFixed(2)));
  buffers.push(CMD.NORMAL, CMD.BOLD_OFF);

  buffers.push(line());
  buffers.push(col("Ödeme:", dto.paymentMethod));
  buffers.push(line());

  // Footer
  buffers.push(CMD.CENTER);
  buffers.push(text("Bizi tercih ettiğiniz için"));
  buffers.push(text("teşekkür ederiz!"));
  buffers.push(CMD.FEED(4));
  buffers.push(CMD.CUT);

  return Buffer.concat(buffers);
}

// ── Send to Epson TM printer via TCP/IP ──────────────────────

async function printToEpson(
  host: string,
  port: number,
  data: Buffer,
  timeoutMs = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer  = setTimeout(() => {
      socket.destroy();
      reject(new FiscalError("PRINTER_TIMEOUT", `Printer at ${host}:${port} timed out`));
    }, timeoutMs);

    socket.connect(port, host, () => {
      socket.write(data, (err) => {
        clearTimeout(timer);
        socket.end();
        if (err) reject(new FiscalError("PRINTER_WRITE_ERROR", err.message));
        else     resolve();
      });
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(new FiscalError("PRINTER_CONNECT_ERROR", `Cannot reach printer: ${err.message}`));
    });
  });
}

// ── Main submit function ──────────────────────────────────────

export async function submitFiscalReceipt(
  branchId:  string,
  deviceId:  string,
  dto:       FiscalReceiptDto
): Promise<FiscalSubmitResult> {
  // Get device config from DB
  const device = await (prisma as any).fiscalDevice?.findFirst({
    where: { id: deviceId, branchId, isActive: true },
  });
  if (!device) throw new FiscalError("DEVICE_NOT_FOUND", "Fiscal device not found", 404);

  const branch = await prisma.branch.findUnique({
    where:   { id: branchId },
    include: { organization: true },
  });

  const branchName    = branch?.name             ?? "Restaurant";
  const branchAddress = branch?.address          ?? "";

  switch (device.deviceType as string) {
    case "epson_tm":
      return epsonSubmit(device, dto, branchName, branchAddress);
    case "mock":
      return mockSubmit(device, dto);
    default:
      throw new FiscalError("UNSUPPORTED_DEVICE", `Device type ${device.deviceType} not supported`);
  }
}

async function epsonSubmit(
  device:        any,
  dto:           FiscalReceiptDto,
  branchName:    string,
  branchAddress: string
): Promise<FiscalSubmitResult> {
  const [host, portStr] = (device.address as string).split(":");
  const port            = parseInt(portStr ?? "9100", 10);

  const buffer = buildReceiptBuffer(dto, branchName, branchAddress);

  try {
    await printToEpson(host, port, buffer);
  } catch (err: any) {
    // Log failure but don't crash the order flow
    await prisma.auditLog.create({
      data: {
        userId:     "system",
        action:     "FISCAL_PRINT_FAILED",
        entityType: "Order",
        entityId:   dto.orderId,
        newValue:   { error: err.message, deviceId: device.id },
      },
    });
    throw err;
  }

  // Generate mock Z-number (in production: read from device response)
  const zNumber   = `Z${Date.now()}`;
  const receiptNo = dto.receiptNo;

  // Persist fiscal record
  await (prisma as any).fiscalRecord?.create({
    data: {
      orderId:   dto.orderId,
      deviceId:  device.id,
      status:    "APPROVED",
      zNumber,
      receiptNo,
      submittedAt: new Date(),
      response:  { printed: true },
    },
  }).catch(() => {/* non-blocking */});

  return {
    deviceId:  device.id,
    zNumber,
    receiptNo,
    status:    "approved",
    raw:       { printed: true, host, port },
  };
}

async function mockSubmit(device: any, dto: FiscalReceiptDto): Promise<FiscalSubmitResult> {
  console.log(`[FISCAL MOCK] Printing receipt ${dto.receiptNo} for order ${dto.orderId}`);
  await new Promise((r) => setTimeout(r, 200)); // simulate network

  return {
    deviceId:  device.id,
    zNumber:   `MOCK-Z-${Date.now()}`,
    receiptNo: dto.receiptNo,
    status:    "approved",
    raw:       { mock: true },
  };
}

// ── Get fiscal devices for branch ─────────────────────────────

export async function getFiscalDevices(branchId: string) {
  return (prisma as any).fiscalDevice?.findMany({
    where:   { branchId, isActive: true },
    orderBy: { name: "asc" },
  }) ?? [];
}

export async function createFiscalDevice(branchId: string, dto: {
  name: string; deviceType: string; serialNo: string; address: string;
}) {
  return (prisma as any).fiscalDevice?.create({
    data: { branchId, ...dto },
  });
}
