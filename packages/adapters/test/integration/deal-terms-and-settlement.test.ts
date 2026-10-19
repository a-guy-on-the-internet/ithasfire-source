/**
 * Deal terms and the settlement sheet against REAL Postgres (P4b): the
 * migration on a fresh database, its CHECKs, the FR-005 per-order fence in
 * the payout-terms adapter, the deals adapter (ordering, id-keeping replace,
 * the sheet lock, the ledger read) and the legacy-mapping read end to end
 * through the core use case.
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
import { getEventSettlement, setAgreementDeal } from "@th/core/use-cases/deals";
import { upsertBookingAgreementLine } from "@th/core/use-cases/booking-agreements";

import { createPrismaRepos } from "../../src/db/prisma";
import { makeDealsRepo } from "../../src/db/prisma/deals";
import {
  clonePayoutTermsRow,
  makePayoutTermsRepo,
} from "../../src/db/prisma/payout-terms";

const FEE_SNAPSHOT = { platformPct: 0 };

// Generous per-test timeout: these run real statements against a container
// on a shared, often loaded machine; vitest's 5s default is not a finding.
describe("Prisma adapters integration – deal terms and the settlement sheet", { timeout: 60_000 }, () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let adminId: string;
  let actHumanId: string;
  let orgId: string;
  let venuePayee: string;
  let actPayee: string;
  let supportPayee: string;
  let strangerPayee: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      adminId = (await prisma.human.create({ data: { name: "Venue Admin", status: "ACTIVE" } })).id;
      actHumanId = (await prisma.human.create({ data: { name: "Lowlight", status: "ACTIVE" } })).id;
      const support = await prisma.human.create({ data: { name: "Paper Moth", status: "ACTIVE" } });
      const stranger = await prisma.human.create({ data: { name: "Stranger", status: "ACTIVE" } });
      orgId = (await prisma.organization.create({ data: { name: "Marrow Hall", slug: `marrow-${randomUUID().slice(0, 8)}` } })).id;
      await prisma.orgMember.create({ data: { orgId, humanId: adminId, role: "ADMIN" } });
      const payee = (subjectType: "HUMAN" | "ORGANIZATION", subjectId: string) =>
        prisma!.payee.create({ data: { subjectType, subjectId } }).then((p) => p.id);
      venuePayee = await payee("ORGANIZATION", orgId);
      actPayee = await payee("HUMAN", actHumanId);
      supportPayee = await payee("HUMAN", support.id);
      strangerPayee = await payee("HUMAN", stranger.id);
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("deal-terms integration setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  const terms = async () =>
    (await prisma!.payoutTerms.create({ data: { kind: "PRIMARY", status: "ACTIVE" } })).id;

  const rejects = async (write: Promise<unknown>, constraint: string) => {
    let message = "";
    try {
      await write;
    } catch (err) {
      message = String((err as Error).message ?? err);
    }
    expect(message, constraint).toContain(constraint);
  };

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("a pre-P4b line reads back as a PERCENT line on the GROSS basis — what the engine pays today", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const termsId = await terms();
    // Exactly the columns a legacy writer sets.
    const legacy = await prisma.payoutTermsLine.create({
      data: { payoutTermsId: termsId, payeeId: venuePayee, percent: 80 },
    });
    expect(legacy).toMatchObject({ amountType: "PERCENT", basis: "GROSS", amountCents: null, resolution: null });
    const lines = await makePayoutTermsRepo(prisma).listLines(termsId);
    expect(lines).toEqual([expect.objectContaining({ id: legacy.id, percent: 80, amountType: "PERCENT", basis: "GROSS" })]);
  });

  test("the clause shape CHECK mirrors the calculator", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const termsId = await terms();
    const line = (data: Record<string, unknown>) =>
      prisma!.payoutTermsLine.create({ data: { payoutTermsId: termsId, payeeId: actPayee, ...data } as never });
    const check = "PayoutTermsLine_deal_clause_shape_check";
    await rejects(line({ amountType: "FIXED", amountCents: 100, percent: 10 }), check);
    await rejects(line({ amountType: "FIXED", amountCents: 0 }), check);
    await rejects(line({ amountType: "FIXED" }), check);
    await rejects(line({ amountType: "PERCENT", percent: 10, amountCents: 5 }), check);
    await rejects(line({ amountType: "PERCENT", percent: 101 }), check);
    await rejects(line({ amountType: "PERCENT", percent: null }), check);
    await rejects(line({ amountType: "PERCENT", percent: 10, resolution: "SUM" }), check);
    await rejects(line({ amountType: "FIXED_AND_PERCENT", amountCents: 100, percent: 10 }), check);
    await rejects(line({ amountType: "FIXED_AND_PERCENT", amountCents: 100, percent: 0, resolution: "SUM" }), check);
    // The legal shapes land.
    await line({ amountType: "FIXED", amountCents: 80_000, percent: null });
    await line({ amountType: "PERCENT", percent: 0 });
    await line({ amountType: "FIXED_AND_PERCENT", amountCents: 80_000, percent: 70, basis: "NET_POOL", resolution: "GREATER_OF" });
  });

  test("deduction and sheet CHECKs", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const termsId = await terms();
    const deduction = (data: Record<string, unknown>, sortOrder: number) =>
      prisma!.payoutTermsDeduction.create({
        data: { payoutTermsId: termsId, kind: "EXPENSE", label: "Sound", creditedPayeeId: venuePayee, sortOrder, ...data } as never,
      });
    const amountOrPercent = "PayoutTermsDeduction_amount_or_percent_check";
    await rejects(deduction({ amountCents: 1, percent: 1 }, 0), amountOrPercent);
    await rejects(deduction({}, 0), amountOrPercent);
    await rejects(deduction({ percent: 101 }, 0), amountOrPercent);
    await rejects(deduction({ amountCents: -1 }, 0), amountOrPercent);
    await rejects(deduction({ amountCents: 1, label: "" }, 0), amountOrPercent);
    await deduction({ amountCents: 30_000 }, 0);
    await rejects(deduction({ percent: 5 }, 0), "Unique constraint");

    const event = await prisma.event.create({
      data: { title: "Checks", startsAt: new Date("2026-09-01T20:00:00Z"), endsAt: new Date("2026-09-01T23:00:00Z"), status: "PUBLISHED", orgId },
    });
    await rejects(
      prisma.settlementSheet.create({ data: { eventId: event.id, status: "SETTLED", settledAt: new Date() } }),
      "SettlementSheet_settled_shape_check",
    );
    await rejects(
      prisma.settlementSheet.create({ data: { eventId: event.id, status: "DRAFT", settledByHumanId: adminId } }),
      "SettlementSheet_settled_shape_check",
    );
    const sheet = await prisma.settlementSheet.create({ data: { eventId: event.id } });
    const entered = { enteredByHumanId: adminId, enteredAt: new Date() };
    await rejects(
      prisma.settlementSheetOffPlatformAmount.create({
        data: { sheetId: sheet.id, kind: "DOOR_CASH", label: "Door", amountCents: -1, heldByPayeeId: venuePayee, ...entered },
      }),
      "SettlementSheetOffPlatformAmount_amount_check",
    );
    await rejects(
      prisma.settlementSheetDirectPayment.create({
        data: { sheetId: sheet.id, fromPayeeId: venuePayee, toPayeeId: venuePayee, amountCents: 1, label: "x", ...entered },
      }),
      "SettlementSheetDirectPayment_shape_check",
    );
    await rejects(
      prisma.settlementSheetDirectPayment.create({
        data: { sheetId: sheet.id, fromPayeeId: venuePayee, toPayeeId: actPayee, amountCents: 0, label: "x", ...entered },
      }),
      "SettlementSheetDirectPayment_shape_check",
    );
  });

  test("FR-005 fence: the payout-line reads and the legacy rewrite never see a clause settled directly", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const termsId = await terms();
    const deals = makeDealsRepo(prisma);
    const lines = makePayoutTermsRepo(prisma);
    const base = {
      ticketTypeId: null, floorCents: 0, capPercent: null, priority: 0, rounding: "FLOOR" as const,
      requiresConfirmation: false, confirmationStatus: null, confirmedAt: null, counterPercentBps: null,
      counterNote: null, displayLabel: null,
    };
    const fixedId = randomUUID();
    const netPoolId = randomUUID();
    const versusId = randomUUID();
    await deals.replaceTermsDeal({
      payoutTermsId: termsId,
      remainderPayeeId: venuePayee,
      clauses: [
        { ...base, id: fixedId, payeeId: actPayee, amountType: "FIXED", amountCents: 80_000, percent: null, basis: "GROSS", resolution: null },
        { ...base, id: netPoolId, payeeId: supportPayee, amountType: "PERCENT", amountCents: null, percent: 10, basis: "NET_POOL", resolution: null },
        { ...base, id: versusId, payeeId: actPayee, amountType: "FIXED_AND_PERCENT", amountCents: 1, percent: 5, basis: "NET_POOL", resolution: "GREATER_OF" },
        { ...base, id: randomUUID(), payeeId: venuePayee, amountType: "PERCENT", amountCents: null, percent: 100, basis: "GROSS", resolution: null },
      ],
      deductions: [{ id: randomUUID(), kind: "RENTAL", label: "Room", amountCents: 10_000, percent: null, creditedPayeeId: venuePayee, estimated: false }],
    });

    const payout = await lines.listLines(termsId);
    expect(payout.map((l) => [l.payeeId, l.percent])).toEqual([[venuePayee, 100]]);
    expect((await lines.listLines(termsId)).map((l) => l.payeeId)).toEqual([venuePayee]);
    for (const id of [fixedId, netPoolId, versusId]) expect(await lines.getLineById(id)).toBeNull();

    // A legacy editor's delete-and-recreate touches the payout lines only.
    await lines.replaceLines(termsId, [
      { payeeId: venuePayee, percent: 90, floorCents: 0, priority: 0, rounding: "FLOOR" },
      { payeeId: supportPayee, percent: 10, floorCents: 0, priority: 0, rounding: "FLOOR" },
    ]);
    const deal = await deals.getTermsDeal(termsId);
    expect(deal?.clauses.map((c) => c.id)).toEqual(expect.arrayContaining([fixedId, netPoolId, versusId]));
    expect(deal?.deductions.length).toBe(1);
    expect(deal?.remainderPayeeId).toBe(venuePayee);
    expect((await lines.listLines(termsId)).map((l) => l.percent).sort()).toEqual([10, 90]);
  });

  test("replaceTermsDeal keeps ids, reorders the waterfall, and the clone carries the whole deal", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const termsId = await terms();
    const deals = makeDealsRepo(prisma);
    const d = (id: string, label: string) => ({
      id, kind: "EXPENSE" as const, label, amountCents: 100, percent: null, creditedPayeeId: venuePayee, estimated: true,
    });
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const clause = {
      id: randomUUID(), payeeId: actPayee, amountType: "FIXED" as const, amountCents: 50_000, percent: null,
      basis: "GROSS" as const, resolution: null, displayLabel: "Headline fee", ticketTypeId: null, floorCents: 0,
      capPercent: null, priority: 0, rounding: "FLOOR" as const, requiresConfirmation: false,
      confirmationStatus: null, confirmedAt: null, counterPercentBps: null, counterNote: null,
    };
    await deals.replaceTermsDeal({ payoutTermsId: termsId, remainderPayeeId: venuePayee, clauses: [clause], deductions: [d(a, "A"), d(b, "B"), d(c, "C")] });
    // Swap order and drop one: the unique (terms, sortOrder) must not trip.
    await deals.replaceTermsDeal({ payoutTermsId: termsId, remainderPayeeId: venuePayee, clauses: [{ ...clause, amountCents: 60_000 }], deductions: [d(c, "C"), d(a, "A2")] });
    const deal = await deals.getTermsDeal(termsId);
    expect(deal?.deductions.map((x) => [x.id, x.label, x.sortOrder])).toEqual([
      [c, "C", 0],
      [a, "A2", 1],
    ]);
    expect(deal?.clauses).toEqual([expect.objectContaining({ id: clause.id, amountCents: 60_000, displayLabel: "Headline fee" })]);

    const clone = await clonePayoutTermsRow(prisma, { sourcePayoutTermsId: termsId, isDefault: false, resetFeeMode: true });
    const cloned = await deals.getTermsDeal(clone!.id);
    expect(cloned?.remainderPayeeId).toBe(venuePayee);
    expect(cloned?.clauses.map((x) => [x.amountType, x.amountCents, x.displayLabel])).toEqual([["FIXED", 60_000, "Headline fee"]]);
    expect(cloned?.deductions.map((x) => [x.label, x.sortOrder])).toEqual([
      ["C", 0],
      ["A2", 1],
    ]);
  });

  test("the sheet: one per event, the DRAFT lock, settle, reopen, rows scoped to their sheet", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const deals = makeDealsRepo(prisma);
    const event = await prisma.event.create({
      data: { title: "Sheet", startsAt: new Date("2026-09-01T20:00:00Z"), endsAt: new Date("2026-09-01T23:00:00Z"), status: "PUBLISHED", orgId },
    });
    const other = await prisma.event.create({
      data: { title: "Other", startsAt: new Date("2026-09-01T20:00:00Z"), endsAt: new Date("2026-09-01T23:00:00Z"), status: "PUBLISHED", orgId },
    });
    const first = await deals.ensureSheet(event.id);
    expect(await deals.ensureSheet(event.id)).toEqual(first);
    const otherSheet = await deals.ensureSheet(other.id);
    expect(await deals.lockDraftSheet(first.id)).toBe(true);

    const row = await deals.upsertOffPlatform({
      sheetId: first.id, kind: "DOOR_CASH", label: "Door cash", amountCents: null,
      heldByPayeeId: venuePayee, ownerPayeeId: null, enteredByHumanId: adminId, enteredAt: new Date(),
    });
    expect(row?.amountCents).toBeNull();
    // A row id from another sheet is never updated or deleted through this one.
    expect(await deals.upsertOffPlatform({ ...row!, sheetId: otherSheet.id, amountCents: 5 })).toBeNull();
    expect(await deals.deleteOffPlatform(otherSheet.id, row!.id)).toBe(false);

    expect(
      await deals.markSheetSettled({ sheetId: first.id, settledByHumanId: adminId, settledAt: new Date(), engineVersion: 4, snapshot: { frozen: true } }),
    ).toBe(true);
    expect(await deals.lockDraftSheet(first.id)).toBe(false);
    expect(await deals.markSheetSettled({ sheetId: first.id, settledByHumanId: adminId, settledAt: new Date(), engineVersion: 4, snapshot: {} })).toBe(false);
    const settled = await deals.getSheetByEventId(event.id);
    expect(settled).toMatchObject({ status: "SETTLED", engineVersion: 4, snapshot: { frozen: true } });
    expect(settled?.offPlatform.map((o) => o.id)).toEqual([row!.id]);

    expect(await deals.lockSettledSheet(first.id)).toBe(true);
    expect(await deals.reopenSheet({ sheetId: first.id, reopenedByHumanId: adminId, reopenedAt: new Date() })).toBe(true);
    expect(await deals.getSheetByEventId(event.id)).toMatchObject({ status: "DRAFT", snapshot: null, settledAt: null, reopenedByHumanId: adminId });
  });

  test("the ledger read: PRIMARY ticketing orders the engine credited; resale and comps never; refunds counted once", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const deals = makeDealsRepo(prisma);
    const event = await prisma.event.create({
      data: { title: "Ledger", startsAt: new Date("2026-09-01T20:00:00Z"), endsAt: new Date("2026-09-01T23:00:00Z"), status: "PUBLISHED", orgId },
    });
    // A sale since the 2026-10-11 ruling carries the credit rule on its
    // snapshot; `computeAgreementBasis` reads it per order, so the ledger read
    // must hand each order's snapshot back as stored.
    const FULL_PRICE_SNAPSHOT = { ...FEE_SNAPSHOT, organiserCredit: "FULL_PRICE" };
    const order = (data: { source?: string; status?: string; gross: number; fee: number; snapshot?: object }) =>
      prisma!.order.create({
        data: {
          eventId: event.id, buyerHumanId: adminId, amountGrossCents: data.gross, feesPlatformCents: data.fee,
          status: (data.status ?? "SUCCEEDED") as never, source: (data.source ?? "PRIMARY") as never, kind: "TICKETING",
          feePolicySnapshot: data.snapshot ?? FEE_SNAPSHOT,
        },
      });
    const entry = (orderId: string, payeeId: string, type: string, amountCents: number, sourceId = orderId) =>
      prisma!.payeeLedgerEntry.create({
        data: {
          idempotencyKey: randomUUID(), payeeId, type: type as never, amountCents, currency: "usd",
          sourceKind: type === "SETTLEMENT_CREDIT" ? "order_split" : "order_refund", sourceId, orderId,
          description: "test", availableAt: type === "SETTLEMENT_CREDIT" ? new Date() : null,
        },
      });
    const o1 = await order({ gross: 10_500, fee: 500 });
    const o2 = await order({ gross: 5_250, fee: 250, status: "PART_REFUNDED" });
    const resale = await order({ gross: 9_999, fee: 0, source: "RESALE" });
    const uncredited = await order({ gross: 2_000, fee: 100, snapshot: FULL_PRICE_SNAPSHOT });
    await entry(o1.id, venuePayee, "SETTLEMENT_CREDIT", 8_000);
    await entry(o1.id, actPayee, "SETTLEMENT_CREDIT", 2_000);
    await entry(o2.id, venuePayee, "SETTLEMENT_CREDIT", 4_000);
    await entry(o2.id, actPayee, "SETTLEMENT_CREDIT", 1_000);
    // One refund on o2, debited to both payees (one refund, two entries).
    await entry(o2.id, venuePayee, "REFUND_DEBIT", 400, "re_1");
    await entry(o2.id, actPayee, "REFUND_DEBIT", 100, "re_1");
    // A resale order's seller credit is outside the sheet by construction.
    await entry(resale.id, strangerPayee, "SETTLEMENT_CREDIT", 9_999);

    const ledger = await deals.readEventTicketLedger(event.id);
    expect(ledger.orders.map((o) => [o.orderId, o.credited]).sort()).toEqual(
      [
        [o1.id, true],
        [o2.id, true],
        [uncredited.id, false],
      ].sort(),
    );
    const snapshotOf = (id: string) => ledger.orders.find((o) => o.orderId === id)?.feePolicySnapshot;
    expect(snapshotOf(uncredited.id)).toEqual(FULL_PRICE_SNAPSHOT);
    expect(snapshotOf(o1.id)).toEqual(FEE_SNAPSHOT);
    expect(snapshotOf(o1.id)).not.toHaveProperty("organiserCredit");
    expect(ledger.refundCount).toBe(1);
    expect(ledger.perPayee).toEqual(
      expect.arrayContaining([
        { payeeId: venuePayee, creditCents: 12_000, refundDebitCents: 400 },
        { payeeId: actPayee, creditCents: 3_000, refundDebitCents: 100 },
      ]),
    );
    expect(ledger.perPayee.some((p) => p.payeeId === strangerPayee)).toBe(false);
    expect(ledger.currencies).toEqual(["usd"]);
  });

  test("B1: concurrent deal writes on one agreement serialize — exactly one set of clauses, per-order lines at 100%", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const termsId = await terms();
    // A booking clone's legacy lines: act 20%, venue 80%.
    await prisma.payoutTermsLine.createMany({
      data: [
        { payoutTermsId: termsId, payeeId: actPayee, percent: 20 },
        { payoutTermsId: termsId, payeeId: venuePayee, percent: 80 },
      ],
    });
    const agreement = await prisma.agreement.create({
      data: {
        type: "PERFORMANCE",
        status: "DRAFT",
        proposerType: "human",
        proposerId: actHumanId,
        counterpartyType: "organization",
        counterpartyId: orgId,
        title: "Concurrency night",
        payoutTermsId: termsId,
      },
    });
    const support = await prisma.payee.findUniqueOrThrow({ where: { id: supportPayee } });
    const deal = {
      source: "PRESET",
      preset: { preset: "VERSUS", act: { kind: "human", id: actHumanId }, guaranteeCents: 80_000, percent: 70 },
      remainder: { kind: "org", id: orgId },
      extraClauses: [
        { payee: { kind: "human", id: support.subjectId }, amountType: "PERCENT", percent: 10, basis: "GROSS" },
      ],
      deductions: [
        { kind: "EXPENSE", label: "Sound", amountCents: 30_000, creditedPayee: { kind: "org", id: orgId }, estimated: true },
      ],
    };
    const write = () =>
      setAgreementDeal(
        { repos: createPrismaRepos(prisma!), clock: { now: () => new Date() } },
        { actorHumanId: adminId, agreementId: agreement.id, deal },
      );
    // A double-click, and then some: six writes at once.
    const results = await Promise.allSettled(Array.from({ length: 6 }, write));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);

    const lines = await prisma.payoutTermsLine.findMany({ where: { payoutTermsId: termsId } });
    const versus = lines.filter((l) => l.amountType === "FIXED_AND_PERCENT");
    const perOrder = lines.filter((l) => l.amountType === "PERCENT" && l.basis === "GROSS");
    expect(versus.length).toBe(1);
    expect(perOrder.map((l) => [l.payeeId, l.percent]).sort()).toEqual(
      [
        [supportPayee, 10],
        [venuePayee, 90],
      ].sort(),
    );
    expect(perOrder.reduce((s2, l) => s2 + (l.percent ?? 0), 0)).toBe(100);
    expect(await prisma.payoutTermsDeduction.count({ where: { payoutTermsId: termsId } })).toBe(1);
  }, 120_000);

  test("B1 (round 2): a legacy line edit racing a deal write leaves ONE coherent version, in either start order", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const support = await prisma.payee.findUniqueOrThrow({ where: { id: supportPayee } });
    const outcomes: string[] = [];
    for (const order of [["deal", "upsert"], ["upsert", "deal"]] as const) {
      for (let round = 0; round < 2; round += 1) {
        const termsId = await terms();
        // Legacy terms: act 20%, venue 80%.
        const actLine = await prisma.payoutTermsLine.create({ data: { payoutTermsId: termsId, payeeId: actPayee, percent: 20 } });
        await prisma.payoutTermsLine.create({ data: { payoutTermsId: termsId, payeeId: venuePayee, percent: 80 } });
        const agreement = await prisma.agreement.create({
          data: {
            type: "PERFORMANCE",
            status: "DRAFT",
            proposerType: "human",
            proposerId: actHumanId,
            counterpartyType: "organization",
            counterpartyId: orgId,
            title: `Race ${order.join("-")} ${round}`,
            payoutTermsId: termsId,
          },
        });
        const deps = { repos: createPrismaRepos(prisma), clock: { now: () => new Date() } };
        // The legacy editor reads the lines, then dawdles before writing —
        // the window in which an unlocked writer would lose the deal write
        // committed meanwhile. With the terms row lock the dawdle happens
        // INSIDE the lock, so the two can only run one after the other.
        const base = createPrismaRepos(prisma);
        const slowEditorRepos = {
          ...base,
          tx: ((fn: (t: unknown) => Promise<unknown>, options?: unknown) =>
            base.tx(
              (t) =>
                fn({
                  ...t,
                  payoutTerms: {
                    ...t.payoutTerms,
                    listLines: async (id: string) => {
                      const read = await t.payoutTerms.listLines(id);
                      await new Promise((resolve) => setTimeout(resolve, 2_500));
                      return read;
                    },
                  },
                }),
              options as never,
            )) as typeof base.tx,
        };
        const run = {
          // T1: the act gets a versus, the support act 10% per order, the venue the rest (90).
          deal: () =>
            setAgreementDeal(deps, {
              actorHumanId: adminId,
              agreementId: agreement.id,
              deal: {
                source: "PRESET",
                preset: { preset: "VERSUS", act: { kind: "human", id: actHumanId }, guaranteeCents: 80_000, percent: 70 },
                remainder: { kind: "org", id: orgId },
                extraClauses: [
                  { payee: { kind: "human", id: support.subjectId }, amountType: "PERCENT", percent: 10, basis: "GROSS" },
                ],
                deductions: [],
              },
            }),
          // T2: the legacy editor moves the act's per-order line to 10%.
          upsert: () =>
            upsertBookingAgreementLine({ ...deps, repos: slowEditorRepos }, {
              actorHumanId: adminId,
              agreementId: agreement.id,
              lineId: actLine.id,
              payeeRef: { kind: "human", id: actHumanId },
              percent: 10,
            }),
        };
        const [first, second] = order;
        const firstRun = run[first]();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const settled = await Promise.allSettled([firstRun, run[second]()]);
        const byName = Object.fromEntries(order.map((name, i) => [name, settled[i]!]));
        expect(byName.deal!.status, `${order} ${round}: the deal write always lands`).toBe("fulfilled");

        // The ONE coherent version: the deal's. The act has its versus and no
        // per-order line; per order the support act 10%, the venue 90%.
        const lines = await prisma.payoutTermsLine.findMany({ where: { payoutTermsId: termsId } });
        const ctx = `${order.join(" then ")}, round ${round}, upsert ${byName.upsert!.status}`;
        expect(lines.filter((l) => l.amountType === "FIXED_AND_PERCENT").map((l) => l.payeeId), ctx).toEqual([actPayee]);
        expect(
          lines.filter((l) => l.amountType === "PERCENT" && l.basis === "GROSS").map((l) => [l.payeeId, l.percent]).sort(),
          ctx,
        ).toEqual(
          [
            [supportPayee, 10],
            [venuePayee, 90],
          ].sort(),
        );
        outcomes.push(`${order[0]}-first:upsert-${byName.upsert!.status}`);
      }
    }
    // The bug-catching interleaving must actually have run: an upsert that
    // started first took the lock, committed its line, and was then replaced
    // by the deal. Without this, a slow pre-tx read could hand the lock to the
    // deal in both orders and the test would pass with the lock removed.
    expect(outcomes, "the upsert-first interleaving ran with the upsert landing first").toContain(
      "upsert-first:upsert-fulfilled",
    );
  }, 300_000);

  test("legacy terms, end to end: the derived remainder is the organiser, and the sheet settles at $0.00", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const termsId = await terms();
    await prisma.payoutTermsLine.createMany({
      data: [
        { payoutTermsId: termsId, payeeId: actPayee, percent: 20 },
        { payoutTermsId: termsId, payeeId: venuePayee, percent: 80 },
      ],
    });
    const event = await prisma.event.create({
      data: {
        title: "Legacy night", startsAt: new Date("2026-09-01T20:00:00Z"), endsAt: new Date("2026-09-01T23:00:00Z"),
        status: "PUBLISHED", orgId, payoutTermsId: termsId,
      },
    });
    const o = await prisma.order.create({
      data: { eventId: event.id, buyerHumanId: adminId, amountGrossCents: 10_499, feesPlatformCents: 500, status: "SUCCEEDED", feePolicySnapshot: FEE_SNAPSHOT },
    });
    // What computeOrderSplits paid on a 9,999¢ basis: 1,999 + 7,999 + the
    // dropped cent to the first line.
    for (const [payeeId, amountCents] of [[actPayee, 2_000], [venuePayee, 7_999]] as const) {
      await prisma.payeeLedgerEntry.create({
        data: {
          idempotencyKey: randomUUID(), payeeId, type: "SETTLEMENT_CREDIT", amountCents, currency: "usd",
          sourceKind: "order_split", sourceId: o.id, orderId: o.id, description: "credit", availableAt: new Date(),
        },
      });
    }

    const out = await getEventSettlement(
      { repos: createPrismaRepos(prisma), clock: { now: () => new Date("2026-09-02T12:00:00Z") } },
      { actorHumanId: adminId, eventId: event.id },
    );
    expect(out.remainder).toEqual({ payeeId: venuePayee, source: "LEGACY_EVENT_ORGANISER" });
    expect(out.sheet.visibility).toBe("FULL");
    if (out.sheet.visibility !== "FULL") return;
    expect(out.sheet.result.waterfall.grossCents).toBe(9_999);
    expect(out.sheet.result.shortfall).toBeNull();
    expect(out.sheet.result.payees.map((p) => [p.payeeId, p.settleDirectlyCents]).sort()).toEqual(
      [
        [actPayee, 0],
        [venuePayee, 0],
      ].sort(),
    );
    // The read derived the remainder; it never wrote one.
    expect((await prisma.payoutTerms.findUnique({ where: { id: termsId } }))?.remainderPayeeId).toBeNull();
  }, 60_000);
});
