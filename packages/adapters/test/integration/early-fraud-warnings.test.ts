import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeDisputesRepo } from "../../src/db/prisma/disputes";
import { makeEarlyFraudWarningsRepo } from "../../src/db/prisma/early-fraud-warnings";

// ---------------------------------------------------------------------------
// Early fraud warnings adapter integration.
//
// Runs against REAL Postgres via `prisma migrate deploy`, which proves
// migration 20260902090000_early_fraud_warnings replays on a fresh database
// on top of the full history (enum + EarlyFraudWarning table + indexes + the
// Order FK). Client construction copies dispute-evidence.test.ts EXACTLY:
// the repo's Prisma client runs in driver-adapter mode, so a bare
// `new PrismaClient()` throws and the suite would silently skip.
//
// Load-bearing SQL under test:
//   * `upsertFromStripe` — idempotent on stripeEfwId; a thinner replay must
//     NOT unlink a stored order/owner, while `actionable` follows Stripe.
//   * `markResolved` — the `resolvedAt IS NULL` compare-and-set: the first
//     resolution sticks, a replay returns null.
//   * `listActionable` / `findActiveForOrder` / `findLatestForOrder` /
//     `findActiveByStripeChargeId` — the unresolved-vs-any filters and the
//     newest-first ordering.
//   * The dispute desk row join (`listForDesk` → `earlyFraudWarning`).
// ---------------------------------------------------------------------------

describe("Prisma adapters integration – early fraud warnings", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let orgId: string;
  let orderId: string;
  let otherOrderId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const buyer = await prisma.human.create({
        data: { name: "Buyer Person", status: "ACTIVE" },
      });
      const org = await prisma.organization.create({
        data: { name: "Drkmttr Collective", slug: "drkmttr" },
      });
      orgId = org.id;
      const event = await prisma.event.create({
        data: {
          title: "Rock Show",
          orgId,
          startsAt: new Date("2026-06-01T01:00:00.000Z"),
          endsAt: new Date("2026-06-01T04:00:00.000Z"),
          timezone: "America/Chicago",
        },
      });
      const order = await prisma.order.create({
        data: {
          eventId: event.id,
          buyerHumanId: buyer.id,
          amountGrossCents: 5_000,
          currency: "usd",
          status: "SUCCEEDED",
          feePolicySnapshot: {},
          stripePaymentIntentId: "pi_efw_1",
        },
      });
      orderId = order.id;
      const other = await prisma.order.create({
        data: {
          eventId: event.id,
          buyerHumanId: buyer.id,
          amountGrossCents: 2_000,
          currency: "usd",
          status: "SUCCEEDED",
          feePolicySnapshot: {},
        },
      });
      otherOrderId = other.id;
    } catch (err) {
      runtimeError = err instanceof Error ? err : new Error(String(err));
    }
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pg?.stop();
  }, 120_000);

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await prisma.earlyFraudWarning.deleteMany();
    await prisma.dispute.deleteMany();
  });

  function requireRuntime() {
    if (runtimeError) throw runtimeError;
    if (!prisma) throw new Error("prisma client not initialised");
    return prisma;
  }

  const T0 = new Date("2026-09-02T11:58:00.000Z");
  const T1 = new Date("2026-09-03T11:58:00.000Z");
  const RESOLVED_AT = new Date("2026-09-04T09:00:00.000Z");

  test("migration applied: EarlyFraudWarning table, enum, indexes and Order FK exist", async () => {
    const p = requireRuntime();
    const cols = await p.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'EarlyFraudWarning'`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        "id",
        "stripeEfwId",
        "stripeChargeId",
        "paymentIntentId",
        "orderId",
        "ownerOrgId",
        "ownerHumanId",
        "fraudType",
        "actionable",
        "stripeCreatedAt",
        "resolvedAt",
        "resolution",
        "createdAt",
        "updatedAt",
      ]),
    );
    const enumValues = await p.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'EarlyFraudWarningResolution' ORDER BY enumsortorder`,
    );
    expect(enumValues.map((e) => e.enumlabel)).toEqual([
      "REFUNDED",
      "DISPUTED",
      "IGNORED",
    ]);
    const indexes = await p.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'EarlyFraudWarning'`,
    );
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        "EarlyFraudWarning_stripeEfwId_key",
        "EarlyFraudWarning_orderId_idx",
        "EarlyFraudWarning_stripeChargeId_idx",
        "EarlyFraudWarning_actionable_resolvedAt_stripeCreatedAt_idx",
      ]),
    );
    const fks = await p.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"EarlyFraudWarning"'::regclass AND contype = 'f'`,
    );
    expect(fks.map((f) => f.conname)).toContain("EarlyFraudWarning_orderId_fkey");
  });

  test("upsertFromStripe is idempotent on stripeEfwId and a thinner replay never unlinks", async () => {
    const p = requireRuntime();
    const repo = makeEarlyFraudWarningsRepo(p);

    const first = await repo.upsertFromStripe({
      stripeEfwId: "issfr_1",
      stripeChargeId: "ch_1",
      paymentIntentId: "pi_efw_1",
      orderId,
      ownerOrgId: orgId,
      fraudType: "made_with_stolen_card",
      actionable: true,
      stripeCreatedAt: T0,
    });
    expect(first).toMatchObject({
      stripeEfwId: "issfr_1",
      orderId,
      ownerOrgId: orgId,
      ownerHumanId: null,
      actionable: true,
      resolvedAt: null,
      resolution: null,
    });

    // `.updated` replay: Stripe flips actionable; we supply no linkage.
    const second = await repo.upsertFromStripe({
      stripeEfwId: "issfr_1",
      stripeChargeId: "ch_1",
      paymentIntentId: null,
      orderId: null,
      ownerOrgId: null,
      fraudType: "made_with_stolen_card",
      actionable: false,
      stripeCreatedAt: T0,
    });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      actionable: false,
      orderId,
      ownerOrgId: orgId,
      paymentIntentId: "pi_efw_1",
    });
    expect(await p.earlyFraudWarning.count()).toBe(1);
    expect(await repo.findByStripeEfwId("issfr_1")).toEqual(second);
    expect(await repo.findByStripeEfwId("issfr_nope")).toBeNull();
  });

  test("markResolved is a compare-and-set: the first resolution sticks", async () => {
    const p = requireRuntime();
    const repo = makeEarlyFraudWarningsRepo(p);
    const row = await repo.upsertFromStripe({
      stripeEfwId: "issfr_cas",
      stripeChargeId: "ch_cas",
      orderId,
      fraudType: "misc",
      actionable: true,
      stripeCreatedAt: T0,
    });

    const disputed = await repo.markResolved({
      id: row.id,
      resolution: "DISPUTED",
      resolvedAt: RESOLVED_AT,
    });
    expect(disputed).toMatchObject({
      id: row.id,
      resolution: "DISPUTED",
      resolvedAt: RESOLVED_AT,
    });

    // The refund that lands after the dispute must not overwrite it.
    const again = await repo.markResolved({
      id: row.id,
      resolution: "REFUNDED",
      resolvedAt: new Date("2026-09-05T09:00:00.000Z"),
    });
    expect(again).toBeNull();
    expect(await repo.findByStripeEfwId("issfr_cas")).toMatchObject({
      resolution: "DISPUTED",
      resolvedAt: RESOLVED_AT,
    });
    expect(
      await repo.markResolved({ id: "nope", resolution: "IGNORED", resolvedAt: RESOLVED_AT }),
    ).toBeNull();
  });

  test("listActionable / findActiveForOrder / findLatestForOrder / findActiveByStripeChargeId filter and order as documented", async () => {
    const p = requireRuntime();
    const repo = makeEarlyFraudWarningsRepo(p);

    const older = await repo.upsertFromStripe({
      stripeEfwId: "issfr_old",
      stripeChargeId: "ch_same",
      orderId,
      fraudType: "card_never_received",
      actionable: true,
      stripeCreatedAt: T0,
    });
    const newer = await repo.upsertFromStripe({
      stripeEfwId: "issfr_new",
      stripeChargeId: "ch_same",
      orderId,
      fraudType: "unauthorized_use_of_card",
      actionable: true,
      stripeCreatedAt: T1,
    });
    const notActionable = await repo.upsertFromStripe({
      stripeEfwId: "issfr_na",
      stripeChargeId: "ch_other",
      orderId: otherOrderId,
      fraudType: "misc",
      actionable: false,
      stripeCreatedAt: T1,
    });

    // Newest first, non-actionable excluded.
    expect((await repo.listActionable()).map((r) => r.id)).toEqual([
      newer.id,
      older.id,
    ]);
    expect((await repo.listActionable({ limit: 1 })).map((r) => r.id)).toEqual([
      newer.id,
    ]);
    expect((await repo.findActiveForOrder(orderId))?.id).toBe(newer.id);
    expect((await repo.findActiveByStripeChargeId("ch_same"))?.id).toBe(newer.id);
    // Not actionable but still unresolved → still "active" for the order and
    // charge lookups (Stripe's flag and our resolution are separate facts).
    expect((await repo.findActiveForOrder(otherOrderId))?.id).toBe(notActionable.id);

    await repo.markResolved({ id: newer.id, resolution: "REFUNDED", resolvedAt: RESOLVED_AT });

    expect((await repo.listActionable()).map((r) => r.id)).toEqual([older.id]);
    expect((await repo.findActiveForOrder(orderId))?.id).toBe(older.id);
    expect((await repo.findActiveByStripeChargeId("ch_same"))?.id).toBe(older.id);
    // Latest ignores resolution: the desk wants "we were warned" regardless.
    expect((await repo.findLatestForOrder(orderId))?.id).toBe(newer.id);

    await repo.markResolved({ id: older.id, resolution: "DISPUTED", resolvedAt: RESOLVED_AT });
    expect(await repo.findActiveForOrder(orderId)).toBeNull();
    expect(await repo.findActiveByStripeChargeId("ch_same")).toBeNull();
    expect((await repo.findLatestForOrder(orderId))?.id).toBe(newer.id);
    expect(await repo.findLatestForOrder("order_unknown")).toBeNull();
  });

  test("the dispute desk row carries the linked order's newest warning", async () => {
    const p = requireRuntime();
    const efw = makeEarlyFraudWarningsRepo(p);
    const disputes = makeDisputesRepo(p);

    await efw.upsertFromStripe({
      stripeEfwId: "issfr_desk_old",
      stripeChargeId: "ch_desk",
      orderId,
      fraudType: "misc",
      actionable: false,
      stripeCreatedAt: T0,
    });
    await efw.upsertFromStripe({
      stripeEfwId: "issfr_desk_new",
      stripeChargeId: "ch_desk",
      orderId,
      fraudType: "made_with_stolen_card",
      actionable: false,
      stripeCreatedAt: T1,
    });
    const warned = await p.dispute.create({
      data: {
        stripeDisputeId: "dp_warned",
        orderId,
        ownerSubjectType: "ORGANIZATION",
        ownerSubjectId: orgId,
        ownerOrgId: orgId,
        amountCents: 5_000,
        currency: "usd",
        reason: "fraudulent",
        status: "OPEN",
      },
    });
    const unwarned = await p.dispute.create({
      data: {
        stripeDisputeId: "dp_unwarned",
        orderId: otherOrderId,
        amountCents: 2_000,
        currency: "usd",
        reason: "fraudulent",
        status: "OPEN",
      },
    });

    const page = await disputes.listForDesk({ status: "open", limit: 10 });
    const byId = new Map(page.items.map((r) => [r.id, r]));
    expect(byId.get(warned.id)?.earlyFraudWarning).toEqual({
      fraudType: "made_with_stolen_card",
      stripeCreatedAt: T1,
    });
    expect(byId.get(unwarned.id)?.earlyFraudWarning).toBeNull();
  });

  test("deleting the order nulls the link instead of cascading", async () => {
    const p = requireRuntime();
    const repo = makeEarlyFraudWarningsRepo(p);
    const buyer = await p.human.create({ data: { name: "Temp", status: "ACTIVE" } });
    const event = await p.event.findFirstOrThrow();
    const temp = await p.order.create({
      data: {
        eventId: event.id,
        buyerHumanId: buyer.id,
        amountGrossCents: 100,
        currency: "usd",
        status: "SUCCEEDED",
        feePolicySnapshot: {},
      },
    });
    const row = await repo.upsertFromStripe({
      stripeEfwId: "issfr_orphan",
      stripeChargeId: "ch_orphan",
      orderId: temp.id,
      fraudType: "misc",
      actionable: true,
      stripeCreatedAt: T0,
    });
    await p.order.delete({ where: { id: temp.id } });
    expect(await repo.findByStripeEfwId("issfr_orphan")).toMatchObject({
      id: row.id,
      orderId: null,
    });
  });
});
