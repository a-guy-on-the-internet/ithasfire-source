import type { PrismaClient, Prisma } from "@prisma/client";

export type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;
