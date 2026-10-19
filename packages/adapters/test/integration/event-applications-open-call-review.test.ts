/**
 * Open calls v1 step 5 — the ORGANIZER-SIDE review methods against a REAL
 * Postgres: the queue query (filters, fixed order, keyset cursor), the bulk
 * trust traces (published / past / cancelled / self-organised rules), the
 * guarded first-open stamp, the vote upsert on its unique key, and the
 * thread's monotonic read markers. A mocked Prisma can prove none of these.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import { listOpenCallApplications } from "@th/core/use-cases/events/open-calls/list-open-call-applications";
import { openOpenCallApplication } from "@th/core/use-cases/events/open-calls/open-open-call-application";
import { editOpenCallApplication } from "@th/core/use-cases/events/open-calls/edit-open-call-application";
import { castApplicationVote } from "@th/core/use-cases/events/open-calls/cast-application-vote";
import {
  TRACE_LINEUP_ROLES,
  TRACE_ORGANISER_ORG_ROLES,
} from "@th/core/use-cases/events/open-calls/_shared/review-card";

import { createPrismaRepos } from "../../src/db/prisma";
import { makeEventApplicationsRepo } from "../../src/db/prisma/event-applications";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

describe("Prisma adapters integration – open-call review (organizer side)", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let organizerId: string;
  let orgId: string;
  let otherOrgId: string;
  let placeHere: string;
  let placeElsewhere: string;
  const now = new Date();
  let slugCounter = 0;

  const newHuman = async (name = "Act") =>
    (await prisma!.human.create({ data: { name, status: "ACTIVE" } })).id;

  const newOrg = async (name: string) =>
    (
      await prisma!.organization.create({
        data: { name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-ocr-${(slugCounter += 1)}` },
      })
    ).id;

  const newEvent = async (
    overrides: Partial<Prisma.EventUncheckedCreateInput> = {},
  ): Promise<string> => {
    const startsAt = new Date(now.getTime() + 10 * DAY);
    const event = await prisma!.event.create({
      data: {
        title: "Night",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3 * HOUR),
        status: "PUBLISHED",
        orgId,
        ...overrides,
      } as Prisma.EventUncheckedCreateInput,
    });
    return event.id;
  };

  const pastEvent = (overrides: Partial<Prisma.EventUncheckedCreateInput> = {}) => {
    const startsAt = new Date(now.getTime() - 30 * DAY);
    return newEvent({
      orgId: otherOrgId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * HOUR),
      ...overrides,
    });
  };

  const credit = async (
    eventId: string,
    who: { humanId?: string; orgId?: string },
    role: "PERFORMER" | "DJ" | "VOLUNTEER" = "PERFORMER",
  ) => {
    await prisma!.eventHuman.create({
      data: { eventId, humanId: who.humanId ?? null, orgId: who.orgId ?? null, role },
    });
  };

  const newPostedCall = async (
    anchor: { kind: "event"; eventId: string } | { kind: "series"; seriesId: string },
  ) => {
    const repo = makeEventApplicationsRepo(prisma!);
    const call = await repo.upsertOpenCall({ anchor, payKind: "UNPAID", updatedByHumanId: organizerId });
    return repo.setOpenCallPosted({ formId: call.id, postedAt: now, postedByHumanId: organizerId });
  };

  const submit = async (
    formId: string,
    eventId: string | null,
    who: { humanId?: string; orgId?: string; guest?: string },
    submittedAt: Date,
    dateChoices: Array<{ eventDateId: string } | { occurrenceId: string }> = [],
    token = `tok-${randomUUID()}`,
  ) => {
    const repo = makeEventApplicationsRepo(prisma!);
    return repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null, 
      formId,
      eventId,
      humanId: who.humanId ?? null,
      applyingAsOrgId: who.orgId ?? null,
      guestName: who.guest ?? null,
      guestUrl: who.guest ? "https://guest.example.com" : null,
      contactEmail: who.guest ? `${randomUUID()}@example.com` : null,
      answers: { q: "answer" },
      questionsSnapshot: {},
      isPrivate: false,
      statusTokenHash: sha256(token),
      dateChoices: dateChoices as never,
      submittedAt,
    });
  };

  const repo = () => makeEventApplicationsRepo(prisma!);
  const deps = () => ({ repos: createPrismaRepos(prisma!), clock: { now: () => new Date() } });
  const listInput = (formId: string, extra: Record<string, unknown> = {}) => ({
    formId,
    viewerHumanId: organizerId,
    filter: {},
    cursor: null,
    limit: 50,
    now: new Date(),
    lineupRoles: TRACE_LINEUP_ROLES,
    organiserOrgRoles: TRACE_ORGANISER_ORG_ROLES,
    ...extra,
  });

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl, max: 10 });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      organizerId = await newHuman("Organizer");
      orgId = await newOrg("Basement Org");
      otherOrgId = await newOrg("Other Org");
      // Reviewing needs event edit rights (FR-014 as amended, Q43).
      await prisma.orgMember.create({ data: { orgId, humanId: organizerId, role: "EDITOR" } });
      placeHere = (await prisma.place.create({ data: { name: "The Basement", address: "1 Elm" } })).id;
      placeElsewhere = (await prisma.place.create({ data: { name: "Elsewhere", address: "2 Elm" } })).id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("open-call review integration setup failed:", error);
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

  test("queue: oldest first, (createdAt, id) cursor, WITHDRAWN only on request, status / date / my-vote filters", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent({ placeId: placeHere });
    const d1 = await prisma.eventDate.create({
      data: { eventId, ordinal: 1, startsAt: new Date(now.getTime() + 5 * DAY) },
    });
    const d2 = await prisma.eventDate.create({
      data: { eventId, ordinal: 2, startsAt: new Date(now.getTime() + 6 * DAY) },
    });
    const call = await newPostedCall({ kind: "event", eventId });
    const t = (m: number) => new Date(now.getTime() - DAY + m * 60_000);
    const a = await submit(call.id, eventId, { guest: "A" }, t(3), [{ eventDateId: d1.id }]);
    const b = await submit(call.id, eventId, { guest: "B" }, t(1), [{ eventDateId: d2.id }]);
    const c = await submit(call.id, eventId, { guest: "C" }, t(2), [
      { eventDateId: d1.id },
      { eventDateId: d2.id },
    ]);
    const w = await submit(call.id, eventId, { guest: "W" }, t(4), [{ eventDateId: d1.id }]);
    await repo().withdrawPendingOpenCallSubmission({ submissionId: w.id, formId: call.id });
    // Another call's submission never shows (and its id as a cursor restarts).
    const otherEvent = await newEvent();
    const otherCall = await newPostedCall({ kind: "event", eventId: otherEvent });
    const foreign = await submit(otherCall.id, otherEvent, { guest: "F" }, t(0));

    const ids = async (extra: Record<string, unknown>) =>
      (await repo().listOpenCallReviewCards(listInput(call.id, extra))).items.map((x) => x.submission.id);

    expect(await ids({})).toEqual([b.id, c.id, a.id]);
    expect(await ids({ filter: { statuses: ["WITHDRAWN"] } })).toEqual([w.id]);
    expect(await ids({ filter: { dateId: d2.id } })).toEqual([b.id, c.id]);
    expect(await ids({ cursor: foreign.id })).toEqual([b.id, c.id, a.id]);

    const p1 = await repo().listOpenCallReviewCards(listInput(call.id, { limit: 2 }));
    expect(p1.items.map((x) => x.submission.id)).toEqual([b.id, c.id]);
    expect(p1.nextCursor).toBe(c.id);
    const p2 = await repo().listOpenCallReviewCards(listInput(call.id, { limit: 2, cursor: p1.nextCursor }));
    expect(p2.items.map((x) => x.submission.id)).toEqual([a.id]);
    expect(p2.nextCursor).toBeNull();

    await repo().setApplicationVote({ submissionId: a.id, humanId: organizerId, vote: "YES", at: now });
    const otherMember = await newHuman("Member");
    await repo().setApplicationVote({ submissionId: c.id, humanId: otherMember, vote: "NO", at: now });
    expect(await ids({ filter: { myVote: "YES" } })).toEqual([a.id]);
    expect(await ids({ filter: { myVote: "NONE" } })).toEqual([b.id, c.id]);

    // Tally, my vote, notes, unread in bulk.
    await repo().createApplicationNote({ submissionId: c.id, authorHumanId: otherMember, body: "n", createdAt: now });
    await repo().createApplicationMessage({
      submissionId: c.id,
      authorSide: "APPLICANT",
      authorHumanId: null,
      body: "hi",
      createdAt: now,
    });
    await repo().createApplicationMessage({
      submissionId: c.id,
      authorSide: "ORGANIZER",
      authorHumanId: organizerId,
      body: "hello",
      createdAt: now,
    });
    const cards = (await repo().listOpenCallReviewCards(listInput(call.id))).items;
    const cardC = cards.find((x) => x.submission.id === c.id)!;
    expect(cardC).toMatchObject({
      displayName: "C",
      votes: { yes: 0, maybe: 0, no: 1 },
      myVote: null,
      noteCount: 1,
      unreadForOrganizer: 1,
      traces: null,
    });
    expect(cardC.submission.dateChoices.map((d) => d.eventDateId)).toEqual([d1.id, d2.id]);
    // FR-010: the queue never reads answers, the snapshot, email or token hash.
    for (const key of ["answers", "questionsSnapshot", "contactEmail", "statusTokenHash"]) {
      expect(cardC.submission).not.toHaveProperty(key);
    }
    expect(cards.find((x) => x.submission.id === a.id)!.myVote).toBe("YES");
  });

  test("traces in bulk: public / published / past / not cancelled; self-booking is ran; org nights without you are not yours; here = the call's place", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const act = await newHuman("Ana");
    const band = await newOrg("The Band");

    await credit(await pastEvent({ placeId: placeHere }), { humanId: act }); // played here
    await credit(await pastEvent({ placeId: placeElsewhere, status: "COMPLETED" }), { humanId: act }, "DJ"); // played
    await credit(await pastEvent({ status: "CANCELLED", placeId: placeHere }), { humanId: act }); // no
    await credit(await pastEvent({ status: "DRAFT" }), { humanId: act }); // no
    await credit(await newEvent({ orgId: otherOrgId, placeId: placeHere }), { humanId: act }); // future: no
    await credit(await pastEvent(), { humanId: act }, "VOLUNTEER"); // not a lineup credit
    // An org event that Ana happened to create: org-owned, so still "played".
    await credit(await pastEvent({ humanId: act }), { humanId: act });
    // Ana's OWN personal event with herself on it: ran, not played.
    const own = await pastEvent({ orgId: null, humanId: act, placeId: placeHere });
    await credit(own, { humanId: act });
    // Multi-date: 2 ended SCHEDULED dates + 1 cancelled + 1 upcoming = 2 nights.
    const multi = await pastEvent({ endsAt: new Date(now.getTime() + 30 * DAY) });
    for (const [i, offset, status] of [
      [1, -20, "SCHEDULED"],
      [2, -19, "SCHEDULED"],
      [3, -18, "CANCELLED"],
      [4, 2, "SCHEDULED"],
    ] as const) {
      await prisma.eventDate.create({
        data: { eventId: multi, ordinal: i, startsAt: new Date(now.getTime() + offset * DAY), status },
      });
    }
    await credit(multi, { humanId: act });

    // PRIVATE published past nights count nowhere.
    await credit(await pastEvent({ visibility: "PRIVATE", placeId: placeHere }), { humanId: act });
    await pastEvent({ visibility: "PRIVATE", orgId: null, humanId: act });
    // "Ana Presents": Ana is its OWNER, so her night on its lineup is ran, not played.
    const anaPresents = await newOrg("Ana Presents");
    await prisma.orgMember.create({ data: { orgId: anaPresents, humanId: act, role: "OWNER" } });
    await credit(await pastEvent({ orgId: anaPresents }), { humanId: act });
    // Ana Presents nights she is NOT on the lineup of: neither ran nor played.
    await pastEvent({ orgId: anaPresents, placeId: placeHere });
    await credit(await pastEvent({ orgId: anaPresents }), { humanId: await newHuman("Someone else") });
    // An org where Ana is only a VIEWER: her night there is still played.
    const crew = await newOrg("Venue Crew");
    await prisma.orgMember.create({ data: { orgId: crew, humanId: act, role: "VIEWER" } });
    await credit(await pastEvent({ orgId: crew }), { humanId: act });

    await credit(await pastEvent(), { orgId: band }); // band played
    const bandOwn = await pastEvent({ orgId: band });
    await credit(bandOwn, { orgId: band }); // band ran, not played

    const eventId = await newEvent({ placeId: placeHere });
    const call = await newPostedCall({ kind: "event", eventId });
    const t = (m: number) => new Date(now.getTime() - DAY + m * 60_000);
    const sAna = await submit(call.id, eventId, { humanId: act }, t(1));
    const sBand = await submit(call.id, eventId, { humanId: act, orgId: band }, t(2));
    const sNew = await submit(call.id, eventId, { humanId: await newHuman("New") }, t(3));
    const sGuest = await submit(call.id, eventId, { guest: "Guest" }, t(4));

    const cards = (await repo().listOpenCallReviewCards(listInput(call.id))).items;
    const by = (id: string) => cards.find((x) => x.submission.id === id)!;
    expect(by(sAna.id).traces).toEqual({ playedHereNights: 1, playedNights: 6, ranNights: 2 });
    expect(by(sAna.id).displayName).toBe("Ana");
    expect(by(sBand.id).traces).toEqual({ playedHereNights: 0, playedNights: 1, ranNights: 1 });
    expect(by(sBand.id).displayName).toBe("The Band");
    expect(by(sNew.id).traces).toEqual({ playedHereNights: 0, playedNights: 0, ranNights: 0 });
    expect(by(sGuest.id).traces).toBeNull();
    // Traces never reorder: still time applied.
    expect(cards.map((x) => x.submission.id)).toEqual([sAna.id, sBand.id, sNew.id, sGuest.id]);

    // Core's view of the same rows: New here, never zeros.
    const out = await listOpenCallApplications(deps(), { actorHumanId: organizerId, formId: call.id });
    expect(out.items.map((x) => x.traces)).toEqual([
      { newHere: false, playedHereNights: 1, playedNights: 6, ranNights: 2 },
      { newHere: false, playedHereNights: null, playedNights: 1, ranNights: 1 },
      { newHere: true },
      { newHere: true },
    ]);
  });

  test("series call: 'here' = the places of the series' materialised events", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const act = await newHuman("Series act");
    await credit(await pastEvent({ placeId: placeElsewhere }), { humanId: act });
    const series = await prisma.eventSeries.create({
      data: {
        ownerScope: "ORGANIZATION",
        ownerId: orgId,
        name: "Weekly",
        nameNormalized: `weekly ${randomUUID()}`,
        timezone: "America/Chicago",
        schedule: { kind: "FIXED_DATES", dates: [] },
      },
    });
    const night = await newEvent({ placeId: placeElsewhere });
    const o1 = await prisma.eventSeriesOccurrence.create({
      data: { seriesId: series.id, ordinal: 1, startsAt: new Date(now.getTime() + 2 * DAY), eventId: night, status: "GENERATED" },
    });
    const call = await newPostedCall({ kind: "series", seriesId: series.id });
    const s = await submit(call.id, null, { humanId: act }, new Date(), [{ occurrenceId: o1.id }]);
    const [card] = (await repo().listOpenCallReviewCards(listInput(call.id))).items;
    expect(card!.submission.id).toBe(s.id);
    expect(card!.traces).toEqual({ playedHereNights: 1, playedNights: 1, ranNights: 0 });
    const filtered = await repo().listOpenCallReviewCards(listInput(call.id, { filter: { dateId: o1.id } }));
    expect(filtered.items).toHaveLength(1);
  });

  test("first open: one guarded stamp under concurrency, and it locks the applicant's edit", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const token = "Q".repeat(43);
    const s = await submit(call.id, eventId, { guest: "Openme" }, new Date(), [], token);

    const results = await Promise.all(
      [1, 2, 3].map(() =>
        prisma!.$transaction((tx) =>
          makeEventApplicationsRepo(tx as unknown as PrismaClient).markOpenCallSubmissionOpened({
            submissionId: s.id,
            formId: call.id,
            openedAt: new Date(),
          }),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    // Wrong form id: never matches.
    const otherCall = await newPostedCall({ kind: "event", eventId: await newEvent() });
    const s2 = await submit(call.id, eventId, { guest: "Other" }, new Date());
    expect(
      await repo().markOpenCallSubmissionOpened({ submissionId: s2.id, formId: otherCall.id, openedAt: now }),
    ).toBe(false);

    // Core path end to end.
    const opened = await openOpenCallApplication(deps(), {
      actorHumanId: organizerId,
      formId: call.id,
      submissionId: s2.id,
    });
    expect(opened.firstOpen).toBe(true);
    const row = await prisma.eventApplicationSubmission.findUnique({ where: { id: s2.id } });
    expect(row!.openedAt).not.toBeNull();
    await expect(
      editOpenCallApplication(deps(), {
        auth: { kind: "token", token },
        answers: {},
        dateIds: [],
        isPrivate: false,
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_LOCKED" });

    // A first VOTE locks the edit too (stamped in the vote's transaction).
    const voteToken = "V".repeat(43);
    const s3 = await submit(call.id, eventId, { guest: "Voted" }, new Date(), [], voteToken);
    await castApplicationVote(deps(), {
      actorHumanId: organizerId,
      formId: call.id,
      submissionId: s3.id,
      vote: "YES",
    });
    const row3 = await prisma.eventApplicationSubmission.findUnique({ where: { id: s3.id } });
    expect(row3!.openedAt).not.toBeNull();
    await expect(
      editOpenCallApplication(deps(), {
        auth: { kind: "token", token: voteToken },
        answers: {},
        dateIds: [],
        isPrivate: false,
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_LOCKED" });
  });

  test("vote upsert: one row per (submission, human) under concurrency; change; clear", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const s = await submit(call.id, eventId, { guest: "Voteme" }, new Date());
    await Promise.all(
      (["YES", "NO", "MAYBE", "YES", "NO"] as const).map((vote) =>
        repo().setApplicationVote({ submissionId: s.id, humanId: organizerId, vote, at: new Date() }),
      ),
    );
    expect(await prisma.applicationVote.count({ where: { submissionId: s.id } })).toBe(1);
    await repo().setApplicationVote({ submissionId: s.id, humanId: organizerId, vote: "MAYBE", at: new Date() });
    let summary = await repo().getApplicationVoteSummary({ submissionId: s.id, viewerHumanId: organizerId });
    expect(summary).toEqual({ votes: { yes: 0, maybe: 1, no: 0 }, myVote: "MAYBE" });
    await repo().setApplicationVote({ submissionId: s.id, humanId: organizerId, vote: null, at: new Date() });
    summary = await repo().getApplicationVoteSummary({ submissionId: s.id, viewerHumanId: organizerId });
    expect(summary).toEqual({ votes: { yes: 0, maybe: 0, no: 0 }, myVote: null });
  });

  test("thread: oldest-first pages, monotonic read markers on the other side only", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const s = await submit(call.id, eventId, { guest: "Talker" }, new Date());
    const base = new Date(now.getTime() - HOUR);
    const at = (sec: number) => new Date(base.getTime() + sec * 1000);
    const a1 = await repo().createApplicationMessage({ submissionId: s.id, authorSide: "APPLICANT", authorHumanId: null, body: "a1", createdAt: at(1) });
    await repo().createApplicationMessage({ submissionId: s.id, authorSide: "ORGANIZER", authorHumanId: organizerId, body: "o1", createdAt: at(2) });
    await repo().createApplicationMessage({ submissionId: s.id, authorSide: "APPLICANT", authorHumanId: null, body: "a2", createdAt: at(3) });

    const p1 = await repo().listApplicationMessages({ submissionId: s.id, cursor: null, limit: 2 });
    const p2 = await repo().listApplicationMessages({ submissionId: s.id, cursor: p1.nextCursor, limit: 2 });
    expect([...p1.items, ...p2.items].map((m) => m.body)).toEqual(["a1", "o1", "a2"]);
    expect(p2.nextCursor).toBeNull();

    const firstStamp = new Date(now.getTime() - 30 * 60_000);
    expect(
      await repo().markApplicationMessagesRead({ submissionId: s.id, readerSide: "ORGANIZER", upToCreatedAt: at(2), readAt: firstStamp }),
    ).toBe(1);
    expect(
      await repo().markApplicationMessagesRead({ submissionId: s.id, readerSide: "ORGANIZER", upToCreatedAt: at(10), readAt: new Date() }),
    ).toBe(1);
    expect(
      await repo().markApplicationMessagesRead({ submissionId: s.id, readerSide: "ORGANIZER", upToCreatedAt: at(10), readAt: new Date() }),
    ).toBe(0);
    const rows = await prisma.applicationMessage.findMany({ where: { submissionId: s.id }, orderBy: { createdAt: "asc" } });
    expect(rows.find((r) => r.id === a1.id)!.readAt!.getTime()).toBe(firstStamp.getTime());
    expect(rows.find((r) => r.body === "o1")!.readAt).toBeNull();
    expect(
      await repo().markApplicationMessagesRead({ submissionId: s.id, readerSide: "APPLICANT", upToCreatedAt: at(10), readAt: new Date() }),
    ).toBe(1);
  });
});
