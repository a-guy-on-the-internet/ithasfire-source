/**
 * `HumansRepo.getAccountCreatedAt` against a REAL Postgres (owner ruling
 * 2026-10-07: "A new account is new the moment it gets created"). The
 * invite allowance's first-week limit reads it, so a guest checkout's
 * shadow AuthUser row must not date the account.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeHumansRepo } from "../../src/db/prisma/humans";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("Prisma adapters integration – humans.getAccountCreatedAt", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const now = new Date();
  const daysAgo = (n: number): Date => new Date(now.getTime() - n * DAY_MS);

  /** A Human + AuthUser, the AuthUser row dated `authUserCreatedAt`. */
  const newHuman = async (
    authUserCreatedAt: Date,
  ): Promise<{ humanId: string; authUserId: string }> => {
    const tag = randomUUID();
    const human = await prisma!.human.create({
      data: {
        name: `Human ${tag}`,
        status: "ACTIVE",
        authUser: {
          create: {
            name: `user-${tag}`,
            email: `user-${tag}@example.test`,
            emailVerified: false,
            createdAt: authUserCreatedAt,
          },
        },
      },
      select: { id: true, authUser: { select: { id: true } } },
    });
    return { humanId: human.id, authUserId: human.authUser!.id };
  };

  const addAccount = (
    userId: string,
    providerId: string,
    createdAt: Date,
  ): Promise<unknown> =>
    prisma!.authAccount.create({
      data: {
        userId,
        providerId,
        accountId: providerId === "credential" ? userId : randomUUID(),
        createdAt,
      },
    });

  const addSession = (userId: string, createdAt: Date): Promise<unknown> =>
    prisma!.authSession.create({
      data: {
        userId,
        token: randomUUID(),
        expiresAt: new Date(now.getTime() + 7 * DAY_MS),
        createdAt,
      },
    });

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("humans-account-created-at setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("a guest-checkout shadow row from weeks ago that signed up today dates from today", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    // ensureGuestHuman made the AuthUser 30 days ago; the person signed up
    // with a password today (credential account + first session).
    const signUp = daysAgo(0);
    const { humanId, authUserId } = await newHuman(daysAgo(30));
    await addAccount(authUserId, "credential", signUp);
    await addSession(authUserId, new Date(signUp.getTime() + 1_000));

    const at = await repo.getAccountCreatedAt(humanId);
    expect(at?.getTime()).toBe(signUp.getTime());
  });

  test("a guest who claims the shadow row with an email code dates from that first sign-in", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    // Email-code / magic-link sign-in on an existing user adds a session and
    // no AuthAccount row (better-auth 1.6.9).
    const firstSignIn = daysAgo(2);
    const { humanId, authUserId } = await newHuman(daysAgo(40));
    await addSession(authUserId, firstSignIn);
    await addSession(authUserId, daysAgo(0));

    const at = await repo.getAccountCreatedAt(humanId);
    expect(at?.getTime()).toBe(firstSignIn.getTime());
  });

  test("a normal sign-up 8 days ago is dated 8 days ago", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    const signUp = daysAgo(8);
    const { humanId, authUserId } = await newHuman(signUp);
    await addAccount(authUserId, "credential", signUp);
    // A later Google link and a fresh session never move the date forward.
    await addAccount(authUserId, "google", daysAgo(1));
    await addSession(authUserId, daysAgo(0));

    const at = await repo.getAccountCreatedAt(humanId);
    expect(at?.getTime()).toBe(signUp.getTime());
  });

  test("a passkey older than every surviving session still counts", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    const { humanId, authUserId } = await newHuman(daysAgo(20));
    const passkeyAt = daysAgo(10);
    await prisma.passkey.create({
      data: {
        userId: authUserId,
        publicKey: "pk",
        credentialID: randomUUID(),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        createdAt: passkeyAt,
      },
    });
    await addSession(authUserId, daysAgo(0));

    const at = await repo.getAccountCreatedAt(humanId);
    expect(at?.getTime()).toBe(passkeyAt.getTime());
  });

  test("a shadow row that never signed in (no account, session or passkey) is null", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    const { humanId } = await newHuman(daysAgo(30));

    expect(await repo.getAccountCreatedAt(humanId)).toBeNull();
  });

  const stamp = (authUserId: string, at: Date): Promise<unknown> =>
    prisma!.authUser.update({
      where: { id: authUserId },
      data: { firstSignedInAt: at },
    });

  test("a stamped first sign-in survives every session being deleted", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    // Passwordless ex-guest: email-code sign-in a year ago (no auth_account
    // row), then signed out everywhere. Before the stored stamp this read as
    // a brand-new account.
    const firstSignIn = daysAgo(365);
    const { humanId, authUserId } = await newHuman(daysAgo(400));
    await addSession(authUserId, firstSignIn);
    await stamp(authUserId, firstSignIn);
    await prisma.authSession.deleteMany({ where: { userId: authUserId } });

    const at = await repo.getAccountCreatedAt(humanId);
    expect(at?.getTime()).toBe(firstSignIn.getTime());
  });

  test("a stamp older than every account, session and passkey row wins", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    const firstSignIn = daysAgo(30);
    const { humanId, authUserId } = await newHuman(daysAgo(60));
    await stamp(authUserId, firstSignIn);
    await addAccount(authUserId, "credential", daysAgo(5));
    await addSession(authUserId, daysAgo(1));

    const at = await repo.getAccountCreatedAt(humanId);
    expect(at?.getTime()).toBe(firstSignIn.getTime());
  });

  test("with no stamp, an account row plus an older session: the session wins", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    const sessionAt = daysAgo(12);
    const { humanId, authUserId } = await newHuman(daysAgo(20));
    await addAccount(authUserId, "credential", daysAgo(3));
    await addSession(authUserId, sessionAt);

    const at = await repo.getAccountCreatedAt(humanId);
    expect(at?.getTime()).toBe(sessionAt.getTime());
  });

  test("the backfill migration stamps the earliest row, leaves never-signed-in users NULL, and only moves a stamp earlier", async () => {
    if (!prisma) return;
    // Re-run the migration's own backfill UPDATE (static SQL, no input)
    // against rows created after the container migrated.
    const sql = readFileSync(
      resolve(
        __dirname,
        "../../../db/prisma/migrations/20261007170100_auth_user_first_signed_in_at_backfill/migration.sql",
      ),
      "utf8",
    );
    const backfill = sql.slice(sql.indexOf('UPDATE "auth_user"'));
    expect(backfill.startsWith('UPDATE "auth_user"')).toBe(true);

    const signedIn = await newHuman(daysAgo(90));
    await addAccount(signedIn.authUserId, "credential", daysAgo(50));
    await addSession(signedIn.authUserId, daysAgo(70));
    const shadow = await newHuman(daysAgo(90));
    const alreadyStamped = await newHuman(daysAgo(90));
    await addSession(alreadyStamped.authUserId, daysAgo(10));
    await stamp(alreadyStamped.authUserId, daysAgo(80));
    // The hook stamped "deploy time" between the two migrations, but the
    // person's first session is older: the backfill moves it earlier.
    const stampedLate = await newHuman(daysAgo(90));
    await addSession(stampedLate.authUserId, daysAgo(60));
    await stamp(stampedLate.authUserId, daysAgo(0));

    await prisma.$executeRawUnsafe(backfill);

    const read = async (id: string) =>
      (
        await prisma!.authUser.findUniqueOrThrow({
          where: { id },
          select: { firstSignedInAt: true },
        })
      ).firstSignedInAt;
    expect((await read(signedIn.authUserId))?.getTime()).toBe(
      daysAgo(70).getTime(),
    );
    expect(await read(shadow.authUserId)).toBeNull();
    // An earlier existing stamp is never moved later.
    expect((await read(alreadyStamped.authUserId))?.getTime()).toBe(
      daysAgo(80).getTime(),
    );
    expect((await read(stampedLate.authUserId))?.getTime()).toBe(
      daysAgo(60).getTime(),
    );
  });

  test("stampFirstSignInIfUnset sets a null stamp", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    const { humanId, authUserId } = await newHuman(daysAgo(30));
    const t1 = daysAgo(3);

    await repo.stampFirstSignInIfUnset(authUserId, t1);

    const row = await prisma.authUser.findUniqueOrThrow({
      where: { id: authUserId },
      select: { firstSignedInAt: true },
    });
    expect(row.firstSignedInAt?.getTime()).toBe(t1.getTime());
    // No account, session or passkey rows: the stamp alone dates it.
    expect((await repo.getAccountCreatedAt(humanId))?.getTime()).toBe(
      t1.getTime(),
    );
  });

  test("stampFirstSignInIfUnset is set-once: a second call at T2 keeps T1", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    const { authUserId } = await newHuman(daysAgo(30));
    const t1 = daysAgo(3);
    const t2 = daysAgo(0);

    await repo.stampFirstSignInIfUnset(authUserId, t1);
    await repo.stampFirstSignInIfUnset(authUserId, t2);

    const row = await prisma.authUser.findUniqueOrThrow({
      where: { id: authUserId },
      select: { firstSignedInAt: true },
    });
    expect(row.firstSignedInAt?.getTime()).toBe(t1.getTime());
  });

  test("stampFirstSignInIfUnset on an unknown AuthUser is a no-op", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    await expect(
      repo.stampFirstSignInIfUnset(randomUUID(), daysAgo(0)),
    ).resolves.toBeUndefined();
  });

  test("a human with no AuthUser is null", async () => {
    if (!prisma) return;
    const repo = makeHumansRepo(prisma);
    const human = await prisma.human.create({
      data: { name: "No auth user", status: "ACTIVE" },
      select: { id: true },
    });

    expect(await repo.getAccountCreatedAt(human.id)).toBeNull();
  });
});
