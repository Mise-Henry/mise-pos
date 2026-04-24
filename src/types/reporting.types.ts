// ============================================================
//  MISE — Reporting Types
// ============================================================

export type ReportPeriod = "today" | "yesterday" | "week" | "month" | "quarter" | "year" | "custom";
export type GroupBy      = "hour" | "day" | "week" | "month";

// ── Query params ──────────────────────────────────────────────

export interface DateRangeParams {
  period?:   ReportPeriod;
  dateFrom?: string;   // YYYY-MM-DD  (required when period=custom)
  dateTo?:   string;   // YYYY-MM-DD
  groupBy?:  GroupBy;
}

// ── Dashboard ─────────────────────────────────────────────────

export interface DashboardSummary {
  period:           { from: string; to: string };
  revenue: {
    total:          number;
    vs_prev:        number;   // % change vs previous period
    tax:            number;
    discounts:      number;
    refunds:        number;
    net:            number;
  };
  orders: {
    total:          number;
    vs_prev:        number;
    avgValue:       number;
    byType:         Record<string, number>;
    byStatus:       Record<string, number>;
  };
  tables: {
    turnoverRate:   number;   // orders per table per day
    avgDuration:    number;   // avg minutes table occupied
    topTables:      Array<{ name: string; revenue: number }>;
  };
  topProducts:      Array<{ name: string; qty: number; revenue: number }>;
  peakHour:         string;
  salesTimeline:    Array<{ period: string; revenue: number; orders: number }>;
}

// ── Sales report ──────────────────────────────────────────────

export interface SalesReport {
  period:           { from: string; to: string };
  totals: {
    grossSales:     number;
    discounts:      number;
    tax:            number;
    netSales:       number;
    refunds:        number;
    orderCount:     number;
    avgOrderValue:  number;
    itemsSold:      number;
  };
  byPaymentMethod:  Record<string, number>;
  byOrderType:      Record<string, { count: number; revenue: number }>;
  timeline:         Array<{ period: string; revenue: number; orders: number; avgValue: number }>;
  hourlyPattern:    Array<{ hour: number; label: string; revenue: number; orders: number }>;
  dailyPattern:     Array<{ day: string; revenue: number; orders: number }>;
}

// ── Product report ────────────────────────────────────────────

export interface ProductReport {
  period:   { from: string; to: string };
  products: Array<{
    id:            string;
    name:          string;
    category:      string;
    qtySold:       number;
    revenue:       number;
    avgPrice:      number;
    costTotal:     number;
    grossMargin:   number;   // %
    returnRate:    number;   // % of sold items that were voided/cancelled
    rank:          number;
  }>;
  categories: Array<{
    name:     string;
    qtySold:  number;
    revenue:  number;
    share:    number;        // % of total revenue
  }>;
  topSellers:     Array<{ name: string; qtySold: number; revenue: number }>;
  slowMovers:     Array<{ name: string; qtySold: number; lastSold: string | null }>;
  neverSold:      Array<{ name: string; category: string; price: number }>;
  modifierRevenue: Array<{ name: string; timesOrdered: number; revenue: number }>;
}

// ── Staff report ──────────────────────────────────────────────

export interface StaffReport {
  period:   { from: string; to: string };
  staff:    Array<{
    userId:        string;
    name:          string;
    role:          string;
    ordersCreated: number;
    ordersClosed:  number;
    revenue:       number;
    avgOrderValue: number;
    discountsApplied: number;
    discountTotal: number;
    voidsCount:    number;
    refundsCount:  number;
  }>;
}

// ── Table report ──────────────────────────────────────────────

export interface TableReport {
  period: { from: string; to: string };
  tables: Array<{
    id:            string;
    name:          string;
    section:       string;
    ordersServed:  number;
    revenue:       number;
    avgOrderValue: number;
    avgDurationMin: number;
    turnsPerDay:   number;
  }>;
  sections: Array<{
    name:     string;
    revenue:  number;
    orders:   number;
    share:    number;
  }>;
}

// ── Inventory cost report ─────────────────────────────────────

export interface CostReport {
  period:      { from: string; to: string };
  totalCost:   number;
  totalRevenue: number;
  grossMargin: number;   // %
  items: Array<{
    name:        string;
    category:    string;
    qtySold:     number;
    revenue:     number;
    cogs:        number;  // cost of goods sold
    margin:      number;  // %
  }>;
}
