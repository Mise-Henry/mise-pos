// ============================================================
//  MISE — Product Service
//  Handles: products, availability, price history, modifiers
// ============================================================

import { PrismaClient, Prisma } from "@prisma/client";
import { MenuError } from "../menu/menu.service";
import type {
  CreateProductDto,
  UpdateProductDto,
  ReorderProductsDto,
  BulkUpdateAvailabilityDto,
  ProductQueryParams,
} from "../../types/menu.types";

const prisma = new PrismaClient();

const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true, color: true, icon: true } },
  modifierGroups: {
    include: {
      modifierGroup: {
        include: {
          modifiers: {
            where:   { isActive: true },
            orderBy: { sortOrder: "asc" as const },
          },
        },
      },
    },
    orderBy: { sortOrder: "asc" as const },
  },
} satisfies Prisma.ProductInclude;

// ── List products ─────────────────────────────────────────────

export async function getProducts(branchId: string, params: ProductQueryParams = {}) {
  const {
    categoryId,
    isAvailable,
    isActive = true,
    search,
    page = 1,
    limit = 50,
    sortBy = "sortOrder",
    sortDir = "asc",
  } = params;

  const where: Prisma.ProductWhereInput = {
    branchId,
    isActive,
    ...(categoryId  !== undefined && { categoryId }),
    ...(isAvailable !== undefined && { isAvailable }),
    ...(search && {
      OR: [
        { name:        { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { sku:         { contains: search, mode: "insensitive" } },
        { barcode:     { contains: search, mode: "insensitive" } },
      ],
    }),
  };

  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      include: PRODUCT_INCLUDE,
      orderBy: { [sortBy]: sortDir },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  };
}

// ── Get single product ────────────────────────────────────────

export async function getProductById(branchId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where:   { id: productId, branchId },
    include: {
      ...PRODUCT_INCLUDE,
      priceHistory: { orderBy: { changedAt: "desc" }, take: 10 },
      stockRecipe: {
        include: { stockItem: { select: { id: true, name: true, unit: true } } },
      },
    },
  });

  if (!product) throw new MenuError("NOT_FOUND", "Product not found", 404);
  return product;
}

// ── Create product ────────────────────────────────────────────

export async function createProduct(
  branchId: string,
  createdById: string,
  dto: CreateProductDto
) {
  // Verify category belongs to this branch
  const category = await prisma.category.findFirst({
    where: { id: dto.categoryId, branchId, isActive: true },
  });
  if (!category) throw new MenuError("NOT_FOUND", "Category not found", 404);

  // Auto-assign sortOrder
  if (dto.sortOrder === undefined) {
    const last = await prisma.product.findFirst({
      where:   { categoryId: dto.categoryId, isActive: true },
      orderBy: { sortOrder: "desc" },
    });
    dto.sortOrder = (last?.sortOrder ?? -1) + 1;
  }

  // Validate modifier groups exist
  if (dto.modifierGroupIds?.length) {
    const found = await prisma.modifierGroup.count({
      where: { id: { in: dto.modifierGroupIds }, isActive: true },
    });
    if (found !== dto.modifierGroupIds.length) {
      throw new MenuError("NOT_FOUND", "One or more modifier groups not found");
    }
  }

  const product = await prisma.product.create({
    data: {
      branchId,
      categoryId:      dto.categoryId,
      name:            dto.name,
      description:     dto.description ?? null,
      sku:             dto.sku ?? null,
      barcode:         dto.barcode ?? null,
      price:           dto.price,
      cost:            dto.cost ?? null,
      taxRate:         dto.taxRate ?? 8,
      preparationTime: dto.preparationTime ?? null,
      kitchenNote:     dto.kitchenNote ?? null,
      sortOrder:       dto.sortOrder,
      // Link modifier groups
      ...(dto.modifierGroupIds?.length && {
        modifierGroups: {
          create: dto.modifierGroupIds.map((mgId, i) => ({
            modifierGroupId: mgId,
            sortOrder:       i,
          })),
        },
      }),
    },
    include: PRODUCT_INCLUDE,
  });

  return product;
}

// ── Update product ────────────────────────────────────────────

export async function updateProduct(
  branchId: string,
  productId: string,
  updatedById: string,
  dto: UpdateProductDto
) {
  const existing = await prisma.product.findFirst({
    where: { id: productId, branchId },
  });
  if (!existing) throw new MenuError("NOT_FOUND", "Product not found", 404);

  if (dto.categoryId) {
    const cat = await prisma.category.findFirst({
      where: { id: dto.categoryId, branchId, isActive: true },
    });
    if (!cat) throw new MenuError("NOT_FOUND", "Category not found", 404);
  }

  // Record price change in history
  const priceChanged =
    dto.price !== undefined &&
    Number(dto.price) !== Number(existing.price);

  await prisma.$transaction(async (tx) => {
    if (priceChanged) {
      await tx.productPriceHistory.create({
        data: {
          productId,
          oldPrice:  existing.price,
          newPrice:  dto.price!,
          changedBy: updatedById,
        },
      });
    }

    // Update modifier group links if provided
    if (dto.modifierGroupIds !== undefined) {
      await tx.productModifierGroup.deleteMany({ where: { productId } });
      if (dto.modifierGroupIds.length > 0) {
        await tx.productModifierGroup.createMany({
          data: dto.modifierGroupIds.map((mgId, i) => ({
            productId,
            modifierGroupId: mgId,
            sortOrder:       i,
          })),
        });
      }
    }

    await tx.product.update({
      where: { id: productId },
      data: {
        ...(dto.categoryId      !== undefined && { categoryId:      dto.categoryId }),
        ...(dto.name            !== undefined && { name:            dto.name }),
        ...(dto.description     !== undefined && { description:     dto.description }),
        ...(dto.sku             !== undefined && { sku:             dto.sku }),
        ...(dto.barcode         !== undefined && { barcode:         dto.barcode }),
        ...(dto.price           !== undefined && { price:           dto.price }),
        ...(dto.cost            !== undefined && { cost:            dto.cost }),
        ...(dto.taxRate         !== undefined && { taxRate:         dto.taxRate }),
        ...(dto.preparationTime !== undefined && { preparationTime: dto.preparationTime }),
        ...(dto.kitchenNote     !== undefined && { kitchenNote:     dto.kitchenNote }),
        ...(dto.sortOrder       !== undefined && { sortOrder:       dto.sortOrder }),
        ...(dto.isAvailable     !== undefined && { isAvailable:     dto.isAvailable }),
        ...(dto.isActive        !== undefined && { isActive:        dto.isActive }),
      },
    });
  });

  return getProductById(branchId, productId);
}

// ── Toggle availability (86'd) ────────────────────────────────
// Quick toggle for when a dish runs out mid-service

export async function toggleAvailability(branchId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, branchId },
  });
  if (!product) throw new MenuError("NOT_FOUND", "Product not found", 404);

  return prisma.product.update({
    where: { id: productId },
    data:  { isAvailable: !product.isAvailable },
    select: { id: true, name: true, isAvailable: true },
  });
}

// ── Bulk availability update ──────────────────────────────────

export async function bulkUpdateAvailability(
  branchId: string,
  dto: BulkUpdateAvailabilityDto
) {
  const result = await prisma.product.updateMany({
    where: { id: { in: dto.productIds }, branchId },
    data:  { isAvailable: dto.isAvailable },
  });

  return { updated: result.count, isAvailable: dto.isAvailable };
}

// ── Delete product ────────────────────────────────────────────

export async function deleteProduct(branchId: string, productId: string) {
  await prisma.product.findFirst({ where: { id: productId, branchId } });

  // Check if used in any open orders
  const activeOrderItems = await prisma.orderItem.count({
    where: {
      productId,
      order: { status: { notIn: ["CLOSED", "CANCELLED", "VOID"] } },
    },
  });

  if (activeOrderItems > 0) {
    throw new MenuError(
      "PRODUCT_IN_ACTIVE_ORDER",
      "Product is in an active order. Mark it unavailable instead.",
      409
    );
  }

  return prisma.product.update({
    where: { id: productId },
    data:  { isActive: false, isAvailable: false },
  });
}

// ── Reorder products ──────────────────────────────────────────

export async function reorderProducts(branchId: string, dto: ReorderProductsDto) {
  const updates = dto.items.map(({ id, sortOrder }) =>
    prisma.product.updateMany({
      where: { id, branchId },
      data:  { sortOrder },
    })
  );
  await prisma.$transaction(updates);
  return { message: `Reordered ${dto.items.length} products` };
}

// ── Get price history ─────────────────────────────────────────

export async function getPriceHistory(branchId: string, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, branchId } });
  if (!product) throw new MenuError("NOT_FOUND", "Product not found", 404);

  return prisma.productPriceHistory.findMany({
    where:   { productId },
    orderBy: { changedAt: "desc" },
    take:    50,
  });
}

// ── Search across all products ────────────────────────────────

export async function searchProducts(branchId: string, query: string) {
  if (query.length < 2) return [];

  return prisma.product.findMany({
    where: {
      branchId,
      isActive:    true,
      isAvailable: true,
      OR: [
        { name:        { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
        { sku:         { contains: query, mode: "insensitive" } },
        { barcode:     { equals: query } }, // exact barcode match
      ],
    },
    include: PRODUCT_INCLUDE,
    take:    20,
  });
}
