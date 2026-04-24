// ============================================================
//  MISE — Menu Service
//  Handles: menus, categories, reordering, full menu fetch
// ============================================================

import { PrismaClient } from "@prisma/client";
import type {
  CreateMenuDto,
  UpdateMenuDto,
  CreateCategoryDto,
  UpdateCategoryDto,
  ReorderCategoriesDto,
  FullMenuResponse,
} from "../../types/menu.types";

const prisma = new PrismaClient();

export class MenuError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "MenuError";
  }
}

// ── Menus ─────────────────────────────────────────────────────

export async function getMenus(branchId: string) {
  return prisma.menu.findMany({
    where:   { branchId, isActive: true },
    include: { categories: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function getMenuById(branchId: string, menuId: string) {
  const menu = await prisma.menu.findFirst({
    where:   { id: menuId, branchId },
    include: {
      categories: {
        where:   { isActive: true },
        orderBy: { sortOrder: "asc" },
        include: {
          products: {
            where:   { isActive: true },
            orderBy: { sortOrder: "asc" },
          },
        },
      },
    },
  });

  if (!menu) throw new MenuError("NOT_FOUND", "Menu not found", 404);
  return menu;
}

// Returns the full menu tree ready for the POS UI
export async function getFullMenu(branchId: string): Promise<FullMenuResponse[]> {
  const menus = await prisma.menu.findMany({
    where:   { branchId, isActive: true },
    orderBy: { createdAt: "asc" },
    include: {
      categories: {
        where:   { isActive: true, parentId: null }, // top-level only
        orderBy: { sortOrder: "asc" },
        include: {
          children: {
            where:   { isActive: true },
            orderBy: { sortOrder: "asc" },
            include: {
              products: {
                where:   { isActive: true, isAvailable: true },
                orderBy: { sortOrder: "asc" },
                include: {
                  modifierGroups: {
                    include: {
                      modifierGroup: {
                        include: { modifiers: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } },
                      },
                    },
                  },
                },
              },
            },
          },
          products: {
            where:   { isActive: true, isAvailable: true },
            orderBy: { sortOrder: "asc" },
            include: {
              modifierGroups: {
                include: {
                  modifierGroup: {
                    include: { modifiers: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  return menus as any;
}

export async function createMenu(branchId: string, dto: CreateMenuDto) {
  // If setting as default, unset other defaults first
  if (dto.isDefault) {
    await prisma.menu.updateMany({
      where: { branchId, isDefault: true },
      data:  { isDefault: false },
    });
  }

  return prisma.menu.create({
    data: {
      branchId,
      name:          dto.name,
      isDefault:     dto.isDefault ?? false,
      availableFrom: dto.availableFrom as any ?? null,
      availableTo:   dto.availableTo as any ?? null,
    },
  });
}

export async function updateMenu(branchId: string, menuId: string, dto: UpdateMenuDto) {
  await assertMenuExists(branchId, menuId);

  if (dto.isDefault) {
    await prisma.menu.updateMany({
      where: { branchId, isDefault: true, id: { not: menuId } },
      data:  { isDefault: false },
    });
  }

  return prisma.menu.update({
    where: { id: menuId },
    data:  {
      ...(dto.name          !== undefined && { name:          dto.name }),
      ...(dto.isDefault     !== undefined && { isDefault:     dto.isDefault }),
      ...(dto.isActive      !== undefined && { isActive:      dto.isActive }),
      ...(dto.availableFrom !== undefined && { availableFrom: dto.availableFrom as any }),
      ...(dto.availableTo   !== undefined && { availableTo:   dto.availableTo as any }),
    },
  });
}

export async function deleteMenu(branchId: string, menuId: string) {
  const menu = await assertMenuExists(branchId, menuId);
  if (menu.isDefault) {
    throw new MenuError("CANNOT_DELETE_DEFAULT", "Cannot delete the default menu. Set another menu as default first.");
  }
  // Soft delete
  return prisma.menu.update({ where: { id: menuId }, data: { isActive: false } });
}

// ── Categories ────────────────────────────────────────────────

export async function getCategories(branchId: string, menuId?: string) {
  return prisma.category.findMany({
    where:   { branchId, ...(menuId && { menuId }), isActive: true, parentId: null },
    orderBy: { sortOrder: "asc" },
    include: {
      children: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
      _count:   { select: { products: { where: { isActive: true } } } },
    },
  });
}

export async function getCategoryById(branchId: string, categoryId: string) {
  const cat = await prisma.category.findFirst({
    where:   { id: categoryId, branchId },
    include: {
      children: { where: { isActive: true } },
      products: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
      _count:   { select: { products: true } },
    },
  });
  if (!cat) throw new MenuError("NOT_FOUND", "Category not found", 404);
  return cat;
}

export async function createCategory(branchId: string, dto: CreateCategoryDto) {
  if (dto.menuId) {
    const menu = await prisma.menu.findFirst({ where: { id: dto.menuId, branchId } });
    if (!menu) throw new MenuError("NOT_FOUND", "Menu not found", 404);
  }

  if (dto.parentId) {
    const parent = await prisma.category.findFirst({ where: { id: dto.parentId, branchId } });
    if (!parent) throw new MenuError("NOT_FOUND", "Parent category not found", 404);
  }

  // Auto-assign sortOrder to end if not provided
  if (dto.sortOrder === undefined) {
    const last = await prisma.category.findFirst({
      where:   { branchId, menuId: dto.menuId ?? null, parentId: dto.parentId ?? null },
      orderBy: { sortOrder: "desc" },
    });
    dto.sortOrder = (last?.sortOrder ?? -1) + 1;
  }

  return prisma.category.create({
    data: {
      branchId,
      menuId:      dto.menuId ?? null,
      parentId:    dto.parentId ?? null,
      name:        dto.name,
      description: dto.description ?? null,
      color:       dto.color ?? null,
      icon:        dto.icon ?? null,
      sortOrder:   dto.sortOrder,
    },
  });
}

export async function updateCategory(branchId: string, categoryId: string, dto: UpdateCategoryDto) {
  await assertCategoryExists(branchId, categoryId);

  return prisma.category.update({
    where: { id: categoryId },
    data:  {
      ...(dto.name        !== undefined && { name:        dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.color       !== undefined && { color:       dto.color }),
      ...(dto.icon        !== undefined && { icon:        dto.icon }),
      ...(dto.sortOrder   !== undefined && { sortOrder:   dto.sortOrder }),
      ...(dto.isActive    !== undefined && { isActive:    dto.isActive }),
      ...(dto.menuId      !== undefined && { menuId:      dto.menuId }),
    },
  });
}

export async function deleteCategory(branchId: string, categoryId: string) {
  const cat = await assertCategoryExists(branchId, categoryId);
  const productCount = await prisma.product.count({
    where: { categoryId, isActive: true },
  });

  if (productCount > 0) {
    throw new MenuError(
      "CATEGORY_HAS_PRODUCTS",
      `Cannot delete category with ${productCount} active product(s). Move or delete products first.`
    );
  }

  return prisma.category.update({ where: { id: categoryId }, data: { isActive: false } });
}

export async function reorderCategories(branchId: string, dto: ReorderCategoriesDto) {
  const updates = dto.items.map(({ id, sortOrder }) =>
    prisma.category.updateMany({
      where: { id, branchId },
      data:  { sortOrder },
    })
  );
  await prisma.$transaction(updates);
  return { message: `Reordered ${dto.items.length} categories` };
}

// ── Helpers ───────────────────────────────────────────────────

async function assertMenuExists(branchId: string, menuId: string) {
  const menu = await prisma.menu.findFirst({ where: { id: menuId, branchId } });
  if (!menu) throw new MenuError("NOT_FOUND", "Menu not found", 404);
  return menu;
}

async function assertCategoryExists(branchId: string, categoryId: string) {
  const cat = await prisma.category.findFirst({ where: { id: categoryId, branchId } });
  if (!cat) throw new MenuError("NOT_FOUND", "Category not found", 404);
  return cat;
}
