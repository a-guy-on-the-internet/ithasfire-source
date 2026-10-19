/**
 * Open calls v1 step 6 — DECIDING against a REAL Postgres: the pick
 * transaction (status flip + lineup rows at the end, a series night
 * materialised through the real `generateEventsFromSeries`), a concurrent
 * double pick serialised on the submission row lock (one wins, no duplicate
 * rows), pick vs withdraw, the drop-out transaction, and the lineup-removal
 * stamp. A mocked Prisma can prove none of the locking.
 */
import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { pickOpenCallApplication } from "@th/core/use-cases/events/open-calls/pick-open-call-application";
import { dropOutOfOpenCall } from "@th/core/use-cases/events/open-calls/drop-out-of-open-call";
import { detachEventHuman } from "@th/core/use-cases/event-humans/detach-event-human";
import { generateEventsFromSeries } from "@th/core/use-cases/series/generate-events-from-series";

import { createPrismaRepos } from "../../src/db/prisma";
import { makeEventApplicationsRepo } from "../../src/db/prisma/event-applications";
import { makeEventHumansRepo } from "../../src/db/prisma/event-humans";

const DAY = 24 * 60 * 60 * 1000;
const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<"settled" | "blocked"> {
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), ms)),
  ]);
}

describe("Prisma adapters integration – open-call decisions", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let organizerId: string;
  let orgId: string;
  const now = new Date();
  let counter = 0;
  const uniq = () => `${Date.now()}-${(counter += 1)}-${Math.random().toString(36).slice(2, 8)}`;

  const deps = () => ({ repos: createPrismaRepos(prisma!), clock: { now: () => new Date() } });

  const newEvent = async (overrides: Partial<Prisma.EventUncheckedCreateInput> = {}) => {
    const startsAt = new Date(now.getTime() + 10 * DAY);
    const event = await prisma!.event.create({
      data: {
        title: "Open call night",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3 * 3600_000),
        status: "PUBLISHED",
        orgId,
        ...overrides,
      } as Prisma.EventUncheckedCreateInput,
    });
    return event.id;
  };

  const newPostedCall = async (
    anchor: { kind: "event"; eventId: string } | { kind: "series"; seriesId: string },
  ) => {
    const repo = makeEventApplicationsRepo(prisma!);
    const call = await repo.upsertOpenCall({ anchor, payKind: "UNPAID", updatedByHumanId: organizerId });
    return repo.setOpenCallPosted({ formId: call.id, postedAt: now, postedByHumanId: organizerId });
  };

  const newHuman = async (name = "Act") =>
    (await prisma!.human.create({ data: { name, status: "ACTIVE" } })).id;

  /** A PENDING submission straight in the table (submit is covered elsewhere). */
  const newSubmission = async (
    formId: string,
    eventId: string | null,
    who: { humanId?: string; applyingAsOrgId?: string; guestName?: string },
    choices: Array<{ occurrenceId: string }> = [],
  ) => {
    const token = uniq();
    const row = await prisma!.eventApplicationSubmission.create({
      data: {
        formId,
        eventId,
        humanId: who.humanId ?? null,
        applyingAsOrgId: who.applyingAsOrgId ?? null,
        guestName: who.guestName ?? null,
        contactEmail: who.guestName ? `${token}@example.com` : null,
        statusTokenHash: sha256(token),
        status: "PENDING",
        dateChoices: { create: choices },
      },
    });
    return { id: row.id, token };
  };

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl, max: 10 });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      organizerId = await newHuman("Organizer");
      orgId = (
        await prisma.organization.create({ data: { name: "Decisions Org", slug: `decisions-${uniq()}` } })
      ).id;
      await prisma.orgMember.create({ data: { orgId, humanId: organizerId, role: "OWNER" } });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("open-call decisions integration setup failed:", error);
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

  test("pick: APPROVED + one PERFORMER row at the end of the lineup, openedAt stamped, audited", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    await prisma.eventHuman.createMany({
      data: [
        { eventId, externalName: "Opener", role: "PERFORMER", sortOrder: 0 },
        { eventId, externalName: "Headliner", role: "PERFORMER", sortOrder: 3 },
      ],
    });
    const call = await newPostedCall({ kind: "event", eventId });
    const act = await newHuman("Picked Person");
    const s = await newSubmission(call.id, eventId, { humanId: act });

    const out = await pickOpenCallApplication(deps(), {
      actorHumanId: organizerId,
      formId: call.id,
      submissionId: s.id,
    });

    expect(out.rows).toEqual([expect.objectContaining({ eventId, added: true })]);
    const row = await prisma.eventHuman.findUniqueOrThrow({ where: { id: out.rows[0]!.eventHumanId } });
    expect(row).toMatchObject({ humanId: act, orgId: null, role: "PERFORMER", sortOrder: 4 });
    const fresh = await prisma.eventApplicationSubmission.findUniqueOrThrow({ where: { id: s.id } });
    expect(fresh.status).toBe("APPROVED");
    expect(fresh.reviewerHumanId).toBe(organizerId);
    expect(fresh.reviewedAt).not.toBeNull();
    expect(fresh.openedAt).not.toBeNull();
    const audit = await prisma.auditLog.findMany({
      where: { action: "open_call_application_picked", entityId: eventId },
    });
    expect(audit).toHaveLength(1);
  });

  test("pick on a series call materialises the night through generateEventsFromSeries, one row per night", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const series = await prisma.eventSeries.create({
      data: {
        ownerScope: "ORGANIZATION",
        ownerId: orgId,
        name: "Decisions series",
        nameNormalized: `decisions series ${uniq()}`,
        timezone: "America/Chicago",
        schedule: { kind: "FIXED_DATES", dates: [] },
      },
    });
    const materialised = await newEvent({ title: "Night 1" });
    const o1 = await prisma.eventSeriesOccurrence.create({
      data: { seriesId: series.id, ordinal: 1, startsAt: new Date(now.getTime() + 2 * DAY), eventId: materialised, status: "GENERATED" },
    });
    const o2 = await prisma.eventSeriesOccurrence.create({
      data: {
        seriesId: series.id,
        ordinal: 2,
        startsAt: new Date(now.getTime() + 9 * DAY),
        // generateEventsFromSeries copies endsAt onto the required Event.endsAt.
        endsAt: new Date(now.getTime() + 9 * DAY + 3 * 3600_000),
        status: "PLANNED",
      },
    });
    const call = await newPostedCall({ kind: "series", seriesId: series.id });
    const band = (
      await prisma.organization.create({ data: { name: "The Band", slug: `band-${uniq()}` } })
    ).id;
    const s = await newSubmission(call.id, null, { humanId: await newHuman(), applyingAsOrgId: band }, [
      { occurrenceId: o1.id },
      { occurrenceId: o2.id },
    ]);
    const base = deps();
    const idempotency = createFakeIdempotencyPort();

    const out = await pickOpenCallApplication(
      {
        ...base,
        materializeSeriesOccurrences: (input) =>
          generateEventsFromSeries({ repos: base.repos, idempotency, clock: base.clock }, input),
      },
      { actorHumanId: organizerId, formId: call.id, submissionId: s.id, occurrenceIds: [o1.id, o2.id] },
    );

    const o2Fresh = await prisma.eventSeriesOccurrence.findUniqueOrThrow({ where: { id: o2.id } });
    expect(o2Fresh.eventId).not.toBeNull();
    expect(o2Fresh.status).toBe("GENERATED");
    expect(out.rows.map((r) => r.eventId).sort()).toEqual([materialised, o2Fresh.eventId].sort());
    const rows = await prisma.eventHuman.findMany({ where: { orgId: band } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.humanId === null && r.role === "PERFORMER")).toBe(true);
  });

  test("concurrent double pick of a GUEST (no unique key): the second waits on the row lock, then adds nothing", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const s = await newSubmission(call.id, eventId, { guestName: "The Moths" });

    const firstHolds = gate();
    const release = gate();
    // Organizer A, mid-pick: holds the submission row lock with the row added.
    const first = prisma.$transaction(
      async (tx) => {
        const apps = makeEventApplicationsRepo(tx as unknown as PrismaClient);
        const humans = makeEventHumansRepo(tx as unknown as PrismaClient);
        const locked = await apps.lockOpenCallSubmission({ submissionId: s.id, formId: call.id });
        expect(locked?.status).toBe("PENDING");
        expect(
          await apps.approveOpenCallSubmission({
            submissionId: s.id,
            formId: call.id,
            reviewerHumanId: organizerId,
            reviewedAt: new Date(),
          }),
        ).toBe(true);
        await humans.attach({ eventId, externalName: "The Moths", role: "PERFORMER", sortOrder: 0 });
        firstHolds.open();
        await release.opened;
      },
      { timeout: 30_000 },
    );
    await firstHolds.opened;

    // Organizer B picks the same application through core.
    const second = pickOpenCallApplication(deps(), {
      actorHumanId: organizerId,
      formId: call.id,
      submissionId: s.id,
    });
    expect(await settlesWithin(second, 1_500)).toBe("blocked");
    release.open();
    await first;
    const out = await second;

    expect(out.alreadyPicked).toBe(true);
    expect(out.rows[0]!.added).toBe(false);
    expect(await prisma.eventHuman.count({ where: { eventId } })).toBe(1);
  });

  test("two core picks racing on a PERSON: both succeed, exactly one row, one 'picked' audit", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const s = await newSubmission(call.id, eventId, { humanId: await newHuman() });
    const input = { actorHumanId: organizerId, formId: call.id, submissionId: s.id };

    const [a, b] = await Promise.all([
      pickOpenCallApplication(deps(), input),
      pickOpenCallApplication(deps(), input),
    ]);

    expect([a.alreadyPicked, b.alreadyPicked].sort()).toEqual([false, true]);
    expect(await prisma.eventHuman.count({ where: { eventId } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: "open_call_application_picked", entityId: eventId } }),
    ).toBe(1);
  });

  test("pick vs withdraw: a withdraw waiting on the pick's row lock then matches nothing", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const s = await newSubmission(call.id, eventId, { guestName: "Racer" });

    const held = gate();
    const release = gate();
    const pick = prisma.$transaction(
      async (tx) => {
        const apps = makeEventApplicationsRepo(tx as unknown as PrismaClient);
        await apps.lockOpenCallSubmission({ submissionId: s.id, formId: call.id });
        await apps.approveOpenCallSubmission({
          submissionId: s.id,
          formId: call.id,
          reviewerHumanId: organizerId,
          reviewedAt: new Date(),
        });
        held.open();
        await release.opened;
      },
      { timeout: 30_000 },
    );
    await held.opened;
    // The applicant's guarded write, straight against the adapter in its own tx.
    const guarded = prisma.$transaction(async (tx) =>
      makeEventApplicationsRepo(tx as unknown as PrismaClient).withdrawPendingOpenCallSubmission({
        submissionId: s.id,
        formId: call.id,
      }),
    );
    expect(await settlesWithin(guarded, 1_500)).toBe("blocked");
    release.open();
    await pick;
    expect(await guarded).toBe(false);
    const fresh = await prisma.eventApplicationSubmission.findUniqueOrThrow({ where: { id: s.id } });
    expect(fresh.status).toBe("APPROVED");
  });

  test("removal racing an in-flight 'already on the lineup' pick: waits on the lock, then sees APPROVED and stamps", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const act = await newHuman("Already Booked");
    // Hand-added before the pick, so the pick adds no row (added: false).
    const row = await prisma.eventHuman.create({
      data: { eventId, humanId: act, role: "PERFORMER", sortOrder: 0 },
    });
    const s = await newSubmission(call.id, eventId, { humanId: act });

    const held = gate();
    const release = gate();
    // The pick, mid-transaction: row lock held, status flipped, not committed.
    const pick = prisma.$transaction(
      async (tx) => {
        const apps = makeEventApplicationsRepo(tx as unknown as PrismaClient);
        await apps.lockOpenCallSubmission({ submissionId: s.id, formId: call.id });
        await apps.approveOpenCallSubmission({
          submissionId: s.id,
          formId: call.id,
          reviewerHumanId: organizerId,
          reviewedAt: new Date(),
        });
        held.open();
        await release.opened;
      },
      { timeout: 30_000 },
    );
    await held.opened;

    const removal = detachEventHuman(
      { ...deps(), authz: { hasStaffRole: async () => ({ allowed: false }) } } as never,
      { actorHumanId: organizerId, eventHumanId: row.id },
    );
    expect(await settlesWithin(removal, 1_500)).toBe("blocked");
    release.open();
    await pick;
    await removal;

    const fresh = await prisma.eventApplicationSubmission.findUniqueOrThrow({ where: { id: s.id } });
    expect(fresh.status).toBe("APPROVED");
    expect(fresh.removedFromLineupAt).not.toBeNull();
    expect(await prisma.eventHuman.count({ where: { eventId } })).toBe(0);
  });

  test("lockOpenCallSubmissionsByAct locks every status of the act, in id order", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const act = await newHuman("Many Rows");
    const a = await newSubmission(call.id, eventId, { humanId: act });
    await prisma.eventApplicationSubmission.update({ where: { id: a.id }, data: { status: "REJECTED" } });
    const b = await newSubmission(call.id, eventId, { humanId: act });
    const locked = await prisma.$transaction((tx) =>
      makeEventApplicationsRepo(tx as unknown as PrismaClient).lockOpenCallSubmissionsByAct({
        formId: call.id,
        act: { kind: "human", humanId: act },
      }),
    );
    expect(locked.map((r) => r.id)).toEqual([a.id, b.id].sort());
    expect(locked.map((r) => r.status).sort()).toEqual(["PENDING", "REJECTED"]);
  });

  test("drop out by status link: rows removed and WITHDRAWN + droppedOutAt in one transaction", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const s = await newSubmission(call.id, eventId, { guestName: "Dropper" });
    // A status token is 43 base64url chars; seed one whose hash we store.
    const token = "A".repeat(43);
    await prisma.eventApplicationSubmission.update({
      where: { id: s.id },
      data: { statusTokenHash: sha256(token) },
    });
    await pickOpenCallApplication(deps(), { actorHumanId: organizerId, formId: call.id, submissionId: s.id });
    const keep = await prisma.eventHuman.create({
      data: { eventId, externalName: "Someone Else", role: "PERFORMER", sortOrder: 9 },
    });

    const out = await dropOutOfOpenCall(deps(), { auth: { kind: "token", token } });

    expect(out.removedEventHumanIds).toHaveLength(1);
    expect((await prisma.eventHuman.findMany({ where: { eventId } })).map((r) => r.id)).toEqual([keep.id]);
    const fresh = await prisma.eventApplicationSubmission.findUniqueOrThrow({ where: { id: s.id } });
    expect(fresh.status).toBe("WITHDRAWN");
    expect(fresh.droppedOutAt).not.toBeNull();
  });

  test("lineup removal by an editor stamps removedFromLineupAt and keeps APPROVED", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const act = await newHuman("Removed Act");
    const s = await newSubmission(call.id, eventId, { humanId: act });
    const picked = await pickOpenCallApplication(deps(), {
      actorHumanId: organizerId,
      formId: call.id,
      submissionId: s.id,
    });

    await detachEventHuman(
      { ...deps(), authz: { hasStaffRole: async () => ({ allowed: false }) } } as never,
      { actorHumanId: organizerId, eventHumanId: picked.rows[0]!.eventHumanId },
    );

    const fresh = await prisma.eventApplicationSubmission.findUniqueOrThrow({ where: { id: s.id } });
    expect(fresh.status).toBe("APPROVED");
    expect(fresh.removedFromLineupAt).not.toBeNull();
    expect(await prisma.eventHuman.count({ where: { eventId } })).toBe(0);
  });
});
