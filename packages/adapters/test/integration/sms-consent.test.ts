import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeSmsConsentRepo } from "../../src/db/prisma/sms-consent";

const T1 = new Date("2026-07-07T11:40:00.000Z");
const T2 = new Date("2026-07-07T11:50:00.000Z");
const T3 = new Date("2026-07-07T11:55:00.000Z");

/**
 * The ordered compare-and-set behind recordSmsOptIn / recordSmsOptOut:
 * a decision older than the row's latest one writes nothing, against a real
 * Postgres (the WHERE on optedInAt/optedOutAt is the whole guarantee).
 */
describe("Prisma adapters integration – sms consent ordering", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("sms consent setup failed:", error);
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

  test("first decision creates the row", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeSmsConsentRepo(prisma);
    const phone = "+16155550101";

    const out = await repo.applyDecisionIfNewer({
      phoneE164: phone,
      status: "OPTED_OUT",
      eventAt: T2,
      source: "sns_inbound",
      reasonKeyword: "STOP",
    });

    expect(out.applied).toBe(true);
    expect(out.record).toMatchObject({
      status: "OPTED_OUT",
      optedOutAt: T2,
      optedInAt: null,
      reasonKeyword: "STOP",
    });
  });

  test("STOP at t2, redelivered START at t1 → stays OPTED_OUT; START at t3 → OPTED_IN", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeSmsConsentRepo(prisma);
    const phone = "+16155550102";

    await repo.applyDecisionIfNewer({
      phoneE164: phone,
      status: "OPTED_OUT",
      eventAt: T2,
      source: "sns_inbound",
    });

    const stale = await repo.applyDecisionIfNewer({
      phoneE164: phone,
      status: "OPTED_IN",
      eventAt: T1,
      source: "sns_inbound",
    });
    expect(stale.applied).toBe(false);
    expect(stale.record).toMatchObject({ status: "OPTED_OUT", optedOutAt: T2 });

    const fresh = await repo.applyDecisionIfNewer({
      phoneE164: phone,
      status: "OPTED_IN",
      eventAt: T3,
      source: "sns_inbound",
    });
    expect(fresh.applied).toBe(true);
    // The opt-out time is kept for later comparisons.
    expect(fresh.record).toMatchObject({
      status: "OPTED_IN",
      optedInAt: T3,
      optedOutAt: T2,
    });
  });

  test("an opt-out older than the latest opt-in is ignored; a tie goes to the opt-out", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeSmsConsentRepo(prisma);
    const phone = "+16155550103";

    await repo.applyDecisionIfNewer({
      phoneE164: phone,
      status: "OPTED_IN",
      eventAt: T2,
      source: "volunteer_reminder_toggle",
    });

    const older = await repo.applyDecisionIfNewer({
      phoneE164: phone,
      status: "OPTED_OUT",
      eventAt: T1,
      source: "sns_inbound",
    });
    expect(older.applied).toBe(false);
    expect(older.record.status).toBe("OPTED_IN");

    const tie = await repo.applyDecisionIfNewer({
      phoneE164: phone,
      status: "OPTED_OUT",
      eventAt: T2,
      source: "sns_inbound",
    });
    expect(tie.applied).toBe(true);
    expect(tie.record.status).toBe("OPTED_OUT");

    const tieBack = await repo.applyDecisionIfNewer({
      phoneE164: phone,
      status: "OPTED_IN",
      eventAt: T2,
      source: "sns_inbound",
    });
    expect(tieBack.applied).toBe(false);
  });

  test("runs inside an interactive transaction (createMany skipDuplicates never aborts it)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const phone = "+16155550104";
    await makeSmsConsentRepo(prisma).applyDecisionIfNewer({
      phoneE164: phone,
      status: "OPTED_OUT",
      eventAt: T1,
      source: "sns_inbound",
    });

    const result = await prisma.$transaction(async (tx) => {
      const repo = makeSmsConsentRepo(tx as never);
      const out = await repo.applyDecisionIfNewer({
        phoneE164: phone,
        status: "OPTED_IN",
        eventAt: T3,
        source: "volunteer_signup",
      });
      await repo.recordEvent({
        phoneE164: phone,
        eventType: "opt_in",
        source: "volunteer_signup",
      });
      return out;
    });

    expect(result.applied).toBe(true);
    expect(
      await prisma.smsConsentEvent.count({ where: { phoneE164: phone } }),
    ).toBe(1);
  });

  // A STOP at t2 and a redelivered START at t1 racing each other, each in
  // its own transaction (as recordSmsOptOut / recordSmsOptIn run them).
  // Whatever order Postgres serialises them in, the newer STOP wins.
  const race = async (
    client: PrismaClient,
    phone: string,
  ): Promise<void> => {
    const decide = (status: "OPTED_IN" | "OPTED_OUT", eventAt: Date) =>
      client.$transaction(async (tx) =>
        makeSmsConsentRepo(tx as never).applyDecisionIfNewer({
          phoneE164: phone,
          status,
          eventAt,
          source: "sns_inbound",
        }),
      );
    await Promise.all([decide("OPTED_OUT", T2), decide("OPTED_IN", T1)]);
  };

  for (const [label, existing] of [
    ["a brand-new number", false],
    ["an existing row", true],
  ] as const) {
    test(`concurrent STOP(t2) and START(t1) on ${label} end OPTED_OUT at t2`, async ({
      skip,
    }) => {
      if (runtimeError || !prisma || !pool) {
        skip();
        return;
      }
      // Separate pool connections so the two transactions really overlap.
      const racerPool = new Pool({ connectionString: pg!.databaseUrl });
      const racer = new PrismaClient({ adapter: new PrismaPg(racerPool) });
      try {
        for (let round = 0; round < 10; round += 1) {
          const phone = `+1615555${existing ? "02" : "03"}${String(round).padStart(2, "0")}`;
          if (existing) {
            await makeSmsConsentRepo(prisma).applyDecisionIfNewer({
              phoneE164: phone,
              status: "OPTED_IN",
              eventAt: new Date(T1.getTime() - 60_000),
              source: "volunteer_signup",
            });
          }

          await race(racer, phone);

          const row = await makeSmsConsentRepo(prisma).getByPhone(phone);
          expect(row?.status).toBe("OPTED_OUT");
          expect(row?.optedOutAt).toEqual(T2);
        }
      } finally {
        await racer.$disconnect();
        await racerPool.end();
      }
    });
  }
});
