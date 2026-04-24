// ============================================================
//  MISE — Purchase Order Service
//  Create POs, receive stock, track delivery discrepancies
// ============================================================

import { PrismaClient } from "@prisma/client";
import { InventoryError } from "../inventory/inventory.service";
import type {
  CreatePurchaseOrderDto,
  ReceivePurchaseOrderDto,
  PurchaseOrderStatus,
} from "../../types/inventory.types";

const prisma = new PrismaClient();

// ── Generate PO number ────────────────────────────────────────

async function generatePoNumber(branchId: string): Promise<string> {
  const count = await (prisma as any).purchaseOrder?.count({ where: { branchId } }) ?? 0;
  return `PO-${String(count + 1).padStart(5, "0")}`;
}

// ── List purchase orders ──────────────────────────────────────

export async function getPurchaseOrders(
  branchId: string,
  status?: PurchaseOrderStatus,
  page = 1,
  limit = 20
) {
  const where: any = { branchId, ...(status && { status }) };

  const [items, total] = await Promise.all([
    (prisma as any).purchaseOrder?.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        lines:    { include: { stockItem: { select: { id: true, name: true, unit: true } } } },
      },
      orderBy: { createdAt: "desc" },
      skip:    (page - 1) * limit,
      take:    limit,
    }) ?? [],
    (prisma as any).purchaseOrder?.count({ where }) ?? 0,
  ]);

  return { items, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
}

export async function getPurchaseOrderById(branchId: string, poId: string) {
  const po = await (prisma as any).purchaseOrder?.findFirst({
    where:   { id: poId, branchId },
    include: {
      supplier: true,
      lines: {
        include: { stockItem: { select: { id: true, name: true, unit: true, currentQty: true } } },
      },
      createdBy: { select: { firstName: true, lastName: true } },
    },
  });
  if (!po) throw new InventoryError("NOT_FOUND", "Purchase order not found", 404);
  return po;
}

// ── Create purchase order ─────────────────────────────────────

export async function createPurchaseOrder(
  branchId: string,
  createdById: string,
  dto: CreatePurchaseOrderDto
) {
  // Validate supplier
  const supplier = await (prisma as any).supplier?.findFirst({
    where: { id: dto.supplierId, branchId },
  });
  if (!supplier) throw new InventoryError("NOT_FOUND", "Supplier not found", 404);

  // Validate stock items
  const stockIds = dto.lines.map((l) => l.stockItemId);
  const stockItems = await prisma.stockItem.findMany({
    where: { id: { in: stockIds }, branchId },
  });
  if (stockItems.length !== stockIds.length) {
    throw new InventoryError("NOT_FOUND", "One or more stock items not found");
  }

  const totalCost = dto.lines.reduce((s, l) => s + l.orderedQty * l.unitCost, 0);
  const poNumber  = await generatePoNumber(branchId);

  const po = await (prisma as any).purchaseOrder?.create({
    data: {
      branchId,
      supplierId:    dto.supplierId,
      poNumber,
      status:        "DRAFT",
      expectedDate:  dto.expectedDate ? new Date(dto.expectedDate) : null,
      totalCost,
      note:          dto.note ?? null,
      createdById,
      lines: {
        create: dto.lines.map((l) => ({
          stockItemId:  l.stockItemId,
          orderedQty:   l.orderedQty,
          receivedQty:  0,
          unitCost:     l.unitCost,
          totalCost:    l.orderedQty * l.unitCost,
        })),
      },
    },
    include: {
      supplier: { select: { id: true, name: true } },
      lines:    { include: { stockItem: { select: { name: true, unit: true } } } },
    },
  });

  return po;
}

// ── Send PO to supplier ───────────────────────────────────────

export async function sendPurchaseOrder(branchId: string, poId: string) {
  const po = await getPurchaseOrderById(branchId, poId);

  if (po.status !== "DRAFT") {
    throw new InventoryError("INVALID_STATUS", `PO is already ${po.status}`, 409);
  }

  return (prisma as any).purchaseOrder?.update({
    where: { id: poId },
    data:  { status: "SENT", sentAt: new Date() },
  });
}

// ── Receive stock against a PO ────────────────────────────────

export async function receivePurchaseOrder(
  branchId: string,
  poId: string,
  receivedById: string,
  dto: ReceivePurchaseOrderDto
) {
  const po = await getPurchaseOrderById(branchId, poId);

  if (!["SENT", "PARTIAL"].includes(po.status)) {
    throw new InventoryError(
      "INVALID_STATUS",
      `Cannot receive against a PO with status "${po.status}"`,
      409
    );
  }

  await prisma.$transaction(async (tx) => {
    for (const line of dto.lines) {
      const poLine = po.lines.find((l: any) => l.id === line.purchaseLineId);
      if (!poLine) continue;

      const received = line.receivedQty;
      if (received <= 0) continue;

      // Update PO line received qty
      await (tx as any).purchaseOrderLine?.update({
        where: { id: line.purchaseLineId },
        data: {
          receivedQty: poLine.receivedQty + received,
          unitCost:    line.unitCost ?? poLine.unitCost,
        },
      });

      // Create stock PURCHASE movement
      await tx.stockMovement.create({
        data: {
          branchId,
          stockItemId: poLine.stockItemId,
          type:        "PURCHASE",
          quantity:    received,
          note:        `Received against PO ${po.poNumber}`,
          createdById: receivedById,
        },
      });

      // Update stock item qty + cost (weighted average)
      const stockItem = await tx.stockItem.findUnique({ where: { id: poLine.stockItemId } });
      if (stockItem) {
        const prevQty    = Number(stockItem.currentQty);
        const prevCost   = Number(stockItem.cost ?? 0);
        const newCost    = line.unitCost ?? poLine.unitCost;
        const newQty     = prevQty + received;

        // Weighted average cost: ((prevQty × prevCost) + (received × newCost)) / newQty
        const avgCost = newQty > 0
          ? ((prevQty * prevCost) + (received * newCost)) / newQty
          : newCost;

        await tx.stockItem.update({
          where: { id: poLine.stockItemId },
          data: {
            currentQty: newQty,
            cost:       Math.round(avgCost * 10000) / 10000,
          },
        });
      }
    }

    // Determine new PO status
    const updatedLines = await (tx as any).purchaseOrderLine?.findMany({
      where: { purchaseOrderId: poId },
    });

    const allFulfilled = updatedLines?.every(
      (l: any) => l.receivedQty >= l.orderedQty
    );
    const anyReceived  = updatedLines?.some((l: any) => l.receivedQty > 0);

    const newStatus: PurchaseOrderStatus =
      allFulfilled ? "RECEIVED" : anyReceived ? "PARTIAL" : "SENT";

    await (tx as any).purchaseOrder?.update({
      where: { id: poId },
      data:  {
        status:       newStatus,
        note:         dto.note ?? null,
        receivedAt:   newStatus === "RECEIVED" ? new Date() : null,
      },
    });

    await tx.auditLog.create({
      data: {
        userId:     receivedById,
        action:     "PURCHASE_ORDER_RECEIVED",
        entityType: "PurchaseOrder",
        entityId:   poId,
        newValue:   { lines: dto.lines, status: newStatus },
      },
    });
  });

  return getPurchaseOrderById(branchId, poId);
}

// ── Cancel PO ─────────────────────────────────────────────────

export async function cancelPurchaseOrder(branchId: string, poId: string, reason: string) {
  const po = await getPurchaseOrderById(branchId, poId);

  if (po.status === "RECEIVED") {
    throw new InventoryError("INVALID_STATUS", "Cannot cancel a fully received PO", 409);
  }

  return (prisma as any).purchaseOrder?.update({
    where: { id: poId },
    data:  { status: "CANCELLED", note: reason },
  });
}
