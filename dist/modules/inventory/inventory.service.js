// ============================================================
//  MISE — Stock Item Service
//  Manages ingredients, stock levels, movements, alerts
// ============================================================

import { PrismaClient, Prisma } from "@prisma/client";
import type {
  CreateStockItemDto,
  UpdateStockItemDto,
  CreateMovementDto,
  BulkAdjustmentDto,
  WasteLogDto,
  StockQueryParams,
  MovementQueryParams,
  StockLevelReport,
  ConsumptionReport,
} from "../../types/inventory.types";

const prisma = new PrismaClient();

export class InventoryError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "InventoryError";
  }
}

// ── Stock Items CRUD ──────────────────────────────────────────

export async function getStockItems(branchId: string, params: StockQueryParams = {}) {
  const { search, lowStock, supplierId, isActive = true, page = 1, limit = 50 } = params;

  const where: Prisma.StockItemWhereInput = {
    branchId,
    isActive,
    ...(supplierId && { supplierId }),
    ...(search && {
      name: { contains: search, mode: "insensitive" },
    }),
  };

  const [items, total] = await prisma.$transaction([
    prisma.stockItem.findMany({
      where,
      orderBy: { name: "asc" },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.stockItem.count({ where }),
  ]);

  // Filter low stock after fetch (Prisma can't compare two columns directly)
  const filtered = lowStock
    ? items.filter((i) => Number(i.currentQty) <= Number(i.minQty))
    : items;

  return {
    items: filtered.map(formatStockItem),
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  };
}

export async function getStockItemById(branchId: string, itemId: string) {
  const item = await prisma.stockItem.findFirst({
    where:   { id: itemId, branchId },
    include: {
      movements: { orderBy: { createdAt: "desc" }, take: 20 },
      recipes:   {
        include: { product: { select: { id: true, name: true, isAvailable: true } } },
      },
    },
  });
  if (!item) throw new InventoryError("NOT_FOUND", "Stock item not found", 404);
  return item;
}

export async function createStockItem(branchId: string, dto: CreateStockItemDto) {
  const existing = await prisma.stockItem.findFirst({
    where: { branchId, name: { equals: dto.name, mode: "insensitive" }, isActive: true },
  });
  if (existing) throw new InventoryError("DUPLICATE", `Stock item "${dto.name}" already exists`);

  return prisma.stockItem.create({
    data: {
      branchId,
      name:       dto.name,
      unit:       dto.unit,
      currentQty: dto.currentQty ?? 0,
      minQty:     dto.minQty    ?? 0,
      cost:       dto.cost      ?? null,
    },
  });
}

export async function updateStockItem(branchId: string, itemId: string, dto: UpdateStockItemDto) {
  await assertStockItem(branchId, itemId);

  return prisma.stockItem.update({
    where: { id: itemId },
    data: {
      ...(dto.name       !== undefined && { name:       dto.name }),
      ...(dto.unit       !== undefined && { unit:       dto.unit }),
      ...(dto.minQty     !== undefined && { minQty:     dto.minQty }),
      ...(dto.cost       !== undefined && { cost:       dto.cost }),
      ...(dto.isActive   !== undefined && { isActive:   dto.isActive }),
    },
  });
}

export async function deleteStockItem(branchId: string, itemId: string) {
  await assertStockItem(branchId, itemId);

  const recipeCount = await prisma.stockRecipe.count({ where: { stockItemId: itemId } });
  if (recipeCount > 0) {
    throw new InventoryError(
      "ITEM_IN_RECIPE",
      `Stock item is used in ${recipeCount} product recipe(s). Remove from recipes first.`,
      409
    );
  }

  return prisma.stockItem.update({
    where: { id: itemId },
    data:  { isActive: false },
  });
}

// ── Stock Level Report ────────────────────────────────────────

export async function getStockLevels(branchId: string): Promise<StockLevelReport> {
  const items = await prisma.stockItem.findMany({
    where:   { branchId, isActive: true },
    orderBy: { name: "asc" },
  });

  let totalValue   = 0;
  let lowStock     = 0;
  let outOfStock   = 0;

  const mapped = items.map((item) => {
    const qty    = Number(item.currentQty);
    const min    = Number(item.minQty);
    const cost   = Number(item.cost ?? 0);
    const value  = round2(qty * cost);
    totalValue  += value;

    let status: "OK" | "LOW" | "OUT" = "OK";
    if (qty <= 0)        { status = "OUT"; outOfStock++; }
    else if (qty <= min) { status = "LOW"; lowStock++;   }

    return {
      id:         item.id,
      name:       item.name,
      unit:       item.unit as any,
      currentQty: round2(qty),
      minQty:     round2(min),
      status,
      value,
      supplier:   null as string | null,
    };
  });

  return {
    summary: {
      totalItems:    items.length,
      lowStockCount: lowStock,
      outOfStock,
      totalValue:    round2(totalValue),
    },
    items: mapped,
  };
}

// ── Recipe management ─────────────────────────────────────────

export async function getRecipe(branchId: string, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, branchId } });
  if (!product) throw new InventoryError("NOT_FOUND", "Product not found", 404);

  return prisma.stockRecipe.findMany({
    where:   { productId },
    include: { stockItem: true },
  });
}

export async function setRecipe(branchId: string, productId: string, dto: { ingredients: Array<{ stockItemId: string; quantity: number }> }) {
  const product = await prisma.product.findFirst({ where: { id: productId, branchId } });
  if (!product) throw new InventoryError("NOT_FOUND", "Product not found", 404);

  // Validate all stock items belong to this branch
  const stockIds = dto.ingredients.map((i) => i.stockItemId);
  const found    = await prisma.stockItem.count({
    where: { id: { in: stockIds }, branchId, isActive: true },
  });
  if (found !== stockIds.length) {
    throw new InventoryError("NOT_FOUND", "One or more stock items not found");
  }

  // Replace all recipes in one transaction
  await prisma.$transaction([
    prisma.stockRecipe.deleteMany({ where: { productId } }),
    prisma.stockRecipe.createMany({
      data: dto.ingredients.map(({ stockItemId, quantity }) => ({
        productId,
        stockItemId,
        quantity,
      })),
    }),
  ]);

  return getRecipe(branchId, productId);
}

export async function removeRecipe(branchId: string, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, branchId } });
  if (!product) throw new InventoryError("NOT_FOUND", "Product not found", 404);

  await prisma.stockRecipe.deleteMany({ where: { productId } });
  return { message: "Recipe removed" };
}

// ── Stock movements ───────────────────────────────────────────

export async function getMovements(branchId: string, params: MovementQueryParams = {}) {
  const { stockItemId, type, dateFrom, dateTo, page = 1, limit = 50 } = params;

  const where: Prisma.StockMovementWhereInput = {
    branchId,
    ...(stockItemId && { stockItemId }),
    ...(type        && { type }),
    ...((dateFrom || dateTo) && {
      createdAt: {
        ...(dateFrom && { gte: new Date(dateFrom) }),
        ...(dateTo   && { lte: new Date(dateTo)   }),
      },
    }),
  };

  const [items, total] = await prisma.$transaction([
    prisma.stockMovement.findMany({
      where,
      include: { stockItem: { select: { id: true, name: true, unit: true } } },
      orderBy: { createdAt: "desc" },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.stockMovement.count({ where }),
  ]);

  return { items, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
}

export async function createMovement(
  branchId: string,
  createdById: string,
  dto: CreateMovementDto
) {
  const item = await assertStockItem(branchId, dto.stockItemId);

  const newQty = round2(Number(item.currentQty) + dto.quantity);

  if (newQty < 0 && dto.type !== "ADJUSTMENT") {
    throw new InventoryError(
      "INSUFFICIENT_STOCK",
      `Cannot remove ${Math.abs(dto.quantity)} ${item.unit} from "${item.name}" — only ${Number(item.currentQty)} available`
    );
  }

  await prisma.$transaction([
    prisma.stockMovement.create({
      data: {
        branchId,
        stockItemId: dto.stockItemId,
        type:        dto.type,
        quantity:    dto.quantity,
        note:        dto.note ?? null,
        createdById,
      },
    }),
    prisma.stockItem.update({
      where: { id: dto.stockItemId },
      data:  { currentQty: Math.max(0, newQty), ...(dto.unitCost && { cost: dto.unitCost }) },
    }),
  ]);

  const updated = await prisma.stockItem.findUnique({ where: { id: dto.stockItemId } });
  return { ...formatStockItem(updated!), previousQty: Number(item.currentQty) };
}

// ── Waste log ─────────────────────────────────────────────────

export async function logWaste(branchId: string, loggedById: string, dto: WasteLogDto) {
  return createMovement(branchId, loggedById, {
    stockItemId: dto.stockItemId,
    type:        "WASTE",
    quantity:    -Math.abs(dto.quantity),  // always negative
    note:        dto.reason,
  });
}

// ── Bulk stock count (physical inventory) ─────────────────────

export async function bulkAdjust(
  branchId: string,
  adjustedById: string,
  dto: BulkAdjustmentDto
) {
  const results: Array<{ stockItemId: string; name: string; previousQty: number; newQty: number; adjustment: number }> = [];

  await prisma.$transaction(async (tx) => {
    for (const adj of dto.adjustments) {
      const item = await tx.stockItem.findFirst({
        where: { id: adj.stockItemId, branchId },
      });
      if (!item) continue;

      const prev       = Number(item.currentQty);
      const actual     = adj.actualQty;
      const adjustment = round2(actual - prev);

      if (adjustment === 0) continue;

      await tx.stockMovement.create({
        data: {
          branchId,
          stockItemId: adj.stockItemId,
          type:        "ADJUSTMENT",
          quantity:    adjustment,
          note:        adj.note ?? `Physical count: ${actual} ${item.unit} (was ${prev})`,
          createdById: adjustedById,
        },
      });

      await tx.stockItem.update({
        where: { id: adj.stockItemId },
        data:  { currentQty: actual },
      });

      results.push({
        stockItemId: adj.stockItemId,
        name:        item.name,
        previousQty: prev,
        newQty:      actual,
        adjustment,
      });
    }
  });

  return { adjusted: results.length, results };
}

// ── Auto-deduct when order closes ─────────────────────────────
// Called by the order service after CLOSED status is set.
// Silently skips items with no recipe — doesn't break the flow.

export async function deductForOrder(branchId: string, orderId: string) {
  const items = await prisma.orderItem.findMany({
    where:   { orderId, status: { notIn: ["CANCELLED", "VOID"] } },
    include: {
      product: {
        include: { stockRecipe: { include: { stockItem: true } } },
      },
    },
  });

  if (!items.length) return { deducted: 0, skipped: 0 };

  const deductions: Record<string, number> = {}; // stockItemId → totalQty to deduct

  for (const orderItem of items) {
    for (const recipe of orderItem.product.stockRecipe) {
      const qty = round2(Number(recipe.quantity) * orderItem.quantity);
      deductions[recipe.stockItemId] = round2(
        (deductions[recipe.stockItemId] ?? 0) + qty
      );
    }
  }

  let deducted = 0;
  let skipped  = 0;

  await prisma.$transaction(async (tx) => {
    for (const [stockItemId, qty] of Object.entries(deductions)) {
      const stock = await tx.stockItem.findUnique({ where: { id: stockItemId } });
      if (!stock || !stock.isActive) { skipped++; continue; }

      const newQty = Math.max(0, Number(stock.currentQty) - qty);

      await tx.stockMovement.create({
        data: {
          branchId,
          stockItemId,
          type:        "CONSUMPTION",
          quantity:    -qty,
          note:        `Auto-deduct: order ${orderId}`,
          orderId,
          createdById: "system",
        },
      });

      await tx.stockItem.update({
        where: { id: stockItemId },
        data:  { currentQty: newQty },
      });

      deducted++;

      // Check low-stock threshold and emit alert
      if (newQty <= Number(stock.minQty) && Number(stock.minQty) > 0) {
        await tx.auditLog.create({
          data: {
            userId:     "system",
            action:     "LOW_STOCK_ALERT",
            entityType: "StockItem",
            entityId:   stockItemId,
            newValue:   {
              name:       stock.name,
              currentQty: newQty,
              minQty:     Number(stock.minQty),
              unit:       stock.unit,
              branchId,
            },
          },
        });
      }
    }
  });

  return { deducted, skipped, stockItemCount: Object.keys(deductions).length };
}

// ── Consumption report ────────────────────────────────────────

export async function getConsumptionReport(
  branchId: string,
  dateFrom: string,
  dateTo: string
): Promise<ConsumptionReport> {
  const from = new Date(dateFrom);
  const to   = new Date(dateTo);

  const movements = await prisma.stockMovement.findMany({
    where: {
      branchId,
      createdAt: { gte: from, lte: to },
    },
    include: { stockItem: { select: { id: true, name: true, unit: true, cost: true } } },
  });

  const itemMap: Record<string, {
    stockItemId: string; name: string; unit: string;
    consumed: number; wasted: number; purchased: number; cost: number;
  }> = {};

  for (const m of movements) {
    const sid = m.stockItemId;
    if (!itemMap[sid]) {
      itemMap[sid] = {
        stockItemId: sid,
        name:        m.stockItem.name,
        unit:        m.stockItem.unit,
        consumed:    0,
        wasted:      0,
        purchased:   0,
        cost:        Number(m.stockItem.cost ?? 0),
      };
    }

    const qty = Number(m.quantity);
    if (m.type === "CONSUMPTION")          itemMap[sid].consumed  += Math.abs(qty);
    else if (m.type === "WASTE")           itemMap[sid].wasted    += Math.abs(qty);
    else if (m.type === "PURCHASE")        itemMap[sid].purchased += qty;
  }

  const items = Object.values(itemMap).map((i) => ({
    stockItemId:  i.stockItemId,
    name:         i.name,
    unit:         i.unit as any,
    consumed:     round2(i.consumed),
    wasted:       round2(i.wasted),
    purchased:    round2(i.purchased),
    netMovement:  round2(i.purchased - i.consumed - i.wasted),
    costOfUsage:  round2((i.consumed + i.wasted) * i.cost),
  })).sort((a, b) => b.costOfUsage - a.costOfUsage);

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    items,
  };
}

// ── Low stock alerts ──────────────────────────────────────────

export async function getLowStockAlerts(branchId: string) {
  const items = await prisma.stockItem.findMany({
    where: { branchId, isActive: true },
  });

  return items
    .filter((i) => Number(i.currentQty) <= Number(i.minQty))
    .map((i) => ({
      id:         i.id,
      name:       i.name,
      unit:       i.unit,
      currentQty: round2(Number(i.currentQty)),
      minQty:     round2(Number(i.minQty)),
      deficit:    round2(Number(i.minQty) - Number(i.currentQty)),
      isOut:      Number(i.currentQty) <= 0,
    }))
    .sort((a, b) => b.deficit - a.deficit);
}

// ── Helpers ───────────────────────────────────────────────────

async function assertStockItem(branchId: string, itemId: string) {
  const item = await prisma.stockItem.findFirst({ where: { id: itemId, branchId } });
  if (!item) throw new InventoryError("NOT_FOUND", "Stock item not found", 404);
  return item;
}

function formatStockItem(item: any) {
  return {
    ...item,
    currentQty: round2(Number(item.currentQty)),
    minQty:     round2(Number(item.minQty)),
    cost:       item.cost ? round2(Number(item.cost)) : null,
    isLow:      Number(item.currentQty) <= Number(item.minQty) && Number(item.minQty) > 0,
    isOut:      Number(item.currentQty) <= 0,
  };
}

function round2(n: number) { return Math.round(n * 1000) / 1000; }
