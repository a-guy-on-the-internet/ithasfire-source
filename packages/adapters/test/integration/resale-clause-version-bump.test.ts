/**
 * `PayoutTermsRepo.updateDraft({ bumpVersion })` against REAL Postgres
 * (organiser-resale-share B5a): a ticket records its resale clause keyed by
 * terms id + `PayoutTerms.version`, so an in-place clause edit moves the
 * version in the SAME UPDATE as the clause columns. Also pins that the
 * shapes the clause writer stores pass `PayoutTerms_resale_share_shape_check`
 * (set PERCENT, set FLAT, cleared with payer SELLER). And that the org's
 * default template is pinned only while none is (review W3): two first saves
 * cannot both link, so the loser's row never silently replaces the winner's.
 *
 * Runs only with Docker (testcontainers). The canary FAILS, not skips, when
 * the environment is down.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeDealsRepo } from "../../src/db/prisma/deals";
import { makePayoutTermsRepo } from "../../src/db/prisma/payout-terms";

describe("Prisma adapters integration – resale clause version bump", { timeout: 60_000 }, () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

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
      console.error("resale clause version integration setup failed:", error);
    }
  }, 600_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("bumpVersion moves the version with the clause; without it the version stays", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makePayoutTermsRepo(prisma);
    const created = await repo.createDraft({ kind: "RESALE", settlementCurrency: "usd" });
    expect(created.version).toBe(1);
    expect(created.resaleShareType).toBeNull();

    const percent = await repo.updateDraft({
      payoutTermsId: created.id,
      resaleShareType: "PERCENT",
      resaleShareBps: 1000,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      bumpVersion: true,
    });
    expect(percent).toMatchObject({ version: 2, resaleShareType: "PERCENT", resaleShareBps: 1000 });

    const flat = await repo.updateDraft({
      payoutTermsId: created.id,
      resaleShareType: "FLAT",
      resaleShareBps: null,
      resaleShareCents: 500,
      resaleSharePayer: "BUYER",
      bumpVersion: true,
    });
    expect(flat).toMatchObject({ version: 3, resaleShareType: "FLAT", resaleShareCents: 500, resaleSharePayer: "BUYER" });

    const cleared = await repo.updateDraft({
      payoutTermsId: created.id,
      resaleShareType: null,
      resaleShareBps: null,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      bumpVersion: true,
    });
    expect(cleared).toMatchObject({ version: 4, resaleShareType: null, resaleShareCents: null });

    // A write that is not a clause change leaves the version alone.
    const other = await repo.updateDraft({ payoutTermsId: created.id, resalePayoutReleaseDays: 14 });
    expect(other.version).toBe(4);
    expect((await repo.getById(created.id))?.version).toBe(4);
  });

  test("linkOrgDefaultResaleTermsIfUnset links once; a second first-save loses", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const terms = makePayoutTermsRepo(prisma);
    const deals = makeDealsRepo(prisma);
    const org = await prisma.organization.create({
      data: { name: "Resale Default Org", slug: `resale-default-${Date.now()}` },
    });
    const first = await terms.createDraft({ kind: "RESALE", settlementCurrency: "usd" });
    const second = await terms.createDraft({ kind: "RESALE", settlementCurrency: "usd" });

    await expect(
      deals.linkOrgDefaultResaleTermsIfUnset({ orgId: org.id, payoutTermsId: first.id }),
    ).resolves.toBe(true);
    await expect(
      deals.linkOrgDefaultResaleTermsIfUnset({ orgId: org.id, payoutTermsId: second.id }),
    ).resolves.toBe(false);
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(after.defaultResalePayoutTermsId).toBe(first.id);
  });
});
