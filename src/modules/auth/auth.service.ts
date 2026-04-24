// ============================================================
//  MISE — Auth Service
//  All authentication business logic lives here
// ============================================================

import bcrypt from "bcryptjs";
import { FastifyInstance } from "fastify";
import { prisma } from "../../config/prisma";
import { generateTokenPair, verifyRefreshToken } from "../../utils/token.utils";
import {
  LoginResponse,
  SafeUser,
  TokenPair,
} from "../../types/auth.types";

// ── Helpers ──────────────────────────────────────────────────

function toSafeUser(user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: any;
  branchId: string | null;
  organizationId: string;
  avatarUrl: string | null;
}): SafeUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    branchId: user.branchId,
    organizationId: user.organizationId,
    avatarUrl: user.avatarUrl,
  };
}

// ── Login with email + password ───────────────────────────────

export async function loginWithEmail(
  fastify: FastifyInstance,
  email: string,
  password: string,
  device?: string,
  ipAddress?: string
): Promise<LoginResponse> {
  // 1. Find user
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
  });

  if (!user || !user.isActive) {
    throw { statusCode: 401, message: "Invalid credentials" };
  }

  // 2. Verify password
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    // Log failed attempt for security audit
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "LOGIN_FAILED",
        entityType: "User",
        entityId: user.id,
        ipAddress,
        newValue: { reason: "invalid_password", email },
      },
    });
    throw { statusCode: 401, message: "Invalid credentials" };
  }

  // 3. Create session
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      token: crypto.randomUUID(),
      device: device ?? "Unknown",
      ipAddress,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
  });

  // 4. Generate tokens
  const tokens = await generateTokenPair(fastify, {
    sub: user.id,
    orgId: user.organizationId,
    branchId: user.branchId,
    role: user.role,
    sessionId: session.id,
  });

  // 5. Update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "LOGIN_SUCCESS",
      entityType: "User",
      entityId: user.id,
      ipAddress,
    },
  });

  return { user: toSafeUser(user), tokens };
}

// ── PIN Login (for POS terminals — fast, no keyboard) ─────────

export async function loginWithPin(
  fastify: FastifyInstance,
  branchId: string,
  pin: string,
  device?: string,
  ipAddress?: string
): Promise<LoginResponse> {
  if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    throw { statusCode: 400, message: "PIN must be exactly 4 digits" };
  }

  // Find active user with this PIN in this branch
  const user = await prisma.user.findFirst({
    where: { branchId, pin, isActive: true },
  });

  if (!user) {
    throw { statusCode: 401, message: "Invalid PIN" };
  }

  // Kitchen staff can only log in via PIN on a KDS device
  // (no full system access)
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      token: crypto.randomUUID(),
      device: device ?? "POS Terminal",
      ipAddress,
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000), // 12h shift max
    },
  });

  const tokens = await generateTokenPair(fastify, {
    sub: user.id,
    orgId: user.organizationId,
    branchId: user.branchId,
    role: user.role,
    sessionId: session.id,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return { user: toSafeUser(user), tokens };
}

// ── Refresh Token ─────────────────────────────────────────────

export async function refreshAccessToken(
  fastify: FastifyInstance,
  refreshToken: string
): Promise<TokenPair> {
  // 1. Verify the refresh token signature
  let payload: { sub: string; sessionId: string };
  try {
    payload = verifyRefreshToken(fastify, refreshToken);
  } catch {
    throw { statusCode: 401, message: "Invalid or expired refresh token" };
  }

  // 2. Check session still exists and hasn't been revoked
  const session = await prisma.session.findUnique({
    where: { id: payload.sessionId },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) {
    throw { statusCode: 401, message: "Session expired. Please log in again." };
  }

  if (!session.user.isActive) {
    throw { statusCode: 401, message: "Account deactivated" };
  }

  // 3. Issue new token pair (rotation)
  const tokens = await generateTokenPair(fastify, {
    sub: session.user.id,
    orgId: session.user.organizationId,
    branchId: session.user.branchId,
    role: session.user.role,
    sessionId: session.id,
  });

  // 4. Extend session expiry on each refresh
  await prisma.session.update({
    where: { id: session.id },
    data: { expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  });

  return tokens;
}

// ── Logout ────────────────────────────────────────────────────

export async function logout(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

export async function logoutAllDevices(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

// ── Get current user ──────────────────────────────────────────

export async function getMe(userId: string): Promise<SafeUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive) {
    throw { statusCode: 404, message: "User not found" };
  }
  return toSafeUser(user);
}

// ── Change password ───────────────────────────────────────────

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw { statusCode: 404, message: "User not found" };

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) throw { statusCode: 401, message: "Current password is incorrect" };

  if (newPassword.length < 8) {
    throw { statusCode: 400, message: "Password must be at least 8 characters" };
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // Invalidate all other sessions (security best practice)
  await prisma.session.deleteMany({ where: { userId } });

  await prisma.auditLog.create({
    data: {
      userId,
      action: "PASSWORD_CHANGED",
      entityType: "User",
      entityId: userId,
    },
  });
}

// ── Change PIN ────────────────────────────────────────────────

export async function changePin(
  userId: string,
  newPin: string
): Promise<void> {
  if (!/^\d{4}$/.test(newPin)) {
    throw { statusCode: 400, message: "PIN must be exactly 4 digits" };
  }

  // Check PIN isn't already used in the same branch
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw { statusCode: 404, message: "User not found" };

  if (user.branchId) {
    const conflict = await prisma.user.findFirst({
      where: { branchId: user.branchId, pin: newPin, id: { not: userId } },
    });
    if (conflict) {
      throw { statusCode: 409, message: "This PIN is already in use by another staff member" };
    }
  }

  await prisma.user.update({ where: { id: userId }, data: { pin: newPin } });
}
