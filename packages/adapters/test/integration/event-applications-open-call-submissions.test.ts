/**
 * Open calls v1 step 4 — open-call APPLICATIONS against a REAL Postgres: the
 * submit transaction under FOR KEY SHARE racing a close, date-choice
 * uniqueness, the peer-list query's filtering, the token-hash lookup and the
 * guarded edit / withdraw writes. A mocked Prisma can prove none of these.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import { submitOpenCallApplication } from "@th/core/use-cases/events/open-calls/submit-open-call-application";
import { deriveStatusToken } from "@th/core/use-cases/events/open-calls/_shared/status-token";
import { getOpenCallApplicationStatus } from "@th/core/use-cases/events/open-calls/get-open-call-application-status";
import { editOpenCallApplication } from "@th/core/use-cases/events/open-calls/edit-open-call-application";
import { setOpenCallApplicationPrivacy } from "@th/core/use-cases/events/open-calls/set-open-call-application-privacy";

import { createPrismaRepos } from "../../src/db/prisma";
import { makeEventApplicationsRepo } from "../../src/db/prisma/event-applications";

const DAY = 24 * 60 * 60 * 1000;
const STATUS_TOKEN_SECRET = "integration-open-call-status-secret-0123456789";
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

describe("Prisma adapters integration – open-call applications", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let organizerId: string;
  let orgId: string;
  const now = new Date();
  let tokenCounter = 0;
  const nextHash = () => sha256(`token-${(tokenCounter += 1)}-${Math.random()}`);

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

  const newPostedCall = async (anchor: { kind: "event"; eventId: string } | { kind: "series"; seriesId: string }) => {
    const repo = makeEventApplicationsRepo(prisma!);
    const call = await repo.upsertOpenCall({ anchor, payKind: "UNPAID", updatedByHumanId: organizerId });
    return repo.setOpenCallPosted({ formId: call.id, postedAt: now, postedByHumanId: organizerId });
  };

  const newHuman = async (name = "Act") =>
    (await prisma!.human.create({ data: { name, status: "ACTIVE" } })).id;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl, max: 10 });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      organizerId = await newHuman("Organizer");
      orgId = (
        await prisma.organization.create({ data: { name: "Basement Org", slug: "basement-org-oca" } })
      ).id;
      await prisma.orgMember.create({ data: { orgId, humanId: organizerId, role: "OWNER" } });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("open-call applications integration setup failed:", error);
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

  test("core submit waits on a close in flight (FOR KEY SHARE vs FOR UPDATE) and is refused after it", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const applicant = await newHuman();

    const closed = gate();
    const release = gate();
    const close = prisma.$transaction(
      async (tx) => {
        const txRepo = makeEventApplicationsRepo(tx as unknown as PrismaClient);
        await txRepo.lockOpenCallForClose(call.id);
        await txRepo.setOpenCallClosed({ formId: call.id, closedAt: new Date(), closedByHumanId: organizerId });
        await txRepo.rejectPendingOpenCallSubmissions({ formId: call.id, reviewedAt: new Date() });
        closed.open();
        await release.opened;
      },
      { timeout: 30_000 },
    );
    await closed.opened;

    const deps = {
      repos: createPrismaRepos(prisma),
      clock: { now: () => new Date() },
      statusTokenSecret: STATUS_TOKEN_SECRET,
    };
    const submit = submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: applicant,
    });
    expect(await settlesWithin(submit, 700)).toBe("blocked");
    release.open();
    await close;
    await expect(submit).rejects.toMatchObject({ code: "OPEN_CALL_CLOSED" });
    expect(await prisma.eventApplicationSubmission.count({ where: { formId: call.id } })).toBe(0);
  });

  test("core submit end to end: series call, occurrences stored, token hash only, status by token", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const series = await prisma.eventSeries.create({
      data: {
        ownerScope: "ORGANIZATION",
        ownerId: orgId,
        name: "Tuesday series",
        nameNormalized: "tuesday series oca",
        timezone: "America/Chicago",
        schedule: { kind: "FIXED_DATES", dates: [] },
      },
    });
    const materialised = await newEvent({ title: "Night 1" });
    const o1 = await prisma.eventSeriesOccurrence.create({
      data: { seriesId: series.id, ordinal: 1, startsAt: new Date(now.getTime() + 2 * DAY), eventId: materialised, status: "GENERATED" },
    });
    const o2 = await prisma.eventSeriesOccurrence.create({
      data: { seriesId: series.id, ordinal: 2, startsAt: new Date(now.getTime() + 9 * DAY), status: "PLANNED" },
    });
    const call = await newPostedCall({ kind: "series", seriesId: series.id });
    const deps = {
      repos: createPrismaRepos(prisma),
      clock: { now: () => new Date() },
      statusTokenSecret: STATUS_TOKEN_SECRET,
    };

    await expect(
      submitOpenCallApplication(deps, {
        publicId: call.publicId,
        guest: { name: "The Moths", email: "moths@example.com" },
        dateIds: [materialised],
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_DATE_INVALID" });

    const out = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      guest: { name: "The Moths", email: "Moths@Example.com", url: "https://moths.example" },
      dateIds: [o2.id, o1.id],
    });
    const row = await prisma.eventApplicationSubmission.findUniqueOrThrow({
      where: { id: out.submissionId! },
      include: { dateChoices: true },
    });
    expect(row).toMatchObject({
      formId: call.id,
      eventId: null,
      humanId: null,
      contactEmail: "moths@example.com",
      statusTokenHash: sha256(out.statusToken!),
    });
    expect(row.dateChoices.map((c) => [c.occurrenceId, c.eventId, c.eventDateId]).sort()).toEqual(
      [
        [o1.id, null, null],
        [o2.id, null, null],
      ].sort(),
    );

    // A guest duplicate (another case of the same email) creates nothing.
    const dup = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      guest: { name: "Imposter", email: "MOTHS@example.com" },
      dateIds: [o1.id],
    });
    expect(dup.outcome).toBe("guest_duplicate");
    expect(await prisma.eventApplicationSubmission.count({ where: { formId: call.id } })).toBe(1);

    const status = await getOpenCallApplicationStatus(deps, {
      auth: { kind: "token", token: out.statusToken! },
    });
    expect(status.application.dateChoices.map((c) => c.id)).toEqual([o1.id, o2.id]);
    expect(status.call.anchor).toBe("series");
  });

  test("date choices: one row per (submission, target); the CHECK demands exactly one target", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const d1 = await prisma.eventDate.create({
      data: { eventId, ordinal: 1, startsAt: new Date(now.getTime() + 2 * DAY) },
    });
    const base = {
      formId: call.id,
      eventId,
      applyingAsOrgId: null,
      guestName: null,
      guestUrl: null,
      contactEmail: null,
      answers: {},
      questionsSnapshot: {},
      isPrivate: false,
      submittedAt: new Date(),
    };
    await expect(
      repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null, 
        ...base,
        humanId: await newHuman(),
        statusTokenHash: nextHash(),
        dateChoices: [{ eventDateId: d1.id }, { eventDateId: d1.id }],
      }),
    ).rejects.toThrow(/OpenCallDateChoice_submissionId_eventDateId_key|Unique constraint/);
    // Nothing half-written: the nested create is one statement set.
    expect(await prisma.eventApplicationSubmission.count({ where: { formId: call.id } })).toBe(0);

    const ok = await repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null, 
      ...base,
      humanId: await newHuman(),
      statusTokenHash: nextHash(),
      dateChoices: [{ eventDateId: d1.id }],
    });
    expect(ok.dateChoices).toEqual([
      { eventId: null, occurrenceId: null, eventDateId: d1.id, startsAt: d1.startsAt },
    ]);
    await expect(
      prisma.$executeRaw`INSERT INTO "OpenCallDateChoice" ("id","submissionId","eventId","eventDateId")
        VALUES (gen_random_uuid()::text, ${ok.id}, ${eventId}, ${d1.id})`,
    ).rejects.toThrow(/OpenCallDateChoice_one_target_check/);
  });

  test("duplicate open application maps to duplicate_open_application; re-apply after WITHDRAWN works", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const human = await newHuman();
    const input = {
      formId: call.id,
      eventId,
      humanId: human,
      applyingAsOrgId: null,
      guestName: null,
      guestUrl: null,
      contactEmail: null,
      answers: {},
      questionsSnapshot: {},
      isPrivate: false,
      dateChoices: [],
      submittedAt: new Date(),
    };
    const first = await repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null,  ...input, statusTokenHash: nextHash() });
    await expect(
      repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null,  ...input, statusTokenHash: nextHash() }),
    ).rejects.toMatchObject({ code: "duplicate_open_application" });
    // A token-hash collision is a bug, not a duplicate application.
    const other = await newHuman();
    await expect(
      repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null,  ...input, humanId: other, statusTokenHash: first.statusTokenHash! }),
    ).rejects.not.toMatchObject({ code: "duplicate_open_application" });

    expect(await repo.withdrawPendingOpenCallSubmission({ submissionId: first.id, formId: call.id })).toBe(true);
    expect(await repo.withdrawPendingOpenCallSubmission({ submissionId: first.id, formId: call.id })).toBe(false);
    const again = await repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null,  ...input, statusTokenHash: nextHash() });
    expect(again.status).toBe("PENDING");
  });

  test("token hash lookup: unique index, PERFORM only; by id is PERFORM only too", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const hash = nextHash();
    const sub = await repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null, 
      formId: call.id,
      eventId,
      humanId: null,
      applyingAsOrgId: null,
      guestName: "Guest",
      guestUrl: null,
      contactEmail: "g@example.com",
      answers: {},
      questionsSnapshot: {},
      isPrivate: false,
      statusTokenHash: hash,
      dateChoices: [],
      submittedAt: new Date(),
    });
    expect((await repo.getOpenCallSubmissionByTokenHash(hash))?.id).toBe(sub.id);
    expect(await repo.getOpenCallSubmissionByTokenHash(nextHash())).toBeNull();

    const attend = await repo.ensureForm({ eventId, purpose: "ATTEND" });
    const attendHash = nextHash();
    const attendSub = await prisma.eventApplicationSubmission.create({
      data: { formId: attend.id, eventId, humanId: await newHuman(), statusTokenHash: attendHash, answers: {} },
    });
    expect(await repo.getOpenCallSubmissionByTokenHash(attendHash)).toBeNull();
    expect(await repo.getOpenCallSubmissionById(attendSub.id)).toBeNull();
    // The guarded writes are keyed by (id, formId): an attendee row named
    // with the PERFORM form never matches.
    expect(
      await repo.withdrawPendingOpenCallSubmission({ submissionId: attendSub.id, formId: call.id }),
    ).toBe(false);
    expect(
      await repo.updateOpenCallSubmission({
        submissionId: attendSub.id,
        formId: call.id,
        answers: { x: 1 },
        questionsSnapshot: {},
        isPrivate: true,
        dateChoices: [],
      }),
    ).toBeNull();
  });

  test("updateOpenCallSubmission: replaces choices atomically; refused once opened or decided", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const d1 = await prisma.eventDate.create({ data: { eventId, ordinal: 1, startsAt: new Date(now.getTime() + 2 * DAY) } });
    const d2 = await prisma.eventDate.create({ data: { eventId, ordinal: 2, startsAt: new Date(now.getTime() + 3 * DAY) } });
    const sub = await repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null, 
      formId: call.id,
      eventId,
      humanId: await newHuman(),
      applyingAsOrgId: null,
      guestName: null,
      guestUrl: null,
      contactEmail: null,
      answers: { a: "1" },
      questionsSnapshot: {},
      isPrivate: false,
      statusTokenHash: nextHash(),
      dateChoices: [{ eventDateId: d1.id }],
      submittedAt: new Date(),
    });
    const edited = await prisma.$transaction((tx) =>
      makeEventApplicationsRepo(tx as unknown as PrismaClient).updateOpenCallSubmission({
        submissionId: sub.id,
        formId: call.id,
        answers: { a: "2" },
        questionsSnapshot: {},
        isPrivate: true,
        dateChoices: [{ eventDateId: d2.id }],
      }),
    );
    expect(edited).toMatchObject({ answers: { a: "2" }, isPrivate: true });
    expect(edited!.dateChoices.map((c) => c.eventDateId)).toEqual([d2.id]);

    await prisma.eventApplicationSubmission.update({ where: { id: sub.id }, data: { openedAt: new Date() } });
    expect(
      await repo.updateOpenCallSubmission({
        submissionId: sub.id,
        formId: call.id,
        answers: { a: "3" },
        questionsSnapshot: {},
        isPrivate: false,
        dateChoices: [{ eventDateId: d1.id }],
      }),
    ).toBeNull();
    const after = await repo.getOpenCallSubmissionById(sub.id);
    expect(after).toMatchObject({ answers: { a: "2" } });
    expect(after!.dateChoices.map((c) => c.eventDateId)).toEqual([d2.id]);
  });

  test("listOpenCallPeers filters private, withdrawn, self and banned in the query; display fields only", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    let n = 0;
    const mk = async (data: Partial<Prisma.EventApplicationSubmissionUncheckedCreateInput>) =>
      prisma!.eventApplicationSubmission.create({
        data: {
          formId: call.id,
          eventId,
          answers: { pitch: "secret" },
          createdAt: new Date(now.getTime() + (n += 1) * 1000),
          ...data,
        },
      });

    const meId = await newHuman("Me");
    const me = await mk({ humanId: meId });
    const paged = await newHuman("Paged Person");
    await prisma.entityPage.create({
      data: { ownerType: "HUMAN", ownerId: paged, slug: "paged-person-oca", displayName: "Paged Page", avatarUrl: "https://img/p.png" },
    });
    await mk({ humanId: paged, status: "REJECTED" });
    const hidden = await newHuman("Hidden Page Person");
    await prisma.entityPage.create({
      data: { ownerType: "HUMAN", ownerId: hidden, slug: "hidden-oca", visibility: "PRIVATE", avatarUrl: "https://img/h.png" },
    });
    await mk({ humanId: hidden });
    const band = await prisma.organization.create({ data: { name: "The Band", slug: "the-band-oca" } });
    await mk({ humanId: await newHuman("Band Member"), applyingAsOrgId: band.id, status: "APPROVED" });
    await mk({ guestName: "Guest Act", guestUrl: "https://guest.example", contactEmail: "guest@example.com" });
    await mk({ humanId: await newHuman("Private Person"), isPrivate: true });
    await mk({ humanId: await newHuman("Withdrawn Person"), status: "WITHDRAWN" });
    const bannedHuman = (
      await prisma.human.create({ data: { name: "Banned Person", status: "BANNED" } })
    ).id;
    await mk({ humanId: bannedHuman });
    // Another call's applicant never shows.
    const otherCall = await newPostedCall({ kind: "event", eventId: await newEvent() });
    await prisma.eventApplicationSubmission.create({
      data: { formId: otherCall.id, eventId: otherCall.eventId, humanId: await newHuman("Elsewhere"), answers: {} },
    });

    const peers = await repo.listOpenCallPeers({
      formId: call.id,
      viewer: { humanId: meId, applyingAsOrgId: null, contactEmail: null },
      limit: 50,
    });
    expect(me.id).toBeDefined();
    const names = peers.map((p) => p.name);
    expect(names.slice(0, 4)).toEqual(["Paged Page", "Hidden Page Person", "The Band", "Guest Act"]);
    expect(names).not.toContain("Me");
    expect(names).not.toContain("Private Person");
    expect(names).not.toContain("Withdrawn Person");
    expect(names).not.toContain("Elsewhere");
    expect(names).not.toContain("Banned Person");
    expect(names).toHaveLength(4);
    expect(peers[0]).toEqual({ kind: "human", name: "Paged Page", photoUrl: "https://img/p.png", pageSlug: "paged-person-oca", url: null });
    // A PRIVATE page lends neither photo nor slug.
    expect(peers[1]).toEqual({ kind: "human", name: "Hidden Page Person", photoUrl: null, pageSlug: null, url: null });
    expect(peers[2]).toMatchObject({ kind: "org", name: "The Band" });
    expect(peers[3]).toEqual({ kind: "guest", name: "Guest Act", photoUrl: null, pageSlug: null, url: "https://guest.example" });
    for (const p of peers) {
      expect(Object.keys(p).sort()).toEqual(["kind", "name", "pageSlug", "photoUrl", "url"]);
    }
    expect(JSON.stringify(peers)).not.toMatch(/secret|guest@example\.com|REJECTED|APPROVED/);
  });

  test("listOpenCallSubmissionsByHuman: own PERFORM applications only, newest first, with titles", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const human = await newHuman();
    const e1 = await newEvent({ title: "First night" });
    const e2 = await newEvent({ title: "Second night" });
    const c1 = await newPostedCall({ kind: "event", eventId: e1 });
    const c2 = await newPostedCall({ kind: "event", eventId: e2 });
    const attend = await repo.ensureForm({ eventId: e1, purpose: "ATTEND" });
    await prisma.eventApplicationSubmission.create({ data: { formId: attend.id, eventId: e1, humanId: human, answers: {} } });
    await prisma.eventApplicationSubmission.create({
      data: { formId: c1.id, eventId: e1, humanId: human, answers: {}, status: "REJECTED", createdAt: new Date(now.getTime() - DAY) },
    });
    await prisma.eventApplicationSubmission.create({
      data: { formId: c2.id, eventId: e2, humanId: human, answers: {}, applyingAsOrgId: orgId },
    });
    const mine = await repo.listOpenCallSubmissionsByHuman({ humanId: human, orgIds: [orgId], limit: 10 });
    expect(mine.map((m) => [m.title, m.status, m.applyingAsOrgName])).toEqual([
      ["Second night", "PENDING", "Basement Org"],
      ["First night", "REJECTED", null],
    ]);
    expect(mine[0]).toMatchObject({ publicId: c2.publicId, anchor: { kind: "event", eventId: e2 } });
    // The org row follows the ORG, not the submitter: without the org (they
    // left it) it is gone; another member of the org sees it.
    const departed = await repo.listOpenCallSubmissionsByHuman({ humanId: human, orgIds: [], limit: 10 });
    expect(departed.map((m) => m.title)).toEqual(["First night"]);
    const bandmate = await newHuman();
    const theirs = await repo.listOpenCallSubmissionsByHuman({ humanId: bandmate, orgIds: [orgId], limit: 10 });
    expect(theirs.map((m) => m.title)).toEqual(["Second night"]);
  });

  // ── Review round 1 ────────────────────────────────────────────────────

  test("Q42 migration: one open application per ENTITY — self + two orgs; a second member for the same org is a duplicate; ATTEND unchanged", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const person = await newHuman("Three Bands");
    const bandA = (await prisma.organization.create({ data: { name: "Band A", slug: "band-a-q42" } })).id;
    const bandB = (await prisma.organization.create({ data: { name: "Band B", slug: "band-b-q42" } })).id;
    const base = {
      formId: call.id,
      eventId,
      guestName: null,
      guestUrl: null,
      contactEmail: null,
      answers: {},
      questionsSnapshot: {},
      isPrivate: false,
      dateChoices: [],
      submittedAt: new Date(),
    };
    for (const applyingAsOrgId of [null, bandA, bandB]) {
      await repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null,  ...base, humanId: person, applyingAsOrgId, statusTokenHash: nextHash() });
    }
    expect(
      await prisma.eventApplicationSubmission.count({ where: { formId: call.id, humanId: person, status: "PENDING" } }),
    ).toBe(3);
    // Self again: open_human_key.
    await expect(
      repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null,  ...base, humanId: person, applyingAsOrgId: null, statusTokenHash: nextHash() }),
    ).rejects.toMatchObject({ code: "duplicate_open_application" });
    // Another member for Band A: open_org_key, whoever submits.
    const bandmate = await newHuman("Bandmate");
    await expect(
      repo.createOpenCallSubmission({ id: randomUUID(), contactLocale: null,  ...base, humanId: bandmate, applyingAsOrgId: bandA, statusTokenHash: nextHash() }),
    ).rejects.toMatchObject({ code: "duplicate_open_application" });
    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'EventApplicationSubmission' AND indexname LIKE '%open_%_key'`;
    const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
    expect(byName.get("EventApplicationSubmission_open_human_key")).toMatch(/"applyingAsOrgId" IS NULL/);
    expect(byName.get("EventApplicationSubmission_open_org_key")).toMatch(/\("formId", "applyingAsOrgId"\)/);

    // ATTEND dedupe is unchanged: one open attendee application per human.
    const attend = await repo.ensureForm({ eventId, purpose: "ATTEND" });
    await repo.createSubmission({ formId: attend.id, eventId, humanId: person, answers: {}, submittedAt: new Date() });
    await expect(
      repo.createSubmission({ formId: attend.id, eventId, humanId: person, answers: {}, submittedAt: new Date() }),
    ).rejects.toMatchObject({ code: "duplicate_open_application" });
    expect(await repo.findOpenSubmission({ formId: attend.id, humanId: person })).not.toBeNull();
  });

  test("peer list: one entry per identity across REJECTED + PENDING re-applications; none for the viewer's identity", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    let n = 0;
    const mk = (data: Partial<Prisma.EventApplicationSubmissionUncheckedCreateInput>) =>
      prisma!.eventApplicationSubmission.create({
        data: { formId: call.id, eventId, answers: {}, createdAt: new Date(now.getTime() + (n += 1) * 1000), ...data },
      });
    const viewer = await newHuman("Viewer");
    const viewerBand = (await prisma.organization.create({ data: { name: "Viewer Band", slug: "viewer-band-oca" } })).id;
    const repeat = await newHuman("Repeat Person");
    const band = (await prisma.organization.create({ data: { name: "Repeat Band", slug: "repeat-band-oca" } })).id;

    await mk({ humanId: repeat, status: "REJECTED" });
    await mk({ humanId: await newHuman("Member One"), applyingAsOrgId: band, status: "REJECTED" });
    await mk({ guestName: "Repeat Guest", contactEmail: "repeat@example.com", status: "REJECTED" });
    await mk({ humanId: repeat });
    await mk({ humanId: await newHuman("Member Two"), applyingAsOrgId: band });
    await mk({ guestName: "Repeat Guest", contactEmail: "REPEAT@example.com" });
    // The viewer: applying as their band now, after an earlier rejected self
    // application and a rejected band application.
    await mk({ humanId: viewer, status: "REJECTED" });
    await mk({ humanId: viewer, applyingAsOrgId: viewerBand, status: "REJECTED" });
    await mk({ humanId: await newHuman("Viewer Bandmate"), applyingAsOrgId: viewerBand });

    const peers = await repo.listOpenCallPeers({
      formId: call.id,
      viewer: { humanId: viewer, applyingAsOrgId: viewerBand, contactEmail: null },
      limit: 50,
    });
    expect(peers.map((p) => `${p.kind}:${p.name}`)).toEqual([
      "human:Repeat Person",
      "org:Repeat Band",
      "guest:Repeat Guest",
    ]);

    // A guest viewer: every row with their email (any case) is excluded.
    const asGuest = await repo.listOpenCallPeers({
      formId: call.id,
      viewer: { humanId: null, applyingAsOrgId: null, contactEmail: "Repeat@Example.com" },
      limit: 50,
    });
    expect(asGuest.map((p) => p.name)).toEqual(["Repeat Person", "Repeat Band", "Viewer", "Viewer Band"]);
  });

  test("peer list privacy is PER IDENTITY: the identity's latest row decides; order stays the identity's FIRST row", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    let n = 0;
    const mk = (data: Partial<Prisma.EventApplicationSubmissionUncheckedCreateInput>) =>
      prisma!.eventApplicationSubmission.create({
        data: { formId: call.id, eventId, answers: {}, createdAt: new Date(now.getTime() + (n += 1) * 1000), ...data },
      });
    const [a, b, c, d, early, viewer] = await Promise.all([
      newHuman("A Rejected Then Private"),
      newHuman("B Rejected Then Public"),
      newHuman("C Withdrawn Latest"),
      newHuman("D Private Then Public"),
      newHuman("Early Bird"),
      newHuman("Viewer"),
    ]);

    // Firsts, in this order: d (private), early, a, b, c.
    await mk({ humanId: d, status: "REJECTED", isPrivate: true });
    await mk({ humanId: early });
    await mk({ humanId: a, status: "REJECTED" });
    await mk({ humanId: b, status: "REJECTED" });
    await mk({ humanId: c, status: "REJECTED" });
    // Latest rows.
    await mk({ humanId: a, isPrivate: true }); // (a) public REJECTED -> private PENDING
    await mk({ humanId: b }); // (b) public REJECTED -> public PENDING
    await mk({ humanId: c, status: "WITHDRAWN" }); // (c) public -> WITHDRAWN latest
    await mk({ humanId: d }); // (d) private REJECTED -> public PENDING

    const peers = await repo.listOpenCallPeers({
      formId: call.id,
      viewer: { humanId: viewer, applyingAsOrgId: null, contactEmail: null },
      limit: 50,
    });
    // (a) hidden, (c) hidden, (b) once, (d) once at its FIRST (private) row's
    // place, ahead of Early Bird.
    expect(peers.map((p) => p.name)).toEqual([
      "D Private Then Public",
      "Early Bird",
      "B Rejected Then Public",
    ]);

    // (c') public PENDING then WITHDRAWN as latest, for an org and a guest too.
    const band = (await prisma.organization.create({ data: { name: "Gone Band", slug: "gone-band-oca" } })).id;
    await mk({ humanId: await newHuman("Gone Member"), applyingAsOrgId: band });
    await mk({ humanId: await newHuman("Gone Member 2"), applyingAsOrgId: band, status: "WITHDRAWN" });
    await mk({ guestName: "Gone Guest", contactEmail: "gone@example.com" });
    await mk({ guestName: "Gone Guest", contactEmail: "GONE@example.com", status: "WITHDRAWN" });
    const after = await repo.listOpenCallPeers({
      formId: call.id,
      viewer: { humanId: viewer, applyingAsOrgId: null, contactEmail: null },
      limit: 50,
    });
    expect(after.map((p) => p.name)).toEqual(peers.map((p) => p.name));
    expect(Object.keys(after[0]!).sort()).toEqual(["kind", "name", "pageSlug", "photoUrl", "url"]);
  });

  test("setOpenCallSubmissionPrivacy: any status but WITHDRAWN, opened or not; idempotent; formId-scoped", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const other = await newPostedCall({ kind: "event", eventId: await newEvent() });
    const row = await prisma.eventApplicationSubmission.create({
      data: {
        formId: call.id,
        eventId,
        humanId: await newHuman("Private Later"),
        answers: {},
        status: "REJECTED",
        openedAt: new Date(),
      },
    });

    const on = await repo.setOpenCallSubmissionPrivacy({ submissionId: row.id, formId: call.id, isPrivate: true });
    expect(on).toMatchObject({ record: { id: row.id, isPrivate: true, status: "REJECTED" }, wasPrivate: false });
    // Same value again still matches (idempotent); the pre-image says so.
    expect(
      await repo.setOpenCallSubmissionPrivacy({ submissionId: row.id, formId: call.id, isPrivate: true }),
    ).toMatchObject({ record: { isPrivate: true }, wasPrivate: true });
    expect(await repo.isLatestOpenCallSubmission({ submissionId: row.id, formId: call.id })).toBe(true);
    expect(await repo.isLatestOpenCallSubmission({ submissionId: row.id, formId: other.id })).toBe(false);
    // Wrong form: nothing.
    expect(
      await repo.setOpenCallSubmissionPrivacy({ submissionId: row.id, formId: other.id, isPrivate: false }),
    ).toBeNull();

    await prisma.eventApplicationSubmission.update({ where: { id: row.id }, data: { status: "WITHDRAWN" } });
    expect(
      await repo.setOpenCallSubmissionPrivacy({ submissionId: row.id, formId: call.id, isPrivate: false }),
    ).toBeNull();
    const stored = await prisma.eventApplicationSubmission.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.isPrivate).toBe(true);

    // ATTEND rows are out of reach (no PERFORM form id matches them).
    const attendForm = await repo.ensureForm({ eventId, purpose: "ATTEND" });
    const attend = await prisma.eventApplicationSubmission.create({
      data: { formId: attendForm.id, eventId, humanId: await newHuman("Attendee"), answers: {} },
    });
    expect(
      await repo.setOpenCallSubmissionPrivacy({ submissionId: attend.id, formId: call.id, isPrivate: true }),
    ).toBeNull();
    expect(await repo.isLatestOpenCallSubmission({ submissionId: attend.id, formId: attendForm.id })).toBe(false);
  });

  test("privacy on a SUPERSEDED row is refused (either direction, self / org / guest); the identity stays listed by its latest row", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const deps = {
      repos: createPrismaRepos(prisma),
      clock: { now: () => new Date() },
      statusTokenSecret: STATUS_TOKEN_SECRET,
    };
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    let n = 0;
    const at = () => new Date(now.getTime() + (n += 1) * 1000);
    const me = await newHuman("Superseded Me");
    const viewer = await newHuman("Viewer");

    // Row A: submitted through core (so it has a working status token),
    // then told "not this time"; row B: a later public re-application.
    const a = await submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: me });
    await prisma.eventApplicationSubmission.update({
      where: { id: a.submissionId! },
      data: { status: "REJECTED", createdAt: at() },
    });
    const b = await prisma.eventApplicationSubmission.create({
      data: { formId: call.id, eventId, humanId: me, answers: {}, createdAt: at() },
    });

    for (const auth of [
      { kind: "token" as const, token: a.statusToken! },
      { kind: "session" as const, actorHumanId: me, submissionId: a.submissionId! },
    ]) {
      await expect(setOpenCallApplicationPrivacy(deps, { auth, isPrivate: true })).rejects.toMatchObject({
        code: "OPEN_CALL_APPLICATION_SUPERSEDED",
      });
    }
    expect(await repo.isLatestOpenCallSubmission({ submissionId: a.submissionId!, formId: call.id })).toBe(false);
    expect(await repo.isLatestOpenCallSubmission({ submissionId: b.id, formId: call.id })).toBe(true);
    const stored = await prisma.eventApplicationSubmission.findMany({
      where: { id: { in: [a.submissionId!, b.id] } },
      select: { isPrivate: true },
    });
    expect(stored.map((r) => r.isPrivate)).toEqual([false, false]);
    const listed = await repo.listOpenCallPeers({
      formId: call.id,
      viewer: { humanId: viewer, applyingAsOrgId: null, contactEmail: null },
      limit: 50,
    });
    expect(listed.map((p) => p.name)).toEqual(["Superseded Me"]);

    // Org: member one's older row loses to member two's newer row; guest:
    // an older row loses to a newer one with the email in another case.
    const band = (await prisma.organization.create({ data: { name: "Two Members", slug: "two-members-oca" } })).id;
    const orgOld = await prisma.eventApplicationSubmission.create({
      data: { formId: call.id, eventId, humanId: await newHuman("M1"), applyingAsOrgId: band, answers: {}, status: "REJECTED", isPrivate: true, createdAt: at() },
    });
    const orgNew = await prisma.eventApplicationSubmission.create({
      data: { formId: call.id, eventId, humanId: await newHuman("M2"), applyingAsOrgId: band, answers: {}, createdAt: at() },
    });
    const guestOld = await prisma.eventApplicationSubmission.create({
      data: { formId: call.id, eventId, guestName: "G", contactEmail: "sup@example.com", answers: {}, status: "REJECTED", createdAt: at() },
    });
    await prisma.eventApplicationSubmission.create({
      data: { formId: call.id, eventId, guestName: "G", contactEmail: "SUP@example.com", answers: {}, createdAt: at() },
    });
    for (const [id, isPrivate] of [
      [orgOld.id, false],
      [guestOld.id, true],
    ] as const) {
      expect(await repo.setOpenCallSubmissionPrivacy({ submissionId: id, formId: call.id, isPrivate })).toBeNull();
    }
    expect(
      await repo.setOpenCallSubmissionPrivacy({ submissionId: orgNew.id, formId: call.id, isPrivate: false }),
    ).toMatchObject({ wasPrivate: false });
    const after = await prisma.eventApplicationSubmission.findMany({
      where: { id: { in: [orgOld.id, guestOld.id] } },
      orderBy: { createdAt: "asc" },
      select: { isPrivate: true },
    });
    expect(after.map((r) => r.isPrivate)).toEqual([true, false]);
  });

  test("two toggles to the same value: the second waits on the first's row lock and reports no change (pre-image from the LOCKED row)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const deps = {
      repos: createPrismaRepos(prisma),
      clock: { now: () => new Date() },
      statusTokenSecret: STATUS_TOKEN_SECRET,
    };
    const submitted = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      guest: { name: "Toggler", email: "toggler@example.com" },
    });

    const written = gate();
    const release = gate();
    let firstWasPrivate: boolean | undefined;
    const first = prisma.$transaction(
      async (tx) => {
        const txRepo = makeEventApplicationsRepo(tx as unknown as PrismaClient);
        firstWasPrivate = (
          await txRepo.setOpenCallSubmissionPrivacy({ submissionId: submitted.submissionId!, formId: call.id, isPrivate: true })
        )?.wasPrivate;
        written.open();
        await release.opened;
      },
      { timeout: 30_000 },
    );
    await written.opened;
    // Its own read sees isPrivate false (uncommitted), so only the locked
    // pre-image can tell it nothing changed.
    const second = setOpenCallApplicationPrivacy(deps, {
      auth: { kind: "token", token: submitted.statusToken! },
      isPrivate: true,
    });
    expect(await settlesWithin(second, 700)).toBe("blocked");
    release.open();
    await first;
    expect(firstWasPrivate).toBe(false);
    await expect(second).resolves.toMatchObject({ isPrivate: true, changed: false });
    expect(
      await prisma.auditLog.count({
        where: { action: "open_call_application_privacy_set", entityId: eventId },
      }),
    ).toBe(0);
    // Positive control: a real change through core IS audited.
    await expect(
      setOpenCallApplicationPrivacy(deps, { auth: { kind: "token", token: submitted.statusToken! }, isPrivate: false }),
    ).resolves.toMatchObject({ changed: true });
    expect(
      await prisma.auditLog.count({
        where: { action: "open_call_application_privacy_set", entityId: eventId },
      }),
    ).toBe(1);
  });

  test("capped submits around a queued close: KEY SHARE, close waits, KEY SHARE, both upgrade — no deadlock; the close sweeps both", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    await repo.upsertOpenCall({ anchor: { kind: "event", eventId }, maxSubmissions: 10, updatedByHumanId: organizerId });
    const [h1, h2] = [await newHuman("Capped One"), await newHuman("Capped Two")];

    // Each transaction publishes its backend pid, so the test can watch
    // pg_stat_activity for "waiting on a lock" instead of guessing with sleeps.
    const pidGate = () => {
      let set!: (pid: number) => void;
      const pid = new Promise<number>((resolve) => {
        set = resolve;
      });
      return { set, pid };
    };
    const myPid = async (tx: Prisma.TransactionClient) =>
      Number((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    const waitUntilBlocked = async (pid: number) => {
      for (let i = 0; i < 400; i += 1) {
        const r = await prisma!.$queryRaw<Array<{ w: string | null }>>`
          SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = ${pid}`;
        if (r[0]?.w === "Lock") return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`backend ${pid} never waited on a lock`);
    };
    // A short deadlock_timeout so the detector gets several chances to fire
    // while the interleave is held (it only runs in a backend that waits).
    const fastDeadlockCheck = (tx: Prisma.TransactionClient) =>
      tx.$executeRawUnsafe("SET LOCAL deadlock_timeout = '50ms'");

    const t1Pid = pidGate();
    const t2Pid = pidGate();
    const closePid = pidGate();
    const t1Shared = gate();
    const t1Inserted = gate();
    const t1Upgrade = gate();
    const t1Commit = gate();
    const t2Shared = gate();
    const t2Upgrade = gate();
    const ids: { t1?: string; t2?: string } = {};

    const t1 = prisma.$transaction(
      async (tx) => {
        await fastDeadlockCheck(tx);
        t1Pid.set(await myPid(tx));
        const r = makeEventApplicationsRepo(tx as unknown as PrismaClient);
        expect(await r.lockOpenCallForSubmit(call.id)).toMatchObject({ maxSubmissions: 10 });
        t1Shared.open();
        await t1Upgrade.opened;
        await r.lockOpenCallForCappedSubmit(call.id);
        ids.t1 = (await tx.eventApplicationSubmission.create({ data: { formId: call.id, eventId, humanId: h1, answers: {} } })).id;
        t1Inserted.open();
        await t1Commit.opened;
      },
      { timeout: 30_000 },
    );
    await t1Shared.opened;

    let swept: string[] = [];
    const close = prisma.$transaction(
      async (tx) => {
        await fastDeadlockCheck(tx);
        closePid.set(await myPid(tx));
        const r = makeEventApplicationsRepo(tx as unknown as PrismaClient);
        await r.lockOpenCallForClose(call.id);
        await r.setOpenCallClosed({ formId: call.id, closedAt: new Date(), closedByHumanId: organizerId });
        swept = (await r.rejectPendingOpenCallSubmissions({ formId: call.id, reviewedAt: new Date() })).ids;
      },
      { timeout: 30_000 },
    );
    await waitUntilBlocked(await closePid.pid);

    const t2 = prisma.$transaction(
      async (tx) => {
        await fastDeadlockCheck(tx);
        t2Pid.set(await myPid(tx));
        const r = makeEventApplicationsRepo(tx as unknown as PrismaClient);
        // KEY SHARE is compatible with T1's KEY SHARE, so it is granted even
        // with the close queued for FOR UPDATE.
        await r.lockOpenCallForSubmit(call.id);
        t2Shared.open();
        await t2Upgrade.opened;
        await r.lockOpenCallForCappedSubmit(call.id);
        ids.t2 = (await tx.eventApplicationSubmission.create({ data: { formId: call.id, eventId, humanId: h2, answers: {} } })).id;
      },
      { timeout: 30_000 },
    );
    expect(await settlesWithin(t2Shared.opened, 5_000)).toBe("settled");

    // T1 upgrades (KEY SHARE + KEY SHARE holders: no conflict) and inserts.
    t1Upgrade.open();
    expect(await settlesWithin(t1Inserted.opened, 5_000)).toBe("settled");
    // T2 upgrades: it must wait for T1's NO KEY UPDATE (not for the queued
    // close's tuple lock, which would be a deadlock).
    t2Upgrade.open();
    await waitUntilBlocked(await t2Pid.pid);
    // Hold the full interleave across many deadlock_timeout periods: a cycle
    // would be detected and abort one of the three by now. A wait is the
    // point here, not a race guess.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await settlesWithin(t2, 10)).toBe("blocked");
    expect(await settlesWithin(close, 10)).toBe("blocked");

    t1Commit.open();
    const results = await Promise.allSettled([t1, t2, close]);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason, "no transaction may fail (40P01 = deadlock)").toBeUndefined();
      }
    }
    expect(ids.t1 && ids.t2).toBeTruthy();
    expect([...swept].sort()).toEqual([ids.t1!, ids.t2!].sort());
    const rows = await prisma.eventApplicationSubmission.findMany({ where: { formId: call.id } });
    expect(rows.map((r) => r.status)).toEqual(["REJECTED", "REJECTED"]);
  });

  test("hard cap: a submit waits on a capped submit in flight and counts after it; two racing submits at cap-1 accept exactly one", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventApplicationsRepo(prisma);
    const deps = {
      repos: createPrismaRepos(prisma),
      clock: { now: () => new Date() },
      statusTokenSecret: STATUS_TOKEN_SECRET,
    };

    // Deterministic interleave: hold the capped lock, insert the last place.
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    await repo.upsertOpenCall({ anchor: { kind: "event", eventId }, maxSubmissions: 1, updatedByHumanId: organizerId });
    const locked = gate();
    const release = gate();
    const first = prisma.$transaction(
      async (tx) => {
        const txRepo = makeEventApplicationsRepo(tx as unknown as PrismaClient);
        await txRepo.lockOpenCallForSubmit(call.id);
        await txRepo.lockOpenCallForCappedSubmit(call.id);
        await tx.eventApplicationSubmission.create({
          data: { formId: call.id, eventId, humanId: (await tx.human.create({ data: { name: "First" } })).id, answers: {} },
        });
        locked.open();
        await release.opened;
      },
      { timeout: 30_000 },
    );
    await locked.opened;
    const second = submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: await newHuman() });
    expect(await settlesWithin(second, 700)).toBe("blocked");
    release.open();
    await first;
    await expect(second).rejects.toMatchObject({ code: "APPLICATION_CAP_REACHED" });

    // Free-for-all race at cap - 1.
    const raceEvent = await newEvent();
    const raceCall = await newPostedCall({ kind: "event", eventId: raceEvent });
    await repo.upsertOpenCall({ anchor: { kind: "event", eventId: raceEvent }, maxSubmissions: 3, updatedByHumanId: organizerId });
    for (let i = 0; i < 2; i += 1) {
      await submitOpenCallApplication(deps, { publicId: raceCall.publicId, viewerHumanId: await newHuman() });
    }
    const [a, b] = [await newHuman(), await newHuman()];
    const results = await Promise.allSettled([
      submitOpenCallApplication(deps, { publicId: raceCall.publicId, viewerHumanId: a }),
      submitOpenCallApplication(deps, { publicId: raceCall.publicId, viewerHumanId: b }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "APPLICATION_CAP_REACHED" });
    expect(await prisma.eventApplicationSubmission.count({ where: { formId: raceCall.id } })).toBe(3);
  });

  test("guarded edit: an organizer open committed mid-edit wins — 0 rows updated, edit refused LOCKED", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const deps = {
      repos: createPrismaRepos(prisma),
      clock: { now: () => new Date() },
      statusTokenSecret: STATUS_TOKEN_SECRET,
    };
    const submitted = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      guest: { name: "Racer", email: "racer@example.com" },
    });

    // Tx 2 stamps openedAt and holds the row lock.
    const opened = gate();
    const release = gate();
    const organizer = prisma.$transaction(
      async (tx) => {
        await tx.eventApplicationSubmission.update({
          where: { id: submitted.submissionId! },
          data: { openedAt: new Date() },
        });
        opened.open();
        await release.opened;
      },
      { timeout: 30_000 },
    );
    await opened.opened;
    // The edit's read sees openedAt null (uncommitted), so it reaches the
    // guarded UPDATE, which waits on the row lock and then re-checks.
    const edit = editOpenCallApplication(deps, {
      auth: { kind: "token", token: submitted.statusToken! },
      answers: { late: "edit" },
      dateIds: [],
      isPrivate: true,
    });
    expect(await settlesWithin(edit, 700)).toBe("blocked");
    release.open();
    await organizer;
    await expect(edit).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_LOCKED" });
    const row = await prisma.eventApplicationSubmission.findUniqueOrThrow({ where: { id: submitted.submissionId! } });
    expect(row.isPrivate).toBe(false);
    expect(row.answers).toEqual({});
  });

  test("a banned person, or an org whose only owner is banned, can't apply", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const deps = {
      repos: createPrismaRepos(prisma),
      clock: { now: () => new Date() },
      statusTokenSecret: STATUS_TOKEN_SECRET,
    };
    const member = await newHuman("Member");
    const bannedOwner = (await prisma.human.create({ data: { name: "Banned Owner", status: "BANNED" } })).id;
    const withheldOrg = (await prisma.organization.create({ data: { name: "Withheld Band", slug: "withheld-band-oca" } })).id;
    await prisma.orgMember.create({ data: { orgId: withheldOrg, humanId: bannedOwner, role: "OWNER" } });
    await prisma.orgMember.create({ data: { orgId: withheldOrg, humanId: member, role: "EDITOR" } });
    await expect(
      submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: member, applyingAsOrgId: withheldOrg }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: bannedOwner }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.eventApplicationSubmission.count({ where: { formId: call.id } })).toBe(0);
  });

  test("migration 20261006120000_open_calls_entity_dedupe fails loudly (deletes nothing) on duplicate open org rows", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const sql = readFileSync(
      resolve(
        __dirname,
        "../../../db/prisma/migrations/20261006120000_open_calls_entity_dedupe/migration.sql",
      ),
      "utf8",
    );
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const band = (await prisma.organization.create({ data: { name: "Dupe Band", slug: "dupe-band-oca" } })).id;
    // Simulate data from before the org index: drop it, insert two open rows
    // for one org, then re-run the migration's SQL in a transaction.
    await prisma.$executeRawUnsafe(`DROP INDEX "EventApplicationSubmission_open_org_key"`);
    try {
      for (const name of ["Dupe One", "Dupe Two"]) {
        await prisma.eventApplicationSubmission.create({
          data: { formId: call.id, eventId, humanId: await newHuman(name), applyingAsOrgId: band, answers: {} },
        });
      }
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        await expect(client.query(sql)).rejects.toThrow(/open_calls_entity_dedupe: 1 \(formId, applyingAsOrgId\)/);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(
        await prisma.eventApplicationSubmission.count({ where: { formId: call.id, applyingAsOrgId: band } }),
      ).toBe(2);
    } finally {
      // Restore: withdraw one dupe, then recreate the index exactly.
      const rows = await prisma.eventApplicationSubmission.findMany({
        where: { formId: call.id, applyingAsOrgId: band },
        orderBy: { createdAt: "asc" },
      });
      if (rows[1]) {
        await prisma.eventApplicationSubmission.update({ where: { id: rows[1].id }, data: { status: "WITHDRAWN" } });
      }
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "EventApplicationSubmission_open_org_key"
        ON "EventApplicationSubmission" ("formId", "applyingAsOrgId")
        WHERE "applyingAsOrgId" IS NOT NULL AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED')`);
    }
  });
  test("submit stores the applicant's language and only the HASH of the derived token; the CHECK refuses an unknown locale", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const eventId = await newEvent();
    const call = await newPostedCall({ kind: "event", eventId });
    const deps = {
      repos: createPrismaRepos(prisma),
      clock: { now: () => new Date() },
      statusTokenSecret: STATUS_TOKEN_SECRET,
    };
    const out = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      guest: { name: "Las Polillas", email: "polillas@example.com" },
      contactLocale: "es",
    });
    const row = await prisma.eventApplicationSubmission.findUniqueOrThrow({
      where: { id: out.submissionId! },
    });
    expect(row.contactLocale).toBe("es");
    expect(row.statusTokenHash).toBe(
      deriveStatusToken(STATUS_TOKEN_SECRET, out.submissionId!).hash,
    );
    expect(JSON.stringify(row)).not.toContain(out.statusToken!);
    const mapped = await makeEventApplicationsRepo(prisma).getOpenCallSubmissionById(row.id);
    expect(mapped?.contactLocale).toBe("es");

    await expect(
      prisma.eventApplicationSubmission.update({ where: { id: row.id }, data: { contactLocale: "fr" } }),
    ).rejects.toThrow(/contactLocale_check|check constraint/i);
  });
});
