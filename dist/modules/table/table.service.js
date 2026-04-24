// ============================================================
//  MISE — Table Service
//  Handles: sections, tables, floor plan, status machine,
//           merging, transfers, real-time status
// ============================================================

import { PrismaClient, Prisma } from "@prisma/client";
import type {
  CreateSectionDto,
  UpdateSectionDto,
  CreateTableDto,
  UpdateTableDto,
  MoveTableDto,
  UpdateTableStatusDto,
  MergeTablesDto,
  TransferTableDto,
  FloorPlanResponse,
  TableWithStatus,
  TableStatus,
  STATUS_TRANSITIONS,
} from "../../types/table.types";
import { STATUS_TRANSITIONS as TRANSITIONS } from "../../types/table.types";

const prisma = new PrismaClient();

// ── Custom error ──────────────────────────────────────────────

export class TableError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "TableError";
  }
}

// ── Active order include (used in multiple queries) ────────────

const ACTIVE_ORDER_INCLUDE = {
  orders: {
    where: {
      status: { notIn: ["CLOSED", "CANCELLED", "VOID"] as any[] },
    },
    select: {
      id:          true,
      orderNumber: true,
      guestCount:  true,
      total:       true,
      createdAt:   true,
      _count:      { select: { items: true } },
    },
    take: 1,
    orderBy: { createdAt: "desc" as const },
  },
};

// ── Helpers ───────────────────────────────────────────────────

function formatTableWithStatus(table: any): TableWithStatus {
  const activeOrder = table.orders?.[0] ?? null;
  return {
    id:       table.id,
    name:     table.name,
    capacity: table.capacity,
    shape:    table.shape ?? "rectangle",
    posX:     table.posX,
    posY:     table.posY,
    width:    table.width,
    height:   table.height,
    status:   table.status,
    section:  table.section ?? null,
    activeOrder: activeOrder
      ? {
          id:          activeOrder.id,
          orderNumber: activeOrder.orderNumber,
          guestCount:  activeOrder.guestCount,
          total:       Number(activeOrder.total),
          itemCount:   activeOrder._count.items,
          openedAt:    activeOrder.createdAt.toISOString(),
        }
      : null,
  };
}

async function assertTable(branchId: string, tableId: string) {
  const table = await prisma.table.findFirst({ where: { id: tableId, branchId } });
  if (!table) throw new TableError("NOT_FOUND", "Table not found", 404);
  return table;
}

// ── Floor plan ────────────────────────────────────────────────

export async function getFloorPlan(branchId: string): Promise<FloorPlanResponse> {
  const sections = await prisma.tableSection.findMany({
    where:   { branchId, isActive: true },
    orderBy: { sortOrder: "asc" },
    include: {
      tables: {
        where:   { isActive: true },
        orderBy: { name: "asc" },
        include: {
          ...ACTIVE_ORDER_INCLUDE,
          section: { select: { id: true, name: true } },
        },
      },
    },
  });

  // Also get tables with no section
  const unassignedTables = await prisma.table.findMany({
    where:   { branchId, isActive: true, sectionId: null },
    orderBy: { name: "asc" },
    include: {
      ...ACTIVE_ORDER_INCLUDE,
      section: { select: { id: true, name: true } },
    },
  });

  const allTables = [
    ...sections.flatMap((s) => s.tables),
    ...unassignedTables,
  ];

  // Summary counts
  const summary = {
    total:     allTables.length,
    available: allTables.filter((t) => t.status === "AVAILABLE").length,
    occupied:  allTables.filter((t) => t.status === "OCCUPIED").length,
    reserved:  allTables.filter((t) => t.status === "RESERVED").length,
    cleaning:  allTables.filter((t) => t.status === "CLEANING").length,
    inactive:  allTables.filter((t) => t.status === "INACTIVE").length,
  };

  return {
    sections: [
      ...sections.map((s) => ({
        id:        s.id,
        name:      s.name,
        sortOrder: s.sortOrder,
        tables:    s.tables.map(formatTableWithStatus),
      })),
      ...(unassignedTables.length > 0
        ? [{
            id:        "unassigned",
            name:      "Unassigned",
            sortOrder: 9999,
            tables:    unassignedTables.map(formatTableWithStatus),
          }]
        : []),
    ],
    summary,
  };
}

// ── Tables ────────────────────────────────────────────────────

export async function getTables(branchId: string, sectionId?: string) {
  const tables = await prisma.table.findMany({
    where:   { branchId, isActive: true, ...(sectionId && { sectionId }) },
    orderBy: { name: "asc" },
    include: {
      ...ACTIVE_ORDER_INCLUDE,
      section: { select: { id: true, name: true } },
    },
  });
  return tables.map(formatTableWithStatus);
}

export async function getTableById(branchId: string, tableId: string) {
  const table = await prisma.table.findFirst({
    where:   { id: tableId, branchId },
    include: {
      section: { select: { id: true, name: true } },
      orders: {
        where:   { status: { notIn: ["CLOSED", "CANCELLED", "VOID"] } },
        include: {
          items: {
            include: { product: { select: { id: true, name: true } }, modifiers: true },
          },
          payments: true,
          createdBy: { select: { id: true, firstName: true, lastName: true } },
        },
        take: 1,
      },
      reservations: {
        where: {
          reservedAt:  { gte: new Date() },
          isCancelled: false,
        },
        orderBy: { reservedAt: "asc" },
        take:    3,
      },
    },
  });
  if (!table) throw new TableError("NOT_FOUND", "Table not found", 404);
  return table;
}

export async function createTable(branchId: string, dto: CreateTableDto) {
  if (dto.sectionId) {
    const section = await prisma.tableSection.findFirst({
      where: { id: dto.sectionId, branchId },
    });
    if (!section) throw new TableError("NOT_FOUND", "Section not found", 404);
  }

  // Check name is unique within the branch
  const existing = await prisma.table.findFirst({
    where: { branchId, name: dto.name, isActive: true },
  });
  if (existing) throw new TableError("DUPLICATE_NAME", `Table "${dto.name}" already exists`);

  return prisma.table.create({
    data: {
      branchId,
      sectionId: dto.sectionId ?? null,
      name:      dto.name,
      capacity:  dto.capacity,
      shape:     dto.shape   ?? "rectangle",
      posX:      dto.posX    ?? null,
      posY:      dto.posY    ?? null,
      width:     dto.width   ?? null,
      height:    dto.height  ?? null,
      status:    "AVAILABLE",
    },
    include: { section: { select: { id: true, name: true } } },
  });
}

export async function updateTable(branchId: string, tableId: string, dto: UpdateTableDto) {
  await assertTable(branchId, tableId);

  if (dto.name) {
    const duplicate = await prisma.table.findFirst({
      where: { branchId, name: dto.name, isActive: true, id: { not: tableId } },
    });
    if (duplicate) throw new TableError("DUPLICATE_NAME", `Table "${dto.name}" already exists`);
  }

  return prisma.table.update({
    where: { id: tableId },
    data: {
      ...(dto.sectionId !== undefined && { sectionId: dto.sectionId }),
      ...(dto.name      !== undefined && { name:      dto.name }),
      ...(dto.capacity  !== undefined && { capacity:  dto.capacity }),
      ...(dto.shape     !== undefined && { shape:     dto.shape }),
      ...(dto.posX      !== undefined && { posX:      dto.posX }),
      ...(dto.posY      !== undefined && { posY:      dto.posY }),
      ...(dto.width     !== undefined && { width:     dto.width }),
      ...(dto.height    !== undefined && { height:    dto.height }),
      ...(dto.isActive  !== undefined && { isActive:  dto.isActive }),
    },
    include: { section: { select: { id: true, name: true } } },
  });
}

// Save floor plan positions from drag-drop (batch update)
export async function saveFloorPlan(
  branchId: string,
  positions: Array<{ tableId: string; posX: number; posY: number; width?: number; height?: number }>
) {
  const updates = positions.map(({ tableId, posX, posY, width, height }) =>
    prisma.table.updateMany({
      where: { id: tableId, branchId },
      data:  { posX, posY, ...(width && { width }), ...(height && { height }) },
    })
  );
  await prisma.$transaction(updates);
  return { message: `Updated positions for ${positions.length} tables` };
}

export async function deleteTable(branchId: string, tableId: string) {
  const table = await assertTable(branchId, tableId);

  if (table.status === "OCCUPIED") {
    throw new TableError("TABLE_OCCUPIED", "Cannot delete an occupied table. Close the order first.", 409);
  }

  return prisma.table.update({
    where: { id: tableId },
    data:  { isActive: false, status: "INACTIVE" },
  });
}

// ── Status machine ────────────────────────────────────────────

export async function updateTableStatus(
  branchId: string,
  tableId: string,
  dto: UpdateTableStatusDto
) {
  const table = await assertTable(branchId, tableId);
  const currentStatus = table.status as TableStatus;
  const newStatus     = dto.status;

  // Enforce state machine transitions
  const allowed = TRANSITIONS[currentStatus];
  if (!allowed.includes(newStatus)) {
    throw new TableError(
      "INVALID_TRANSITION",
      `Cannot transition table from ${currentStatus} to ${newStatus}. Allowed: ${allowed.join(", ")}`,
      409
    );
  }

  // Extra guard: can't manually set OCCUPIED — that happens via order creation
  if (newStatus === "OCCUPIED") {
    const hasActiveOrder = await prisma.order.findFirst({
      where: { tableId, status: { notIn: ["CLOSED", "CANCELLED", "VOID"] } },
    });
    if (!hasActiveOrder) {
      throw new TableError(
        "NO_ACTIVE_ORDER",
        "A table is marked occupied automatically when an order is created on it",
        409
      );
    }
  }

  return prisma.table.update({
    where: { id: tableId },
    data:  { status: newStatus },
    include: { section: { select: { id: true, name: true } } },
  });
}

// ── Table merge ───────────────────────────────────────────────
// Marks secondary tables as OCCUPIED and links them to primary order

export async function mergeTables(branchId: string, dto: MergeTablesDto) {
  const { tableIds, primaryTableId } = dto;

  if (!tableIds.includes(primaryTableId)) {
    throw new TableError("INVALID_MERGE", "primaryTableId must be included in tableIds");
  }

  if (tableIds.length < 2) {
    throw new TableError("INVALID_MERGE", "At least 2 tables required to merge");
  }

  // Validate all tables exist and belong to branch
  const tables = await prisma.table.findMany({
    where: { id: { in: tableIds }, branchId, isActive: true },
  });

  if (tables.length !== tableIds.length) {
    throw new TableError("NOT_FOUND", "One or more tables not found");
  }

  // Ensure non-primary tables are available or reserved
  const blocked = tables.filter(
    (t) => t.id !== primaryTableId && !["AVAILABLE", "RESERVED"].includes(t.status)
  );
  if (blocked.length > 0) {
    throw new TableError(
      "TABLE_NOT_AVAILABLE",
      `Tables ${blocked.map((t) => t.name).join(", ")} are not available for merge`
    );
  }

  // Get the primary table's active order
  const primaryOrder = await prisma.order.findFirst({
    where: { tableId: primaryTableId, status: { notIn: ["CLOSED", "CANCELLED", "VOID"] } },
  });

  // Mark all secondary tables as OCCUPIED and update guest counts
  const secondaryIds = tableIds.filter((id) => id !== primaryTableId);
  await prisma.$transaction(
    secondaryIds.map((id) =>
      prisma.table.update({ where: { id }, data: { status: "OCCUPIED" } })
    )
  );

  return {
    primaryTableId,
    mergedTableIds: secondaryIds,
    orderId: primaryOrder?.id ?? null,
    message: `Tables ${tables.map((t) => t.name).join(" + ")} merged`,
  };
}

// ── Table transfer ────────────────────────────────────────────
// Move an active order from one table to another

export async function transferTable(branchId: string, dto: TransferTableDto) {
  const { fromTableId, toTableId } = dto;

  if (fromTableId === toTableId) {
    throw new TableError("INVALID_TRANSFER", "Source and destination tables must be different");
  }

  const [fromTable, toTable] = await Promise.all([
    prisma.table.findFirst({ where: { id: fromTableId, branchId, isActive: true } }),
    prisma.table.findFirst({ where: { id: toTableId,   branchId, isActive: true } }),
  ]);

  if (!fromTable) throw new TableError("NOT_FOUND", "Source table not found",      404);
  if (!toTable)   throw new TableError("NOT_FOUND", "Destination table not found", 404);

  if (fromTable.status !== "OCCUPIED") {
    throw new TableError("NO_ACTIVE_ORDER", "Source table has no active order");
  }

  if (toTable.status !== "AVAILABLE") {
    throw new TableError("TABLE_NOT_AVAILABLE", `Table ${toTable.name} is not available`);
  }

  // Find the active order on the source table
  const order = await prisma.order.findFirst({
    where: { tableId: fromTableId, status: { notIn: ["CLOSED", "CANCELLED", "VOID"] } },
  });
  if (!order) throw new TableError("NO_ACTIVE_ORDER", "No active order on source table");

  // Move order + swap table statuses atomically
  await prisma.$transaction([
    prisma.order.update({ where: { id: order.id }, data: { tableId: toTableId } }),
    prisma.table.update({ where: { id: fromTableId }, data: { status: "CLEANING" } }),
    prisma.table.update({ where: { id: toTableId   }, data: { status: "OCCUPIED" } }),
  ]);

  return {
    orderId:      order.id,
    orderNumber:  order.orderNumber,
    fromTable:    fromTable.name,
    toTable:      toTable.name,
    message:      `Order moved from ${fromTable.name} to ${toTable.name}`,
  };
}

// ── Sections ──────────────────────────────────────────────────

export async function getSections(branchId: string) {
  return prisma.tableSection.findMany({
    where:   { branchId, isActive: true },
    orderBy: { sortOrder: "asc" },
    include: {
      _count: { select: { tables: { where: { isActive: true } } } },
    },
  });
}

export async function createSection(branchId: string, dto: CreateSectionDto) {
  const last = await prisma.tableSection.findFirst({
    where:   { branchId },
    orderBy: { sortOrder: "desc" },
  });

  return prisma.tableSection.create({
    data: {
      branchId,
      name:      dto.name,
      sortOrder: dto.sortOrder ?? (last?.sortOrder ?? -1) + 1,
    },
  });
}

export async function updateSection(branchId: string, sectionId: string, dto: UpdateSectionDto) {
  const section = await prisma.tableSection.findFirst({ where: { id: sectionId, branchId } });
  if (!section) throw new TableError("NOT_FOUND", "Section not found", 404);

  return prisma.tableSection.update({
    where: { id: sectionId },
    data:  {
      ...(dto.name      !== undefined && { name:      dto.name }),
      ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      ...(dto.isActive  !== undefined && { isActive:  dto.isActive }),
    },
  });
}

export async function deleteSection(branchId: string, sectionId: string) {
  const tableCount = await prisma.table.count({
    where: { sectionId, isActive: true },
  });

  if (tableCount > 0) {
    throw new TableError(
      "SECTION_HAS_TABLES",
      `Cannot delete section with ${tableCount} active table(s). Reassign or delete tables first.`,
      409
    );
  }

  return prisma.tableSection.update({
    where: { id: sectionId },
    data:  { isActive: false },
  });
}
