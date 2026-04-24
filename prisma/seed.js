const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding Mise...');

  const org = await prisma.organization.upsert({
    where: { slug: 'mise-demo' },
    update: {},
    create: { name: 'Mise Demo Restaurant', slug: 'mise-demo', currency: 'TRY', timezone: 'Europe/Istanbul', locale: 'tr-TR' }
  });

  const branch = await prisma.branch.upsert({
    where: { id: 'branch-main' },
    update: {},
    create: { id: 'branch-main', organizationId: org.id, name: 'Main Branch', address: 'Istanbul, Turkey' }
  });

  const passwordHash = await bcrypt.hash('password123', 10);
  const pinAdmin = await bcrypt.hash('1234', 10);
  const pinWaiter = await bcrypt.hash('5678', 10);
  const pinKitchen = await bcrypt.hash('9999', 10);

  await prisma.user.upsert({
    where: { email: 'admin@mise.app' },
    update: {},
    create: { organizationId: org.id, branchId: branch.id, email: 'admin@mise.app', firstName: 'Admin', lastName: 'User', role: 'ADMIN', passwordHash, pin: pinAdmin }
  });

  await prisma.user.upsert({
    where: { email: 'waiter@mise.app' },
    update: {},
    create: { organizationId: org.id, branchId: branch.id, email: 'waiter@mise.app', firstName: 'Waiter', lastName: 'User', role: 'WAITER', passwordHash, pin: pinWaiter }
  });

  await prisma.user.upsert({
    where: { email: 'kitchen@mise.app' },
    update: {},
    create: { organizationId: org.id, branchId: branch.id, email: 'kitchen@mise.app', firstName: 'Kitchen', lastName: 'User', role: 'KITCHEN', passwordHash, pin: pinKitchen }
  });

  console.log('Done! Login: admin@mise.app / password123');
}

main().catch(console.error).finally(() => prisma.$disconnect());
