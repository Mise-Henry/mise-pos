// ============================================================
//  MISE — Menu Routes (all menu-related endpoints)
//
//  MENUS
//    GET    /menu                    — list menus
//    GET    /menu/full               — full tree (for POS UI)
//    GET    /menu/:menuId            — single menu
//    POST   /menu                    — create menu
//    PATCH  /menu/:menuId            — update menu
//    DELETE /menu/:menuId            — soft delete
//
//  CATEGORIES
//    GET    /menu/categories         — list categories
//    GET    /menu/categories/:id     — single category
//    POST   /menu/categories         — create category
//    PATCH  /menu/categories/:id     — update category
//    DELETE /menu/categories/:id     — soft delete
//    POST   /menu/categories/reorder — drag-drop reorder
//
//  PRODUCTS
//    GET    /menu/products           — list (paginated, filterable)
//    GET    /menu/products/search    — search by name/sku/barcode
//    GET    /menu/products/:id       — single product
//    POST   /menu/products           — create product
//    PATCH  /menu/products/:id       — update product
//    DELETE /menu/products/:id       — soft delete
//    POST   /menu/products/reorder   — drag-drop reorder
//    PATCH  /menu/products/:id/toggle-availability
//    POST   /menu/products/bulk-availability
//    GET    /menu/products/:id/price-history
//
//  MODIFIER GROUPS
//    GET    /menu/modifier-groups         — list all
//    GET    /menu/modifier-groups/:id     — single group
//    POST   /menu/modifier-groups         — create group
//    PATCH  /menu/modifier-groups/:id     — update group
//    DELETE /menu/modifier-groups/:id     — soft delete
//    POST   /menu/modifier-groups/:id/modifiers          — add modifier
//    PATCH  /menu/modifier-groups/:id/modifiers/:modId   — update modifier
//    DELETE /menu/modifier-groups/:id/modifiers/:modId   — remove modifier
//    POST   /menu/modifier-groups/:id/modifiers/reorder  — reorder
// ============================================================

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireRole, requirePermission } from "../middleware/auth.middleware";
import {
  getMenus, getMenuById, getFullMenu,
  createMenu, updateMenu, deleteMenu,
  getCategories, getCategoryById,
  createCategory, updateCategory, deleteCategory,
  reorderCategories, MenuError,
} from "../menu/menu.service";
import {
  getProducts, getProductById, createProduct,
  updateProduct, deleteProduct, reorderProducts,
  toggleAvailability, bulkUpdateAvailability,
  getPriceHistory, searchProducts,
} from "../product/product.service";
import {
  getModifierGroups, getModifierGroupById,
  createModifierGroup, updateModifierGroup, deleteModifierGroup,
  createModifier, updateModifier, deleteModifier, reorderModifiers,
} from "../modifier/modifier.service";

// ── Zod schemas ───────────────────────────────────────────────

const MenuSchema = z.object({
  name:          z.string().min(1),
  isDefault:     z.boolean().optional(),
  availableFrom: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  availableTo:   z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

const CategorySchema = z.object({
  menuId:      z.string().optional(),
  parentId:    z.string().optional(),
  name:        z.string().min(1),
  description: z.string().optional(),
  color:       z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon:        z.string().optional(),
  sortOrder:   z.number().int().min(0).optional(),
});

const ProductSchema = z.object({
  categoryId:      z.string().min(1),
  name:            z.string().min(1),
  description:     z.string().optional(),
  sku:             z.string().optional(),
  barcode:         z.string().optional(),
  price:           z.number().positive(),
  cost:            z.number().positive().optional(),
  taxRate:         z.number().min(0).max(100).optional(),
  preparationTime: z.number().int().positive().optional(),
  kitchenNote:     z.string().optional(),
  sortOrder:       z.number().int().min(0).optional(),
  modifierGroupIds: z.array(z.string()).optional(),
});

const ModifierGroupSchema = z.object({
  name:       z.string().min(1),
  minSelect:  z.number().int().min(0).optional(),
  maxSelect:  z.number().int().min(1).optional(),
  isRequired: z.boolean().optional(),
  modifiers: z.array(z.object({
    name:      z.string().min(1),
    price:     z.number().min(0).optional(),
    isDefault: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })).optional(),
});

const ModifierSchema = z.object({
  name:      z.string().min(1),
  price:     z.number().min(0).optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const ReorderSchema = z.object({
  items: z.array(z.object({ id: z.string(), sortOrder: z.number().int().min(0) })).min(1),
});

// ── Error handler ─────────────────────────────────────────────

function handleError(err: unknown, reply: any) {
  if (err instanceof MenuError) {
    return reply.status(err.statusCode).send({ error: err.code, message: err.message });
  }
  throw err;
}

function validate<T>(schema: z.ZodSchema<T>, data: unknown, reply: any): T | null {
  const r = schema.safeParse(data);
  if (!r.success) {
    reply.status(400).send({ error: "VALIDATION_ERROR", message: r.error.issues[0].message, details: r.error.issues });
    return null;
  }
  return r.data;
}

// ── Route registration ────────────────────────────────────────

export async function menuRoutes(fastify: FastifyInstance) {
  // All menu routes require authentication
  fastify.addHook("preHandler", authenticate);

  const getBranch = (req: any) => req.user.branchId!;
  const getUserId = (req: any) => req.user.userId;

  // ─── MENUS ──────────────────────────────────────────────────

  fastify.get("/", async (req, reply) => {
    try { return reply.send(await getMenus(getBranch(req))); }
    catch (err) { return handleError(err, reply); }
  });

  // Full menu tree — used by POS terminal to load all categories + products
  fastify.get("/full", async (req, reply) => {
    try { return reply.send(await getFullMenu(getBranch(req))); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/:menuId", async (req: any, reply) => {
    try { return reply.send(await getMenuById(getBranch(req), req.params.menuId)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/", { preHandler: [requireRole("MANAGER")] }, async (req, reply) => {
    const dto = validate(MenuSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createMenu(getBranch(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/:menuId", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    const dto = validate(MenuSchema.partial(), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateMenu(getBranch(req), req.params.menuId, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.delete("/:menuId", { preHandler: [requireRole("ADMIN")] }, async (req: any, reply) => {
    try { return reply.send(await deleteMenu(getBranch(req), req.params.menuId)); }
    catch (err) { return handleError(err, reply); }
  });

  // ─── CATEGORIES ──────────────────────────────────────────────

  fastify.get("/categories", async (req: any, reply) => {
    const menuId = (req.query as any).menuId;
    try { return reply.send(await getCategories(getBranch(req), menuId)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/categories/:id", async (req: any, reply) => {
    try { return reply.send(await getCategoryById(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/categories", { preHandler: [requireRole("MANAGER")] }, async (req, reply) => {
    const dto = validate(CategorySchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createCategory(getBranch(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/categories/:id", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    const dto = validate(CategorySchema.partial().extend({ isActive: z.boolean().optional() }), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateCategory(getBranch(req), req.params.id, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.delete("/categories/:id", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    try { return reply.send(await deleteCategory(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/categories/reorder", { preHandler: [requireRole("MANAGER")] }, async (req, reply) => {
    const dto = validate(ReorderSchema, req.body, reply);
    if (!dto) return;
    try { return reply.send(await reorderCategories(getBranch(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  // ─── PRODUCTS ─────────────────────────────────────────────────

  fastify.get("/products", async (req: any, reply) => {
    const q = req.query as any;
    try {
      return reply.send(await getProducts(getBranch(req), {
        categoryId:  q.categoryId,
        isAvailable: q.isAvailable !== undefined ? q.isAvailable === "true" : undefined,
        isActive:    q.isActive    !== undefined ? q.isActive    === "true" : true,
        search:      q.search,
        page:        q.page  ? parseInt(q.page)  : 1,
        limit:       q.limit ? parseInt(q.limit) : 50,
        sortBy:      q.sortBy  ?? "sortOrder",
        sortDir:     q.sortDir ?? "asc",
      }));
    } catch (err) { return handleError(err, reply); }
  });

  fastify.get("/products/search", async (req: any, reply) => {
    const q = (req.query as any).q ?? "";
    try { return reply.send(await searchProducts(getBranch(req), q)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/products/:id", async (req: any, reply) => {
    try { return reply.send(await getProductById(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/products", { preHandler: [requireRole("MANAGER")] }, async (req, reply) => {
    const dto = validate(ProductSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createProduct(getBranch(req), getUserId(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/products/:id", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    const dto = validate(ProductSchema.partial().extend({
      isAvailable: z.boolean().optional(),
      isActive:    z.boolean().optional(),
    }), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateProduct(getBranch(req), req.params.id, getUserId(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.delete("/products/:id", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    try { return reply.send(await deleteProduct(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  // Quick 86 toggle (waiter can do this mid-service)
  fastify.patch("/products/:id/toggle-availability",
    { preHandler: [requirePermission("menu:update")] },
    async (req: any, reply) => {
      try { return reply.send(await toggleAvailability(getBranch(req), req.params.id)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.post("/products/bulk-availability",
    { preHandler: [requireRole("MANAGER")] },
    async (req, reply) => {
      const dto = validate(z.object({
        productIds:  z.array(z.string()).min(1),
        isAvailable: z.boolean(),
      }), req.body, reply);
      if (!dto) return;
      try { return reply.send(await bulkUpdateAvailability(getBranch(req), dto)); }
      catch (err) { return handleError(err, reply); }
    }
  );

  fastify.post("/products/reorder", { preHandler: [requireRole("MANAGER")] }, async (req, reply) => {
    const dto = validate(ReorderSchema, req.body, reply);
    if (!dto) return;
    try { return reply.send(await reorderProducts(getBranch(req), dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/products/:id/price-history", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    try { return reply.send(await getPriceHistory(getBranch(req), req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  // ─── MODIFIER GROUPS ─────────────────────────────────────────

  fastify.get("/modifier-groups", async (_req, reply) => {
    try { return reply.send(await getModifierGroups("")); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.get("/modifier-groups/:id", async (req: any, reply) => {
    try { return reply.send(await getModifierGroupById(req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/modifier-groups", { preHandler: [requireRole("MANAGER")] }, async (req, reply) => {
    const dto = validate(ModifierGroupSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createModifierGroup(dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/modifier-groups/:id", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    const dto = validate(ModifierGroupSchema.partial().extend({ isActive: z.boolean().optional() }), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateModifierGroup(req.params.id, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.delete("/modifier-groups/:id", { preHandler: [requireRole("ADMIN")] }, async (req: any, reply) => {
    try { return reply.send(await deleteModifierGroup(req.params.id)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/modifier-groups/:id/modifiers", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    const dto = validate(ModifierSchema, req.body, reply);
    if (!dto) return;
    try { return reply.status(201).send(await createModifier(req.params.id, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.patch("/modifier-groups/:id/modifiers/:modId", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    const dto = validate(ModifierSchema.partial().extend({ isActive: z.boolean().optional() }), req.body, reply);
    if (!dto) return;
    try { return reply.send(await updateModifier(req.params.id, req.params.modId, dto)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.delete("/modifier-groups/:id/modifiers/:modId", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    try { return reply.send(await deleteModifier(req.params.id, req.params.modId)); }
    catch (err) { return handleError(err, reply); }
  });

  fastify.post("/modifier-groups/:id/modifiers/reorder", { preHandler: [requireRole("MANAGER")] }, async (req: any, reply) => {
    const dto = validate(ReorderSchema, req.body, reply);
    if (!dto) return;
    try { return reply.send(await reorderModifiers(req.params.id, dto.items)); }
    catch (err) { return handleError(err, reply); }
  });
}
