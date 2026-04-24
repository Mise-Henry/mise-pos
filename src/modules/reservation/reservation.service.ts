// ============================================================
//  MISE — Reservation Service
// ============================================================

import { PrismaClient } from "@prisma/client";
import { TableError } from "../table/table.service";
import type {
  CreateReservationDto,
  UpdateReservationDto,
  ReservationQueryParams,
} from "../../types/table.types";

const prisma = new PrismaClient();

// ── List reservations ─────────────────────────────────────────

export async function getReservations(branchId: string, params: ReservationQueryParams = {}) {
  const { date, tableId, upcoming, page = 1, limit = 50 } = params;

  let dateFilter: any = {};
  if (date) {
    const start = new Date(`${date}T00:00:00`);
    const end   = new Date(`${date}T23:59:59`);
    dateFilter  = { reservedAt: { gte: start, lte: end } };
  } else if (upcoming) {
    dateFilter = { reservedAt: { gte: new Date() } };
  }

  const [items, total] = await prisma.$transaction([
    prisma.reservation.findMany({
      where: {
        table: { branchId },
        isCancelled: false,
        ...(tableId && { tableId }),
        ...dateFilter,
      },
      include: {
        table: { select: { id: true, name: true, capacity: true, section: { select: { name: true } } } },
      },
      orderBy: { reservedAt: "asc" },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.reservation.count({
      where: {
        table: { branchId },
        isCancelled: false,
        ...(tableId && { tableId }),
        ...dateFilter,
      },
    }),
  ]);

  return { items, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
}

// ── Get single reservation ────────────────────────────────────

export async function getReservationById(branchId: string, reservationId: string) {
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, table: { branchId } },
    include: {
      table: { select: { id: true, name: true, capacity: true, section: { select: { name: true } } } },
    },
  });
  if (!reservation) throw new TableError("NOT_FOUND", "Reservation not found", 404);
  return reservation;
}

// ── Create reservation ────────────────────────────────────────

export async function createReservation(branchId: string, dto: CreateReservationDto) {
  // Verify table belongs to branch
  const table = await prisma.table.findFirst({
    where: { id: dto.tableId, branchId, isActive: true },
  });
  if (!table) throw new TableError("NOT_FOUND", "Table not found", 404);

  const reservedAt = new Date(dto.reservedAt);
  if (isNaN(reservedAt.getTime())) {
    throw new TableError("INVALID_DATE", "Invalid reservation date/time");
  }

  if (reservedAt < new Date()) {
    throw new TableError("PAST_DATE", "Reservation cannot be in the past");
  }

  if (dto.guestCount > table.capacity) {
    throw new TableError(
      "OVER_CAPACITY",
      `Table ${table.name} has capacity for ${table.capacity} guests, but ${dto.guestCount} requested`
    );
  }

  // Check for overlapping reservations (±2 hour window)
  const windowStart = new Date(reservedAt.getTime() - 2 * 60 * 60 * 1000);
  const windowEnd   = new Date(reservedAt.getTime() + 2 * 60 * 60 * 1000);

  const conflict = await prisma.reservation.findFirst({
    where: {
      tableId:     dto.tableId,
      isCancelled: false,
      reservedAt:  { gte: windowStart, lte: windowEnd },
    },
  });

  if (conflict) {
    throw new TableError(
      "RESERVATION_CONFLICT",
      `Table ${table.name} already has a reservation at ${conflict.reservedAt.toISOString()} (within 2-hour window)`,
      409
    );
  }

  const reservation = await prisma.reservation.create({
    data: {
      tableId:    dto.tableId,
      guestName:  dto.guestName,
      guestPhone: dto.guestPhone ?? null,
      guestCount: dto.guestCount,
      reservedAt,
      notes:      dto.notes ?? null,
    },
    include: {
      table: { select: { id: true, name: true, capacity: true } },
    },
  });

  // Auto-mark table as RESERVED if it's currently AVAILABLE
  if (table.status === "AVAILABLE") {
    await prisma.table.update({
      where: { id: dto.tableId },
      data:  { status: "RESERVED" },
    });
  }

  return reservation;
}

// ── Update reservation ────────────────────────────────────────

export async function updateReservation(
  branchId: string,
  reservationId: string,
  dto: UpdateReservationDto
) {
  const existing = await getReservationById(branchId, reservationId);

  if (existing.isCancelled) {
    throw new TableError("ALREADY_CANCELLED", "Cannot update a cancelled reservation");
  }

  if (dto.reservedAt) {
    const newDate = new Date(dto.reservedAt);
    if (isNaN(newDate.getTime())) throw new TableError("INVALID_DATE", "Invalid date/time");
    if (newDate < new Date())      throw new TableError("PAST_DATE",    "Reservation cannot be in the past");
  }

  const updated = await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      ...(dto.guestName   !== undefined && { guestName:   dto.guestName }),
      ...(dto.guestPhone  !== undefined && { guestPhone:  dto.guestPhone }),
      ...(dto.guestCount  !== undefined && { guestCount:  dto.guestCount }),
      ...(dto.reservedAt  !== undefined && { reservedAt:  new Date(dto.reservedAt) }),
      ...(dto.notes       !== undefined && { notes:       dto.notes }),
      ...(dto.isConfirmed !== undefined && { isConfirmed: dto.isConfirmed }),
      ...(dto.isCancelled !== undefined && { isCancelled: dto.isCancelled }),
    },
    include: {
      table: { select: { id: true, name: true, capacity: true } },
    },
  });

  // If cancelled, check if table should revert to AVAILABLE
  if (dto.isCancelled) {
    await maybeRevertTableStatus(existing.tableId, branchId);
  }

  return updated;
}

// ── Cancel reservation ────────────────────────────────────────

export async function cancelReservation(branchId: string, reservationId: string) {
  const reservation = await getReservationById(branchId, reservationId);

  if (reservation.isCancelled) {
    throw new TableError("ALREADY_CANCELLED", "Reservation already cancelled");
  }

  await prisma.reservation.update({
    where: { id: reservationId },
    data:  { isCancelled: true },
  });

  // Revert table to AVAILABLE if no other upcoming reservations
  await maybeRevertTableStatus(reservation.tableId, branchId);

  return { message: `Reservation for ${reservation.guestName} cancelled` };
}

// ── Confirm reservation ───────────────────────────────────────

export async function confirmReservation(branchId: string, reservationId: string) {
  const reservation = await getReservationById(branchId, reservationId);

  if (reservation.isCancelled) {
    throw new TableError("ALREADY_CANCELLED", "Cannot confirm a cancelled reservation");
  }

  return prisma.reservation.update({
    where: { id: reservationId },
    data:  { isConfirmed: true },
  });
}

// ── Upcoming reservations (for host stand widget) ─────────────

export async function getUpcomingReservations(branchId: string, hours = 4) {
  const now  = new Date();
  const until = new Date(now.getTime() + hours * 60 * 60 * 1000);

  return prisma.reservation.findMany({
    where: {
      table:       { branchId },
      isCancelled: false,
      reservedAt:  { gte: now, lte: until },
    },
    include: {
      table: { select: { id: true, name: true, section: { select: { name: true } } } },
    },
    orderBy: { reservedAt: "asc" },
  });
}

// ── Helper: revert table status if no more reservations ───────

async function maybeRevertTableStatus(tableId: string, branchId: string) {
  const table = await prisma.table.findFirst({ where: { id: tableId } });
  if (!table || table.status !== "RESERVED") return;

  const futureReservations = await prisma.reservation.count({
    where: {
      tableId,
      isCancelled: false,
      reservedAt:  { gte: new Date() },
    },
  });

  if (futureReservations === 0) {
    await prisma.table.update({
      where: { id: tableId },
      data:  { status: "AVAILABLE" },
    });
  }
}
