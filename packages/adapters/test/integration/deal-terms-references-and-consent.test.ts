/**
 * The deal builder's shared-row and consent writes against REAL Postgres
 * (A1, deal-terms FR-003):
 *   - `DealsRepo.listTermsReferences` sees every kind of row that points at a
 *     terms row (the guard behind "only this owner may change it");
 *   - `DealsRepo.linkEventPrimaryTermsIfUnset` links only while unset;
 *   - `DealsRepo.answerDealClause` is a guarded write: settled-directly
 *     clauses only, PENDING only;
 *   - `clonePayoutTermsRow` resets a settled-directly clause's answer to
 *     PENDING;
 *   - creating an event from an owner's defaults (`EventsRepo.upsertDraft`)
 *     resets every answer on the copies to PENDING: a default is a template.
 *
 * Runs only with Docker (testcontainers). The canary test FAILS — it does not
 * skip — when the environment is down, so a green run that executed nothing
 * is visible.
 */
import { randomUUID } from "node:crypto";

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
import { makeEventsRepo } from "../../src/db/prisma/events";
import { clonePayoutTermsRow } from "../../src/db/prisma/payout-terms";

describe("Prisma adapters integration – deal terms references and consent", { timeout: 60_000 }, () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let orgId: string;
  let actHumanId: string;
  let venuePayee: string;
  let actPayee: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      actHumanId = (await prisma.human.create({ data: { name: "Lowlight", status: "ACTIVE" } })).id;
      orgId = (
        await prisma.organization.create({ data: { name: "Marrow Hall", slug: `marrow-${randomUUID().slice(0, 8)}` } })
      ).id;
      venuePayee = (await prisma.payee.create({ data: { subjectType: "ORGANIZATION", subjectId: orgId } })).id;
      actPayee = (await prisma.payee.create({ data: { subjectType: "HUMAN", subjectId: actHumanId } })).id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("deal-terms references integration setup failed:", error);
    }
  }, 600_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  const terms = async (isDefault = false) =>
    (await prisma!.payoutTerms.create({ data: { kind: "PRIMARY", status: "ACTIVE", isDefault } })).id;
  const event = (data: Record<string, unknown> = {}) =>
    prisma!.event.create({
      data: {
        title: "Night",
        startsAt: new Date("2026-11-01T20:00:00Z"),
        endsAt: new Date("2026-11-01T23:00:00Z"),
        status: "DRAFT",
        orgId,
        ...data,
      } as never,
    });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("listTermsReferences returns every kind of row pointing at the terms, and nothing for an unused row", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const deals = makeDealsRepo(prisma);
    const id = await terms();
    expect(await deals.listTermsReferences(id)).toEqual([]);

    const agreement = await prisma.agreement.create({
      data: {
        type: "PERFORMANCE",
        status: "DRAFT",
        proposerType: "human",
        proposerId: actHumanId,
        counterpartyType: "organization",
        counterpartyId: orgId,
        title: "Shared night",
        payoutTermsId: id,
      },
    });
    const primary = await event({ payoutTermsId: id });
    const resale = await event({ resalePayoutTermsId: id });
    const merch = await event({ merchPayoutTermsId: id });
    const org = await prisma.organization.create({
      data: { name: "Shared Org", slug: `shared-${randomUUID().slice(0, 8)}`, defaultPrimaryPayoutTermsId: id, defaultResalePayoutTermsId: id },
    });
    const human = await prisma.human.create({
      data: { name: "Shared Human", status: "ACTIVE", defaultPrimaryPayoutTermsId: id, defaultResalePayoutTermsId: id },
    });
    const place = await prisma.place.create({
      data: { name: "The Room", address: "1 Room St", status: "ACTIVE", defaultPrimaryPayoutTermsId: id, defaultResalePayoutTermsId: id },
    });
    const settlement = await prisma.settlement.create({
      data: {
        payeeId: venuePayee,
        date: new Date("2026-11-02T06:00:00Z"),
        scheduledPayoutDate: new Date("2026-11-16T06:00:00Z"),
        amountCents: 1_000,
        payoutTermsId: id,
      },
    });

    const refs = await deals.listTermsReferences(id);
    const sorted = (xs: Array<{ kind: string; id: string }>) =>
      [...xs].sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : 1));
    expect(sorted(refs)).toEqual(
      sorted([
        { kind: "AGREEMENT", id: agreement.id },
        { kind: "EVENT_PRIMARY", id: primary.id },
        { kind: "EVENT_RESALE", id: resale.id },
        { kind: "EVENT_MERCH", id: merch.id },
        { kind: "ORG_DEFAULT_PRIMARY", id: org.id },
        { kind: "ORG_DEFAULT_RESALE", id: org.id },
        { kind: "HUMAN_DEFAULT_PRIMARY", id: human.id },
        { kind: "HUMAN_DEFAULT_RESALE", id: human.id },
        { kind: "PLACE_DEFAULT_PRIMARY", id: place.id },
        { kind: "PLACE_DEFAULT_RESALE", id: place.id },
        { kind: "SETTLEMENT", id: settlement.id },
      ]),
    );
  });

  test("linkEventPrimaryTermsIfUnset links an event with no terms, and refuses one that already has them", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const deals = makeDealsRepo(prisma);
    const first = await terms();
    const second = await terms();
    const night = await event();

    expect(await deals.linkEventPrimaryTermsIfUnset({ eventId: night.id, payoutTermsId: first })).toBe(true);
    expect(await deals.linkEventPrimaryTermsIfUnset({ eventId: night.id, payoutTermsId: second })).toBe(false);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: night.id } })).payoutTermsId).toBe(first);
    expect(await deals.linkEventPrimaryTermsIfUnset({ eventId: randomUUID(), payoutTermsId: second })).toBe(false);
  });

  test("answerDealClause: a settled-directly PENDING clause moves once; per-order lines and other terms are untouched", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const deals = makeDealsRepo(prisma);
    const id = await terms();
    const other = await terms();
    const guarantee = await prisma.payoutTermsLine.create({
      data: {
        payoutTermsId: id,
        payeeId: actPayee,
        amountType: "FIXED",
        amountCents: 50_000,
        percent: null,
        requiresConfirmation: true,
        confirmationStatus: "PENDING",
      },
    });
    const perOrder = await prisma.payoutTermsLine.create({
      data: { payoutTermsId: id, payeeId: venuePayee, percent: 100, requiresConfirmation: true, confirmationStatus: "PENDING" },
    });
    const at = new Date("2026-10-13T12:00:00.000Z");
    const answer = (clauseId: string, payoutTermsId = id) =>
      deals.answerDealClause({ payoutTermsId, clauseId, expectedFrom: ["PENDING", null], confirmationStatus: "CONFIRMED", confirmedAt: at });

    // Wrong terms row: no write.
    expect(await answer(guarantee.id, other)).toBe(false);
    // A per-order line never answers here.
    expect(await answer(perOrder.id)).toBe(false);
    expect((await prisma.payoutTermsLine.findUniqueOrThrow({ where: { id: perOrder.id } })).confirmationStatus).toBe("PENDING");

    expect(await answer(guarantee.id)).toBe(true);
    expect(await prisma.payoutTermsLine.findUniqueOrThrow({ where: { id: guarantee.id } })).toMatchObject({
      confirmationStatus: "CONFIRMED",
      confirmedAt: at,
    });
    // Only PENDING moves: a second answer does not land.
    expect(
      await deals.answerDealClause({ payoutTermsId: id, clauseId: guarantee.id, expectedFrom: ["PENDING", null], confirmationStatus: "DECLINED", confirmedAt: null }),
    ).toBe(false);
    expect((await prisma.payoutTermsLine.findUniqueOrThrow({ where: { id: guarantee.id } })).confirmationStatus).toBe("CONFIRMED");
  });

  test("copying a default into an event's terms resets a settled-directly clause's answer to PENDING", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const source = await terms(true);
    const confirmedAt = new Date("2026-10-01T00:00:00.000Z");
    const clause = (status: "PENDING" | "CONFIRMED", amountCents: number) =>
      prisma!.payoutTermsLine.create({
        data: {
          payoutTermsId: source,
          payeeId: actPayee,
          amountType: "FIXED",
          amountCents,
          percent: null,
          requiresConfirmation: true,
          confirmationStatus: status,
          confirmedAt: status === "CONFIRMED" ? confirmedAt : null,
        },
      });
    await clause("CONFIRMED", 50_000);
    await clause("PENDING", 20_000);
    // A per-order line keeps today's rule (no reset without resetConfirmations).
    await prisma.payoutTermsLine.create({
      data: { payoutTermsId: source, payeeId: venuePayee, percent: 100, requiresConfirmation: true, confirmationStatus: "CONFIRMED", confirmedAt },
    });

    // The clone without `resetConfirmations` (event creation passes it —
    // see the next test).
    const copy = await clonePayoutTermsRow(prisma, { sourcePayoutTermsId: source, isDefault: false, resetFeeMode: true });
    const lines = await prisma.payoutTermsLine.findMany({ where: { payoutTermsId: copy!.id } });
    const settled = lines.filter((l) => l.amountType === "FIXED");
    expect(settled).toHaveLength(2);
    for (const l of settled) {
      expect(l).toMatchObject({ requiresConfirmation: true, confirmationStatus: "PENDING", confirmedAt: null });
    }
    expect(lines.find((l) => l.amountType === "PERCENT")).toMatchObject({ confirmationStatus: "CONFIRMED" });
    // The source template is untouched.
    const sourceLines = await prisma.payoutTermsLine.findMany({ where: { payoutTermsId: source, amountCents: 50_000 } });
    expect(sourceLines[0]).toMatchObject({ confirmationStatus: "CONFIRMED" });
  });

  test("an event created from an org's defaults gets PENDING copies of every answered per-order line; the owner's line is unchanged", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const confirmedAt = new Date("2026-10-01T00:00:00.000Z");
    const otherHumanId = (await prisma.human.create({ data: { name: "Second act", status: "ACTIVE" } })).id;
    const otherPayee = (await prisma.payee.create({ data: { subjectType: "HUMAN", subjectId: otherHumanId } })).id;

    const primary = await terms(true);
    const resale = (await prisma.payoutTerms.create({ data: { kind: "RESALE", status: "ACTIVE", isDefault: true } })).id;
    // Per-order lines answered on the template, and the owner's own line.
    await prisma.payoutTermsLine.createMany({
      data: [
        { payoutTermsId: primary, payeeId: actPayee, percent: 20, requiresConfirmation: true, confirmationStatus: "CONFIRMED", confirmedAt },
        { payoutTermsId: primary, payeeId: otherPayee, percent: 10, requiresConfirmation: true, confirmationStatus: "DECLINED" },
        { payoutTermsId: primary, payeeId: venuePayee, percent: 70, requiresConfirmation: false, confirmationStatus: null },
        { payoutTermsId: resale, payeeId: actPayee, percent: 15, requiresConfirmation: true, confirmationStatus: "CONFIRMED", confirmedAt },
        { payoutTermsId: resale, payeeId: venuePayee, percent: 85, requiresConfirmation: false, confirmationStatus: null },
      ],
    });
    const owner = await prisma.organization.create({
      data: {
        name: "Template Org",
        slug: `template-${randomUUID().slice(0, 8)}`,
        defaultPrimaryPayoutTermsId: primary,
        defaultResalePayoutTermsId: resale,
      },
    });

    const created = await makeEventsRepo(prisma).upsertDraft({
      orgId: owner.id,
      humanId: null,
      title: "Copied night",
      startsAt: new Date("2026-11-02T20:00:00Z"),
      endsAt: new Date("2026-11-02T23:00:00Z"),
      status: "DRAFT",
      location: { kind: "none" },
    });
    const row = await prisma.event.findUniqueOrThrow({
      where: { id: created.id },
      select: { payoutTermsId: true, resalePayoutTermsId: true },
    });
    expect(row.payoutTermsId).not.toBe(primary);
    expect(row.resalePayoutTermsId).not.toBe(resale);

    const byPayee = async (payoutTermsId: string | null) =>
      new Map(
        (await prisma!.payoutTermsLine.findMany({ where: { payoutTermsId: payoutTermsId! } })).map((l) => [l.payeeId, l]),
      );
    const copied = await byPayee(row.payoutTermsId);
    expect(copied.size).toBe(3);
    expect(copied.get(actPayee)).toMatchObject({ percent: 20, requiresConfirmation: true, confirmationStatus: "PENDING", confirmedAt: null });
    expect(copied.get(otherPayee)).toMatchObject({ percent: 10, requiresConfirmation: true, confirmationStatus: "PENDING", confirmedAt: null });
    expect(copied.get(venuePayee)).toMatchObject({ percent: 70, requiresConfirmation: false, confirmationStatus: null });

    const copiedResale = await byPayee(row.resalePayoutTermsId);
    expect(copiedResale.get(actPayee)).toMatchObject({ percent: 15, confirmationStatus: "PENDING", confirmedAt: null });
    expect(copiedResale.get(venuePayee)).toMatchObject({ requiresConfirmation: false, confirmationStatus: null });

    // The templates keep their rows as they were.
    const source = await byPayee(primary);
    expect(source.get(actPayee)).toMatchObject({ confirmationStatus: "CONFIRMED" });
    expect(source.get(otherPayee)).toMatchObject({ confirmationStatus: "DECLINED" });
  });
});
