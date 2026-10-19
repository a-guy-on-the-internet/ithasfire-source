/**
 * Backfill script: Ensure every Human has a linked AuthUser
 *
 * This migration moves identity data (email, phone, verified flags) from Human to AuthUser.
 * This script:
 * 1. Finds Humans without linked AuthUsers
 * 2. Creates AuthUsers for them with identity data from Human
 * 3. Links the AuthUser to the Human
 *
 * Run: DATABASE_URL="postgresql://..." npx tsx scripts/backfill-human-to-auth-user.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting Human → AuthUser backfill...\n");

  // Find all Humans without linked AuthUsers
  const humansWithoutAuthUser = await prisma.$queryRaw<
    Array<{
      id: string;
      email: string | null;
      phone: string | null;
      emailVerified: boolean;
      phoneVerified: boolean;
      name: string | null;
    }>
  >`
    SELECT h.id, h.email, h.phone, h."emailVerified", h."phoneVerified", h.name
    FROM "Human" h
    LEFT JOIN auth_user au ON au.human_id = h.id
    WHERE au.id IS NULL
  `;

  console.log(
    `Found ${humansWithoutAuthUser.length} Humans without AuthUser links\n`,
  );

  if (humansWithoutAuthUser.length === 0) {
    console.log("Nothing to backfill!");
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const human of humansWithoutAuthUser) {
    if (!human.email) {
      console.log(
        `  SKIP: Human ${human.id} has no email, cannot create AuthUser`,
      );
      skipped++;
      continue;
    }

    // Check if an AuthUser with this email already exists (might not be linked)
    const existingAuthUser = await prisma.authUser.findUnique({
      where: { email: human.email },
    });

    if (existingAuthUser) {
      // Link existing AuthUser to Human
      if (!existingAuthUser.humanId) {
        await prisma.authUser.update({
          where: { id: existingAuthUser.id },
          data: { humanId: human.id },
        });
        console.log(
          `  LINKED: AuthUser ${existingAuthUser.id} → Human ${human.id} (${human.email})`,
        );
        created++;
      } else {
        console.log(
          `  SKIP: AuthUser ${existingAuthUser.id} already linked to Human ${existingAuthUser.humanId}`,
        );
        skipped++;
      }
    } else {
      // Create new AuthUser
      const now = new Date();
      await prisma.authUser.create({
        data: {
          id: human.id, // Use same ID for simplicity
          email: human.email,
          emailVerified: human.emailVerified,
          phoneNumber: human.phone,
          phoneNumberVerified: human.phoneVerified,
          name: human.name,
          humanId: human.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      console.log(
        `  CREATED: AuthUser ${human.id} for Human ${human.id} (${human.email})`,
      );
      created++;
    }
  }

  console.log(
    `\nBackfill complete: ${created} created/linked, ${skipped} skipped`,
  );

  // Verify all Humans now have AuthUsers
  const remaining = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count
    FROM "Human" h
    LEFT JOIN auth_user au ON au.human_id = h.id
    WHERE au.id IS NULL AND h.email IS NOT NULL
  `;

  const remainingCount = Number(remaining[0]?.count ?? 0);
  if (remainingCount > 0) {
    console.log(
      `\nWARNING: ${remainingCount} Humans with email still lack AuthUser links!`,
    );
  } else {
    console.log("\n✓ All Humans with email now have linked AuthUsers");
  }
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
