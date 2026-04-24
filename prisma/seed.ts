// ============================================================
//  MISE — Database Seed
//  Run: npx prisma db seed
// ============================================================

import { PrismaClient, UserRole, TableStatus } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding Mise database...");

  // ── Organization ────────────────────────────────────────
  const org = await prisma.organization.upsert({
    where: { slug: "mise-demo" },
    update: {},
    create: {
      name: "Mise Demo Restaurant",
      slug: "mise-demo",
      currency: "TRY",
      timezone: "Europe/Istanbul",
      locale: "tr-TR",
      email: "info@mise.app",
      phone: "+90 212 000 0000",
    },
  });

  // ── Branch ──────────────────────────────────────────────
  const branch = await prisma.branch.upsert({
    where: { id: "branch-main" },
    update: {},
    create: {
      id: "branch-main",
      organizationId: org.id,
      name: "Main Branch",
      address: "Bağdat Caddesi No:1, Kadıköy, İstanbul",
      phone: "+90 212 000 0001",
    },
  });

  // ── Users ────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash("password123", 10);

  const adminUser = await prisma.user.upsert({
    where: { email: "admin@mise.app" },
    update: {},
    create: {
      organizationId: org.id,
      branchId: branch.id,
      email: "admin@mise.app",
      passwordHash,
      firstName: "Ali",
      lastName: "Yılmaz",
      role: UserRole.ADMIN,
      pin: "1234",
    },
  });

  await prisma.user.upsert({
    where: { email: "waiter@mise.app" },
    update: {},
    create: {
      organizationId: org.id,
      branchId: branch.id,
      email: "waiter@mise.app",
      passwordHash,
      firstName: "Mehmet",
      lastName: "Demir",
      role: UserRole.WAITER,
      pin: "5678",
    },
  });

  await prisma.user.upsert({
    where: { email: "kitchen@mise.app" },
    update: {},
    create: {
      organizationId: org.id,
      branchId: branch.id,
      email: "kitchen@mise.app",
      passwordHash,
      firstName: "Ayşe",
      lastName: "Kaya",
      role: UserRole.KITCHEN,
      pin: "9999",
    },
  });

  // ── Table Sections ───────────────────────────────────────
  const mainHall = await prisma.tableSection.create({
    data: { branchId: branch.id, name: "Main Hall", sortOrder: 1 },
  });

  const terrace = await prisma.tableSection.create({
    data: { branchId: branch.id, name: "Terrace", sortOrder: 2 },
  });

  const bar = await prisma.tableSection.create({
    data: { branchId: branch.id, name: "Bar", sortOrder: 3 },
  });

  // ── Tables ───────────────────────────────────────────────
  const tableData = [
    { name: "T1", sectionId: mainHall.id, capacity: 4, posX: 50, posY: 60 },
    { name: "T2", sectionId: mainHall.id, capacity: 4, posX: 200, posY: 60 },
    { name: "T3", sectionId: mainHall.id, capacity: 6, posX: 350, posY: 60 },
    { name: "T4", sectionId: mainHall.id, capacity: 2, posX: 50, posY: 180 },
    { name: "T5", sectionId: mainHall.id, capacity: 4, posX: 200, posY: 180 },
    { name: "T6", sectionId: mainHall.id, capacity: 4, posX: 350, posY: 180 },
    { name: "TR1", sectionId: terrace.id, capacity: 4, posX: 50, posY: 60 },
    { name: "TR2", sectionId: terrace.id, capacity: 4, posX: 200, posY: 60 },
    { name: "TR3", sectionId: terrace.id, capacity: 6, posX: 350, posY: 60 },
    { name: "B1", sectionId: bar.id, capacity: 2, posX: 50, posY: 60 },
    { name: "B2", sectionId: bar.id, capacity: 2, posX: 150, posY: 60 },
    { name: "B3", sectionId: bar.id, capacity: 2, posX: 250, posY: 60 },
  ];

  for (const t of tableData) {
    await prisma.table.create({
      data: { branchId: branch.id, ...t, status: TableStatus.AVAILABLE },
    });
  }

  // ── Menu & Categories ────────────────────────────────────
  const menu = await prisma.menu.create({
    data: { branchId: branch.id, name: "All Day Menu", isDefault: true },
  });

  const categories = [
    { name: "Hot Drinks",      color: "#8B4513", icon: "coffee",  sortOrder: 1 },
    { name: "Cold Drinks",     color: "#4169E1", icon: "cup",     sortOrder: 2 },
    { name: "Alcoholic",       color: "#722F37", icon: "glass",   sortOrder: 3 },
    { name: "Starters",        color: "#228B22", icon: "leaf",    sortOrder: 4 },
    { name: "Main Courses",    color: "#CC5500", icon: "plate",   sortOrder: 5 },
    { name: "Fish",            color: "#4682B4", icon: "fish",    sortOrder: 6 },
    { name: "Pizzas",          color: "#DC143C", icon: "pizza",   sortOrder: 7 },
    { name: "Burgers",         color: "#FF8C00", icon: "burger",  sortOrder: 8 },
    { name: "Salads",          color: "#32CD32", icon: "salad",   sortOrder: 9 },
    { name: "Desserts",        color: "#FF69B4", icon: "cake",    sortOrder: 10 },
    { name: "Breakfast",       color: "#FFD700", icon: "egg",     sortOrder: 11 },
  ];

  const catMap: Record<string, string> = {};
  for (const cat of categories) {
    const created = await prisma.category.create({
      data: { branchId: branch.id, menuId: menu.id, ...cat },
    });
    catMap[cat.name] = created.id;
  }

  // ── Modifier Groups ──────────────────────────────────────
  const cookingPref = await prisma.modifierGroup.create({
    data: {
      name: "Cooking Preference",
      minSelect: 0,
      maxSelect: 1,
      modifiers: {
        create: [
          { name: "Rare",        price: 0, sortOrder: 1 },
          { name: "Medium rare", price: 0, sortOrder: 2 },
          { name: "Medium",      price: 0, sortOrder: 3, isDefault: true },
          { name: "Well done",   price: 0, sortOrder: 4 },
        ],
      },
    },
  });

  const pizzaSize = await prisma.modifierGroup.create({
    data: {
      name: "Size",
      minSelect: 1,
      maxSelect: 1,
      isRequired: true,
      modifiers: {
        create: [
          { name: "Small (25cm)",  price: 0,     sortOrder: 1, isDefault: true },
          { name: "Medium (32cm)", price: 20,    sortOrder: 2 },
          { name: "Large (40cm)",  price: 40,    sortOrder: 3 },
        ],
      },
    },
  });

  const extras = await prisma.modifierGroup.create({
    data: {
      name: "Extras",
      minSelect: 0,
      maxSelect: 5,
      modifiers: {
        create: [
          { name: "Extra cheese",  price: 15, sortOrder: 1 },
          { name: "Extra sauce",   price: 10, sortOrder: 2 },
          { name: "Gluten-free",   price: 20, sortOrder: 3 },
        ],
      },
    },
  });

  // ── Products ─────────────────────────────────────────────
  const products = [
    // Hot Drinks
    { categoryName: "Hot Drinks", name: "Turkish Coffee",  price: 35,  cost: 8 },
    { categoryName: "Hot Drinks", name: "Filter Coffee",   price: 40,  cost: 10 },
    { categoryName: "Hot Drinks", name: "Espresso",        price: 45,  cost: 12 },
    { categoryName: "Hot Drinks", name: "Cappuccino",      price: 55,  cost: 15 },
    { categoryName: "Hot Drinks", name: "Latte",           price: 60,  cost: 16 },
    { categoryName: "Hot Drinks", name: "Tea (pot)",       price: 25,  cost: 5 },
    { categoryName: "Hot Drinks", name: "Herbal Tea",      price: 30,  cost: 6 },
    // Cold Drinks
    { categoryName: "Cold Drinks", name: "Ayran",          price: 20,  cost: 4 },
    { categoryName: "Cold Drinks", name: "Lemonade",       price: 40,  cost: 8 },
    { categoryName: "Cold Drinks", name: "Cola",           price: 30,  cost: 7 },
    { categoryName: "Cold Drinks", name: "Water (500ml)",  price: 10,  cost: 2 },
    { categoryName: "Cold Drinks", name: "Juice (fresh)",  price: 55,  cost: 15 },
    // Alcoholic
    { categoryName: "Alcoholic", name: "Efes Draught",     price: 65,  cost: 20 },
    { categoryName: "Alcoholic", name: "Wine (glass)",     price: 80,  cost: 25 },
    { categoryName: "Alcoholic", name: "Raki",             price: 90,  cost: 30 },
    // Starters
    { categoryName: "Starters", name: "Mixed Meze",        price: 120, cost: 35 },
    { categoryName: "Starters", name: "Hummus",            price: 80,  cost: 20 },
    { categoryName: "Starters", name: "Ezme",              price: 70,  cost: 18 },
    { categoryName: "Starters", name: "Soup of the Day",   price: 65,  cost: 15 },
    // Main Courses
    { categoryName: "Main Courses", name: "Adana Kebab",   price: 220, cost: 80, preparationTime: 20 },
    { categoryName: "Main Courses", name: "Urfa Kebab",    price: 220, cost: 80, preparationTime: 20 },
    { categoryName: "Main Courses", name: "Chicken Grill", price: 190, cost: 65, preparationTime: 18 },
    { categoryName: "Main Courses", name: "Lamb Chops",    price: 280, cost: 110, preparationTime: 25 },
    // Fish
    { categoryName: "Fish", name: "Sea Bass (grilled)",    price: 260, cost: 100, preparationTime: 20 },
    { categoryName: "Fish", name: "Sea Bream",             price: 240, cost: 90,  preparationTime: 20 },
    { categoryName: "Fish", name: "Salmon Fillet",         price: 280, cost: 110, preparationTime: 18 },
    // Pizzas
    { categoryName: "Pizzas", name: "Margherita",          price: 160, cost: 45, preparationTime: 15 },
    { categoryName: "Pizzas", name: "Pepperoni",           price: 180, cost: 55, preparationTime: 15 },
    { categoryName: "Pizzas", name: "Vegetarian",          price: 170, cost: 48, preparationTime: 15 },
    { categoryName: "Pizzas", name: "BBQ Chicken",         price: 190, cost: 60, preparationTime: 15 },
    // Burgers
    { categoryName: "Burgers", name: "Classic Burger",     price: 160, cost: 55, preparationTime: 12 },
    { categoryName: "Burgers", name: "Cheese Burger",      price: 175, cost: 60, preparationTime: 12 },
    { categoryName: "Burgers", name: "Veggie Burger",      price: 150, cost: 48, preparationTime: 12 },
    // Salads
    { categoryName: "Salads", name: "Caesar Salad",        price: 110, cost: 30 },
    { categoryName: "Salads", name: "Greek Salad",         price: 100, cost: 28 },
    { categoryName: "Salads", name: "Rocket & Parmesan",   price: 120, cost: 35 },
    // Desserts
    { categoryName: "Desserts", name: "Baklava",           price: 90,  cost: 25 },
    { categoryName: "Desserts", name: "Künefe",            price: 110, cost: 35 },
    { categoryName: "Desserts", name: "Cheesecake",        price: 95,  cost: 28 },
    { categoryName: "Desserts", name: "Ice Cream",         price: 70,  cost: 20 },
  ];

  for (const p of products) {
    await prisma.product.create({
      data: {
        branchId: branch.id,
        categoryId: catMap[p.categoryName],
        name: p.name,
        price: p.price,
        cost: p.cost ?? null,
        taxRate: 8,
        preparationTime: p.preparationTime ?? null,
        isAvailable: true,
      },
    });
  }

  // ── Stock Items ──────────────────────────────────────────
  const stockItems = [
    { name: "Tomato",         unit: "KG",    currentQty: 10,  minQty: 2,  cost: 8 },
    { name: "Mozzarella",     unit: "KG",    currentQty: 5,   minQty: 1,  cost: 85 },
    { name: "Chicken breast", unit: "KG",    currentQty: 8,   minQty: 2,  cost: 95 },
    { name: "Lamb",           unit: "KG",    currentQty: 5,   minQty: 1,  cost: 180 },
    { name: "Olive oil",      unit: "LITER", currentQty: 5,   minQty: 1,  cost: 120 },
    { name: "Coffee beans",   unit: "KG",    currentQty: 3,   minQty: 0.5,cost: 250 },
    { name: "Milk",           unit: "LITER", currentQty: 10,  minQty: 2,  cost: 22 },
    { name: "Flour",          unit: "KG",    currentQty: 20,  minQty: 5,  cost: 12 },
    { name: "Ayran (pack)",   unit: "PIECE", currentQty: 50,  minQty: 10, cost: 4 },
  ];

  for (const si of stockItems) {
    await prisma.stockItem.create({
      data: { branchId: branch.id, ...si as any },
    });
  }

  // ── Discount Templates ───────────────────────────────────
  await prisma.discountTemplate.createMany({
    data: [
      { name: "Happy Hour 20%", type: "PERCENTAGE", value: 20, isActive: true },
      { name: "Manager Discount 10%", type: "PERCENTAGE", value: 10, isActive: true },
      { name: "Staff Meal (50%)", type: "PERCENTAGE", value: 50, isActive: true },
      { name: "Complimentary", type: "PERCENTAGE", value: 100, isActive: true },
    ],
  });

  // ── Subscription Plan ────────────────────────────────────
  await prisma.subscriptionPlan.create({
    data: {
      organizationId: org.id,
      planName: "Pro",
      maxBranches: 5,
      maxUsers: 20,
      features: {
        kds: true,
        inventory: true,
        loyalty: true,
        onlineOrders: true,
        multiCurrency: false,
        api: false,
      },
      startsAt: new Date(),
    },
  });

  console.log("✅ Seed complete!");
  console.log(`   Org:      ${org.name}`);
  console.log(`   Branch:   ${branch.name}`);
  console.log(`   Tables:   ${tableData.length}`);
  console.log(`   Products: ${products.length}`);
  console.log(`   Users:    3 (admin / waiter / kitchen)`);
  console.log(`\n   Login: admin@mise.app / password123`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
