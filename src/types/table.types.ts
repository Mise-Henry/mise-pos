// ============================================================
//  MISE — Table Types & DTOs
// ============================================================

export type TableStatus = "AVAILABLE" | "OCCUPIED" | "RESERVED" | "CLEANING" | "INACTIVE";
export type TableShape  = "rectangle" | "circle" | "square";

// ── Section DTOs ──────────────────────────────────────────────

export interface CreateSectionDto {
  name: string;
  sortOrder?: number;
}

export interface UpdateSectionDto extends Partial<CreateSectionDto> {
  isActive?: boolean;
}

// ── Table DTOs ────────────────────────────────────────────────

export interface CreateTableDto {
  sectionId?: string;
  name: string;
  capacity: number;
  shape?: TableShape;
  posX?: number;   // Floor plan X position (px)
  posY?: number;   // Floor plan Y position (px)
  width?: number;  // Display width
  height?: number; // Display height
}

export interface UpdateTableDto extends Partial<CreateTableDto> {
  isActive?: boolean;
}

export interface MoveTableDto {
  posX: number;
  posY: number;
}

export interface UpdateTableStatusDto {
  status: TableStatus;
  note?: string;
}

export interface MergeTablesDto {
  tableIds: string[];   // All tables to merge (min 2)
  primaryTableId: string; // Which table the order lives on
}

export interface TransferTableDto {
  fromTableId: string;
  toTableId: string;
}

// ── Reservation DTOs ──────────────────────────────────────────

export interface CreateReservationDto {
  tableId: string;
  guestName: string;
  guestPhone?: string;
  guestCount: number;
  reservedAt: string; // ISO datetime
  notes?: string;
}

export interface UpdateReservationDto extends Partial<Omit<CreateReservationDto, "tableId">> {
  isConfirmed?: boolean;
  isCancelled?: boolean;
}

export interface ReservationQueryParams {
  date?: string;       // YYYY-MM-DD — filter by day
  tableId?: string;
  upcoming?: boolean;
  page?: number;
  limit?: number;
}

// ── Response types ────────────────────────────────────────────

export interface TableWithStatus {
  id: string;
  name: string;
  capacity: number;
  shape: TableShape;
  posX: number | null;
  posY: number | null;
  width: number | null;
  height: number | null;
  status: TableStatus;
  section: { id: string; name: string } | null;
  activeOrder: {
    id: string;
    orderNumber: string;
    guestCount: number;
    total: number;
    itemCount: number;
    openedAt: string;
  } | null;
}

export interface FloorPlanResponse {
  sections: Array<{
    id: string;
    name: string;
    sortOrder: number;
    tables: TableWithStatus[];
  }>;
  summary: {
    total: number;
    available: number;
    occupied: number;
    reserved: number;
    cleaning: number;
    inactive: number;
  };
}

// ── Valid status transitions ──────────────────────────────────
// Defines the state machine — not every status can go to every other

export const STATUS_TRANSITIONS: Record<TableStatus, TableStatus[]> = {
  AVAILABLE: ["OCCUPIED", "RESERVED", "INACTIVE"],
  OCCUPIED:  ["AVAILABLE", "CLEANING"],
  RESERVED:  ["OCCUPIED", "AVAILABLE"],
  CLEANING:  ["AVAILABLE", "INACTIVE"],
  INACTIVE:  ["AVAILABLE"],
};
