/**
 * Open calls v1 step 3 — the open-call repo methods against a REAL Postgres.
 * The row locks, the advisory lock, the one-statement sweep and the
 * relation filters only mean something in the database, so a mocked Prisma
 * can't prove them.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventApplicationsRepo } from "../../src/db/prisma/event-applications";

const DAY = 24 * 60 * 60 * 1000;

/** A promise plus its resolver, to hold a transaction open on cue. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Resolves "blocked" if `p` hasn't settled within `ms`. */
async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<"settled" | "blocked"> {
  return Promise.race([
    p.then(() => "settled" as const),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), ms)),
  ]);
}

describe("Prisma adapters integration – open-call methods", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let organizerId: string;
  let orgId: string;
  let otherOrgId: string;
  const now = new Date();

  const newEvent = async (
    overrides: Partial<Prisma.EventUncheckedCreateInput> = {},
  ): Promise<string> => {
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

  const newSeries = async (name: string, ownerId = orgId): Promise<string> => {
    const s = await prisma!.eventSeries.create({
      data: {
        ownerScope: "ORGANIZATION",
        ownerId,
        name,
        nameNormalized: name.toLowerCase(),
        timezone: "America/Chicago",
        schedule: { kind: "FIXED_DATES", dates: [] },
      },
    });
    return s.id;
  };

  const newOccurrence = async (
    seriesId: string,
    ordinal: number,
    startsAt: Date,
    eventId: string | null = null,
    status: "PLANNED" | "GENERATED" | "DETACHED" | "CANCELLED" = eventId ? "GENERATED" : "PLANNED",
  ) =>
    prisma!.eventSeriesOccurrence.create({
      data: { seriesId, ordinal, startsAt, eventId, status },
    });

  const newSubmission = async (
    formId: string,
    eventId: string | null,
    status: "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN" = "PENDING",
    client: Prisma.TransactionClient | PrismaClient = prisma!,
  ) => {
    const human = await client.human.create({ data: { name: "Act", status: "ACTIVE" } });
    return client.eventApplicationSubmission.create({
      data: { formId, eventId, humanId: human.id, status, answers: {} },
    });
  };

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl, max: 10 });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      organizerId = (
        await prisma.human.create({ data: { name: "Organizer", status: "ACTIVE" } })
      ).id;
      orgId = (
        await prisma.organization.create({ data: { name: "Basement Org", slug: "basement-org" } })
      ).id;
      otherOrgId = (
        await prisma.organization.create({ data: { name: "Other Org", slug: "other-org" } })
      ).id;
      await prisma.orgMember.create({ data: { orgId, humanId: organizerId, role: "OWNER" } });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("open-calls integration setup failed:", error);
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

  test("event and series calls: upsert, read by anchor / id / publicId; ATTEND is invisible", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const seriesId = await newSeries("Upsert series");

    const eventCall = await repo.upsertOpenCall({
      anchor: { kind: "event", eventId },
      payKind: "FIXED",
      payDetails: "$100",
      updatedByHumanId: organizerId,
    });
    expect(eventCall).toMatchObject({ eventId, seriesId: null, purpose: "PERFORM", payKind: "FIXED" });
    expect(eventCall.publicId).toMatch(/^[a-z0-9]{10}$/);

    // Presence semantics: an intro-only update keeps the pay.
    const updated = await repo.upsertOpenCall({
      anchor: { kind: "event", eventId },
      introText: "Bands wanted",
      updatedByHumanId: organizerId,
    });
    expect(updated).toMatchObject({ id: eventCall.id, payKind: "FIXED", introText: "Bands wanted" });

    const seriesCall = await repo.upsertOpenCall({
      anchor: { kind: "series", seriesId },
      payKind: "UNPAID",
      updatedByHumanId: organizerId,
    });
    expect(seriesCall).toMatchObject({ seriesId, eventId: null });
    expect((await repo.getOpenCall({ kind: "series", seriesId }))?.id).toBe(seriesCall.id);

    // The event's ATTEND form lives alongside and is never an open call.
    const attend = await repo.ensureForm({ eventId, purpose: "ATTEND" });
    expect(await repo.getOpenCallById(attend.id)).toBeNull();
    expect(await repo.getOpenCallByPublicId(attend.publicId)).toBeNull();
    expect(await repo.lockOpenCallForClose(attend.id)).toBeNull();
    expect((await repo.getOpenCallByPublicId(eventCall.publicId))?.ownerBanned).toBe(false);
  });

  test("migration: postedAt / postedByHumanId exist, start null, SetNull FK, PERFORM-only CHECK", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const poster = await prisma.human.create({ data: { name: "Poster", status: "ACTIVE" } });
    const call = await repo.upsertOpenCall({
      anchor: { kind: "event", eventId },
      payKind: "UNPAID",
      updatedByHumanId: organizerId,
    });
    expect(call).toMatchObject({ postedAt: null, postedByHumanId: null });

    const postedAt = new Date();
    const posted = await repo.setOpenCallPosted({ formId: call.id, postedAt, postedByHumanId: poster.id });
    expect(posted).toMatchObject({ postedAt, postedByHumanId: poster.id });

    // FK ON DELETE SET NULL: deleting the poster keeps the call posted.
    await prisma.human.delete({ where: { id: poster.id } });
    expect(await repo.getOpenCallById(call.id)).toMatchObject({ postedAt, postedByHumanId: null });

    // CHECK: an ATTEND form can never be posted.
    const attend = await repo.ensureForm({ eventId, purpose: "ATTEND" });
    await expect(
      prisma.$executeRaw`UPDATE "EventApplicationForm" SET "postedAt" = now() WHERE "id" = ${attend.id}`,
    ).rejects.toThrow(/EventApplicationForm_posted_perform_only_check/);
    await expect(
      prisma.$executeRaw`UPDATE "EventApplicationForm" SET "postedByHumanId" = ${organizerId} WHERE "id" = ${attend.id}`,
    ).rejects.toThrow(/EventApplicationForm_posted_perform_only_check/);
  });

  test("deleteOpenCallDraft removes an unposted call with its questions, and nothing else", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const newCall = async () =>
      repo.upsertOpenCall({
        anchor: { kind: "event", eventId: await newEvent() },
        payKind: "UNPAID",
        updatedByHumanId: organizerId,
      });

    const draft = await newCall();
    const question = await prisma.eventApplicationQuestion.create({
      data: { formId: draft.id, type: "SHORT_TEXT", label: "Your band?" },
    });
    expect(await repo.deleteOpenCallDraft(draft.id)).toBe(true);
    expect(await prisma.eventApplicationForm.findUnique({ where: { id: draft.id } })).toBeNull();
    expect(
      await prisma.eventApplicationQuestion.findUnique({ where: { id: question.id } }),
    ).toBeNull();
    // Already gone: false, not an error.
    expect(await repo.deleteOpenCallDraft(draft.id)).toBe(false);

    // A posted call is never deleted.
    const posted = await newCall();
    await repo.setOpenCallPosted({ formId: posted.id, postedAt: new Date(), postedByHumanId: organizerId });
    expect(await repo.deleteOpenCallDraft(posted.id)).toBe(false);
    expect(await repo.getOpenCallById(posted.id)).not.toBeNull();

    // A draft with a submission is refused by the statement itself, and the
    // submission (which would cascade) survives.
    const withSubmission = await newCall();
    const sub = await newSubmission(withSubmission.id, withSubmission.eventId, "WITHDRAWN");
    expect(await repo.deleteOpenCallDraft(withSubmission.id)).toBe(false);
    expect(
      await prisma.eventApplicationSubmission.findUnique({ where: { id: sub.id } }),
    ).not.toBeNull();

    // An ATTEND form (always unposted) is not a call.
    const attend = await repo.ensureForm({ eventId: await newEvent(), purpose: "ATTEND" });
    expect(await repo.deleteOpenCallDraft(attend.id)).toBe(false);
    expect(await prisma.eventApplicationForm.findUnique({ where: { id: attend.id } })).not.toBeNull();
  });

  test("the sweep flips only PENDING, in one statement, and returns ids", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await repo.upsertOpenCall({
      anchor: { kind: "event", eventId },
      payKind: "UNPAID",
      updatedByHumanId: organizerId,
    });
    const p1 = await newSubmission(call.id, eventId);
    const p2 = await newSubmission(call.id, eventId);
    const picked = await newSubmission(call.id, eventId, "APPROVED");
    const withdrawn = await newSubmission(call.id, eventId, "WITHDRAWN");
    const attend = await repo.ensureForm({ eventId, purpose: "ATTEND" });
    const guest = await newSubmission(attend.id, eventId);

    const reviewedAt = new Date();
    const { ids } = await repo.rejectPendingOpenCallSubmissions({ formId: call.id, reviewedAt });
    expect(new Set(ids)).toEqual(new Set([p1.id, p2.id]));

    const after = await prisma.eventApplicationSubmission.findMany({
      where: { id: { in: [p1.id, p2.id, picked.id, withdrawn.id, guest.id] } },
      select: { id: true, status: true, reviewedAt: true },
    });
    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get(p1.id)).toMatchObject({ status: "REJECTED", reviewedAt });
    expect(byId.get(picked.id)?.status).toBe("APPROVED");
    expect(byId.get(withdrawn.id)?.status).toBe("WITHDRAWN");
    expect(byId.get(guest.id)?.status).toBe("PENDING");
    // Idempotent: nothing left to flip.
    expect((await repo.rejectPendingOpenCallSubmissions({ formId: call.id, reviewedAt })).ids).toEqual([]);
  });

  test("close race 1: a submit INSERT in flight makes the close wait, and the sweep sees it", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await repo.upsertOpenCall({
      anchor: { kind: "event", eventId },
      payKind: "UNPAID",
      updatedByHumanId: organizerId,
    });

    const inserted = gate();
    const release = gate();
    let lateId = "";
    const submit = prisma.$transaction(
      async (tx) => {
        const s = await newSubmission(call.id, eventId, "PENDING", tx);
        lateId = s.id;
        inserted.open();
        await release.opened; // hold FOR KEY SHARE on the form row
      },
      { timeout: 30_000 },
    );
    await inserted.opened;

    const close = prisma.$transaction(
      async (tx) => {
        const txRepo = makeEventApplicationsRepo(tx as unknown as PrismaClient);
        const locked = await txRepo.lockOpenCallForClose(call.id);
        await txRepo.setOpenCallClosed({ formId: call.id, closedAt: new Date(), closedByHumanId: organizerId });
        const swept = await txRepo.rejectPendingOpenCallSubmissions({ formId: call.id, reviewedAt: new Date() });
        return { locked, swept };
      },
      { timeout: 30_000 },
    );

    expect(await settlesWithin(close, 500)).toBe("blocked");
    release.open();
    await submit;
    const { swept } = await close;
    expect(swept.ids).toContain(lateId);
  });

  test("close race 2: a submit reading FOR KEY SHARE waits for the close and sees closedAt", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await repo.upsertOpenCall({
      anchor: { kind: "event", eventId },
      payKind: "UNPAID",
      updatedByHumanId: organizerId,
    });

    const closed = gate();
    const release = gate();
    const close = prisma.$transaction(
      async (tx) => {
        const txRepo = makeEventApplicationsRepo(tx as unknown as PrismaClient);
        await txRepo.lockOpenCallForClose(call.id);
        await txRepo.setOpenCallClosed({ formId: call.id, closedAt: new Date(), closedByHumanId: organizerId });
        closed.open();
        await release.opened;
      },
      { timeout: 30_000 },
    );
    await closed.opened;

    const submitRead = prisma.$transaction(
      async (tx) => makeEventApplicationsRepo(tx as unknown as PrismaClient).lockOpenCallForSubmit(call.id),
      { timeout: 30_000 },
    );
    expect(await settlesWithin(submitRead, 500)).toBe("blocked");
    release.open();
    await close;
    expect((await submitRead)?.closedAt).toBeInstanceOf(Date);
  });

  test("a submit's FOR KEY SHARE read does not hold up an organizer edit of the call", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await repo.upsertOpenCall({
      anchor: { kind: "event", eventId },
      payKind: "UNPAID",
      updatedByHumanId: organizerId,
    });

    const read = gate();
    const release = gate();
    const submit = prisma.$transaction(
      async (tx) => {
        await makeEventApplicationsRepo(tx as unknown as PrismaClient).lockOpenCallForSubmit(call.id);
        read.open();
        await release.opened; // hold FOR KEY SHARE
      },
      { timeout: 30_000 },
    );
    await read.opened;

    // A plain UPDATE of non-key columns (FOR NO KEY UPDATE) does not conflict.
    const edit = repo.upsertOpenCall({
      anchor: { kind: "event", eventId },
      introText: "Edited mid-submit",
      updatedByHumanId: organizerId,
    });
    expect(await settlesWithin(edit, 2_000)).toBe("settled");
    release.open();
    await submit;
    expect((await edit).introText).toBe("Edited mid-submit");
  });

  test("lockSeriesOpenCalls serialises two transactions on one series", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const seriesId = await newSeries("Advisory series");
    const locked = gate();
    const release = gate();
    const first = prisma.$transaction(
      async (tx) => {
        await makeEventApplicationsRepo(tx as unknown as PrismaClient).lockSeriesOpenCalls(seriesId);
        locked.open();
        await release.opened;
      },
      { timeout: 30_000 },
    );
    await locked.opened;
    const second = prisma.$transaction(
      async (tx) => makeEventApplicationsRepo(tx as unknown as PrismaClient).lockSeriesOpenCalls(seriesId),
      { timeout: 30_000 },
    );
    expect(await settlesWithin(second, 500)).toBe("blocked");
    release.open();
    await first;
    await second;
  });

  test("listUpcomingEventOpenCallsInSeries: upcoming, own call, not DETACHED, not cancelled", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const seriesId = await newSeries("Conflict series");
    const upcoming = await newEvent({ title: "Upcoming" });
    const past = await newEvent({
      title: "Past",
      startsAt: new Date(now.getTime() - 2 * DAY),
      endsAt: new Date(now.getTime() - 2 * DAY + 3600_000),
    });
    const detached = await newEvent({ title: "Detached" });
    const cancelled = await newEvent({ title: "Cancelled", status: "CANCELLED" });
    const noCall = await newEvent({ title: "No call" });
    let ordinal = 0;
    for (const [eventId, status] of [
      [upcoming, "GENERATED"],
      [past, "GENERATED"],
      [detached, "DETACHED"],
      [cancelled, "GENERATED"],
      [noCall, "GENERATED"],
    ] as const) {
      ordinal += 1;
      await newOccurrence(seriesId, ordinal, new Date(now.getTime() + ordinal * DAY), eventId, status);
      if (eventId !== noCall) {
        await repo.upsertOpenCall({
          anchor: { kind: "event", eventId },
          payKind: "UNPAID",
          updatedByHumanId: organizerId,
        });
      }
    }
    const conflicts = await repo.listUpcomingEventOpenCallsInSeries({ seriesId, startsAfter: now });
    expect(conflicts.map((c) => c.eventTitle)).toEqual(["Upcoming"]);
    expect(conflicts[0]).toMatchObject({ eventId: upcoming });
  });

  test("listOpenCallsByPoster: open calls on public upcoming events and live series, by next date", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    // A fresh org so earlier tests' calls don't show up.
    const posterOrg = (
      await prisma.organization.create({ data: { name: "Poster Org", slug: "poster-org" } })
    ).id;
    const mk = async (
      overrides: Partial<Prisma.EventUncheckedCreateInput>,
      call = true,
      closed = false,
      posted = true,
    ) => {
      const eventId = await newEvent({ orgId: posterOrg, ...overrides });
      if (call) {
        const c = await repo.upsertOpenCall({
          anchor: { kind: "event", eventId },
          payKind: "UNPAID",
          updatedByHumanId: organizerId,
        });
        if (posted) {
          await repo.setOpenCallPosted({ formId: c.id, postedAt: now, postedByHumanId: organizerId });
        }
        if (closed) await repo.setOpenCallClosed({ formId: c.id, closedAt: now, closedByHumanId: organizerId });
        return c;
      }
      return null;
    };
    const later = await mk({ title: "Later", startsAt: new Date(now.getTime() + 20 * DAY), endsAt: new Date(now.getTime() + 20 * DAY + 3600_000) });
    const draft = await mk({ title: "Draft", status: "DRAFT", startsAt: new Date(now.getTime() + 3 * DAY), endsAt: new Date(now.getTime() + 3 * DAY + 3600_000) });
    await mk({ title: "Private", visibility: "PRIVATE" });
    await mk({ title: "Closed" }, true, true);
    // A saved-but-never-posted call is a draft (owner ruling Q41): unlisted.
    await mk({ title: "Unposted draft" }, true, false, false);
    await mk({ title: "Cancelled", status: "CANCELLED" });
    await mk({ title: "Started", startsAt: new Date(now.getTime() - 3600_000), endsAt: new Date(now.getTime() + 3600_000) });
    await newEvent({ orgId: otherOrgId, title: "Someone else's" });

    const seriesId = await newSeries("Poster series", posterOrg);
    await newOccurrence(seriesId, 1, new Date(now.getTime() - DAY));
    await newOccurrence(seriesId, 2, new Date(now.getTime() + 7 * DAY));
    const seriesCall = await repo.upsertOpenCall({
      anchor: { kind: "series", seriesId },
      payKind: "UNPAID",
      updatedByHumanId: organizerId,
    });
    await repo.setOpenCallPosted({ formId: seriesCall.id, postedAt: now, postedByHumanId: organizerId });
    const deadSeries = await newSeries("Dead series", posterOrg);
    await newOccurrence(deadSeries, 1, new Date(now.getTime() + 5 * DAY), null, "CANCELLED");
    const deadCall = await repo.upsertOpenCall({
      anchor: { kind: "series", seriesId: deadSeries },
      payKind: "UNPAID",
      updatedByHumanId: organizerId,
    });
    await repo.setOpenCallPosted({ formId: deadCall.id, postedAt: now, postedByHumanId: organizerId });

    const cards = await repo.listOpenCallsByPoster({
      poster: { kind: "org", orgId: posterOrg },
      now,
      limit: 10,
    });
    expect(cards.map((c) => c.title)).toEqual(["Draft", "Poster series", "Later"]);
    expect(cards.map((c) => c.publicId)).toEqual([draft!.publicId, seriesCall.publicId, later!.publicId]);
    expect(cards[1]).toMatchObject({ anchor: { kind: "series", seriesId } });

    // Limit applies after the sort.
    expect(
      (await repo.listOpenCallsByPoster({ poster: { kind: "org", orgId: posterOrg }, now, limit: 1 })).map(
        (c) => c.title,
      ),
    ).toEqual(["Draft"]);
  });
});
