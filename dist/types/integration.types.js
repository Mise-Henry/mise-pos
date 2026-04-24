// ============================================================
//  MISE — Integration Types
// ============================================================

// ── Payment Gateway ───────────────────────────────────────────

export type GatewayProvider = "stripe" | "iyzico" | "paytr";

export interface GatewayChargeDto {
  orderId:     string;
  amount:      number;       // in major currency units (TRY, USD)
  currency:    string;       // "TRY" | "USD" | "EUR"
  description: string;
  card?: {
    number:  string;
    expMonth: number;
    expYear:  number;
    cvc:     string;
    holder:  string;
  };
  returnUrl?:  string;       // for 3DS redirect flows
  cancelUrl?:  string;
}

export interface GatewayChargeResult {
  provider:      GatewayProvider;
  transactionId: string;
  status:        "success" | "pending" | "failed";
  amount:        number;
  currency:      string;
  redirectUrl?:  string;     // 3DS redirect URL if required
  raw:           Record<string, any>;
}

export interface GatewayRefundDto {
  transactionId: string;
  amount?:       number;     // partial refund
  reason:        string;
}

// ── Delivery Platforms ────────────────────────────────────────

export type DeliveryPlatform = "yemeksepeti" | "getir" | "trendyol";

export interface DeliveryOrder {
  platformOrderId: string;
  platform:        DeliveryPlatform;
  customerName:    string;
  customerPhone:   string;
  deliveryAddress: string;
  items: Array<{
    name:     string;
    quantity: number;
    price:    number;
    notes?:   string;
  }>;
  subtotal:    number;
  deliveryFee: number;
  total:       number;
  estimatedDeliveryMinutes: number;
  rawPayload:  Record<string, any>;
}

// ── Fiscal / Yazarkasa ────────────────────────────────────────

export type FiscalDeviceType = "epson_tm" | "ingenico" | "verifone" | "mock";

export interface FiscalReceiptLine {
  description: string;
  quantity:    number;
  unitPrice:   number;
  taxRate:     number;       // percentage e.g. 8
  total:       number;
}

export interface FiscalReceiptDto {
  orderId:     string;
  receiptNo:   string;
  lines:       FiscalReceiptLine[];
  subtotal:    number;
  taxAmount:   number;
  total:       number;
  paymentMethod: string;
  cashier:     string;
}

export interface FiscalSubmitResult {
  deviceId:    string;
  zNumber:     string;
  receiptNo:   string;
  status:      "approved" | "rejected" | "pending";
  raw:         Record<string, any>;
}

// ── Notifications (SMS + Email) ───────────────────────────────

export interface SmsDto {
  to:      string;           // E.164 format: +905321234567
  message: string;
}

export interface EmailDto {
  to:       string | string[];
  subject:  string;
  html:     string;
  text?:    string;
  from?:    string;
}

export interface ReceiptEmailDto {
  to:        string;
  orderId:   string;
  branchId:  string;
}

// ── Webhooks ──────────────────────────────────────────────────

export type WebhookEvent =
  | "order.created"
  | "order.sent_to_kitchen"
  | "order.closed"
  | "order.cancelled"
  | "payment.completed"
  | "payment.refunded"
  | "inventory.low_stock"
  | "shift.closed";

export interface WebhookEndpoint {
  id:        string;
  branchId:  string;
  url:       string;
  events:    WebhookEvent[];
  secret:    string;         // HMAC-SHA256 signing secret
  isActive:  boolean;
}

export interface WebhookDelivery {
  endpointId:  string;
  event:       WebhookEvent;
  payload:     Record<string, any>;
  status:      "pending" | "delivered" | "failed";
  statusCode?: number;
  attempts:    number;
  nextRetryAt?: Date;
}
