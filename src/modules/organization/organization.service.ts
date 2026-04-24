// ============================================================
//  MISE — Organization & Multi-Branch Service
//  Central management layer: org-level analytics, branch
//  provisioning, cross-branch reporting, user management.
// ============================================================

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

export class OrgError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "OrgError";
  }
}

function round2(n: number) { return Math.round(n * 100) / 100; }

// ── Organization ──────────────────────────────────────────────

export async function getOrganization(orgId: string) {
  const org = await prisma.organization.findUnique({
    where:   { id: orgId },
    include: {
      branches: {
        where:   { isActive: true },
        include: { _count: { select: { users: true, orders: true } } },
        orderBy: { name: "asc" },
      },
      plans: {
        where:   { isActive: true },
        orderBy: { startsAt: "desc" },
        take:    1,
      },
    },
  });
  if (!org) throw new OrgError("NOT_FOUND", "Organization not found", 404);
  return org;
}

export async function updateOrganization(orgId: string, dto: {
  name?: string; phone?: string; email?: string;
  address?: string; currency?: string; timezone?: string; locale?: string;
}) {
  return prisma.organization.update({
    where: { id: orgId },
    data: {
      ...(dto.name     !== undefined && { name:     dto.name }),
      ...(dto.phone    !== undefined && { phone:    dto.phone }),
      ...(dto.email    !== undefined && { email:    dto.email }),
      ...(dto.address  !== undefined && { address:  dto.address }),
      ...(dto.currency !== undefined && { currency: dto.currency }),
      ...(dto.timezone !== undefined && { timezone: dto.timezone }),
      ...(dto.locale   !== undefined && { locale:   dto.locale }),
    },
  });
}

// ── Branches ──────────────────────────────────────────────────

export async function getBranches(orgId: string) {
  return prisma.branch.findMany({
    where:   { organizationId: orgId, isActive: true },
    include: {
      _count: { select: { users: true, tables: true, orders: true } },
    },
    orderBy: { name: "asc" },
  });
}

export async function getBranchById(orgId: string, branchId: string) {
  const branch = await prisma.branch.findFirst({
    where:   { id: branchId, organizationId: orgId },
    include: {
      users:  { where: { isActive: true }, select: { id: true, firstName: true, lastName: true, role: true, lastLoginAt: true } },
      tables: { where: { isActive: true }, select: { id: true, name: true, status: true, capacity: true } },
    },
  });
  if (!branch) throw new OrgError("NOT_FOUND", "Branch not found", 404);
  return branch;
}

export async function createBranch(orgId: string, dto: {
  name: string; address?: string; phone?: string; taxId?: string;
}) {
  // Check subscription branch limit
  const plan = await prisma.subscriptionPlan.findFirst({
    where: { organizationId: orgId, isActive: true },
  });
  const currentCount = await prisma.branch.count({
    where: { organizationId: orgId, isActive: true },
  });
  if (plan && currentCount >= plan.maxBranches) {
    throw new OrgError(
      "BRANCH_LIMIT_REACHED",
      `Your plan allows ${plan.maxBranches} branch(es). Upgrade to add more.`,
      402
    );
  }

  return prisma.branch.create({
    data: {
      organizationId: orgId,
      name:    dto.name,
      address: dto.address ?? null,
      phone:   dto.phone   ?? null,
      taxId:   dto.taxId   ?? null,
    },
  });
}

export async function updateBranch(orgId: string, branchId: string, dto: {
  name?: string; address?: string; phone?: string; isActive?: boolean;
}) {
  await assertBranch(orgId, branchId);
  return prisma.branch.update({
    where: { id: branchId },
    data: {
      ...(dto.name     !== undefined && { name:     dto.name }),
      ...(dto.address  !== undefined && { address:  dto.address }),
      ...(dto.phone    !== undefined && { phone:    dto.phone }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    },
  });
}

// ── Users (org-wide) ──────────────────────────────────────────

export async function getOrgUsers(orgId: string) {
  return prisma.user.findMany({
    where:   { organizationId: orgId, isActive: true },
    select: {
      id: true, firstName: true, lastName: true,
      email: true, role: true, branchId: true,
      lastLoginAt: true, createdAt: true,
      branch: { select: { name: true } },
    },
    orderBy: [{ role: "asc" }, { firstName: "asc" }],
  });
}

export async function createUser(orgId: string, dto: {
  branchId?: string; email: string; password: string;
  firstName: string; lastName: string;
  role: string; pin?: string;
}) {
  // Check subscription user limit
  const plan = await prisma.subscriptionPlan.findFirst({
    where: { organizationId: orgId, isActive: true },
  });
  const currentCount = await prisma.user.count({
    where: { organizationId: orgId, isActive: true },
  });
  if (plan && currentCount >= plan.maxUsers) {
    throw new OrgError("USER_LIMIT_REACHED", `Your plan allows ${plan.maxUsers} users. Upgrade to add more.`, 402);
  }

  const existing = await prisma.user.findUnique({ where: { email: dto.email } });
  if (existing) throw new OrgError("EMAIL_TAKEN", "Email is already registered");

  const passwordHash = await bcrypt.hash(dto.password, 10);
  const pinHash      = dto.pin ? await bcrypt.hash(dto.pin, 10) : null;

  return prisma.user.create({
    data: {
      organizationId: orgId,
      branchId:   dto.branchId ?? null,
      email:      dto.email,
      firstName:  dto.firstName,
      lastName:   dto.lastName,
      role:       dto.role as any,
      passwordHash,
      pin:        pinHash,
    },
    select: {
      id: true, firstName: true, lastName: true,
      email: true, role: true, branchId: true, createdAt: true,
    },
  });
}

export async function updateUser(orgId: string, userId: string, dto: {
  firstName?: string; lastName?: string; branchId?: string;
  role?: string; isActive?: boolean; password?: string; pin?: string;
}) {
  const user = await prisma.user.findFirst({ where: { id: userId, organizationId: orgId } });
  if (!user) throw new OrgError("NOT_FOUND", "User not found", 404);

  return prisma.user.update({
    where: { id: userId },
    data: {
      ...(dto.firstName !== undefined && { firstName: dto.firstName }),
      ...(dto.lastName  !== undefined && { lastName:  dto.lastName }),
      ...(dto.branchId  !== undefined && { branchId:  dto.branchId }),
      ...(dto.role      !== undefined && { role:      dto.role as any }),
      ...(dto.isActive  !== undefined && { isActive:  dto.isActive }),
      ...(dto.password  && { passwordHash: await bcrypt.hash(dto.password, 10) }),
      ...(dto.pin       && { pin:          await bcrypt.hash(dto.pin, 10) }),
    },
    select: {
      id: true, firstName: true, lastName: true,
      email: true, role: true, branchId: true, isActive: true,
    },
  });
}

// ── Cross-branch Analytics (SUPER_ADMIN / ADMIN) ──────────────

export async function getCrossBranchSummary(orgId: string, dateFrom: Date, dateTo: Date) {
  const branches = await prisma.branch.findMany({
    where: { organizationId: orgId, isActive: true },
  });

  const results = await Promise.all(
    branches.map(async (branch) => {
      const orders = await prisma.order.findMany({
        where: {
          branchId: branch.id,
          status:   "CLOSED",
          closedAt: { gte: dateFrom, lte: dateTo },
        },
        select: { total: true, type: true, discountAmount: true, taxAmount: true },
      });

      const revenue      = orders.reduce((s, o) => s + Number(o.total),          0);
      const discounts    = orders.reduce((s, o) => s + Number(o.discountAmount),  0);
      const tax          = orders.reduce((s, o) => s + Number(o.taxAmount),       0);
      const orderCount   = orders.length;
      const avgOrder     = orderCount > 0 ? round2(revenue / orderCount) : 0;

      return {
        branchId:   branch.id,
        branchName: branch.name,
        revenue:    round2(revenue),
        discounts:  round2(discounts),
        tax:        round2(tax),
        orderCount,
        avgOrder,
        netRevenue: round2(revenue - discounts),
      };
    })
  );

  const totals = {
    revenue:    round2(results.reduce((s, b) => s + b.revenue,    0)),
    orderCount: results.reduce((s, b) => s + b.orderCount,        0),
    discounts:  round2(results.reduce((s, b) => s + b.discounts,  0)),
    netRevenue: round2(results.reduce((s, b) => s + b.netRevenue, 0)),
  };

  return { period: { from: dateFrom, to: dateTo }, branches: results, totals };
}

// ── Subscription / Plan ───────────────────────────────────────

export async function getSubscriptionPlan(orgId: string) {
  return prisma.subscriptionPlan.findFirst({
    where:   { organizationId: orgId, isActive: true },
    orderBy: { startsAt: "desc" },
  });
}

// ── Helper ────────────────────────────────────────────────────

async function assertBranch(orgId: string, branchId: string) {
  const branch = await prisma.branch.findFirst({ where: { id: branchId, organizationId: orgId } });
  if (!branch) throw new OrgError("NOT_FOUND", "Branch not found", 404);
  return branch;
}
