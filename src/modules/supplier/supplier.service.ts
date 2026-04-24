// ============================================================
//  MISE — Supplier Service
// ============================================================

import { PrismaClient } from "@prisma/client";
import { InventoryError } from "../inventory/inventory.service";
import type { CreateSupplierDto, UpdateSupplierDto } from "../../types/inventory.types";

const prisma = new PrismaClient();

// Note: Supplier model not in the base schema — we extend via
// a simple pattern using the existing StockItem.supplierId field
// and a new Supplier table added as a migration.
// The Prisma schema extension is shown in the README.

// For now we store suppliers in a lightweight JSON store
// backed by the Organization settings, OR we use the
// AuditLog entity pattern. Below is the full implementation
// assuming you've run the migration to add a Supplier model.

export async function getSuppliers(branchId: string) {
  // Query the extended Supplier model (see README for migration)
  const suppliers = await (prisma as any).supplier?.findMany({
    where:   { branchId, isActive: true },
    include: { _count: { select: { stockItems: true } } },
    orderBy: { name: "asc" },
  }) ?? [];

  return suppliers;
}

export async function getSupplierById(branchId: string, supplierId: string) {
  const supplier = await (prisma as any).supplier?.findFirst({
    where:   { id: supplierId, branchId },
    include: {
      stockItems:    { where: { isActive: true }, select: { id: true, name: true, unit: true } },
      purchaseOrders: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  if (!supplier) throw new InventoryError("NOT_FOUND", "Supplier not found", 404);
  return supplier;
}

export async function createSupplier(branchId: string, dto: CreateSupplierDto) {
  return (prisma as any).supplier?.create({
    data: {
      branchId,
      name:        dto.name,
      contactName: dto.contactName ?? null,
      phone:       dto.phone       ?? null,
      email:       dto.email       ?? null,
      address:     dto.address     ?? null,
      taxId:       dto.taxId       ?? null,
      note:        dto.note        ?? null,
    },
  });
}

export async function updateSupplier(branchId: string, supplierId: string, dto: UpdateSupplierDto) {
  await getSupplierById(branchId, supplierId);

  return (prisma as any).supplier?.update({
    where: { id: supplierId },
    data: {
      ...(dto.name        !== undefined && { name:        dto.name }),
      ...(dto.contactName !== undefined && { contactName: dto.contactName }),
      ...(dto.phone       !== undefined && { phone:       dto.phone }),
      ...(dto.email       !== undefined && { email:       dto.email }),
      ...(dto.address     !== undefined && { address:     dto.address }),
      ...(dto.taxId       !== undefined && { taxId:       dto.taxId }),
      ...(dto.note        !== undefined && { note:        dto.note }),
      ...(dto.isActive    !== undefined && { isActive:    dto.isActive }),
    },
  });
}

export async function deleteSupplier(branchId: string, supplierId: string) {
  const supplier = await getSupplierById(branchId, supplierId);

  const itemCount = await prisma.stockItem.count({
    where: { supplierId, isActive: true },
  });

  if (itemCount > 0) {
    throw new InventoryError(
      "SUPPLIER_IN_USE",
      `Supplier is linked to ${itemCount} stock item(s). Reassign items first.`,
      409
    );
  }

  return (prisma as any).supplier?.update({
    where: { id: supplierId },
    data:  { isActive: false },
  });
}
