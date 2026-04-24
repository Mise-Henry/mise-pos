// ============================================================
//  MISE — Menu Types & DTOs
// ============================================================

// ── Menu ─────────────────────────────────────────────────────

export interface CreateMenuDto {
  name: string;
  isDefault?: boolean;
  availableFrom?: string; // "HH:MM" 24h format
  availableTo?: string;
}

export interface UpdateMenuDto extends Partial<CreateMenuDto> {
  isActive?: boolean;
}

// ── Category ─────────────────────────────────────────────────

export interface CreateCategoryDto {
  menuId?: string;
  parentId?: string;
  name: string;
  description?: string;
  color?: string;   // HEX e.g. "#FF5733"
  icon?: string;    // icon key e.g. "coffee", "pizza"
  sortOrder?: number;
}

export interface UpdateCategoryDto extends Partial<CreateCategoryDto> {
  isActive?: boolean;
}

export interface ReorderCategoriesDto {
  items: Array<{ id: string; sortOrder: number }>;
}

// ── Product ──────────────────────────────────────────────────

export interface CreateProductDto {
  categoryId: string;
  name: string;
  description?: string;
  sku?: string;
  barcode?: string;
  price: number;
  cost?: number;
  taxRate?: number;
  preparationTime?: number;  // minutes
  kitchenNote?: string;
  sortOrder?: number;
  modifierGroupIds?: string[];
}

export interface UpdateProductDto extends Partial<Omit<CreateProductDto, "categoryId">> {
  categoryId?: string;
  isAvailable?: boolean;
  isActive?: boolean;
}

export interface ReorderProductsDto {
  items: Array<{ id: string; sortOrder: number }>;
}

export interface BulkUpdateAvailabilityDto {
  productIds: string[];
  isAvailable: boolean;
}

// ── Modifier ─────────────────────────────────────────────────

export interface CreateModifierGroupDto {
  name: string;
  minSelect?: number;
  maxSelect?: number;
  isRequired?: boolean;
  modifiers?: CreateModifierDto[];
}

export interface UpdateModifierGroupDto extends Partial<Omit<CreateModifierGroupDto, "modifiers">> {
  isActive?: boolean;
}

export interface CreateModifierDto {
  modifierGroupId?: string;   // required when creating standalone
  name: string;
  price?: number;
  isDefault?: boolean;
  sortOrder?: number;
}

export interface UpdateModifierDto extends Partial<CreateModifierDto> {
  isActive?: boolean;
}

// ── Query filters ─────────────────────────────────────────────

export interface MenuQueryParams {
  isActive?: boolean;
  includeCategories?: boolean;
  includeProducts?: boolean;
}

export interface ProductQueryParams {
  categoryId?: string;
  isAvailable?: boolean;
  isActive?: boolean;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: "name" | "price" | "sortOrder" | "createdAt";
  sortDir?: "asc" | "desc";
}

// ── Response shapes ───────────────────────────────────────────

export interface ProductWithDetails {
  id: string;
  name: string;
  description: string | null;
  price: number;
  cost: number | null;
  taxRate: number;
  isAvailable: boolean;
  preparationTime: number | null;
  category: { id: string; name: string; color: string | null };
  modifierGroups: ModifierGroupWithModifiers[];
}

export interface ModifierGroupWithModifiers {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isRequired: boolean;
  modifiers: Array<{
    id: string;
    name: string;
    price: number;
    isDefault: boolean;
  }>;
}

export interface CategoryWithProducts {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  productCount: number;
  products?: ProductWithDetails[];
}

export interface FullMenuResponse {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  availableFrom: string | null;
  availableTo: string | null;
  categories: CategoryWithProducts[];
}
