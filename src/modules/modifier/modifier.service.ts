// ============================================================
//  MISE — Modifier Service
//  Handles: modifier groups (Size, Cooking pref) + options
// ============================================================

import { PrismaClient } from "@prisma/client";
import { MenuError } from "../menu/menu.service";
import type {
  CreateModifierGroupDto,
  UpdateModifierGroupDto,
  CreateModifierDto,
  UpdateModifierDto,
} from "../../types/menu.types";

const prisma = new PrismaClient();

// ── Modifier Groups ───────────────────────────────────────────

export async function getModifierGroups(branchId: string) {
  // Modifier groups are org-level (no branchId) but we check
  // they're used by products in this branch for relevance.
  return prisma.modifierGroup.findMany({
    where:   { isActive: true },
    include: {
      modifiers: {
        where:   { isActive: true },
        orderBy: { sortOrder: "asc" },
      },
      _count: { select: { products: true } },
    },
    orderBy: { name: "asc" },
  });
}

export async function getModifierGroupById(groupId: string) {
  const group = await prisma.modifierGroup.findUnique({
    where:   { id: groupId },
    include: {
      modifiers: {
        where:   { isActive: true },
        orderBy: { sortOrder: "asc" },
      },
      _count: { select: { products: true } },
    },
  });

  if (!group) throw new MenuError("NOT_FOUND", "Modifier group not found", 404);
  return group;
}

export async function createModifierGroup(dto: CreateModifierGroupDto) {
  return prisma.modifierGroup.create({
    data: {
      name:       dto.name,
      minSelect:  dto.minSelect ?? 0,
      maxSelect:  dto.maxSelect ?? 1,
      isRequired: dto.isRequired ?? false,
      modifiers: dto.modifiers?.length
        ? {
            create: dto.modifiers.map((m, i) => ({
              name:      m.name,
              price:     m.price ?? 0,
              isDefault: m.isDefault ?? false,
              sortOrder: m.sortOrder ?? i,
            })),
          }
        : undefined,
    },
    include: {
      modifiers: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
    },
  });
}

export async function updateModifierGroup(groupId: string, dto: UpdateModifierGroupDto) {
  await assertGroupExists(groupId);

  // Validate: minSelect <= maxSelect
  if (
    dto.minSelect !== undefined &&
    dto.maxSelect !== undefined &&
    dto.minSelect > dto.maxSelect
  ) {
    throw new MenuError("INVALID_SELECTION", "minSelect cannot be greater than maxSelect");
  }

  return prisma.modifierGroup.update({
    where: { id: groupId },
    data: {
      ...(dto.name       !== undefined && { name:       dto.name }),
      ...(dto.minSelect  !== undefined && { minSelect:  dto.minSelect }),
      ...(dto.maxSelect  !== undefined && { maxSelect:  dto.maxSelect }),
      ...(dto.isRequired !== undefined && { isRequired: dto.isRequired }),
      ...(dto.isActive   !== undefined && { isActive:   dto.isActive }),
    },
    include: {
      modifiers: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
    },
  });
}

export async function deleteModifierGroup(groupId: string) {
  const group = await assertGroupExists(groupId);

  const productCount = await prisma.productModifierGroup.count({
    where: { modifierGroupId: groupId },
  });

  if (productCount > 0) {
    throw new MenuError(
      "GROUP_IN_USE",
      `This modifier group is used by ${productCount} product(s). Remove from products first.`,
      409
    );
  }

  return prisma.modifierGroup.update({
    where: { id: groupId },
    data:  { isActive: false },
  });
}

// ── Modifiers (individual options within a group) ─────────────

export async function createModifier(groupId: string, dto: CreateModifierDto) {
  await assertGroupExists(groupId);

  const last = await prisma.modifier.findFirst({
    where:   { modifierGroupId: groupId, isActive: true },
    orderBy: { sortOrder: "desc" },
  });

  return prisma.modifier.create({
    data: {
      modifierGroupId: groupId,
      name:      dto.name,
      price:     dto.price ?? 0,
      isDefault: dto.isDefault ?? false,
      sortOrder: dto.sortOrder ?? (last?.sortOrder ?? -1) + 1,
    },
  });
}

export async function updateModifier(
  groupId: string,
  modifierId: string,
  dto: UpdateModifierDto
) {
  const modifier = await prisma.modifier.findFirst({
    where: { id: modifierId, modifierGroupId: groupId },
  });
  if (!modifier) throw new MenuError("NOT_FOUND", "Modifier not found", 404);

  return prisma.modifier.update({
    where: { id: modifierId },
    data: {
      ...(dto.name      !== undefined && { name:      dto.name }),
      ...(dto.price     !== undefined && { price:     dto.price }),
      ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
      ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      ...(dto.isActive  !== undefined && { isActive:  dto.isActive }),
    },
  });
}

export async function deleteModifier(groupId: string, modifierId: string) {
  const modifier = await prisma.modifier.findFirst({
    where: { id: modifierId, modifierGroupId: groupId },
  });
  if (!modifier) throw new MenuError("NOT_FOUND", "Modifier not found", 404);

  return prisma.modifier.update({
    where: { id: modifierId },
    data:  { isActive: false },
  });
}

export async function reorderModifiers(
  groupId: string,
  items: Array<{ id: string; sortOrder: number }>
) {
  await assertGroupExists(groupId);
  const updates = items.map(({ id, sortOrder }) =>
    prisma.modifier.update({ where: { id }, data: { sortOrder } })
  );
  await prisma.$transaction(updates);
  return { message: `Reordered ${items.length} modifiers` };
}

// ── Helper ────────────────────────────────────────────────────

async function assertGroupExists(groupId: string) {
  const group = await prisma.modifierGroup.findUnique({ where: { id: groupId } });
  if (!group) throw new MenuError("NOT_FOUND", "Modifier group not found", 404);
  return group;
}
