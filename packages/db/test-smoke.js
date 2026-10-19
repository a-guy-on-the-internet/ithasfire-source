import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

try {
  await prisma.$connect()
  console.log('Prisma client connected')
  const res = await prisma.$queryRawUnsafe(`SELECT 1 as ok`)
  console.log('Query result:', res)
} catch (e) {
  console.error('Smoke test failed:', e.message)
  process.exitCode = 2
} finally {
  await prisma.$disconnect()
}
