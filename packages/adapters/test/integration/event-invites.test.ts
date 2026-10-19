/**
 * Gated-event invite links (docs/specs/2026-10-02/completed/gated-event-invite-links.
 * spec.yaml) against a REAL Postgres: the SQL-only partial uniques and the
 * CHECK from migration 20261003120000_event_invites only exist in the
 * database, so a mocked Prisma can't prove the adapter's error mapping.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventInvitesRepo } from "../../src/db/prisma/event-invites";
import { makeEventUnlocksRepo } from "../../src/db/prisma/event-unlocks";
import { makeEventApplicationsRepo } from "../../src/db/prisma/event-applications";
import { makeEventInviteOptOutsRepo } from "../../src/db/prisma/event-invite-opt-outs";
import { makeTicketsRepo } from "../../src/db/prisma/tickets";
import { makePayoutItemsRepo } from "../../src/db/prisma/payout-items";

const freshHash = (): string =>
  createHash("sha256").update(randomBytes(32)).digest("hex");

describe("Prisma adapters integration – event-invites", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let organizerId: string;
  let guestAId: string;
  let guestBId: string;

  const newEvent = async (title: string): Promise<string> => {
    const event = await prisma!.event.create({
      data: {
        title,
        startsAt: new Date("2026-12-01T20:00:00.000Z"),
        endsAt: new Date("2026-12-01T23:00:00.000Z"),
        status: "PUBLISHED",
        humanId: organizerId,
      },
    });
    return event.id;
  };

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      organizerId = (
        await prisma.human.create({
          data: { name: "Invite Organizer", status: "ACTIVE" },
        })
      ).id;
      guestAId = (
        await prisma.human.create({
          data: { name: "Guest A", status: "ACTIVE" },
        })
      ).id;
      guestBId = (
        await prisma.human.create({
          data: { name: "Guest B", status: "ACTIVE" },
        })
      ).id;
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("event-invites integration setup failed:", error);
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

  test("a second live SHARED invite → shared_invite_already_live", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitesRepo(prisma);
    const eventId = await newEvent("Shared dup");

    const first = await repo.create({
      kind: "SHARED",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
    });
    expect(first.kind).toBe("SHARED");
    expect(first.redemptionCount).toBe(0);

    await expect(
      repo.create({
        kind: "SHARED",
        eventId,
        tokenHash: freshHash(),
        createdByHumanId: organizerId,
      }),
    ).rejects.toMatchObject({ code: "shared_invite_already_live" });

    // A revoked SHARED row doesn't block a new one.
    await repo.revoke(first.id, new Date());
    const second = await repo.create({
      kind: "SHARED",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
    });
    expect((await repo.getLiveShared(eventId))?.id).toBe(second.id);
  }, 60_000);

  test("rotateShared leaves exactly one live SHARED row", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitesRepo(prisma);
    const eventId = await newEvent("Rotate");

    // Rotate with nothing live = first enable.
    const r1 = await repo.rotateShared(
      eventId,
      { tokenHash: freshHash(), createdByHumanId: organizerId },
      new Date(),
    );
    expect(r1.revoked).toBeNull();

    const at = new Date();
    const r2 = await repo.rotateShared(
      eventId,
      { tokenHash: freshHash(), createdByHumanId: organizerId },
      at,
    );
    expect(r2.revoked?.id).toBe(r1.created.id);
    expect(r2.revoked?.revokedAt?.getTime()).toBe(at.getTime());

    const live = await prisma.eventInvite.findMany({
      where: { eventId, kind: "SHARED", revokedAt: null },
    });
    expect(live.map((r) => r.id)).toEqual([r2.created.id]);
    expect(await repo.listByEvent(eventId)).toHaveLength(2);
  }, 60_000);

  test("a second live PERSONAL for the same email (other case) → personal_invite_already_live; re-invite after revoke inserts a new row", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitesRepo(prisma);
    const eventId = await newEvent("Personal dup");

    const first = await repo.create({
      kind: "PERSONAL",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
      inviteeName: "Ana",
      inviteeEmail: "ana@example.com",
    });

    // The lookup matches case-insensitively.
    expect(
      (await repo.findLivePersonalByEmail(eventId, "ANA@Example.com"))?.id,
    ).toBe(first.id);

    // Different case: the adapter lowercases, so this reaches the
    // "EventInvite_personal_email_key" index rather than the CHECK.
    await expect(
      repo.create({
        kind: "PERSONAL",
        eventId,
        tokenHash: freshHash(),
        createdByHumanId: organizerId,
        inviteeName: "Ana again",
        inviteeEmail: "  ANA@Example.COM ",
      }),
    ).rejects.toMatchObject({ code: "personal_invite_already_live" });

    // Revoke, then re-invite the same email: a NEW row, old one stays revoked.
    const revoked = await repo.revoke(first.id, new Date());
    expect(revoked?.revokedAt).not.toBeNull();
    const again = await repo.create({
      kind: "PERSONAL",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
      inviteeName: "Ana",
      inviteeEmail: "ana@example.com",
    });
    expect(again.id).not.toBe(first.id);
    expect((await repo.getById(first.id))?.revokedAt).not.toBeNull();
    expect(
      (await repo.findLivePersonalByEmail(eventId, "ana@example.com"))?.id,
    ).toBe(again.id);
  }, 60_000);

  test("revoke is idempotent: a second revoke keeps the first revokedAt", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitesRepo(prisma);
    const eventId = await newEvent("Revoke twice");
    const invite = await repo.create({
      kind: "SHARED",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
    });
    const t1 = new Date("2026-10-05T10:00:00.000Z");
    const t2 = new Date("2026-10-05T11:00:00.000Z");
    await repo.revoke(invite.id, t1);
    const second = await repo.revoke(invite.id, t2);
    expect(second?.revokedAt?.getTime()).toBe(t1.getTime());
    expect(await repo.revoke("00000000-0000-0000-0000-000000000000", t2)).toBe(
      null,
    );
  }, 60_000);

  test("recordRedemption twice → count 2, firstRedeemedAt unchanged", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitesRepo(prisma);
    const eventId = await newEvent("Redemptions");
    const invite = await repo.create({
      kind: "SHARED",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
    });

    const t1 = new Date("2026-10-05T10:00:00.000Z");
    const t2 = new Date("2026-10-05T12:00:00.000Z");
    const a = await repo.recordRedemption(invite.id, t1);
    const b = await repo.recordRedemption(invite.id, t2);
    expect(a?.redemptionCount).toBe(1);
    expect(b?.redemptionCount).toBe(2);
    expect(b?.firstRedeemedAt?.getTime()).toBe(t1.getTime());

    // Concurrent redemptions never lose an increment.
    await Promise.all(
      Array.from({ length: 5 }, () => repo.recordRedemption(invite.id, t2)),
    );
    expect((await repo.getById(invite.id))?.redemptionCount).toBe(7);

    expect(
      await repo.recordRedemption("00000000-0000-0000-0000-000000000000", t1),
    ).toBeNull();
  }, 60_000);

  test("lockIfLive: true while live, false once revoked or missing", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitesRepo(prisma);
    const eventId = await newEvent("LockIfLive");
    const invite = await repo.create({
      kind: "SHARED",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
    });

    expect(await repo.lockIfLive(invite.id)).toBe(true);
    // A no-op: the row is still live afterwards.
    expect((await repo.getById(invite.id))?.revokedAt).toBeNull();
    await repo.revoke(invite.id, new Date("2026-10-05T12:00:00.000Z"));
    expect(await repo.lockIfLive(invite.id)).toBe(false);
    expect(
      await repo.lockIfLive("00000000-0000-0000-0000-000000000000"),
    ).toBe(false);
  }, 60_000);

  test("lockIfLive holds the row: a revoke waits for the holder's commit; a lock behind a revoke sees it", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const client = prisma;
    const repo = makeEventInvitesRepo(client);
    const eventId = await newEvent("LockIfLive race");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const at = new Date("2026-10-05T12:00:00.000Z");

    // 1. Lock first: the revoke blocks until our transaction commits.
    const a = await repo.create({
      kind: "SHARED",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
    });
    const order: string[] = [];
    let revokeDone: Promise<unknown> = Promise.resolve();
    await client.$transaction(
      async (tx) => {
        expect(await makeEventInvitesRepo(tx).lockIfLive(a.id)).toBe(true);
        revokeDone = repo.revoke(a.id, at).then(() => order.push("revoke"));
        await sleep(400);
        order.push("holder-commit");
      },
      { timeout: 10_000 },
    );
    await revokeDone;
    expect(order).toEqual(["holder-commit", "revoke"]);

    // 2. Revoke holds the lock first: lockIfLive waits, then sees it revoked.
    const b = await repo.create({
      kind: "SHARED",
      eventId: await newEvent("LockIfLive race 2"),
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
    });
    let locked: Promise<boolean> = Promise.resolve(true);
    await client.$transaction(
      async (tx) => {
        await makeEventInvitesRepo(tx).revoke(b.id, at);
        locked = client.$transaction((tx2) =>
          makeEventInvitesRepo(tx2).lockIfLive(b.id),
        );
        await sleep(400);
      },
      { timeout: 10_000 },
    );
    expect(await locked).toBe(false);
  }, 60_000);

  test("a CHECK violation is NOT mapped to a duplicate", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitesRepo(prisma);
    const eventId = await newEvent("Check");

    // PERSONAL without an email violates "EventInvite_kind_invitee_check"
    // (the port's types forbid it; cast past them to reach the DB).
    const err = await repo
      .create({
        kind: "PERSONAL",
        eventId,
        tokenHash: freshHash(),
        createdByHumanId: organizerId,
        inviteeName: "No email",
        inviteeEmail: null as unknown as string,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).not.toBeNull();
    expect(err).not.toMatchObject({ code: "shared_invite_already_live" });
    expect(err).not.toMatchObject({ code: "personal_invite_already_live" });
    expect(String((err as Error).message)).toContain(
      "EventInvite_kind_invitee_check",
    );

    // SHARED carrying an invitee: the adapter never writes one, so prove the
    // constraint itself is live with a raw insert.
    await expect(
      prisma.eventInvite.create({
        data: {
          eventId,
          kind: "SHARED",
          tokenHash: freshHash(),
          createdByHumanId: organizerId,
          inviteeEmail: "x@example.com",
        },
      }),
    ).rejects.toThrow(/EventInvite_kind_invitee_check/);

    expect(await prisma.eventInvite.count({ where: { eventId } })).toBe(0);
  }, 60_000);

  test("revokeByInvite only touches that invite's unlocks", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const invites = makeEventInvitesRepo(prisma);
    const unlocks = makeEventUnlocksRepo(prisma);
    const eventId = await newEvent("Revoke by invite");

    const mine = await invites.create({
      kind: "PERSONAL",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
      inviteeName: "A",
      inviteeEmail: "a@example.com",
    });
    const other = await invites.create({
      kind: "PERSONAL",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
      inviteeName: "B",
      inviteeEmail: "b@example.com",
    });

    const ua = await unlocks.upsert({
      eventId,
      humanId: guestAId,
      source: "MAGIC_LINK",
      inviteId: mine.id,
    });
    expect(ua.inviteId).toBe(mine.id);
    await unlocks.upsert({
      eventId,
      humanId: guestBId,
      source: "MAGIC_LINK",
      inviteId: other.id,
    });

    const at = new Date();
    expect(await unlocks.revokeByInvite(mine.id, at)).toBe(1);
    expect((await unlocks.get(eventId, guestAId))?.revokedAt).not.toBeNull();
    expect(await unlocks.isUnlocked(eventId, guestBId)).toBe(true);
    // Already revoked → nothing left to revoke.
    expect(await unlocks.revokeByInvite(mine.id, at)).toBe(0);
  }, 60_000);

  test("countSubmissions({ excludeInvited }) leaves out invite approvals (R11)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const invites = makeEventInvitesRepo(prisma);
    const apps = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent("Cap");

    const invite = await invites.create({
      kind: "SHARED",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
    });
    // Rows seeded raw: the open-calls schema (peer WIP, 2026-10-05) now
    // requires a form on every submission, and only countSubmissions is under
    // test here.
    const form = await prisma.eventApplicationForm.create({
      data: { eventId, publicId: `form-${randomBytes(6).toString("hex")}` },
    });
    await prisma.eventApplicationSubmission.create({
      data: { formId: form.id, eventId, humanId: guestAId, answers: {} },
    });
    const viaInvite = await prisma.eventApplicationSubmission.create({
      data: {
        formId: form.id,
        eventId,
        humanId: guestBId,
        answers: {},
        status: "APPROVED",
        inviteId: invite.id,
      },
    });
    expect(viaInvite.inviteId).toBe(invite.id);

    expect(await apps.countSubmissions({ eventId, purpose: "ATTEND" })).toBe(2);
    expect(
      await apps.countSubmissions({ eventId, purpose: "ATTEND", excludeInvited: true }),
    ).toBe(1);
  }, 60_000);

  test("updateSubmissionStatus({ expectedInviteId }) re-checks the invite stamp IN the write", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const invites = makeEventInvitesRepo(prisma);
    const apps = makeEventApplicationsRepo(prisma);
    const eventId = await newEvent("Invite stamp CAS");
    const mk = () =>
      invites.create({
        kind: "SHARED",
        eventId,
        tokenHash: freshHash(),
        createdByHumanId: organizerId,
      });
    const p1 = await mk();
    await invites.revoke(p1.id, new Date("2026-10-05T11:00:00.000Z"));
    const p2 = await mk();
    // Seeded raw, as above (open-calls peer WIP requires a form).
    const form = await prisma.eventApplicationForm.create({
      data: { eventId, publicId: `form-${randomBytes(6).toString("hex")}` },
    });
    // Approved by P1, then re-approved under P2 (status stays APPROVED).
    const sub = await prisma.eventApplicationSubmission.create({
      data: {
        formId: form.id,
        eventId,
        humanId: guestAId,
        answers: {},
        status: "APPROVED",
        inviteId: p2.id,
      },
    });

    // A rescind that read P1 loses: status still matches, the stamp doesn't.
    await expect(
      apps.updateSubmissionStatus({
        submissionId: sub.id,
        status: "PENDING",
        inviteId: null,
        expectedFromStatuses: ["APPROVED"],
        expectedInviteId: p1.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (await prisma.eventApplicationSubmission.findUnique({ where: { id: sub.id } }))
        ?.status,
    ).toBe("APPROVED");

    // `null` expects no stamp: also a miss here.
    await expect(
      apps.updateSubmissionStatus({
        submissionId: sub.id,
        status: "PENDING",
        expectedInviteId: null,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // The matching stamp lands (with or without a status guard).
    const out = await apps.updateSubmissionStatus({
      submissionId: sub.id,
      status: "PENDING",
      inviteId: null,
      expectedFromStatuses: ["APPROVED"],
      expectedInviteId: p2.id,
    });
    expect(out).toMatchObject({ status: "PENDING", inviteId: null });
  }, 60_000);

  // ── Migration 20261005200000_event_invite_optout_and_removal ─────────────

  test("grantsRevokedAt: maps null by default; revokeSharedGrants stamps every SHARED row but the excepted one, keeping a first stamp", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitesRepo(prisma);
    const eventId = await newEvent("Remove everyone");
    const t1 = new Date("2026-10-05T10:00:00.000Z");
    const t2 = new Date("2026-10-05T11:00:00.000Z");

    const a = await repo.create({
      kind: "SHARED",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
    });
    expect(a.grantsRevokedAt).toBeNull();
    const { created: b } = await repo.rotateShared(
      eventId,
      { tokenHash: freshHash(), createdByHumanId: organizerId },
      t1,
    );
    const personal = await repo.create({
      kind: "PERSONAL",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
      inviteeName: "P",
      inviteeEmail: "p@example.com",
    });

    // Stamp A only (B excepted, PERSONAL never touched).
    expect(await repo.revokeSharedGrants(eventId, t1, { exceptInviteId: b.id })).toEqual([
      a.id,
    ]);
    expect((await repo.getById(a.id))?.grantsRevokedAt).toEqual(t1);
    expect((await repo.getById(b.id))?.grantsRevokedAt).toBeNull();
    expect((await repo.getById(personal.id))?.grantsRevokedAt).toBeNull();

    // Again with nothing excepted: A keeps t1, B gets t2; both ids returned.
    const ids = await repo.revokeSharedGrants(eventId, t2);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
    expect((await repo.getById(a.id))?.grantsRevokedAt).toEqual(t1);
    expect((await repo.getById(b.id))?.grantsRevokedAt).toEqual(t2);
  }, 60_000);

  test("lockIfGrantsHold is true until grantsRevokedAt is set, regardless of revokedAt (R5)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeEventInvitesRepo(prisma);
    const eventId = await newEvent("Grant lock");
    const inv = await repo.create({
      kind: "SHARED",
      eventId,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
    });
    await repo.revoke(inv.id, new Date());
    // A plain reset (revokedAt) keeps the grants.
    expect(await prisma.$transaction((tx) => makeEventInvitesRepo(tx).lockIfGrantsHold(inv.id))).toBe(true);
    await repo.revokeSharedGrants(eventId, new Date());
    expect(await repo.lockIfGrantsHold(inv.id)).toBe(false);
    expect(await repo.lockIfGrantsHold("00000000-0000-4000-8000-000000000000")).toBe(false);
  }, 60_000);

  test("EventInviteOptOut: idempotent add per owner by HASH, scoped lookups, CHECKs hold", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const optOuts = makeEventInviteOptOutsRepo(prisma);
    const org = await prisma.organization.create({
      data: { name: "Opt-out Org", slug: `optout-${randomBytes(4).toString("hex")}` },
    });
    const orgOwner = { kind: "ORG" as const, orgId: org.id };
    const humanOwner = { kind: "HUMAN" as const, humanId: organizerId };
    // Hashes come from core (keyed HMAC, 43 base64url chars); the repo never
    // sees an address.
    const hash = (label: string) =>
      createHash("sha256").update(label).digest("base64url");
    const ana = hash("ana");
    const bo = hash("bo");
    expect(ana).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(await optOuts.add({ owner: orgOwner, emailHash: ana })).toEqual({ created: true });
    expect(await optOuts.add({ owner: orgOwner, emailHash: ana })).toEqual({ created: false });
    await optOuts.add({ owner: humanOwner, emailHash: ana });
    expect(await prisma.eventInviteOptOut.count({ where: { emailHash: ana } })).toBe(2);

    expect(
      await optOuts.listOptedOut({ owner: orgOwner, emailHashes: [ana, bo] }),
    ).toEqual(new Set([ana]));
    expect(
      await optOuts.listOptedOut({
        owner: { kind: "HUMAN", humanId: guestAId },
        emailHashes: [ana],
      }),
    ).toEqual(new Set());
    expect(await optOuts.listOptedOut({ owner: orgOwner, emailHashes: [] })).toEqual(
      new Set(),
    );

    // No plaintext column any more.
    const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'EventInviteOptOut'`;
    expect(cols.map((c) => c.column_name)).not.toContain("emailLower");

    // At most one owner; the hash must look like one (no address slips in).
    await expect(
      prisma.eventInviteOptOut.create({
        data: { emailHash: bo, orgId: org.id, humanOwnerId: organizerId },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.eventInviteOptOut.create({
        data: { emailHash: "ana@example.com", orgId: org.id },
      }),
    ).rejects.toThrow();
  }, 60_000);

  test("EventInviteOptOut: stop-all is one ownerless row per hash and bars every organiser", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const optOuts = makeEventInviteOptOutsRepo(prisma);
    const org = await prisma.organization.create({
      data: { name: "Stop-all Org", slug: `stopall-${randomBytes(4).toString("hex")}` },
    });
    const orgOwner = { kind: "ORG" as const, orgId: org.id };
    const humanOwner = { kind: "HUMAN" as const, humanId: guestBId };
    const hash = (label: string) =>
      createHash("sha256").update(`stop-all:${label}`).digest("base64url");
    const cy = hash("cy");
    const di = hash("di");
    const ed = hash("ed");

    expect(await optOuts.standing({ owner: orgOwner, emailHash: cy })).toBeNull();
    // NULLs are distinct in a plain unique: the partial unique must catch it.
    expect(await optOuts.addForAllOrganisers({ emailHash: cy })).toEqual({ created: true });
    expect(await optOuts.addForAllOrganisers({ emailHash: cy })).toEqual({ created: false });
    expect(
      await prisma.eventInviteOptOut.count({
        where: { emailHash: cy, orgId: null, humanOwnerId: null },
      }),
    ).toBe(1);
    await expect(
      prisma.eventInviteOptOut.create({ data: { emailHash: cy } }),
    ).rejects.toThrow();

    // Per-organiser rows still coexist with it.
    await optOuts.add({ owner: orgOwner, emailHash: di });
    await optOuts.add({ owner: orgOwner, emailHash: cy });

    // Every organiser kind sees the stop-all; only this org sees di.
    expect(
      await optOuts.listOptedOut({ owner: orgOwner, emailHashes: [cy, di, ed] }),
    ).toEqual(new Set([cy, di]));
    expect(
      await optOuts.listOptedOut({ owner: humanOwner, emailHashes: [cy, di, ed] }),
    ).toEqual(new Set([cy]));
    expect(await optOuts.listOptedOut({ owner: null, emailHashes: [cy, di, ed] })).toEqual(
      new Set([cy]),
    );

    // standing: ALL wins over ORGANISER; scoped to the one hash asked.
    expect(await optOuts.standing({ owner: orgOwner, emailHash: cy })).toBe("ALL");
    expect(await optOuts.standing({ owner: humanOwner, emailHash: cy })).toBe("ALL");
    expect(await optOuts.standing({ owner: orgOwner, emailHash: di })).toBe("ORGANISER");
    expect(await optOuts.standing({ owner: humanOwner, emailHash: di })).toBeNull();
    expect(await optOuts.standing({ owner: orgOwner, emailHash: ed })).toBeNull();

    // An org's deletion cascades its own rows, never the stop-all.
    await prisma.organization.delete({ where: { id: org.id } });
    expect(await prisma.eventInviteOptOut.count({ where: { emailHash: cy } })).toBe(1);
  }, 60_000);

  type Pay =
    | "card"
    | "comp"
    | "cash"
    | "pos"
    | "free"
    | "refunded"
    | "none"
    | "cardZero" // WEB + PaymentIntent, gross 0
    | "compCharged" // COMP source, PaymentIntent, gross 2500
    | "disputed"
    | "resale"; // RESALE source, card-paid
  /**
   * Track-record fixtures: humans (verified account by default), events of an
   * owner, and door scans of a ticket whose order is `pay` (card-paid by
   * default).
   */
  const trackKit = (orgId: string) => {
    const mkHuman = async (name: string, opts: { verified?: boolean | null } = {}) => {
      const id = (await prisma!.human.create({ data: { name, status: "ACTIVE" } })).id;
      const verified = opts.verified === undefined ? true : opts.verified;
      if (verified !== null) {
        await prisma!.authUser.create({
          data: {
            name,
            email: `h-${randomBytes(5).toString("hex")}@example.com`,
            emailVerified: verified,
            humanId: id,
          },
        });
      }
      return id;
    };
    const mkEvent = (endsAt: Date, o: { orgId?: string; humanId?: string } = { orgId }) =>
      prisma!.event.create({
        data: {
          title: "Track",
          startsAt: new Date(endsAt.getTime() - 3 * 3600_000),
          endsAt,
          status: "PUBLISHED",
          ...o,
        },
      });
    const mkOrder = async (eventId: string, buyer: string, pay: Pay) => {
      if (pay === "none") return null;
      const charged = ["card", "refunded", "pos", "cardZero", "compCharged", "disputed", "resale"];
      const order = await prisma!.order.create({
        data: {
          eventId,
          buyerHumanId: buyer,
          amountGrossCents: ["free", "comp", "cash", "cardZero"].includes(pay) ? 0 : 2500,
          feePolicySnapshot: {},
          status:
            pay === "refunded" ? "REFUNDED" : pay === "disputed" ? "DISPUTED" : "SUCCEEDED",
          source:
            pay === "comp" || pay === "compCharged"
              ? "COMP"
              : pay === "resale"
                ? "RESALE"
                : "PRIMARY",
          paymentChannel: pay === "cash" ? "CASH" : pay === "pos" ? "POS" : "WEB",
          stripePaymentIntentId: charged.includes(pay)
            ? `pi_${randomBytes(8).toString("hex")}`
            : null,
        },
      });
      return order.id;
    };
    const scan = async (
      event: { id: string; startsAt: Date },
      holderId: string,
      opts: {
        scannerId?: string;
        message?: string | null;
        outcome?: "ACCEPTED" | "REJECTED";
        scannedAt?: Date;
        pay?: Pay;
        ticketStatus?: "VALID" | "SCANNED" | "REFUNDED" | "INVALID";
      } = {},
    ) => {
      const orderId = await mkOrder(event.id, holderId, opts.pay ?? "card");
      const ticket = await prisma!.ticket.create({
        data: {
          eventId: event.id,
          ownerHumanId: holderId,
          code: `T-${randomBytes(6).toString("hex")}`,
          status: opts.ticketStatus ?? "SCANNED",
          ...(orderId ? { orderId } : {}),
        },
      });
      await prisma!.ticketScan.create({
        data: {
          ticketId: ticket.id,
          eventId: event.id,
          actorHumanId: opts.scannerId ?? organizerId,
          scannedAt: opts.scannedAt ?? new Date(event.startsAt.getTime() + 600_000),
          outcome: opts.outcome ?? "ACCEPTED",
          message: opts.message ?? null,
        },
      });
    };
    return { mkHuman, mkEvent, scan };
  };

  test("track record: DISTINCT outside holders admitted at the door of events that ended a day ago, capped", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const tickets = makeTicketsRepo(prisma);
    const now = new Date("2026-10-05T12:00:00.000Z");
    const DAY = 86_400_000;
    const endedBefore = new Date(now.getTime() - DAY);
    const LEAD = 6 * 3600;
    const org = await prisma.organization.create({
      data: { name: "Track Org", slug: `track-${randomBytes(4).toString("hex")}` },
    });
    const owner = { orgId: org.id };
    const count = (o: { orgId: string } | { humanId: string } = owner, cap = 10) =>
      tickets.countDistinctDoorScannedHolders({
        owner: o,
        endedBefore,
        doorLeadSeconds: LEAD,
        cap,
      });

    const { mkHuman, mkEvent, scan } = trackKit(org.id);
    const past = await mkEvent(new Date("2026-09-01T00:00:00.000Z"));
    const outsiders: string[] = [];
    for (let i = 0; i < 12; i += 1) outsiders.push(await mkHuman(`Outsider ${i}`));

    expect(await count()).toBe(0);

    // None of these count.
    const member = await mkHuman("Team member");
    await prisma.orgMember.create({ data: { orgId: org.id, humanId: member, role: "ADMIN" } });
    await scan(past, member); // an org member's ticket
    await scan(past, outsiders[0]!, { scannerId: outsiders[0]! }); // self-scan
    await scan(past, outsiders[1]!, { message: "POS_AUTO_ADMIT" });
    await scan(past, outsiders[1]!, { message: "POS_CASH_AUTO_ADMIT" });
    await scan(past, outsiders[1]!, { outcome: "REJECTED" });
    // Scanned days before the doors (outside the 6h window).
    await scan(past, outsiders[2]!, {
      scannedAt: new Date(past.startsAt.getTime() - 3 * DAY),
    });
    // An event that ended less than 24h ago, and a future one.
    const recent = await mkEvent(new Date(now.getTime() - 2 * 3600_000));
    await scan(recent, outsiders[3]!);
    const future = await mkEvent(new Date("2026-12-01T00:00:00.000Z"));
    await scan(future, outsiders[4]!);
    expect(await count()).toBe(0);

    // 9 distinct outsiders (one scanned twice, one scanned 5h before start).
    await scan(past, outsiders[5]!, {
      scannedAt: new Date(past.startsAt.getTime() - 5 * 3600_000),
    });
    for (let i = 6; i < 14; i += 1) {
      await scan(past, outsiders[i % 12]!);
    }
    await scan(past, outsiders[6]!);
    // outsiders 5..11 + 0, 1 (i=12,13 → 0,1 by scanner organizer): 9 distinct.
    expect(await count()).toBe(9);
    await scan(past, outsiders[2]!);
    expect(await count()).toBe(10);
    // Capped: never counts past `cap`.
    await scan(past, outsiders[3]!);
    expect(await count(owner, 10)).toBe(10);
    expect(await count(owner, 5)).toBe(5);
    // Another owner's record is not this one's.
    expect(await count({ humanId: guestBId })).toBe(0);

    // Person-owned: the owner human's own ticket doesn't count.
    const ownerHuman = await mkHuman("Solo organiser");
    const solo = await mkEvent(new Date("2026-09-01T00:00:00.000Z"), {
      humanId: ownerHuman,
    });
    await scan(solo, ownerHuman, { scannerId: organizerId });
    await scan(solo, outsiders[0]!, { scannerId: ownerHuman });
    expect(await count({ humanId: ownerHuman })).toBe(1);
  }, 120_000);

  test("track record: only PAID tickets of VERIFIED holders count (comps, $0 cash, POS, refunds don't)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const tickets = makeTicketsRepo(prisma);
    const now = new Date("2026-10-05T12:00:00.000Z");
    const org = await prisma.organization.create({
      data: { name: "Paid Org", slug: `paid-${randomBytes(4).toString("hex")}` },
    });
    const { mkHuman, mkEvent, scan } = trackKit(org.id);
    const count = () =>
      tickets.countDistinctDoorScannedHolders({
        owner: { orgId: org.id },
        endedBefore: new Date(now.getTime() - 86_400_000),
        doorLeadSeconds: 6 * 3600,
        cap: 10,
      });
    const past = await mkEvent(new Date("2026-09-01T00:00:00.000Z"));
    const tenScans = async (opts: Parameters<typeof scan>[2], verified: boolean | null = true) => {
      for (let i = 0; i < 10; i += 1) {
        await scan(past, await mkHuman(`H ${i}`, { verified }), opts);
      }
    };

    await tenScans({ pay: "comp" });
    expect(await count()).toBe(0);
    await tenScans({ pay: "cash" });
    expect(await count()).toBe(0);
    await tenScans({ pay: "pos" }); // paid, but in person: still not counted
    expect(await count()).toBe(0);
    await tenScans({ pay: "free" });
    await tenScans({ pay: "none" }); // no order at all
    expect(await count()).toBe(0);
    await tenScans({ pay: "refunded" }); // order refunded
    await tenScans({ pay: "card", ticketStatus: "REFUNDED" }); // ticket refunded
    await tenScans({ pay: "card", ticketStatus: "INVALID" }); // voided
    expect(await count()).toBe(0);
    await tenScans({ pay: "cardZero" }); // charged online, but $0
    expect(await count()).toBe(0);
    await tenScans({ pay: "compCharged" }); // a comp, whatever else it carries
    expect(await count()).toBe(0);
    await tenScans({ pay: "disputed" });
    expect(await count()).toBe(0);
    await tenScans({ pay: "card" }, false); // unverified account
    await tenScans({ pay: "card" }, null); // no account (phantom Human)
    expect(await count()).toBe(0);

    // A card-paid RESALE order with a verified holder is real money too.
    await scan(past, await mkHuman("Resale buyer"), { pay: "resale" });
    expect(await count()).toBe(1);

    await tenScans({ pay: "card" });
    expect(await count()).toBe(10);
  }, 240_000);

  test("track record: a transferred payout counts", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const payoutItems = makePayoutItemsRepo(prisma);
    const now = new Date("2026-10-05T12:00:00.000Z");
    const org = await prisma.organization.create({
      data: { name: "Payout Org", slug: `payout-${randomBytes(4).toString("hex")}` },
    });
    const subject = { subjectType: "ORGANIZATION" as const, subjectId: org.id };
    expect(await payoutItems.subjectHasTransferredPayout(subject)).toBe(false);
    const payee = await prisma.payee.create({
      data: { subjectType: "ORGANIZATION", subjectId: org.id },
    });
    const payout = await prisma.payout.create({ data: { scheduledFor: now } });
    const item = await prisma.payoutItem.create({
      data: { payoutId: payout.id, payeeId: payee.id, amountCents: 1000 },
    });
    expect(await payoutItems.subjectHasTransferredPayout(subject)).toBe(false);
    await prisma.payoutItem.update({ where: { id: item.id }, data: { status: "transferred" } });
    expect(await payoutItems.subjectHasTransferredPayout(subject)).toBe(true);
    expect(
      await payoutItems.subjectHasTransferredPayout({ subjectType: "HUMAN", subjectId: org.id }),
    ).toBe(false);
  }, 60_000);

  test("eventUnlocks.repointInvite: guarded on event, human, from-invite and live", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const unlocksRepo = makeEventUnlocksRepo(prisma);
    const invites = makeEventInvitesRepo(prisma);
    const ev = { id: await newEvent("Repoint") };
    const sharedInv = await invites.create({
      kind: "SHARED",
      eventId: ev.id,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
    });
    const personal = await invites.create({
      kind: "PERSONAL",
      eventId: ev.id,
      tokenHash: freshHash(),
      createdByHumanId: organizerId,
      inviteeName: "P",
      inviteeEmail: `p-${randomBytes(3).toString("hex")}@example.com`,
    });
    await unlocksRepo.upsert({
      eventId: ev.id,
      humanId: guestAId,
      source: "MAGIC_LINK",
      applicationSubmissionId: null,
      inviteId: sharedInv.id,
    });
    const args = {
      eventId: ev.id,
      humanId: guestAId,
      fromInviteIds: [sharedInv.id],
      toInviteId: personal.id,
    };
    expect(await unlocksRepo.repointInvite({ ...args, humanId: guestBId })).toBe(false);
    expect(await unlocksRepo.repointInvite({ ...args, fromInviteIds: [] })).toBe(false);
    expect(await unlocksRepo.repointInvite(args)).toBe(true);
    expect((await unlocksRepo.get(ev.id, guestAId))?.inviteId).toBe(personal.id);
    // Already moved: the from-invite no longer matches.
    expect(await unlocksRepo.repointInvite(args)).toBe(false);
    // A revoked unlock is never moved.
    await unlocksRepo.revokeByInvite(personal.id, new Date());
    expect(
      await unlocksRepo.repointInvite({
        ...args,
        fromInviteIds: [personal.id],
        toInviteId: sharedInv.id,
      }),
    ).toBe(false);
  }, 60_000);
});
