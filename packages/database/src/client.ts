import { PrismaClient } from '@prisma/client';

/**
 * Process-wide Prisma client singleton.
 *
 * In development we stash it on globalThis to survive Next/Nest hot reloads and
 * avoid exhausting the connection pool with duplicate clients.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient } from '@prisma/client';
