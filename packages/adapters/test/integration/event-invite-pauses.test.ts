/**
 * Invite complaint auto-pause (W4) against a REAL Postgres: the CHECKs and
 * the one-open-pause partial uniques from migration
 * 20261007160000_event_invite_complaint_pause only exist in the database, and
 * the advisory lock needs a real transaction.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import {
  decideInvitePause,
  isUnretryableStoreError,
  recordInviteComplaint,
} from "@th/core/use-cases/events/invites/invite-complaint-pause";

import { createPrismaRepos } from "../../src/db/prisma";
import { makeEventInvitePausesRepo } from "../../src/db/prisma/event-invite-pauses";

const OPT_OUT_SECRET = "o".repeat(48);

/** A valid emailHash: 43 base64url chars. */
const hash = (): string =>
  createHash("sha256").update(randomBytes(32)).digest("base64url");
const tokenHash = (): string =>
  createHash("sha256").update(randomBytes(32)).digest("hex");

describe("Prisma adapters integration – event-invite-pauses", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  const newOrg = async () =>
    (
      await prisma!.organization.create({
        data: { name: "Paused Org", slug: `paused-${randomUUID()}` },
      })
    ).id;
  const newHuman = async (name = "Organiser") =>
    (await prisma!.human.create({ data: { name, status: "ACTIVE" } })).id;
  const newEvent = async (owner: { orgId?: string; humanId?: string }) =>
    (
      await prisma!.event.create({
        data: {
          title: "Invite show",
          startsAt: new Date("2026-12-01T20:00:00.000Z"),
          endsAt: new Date("2026-12-01T23:00:00.000Z"),
          status: "PUBLISHED",
          ...owner,
        },
      })
    ).id;
  const sendInvite = async (
    eventId: string,
    sentAt: Date | null,
    kind: "PERSONAL" | "SHARED" = "PERSONAL",
  ) =>
    prisma!.eventInvite.create({
      data: {
        eventId,
        kind,
        tokenHash: tokenHash(),
        ...(kind === "PERSONAL"
          ? { inviteeEmail: `${randomUUID()}@example.com`, sentAt }
          : {}),
      },
    });

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
      console.error("event-invite-pauses integration setup failed:", error);
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

  test("complaints: replay is a no-op; distinct addresses since a cutoff", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitePausesRepo(prisma);
    const orgId = await newOrg();
    const owner = { kind: "ORG", orgId } as const;
    const a = hash();
    const at = new Date("2026-10-07T10:00:00.000Z");

    expect(
      await repo.recordComplaint({ providerEventId: "evt_1", owner, eventId: null, emailHash: a, sentAt: null, occurredAt: at }),
    ).toEqual({ created: true });
    expect(
      await repo.recordComplaint({ providerEventId: "evt_1", owner, eventId: null, emailHash: a, sentAt: null, occurredAt: at }),
    ).toEqual({ created: false });
    await repo.recordComplaint({ providerEventId: "evt_2", owner, eventId: null, emailHash: a, sentAt: null, occurredAt: at });
    await repo.recordComplaint({
      providerEventId: "evt_3",
      owner,
      eventId: null,
      emailHash: hash(),
      sentAt: null,
      occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    expect(
      await repo.countDistinctComplainants({ owner, since: new Date("2026-09-01T00:00:00.000Z") }),
    ).toBe(1);
    expect(
      await repo.countDistinctComplainants({ owner, since: new Date("2026-07-01T00:00:00.000Z") }),
    ).toBe(2);
  }, 60_000);

  test("CHECKs: exactly one owner; hash format", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const orgId = await newOrg();
    const humanId = await newHuman();
    const base = { emailHash: hash(), occurredAt: new Date() };
    await expect(
      prisma.eventInviteComplaint.create({
        data: { ...base, providerEventId: randomUUID(), orgId, humanOwnerId: humanId },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.eventInviteComplaint.create({
        data: { ...base, providerEventId: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.eventInviteComplaint.create({
        data: { ...base, providerEventId: randomUUID(), orgId, emailHash: "ana@example.com" },
      }),
    ).rejects.toThrow();
  }, 60_000);

  test("recipients: PERSONAL sends of the owner's events since the cutoff (org vs person-owned)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitePausesRepo(prisma);
    const orgId = await newOrg();
    const humanId = await newHuman();
    const orgEvent = await newEvent({ orgId, humanId });
    const humanEvent = await newEvent({ humanId });
    const since = new Date("2026-10-01T00:00:00.000Z");

    await sendInvite(orgEvent, new Date("2026-10-05T00:00:00.000Z"));
    await sendInvite(orgEvent, new Date("2026-10-06T00:00:00.000Z"));
    await sendInvite(orgEvent, new Date("2026-09-01T00:00:00.000Z")); // too old
    await sendInvite(orgEvent, null); // never sent
    await sendInvite(orgEvent, null, "SHARED");
    await sendInvite(humanEvent, new Date("2026-10-05T00:00:00.000Z"));
    // The same guest on a second org event counts once (distinct recipients).
    const orgEvent2 = await newEvent({ orgId });
    const repeat = await sendInvite(orgEvent, new Date("2026-10-05T00:00:00.000Z"));
    await prisma.eventInvite.create({
      data: {
        eventId: orgEvent2,
        kind: "PERSONAL",
        tokenHash: tokenHash(),
        inviteeEmail: repeat.inviteeEmail,
        sentAt: new Date("2026-10-05T00:00:00.000Z"),
      },
    });

    expect(await repo.countInviteRecipients({ owner: { kind: "ORG", orgId }, since })).toBe(3);
    // The org-owned event (which also carries humanId) is the ORG's, not the human's.
    expect(
      await repo.countInviteRecipients({ owner: { kind: "HUMAN", humanId }, since }),
    ).toBe(1);
  }, 60_000);

  test("latest complaint event: newest complaint that names an event; a deleted event drops out", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitePausesRepo(prisma);
    const orgId = await newOrg();
    const otherOrg = await newOrg();
    const owner = { kind: "ORG", orgId } as const;
    expect(await repo.getLatestComplaintEventId(owner)).toBeNull();

    const older = await newEvent({ orgId });
    const newer = await newEvent({ orgId });
    const base = { sentAt: null, eventId: null as string | null };
    await repo.recordComplaint({ ...base, providerEventId: `a-${randomUUID()}`, owner, eventId: older, emailHash: hash(), occurredAt: new Date("2026-10-01T00:00:00.000Z") });
    await repo.recordComplaint({ ...base, providerEventId: `b-${randomUUID()}`, owner, eventId: newer, emailHash: hash(), occurredAt: new Date("2026-10-03T00:00:00.000Z") });
    // Newest overall, but names no event.
    await repo.recordComplaint({ ...base, providerEventId: `c-${randomUUID()}`, owner, emailHash: hash(), occurredAt: new Date("2026-10-05T00:00:00.000Z") });
    // Another owner's newer complaint is never returned.
    const foreign = await newEvent({ orgId: otherOrg });
    await repo.recordComplaint({ ...base, providerEventId: `d-${randomUUID()}`, owner: { kind: "ORG", orgId: otherOrg }, eventId: foreign, emailHash: hash(), occurredAt: new Date("2026-10-06T00:00:00.000Z") });

    expect(await repo.getLatestComplaintEventId(owner)).toBe(newer);
    // Deleting the event nulls the complaint's eventId (SetNull).
    await prisma.event.delete({ where: { id: newer } });
    expect(await repo.getLatestComplaintEventId(owner)).toBe(older);
  }, 60_000);

  test("list order: OPEN oldest first (a page cut drops the newest; offset pages forward); LIFTED newest lift first", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitePausesRepo(prisma);
    // Dates older than any other test's pauses, so these three are the head
    // of the OPEN queue in this shared database.
    const at = (iso: string) => new Date(iso);
    const mk = async (pausedAt: Date) =>
      repo.openPause({
        owner: { kind: "ORG", orgId: await newOrg() },
        reason: "COMPLAINT_COUNT",
        complaintCount: 3,
        recipientCount: 10,
        pausedAt,
      });
    const middle = await mk(at("2001-02-01T00:00:00.000Z"));
    const oldest = await mk(at("2001-01-01T00:00:00.000Z"));
    const newest = await mk(at("2001-03-01T00:00:00.000Z"));

    const page1 = await repo.list({ status: "OPEN", limit: 2, offset: 0 });
    expect(page1.map((r) => r.id)).toEqual([oldest.id, middle.id]);
    const page2 = await repo.list({ status: "OPEN", limit: 1, offset: 2 });
    expect(page2.map((r) => r.id)).toEqual([newest.id]);

    // LIFTED: newest lift first.
    const staffId = await newHuman("Staff");
    const decide = (id: string, iso: string) =>
      repo.decide({ id, decision: "LIFTED", note: null, decidedByHumanId: staffId, at: at(iso) });
    await decide(oldest.id, "2001-04-02T00:00:00.000Z");
    await decide(newest.id, "2001-04-01T00:00:00.000Z");
    const lifted = (await repo.list({ status: "LIFTED", limit: 100, offset: 0 }))
      .map((r) => r.id)
      .filter((id) => id === oldest.id || id === newest.id);
    expect(lifted).toEqual([oldest.id, newest.id]);
  }, 60_000);

  test("one OPEN pause per owner; a lift frees the slot; review + decisions are conditional", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitePausesRepo(prisma);
    const orgId = await newOrg();
    const staffId = await newHuman("Staff");
    const owner = { kind: "ORG", orgId } as const;
    const t0 = new Date("2026-10-07T10:00:00.000Z");
    const open = { owner, reason: "COMPLAINT_COUNT" as const, complaintCount: 3, recipientCount: 400, pausedAt: t0 };

    const p1 = await repo.openPause(open);
    await expect(repo.openPause(open)).rejects.toMatchObject({
      code: "invite_pause_already_open",
    });
    expect((await repo.getOpenPause(owner))?.id).toBe(p1.id);

    const asked = await repo.requestReview({ id: p1.id, note: "please", at: t0 });
    expect(asked).toMatchObject({ reviewRequestedAt: t0, reviewRequestNote: "please" });
    expect(await repo.requestReview({ id: p1.id, note: null, at: t0 })).toBeNull();
    expect((await repo.list({ status: "AWAITING_REVIEW", limit: 50, offset: 0 })).map((r) => r.id)).toContain(p1.id);

    const kept = await repo.decide({ id: p1.id, decision: "KEPT", note: "no", decidedByHumanId: staffId, at: t0 });
    expect(kept).toMatchObject({ decision: "KEPT", reviewRequestedAt: null, reviewRequestNote: null, liftedAt: null });

    const t1 = new Date("2026-10-08T10:00:00.000Z");
    const lifted = await repo.decide({ id: p1.id, decision: "LIFTED", note: null, decidedByHumanId: staffId, at: t1 });
    expect(lifted).toMatchObject({ decision: "LIFTED", liftedAt: t1 });
    expect(await repo.decide({ id: p1.id, decision: "KEPT", note: "x", decidedByHumanId: staffId, at: t1 })).toBeNull();
    expect(await repo.getLastLiftedAt(owner)).toEqual(t1);
    expect(await repo.getOpenPause(owner)).toBeNull();

    const p2 = await repo.openPause({ ...open, pausedAt: t1 });
    expect((await repo.getLatestPause(owner))?.id).toBe(p2.id);
    const listed = await repo.list({ status: "LIFTED", limit: 50, offset: 0 });
    expect(listed.find((r) => r.id === p1.id)).toMatchObject({ ownerName: "Paused Org" });
  }, 60_000);

  test("lockOwner works inside a real transaction (void return decodes)", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const orgId = await newOrg();
    const owner = { kind: "ORG", orgId } as const;
    const out = await prisma.$transaction(async (tx) => {
      const repo = makeEventInvitePausesRepo(tx);
      await repo.lockOwner(owner);
      await repo.lockOwner(owner); // re-entrant within one tx
      return repo.getOpenPause(owner);
    });
    expect(out).toBeNull();
  }, 60_000);

  test("owner delete cascades; event delete keeps the complaint (eventId → null)", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitePausesRepo(prisma);
    const orgId = await newOrg();
    const eventId = await newEvent({ orgId });
    const owner = { kind: "ORG", orgId } as const;
    await repo.recordComplaint({ providerEventId: `evt_${randomUUID()}`, owner, eventId, emailHash: hash(), sentAt: null, occurredAt: new Date() });
    await repo.openPause({ owner, reason: "COMPLAINT_RATE", complaintCount: 1, recipientCount: 0, pausedAt: new Date() });

    await prisma.event.delete({ where: { id: eventId } });
    const rows = await prisma.eventInviteComplaint.findMany({ where: { orgId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventId).toBeNull();

    await prisma.organization.delete({ where: { id: orgId } });
    expect(await prisma.eventInviteComplaint.count({ where: { orgId } })).toBe(0);
    expect(await prisma.eventInvitePause.count({ where: { orgId } })).toBe(0);
  }, 60_000);

  test("complaints count by SEND time (sentAt), falling back to occurredAt when untagged", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitePausesRepo(prisma);
    const orgId = await newOrg();
    const owner = { kind: "ORG", orgId } as const;
    const lift = new Date("2026-10-06T00:00:00.000Z");
    const today = new Date("2026-10-07T00:00:00.000Z");
    // Late complaint about pre-lift mail: does NOT count after the lift.
    await repo.recordComplaint({ providerEventId: `e_${randomUUID()}`, owner, eventId: null, emailHash: hash(), sentAt: new Date("2026-10-05T00:00:00.000Z"), occurredAt: today });
    // Post-lift mail: counts.
    await repo.recordComplaint({ providerEventId: `e_${randomUUID()}`, owner, eventId: null, emailHash: hash(), sentAt: new Date("2026-10-06T12:00:00.000Z"), occurredAt: today });
    // Untagged: by its own time (after the lift): counts.
    await repo.recordComplaint({ providerEventId: `e_${randomUUID()}`, owner, eventId: null, emailHash: hash(), sentAt: null, occurredAt: today });
    expect(await repo.countDistinctComplainants({ owner, since: lift })).toBe(2);
  }, 60_000);

  test("a CHECK violation surfaces as an error core treats as unretryable", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitePausesRepo(prisma);
    const orgId = await newOrg();
    const err = await repo
      .recordComplaint({ providerEventId: `e_${randomUUID()}`, owner: { kind: "ORG", orgId }, eventId: null, emailHash: "not-a-hash", sentAt: null, occurredAt: new Date() })
      .then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(isUnretryableStoreError(err)).toBe(true);
  }, 60_000);

  const coreDeps = (now: Date) => ({
    repos: createPrismaRepos(prisma!),
    clock: { now: () => now },
    inviteOptOutSecret: OPT_OUT_SECRET,
  });
  const ownerMeta = (orgId: string, sentAt?: Date) => ({
    inviteOwner: `org-${orgId}`,
    ...(sentAt ? { inviteSentAt: String(sentAt.getTime()) } : {}),
  });

  test("CONCURRENT complaints for one organiser open exactly ONE pause (advisory lock)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const orgId = await newOrg();
    const now = new Date("2026-10-07T12:00:00.000Z");
    // No sends: each complaint alone trips by rate (1 / 0).
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        recordInviteComplaint(coreDeps(now), {
          providerEventId: `race_${randomUUID()}`,
          email: `r${i}@example.com`,
          occurredAt: now,
          metadata: ownerMeta(orgId, now),
        }),
      ),
    );
    expect(results.every((r) => r.outcome === "RECORDED")).toBe(true);
    expect(results.filter((r) => r.outcome === "RECORDED" && r.paused)).toHaveLength(1);
    expect(await prisma.eventInvitePause.count({ where: { orgId, liftedAt: null } })).toBe(1);
    expect(await prisma.eventInviteComplaint.count({ where: { orgId } })).toBe(6);
  }, 120_000);

  test("a staff LIFT racing a late complaint about pre-lift mail: the lift holds either way", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const orgId = await newOrg();
    const staffId = await newHuman("Staff");
    const before = new Date("2026-10-07T10:00:00.000Z");
    await recordInviteComplaint(coreDeps(before), {
      providerEventId: `trip_${randomUUID()}`,
      email: "first@example.com",
      occurredAt: before,
      metadata: ownerMeta(orgId, before),
    });
    const pause = await prisma.eventInvitePause.findFirstOrThrow({ where: { orgId, liftedAt: null } });

    const liftAt = new Date("2026-10-07T12:00:00.000Z");
    const [decided, late] = await Promise.all([
      decideInvitePause(
        {
          ...coreDeps(liftAt),
          authz: { hasStaffRole: async () => ({ allowed: true }) },
        },
        { actorHumanId: staffId, pauseId: pause.id, decision: "LIFTED" },
      ),
      recordInviteComplaint(coreDeps(liftAt), {
        providerEventId: `late_${randomUUID()}`,
        email: "late@example.com",
        occurredAt: liftAt,
        metadata: ownerMeta(orgId, new Date("2026-10-07T09:00:00.000Z")),
      }),
    ]);
    expect(decided.pause).toMatchObject({ decision: "LIFTED", ownerName: "Paused Org" });
    expect(late.outcome).toBe("RECORDED");
    // Whichever ran first: no open pause remains.
    expect(await prisma.eventInvitePause.count({ where: { orgId, liftedAt: null } })).toBe(0);
  }, 120_000);

  test("raw COUNT(DISTINCT) queries honour the cutoff to the millisecond (no timezone shift)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitePausesRepo(prisma);
    const orgId = await newOrg();
    const owner = { kind: "ORG", orgId } as const;
    const eventId = await newEvent({ orgId });
    const since = new Date("2026-10-01T00:00:00.000Z");
    const justBefore = new Date(since.getTime() - 1);

    await sendInvite(eventId, since); // counts
    await sendInvite(eventId, justBefore); // doesn't
    expect(await repo.countInviteRecipients({ owner, since })).toBe(1);

    const rec = (sentAt: Date | null, occurredAt: Date) =>
      repo.recordComplaint({ providerEventId: `b_${randomUUID()}`, owner, eventId: null, emailHash: hash(), sentAt, occurredAt });
    await rec(since, justBefore); // sent at the cutoff: counts
    await rec(justBefore, since); // sent before: doesn't, despite a later complaint
    await rec(null, since); // untagged at the cutoff: counts
    await rec(null, justBefore); // untagged before: doesn't
    expect(await repo.countDistinctComplainants({ owner, since })).toBe(2);
  }, 60_000);
});
