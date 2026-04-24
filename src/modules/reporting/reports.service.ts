// ============================================================
//  MISE — Reports Service
//  Sales, product performance, staff, table, cost reports
// ============================================================

import { PrismaClient } from "@prisma/client";
import {
  resolveDateRange, suggestGroupBy,
  generateTimeBuckets, dateToBucket,
  round2,
} from "../../utils/date.utils";
import type {
  DateRangeParams,
  SalesReport,
  ProductReport,
  StaffReport,
  TableReport,
  CostReport,
} from "../../types/reporting.types";

const prisma = new PrismaClient();

// ── Sales Report ──────────────────────────────────────────────

export async function getSalesReport(
  branchId: string,
  params: DateRangeParams = {}
): Promise<SalesReport> {
  const range   = resolveDateRange(params.period ?? "month", params.dateFrom, params.dateTo);
  const groupBy = params.groupBy ?? suggestGroupBy(range.from, range.to);

  const orders = await prisma.order.findMany({
    where: {
      branchId,
      status:   "CLOSED",
      closedAt: { gte: range.from, lte: range.to },
    },
    include: {
      payments:  { where: { status: "COMPLETED" } },
      items:     { where: { status: { notIn: ["CANCELLED", "VOID"] } } },
      discounts: true,
    },
  });

  const refunds = await prisma.payment.findMany({
    where: {
      order:     { branchId },
      status:    "REFUNDED",
      createdAt: { gte: range.from, lte: range.to },
    },
  });

  // ── Aggregate totals ──────────────────────────────────────────

  let grossSales    = 0;
  let discountTotal = 0;
  let taxTotal      = 0;
  let itemsSold     = 0;

  const byPaymentMethod: Record<string, number> = {};
  const byOrderType: Record<string, { count: number; revenue: number }> = {};

  for (const o of orders) {
    grossSales    += Number(o.subtotal) + Number(o.taxAmount);
    discountTotal += Number(o.discountAmount);
    taxTotal      += Number(o.taxAmount);
    itemsSold     += o.items.reduce((s, i) => s + i.quantity, 0);

    for (const p of o.payments) {
      byPaymentMethod[p.method] = round2(
        (byPaymentMethod[p.method] ?? 0) + Number(p.amount)
      );
    }

    if (!byOrderType[o.type]) byOrderType[o.type] = { count: 0, revenue: 0 };
    byOrderType[o.type].count  += 1;
    byOrderType[o.type].revenue = round2(byOrderType[o.type].revenue + Number(o.total));
  }

  const refundTotal    = refunds.reduce((s, p) => s + Math.abs(Number(p.amount)), 0);
  const netSales       = round2(grossSales - discountTotal - refundTotal);
  const orderCount     = orders.length;
  const avgOrderValue  = orderCount > 0 ? round2(netSales / orderCount) : 0;

  // ── Timeline ──────────────────────────────────────────────────

  const buckets    = generateTimeBuckets(range.from, range.to, groupBy);
  const bucketData: Record<string, { revenue: number; orders: number }> = {};
  for (const b of buckets) bucketData[b] = { revenue: 0, orders: 0 };

  for (const o of orders) {
    const key = dateToBucket(o.closedAt!, groupBy);
    if (bucketData[key]) {
      bucketData[key].revenue = round2(bucketData[key].revenue + Number(o.total));
      bucketData[key].orders += 1;
    }
  }

  const timeline = buckets.map((b) => ({
    period:   b,
    revenue:  bucketData[b]?.revenue ?? 0,
    orders:   bucketData[b]?.orders  ?? 0,
    avgValue: bucketData[b]?.orders
      ? round2((bucketData[b]?.revenue ?? 0) / bucketData[b]!.orders)
      : 0,
  }));

  // ── Hourly pattern (0–23) ─────────────────────────────────────

  const hourlyRaw: Record<number, { revenue: number; orders: number }> = {};
  for (let h = 0; h < 24; h++) hourlyRaw[h] = { revenue: 0, orders: 0 };

  for (const o of orders) {
    const h = new Date(o.closedAt!).getHours();
    hourlyRaw[h].revenue = round2(hourlyRaw[h].revenue + Number(o.total));
    hourlyRaw[h].orders += 1;
  }

  const hourlyPattern = Object.entries(hourlyRaw).map(([h, d]) => ({
    hour:    Number(h),
    label:   `${h.padStart(2, "0")}:00`,
    revenue: d.revenue,
    orders:  d.orders,
  }));

  // ── Day-of-week pattern ───────────────────────────────────────

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dailyRaw: Record<string, { revenue: number; orders: number }> = {};
  for (const d of dayNames) dailyRaw[d] = { revenue: 0, orders: 0 };

  for (const o of orders) {
    const d = dayNames[new Date(o.closedAt!).getDay()];
    dailyRaw[d].revenue = round2(dailyRaw[d].revenue + Number(o.total));
    dailyRaw[d].orders += 1;
  }

  const dailyPattern = dayNames.map((d) => ({
    day:     d,
    revenue: dailyRaw[d].revenue,
    orders:  dailyRaw[d].orders,
  }));

  return {
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    totals: {
      grossSales:    round2(grossSales),
      discounts:     round2(discountTotal),
      tax:           round2(taxTotal),
      netSales,
      refunds:       round2(refundTotal),
      orderCount,
      avgOrderValue,
      itemsSold,
    },
    byPaymentMethod,
    byOrderType,
    timeline,
    hourlyPattern,
    dailyPattern,
  };
}

// ── Product Report ────────────────────────────────────────────

export async function getProductReport(
  branchId: string,
  params: DateRangeParams = {}
): Promise<ProductReport> {
  const range = resolveDateRange(params.period ?? "month", params.dateFrom, params.dateTo);

  // All sold items in range (from closed orders)
  const soldItems = await prisma.orderItem.findMany({
    where: {
      status: { notIn: ["CANCELLED", "VOID"] },
      order: {
        branchId,
        status:   "CLOSED",
        closedAt: { gte: range.from, lte: range.to },
      },
    },
    include: {
      product:  { include: { category: true } },
      modifiers: true,
    },
  });

  // Voided / cancelled items (for return rate)
  const voidedItems = await prisma.orderItem.findMany({
    where: {
      status: { in: ["CANCELLED", "VOID"] },
      order:  { branchId, closedAt: { gte: range.from, lte: range.to } },
    },
    select: { productId: true },
  });
  const voidCountMap: Record<string, number> = {};
  for (const v of voidedItems) {
    voidCountMap[v.productId] = (voidCountMap[v.productId] ?? 0) + 1;
  }

  // Aggregate by product
  const prodMap: Record<string, {
    id: string; name: string; category: string;
    qtySold: number; revenue: number; costTotal: number;
    prices: number[];
  }> = {};

  for (const item of soldItems) {
    const pid = item.productId;
    if (!prodMap[pid]) {
      prodMap[pid] = {
        id:        pid,
        name:      item.product.name,
        category:  item.product.category.name,
        qtySold:   0,
        revenue:   0,
        costTotal: 0,
        prices:    [],
      };
    }
    const lineRevenue = Number(item.price) * item.quantity;
    prodMap[pid].qtySold   += item.quantity;
    prodMap[pid].revenue    = round2(prodMap[pid].revenue + lineRevenue);
    prodMap[pid].costTotal  = round2(
      prodMap[pid].costTotal + (Number(item.product.cost ?? 0) * item.quantity)
    );
    prodMap[pid].prices.push(Number(item.price));
  }

  const totalRevenue = Object.values(prodMap).reduce((s, p) => s + p.revenue, 0);

  const products = Object.values(prodMap)
    .sort((a, b) => b.revenue - a.revenue)
    .map((p, i) => ({
      id:          p.id,
      name:        p.name,
      category:    p.category,
      qtySold:     p.qtySold,
      revenue:     p.revenue,
      avgPrice:    round2(p.prices.reduce((s, x) => s + x, 0) / p.prices.length),
      costTotal:   p.costTotal,
      grossMargin: p.costTotal > 0
        ? round2(((p.revenue - p.costTotal) / p.revenue) * 100)
        : 0,
      returnRate: round2(
        ((voidCountMap[p.id] ?? 0) / (p.qtySold + (voidCountMap[p.id] ?? 0))) * 100
      ),
      rank: i + 1,
    }));

  // Categories
  const catMap: Record<string, { revenue: number; qtySold: number }> = {};
  for (const p of products) {
    if (!catMap[p.category]) catMap[p.category] = { revenue: 0, qtySold: 0 };
    catMap[p.category].revenue = round2(catMap[p.category].revenue + p.revenue);
    catMap[p.category].qtySold += p.qtySold;
  }

  const categories = Object.entries(catMap)
    .sort(([, a], [, b]) => b.revenue - a.revenue)
    .map(([name, d]) => ({
      name,
      qtySold:  d.qtySold,
      revenue:  d.revenue,
      share:    totalRevenue > 0 ? round2((d.revenue / totalRevenue) * 100) : 0,
    }));

  // Slow movers — sold fewer than 3 times in the period
  const slowMovers = products
    .filter((p) => p.qtySold < 3)
    .map((p) => ({
      name:     p.name,
      qtySold:  p.qtySold,
      lastSold: null as string | null,
    }));

  // Never sold — active products with 0 sales in period
  const allProducts = await prisma.product.findMany({
    where:   { branchId, isActive: true, isAvailable: true },
    include: { category: true },
  });

  const soldIds  = new Set(Object.keys(prodMap));
  const neverSold = allProducts
    .filter((p) => !soldIds.has(p.id))
    .map((p) => ({ name: p.name, category: p.category.name, price: Number(p.price) }));

  // Modifier revenue
  const modItems = soldItems.flatMap((i) => i.modifiers.filter((m) => Number(m.price) > 0));
  const modMap: Record<string, { timesOrdered: number; revenue: number }> = {};
  for (const m of modItems) {
    if (!modMap[m.name]) modMap[m.name] = { timesOrdered: 0, revenue: 0 };
    modMap[m.name].timesOrdered += 1;
    modMap[m.name].revenue = round2(modMap[m.name].revenue + Number(m.price));
  }
  const modifierRevenue = Object.entries(modMap)
    .sort(([, a], [, b]) => b.revenue - a.revenue)
    .map(([name, d]) => ({ name, ...d }));

  return {
    period:          { from: range.from.toISOString(), to: range.to.toISOString() },
    products,
    categories,
    topSellers:      products.slice(0, 10).map((p) => ({ name: p.name, qtySold: p.qtySold, revenue: p.revenue })),
    slowMovers,
    neverSold,
    modifierRevenue,
  };
}

// ── Staff Report ──────────────────────────────────────────────

export async function getStaffReport(
  branchId: string,
  params: DateRangeParams = {}
): Promise<StaffReport> {
  const range = resolveDateRange(params.period ?? "month", params.dateFrom, params.dateTo);

  // Orders created by each staff member
  const orders = await prisma.order.findMany({
    where: {
      branchId,
      status:   "CLOSED",
      closedAt: { gte: range.from, lte: range.to },
    },
    include: {
      createdBy: { select: { id: true, firstName: true, lastName: true, role: true } },
      closedBy:  { select: { id: true } },
      discounts: true,
    },
  });

  // Voids and refunds per user
  const voids = await prisma.auditLog.findMany({
    where: {
      action:    { in: ["ORDER_ITEM_VOIDED", "ORDER_VOIDED"] },
      createdAt: { gte: range.from, lte: range.to },
    },
    select: { userId: true, action: true },
  });

  const refunds = await prisma.auditLog.findMany({
    where: {
      action:    "PAYMENT_REFUNDED",
      createdAt: { gte: range.from, lte: range.to },
    },
    select: { userId: true },
  });

  const staffMap: Record<string, {
    userId: string; name: string; role: string;
    ordersCreated: number; ordersClosed: number; revenue: number;
    discountsApplied: number; discountTotal: number;
  }> = {};

  const voidMap: Record<string, number>   = {};
  const refundMap: Record<string, number> = {};

  for (const v of voids)   voidMap[v.userId]   = (voidMap[v.userId]   ?? 0) + 1;
  for (const r of refunds) refundMap[r.userId] = (refundMap[r.userId] ?? 0) + 1;

  for (const o of orders) {
    const uid  = o.createdById;
    const user = o.createdBy;

    if (!staffMap[uid]) {
      staffMap[uid] = {
        userId:           uid,
        name:             `${user.firstName} ${user.lastName}`,
        role:             user.role,
        ordersCreated:    0,
        ordersClosed:     0,
        revenue:          0,
        discountsApplied: 0,
        discountTotal:    0,
      };
    }

    staffMap[uid].ordersCreated   += 1;
    staffMap[uid].revenue          = round2(staffMap[uid].revenue + Number(o.total));
    staffMap[uid].discountsApplied += o.discounts.length;
    staffMap[uid].discountTotal    = round2(
      staffMap[uid].discountTotal + o.discounts.reduce((s, d) => s + Number(d.amount), 0)
    );

    if (o.closedById && staffMap[o.closedById]) {
      staffMap[o.closedById].ordersClosed += 1;
    }
  }

  const staff = Object.values(staffMap)
    .map((s) => ({
      ...s,
      avgOrderValue:  s.ordersCreated > 0 ? round2(s.revenue / s.ordersCreated) : 0,
      voidsCount:     voidMap[s.userId]   ?? 0,
      refundsCount:   refundMap[s.userId] ?? 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    staff,
  };
}

// ── Table Report ──────────────────────────────────────────────

export async function getTableReport(
  branchId: string,
  params: DateRangeParams = {}
): Promise<TableReport> {
  const range = resolveDateRange(params.period ?? "month", params.dateFrom, params.dateTo);

  const orders = await prisma.order.findMany({
    where: {
      branchId,
      status:   "CLOSED",
      closedAt: { gte: range.from, lte: range.to },
      tableId:  { not: null },
    },
    include: {
      table: {
        include: { section: { select: { name: true } } },
      },
    },
  });

  const days = Math.max(1, Math.ceil(
    (range.to.getTime() - range.from.getTime()) / (1000 * 60 * 60 * 24)
  ));

  const tableMap: Record<string, {
    id: string; name: string; section: string;
    orders: number; revenue: number; durations: number[];
  }> = {};

  for (const o of orders) {
    if (!o.tableId || !o.table) continue;
    if (!tableMap[o.tableId]) {
      tableMap[o.tableId] = {
        id:        o.tableId,
        name:      o.table.name,
        section:   o.table.section?.name ?? "Unassigned",
        orders:    0,
        revenue:   0,
        durations: [],
      };
    }
    tableMap[o.tableId].orders  += 1;
    tableMap[o.tableId].revenue  = round2(tableMap[o.tableId].revenue + Number(o.total));

    if (o.closedAt) {
      const dur = (o.closedAt.getTime() - o.createdAt.getTime()) / 60000;
      if (dur > 0 && dur < 600) tableMap[o.tableId].durations.push(dur); // ignore >10h (likely error)
    }
  }

  const tables = Object.values(tableMap)
    .map((t) => ({
      id:              t.id,
      name:            t.name,
      section:         t.section,
      ordersServed:    t.orders,
      revenue:         t.revenue,
      avgOrderValue:   t.orders > 0 ? round2(t.revenue / t.orders) : 0,
      avgDurationMin:  t.durations.length
        ? round2(t.durations.reduce((s, d) => s + d, 0) / t.durations.length)
        : 0,
      turnsPerDay:     round2(t.orders / days),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // Section breakdown
  const sectionMap: Record<string, { revenue: number; orders: number }> = {};
  const totalRev = tables.reduce((s, t) => s + t.revenue, 0);

  for (const t of tables) {
    if (!sectionMap[t.section]) sectionMap[t.section] = { revenue: 0, orders: 0 };
    sectionMap[t.section].revenue = round2(sectionMap[t.section].revenue + t.revenue);
    sectionMap[t.section].orders += t.ordersServed;
  }

  const sections = Object.entries(sectionMap)
    .sort(([, a], [, b]) => b.revenue - a.revenue)
    .map(([name, d]) => ({
      name,
      revenue: d.revenue,
      orders:  d.orders,
      share:   totalRev > 0 ? round2((d.revenue / totalRev) * 100) : 0,
    }));

  return {
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    tables,
    sections,
  };
}

// ── Cost / Margin Report ──────────────────────────────────────

export async function getCostReport(
  branchId: string,
  params: DateRangeParams = {}
): Promise<CostReport> {
  const range = resolveDateRange(params.period ?? "month", params.dateFrom, params.dateTo);

  const soldItems = await prisma.orderItem.findMany({
    where: {
      status: { notIn: ["CANCELLED", "VOID"] },
      order: {
        branchId,
        status:   "CLOSED",
        closedAt: { gte: range.from, lte: range.to },
      },
    },
    include: {
      product: { include: { category: true } },
    },
  });

  let totalRevenue = 0;
  let totalCost    = 0;

  const itemMap: Record<string, {
    name: string; category: string;
    qtySold: number; revenue: number; cogs: number;
  }> = {};

  for (const item of soldItems) {
    const pid      = item.productId;
    const revenue  = Number(item.price) * item.quantity;
    const cogs     = Number(item.product.cost ?? 0) * item.quantity;

    totalRevenue += revenue;
    totalCost    += cogs;

    if (!itemMap[pid]) {
      itemMap[pid] = {
        name:     item.product.name,
        category: item.product.category.name,
        qtySold:  0,
        revenue:  0,
        cogs:     0,
      };
    }
    itemMap[pid].qtySold += item.quantity;
    itemMap[pid].revenue  = round2(itemMap[pid].revenue + revenue);
    itemMap[pid].cogs     = round2(itemMap[pid].cogs    + cogs);
  }

  const items = Object.values(itemMap)
    .map((i) => ({
      ...i,
      margin: i.revenue > 0 && i.cogs > 0
        ? round2(((i.revenue - i.cogs) / i.revenue) * 100)
        : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    period:       { from: range.from.toISOString(), to: range.to.toISOString() },
    totalCost:    round2(totalCost),
    totalRevenue: round2(totalRevenue),
    grossMargin:  totalRevenue > 0
      ? round2(((totalRevenue - totalCost) / totalRevenue) * 100)
      : 0,
    items,
  };
}
