// ============================================================
//  MISE — Dashboard Service
//  The real-time overview card shown on the admin home screen.
// ============================================================

import { PrismaClient } from "@prisma/client";
import {
  resolveDateRange, suggestGroupBy,
  generateTimeBuckets, dateToBucket,
  pctChange, round2,
} from "../../utils/date.utils";
import type { DateRangeParams, DashboardSummary } from "../../types/reporting.types";

const prisma = new PrismaClient();

export async function getDashboard(
  branchId: string,
  params: DateRangeParams = {}
): Promise<DashboardSummary> {
  const range   = resolveDateRange(params.period ?? "today", params.dateFrom, params.dateTo);
  const groupBy = params.groupBy ?? suggestGroupBy(range.from, range.to);

  // ── Fetch closed orders in range and previous period ─────────

  const [orders, prevOrders, refunds] = await Promise.all([
    prisma.order.findMany({
      where: {
        branchId,
        status:   "CLOSED",
        closedAt: { gte: range.from, lte: range.to },
      },
      include: {
        payments: { where: { status: "COMPLETED" } },
        items:    { where: { status: { notIn: ["CANCELLED", "VOID"] } }, include: { product: true } },
        table:    { select: { id: true, name: true } },
        discounts: true,
      },
    }),
    prisma.order.findMany({
      where: {
        branchId,
        status:   "CLOSED",
        closedAt: { gte: range.prevFrom, lte: range.prevTo },
      },
      select: { total: true },
    }),
    prisma.payment.findMany({
      where: {
        order:     { branchId },
        status:    "REFUNDED",
        createdAt: { gte: range.from, lte: range.to },
      },
    }),
  ]);

  // ── Revenue totals ────────────────────────────────────────────

  const totalRevenue  = orders.reduce((s, o) => s + Number(o.total), 0);
  const prevRevenue   = prevOrders.reduce((s, o) => s + Number(o.total), 0);
  const taxTotal      = orders.reduce((s, o) => s + Number(o.taxAmount), 0);
  const discountTotal = orders.reduce((s, o) => s + Number(o.discountAmount), 0);
  const refundTotal   = refunds.reduce((s, p) => s + Math.abs(Number(p.amount)), 0);
  const netRevenue    = round2(totalRevenue - refundTotal);

  // ── Order stats ───────────────────────────────────────────────

  const orderCount     = orders.length;
  const prevOrderCount = prevOrders.length;
  const avgOrderValue  = orderCount > 0 ? round2(totalRevenue / orderCount) : 0;

  const byType: Record<string, number> = {};
  for (const o of orders) {
    byType[o.type] = (byType[o.type] ?? 0) + 1;
  }

  // ── Table stats ───────────────────────────────────────────────

  const dineInOrders  = orders.filter((o) => o.tableId && o.closedAt && o.createdAt);
  const durations     = dineInOrders.map((o) =>
    (o.closedAt!.getTime() - o.createdAt.getTime()) / 60000
  );
  const avgDuration   = durations.length
    ? round2(durations.reduce((s, d) => s + d, 0) / durations.length)
    : 0;

  const days = Math.max(1, Math.ceil(
    (range.to.getTime() - range.from.getTime()) / (1000 * 60 * 60 * 24)
  ));

  const uniqueTables  = new Set(orders.map((o) => o.tableId).filter(Boolean));
  const turnoverRate  = uniqueTables.size > 0
    ? round2(dineInOrders.length / uniqueTables.size / days)
    : 0;

  // Top tables by revenue
  const tableRevMap: Record<string, { name: string; revenue: number }> = {};
  for (const o of orders) {
    if (!o.tableId || !o.table) continue;
    if (!tableRevMap[o.tableId]) tableRevMap[o.tableId] = { name: o.table.name, revenue: 0 };
    tableRevMap[o.tableId].revenue = round2(tableRevMap[o.tableId].revenue + Number(o.total));
  }
  const topTables = Object.values(tableRevMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // ── Top products ──────────────────────────────────────────────

  const productMap: Record<string, { name: string; qty: number; revenue: number }> = {};
  for (const order of orders) {
    for (const item of order.items) {
      if (!productMap[item.productId]) {
        productMap[item.productId] = { name: item.name, qty: 0, revenue: 0 };
      }
      productMap[item.productId].qty     += item.quantity;
      productMap[item.productId].revenue  = round2(
        productMap[item.productId].revenue + Number(item.price) * item.quantity
      );
    }
  }
  const topProducts = Object.values(productMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // ── Peak hour ─────────────────────────────────────────────────

  const hourMap: Record<number, number> = {};
  for (const o of orders) {
    const h = new Date(o.closedAt!).getHours();
    hourMap[h] = (hourMap[h] ?? 0) + Number(o.total);
  }
  const peakHour = Object.entries(hourMap).sort(([, a], [, b]) => b - a)[0]?.[0];
  const peakLabel = peakHour
    ? `${peakHour}:00 – ${String(Number(peakHour) + 1).padStart(2, "0")}:00`
    : "—";

  // ── Sales timeline ────────────────────────────────────────────

  const buckets  = generateTimeBuckets(range.from, range.to, groupBy);
  const bucketMap: Record<string, { revenue: number; orders: number }> = {};
  for (const b of buckets) bucketMap[b] = { revenue: 0, orders: 0 };

  for (const o of orders) {
    const key = dateToBucket(o.closedAt!, groupBy);
    if (bucketMap[key]) {
      bucketMap[key].revenue = round2(bucketMap[key].revenue + Number(o.total));
      bucketMap[key].orders += 1;
    }
  }

  const salesTimeline = buckets.map((b) => ({
    period:  b,
    revenue: bucketMap[b]?.revenue ?? 0,
    orders:  bucketMap[b]?.orders  ?? 0,
  }));

  return {
    period:   { from: range.from.toISOString(), to: range.to.toISOString() },
    revenue: {
      total:     round2(totalRevenue),
      vs_prev:   pctChange(totalRevenue, prevRevenue),
      tax:       round2(taxTotal),
      discounts: round2(discountTotal),
      refunds:   round2(refundTotal),
      net:       netRevenue,
    },
    orders: {
      total:    orderCount,
      vs_prev:  pctChange(orderCount, prevOrderCount),
      avgValue: avgOrderValue,
      byType,
      byStatus: {},
    },
    tables: { turnoverRate, avgDuration, topTables },
    topProducts,
    peakHour: peakLabel,
    salesTimeline,
  };
}
