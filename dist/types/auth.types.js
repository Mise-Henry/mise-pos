// ============================================================
//  MISE — Auth Types & Role Permissions
// ============================================================

import { UserRole } from "@prisma/client";

export interface JwtPayload {
  sub: string;          // userId
  orgId: string;
  branchId: string | null;
  role: UserRole;
  sessionId: string;
  iat?: number;
  exp?: number;
}

export interface RefreshPayload {
  sub: string;
  sessionId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResponse {
  user: SafeUser;
  tokens: TokenPair;
}

export interface SafeUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  branchId: string | null;
  organizationId: string;
  avatarUrl: string | null;
}

// ── Permissions ──────────────────────────────────────────────
export type Permission =
  | "orders:read"    | "orders:write"   | "orders:void"   | "orders:close"
  | "menu:read"      | "menu:write"
  | "tables:read"    | "tables:write"
  | "payments:read"  | "payments:write"
  | "reports:read"   | "reports:export"
  | "inventory:read" | "inventory:write"
  | "users:read"     | "users:write"
  | "settings:read"  | "settings:write"
  | "discounts:apply"
  | "kds:read"       | "kds:write"
  | "shifts:open"    | "shifts:close";

// Role → permissions mapping (single source of truth)
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  SUPER_ADMIN: [
    "orders:read","orders:write","orders:void","orders:close",
    "menu:read","menu:write",
    "tables:read","tables:write",
    "payments:read","payments:write",
    "reports:read","reports:export",
    "inventory:read","inventory:write",
    "users:read","users:write",
    "settings:read","settings:write",
    "discounts:apply",
    "kds:read","kds:write",
    "shifts:open","shifts:close",
  ],
  ADMIN: [
    "orders:read","orders:write","orders:void","orders:close",
    "menu:read","menu:write",
    "tables:read","tables:write",
    "payments:read","payments:write",
    "reports:read","reports:export",
    "inventory:read","inventory:write",
    "users:read","users:write",
    "settings:read","settings:write",
    "discounts:apply",
    "kds:read","kds:write",
    "shifts:open","shifts:close",
  ],
  MANAGER: [
    "orders:read","orders:write","orders:void","orders:close",
    "menu:read",
    "tables:read","tables:write",
    "payments:read","payments:write",
    "reports:read",
    "inventory:read","inventory:write",
    "users:read",
    "settings:read",
    "discounts:apply",
    "kds:read","kds:write",
    "shifts:open","shifts:close",
  ],
  CASHIER: [
    "orders:read","orders:close",
    "menu:read",
    "tables:read",
    "payments:read","payments:write",
    "reports:read",
    "kds:read",
    "shifts:open","shifts:close",
  ],
  WAITER: [
    "orders:read","orders:write",
    "menu:read",
    "tables:read","tables:write",
    "kds:read",
    "discounts:apply",
  ],
  KITCHEN: [
    "kds:read","kds:write",
    "orders:read",
    "menu:read",
  ],
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
