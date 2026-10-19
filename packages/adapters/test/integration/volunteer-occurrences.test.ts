/**
 * Integration coverage for the volunteer shift-occurrence + claim repo
 * surface (generic-volunteer-shifts-occurrences phase A) against real
 * Postgres. Verifies the things stubbed unit tests can't:
 *
 *  - `@@unique([occurrenceId, signupId])` really maps a race loser to the
 *    `duplicate_claim` domain code (FR-001's claim idempotency anchor),
 *  - `countActiveOccurrenceClaims` genuinely locks the occurrence row
 *    (`FOR UPDATE NOWAIT` probe asserting 55P03 while the repo holds it —
 *    same proof shape as volunteering-occupancy.test.ts),
 *  - `withdrawFutureClaimsBySignup` flips ONLY future CLAIMED claims
 *    (FR-003's signup-withdrawal cascade),
 *  - `listOccurrencesByAsk` counts CLAIMED claims only and honors the
 *    status/from filters,
 *  - the phase-B `@@unique([patternId, startsAt])` anchor exists and does
 *    NOT constrain pattern-less (one-off) rows.
 *
 * Harness: same pattern as volunteering-occupancy / event-saves — an
 * ephemeral database per suite (Testcontainers or a throwaway database on
 * a host Postgres), migrated via `prisma migrate deploy`, dropped in
 * afterAll. When no database is reachable, setup fails and every test
 * skips cleanly.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeVolunteeringRepo } from "../../src/db/prisma/volunteering";

const uniqueEmail = () => `vol-occ-${randomUUID()}@example.test`;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * `SELECT … FOR UPDATE NOWAIT` probe from a raw pg connection. Resolves to
 * "acquired" when the row lock was free, else the SQLSTATE (55P03 =
 * lock_not_available). Runs in its own implicit tx, so any lock it takes
 * releases immediately.
 */
async function probeOccurrenceLockNowait(
  pool: pg.Pool,
  id: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query(
      `SELECT id FROM "VolunteerShiftOccurrence" WHERE id = $1 FOR UPDATE NOWAIT`,
      [id],
    );
    return "acquired";
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown_error";
  } finally {
    client.release();
  }
}

describe("Prisma volunteering repo integration – shift occurrences + claims", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let poolB: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  /** Second client — the "concurrent claimer" side of the interleaving proof. */
  let prismaB: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pgContainer = await startPostgresContainer();
      await runPrismaMigrateDeploy(pgContainer.databaseUrl);
      process.env.DATABASE_URL = pgContainer.databaseUrl;

      pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      poolB = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prismaB = new PrismaClient({ adapter: new PrismaPg(poolB) });
    } catch (err) {
      runtimeError = err as Error;
      console.error("[volunteer-occurrences.test] setup failed:", err);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (prismaB) await prismaB.$disconnect();
    if (pool) await pool.end();
    if (poolB) await poolB.end();
    if (pgContainer) await pgContainer.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  /** FK chain for a STANDING ask: Organization → VolunteerAsk → ask-owned role → APPROVED signup. */
  async function seedAskRoleSignup(db: PrismaClient) {
    const tag = randomUUID().slice(0, 8);
    const org = await db.organization.create({
      data: {
        name: `Vol Occ Org ${tag}`,
        slug: `vol-occ-org-${tag}`,
        status: "ACTIVE",
      },
    });
    const ask = await db.volunteerAsk.create({
      data: {
        subjectType: "ORG",
        subjectId: org.id,
        orgId: org.id,
        title: `Standing ask ${tag}`,
        status: "OPEN",
        cadence: "RECURRING",
      },
    });
    const role = await db.eventVolunteerRole.create({
      data: { askId: ask.id, name: `Door ${tag}` },
    });
    const signup = await db.volunteerSignup.create({
      data: {
        askId: ask.id,
        roleId: role.id,
        contactEmail: uniqueEmail(),
        status: "APPROVED",
      },
    });
    return { orgId: org.id, askId: ask.id, roleId: role.id, signupId: signup.id };
  }

  test("duplicate claim on (occurrenceId, signupId) surfaces the duplicate_claim domain code", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const fx = await seedAskRoleSignup(prisma);
    const repo = makeVolunteeringRepo(prisma);
    const occurrence = await repo.createOccurrence({
      askId: fx.askId,
      roleId: fx.roleId,
      startsAt: new Date("2027-02-05T19:00:00Z"),
      endsAt: new Date("2027-02-05T23:00:00Z"),
      capacity: 2,
    });

    const first = await repo.createOccurrenceClaim({
      occurrenceId: occurrence.id,
      signupId: fx.signupId,
    });
    expect(first.status).toBe("CLAIMED");
    expect(first.source).toBe("SELF");

    await expect(
      repo.createOccurrenceClaim({
        occurrenceId: occurrence.id,
        signupId: fx.signupId,
      }),
    ).rejects.toMatchObject({ code: "duplicate_claim" });
  });

  test("countActiveOccurrenceClaims locks the occurrence row (NOWAIT probe 55P03) and counts CLAIMED only", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !pool) {
      skip();
      return;
    }
    const fx = await seedAskRoleSignup(prisma);
    const repo = makeVolunteeringRepo(prisma);
    const occurrence = await repo.createOccurrence({
      askId: fx.askId,
      roleId: fx.roleId,
      startsAt: new Date("2027-02-06T19:00:00Z"),
      endsAt: new Date("2027-02-06T23:00:00Z"),
    });

    // One CLAIMED + one WITHDRAWN claim (second signup withdrew).
    await repo.createOccurrenceClaim({
      occurrenceId: occurrence.id,
      signupId: fx.signupId,
    });
    const otherSignup = await prisma.volunteerSignup.create({
      data: {
        askId: fx.askId,
        roleId: fx.roleId,
        contactEmail: uniqueEmail(),
        status: "APPROVED",
      },
    });
    await prisma.volunteerOccurrenceClaim.create({
      data: {
        occurrenceId: occurrence.id,
        signupId: otherSignup.id,
        status: "WITHDRAWN",
      },
    });

    const holdTx = deferred();
    let probeResult: string | undefined;
    let countInsideTx: number | undefined;

    const txPromise = prisma.$transaction(async (tx) => {
      countInsideTx = await makeVolunteeringRepo(
        tx,
      ).countActiveOccurrenceClaims(occurrence.id);
      // Lock is now held until this tx commits — probe from outside.
      probeResult = await probeOccurrenceLockNowait(pool!, occurrence.id);
      holdTx.resolve();
    });

    await holdTx.promise;
    await txPromise;

    expect(countInsideTx).toBe(1); // WITHDRAWN never counts
    expect(probeResult).toBe("55P03"); // lock_not_available while held

    // After commit the row lock is free again.
    expect(await probeOccurrenceLockNowait(pool, occurrence.id)).toBe(
      "acquired",
    );
  });

  test("cancel-vs-claim interleaving fails closed: a getOccurrenceForUpdate that acquires the lock AFTER a cancel commits observes CANCELLED", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !prismaB) {
      skip();
      return;
    }
    const fx = await seedAskRoleSignup(prisma);
    const repo = makeVolunteeringRepo(prisma);
    const occurrence = await repo.createOccurrence({
      askId: fx.askId,
      roleId: fx.roleId,
      startsAt: new Date("2027-06-04T19:00:00Z"),
      endsAt: new Date("2027-06-04T23:00:00Z"),
    });

    // Tx A (canceller): lock the row, then — while a concurrent claimer's
    // getOccurrenceForUpdate is provably issued and blocked behind us —
    // flip it to CANCELLED and commit.
    const claimerStarted = deferred();
    const cancelDone = deferred();

    const claimerPromise = (async () => {
      claimerStarted.resolve();
      // Tx B (claimer): its FOR UPDATE blocks until tx A commits; the
      // post-lock re-read must then see the committed CANCELLED status —
      // the exact read claimOccurrence gates on (a stale SCHEDULED here
      // would land a claim on a cancelled occurrence and miss its cancel
      // fan-out).
      return prismaB!.$transaction(async (txB) =>
        makeVolunteeringRepo(txB).getOccurrenceForUpdate(occurrence.id),
      );
    })();

    await prisma.$transaction(async (txA) => {
      const repoA = makeVolunteeringRepo(txA);
      const locked = await repoA.getOccurrenceForUpdate(occurrence.id);
      expect(locked?.status).toBe("SCHEDULED");
      // Let the claimer issue its (now-blocking) lock acquisition, then
      // give it a beat to actually reach the FOR UPDATE statement.
      await claimerStarted.promise;
      await new Promise((r) => setTimeout(r, 150));
      await repoA.updateOccurrence(occurrence.id, { status: "CANCELLED" });
      cancelDone.resolve();
    });
    await cancelDone.promise;

    const claimerView = await claimerPromise;
    expect(claimerView?.status).toBe("CANCELLED");
  });

  test("withdrawFutureClaimsBySignup flips only FUTURE CLAIMED claims and is idempotent", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const fx = await seedAskRoleSignup(prisma);
    const repo = makeVolunteeringRepo(prisma);
    const now = new Date("2027-03-01T12:00:00Z");

    const pastOcc = await repo.createOccurrence({
      askId: fx.askId,
      roleId: fx.roleId,
      startsAt: new Date("2027-02-26T19:00:00Z"),
      endsAt: new Date("2027-02-26T23:00:00Z"),
    });
    const futureOcc = await repo.createOccurrence({
      askId: fx.askId,
      roleId: fx.roleId,
      startsAt: new Date("2027-03-05T19:00:00Z"),
      endsAt: new Date("2027-03-05T23:00:00Z"),
    });
    const futureOcc2 = await repo.createOccurrence({
      askId: fx.askId,
      roleId: fx.roleId,
      startsAt: new Date("2027-03-12T19:00:00Z"),
      endsAt: new Date("2027-03-12T23:00:00Z"),
    });

    const pastClaim = await repo.createOccurrenceClaim({
      occurrenceId: pastOcc.id,
      signupId: fx.signupId,
    });
    const futureClaim = await repo.createOccurrenceClaim({
      occurrenceId: futureOcc.id,
      signupId: fx.signupId,
    });
    // Already-withdrawn future claim — must not be re-counted.
    await prisma.volunteerOccurrenceClaim.create({
      data: {
        occurrenceId: futureOcc2.id,
        signupId: fx.signupId,
        status: "WITHDRAWN",
      },
    });

    const flipped = await repo.withdrawFutureClaimsBySignup(fx.signupId, now);
    expect(flipped).toBe(1);

    const pastAfter = await repo.getOccurrenceClaim(pastClaim.id);
    const futureAfter = await repo.getOccurrenceClaim(futureClaim.id);
    expect(pastAfter?.status).toBe("CLAIMED"); // history untouched
    expect(futureAfter?.status).toBe("WITHDRAWN");

    // Idempotent: nothing left to flip.
    expect(await repo.withdrawFutureClaimsBySignup(fx.signupId, now)).toBe(0);
  });

  test("listOccurrencesByAsk counts CLAIMED only and honors status/from filters", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const fx = await seedAskRoleSignup(prisma);
    const repo = makeVolunteeringRepo(prisma);

    const scheduled = await repo.createOccurrence({
      askId: fx.askId,
      roleId: fx.roleId,
      startsAt: new Date("2027-04-02T19:00:00Z"),
      endsAt: new Date("2027-04-02T23:00:00Z"),
      capacity: 3,
    });
    const cancelled = await repo.createOccurrence({
      askId: fx.askId,
      roleId: fx.roleId,
      startsAt: new Date("2027-04-09T19:00:00Z"),
      endsAt: new Date("2027-04-09T23:00:00Z"),
    });
    await repo.updateOccurrence(cancelled.id, { status: "CANCELLED" });

    await repo.createOccurrenceClaim({
      occurrenceId: scheduled.id,
      signupId: fx.signupId,
    });
    const otherSignup = await prisma.volunteerSignup.create({
      data: {
        askId: fx.askId,
        roleId: fx.roleId,
        contactEmail: uniqueEmail(),
        status: "APPROVED",
      },
    });
    await prisma.volunteerOccurrenceClaim.create({
      data: {
        occurrenceId: scheduled.id,
        signupId: otherSignup.id,
        status: "WITHDRAWN",
      },
    });

    const all = await repo.listOccurrencesByAsk(fx.askId);
    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe(scheduled.id); // startsAt asc
    expect(all[0]?.claimedCount).toBe(1); // WITHDRAWN excluded

    const scheduledOnly = await repo.listOccurrencesByAsk(fx.askId, {
      status: "SCHEDULED",
    });
    expect(scheduledOnly.map((o) => o.id)).toEqual([scheduled.id]);

    const fromFiltered = await repo.listOccurrencesByAsk(fx.askId, {
      from: new Date("2027-04-05T00:00:00Z"),
    });
    expect(fromFiltered.map((o) => o.id)).toEqual([cancelled.id]);
  });

  test("one-off (pattern-less) occurrences are NOT constrained by the (patternId, startsAt) unique", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const fx = await seedAskRoleSignup(prisma);
    const repo = makeVolunteeringRepo(prisma);
    const startsAt = new Date("2027-05-07T19:00:00Z");
    const endsAt = new Date("2027-05-07T23:00:00Z");

    // Two one-off rows at the SAME instant: NULL patternId rows must both
    // land (Postgres treats NULLs as distinct in the unique).
    const a = await repo.createOccurrence({
      askId: fx.askId,
      roleId: fx.roleId,
      startsAt,
      endsAt,
    });
    const b = await repo.createOccurrence({
      askId: fx.askId,
      roleId: fx.roleId,
      startsAt,
      endsAt,
    });
    expect(a.id).not.toBe(b.id);

    // While a patterned pair at the same instant conflicts — the phase-B
    // materializer's idempotency anchor is live from day one.
    const patternId = randomUUID();
    await repo.createOccurrence({
      askId: fx.askId,
      roleId: fx.roleId,
      patternId,
      startsAt,
      endsAt,
    });
    await expect(
      repo.createOccurrence({
        askId: fx.askId,
        roleId: fx.roleId,
        patternId,
        startsAt,
        endsAt,
      }),
    ).rejects.toThrow();
  });
});
