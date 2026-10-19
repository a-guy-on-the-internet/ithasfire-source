/**
 * Agreement.draftEventId anchor against real Postgres
 * (booking-conversation-and-event-step FR-006).
 *
 * The unit tests in @th/core pin the contract through fakes; these run the
 * real Prisma adapter (packages/adapters/src/db/prisma/agreements.ts) plus
 * migration 20260714130000_add_agreement_draft_event so we know:
 *
 *  - `setDraftEvent` stamps the anchor on an ACCEPTED, never-finalized row,
 *  - the CAS refuses a second stamp (`agreement_status_changed`), a row whose
 *    `eventId` is already set (finalized), and a row outside `expectedFrom`,
 *  - concurrent double-stamps have exactly one winner,
 *  - the FK's ON DELETE SET NULL re-opens the anchor when the draft event is
 *    deleted, so a fresh stamp succeeds afterwards,
 *  - `updateStatus` (finalize) still works on a row carrying a draft anchor
 *    (the eventId-null fence ignores draftEventId),
 *  - `findByLinkedEventId` (the reverse lookup behind `getEventProvenance`)
 *    resolves through EITHER link column, misses cleanly on an unlinked
 *    event, and prefers the FINALIZED link when one event is both agreement
 *    A's draft anchor and agreement B's finalized event.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeAgreementsRepo } from "../../src/db/prisma/agreements";

describe("Prisma adapters integration – agreement draft-event anchor", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  beforeAll(async () => {
    try {
      pgContainer = await startPostgresContainer();
      await runPrismaMigrateDeploy(pgContainer.databaseUrl);
      process.env.DATABASE_URL = pgContainer.databaseUrl;
      pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    } catch (err) {
      runtimeError = err as Error;
      console.error("[agreement-draft-event.test] setup failed:", err);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pgContainer) await pgContainer.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await prisma.agreement.deleteMany({});
    await prisma.event.deleteMany({});
  }, 60_000);

  function requirePrisma(): PrismaClient {
    if (runtimeError) throw runtimeError;
    if (!prisma) throw new Error("prisma not initialised");
    return prisma;
  }

  async function createEvent(title: string): Promise<string> {
    const event = await requirePrisma().event.create({
      data: {
        title,
        startsAt: new Date("2026-08-01T00:00:00.000Z"),
        endsAt: new Date("2026-08-01T03:00:00.000Z"),
        status: "DRAFT",
      },
    });
    return event.id;
  }

  async function createAcceptedAgreement(): Promise<string> {
    const agreement = await requirePrisma().agreement.create({
      data: {
        type: "PERFORMANCE",
        status: "ACCEPTED",
        proposerType: "human",
        proposerId: "11111111-1111-4111-8111-111111111111",
        counterpartyType: "organization",
        counterpartyId: "22222222-2222-4222-8222-222222222222",
        title: "Booking — Integration Venue",
      },
    });
    return agreement.id;
  }

  test("stamps the anchor on an ACCEPTED row and round-trips through the record", async () => {
    const repo = makeAgreementsRepo(requirePrisma());
    const agreementId = await createAcceptedAgreement();
    const eventId = await createEvent("Draft Show");

    const updated = await repo.setDraftEvent({
      id: agreementId,
      draftEventId: eventId,
      expectedFrom: ["ACCEPTED"],
    });

    expect(updated.draftEventId).toBe(eventId);
    expect(updated.eventId).toBeNull();
    expect((await repo.getById(agreementId))?.draftEventId).toBe(eventId);
  });

  test("CAS refuses a second stamp, a finalized row, and a non-expected status", async () => {
    const repo = makeAgreementsRepo(requirePrisma());

    // Second stamp on an anchored row.
    const anchored = await createAcceptedAgreement();
    const firstEvent = await createEvent("First Draft");
    await repo.setDraftEvent({
      id: anchored,
      draftEventId: firstEvent,
      expectedFrom: ["ACCEPTED"],
    });
    await expect(
      repo.setDraftEvent({
        id: anchored,
        draftEventId: await createEvent("Second Draft"),
        expectedFrom: ["ACCEPTED"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "agreement_status_changed",
    });
    expect((await repo.getById(anchored))?.draftEventId).toBe(firstEvent);

    // Row already finalized (eventId set).
    const finalized = await createAcceptedAgreement();
    const linkedEvent = await createEvent("Linked Show");
    await repo.updateStatus({
      id: finalized,
      status: "ACCEPTED",
      expectedFrom: ["ACCEPTED"],
      eventId: linkedEvent,
    });
    await expect(
      repo.setDraftEvent({
        id: finalized,
        draftEventId: await createEvent("Late Draft"),
        expectedFrom: ["ACCEPTED"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // Status outside expectedFrom.
    const draftStatus = await requirePrisma().agreement.create({
      data: {
        type: "PERFORMANCE",
        status: "DRAFT",
        proposerType: "human",
        proposerId: "11111111-1111-4111-8111-111111111111",
        counterpartyType: "organization",
        counterpartyId: "22222222-2222-4222-8222-222222222222",
        title: "Not accepted yet",
      },
    });
    await expect(
      repo.setDraftEvent({
        id: draftStatus.id,
        draftEventId: await createEvent("Premature Draft"),
        expectedFrom: ["ACCEPTED"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("concurrent double-stamp: exactly one winner", async () => {
    const repo = makeAgreementsRepo(requirePrisma());
    const agreementId = await createAcceptedAgreement();
    const eventA = await createEvent("Race Draft A");
    const eventB = await createEvent("Race Draft B");

    const settled = await Promise.allSettled([
      repo.setDraftEvent({
        id: agreementId,
        draftEventId: eventA,
        expectedFrom: ["ACCEPTED"],
      }),
      repo.setDraftEvent({
        id: agreementId,
        draftEventId: eventB,
        expectedFrom: ["ACCEPTED"],
      }),
    ]);

    const wins = settled.filter((s) => s.status === "fulfilled");
    const losses = settled.filter((s) => s.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(
      (losses[0] as PromiseRejectedResult).reason,
    ).toMatchObject({ code: "conflict", message: "agreement_status_changed" });

    const final = await repo.getById(agreementId);
    expect([eventA, eventB]).toContain(final?.draftEventId);
  });

  test("deleting the draft event SetNulls the anchor; a fresh stamp then succeeds", async () => {
    const repo = makeAgreementsRepo(requirePrisma());
    const agreementId = await createAcceptedAgreement();
    const discarded = await createEvent("Discarded Draft");

    await repo.setDraftEvent({
      id: agreementId,
      draftEventId: discarded,
      expectedFrom: ["ACCEPTED"],
    });
    await requirePrisma().event.delete({ where: { id: discarded } });

    expect((await repo.getById(agreementId))?.draftEventId).toBeNull();

    const fresh = await createEvent("Fresh Draft");
    const updated = await repo.setDraftEvent({
      id: agreementId,
      draftEventId: fresh,
      expectedFrom: ["ACCEPTED"],
    });
    expect(updated.draftEventId).toBe(fresh);
  });

  test("finalize (updateStatus + eventId) still lands on a row carrying a draft anchor", async () => {
    const repo = makeAgreementsRepo(requirePrisma());
    const agreementId = await createAcceptedAgreement();
    const draftEvent = await createEvent("Anchored Draft");

    await repo.setDraftEvent({
      id: agreementId,
      draftEventId: draftEvent,
      expectedFrom: ["ACCEPTED"],
    });

    const finalized = await repo.updateStatus({
      id: agreementId,
      status: "ACCEPTED",
      expectedFrom: ["ACCEPTED"],
      eventId: draftEvent,
    });

    expect(finalized.eventId).toBe(draftEvent);
    expect(finalized.draftEventId).toBe(draftEvent);
  });

  test("divergent finalize (clearDraftEventId) retires the anchor in the same guarded write; the draft EVENT row survives", async () => {
    const repo = makeAgreementsRepo(requirePrisma());
    const agreementId = await createAcceptedAgreement();
    const draftEvent = await createEvent("Minted Draft");
    const handPicked = await createEvent("Hand-Picked Show");

    await repo.setDraftEvent({
      id: agreementId,
      draftEventId: draftEvent,
      expectedFrom: ["ACCEPTED"],
    });

    const finalized = await repo.updateStatus({
      id: agreementId,
      status: "ACCEPTED",
      expectedFrom: ["ACCEPTED"],
      eventId: handPicked,
      clearDraftEventId: true,
    });

    expect(finalized.eventId).toBe(handPicked);
    expect(finalized.draftEventId).toBeNull();
    // The draft EVENT row itself is untouched — it's the venue's to keep.
    expect(
      await requirePrisma().event.findUnique({ where: { id: draftEvent } }),
    ).not.toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findByLinkedEventId — the reverse lookup behind getEventProvenance
  // ───────────────────────────────────────────────────────────────────────────

  test("findByLinkedEventId resolves through BOTH link columns and misses cleanly", async () => {
    const repo = makeAgreementsRepo(requirePrisma());

    // Unlinked event → null. The common case for the provenance read: most
    // events never came from a booking.
    expect(await repo.findByLinkedEventId(await createEvent("Unbooked"))).toBeNull();

    // Draft anchor only (eventId still NULL) — the state a booked event
    // spends its whole pre-finalize life in, and the one `getByEventId` is
    // blind to.
    const draftAgreement = await createAcceptedAgreement();
    const draftEvent = await createEvent("Anchored Only");
    await repo.setDraftEvent({
      id: draftAgreement,
      draftEventId: draftEvent,
      expectedFrom: ["ACCEPTED"],
    });
    expect(await repo.getByEventId(draftEvent)).toBeNull();
    const viaDraft = await repo.findByLinkedEventId(draftEvent);
    expect(viaDraft?.id).toBe(draftAgreement);
    expect(viaDraft?.eventId).toBeNull();
    expect(viaDraft?.draftEventId).toBe(draftEvent);

    // Finalized link.
    const finalAgreement = await createAcceptedAgreement();
    const finalEvent = await createEvent("Finalized Show");
    await repo.updateStatus({
      id: finalAgreement,
      status: "ACCEPTED",
      expectedFrom: ["ACCEPTED"],
      eventId: finalEvent,
    });
    expect((await repo.findByLinkedEventId(finalEvent))?.id).toBe(
      finalAgreement,
    );
  });

  test("findByLinkedEventId prefers the FINALIZED link when one event is two agreements' anchor", async () => {
    // Reachable: agreement A stamps the event as its DRAFT anchor, then a
    // venue hand-picks that same event in agreement B's FinalizeDialog — B's
    // own `getByEventId` precheck sees nothing, because A links by
    // `draftEventId`, not `eventId`. Both columns are unique, so this is the
    // one shape where "the agreement for this event" is ambiguous, and the
    // money link has to win.
    const repo = makeAgreementsRepo(requirePrisma());
    const sharedEvent = await createEvent("Contested Show");

    const draftHolder = await createAcceptedAgreement();
    await repo.setDraftEvent({
      id: draftHolder,
      draftEventId: sharedEvent,
      expectedFrom: ["ACCEPTED"],
    });

    const finalizer = await createAcceptedAgreement();
    await repo.updateStatus({
      id: finalizer,
      status: "ACCEPTED",
      expectedFrom: ["ACCEPTED"],
      eventId: sharedEvent,
    });

    const resolved = await repo.findByLinkedEventId(sharedEvent);
    expect(resolved?.id).toBe(finalizer);
    expect(resolved?.eventId).toBe(sharedEvent);
  });
});
