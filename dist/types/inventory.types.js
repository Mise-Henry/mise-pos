// ============================================================
//  MISE — Inventory Types & DTOs
// ============================================================

export type InventoryUnit =
  | "KG" | "GRAM" | "LITER" | "ML" | "PIECE" | "PORTION";

export type StockMovementType =
  | "PURCHASE"    // Stock in from supplier
  | "CONSUMPTION" // Auto-deducted when order closes
  | "WASTE"       // Spoilage / manual waste log
  | "ADJUSTMENT"  // Manual stock count correction
  | "TRANSFER";   // Between branches

export type PurchaseOrderStatus =
  | "DRAFT"
  | "SENT"
  | "PARTIAL"     // Partially received
  | "RECEIVED"
  | "CANCELLED";

// ── Stock Item DTOs ───────────────────────────────────────────

export interface CreateStockItemDto {
  name:       string;
  unit:       InventoryUnit;
  currentQty?: number;
  minQty?:    number;   // Low-stock alert threshold
  cost?:      number;   // Cost per unit (for COGS)
  supplierId?: string;
  note?:      string;
}

export interface UpdateStockItemDto extends Partial<CreateStockItemDto> {
  isActive?: boolean;
}

// ── Stock Recipe DTOs ─────────────────────────────────────────

export interface SetRecipeDto {
  ingredients: Array<{
    stockItemId: string;
    quantity:    number;   // per 1 unit of product sold
  }>;
}

// ── Stock Movement DTOs ───────────────────────────────────────

export interface CreateMovementDto {
  stockItemId: string;
  type:        StockMovementType;
  quantity:    number;   // positive = in, negative = out
  note?:       string;
  unitCost?:   number;   // used for PURCHASE movements
}

export interface BulkAdjustmentDto {
  adjustments: Array<{
    stockItemId:   string;
    actualQty:     number;   // What the physical count shows
    note?:         string;
  }>;
}

export interface WasteLogDto {
  stockItemId: string;
  quantity:    number;
  reason:      string;
}

// ── Supplier DTOs ─────────────────────────────────────────────

export interface CreateSupplierDto {
  name:        string;
  contactName?: string;
  phone?:      string;
  email?:      string;
  address?:    string;
  taxId?:      string;
  note?:       string;
}

export interface UpdateSupplierDto extends Partial<CreateSupplierDto> {
  isActive?: boolean;
}

// ── Purchase Order DTOs ───────────────────────────────────────

export interface CreatePurchaseOrderDto {
  supplierId:    string;
  expectedDate?: string;   // ISO date
  note?:         string;
  lines: Array<{
    stockItemId:   string;
    orderedQty:    number;
    unitCost:      number;
  }>;
}

export interface ReceivePurchaseOrderDto {
  lines: Array<{
    purchaseLineId: string;
    receivedQty:    number;   // May differ from ordered qty
    unitCost?:      number;   // Override if invoice price differs
  }>;
  note?: string;
}

// ── Query params ──────────────────────────────────────────────

export interface StockQueryParams {
  search?:      string;
  lowStock?:    boolean;   // only items below minQty
  supplierId?:  string;
  isActive?:    boolean;
  page?:        number;
  limit?:       number;
}

export interface MovementQueryParams {
  stockItemId?: string;
  type?:        StockMovementType;
  dateFrom?:    string;
  dateTo?:      string;
  page?:        number;
  limit?:       number;
}

// ── Response types ────────────────────────────────────────────

export interface StockLevelReport {
  summary: {
    totalItems:    number;
    lowStockCount: number;
    outOfStock:    number;
    totalValue:    number;   // current qty × cost
  };
  items: Array<{
    id:         string;
    name:       string;
    unit:       InventoryUnit;
    currentQty: number;
    minQty:     number;
    status:     "OK" | "LOW" | "OUT";
    value:      number;
    supplier:   string | null;
  }>;
}

export interface ConsumptionReport {
  period:  { from: string; to: string };
  items: Array<{
    stockItemId:  string;
    name:         string;
    unit:         InventoryUnit;
    consumed:     number;
    wasted:       number;
    purchased:    number;
    netMovement:  number;
    costOfUsage:  number;
  }>;
}
