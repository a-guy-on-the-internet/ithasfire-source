/**
 * seed-platform-admin.ts — Create or update a platform admin account.
 *
 * Usage (against remote Neon):
 *   DATABASE_URL=<neon-url> pnpm -F api tsx src/scripts/seed-platform-admin.ts \
 *     --email admin@ithasfire.com \
 *     --password 'SomeSecurePassword!' \
 *     --name 'Platform Admin'
 *
 * Or via the root convenience script (local dev DB):
 *   pnpm seed:admin --email admin@ithasfire.com --password 'Pass!'
 *
 * Remote:
 *   pnpm seed:admin:remote --email admin@ithasfire.com --password 'Pass!'
 *
 * Flags:
 *   --email-verified   Mark the email as verified on seed (default: true).
 *                       Pass --no-email-verified to leave unverified.
 *
 * This creates (or upserts) a Human + AuthUser + AuthAccount chain with
 * platform roles ["USER", "ADMIN"], enabling full /platform staff access
 * once the email is verified.
 */

import "dotenv/config";
import { parseArgs } from "util";
import { randomUUID } from "crypto";
import { hashPassword } from "better-auth/crypto";
import { getPrisma } from "@th/db";

// ── CLI args ─────────────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    email: { type: "string" },
    password: { type: "string" },
    name: { type: "string", default: "Platform Admin" },
    roles: { type: "string", default: "USER,ADMIN" },
    "email-verified": { type: "boolean", default: true },
  },
  strict: false,
  allowPositionals: true,
});

const email = (values.email as string | undefined)?.toLowerCase();
const password = values.password as string | undefined;
const displayName = (values.name as string | undefined) ?? "Platform Admin";
const roles = ((values.roles as string | undefined) ?? "USER,ADMIN")
  .split(",")
  .map((r: string) => r.trim()) as Array<
  "USER" | "REVIEWER" | "ADMIN" | "DEVELOPER" | "SUPPORT"
>;
const emailVerified = values["email-verified"] === true;

if (!email || !password) {
  console.error(
    "Usage: pnpm seed:admin --email <email> --password <pw> [--name <name>] [--roles USER,ADMIN,SUPPORT]",
  );
  process.exit(1);
}

if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Pass it as an env var or put it in .env.local.",
  );
  process.exit(1);
}

// Safety: print the host so the operator knows which DB they're targeting.
try {
  const url = new URL(process.env.DATABASE_URL);
  console.log(`[admin-seed] Target database host: ${url.hostname}`);
} catch {
  console.log("[admin-seed] Target DATABASE_URL set (could not parse host)");
}

const prisma = getPrisma();

async function main() {
  const id = randomUUID();
  const passwordHash = await hashPassword(password!);

  console.log(`[admin-seed] Upserting platform admin: ${email}`);
  console.log(`[admin-seed] Roles: ${roles.join(", ")}`);

  // 1. Check if AuthUser already exists for this email
  const existingAuthUser = await prisma.authUser.findUnique({
    where: { email: email! },
    select: { id: true, humanId: true },
  });

  let humanId: string;
  if (existingAuthUser?.humanId) {
    // Update existing human's roles
    humanId = existingAuthUser.humanId;
    await prisma.human.update({
      where: { id: humanId },
      data: { roles, status: "ACTIVE", name: displayName },
    });
    console.log(`[admin-seed] Updated existing Human ${humanId}`);
  } else if (existingAuthUser && !existingAuthUser.humanId) {
    // AuthUser exists but no linked Human — create one and link
    humanId = id;
    await prisma.human.upsert({
      where: { id: humanId },
      update: { roles, status: "ACTIVE", name: displayName },
      create: {
        id: humanId,
        name: displayName,
        status: "ACTIVE",
        locale: "en",
        roles,
      },
    });
    await prisma.authUser.update({
      where: { id: existingAuthUser.id },
      data: { humanId },
    });
    console.log(
      `[admin-seed] Created Human ${humanId} and linked to existing AuthUser`,
    );
  } else {
    // No existing user — create everything
    humanId = id;
    await prisma.human.upsert({
      where: { id: humanId },
      update: { roles, status: "ACTIVE", name: displayName },
      create: {
        id: humanId,
        name: displayName,
        status: "ACTIVE",
        locale: "en",
        roles,
      },
    });
    console.log(`[admin-seed] Created Human ${humanId}`);
  }

  // 2. AuthUser
  const authUserId = existingAuthUser?.id ?? id;
  await prisma.authUser.upsert({
    where: { email: email! },
    update: {
      name: displayName,
      emailVerified,
      humanId,
    },
    create: {
      id: authUserId,
      email: email!,
      name: displayName,
      emailVerified,
      humanId,
    },
  });
  console.log(
    `[admin-seed] Upserted AuthUser ${authUserId} (${email}, emailVerified=${emailVerified})`,
  );

  // 3. AuthAccount (credential provider for email/password login)
  await prisma.authAccount.upsert({
    where: {
      providerId_accountId: {
        providerId: "credential",
        accountId: authUserId,
      },
    },
    update: {
      password: passwordHash,
      userId: authUserId,
    },
    create: {
      providerId: "credential",
      accountId: authUserId,
      userId: authUserId,
      password: passwordHash,
    },
  });
  console.log(`[admin-seed] Upserted credential account`);

  // 4. EntityPage (profile page)
  //
  // `slug` is GLOBALLY unique while ownership is keyed on the compound
  // `(ownerType, ownerId)` unique. A fresh admin email (e.g. after the
  // Hearthfire→Ithas Fire rebrand) yields a brand-new humanId but the same
  // derived slug, so a naive upsert keyed on `ownerType_ownerId` would try to
  // CREATE a row whose slug collides with a stale page still owned by the old
  // admin human (P2002). Reconcile both unique constraints up front so the
  // seed is fully re-runnable.
  const slug = email!.split("@")[0]!.replace(/[^a-z0-9-]/g, "-");

  const [pageBySlug, pageByOwner] = await Promise.all([
    prisma.entityPage.findUnique({ where: { slug } }),
    prisma.entityPage.findUnique({
      where: { ownerType_ownerId: { ownerType: "HUMAN", ownerId: humanId } },
    }),
  ]);

  const slugOwnedByCurrent =
    pageBySlug?.ownerType === "HUMAN" && pageBySlug?.ownerId === humanId;

  if (pageBySlug && !slugOwnedByCurrent) {
    // The target slug is held by a different (stale) owner. Reclaim it for the
    // current admin human without violating the `(ownerType, ownerId)` unique.
    if (pageByOwner && pageByOwner.id !== pageBySlug.id) {
      // The current human already has a (different-slug) page. We can't repoint
      // the stale row onto this human (compound-unique clash), so park the
      // stale row on a throwaway slug first, then move the canonical slug onto
      // the human's existing page.
      await prisma.entityPage.update({
        where: { id: pageBySlug.id },
        // Unlist the parked orphan so it isn't publicly reachable.
        data: { slug: `${slug}-stale-${pageBySlug.id}`, visibility: "UNLISTED" },
      });
      await prisma.entityPage.update({
        where: { id: pageByOwner.id },
        data: { displayName, slug, visibility: "PUBLIC" },
      });
      console.log(
        `[admin-seed] Reclaimed slug "${slug}" from stale page ${pageBySlug.id}; moved onto current page ${pageByOwner.id}`,
      );
    } else {
      // Current human has no page (or its page already is the slug row).
      // Repoint the stale row directly onto the current admin human.
      await prisma.entityPage.update({
        where: { id: pageBySlug.id },
        data: {
          ownerType: "HUMAN",
          ownerId: humanId,
          displayName,
          visibility: "PUBLIC",
        },
      });
      console.log(
        `[admin-seed] Repointed stale entity page ${pageBySlug.id} (slug: ${slug}) to current admin human ${humanId}`,
      );
    }
  } else {
    // Steady state: either no row holds the slug, or it's already ours.
    await prisma.entityPage.upsert({
      where: { ownerType_ownerId: { ownerType: "HUMAN", ownerId: humanId } },
      update: { displayName, slug },
      create: {
        ownerType: "HUMAN",
        ownerId: humanId,
        displayName,
        slug,
        visibility: "PUBLIC",
      },
    });
    console.log(`[admin-seed] Upserted entity page (slug: ${slug})`);
  }

  console.log("\n[admin-seed] Done! You can now sign in with:");
  console.log(`  Email:          ${email}`);
  console.log(`  Password:       (as provided)`);
  console.log(`  Roles:          ${roles.join(", ")}`);
  console.log(`  Email verified: ${emailVerified}`);
  if (!emailVerified) {
    console.log(
      "  Note: Pass --email-verified to skip email verification for this account.",
    );
  }
}

main()
  .catch((err) => {
    console.error("[admin-seed] Fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
