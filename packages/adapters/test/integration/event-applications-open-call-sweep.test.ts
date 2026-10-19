/**
 * Open calls v1 step 8 — the sweep-open-calls queries against a REAL
 * Postgres: which PENDING applications are due and why (backstop vs pulled,
 * incl. the one-remaining-date case, series, a cancelled materialised night),
 * the guarded flips, and the reconcile pages (window + keyset). The
 * container may be shared with other suites, so every assertion filters to
 * the rows this file created.
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

import { makeEventApplicationsRepo } from "../../src/db/prisma/event-applications";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

describe("Prisma adapters integration – open-call sweep", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let organizerId: string;
  let orgId: string;
  // Truncated to ms: Postgres timestamp(3) round-trips exactly.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  let counter = 0;
  const uniq = () => `${Date.now()}-${(counter += 1)}-${Math.random().toString(36).slice(2, 8)}`;
  const repo = () => makeEventApplicationsRepo(prisma!);

  const newEvent = async (overrides: Partial<Prisma.EventUncheckedCreateInput> = {}) => {
    const startsAt = (overrides.startsAt as Date | undefined) ?? new Date(now.getTime() + 10 * DAY);
    const event = await prisma!.event.create({
      data: {
        title: `Sweep night ${uniq()}`,
        endsAt: new Date(startsAt.getTime() + 3 * HOUR),
        status: "PUBLISHED",
        orgId,
        ...overrides,
        startsAt,
      } as Prisma.EventUncheckedCreateInput,
    });
    return event;
  };

  const newSeries = async (archivedAt: Date | null = null) =>
    prisma!.eventSeries.create({
      data: {
        ownerScope: "ORGANIZATION",
        ownerId: orgId,
        name: `Sweep series ${uniq()}`,
        nameNormalized: `sweep series ${uniq()}`,
        timezone: "America/Chicago",
        schedule: { kind: "FIXED_DATES", dates: [] },
        archivedAt,
      },
    });

  let ordinal = 0;
  const newOccurrence = async (
    seriesId: string,
    startsAt: Date,
    extra: { status?: "PLANNED" | "GENERATED" | "CANCELLED"; eventId?: string } = {},
  ) =>
    prisma!.eventSeriesOccurrence.create({
      data: {
        seriesId,
        ordinal: (ordinal += 1),
        startsAt,
        status: extra.status ?? (extra.eventId ? "GENERATED" : "PLANNED"),
        eventId: extra.eventId ?? null,
      },
    });

  const newEventDate = async (eventId: string, startsAt: Date, status: "SCHEDULED" | "CANCELLED" = "SCHEDULED") =>
    prisma!.eventDate.create({ data: { eventId, ordinal: (ordinal += 1), startsAt, status } });

  const newCall = async (anchor: { kind: "event"; eventId: string } | { kind: "series"; seriesId: string }) => {
    const call = await repo().upsertOpenCall({ anchor, payKind: "UNPAID", updatedByHumanId: organizerId });
    return repo().setOpenCallPosted({ formId: call.id, postedAt: now, postedByHumanId: organizerId });
  };

  /** A guest submission straight in the table (submit is covered elsewhere). */
  const newSubmission = async (
    formId: string,
    eventId: string | null,
    opts: {
      status?: "PENDING" | "WAITLISTED" | "APPROVED" | "REJECTED" | "EXPIRED";
      createdAt?: Date;
      reviewedAt?: Date | null;
      choices?: Array<{ occurrenceId: string } | { eventDateId: string }>;
    } = {},
  ) => {
    const token = uniq();
    const row = await prisma!.eventApplicationSubmission.create({
      data: {
        formId,
        eventId,
        guestName: `Guest ${token}`,
        contactEmail: `${token}@example.com`,
        statusTokenHash: sha256(token),
        status: opts.status ?? "PENDING",
        createdAt: opts.createdAt ?? new Date(now.getTime() - DAY),
        reviewedAt: opts.reviewedAt ?? null,
        dateChoices: { create: opts.choices ?? [] },
      },
    });
    return row.id;
  };

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl, max: 5 });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      organizerId = (await prisma.human.create({ data: { name: "Organizer", status: "ACTIVE" } })).id;
      orgId = (await prisma.organization.create({ data: { name: "Sweep Org", slug: `sweep-${uniq()}` } })).id;
      await prisma.orgMember.create({ data: { orgId, humanId: organizerId, role: "OWNER" } });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("open-call sweep integration setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  const due = async () => {
    const rows = await repo().listOpenCallSweepDue({ now, limit: 10_000 });
    return new Map(rows.map((r) => [r.submissionId, r]));
  };

  test("listOpenCallSweepDue: event calls (single date, cancelled, one-remaining-date, chosen dates)", async () => {
    if (runtimeError) throw runtimeError;

    const started = await newEvent({ startsAt: new Date(now.getTime() - HOUR) });
    const startedCall = await newCall({ kind: "event", eventId: started.id });
    const backstop = await newSubmission(startedCall.id, started.id);
    const picked = await newSubmission(startedCall.id, started.id, { status: "APPROVED" });

    const upcoming = await newEvent();
    const upcomingCall = await newCall({ kind: "event", eventId: upcoming.id });
    const notDue = await newSubmission(upcomingCall.id, upcoming.id);

    const cancelled = await newEvent({ status: "CANCELLED" });
    const cancelledCall = await newCall({ kind: "event", eventId: cancelled.id });
    const pulled = await newSubmission(cancelledCall.id, cancelled.id);

    // One date left when they applied → no stored choice; event.startsAt
    // (the first date) is long past.
    const multi = await newEvent({ startsAt: new Date(now.getTime() - 10 * DAY) });
    await newEventDate(multi.id, new Date(now.getTime() - 10 * DAY));
    const remaining = await newEventDate(multi.id, new Date(now.getTime() + 2 * DAY));
    const multiCall = await newCall({ kind: "event", eventId: multi.id });
    const implied = await newSubmission(multiCall.id, multi.id, { createdAt: new Date(now.getTime() - DAY) });
    void remaining;

    // The implied night was cancelled → pulled.
    const multiOff = await newEvent({ startsAt: new Date(now.getTime() - 10 * DAY) });
    await newEventDate(multiOff.id, new Date(now.getTime() - 10 * DAY));
    await newEventDate(multiOff.id, new Date(now.getTime() + 2 * DAY), "CANCELLED");
    const multiOffCall = await newCall({ kind: "event", eventId: multiOff.id });
    const impliedOff = await newSubmission(multiOffCall.id, multiOff.id, { createdAt: new Date(now.getTime() - DAY) });

    // Chosen dates: last one past → backstop; one still ahead → not due.
    const chosen = await newEvent({ startsAt: new Date(now.getTime() - 3 * DAY) });
    const d1 = await newEventDate(chosen.id, new Date(now.getTime() - 3 * DAY));
    const d2 = await newEventDate(chosen.id, new Date(now.getTime() - HOUR));
    const d3 = await newEventDate(chosen.id, new Date(now.getTime() + 3 * DAY));
    const chosenCall = await newCall({ kind: "event", eventId: chosen.id });
    const allPast = await newSubmission(chosenCall.id, chosen.id, {
      choices: [{ eventDateId: d1.id }, { eventDateId: d2.id }],
    });
    const oneAhead = await newSubmission(chosenCall.id, chosen.id, {
      choices: [{ eventDateId: d1.id }, { eventDateId: d3.id }],
    });

    const rows = await due();
    expect(rows.get(backstop)).toMatchObject({
      verdict: "backstop",
      formId: startedCall.id,
      eventId: started.id,
      seriesId: null,
      title: started.title,
    });
    expect(rows.has(picked)).toBe(false);
    expect(rows.has(notDue)).toBe(false);
    expect(rows.get(pulled)?.verdict).toBe("pulled");
    expect(rows.has(implied)).toBe(false);
    expect(rows.get(impliedOff)?.verdict).toBe("pulled");
    expect(rows.get(allPast)?.verdict).toBe("backstop");
    expect(rows.has(oneAhead)).toBe(false);
  });

  test("listOpenCallSweepDue: series calls (per application, cancelled materialised night, archived)", async () => {
    if (runtimeError) throw runtimeError;

    const series = await newSeries();
    const past = await newOccurrence(series.id, new Date(now.getTime() - HOUR));
    const ahead = await newOccurrence(series.id, new Date(now.getTime() + 5 * DAY));
    const offOcc = await newOccurrence(series.id, new Date(now.getTime() + 2 * DAY), { status: "CANCELLED" });
    const night = await newEvent({ status: "CANCELLED", startsAt: new Date(now.getTime() + 3 * DAY) });
    const cancelledNight = await newOccurrence(series.id, night.startsAt, { eventId: night.id, status: "GENERATED" });
    const call = await newCall({ kind: "series", seriesId: series.id });

    const answered = await newSubmission(call.id, null, { choices: [{ occurrenceId: past.id }] });
    const waiting = await newSubmission(call.id, null, {
      choices: [{ occurrenceId: past.id }, { occurrenceId: ahead.id }],
    });
    const allOff = await newSubmission(call.id, null, {
      choices: [{ occurrenceId: offOcc.id }, { occurrenceId: cancelledNight.id }],
    });
    const noChoice = await newSubmission(call.id, null);

    const archived = await newSeries(now);
    const archivedAhead = await newOccurrence(archived.id, new Date(now.getTime() + DAY));
    const archivedCall = await newCall({ kind: "series", seriesId: archived.id });
    const shelved = await newSubmission(archivedCall.id, null, { choices: [{ occurrenceId: archivedAhead.id }] });

    const rows = await due();
    expect(rows.get(answered)).toMatchObject({ verdict: "backstop", seriesId: series.id, eventId: null, title: series.name });
    expect(rows.has(waiting)).toBe(false);
    expect(rows.get(allOff)?.verdict).toBe("pulled");
    expect(rows.get(noChoice)?.verdict).toBe("pulled");
    expect(rows.get(shelved)?.verdict).toBe("pulled");

    // Oldest first.
    const ordered = (await repo().listOpenCallSweepDue({ now, limit: 10_000 })).map((r) => r.createdAt.getTime());
    expect([...ordered].sort((a, b) => a - b)).toEqual(ordered);
  });

  test("settlePendingOpenCallSubmissions flips only PENDING rows and returns what it flipped", async () => {
    if (runtimeError) throw runtimeError;
    const event = await newEvent({ startsAt: new Date(now.getTime() - HOUR) });
    const call = await newCall({ kind: "event", eventId: event.id });
    const a = await newSubmission(call.id, event.id);
    const picked = await newSubmission(call.id, event.id, { status: "APPROVED" });

    const out = await repo().settlePendingOpenCallSubmissions({
      submissionIds: [a, picked],
      status: "REJECTED",
      reviewedAt: now,
    });
    expect(out.ids).toEqual([a]);
    const rows = await prisma!.eventApplicationSubmission.findMany({
      where: { id: { in: [a, picked] } },
      select: { id: true, status: true, reviewedAt: true },
    });
    expect(rows.find((r) => r.id === a)).toMatchObject({ status: "REJECTED", reviewedAt: now });
    expect(rows.find((r) => r.id === picked)?.status).toBe("APPROVED");

    // A second run (or an overlapping one) flips nothing.
    const again = await repo().settlePendingOpenCallSubmissions({
      submissionIds: [a],
      status: "EXPIRED",
      reviewedAt: now,
    });
    expect(again.ids).toEqual([]);
    expect(await repo().settlePendingOpenCallSubmissions({ submissionIds: [], status: "EXPIRED", reviewedAt: now })).toEqual({ ids: [] });
  });

  test("expireUndecidedOpenCallSubmissions expires PENDING and WAITLISTED on one form only", async () => {
    if (runtimeError) throw runtimeError;
    const event = await newEvent({ status: "DRAFT" });
    const call = await newCall({ kind: "event", eventId: event.id });
    const pending = await newSubmission(call.id, event.id);
    const waiting = await newSubmission(call.id, event.id, { status: "WAITLISTED" });
    const picked = await newSubmission(call.id, event.id, { status: "APPROVED" });
    const other = await newEvent();
    const otherCall = await newCall({ kind: "event", eventId: other.id });
    const elsewhere = await newSubmission(otherCall.id, other.id);

    const out = await repo().expireUndecidedOpenCallSubmissions({ formId: call.id, reviewedAt: now });
    expect(new Set(out.ids)).toEqual(new Set([pending, waiting]));
    const statuses = await prisma!.eventApplicationSubmission.findMany({
      where: { id: { in: [pending, waiting, picked, elsewhere] } },
      select: { id: true, status: true },
    });
    expect(Object.fromEntries(statuses.map((r) => [r.id, r.status]))).toEqual({
      [pending]: "EXPIRED",
      [waiting]: "EXPIRED",
      [picked]: "APPROVED",
      [elsewhere]: "PENDING",
    });
  });

  test("listOpenCallSubmissionsByFormStatus: one form, the asked statuses, id keyset paging", async () => {
    if (runtimeError) throw runtimeError;
    const event = await newEvent({ status: "DRAFT" });
    const call = await newCall({ kind: "event", eventId: event.id });
    const rejected = await newSubmission(call.id, event.id, { status: "REJECTED", reviewedAt: now });
    const expired = await newSubmission(call.id, event.id, { status: "EXPIRED", reviewedAt: now });
    const rejected2 = await newSubmission(call.id, event.id, { status: "REJECTED", reviewedAt: now });
    await newSubmission(call.id, event.id, { status: "APPROVED" });
    await newSubmission(call.id, event.id);
    const other = await newEvent();
    const otherCall = await newCall({ kind: "event", eventId: other.id });
    await newSubmission(otherCall.id, other.id, { status: "REJECTED", reviewedAt: now });

    const all = await repo().listOpenCallSubmissionsByFormStatus({
      formId: call.id,
      statuses: ["REJECTED", "EXPIRED"],
      afterId: null,
      limit: 100,
    });
    const want = [
      { submissionId: rejected, status: "REJECTED" },
      { submissionId: expired, status: "EXPIRED" },
      { submissionId: rejected2, status: "REJECTED" },
    ].sort((a, b) => (a.submissionId < b.submissionId ? -1 : 1));
    expect(all).toEqual(want);

    const page = await repo().listOpenCallSubmissionsByFormStatus({
      formId: call.id,
      statuses: ["REJECTED", "EXPIRED"],
      afterId: want[0]!.submissionId,
      limit: 1,
    });
    expect(page).toEqual([want[1]]);

    const onlyExpired = await repo().listOpenCallSubmissionsByFormStatus({
      formId: call.id,
      statuses: ["EXPIRED"],
      afterId: null,
      limit: 100,
    });
    expect(onlyExpired).toEqual([{ submissionId: expired, status: "EXPIRED" }]);
  });

  test("listOpenCallNoticeReconcileRows: kind, window and keyset paging", async () => {
    if (runtimeError) throw runtimeError;
    const event = await newEvent();
    const call = await newCall({ kind: "event", eventId: event.id });
    const at = (ms: number) => new Date(now.getTime() - ms);
    const r1 = await newSubmission(call.id, event.id, { status: "REJECTED", reviewedAt: at(3 * HOUR) });
    const r2 = await newSubmission(call.id, event.id, { status: "REJECTED", reviewedAt: at(2 * HOUR) });
    const r3 = await newSubmission(call.id, event.id, { status: "REJECTED", reviewedAt: at(HOUR) });
    const tooOld = await newSubmission(call.id, event.id, { status: "REJECTED", reviewedAt: at(20 * DAY) });
    const tooNew = await newSubmission(call.id, event.id, { status: "REJECTED", reviewedAt: at(60_000) });
    const expired = await newSubmission(call.id, event.id, { status: "EXPIRED", reviewedAt: at(HOUR) });
    const pending = await newSubmission(call.id, event.id, { createdAt: at(HOUR) });

    const window = { since: at(14 * DAY), until: at(10 * 60_000) };
    const mine = (rows: Array<{ submissionId: string }>) =>
      rows.map((r) => r.submissionId).filter((id) => [r1, r2, r3, tooOld, tooNew, expired, pending].includes(id));

    const all = await repo().listOpenCallNoticeReconcileRows({ kind: "not-this-time", ...window, after: null, limit: 10_000 });
    expect(mine(all)).toEqual([r1, r2, r3]);
    const r1Row = all.find((r) => r.submissionId === r1)!;
    expect(r1Row).toMatchObject({ formId: call.id, eventId: event.id, seriesId: null, title: event.title, at: at(3 * HOUR) });

    // Keyset: strictly after r1 → r2, r3 (and nothing at or before r1).
    const page = await repo().listOpenCallNoticeReconcileRows({
      kind: "not-this-time",
      ...window,
      after: { at: r1Row.at, submissionId: r1 },
      limit: 10_000,
    });
    expect(mine(page)).toEqual([r2, r3]);
    expect(page.every((r) => r.at.getTime() >= r1Row.at.getTime())).toBe(true);

    const pulled = await repo().listOpenCallNoticeReconcileRows({ kind: "pulled", ...window, after: null, limit: 10_000 });
    expect(mine(pulled)).toEqual([expired]);
    const received = await repo().listOpenCallNoticeReconcileRows({ kind: "received", ...window, after: null, limit: 10_000 });
    expect(mine(received)).toEqual([pending]);
  });

  test("listOpenCallNoticeReconcileRows: rows sharing one reviewedAt page by id from a cursor inside the group", async () => {
    if (runtimeError) throw runtimeError;
    const event = await newEvent();
    const call = await newCall({ kind: "event", eventId: event.id });
    // settleDue / close / expireUndecided stamp a whole batch with one `now`.
    const shared = new Date(now.getTime() - 5 * HOUR - 137);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await newSubmission(call.id, event.id, { status: "REJECTED", reviewedAt: shared }));
    }
    ids.sort();
    const window = { since: new Date(now.getTime() - 14 * DAY), until: new Date(now.getTime() - 10 * 60_000) };
    const mine = (rows: Array<{ submissionId: string }>) =>
      rows.map((r) => r.submissionId).filter((id) => ids.includes(id));

    const all = await repo().listOpenCallNoticeReconcileRows({ kind: "not-this-time", ...window, after: null, limit: 10_000 });
    expect(mine(all)).toEqual(ids);

    // Cursor on the 2nd row of the group: only the later ids at that same
    // instant (the `at = x AND id > y` branch), never the cursor row or before.
    const rest = await repo().listOpenCallNoticeReconcileRows({
      kind: "not-this-time",
      ...window,
      after: { at: shared, submissionId: ids[1]! },
      limit: 10_000,
    });
    expect(mine(rest)).toEqual([ids[2], ids[3]]);
    expect(rest.some((r) => r.at.getTime() < shared.getTime())).toBe(false);

    // One row at a time through the group (window pinned to that instant).
    const pinned = { since: shared, until: shared };
    const walked: string[] = [];
    let after: { at: Date; submissionId: string } | null = { at: shared, submissionId: ids[0]! };
    for (;;) {
      const page = await repo().listOpenCallNoticeReconcileRows({ kind: "not-this-time", ...pinned, after, limit: 1 });
      if (page.length === 0) break;
      const row = page[0]!;
      expect(row.at.getTime()).toBe(shared.getTime());
      walked.push(row.submissionId);
      after = { at: row.at, submissionId: row.submissionId };
    }
    expect(mine(walked.map((submissionId) => ({ submissionId })))).toEqual([ids[1], ids[2], ids[3]]);
  });

  test("listOpenCallsByPoster: a series whose only upcoming night's event was cancelled is not listed", async () => {
    if (runtimeError) throw runtimeError;
    const series = await newSeries();
    const night = await newEvent({ status: "CANCELLED", startsAt: new Date(now.getTime() + 2 * DAY) });
    await newOccurrence(series.id, night.startsAt, { eventId: night.id, status: "GENERATED" });
    const call = await newCall({ kind: "series", seriesId: series.id });

    const listed = await repo().listOpenCallsByPoster({ poster: { kind: "org", orgId }, now, limit: 200 });
    expect(listed.map((c) => c.formId)).not.toContain(call.id);

    await newOccurrence(series.id, new Date(now.getTime() + 4 * DAY));
    const relisted = await repo().listOpenCallsByPoster({ poster: { kind: "org", orgId }, now, limit: 200 });
    expect(relisted.map((c) => c.formId)).toContain(call.id);
  });
});
