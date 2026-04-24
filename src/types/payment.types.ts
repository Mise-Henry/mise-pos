// ============================================================
//  MISE — Payment Types & DTOs
// ============================================================

export type PaymentMethod =
  | "CASH"
  | "CREDIT_CARD"
  | "DEBIT_CARD"
  | "ONLINE"
  | "VOUCHER"
  | "MIXED";

export type PaymentStatus = "PENDING" | "COMPLETED" | "FAILED" | "REFUNDED" | "PARTIAL";

// ── Payment DTOs ──────────────────────────────────────────────

export interface ProcessPaymentDto {
  method:     PaymentMethod;
  amount:     number;          // Amount being paid (may be partial)
  tendered?:  number;          // Cash given by customer (cash only)
  reference?: string;          // Card terminal transaction ref
  note?:      string;
}

export interface SplitPaymentDto {
  payments: Array<{
    method:    PaymentMethod;
    amount:    number;
    tendered?: number;
    reference?: string;
  }>;
}

export interface RefundPaymentDto {
  paymentId: string;
  amount?:   number;  // partial refund — omit for full refund
  reason:    string;
}

// ── Receipt DTOs ──────────────────────────────────────────────

export interface SendReceiptDto {
  email?:  string;
  phone?:  string;  // for SMS receipt
  print?:  boolean; // trigger printer
}

// ── Shift DTOs ────────────────────────────────────────────────

export interface OpenShiftDto {
  openingFloat: number;  // Opening cash in drawer
  note?:        string;
}

export interface CloseShiftDto {
  closingCash: number;   // Actual cash counted at close
  note?:       string;
}

// ── Response types ────────────────────────────────────────────

export interface PaymentResult {
  paymentId:     string;
  method:        PaymentMethod;
  status:        PaymentStatus;
  amount:        number;
  tendered?:     number;
  change?:       number;
  reference?:    string;
  remainingDue:  number;        // 0 = fully paid
  isFullyPaid:   boolean;
}

export interface ReceiptData {
  receiptNo:       string;
  orderNumber:     string;
  branchName:      string;
  branchAddress:   string;
  date:            string;
  cashier:         string;
  tableName:       string | null;
  items: Array<{
    name:      string;
    quantity:  number;
    unitPrice: number;
    modifiers: string[];
    lineTotal: number;
  }>;
  subtotal:        number;
  taxAmount:       number;
  discountAmount:  number;
  total:           number;
  payments: Array<{
    method: PaymentMethod;
    amount: number;
    tendered?: number;
    change?:   number;
  }>;
  footer:          string;
}

export interface ShiftSummary {
  shiftId:         string;
  openedAt:        string;
  closedAt?:       string;
  openedBy:        string;
  openingFloat:    number;
  closingCash?:    number;
  expectedCash:    number;     // float + cash sales
  cashVariance?:   number;     // actual - expected
  totals: {
    orderCount:      number;
    grossSales:      number;
    discountTotal:   number;
    taxTotal:        number;
    netSales:        number;
    refundTotal:     number;
  };
  byPaymentMethod: Record<PaymentMethod, number>;
  hourlyBreakdown: Array<{ hour: string; sales: number; orders: number }>;
}
