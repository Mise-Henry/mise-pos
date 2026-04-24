// ============================================================
//  MISE — Order Types & DTOs
// ============================================================

export type OrderStatus =
  | "DRAFT"
  | "SENT"
  | "IN_PROGRESS"
  | "READY"
  | "DELIVERED"
  | "CLOSED"
  | "CANCELLED"
  | "VOID";

export type OrderType   = "DINE_IN" | "TAKEAWAY" | "DELIVERY" | "ONLINE";
export type ItemStatus  = "PENDING" | "SENT" | "IN_PROGRESS" | "READY" | "SERVED" | "CANCELLED" | "VOID";

// ── Order DTOs ────────────────────────────────────────────────

export interface CreateOrderDto {
  tableId?:        string;
  type?:           OrderType;
  guestCount?:     number;
  notes?:          string;
  // Delivery fields
  deliveryName?:   string;
  deliveryPhone?:  string;
  deliveryAddress?: string;
}

export interface UpdateOrderDto {
  guestCount?:      number;
  notes?:           string;
  deliveryName?:    string;
  deliveryPhone?:   string;
  deliveryAddress?: string;
}

// ── Order Item DTOs ───────────────────────────────────────────

export interface AddItemDto {
  productId:    string;
  quantity?:    number;
  notes?:       string;
  courseNumber?: number;   // 1=starter, 2=main, 3=dessert
  modifierIds?: string[];
}

export interface UpdateItemDto {
  quantity?:     number;
  notes?:        string;
  courseNumber?: number;
}

export interface RemoveItemDto {
  reason?: string;
}

// ── Kitchen / KDS DTOs ────────────────────────────────────────

export interface SendToKitchenDto {
  itemIds?: string[];  // omit = send all PENDING items
}

export interface UpdateItemStatusDto {
  status: ItemStatus;
}

// ── Discount ──────────────────────────────────────────────────

export interface ApplyDiscountDto {
  templateId?: string;  // from DiscountTemplate
  name:        string;
  type:        "PERCENTAGE" | "FIXED_AMOUNT";
  value:       number;
}

// ── Split bill ────────────────────────────────────────────────

export interface SplitBillDto {
  splits: Array<{
    label:     string;   // "Guest 1", "Card", etc.
    itemIds?:  string[]; // specific items — if empty = even split portion
    amount?:   number;   // fixed amount — overrides item calc
  }>;
}

// ── Query params ──────────────────────────────────────────────

export interface OrderQueryParams {
  status?:    OrderStatus | OrderStatus[];
  tableId?:   string;
  type?:      OrderType;
  dateFrom?:  string;
  dateTo?:    string;
  search?:    string;   // by order number
  page?:      number;
  limit?:     number;
}

// ── WebSocket events ──────────────────────────────────────────

export type WsEventType =
  | "ORDER_CREATED"
  | "ORDER_UPDATED"
  | "ORDER_SENT_TO_KITCHEN"
  | "ORDER_CLOSED"
  | "ORDER_CANCELLED"
  | "ITEM_STATUS_CHANGED"
  | "TABLE_STATUS_CHANGED"
  | "KDS_ITEM_READY";

export interface WsEvent {
  event:    WsEventType;
  branchId: string;
  payload:  Record<string, any>;
  ts:       string;
}

// ── Order status state machine ────────────────────────────────

export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT:       ["SENT", "CANCELLED"],
  SENT:        ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["READY", "DELIVERED"],
  READY:       ["DELIVERED", "CLOSED"],
  DELIVERED:   ["CLOSED"],
  CLOSED:      ["VOID"],          // manager only
  CANCELLED:   [],
  VOID:        [],
};

// ── Calculated totals helper ──────────────────────────────────

export interface OrderTotals {
  subtotal:       number;
  taxAmount:      number;
  discountAmount: number;
  total:          number;
}
