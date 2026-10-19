/**
 * Integration coverage for the generic volunteer-ask surface of the
 * volunteering Prisma repo (step A2 of the 2026-06-29
 * generic-volunteering-asks spec), against real Postgres.
 *
 * What the unit tests can't verify with a stubbed repo:
 *
 *  - The raw partial unique index "VolunteerAsk_event_subject_key"
 *    (SQL-only — invisible to the Prisma schema) actually rejects a second
 *    EVENT-subject ask per event, and the adapter maps that P2002 to the
 *    domain conflict `{ code: "duplicate_event_ask" }`.
 *  - Group-scoped signup listing returns ONLY that group's rows and the
 *    general-pool query (`groupId: null`) excludes grouped signups — the
 *    query primitives coordinator PII scoping (NFR-003) sits on.
 *  - Broadcast recipient queries resolve the right audience per scope
 *    (ALL | ROLE | GROUP | POOL) and never include non-accepted signups.
 *  - The .ics feed queries join shift/event (event path) and the ask
 *    window (ask path) correctly and respect the `from` bound.
 *
 * Harness: same pattern as volunteering-occupancy / checkout-repos — an
 * ephemeral database per suite (Testcontainers, or a throwaway database on
 * a host Postgres when TESTCONTAINERS_REUSE_DATABASE_URL is set), migrated
 * via `prisma migrate deploy` and dropped in afterAll. Every test seeds its
 * own fixture chain with unique ids, so reruns are safe. When no database
 * is reachable, setup fails and every test skips cleanly.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeVolunteeringRepo } from "../../src/db/prisma/volunteering";

const uniqueEmail = () => `vol-ask-${randomUUID()}@example.test`;

/**
 * The caller clock handed to `listCommitmentsByHuman`. Fixed, not
 * `new Date()`, so the upcoming/past claim split is deterministic: every
 * occurrence seeded below sits unambiguously on one side of it.
 */
const NOW = new Date("2026-06-10T12:00:00Z");

describe("Prisma volunteering repo integration – generic asks", () => {
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
      console.error("[volunteering-asks.test] setup failed:", err);
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

  // ── Fixture helpers ────────────────────────────────────────────────────

  async function seedOrg(db: PrismaClient) {
    const tag = randomUUID().slice(0, 8);
    return db.organization.create({
      data: {
        name: `Vol Ask Org ${tag}`,
        slug: `vol-ask-org-${tag}`,
        status: "ACTIVE",
      },
    });
  }

  async function seedEvent(db: PrismaClient, orgId: string) {
    const tag = randomUUID().slice(0, 8);
    return db.event.create({
      data: {
        orgId,
        title: `Vol Ask Event ${tag}`,
        startsAt: new Date("2027-03-01T20:00:00Z"),
        endsAt: new Date("2027-03-01T23:00:00Z"),
        status: "PUBLISHED",
        volunteeringEnabled: true,
        timezone: "America/Chicago",
        addressText: "123 Test St",
      },
    });
  }

  async function seedHuman(
    db: PrismaClient,
    opts?: { name?: string; withEmail?: boolean },
  ) {
    const tag = randomUUID().slice(0, 8);
    const human = await db.human.create({
      data: { name: opts?.name ?? `Vol Human ${tag}` },
    });
    let email: string | null = null;
    if (opts?.withEmail) {
      email = uniqueEmail();
      await db.authUser.create({
        data: { humanId: human.id, name: human.name ?? "vol", email },
      });
    }
    return { human, email };
  }

  /** Ask + one ask-owned role — the minimal generic-ask fixture. */
  async function seedAskWithRole(
    db: PrismaClient,
    orgId: string,
    opts?: { startsAt?: Date | null; endsAt?: Date | null },
  ) {
    const repo = makeVolunteeringRepo(db);
    const ask = await repo.createAsk({
      subjectType: "ORG",
      subjectId: orgId,
      orgId,
      title: `Standing pool ${randomUUID().slice(0, 8)}`,
      status: "OPEN",
      cadence: "ONGOING",
      startsAt: opts?.startsAt ?? null,
      endsAt: opts?.endsAt ?? null,
    });
    const role = await repo.createEventRole({
      askId: ask.id,
      name: "Door",
    });
    return { repo, ask, role };
  }

  async function createAskSignup(
    repo: ReturnType<typeof makeVolunteeringRepo>,
    args: {
      askId: string;
      roleId: string;
      groupId?: string | null;
      humanId?: string | null;
      status?: "PENDING" | "APPROVED" | "REJECTED" | "CHECKED_IN";
      contactName?: string | null;
    },
  ) {
    return repo.createSignup({
      askId: args.askId,
      roleId: args.roleId,
      groupId: args.groupId ?? null,
      humanId: args.humanId ?? null,
      contactEmail: uniqueEmail(),
      contactName: args.contactName ?? null,
      status: args.status ?? "PENDING",
    });
  }

  // ── Asks ───────────────────────────────────────────────────────────────

  test(
    "ask CRUD round-trips and lists by subject / org with status filter",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const repo = makeVolunteeringRepo(prisma);
      const org = await seedOrg(prisma);

      const created = await repo.createAsk({
        subjectType: "ORG",
        subjectId: org.id,
        orgId: org.id,
        title: "Street team",
        description: "Ongoing street team",
        cadence: "ONGOING",
        capacity: 12,
        autoApprove: true,
        smsOptInEnabled: true,
        formSchema: { questions: [{ id: "q1", label: "Why?" }] },
      });
      expect(created).toMatchObject({
        subjectType: "ORG",
        subjectId: org.id,
        orgId: org.id,
        title: "Street team",
        status: "DRAFT",
        cadence: "ONGOING",
        capacity: 12,
        autoApprove: true,
        waiverRequired: false,
        smsOptInEnabled: true,
      });
      expect(created.formSchema).toEqual({
        questions: [{ id: "q1", label: "Why?" }],
      });

      const fetched = await repo.getAsk(created.id);
      expect(fetched).toEqual(created);

      const updated = await repo.updateAsk(created.id, {
        status: "OPEN",
        title: "Street team 2.0",
        capacity: null,
        startsAt: new Date("2027-04-01T00:00:00Z"),
      });
      expect(updated).toMatchObject({
        id: created.id,
        status: "OPEN",
        title: "Street team 2.0",
        capacity: null,
      });
      expect(updated.startsAt?.toISOString()).toBe("2027-04-01T00:00:00.000Z");
      // Untouched fields survive a partial patch.
      expect(updated.autoApprove).toBe(true);

      const bySubject = await repo.listAsksBySubject("ORG", org.id);
      expect(bySubject.map((a) => a.id)).toContain(created.id);

      const byOrgOpen = await repo.listAsksByOrg(org.id, { status: "OPEN" });
      expect(byOrgOpen.map((a) => a.id)).toContain(created.id);
      const byOrgDraft = await repo.listAsksByOrg(org.id, { status: "DRAFT" });
      expect(byOrgDraft.map((a) => a.id)).not.toContain(created.id);
    },
    300_000,
  );

  test(
    "listAsksByOrg (standing dashboard) excludes EVENT-subject asks",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const repo = makeVolunteeringRepo(prisma);
      const org = await seedOrg(prisma);
      const event = await seedEvent(prisma, org.id);

      // A real standing (ORG-subject) ask on the org…
      const standing = await repo.createAsk({
        subjectType: "ORG",
        subjectId: org.id,
        orgId: org.id,
        title: "Street team",
      });
      // …and an EVENT-subject ask backfilled on the SAME orgId (managed on
      // the per-event volunteer page, not the standing dashboard).
      const eventAsk = await repo.createAsk({
        subjectType: "EVENT",
        subjectId: event.id,
        orgId: org.id,
        title: "Event crew",
      });

      const byOrg = await repo.listAsksByOrg(org.id);
      const ids = byOrg.map((a) => a.id);
      expect(ids).toContain(standing.id);
      expect(ids).not.toContain(eventAsk.id);
      expect(byOrg.every((a) => a.subjectType !== "EVENT")).toBe(true);
    },
    300_000,
  );

  test(
    "at most one EVENT-subject ask per event; other subjects unconstrained",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const repo = makeVolunteeringRepo(prisma);
      const org = await seedOrg(prisma);
      const event = await seedEvent(prisma, org.id);

      const first = await repo.createAsk({
        subjectType: "EVENT",
        subjectId: event.id,
        orgId: org.id,
        title: "Event crew",
      });
      expect(first.subjectId).toBe(event.id);

      // Second EVENT-subject ask on the same event → the raw partial
      // unique index fires and the adapter maps it to the domain conflict.
      await expect(
        repo.createAsk({
          subjectType: "EVENT",
          subjectId: event.id,
          orgId: org.id,
          title: "Event crew (dupe)",
        }),
      ).rejects.toMatchObject({ code: "duplicate_event_ask" });

      // Non-EVENT subjects are NOT constrained — two ORG asks coexist.
      await repo.createAsk({
        subjectType: "ORG",
        subjectId: org.id,
        title: "Pool A",
      });
      await repo.createAsk({
        subjectType: "ORG",
        subjectId: org.id,
        title: "Pool B",
      });
      const asks = await repo.listAsksBySubject("ORG", org.id);
      expect(asks.length).toBeGreaterThanOrEqual(2);
    },
    300_000,
  );

  test(
    "createAskIfAbsent: races resolve to the same ask and never abort the surrounding tx",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const repo = makeVolunteeringRepo(prisma);
      const org = await seedOrg(prisma);
      const event = await seedEvent(prisma, org.id);

      const draft = {
        subjectType: "EVENT" as const,
        subjectId: event.id,
        orgId: org.id,
        title: "Event crew",
        status: "OPEN" as const,
      };

      // Two createAskIfAbsent calls for the same event in SEPARATE
      // transactions: the first wins, the second silently no-ops
      // (ON CONFLICT DO NOTHING against the raw partial unique index),
      // and the follow-up re-read resolves both to the same row.
      const first = await prisma.$transaction(async (tx) => {
        const txRepo = makeVolunteeringRepo(tx);
        await txRepo.createAskIfAbsent(draft);
        const [ask] = await txRepo.listAsksBySubject("EVENT", event.id);
        return ask!;
      });
      const second = await prisma.$transaction(async (tx) => {
        const txRepo = makeVolunteeringRepo(tx);
        await txRepo.createAskIfAbsent({
          ...draft,
          title: "Event crew (race loser)",
        });
        const [ask] = await txRepo.listAsksBySubject("EVENT", event.id);
        return ask!;
      });
      expect(second.id).toBe(first.id);
      expect(second.title).toBe("Event crew"); // winner's data, not the loser's

      // The abort-safety property itself: a conflicting insert INSIDE an
      // interactive tx, racing a competing COMMITTED insert, must not
      // poison the tx (25P02) — later statements in the SAME tx still work.
      // (A plain createAsk here would throw P2002 and abort the tx,
      // failing the post-conflict re-read.)
      await prisma.$transaction(async (tx) => {
        const txRepo = makeVolunteeringRepo(tx);
        await txRepo.createAskIfAbsent(draft); // conflicts with committed row
        const stillHealthy = await txRepo.listAsksBySubject("EVENT", event.id);
        expect(stillHealthy[0]?.id).toBe(first.id);
      });

      // Exactly one EVENT-subject row ever landed.
      const all = await repo.listAsksBySubject("EVENT", event.id);
      expect(all).toHaveLength(1);
    },
    300_000,
  );

  // ── Roles ──────────────────────────────────────────────────────────────

  test(
    "ask-owned roles: createEventRole(askId) + defaultHours + listRolesByAsk",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const org = await seedOrg(prisma);
      const { repo, ask, role } = await seedAskWithRole(prisma, org.id);

      expect(role).toMatchObject({
        askId: ask.id,
        eventId: null,
        name: "Door",
        defaultHours: null,
      });

      const withHours = await repo.createEventRole({
        askId: ask.id,
        name: "Bar",
        defaultHours: 2.5,
      });
      expect(withHours.defaultHours).toBe(2.5);

      const listed = await repo.listRolesByAsk(ask.id);
      expect(listed.map((r) => r.id).sort()).toEqual(
        [role.id, withHours.id].sort(),
      );
      expect(listed.every((r) => Array.isArray(r.shifts))).toBe(true);

      const bumped = await repo.updateEventRole(withHours.id, {
        defaultHours: 4,
      });
      expect(bumped.defaultHours).toBe(4);
      const cleared = await repo.updateEventRole(withHours.id, {
        defaultHours: null,
      });
      expect(cleared.defaultHours).toBeNull();
    },
    300_000,
  );

  test(
    "role names are unique per ask; duplicate maps to duplicate_role_name",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const org = await seedOrg(prisma);
      const { repo, ask } = await seedAskWithRole(prisma, org.id);

      // Same name on the same ask → @@unique([askId, name]) fires and the
      // adapter maps the P2002 to the domain conflict.
      await expect(
        repo.createEventRole({ askId: ask.id, name: "Door" }),
      ).rejects.toMatchObject({ code: "duplicate_role_name" });

      // Same name on a DIFFERENT ask is fine.
      const { role: otherRole } = await seedAskWithRole(prisma, org.id);
      expect(otherRole.name).toBe("Door");
    },
    300_000,
  );

  // ── Groups ─────────────────────────────────────────────────────────────

  test(
    "group CRUD, coordinator assignment, and accepted member counts",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const org = await seedOrg(prisma);
      const { repo, ask, role } = await seedAskWithRole(prisma, org.id);
      const { human: coordinator } = await seedHuman(
        prisma,
        { name: "Coord Casey", withEmail: true },
      );

      const groupA = await repo.createGroup({
        askId: ask.id,
        name: "Alpha",
        description: "First group",
        capacity: 5,
      });
      const groupB = await repo.createGroup({ askId: ask.id, name: "Beta" });
      expect(groupA).toMatchObject({
        askId: ask.id,
        name: "Alpha",
        capacity: 5,
        coordinatorHumanId: null,
      });

      await repo.setGroupCoordinator(groupA.id, coordinator.id);

      // Members: 2 accepted + 1 pending in Alpha, 1 accepted in Beta.
      await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        groupId: groupA.id,
        status: "APPROVED",
      });
      await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        groupId: groupA.id,
        status: "CHECKED_IN",
      });
      await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        groupId: groupA.id,
        status: "PENDING",
      });
      const bMember = await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        groupId: groupB.id,
        status: "APPROVED",
      });

      const groups = await repo.listGroupsByAsk(ask.id);
      const a = groups.find((g) => g.id === groupA.id)!;
      const b = groups.find((g) => g.id === groupB.id)!;
      // Accepted only — the pending Alpha signup doesn't occupy a seat.
      expect(a.memberCount).toBe(2);
      // Name only: returning the account email made this an email/humanId
      // lookup for any ask owner (2026-09-29 security review).
      expect(a.coordinator).toEqual({
        humanId: coordinator.id,
        name: "Coord Casey",
      });
      expect(a.coordinator).not.toHaveProperty("email");
      expect(b.memberCount).toBe(1);
      expect(b.coordinator).toBeNull();

      const renamed = await repo.updateGroup(groupA.id, {
        name: "Alpha Prime",
        capacity: null,
      });
      expect(renamed).toMatchObject({ name: "Alpha Prime", capacity: null });

      const clearedCoord = await repo.setGroupCoordinator(groupA.id, null);
      expect(clearedCoord.coordinatorHumanId).toBeNull();

      // Deleting a group releases members to the pool (FK SetNull).
      await repo.deleteGroup(groupB.id);
      expect(await repo.getGroup(groupB.id)).toBeNull();
      const released = await repo.getSignup(bMember.id);
      expect(released?.groupId).toBeNull();
    },
    300_000,
  );

  test(
    "group names are unique per ask; duplicate maps to duplicate_group_name",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const org = await seedOrg(prisma);
      const { repo, ask } = await seedAskWithRole(prisma, org.id);
      await repo.createGroup({ askId: ask.id, name: "Crew" });

      // Same name on the same ask → @@unique([askId, name]) fires and the
      // adapter maps the P2002 to the domain conflict.
      await expect(
        repo.createGroup({ askId: ask.id, name: "Crew" }),
      ).rejects.toMatchObject({ code: "duplicate_group_name" });

      // Same name on a DIFFERENT ask is fine.
      const { ask: otherAsk } = await seedAskWithRole(prisma, org.id);
      const other = await repo.createGroup({ askId: otherAsk.id, name: "Crew" });
      expect(other).toMatchObject({ askId: otherAsk.id, name: "Crew" });
    },
    300_000,
  );

  // ── Signups: scoping + pool ────────────────────────────────────────────

  test(
    "ask signup listing: group scoping never leaks, pool excludes grouped",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const org = await seedOrg(prisma);
      const { repo, ask, role } = await seedAskWithRole(prisma, org.id);
      const groupA = await repo.createGroup({ askId: ask.id, name: "A" });
      const groupB = await repo.createGroup({ askId: ask.id, name: "B" });

      const inA = await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        groupId: groupA.id,
        status: "APPROVED",
      });
      const inB = await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        groupId: groupB.id,
        status: "APPROVED",
      });
      const poolApproved = await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        status: "APPROVED",
      });
      const poolPending = await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        status: "PENDING",
      });

      // Group-scoped list returns ONLY that group's rows (NFR-003
      // primitive: no cross-group leakage, no pool rows).
      const onlyA = await repo.listSignupsByAsk(ask.id, { groupId: groupA.id });
      expect(onlyA.items.map((s) => s.id)).toEqual([inA.id]);

      // General pool = unassigned + APPROVED: grouped and pending excluded.
      const pool = await repo.listSignupsByAsk(ask.id, {
        groupId: null,
        status: "APPROVED",
      });
      expect(pool.items.map((s) => s.id)).toEqual([poolApproved.id]);

      // Unfiltered ask list sees everything on the ask.
      const all = await repo.listSignupsByAsk(ask.id);
      expect(all.pageInfo.total).toBe(4);
      expect(all.items.map((s) => s.id).sort()).toEqual(
        [inA.id, inB.id, poolApproved.id, poolPending.id].sort(),
      );

      // Duplicate lookup works on the ask key…
      const found = await repo.getSignupByEmail({
        askId: ask.id,
        roleId: role.id,
        contactEmail: poolApproved.contactEmail,
      });
      expect(found?.id).toBe(poolApproved.id);
      // …and misses on a different email.
      expect(
        await repo.getSignupByEmail({
          askId: ask.id,
          roleId: role.id,
          contactEmail: uniqueEmail(),
        }),
      ).toBeNull();

      // assignSignupToGroup: pool → A → back to the pool.
      const assigned = await repo.assignSignupToGroup(
        poolApproved.id,
        groupA.id,
      );
      expect(assigned.groupId).toBe(groupA.id);
      const releasedPool = await repo.listSignupsByAsk(ask.id, {
        groupId: null,
        status: "APPROVED",
      });
      expect(releasedPool.items).toHaveLength(0);
      const unassigned = await repo.assignSignupToGroup(poolApproved.id, null);
      expect(unassigned.groupId).toBeNull();
    },
    300_000,
  );

  test(
    "legacy event key on getSignupByEmail still resolves event signups",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const repo = makeVolunteeringRepo(prisma);
      const org = await seedOrg(prisma);
      const event = await seedEvent(prisma, org.id);
      const role = await repo.createEventRole({
        eventId: event.id,
        name: "Security",
      });
      const email = uniqueEmail();
      const signup = await repo.createSignup({
        eventId: event.id,
        roleId: role.id,
        contactEmail: email,
      });
      expect(signup).toMatchObject({
        eventId: event.id,
        askId: null,
        groupId: null,
      });

      const found = await repo.getSignupByEmail({
        eventId: event.id,
        roleId: role.id,
        contactEmail: email,
      });
      expect(found?.id).toBe(signup.id);
    },
    300_000,
  );

  // ── Broadcasts ─────────────────────────────────────────────────────────

  test(
    "broadcast ledger writes and recipients resolve per scope",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const org = await seedOrg(prisma);
      const { repo, ask, role } = await seedAskWithRole(prisma, org.id);
      const otherRole = await repo.createEventRole({
        askId: ask.id,
        name: "Bar",
      });
      const group = await repo.createGroup({ askId: ask.id, name: "Crew" });
      const { human: sender } = await seedHuman(prisma);

      const grouped = await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        groupId: group.id,
        status: "APPROVED",
      });
      const poolCheckedIn = await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        status: "CHECKED_IN",
      });
      const poolOtherRole = await createAskSignup(repo, {
        askId: ask.id,
        roleId: otherRole.id,
        status: "APPROVED",
      });
      // Never deliverable: pending + rejected.
      await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        status: "PENDING",
      });
      await createAskSignup(repo, {
        askId: ask.id,
        roleId: role.id,
        status: "REJECTED",
      });

      const ids = (rows: { signupId: string }[]) =>
        rows.map((r) => r.signupId).sort();

      const all = await repo.listBroadcastRecipients(ask.id, { kind: "ALL" });
      expect(ids(all)).toEqual(
        [grouped.id, poolCheckedIn.id, poolOtherRole.id].sort(),
      );

      const byRole = await repo.listBroadcastRecipients(ask.id, {
        kind: "ROLE",
        roleId: otherRole.id,
      });
      expect(ids(byRole)).toEqual([poolOtherRole.id]);

      const byGroup = await repo.listBroadcastRecipients(ask.id, {
        kind: "GROUP",
        groupId: group.id,
      });
      expect(ids(byGroup)).toEqual([grouped.id]);

      const byPool = await repo.listBroadcastRecipients(ask.id, {
        kind: "POOL",
      });
      expect(ids(byPool)).toEqual([poolCheckedIn.id, poolOtherRole.id].sort());
      // Recipient rows carry the contact projection the dispatcher needs.
      expect(byGroup[0]).toEqual({
        signupId: grouped.id,
        humanId: null,
        contactEmail: grouped.contactEmail,
        contactName: null,
      });

      const broadcast = await repo.createBroadcast({
        askId: ask.id,
        senderHumanId: sender.id,
        scopeType: "GROUP",
        scopeId: group.id,
        subject: "Crew — Saturday call time",
        body: "Doors at 6, please arrive 5:30.",
        recipientCount: byGroup.length,
      });
      expect(broadcast).toMatchObject({
        askId: ask.id,
        senderHumanId: sender.id,
        scopeType: "GROUP",
        scopeId: group.id,
        recipientCount: 1,
      });
      const history = await repo.listBroadcastsByAsk(ask.id);
      expect(history.map((b) => b.id)).toEqual([broadcast.id]);
    },
    300_000,
  );

  // ── ICS feed ───────────────────────────────────────────────────────────

  test(
    "ics feed: token lifecycle + upcoming event-shift and ask-window rows",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const repo = makeVolunteeringRepo(prisma);
      const org = await seedOrg(prisma);
      const { human } = await seedHuman(prisma);

      // Token lifecycle.
      expect(await repo.getVolunteerIcsFeedToken(human.id)).toBeNull();
      const token = `feed-${randomUUID()}`;
      await repo.setVolunteerIcsFeedToken(human.id, token);
      expect(await repo.getVolunteerIcsFeedToken(human.id)).toBe(token);
      expect(await repo.findHumanIdByIcsFeedToken(token)).toBe(human.id);
      expect(
        await repo.findHumanIdByIcsFeedToken(`feed-${randomUUID()}`),
      ).toBeNull();

      const from = new Date("2027-01-01T00:00:00Z");

      // Event path: approved signup on a future shift…
      const event = await seedEvent(prisma, org.id);
      const eventRole = await repo.createEventRole({
        eventId: event.id,
        name: "Setup",
      });
      const futureShift = await repo.createShift({
        roleId: eventRole.id,
        label: "Load-in",
        startsAt: new Date("2027-03-01T17:00:00Z"),
        endsAt: new Date("2027-03-01T20:00:00Z"),
      });
      const shiftSignup = await repo.createSignup({
        eventId: event.id,
        roleId: eventRole.id,
        shiftId: futureShift.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "APPROVED",
      });
      // …a PAST shift signup (excluded by `from`)…
      const pastShift = await repo.createShift({
        roleId: eventRole.id,
        startsAt: new Date("2026-01-01T17:00:00Z"),
        endsAt: new Date("2026-01-01T20:00:00Z"),
      });
      await repo.createSignup({
        eventId: event.id,
        roleId: eventRole.id,
        shiftId: pastShift.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "APPROVED",
      });
      // …and a shiftless event signup (no window → excluded).
      const otherEvent = await seedEvent(prisma, org.id);
      const otherRole = await repo.createEventRole({
        eventId: otherEvent.id,
        name: "Door",
      });
      await repo.createSignup({
        eventId: otherEvent.id,
        roleId: otherRole.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "APPROVED",
      });

      // Ask path: windowed ask (included, earlier than the shift)…
      const { ask: windowedAsk, role: askRole } = await seedAskWithRole(
        prisma,
        org.id,
        {
          startsAt: new Date("2027-02-01T15:00:00Z"),
          endsAt: new Date("2027-02-01T18:00:00Z"),
        },
      );
      const askSignup = await repo.createSignup({
        askId: windowedAsk.id,
        roleId: askRole.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "CHECKED_IN",
      });
      // …and a windowless ask (excluded).
      const { ask: windowlessAsk, role: windowlessRole } =
        await seedAskWithRole(prisma, org.id);
      await repo.createSignup({
        askId: windowlessAsk.id,
        roleId: windowlessRole.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "APPROVED",
      });

      const feed = await repo.listUpcomingSignupsForFeed(human.id, from);
      expect(feed.map((f) => f.signupId)).toEqual([
        askSignup.id, // 2027-02-01 — sorted soonest first
        shiftSignup.id, // 2027-03-01
      ]);

      const askRow = feed[0]!;
      expect(askRow).toMatchObject({
        source: "ASK_WINDOW",
        title: windowedAsk.title,
        roleName: "Door",
        shiftLabel: null,
        askId: windowedAsk.id,
        eventId: null,
        eventSlug: null,
      });
      expect(askRow.startsAt.toISOString()).toBe("2027-02-01T15:00:00.000Z");
      expect(askRow.endsAt?.toISOString()).toBe("2027-02-01T18:00:00.000Z");

      const shiftRow = feed[1]!;
      expect(shiftRow).toMatchObject({
        source: "EVENT_SHIFT",
        title: event.title,
        roleName: "Setup",
        shiftLabel: "Load-in",
        eventId: event.id,
        eventTimezone: "America/Chicago",
        addressText: "123 Test St",
        askId: null,
      });
      expect(shiftRow.startsAt.toISOString()).toBe("2027-03-01T17:00:00.000Z");
    },
    300_000,
  );

  // ── "My volunteering" page ─────────────────────────────────────────────

  test(
    "commitments: every status, past rows, windowless rows, scoped to one human",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const repo = makeVolunteeringRepo(prisma);
      const org = await seedOrg(prisma);
      const { human } = await seedHuman(prisma);
      const { human: stranger } = await seedHuman(prisma);

      const event = await seedEvent(prisma, org.id);
      const eventRole = await repo.createEventRole({
        eventId: event.id,
        name: "Setup",
      });

      // A PAST shift, REJECTED — both facts exclude it from the .ics feed.
      const pastShift = await repo.createShift({
        roleId: eventRole.id,
        label: "Teardown",
        startsAt: new Date("2025-01-05T17:00:00Z"),
        endsAt: new Date("2025-01-05T20:00:00Z"),
      });
      const pastSignup = await repo.createSignup({
        eventId: event.id,
        roleId: eventRole.id,
        shiftId: pastShift.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "REJECTED",
      });

      // A future shift, PENDING — the "awaiting confirmation" section.
      const futureShift = await repo.createShift({
        roleId: eventRole.id,
        label: "Load-in",
        startsAt: new Date("2027-03-01T17:00:00Z"),
        endsAt: new Date("2027-03-01T20:00:00Z"),
      });
      const pendingSignup = await repo.createSignup({
        eventId: event.id,
        roleId: eventRole.id,
        shiftId: futureShift.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "PENDING",
      });

      // A shiftless event signup on a second event — WINDOWLESS. Modelled
      // the way production rows actually look: `askId` points at the
      // event's EVENT-subject ask (what the A1 backfill stamped and what
      // `resolveOrCreateEventAsk` stamps on new rows), and that ask has NO
      // window — which is what makes the row windowless.
      const otherEvent = await seedEvent(prisma, org.id);
      const otherRole = await repo.createEventRole({
        eventId: otherEvent.id,
        name: "Door",
      });
      const otherEventAsk = await repo.createAsk({
        subjectType: "EVENT",
        subjectId: otherEvent.id,
        orgId: org.id,
        title: otherEvent.title,
        status: "OPEN",
        cadence: "ONE_TIME",
      });
      const shiftlessSignup = await repo.createSignup({
        eventId: otherEvent.id,
        askId: otherEventAsk.id,
        roleId: otherRole.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "WITHDRAWN",
      });

      // A windowed ask signup, CHECKED_IN, between the two dated rows.
      const { ask: windowedAsk, role: askRole } = await seedAskWithRole(
        prisma,
        org.id,
        {
          startsAt: new Date("2027-02-01T15:00:00Z"),
          endsAt: new Date("2027-02-01T18:00:00Z"),
        },
      );
      const askSignup = await repo.createSignup({
        askId: windowedAsk.id,
        roleId: askRole.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "CHECKED_IN",
      });

      // A windowless ask signup — the feed drops it, the page keeps it.
      const { ask: windowlessAsk, role: windowlessRole } =
        await seedAskWithRole(prisma, org.id);
      const windowlessAskSignup = await repo.createSignup({
        askId: windowlessAsk.id,
        roleId: windowlessRole.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "APPROVED",
      });

      // Another human's signup — must never appear.
      await repo.createSignup({
        eventId: event.id,
        roleId: eventRole.id,
        shiftId: futureShift.id,
        humanId: stranger.id,
        contactEmail: uniqueEmail(),
        status: "APPROVED",
      });

      const rows = await repo.listCommitmentsByHuman(human.id, NOW);

      // startsAt ASC with the windowless rows LAST. (The createdAt DESC
      // tiebreak inside that tail is asserted deterministically in the
      // unit test — two inserts can share a millisecond here.)
      expect(rows.slice(0, 3).map((r) => r.signupId)).toEqual([
        pastSignup.id, // 2025-01-05 — past rows are in
        askSignup.id, // 2027-02-01
        pendingSignup.id, // 2027-03-01
      ]);
      expect(rows.slice(3).map((r) => r.signupId).sort()).toEqual(
        [windowlessAskSignup.id, shiftlessSignup.id].sort(),
      );

      // Every status is readable, not just APPROVED | CHECKED_IN.
      expect(rows.map((r) => r.status).sort()).toEqual([
        "APPROVED",
        "CHECKED_IN",
        "PENDING",
        "REJECTED",
        "WITHDRAWN",
      ]);

      const byId = new Map(rows.map((r) => [r.signupId, r]));

      expect(byId.get(pendingSignup.id)).toMatchObject({
        source: "EVENT_SHIFT",
        title: event.title,
        roleName: "Setup",
        shiftLabel: "Load-in",
        eventId: event.id,
        eventTimezone: "America/Chicago",
        addressText: "123 Test St",
        hoursWorked: null,
        // Derived from the 3h shift (17:00–20:00) even with no override —
        // null hoursWorked is NOT zero hours.
        hoursCredited: 3,
        checkedInAt: null,
      });

      expect(byId.get(askSignup.id)).toMatchObject({
        source: "ASK_WINDOW",
        title: windowedAsk.title,
        roleName: "Door",
        shiftLabel: null,
        askId: windowedAsk.id,
        eventId: null,
      });
      expect(byId.get(askSignup.id)!.startsAt?.toISOString()).toBe(
        "2027-02-01T15:00:00.000Z",
      );
      // The ask window is 3h here, but ask windows are NEVER converted to
      // hours — only a shift's duration is, and this row has no override.
      expect(byId.get(askSignup.id)!.hoursCredited).toBeNull();

      // Windowless rows are INCLUDED with a null window (the feed drops
      // these outright).
      expect(byId.get(windowlessAskSignup.id)).toMatchObject({
        source: "ASK_WINDOW",
        title: windowlessAsk.title,
        startsAt: null,
        endsAt: null,
      });
      // The shiftless EVENT signup resolves through its EVENT-subject ask
      // (shiftId null + askId set → the ask path), which supplies the title
      // while the joined event still supplies the link/venue fields the
      // page renders.
      expect(byId.get(shiftlessSignup.id)).toMatchObject({
        source: "ASK_WINDOW",
        startsAt: null,
        endsAt: null,
        eventId: otherEvent.id,
        title: otherEvent.title,
        addressText: "123 Test St",
      });

      // Scoping: the stranger's row is absent here, and the stranger sees
      // only their own.
      const strangerRows = await repo.listCommitmentsByHuman(stranger.id, NOW);
      expect(strangerRows).toHaveLength(1);
      expect(
        strangerRows.every((r) => rows.every((m) => m.signupId !== r.signupId)),
      ).toBe(true);

      // The .ics feed is unchanged by the shared projection: still accepted
      // statuses only, still forward-looking, still windowed rows only.
      const feed = await repo.listUpcomingSignupsForFeed(
        human.id,
        new Date("2027-01-01T00:00:00Z"),
      );
      expect(feed.map((f) => f.signupId)).toEqual([askSignup.id]);
    },
    300_000,
  );

  test(
    "commitments: standing-ask occurrence claims become their own rows and replace the parent",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const repo = makeVolunteeringRepo(prisma);
      const org = await seedOrg(prisma);
      const { human } = await seedHuman(prisma);

      // A RECURRING, OPEN-ENDED standing ask — the shape that used to
      // render "No set shift time": a start, no end, and a volunteer whose
      // real commitments live on dated occurrences.
      const standingAsk = await repo.createAsk({
        subjectType: "ORG",
        subjectId: org.id,
        orgId: org.id,
        title: "Basement Thursdays",
        status: "OPEN",
        cadence: "RECURRING",
        startsAt: new Date("2026-01-01T00:00:00Z"),
        endsAt: null,
      });
      const doorRole = await repo.createEventRole({
        askId: standingAsk.id,
        name: "Door",
      });
      const standingSignup = await repo.createSignup({
        askId: standingAsk.id,
        roleId: doorRole.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "APPROVED",
      });

      // Upcoming claimed slot (relative to NOW = 2026-06-10).
      const upcoming = await repo.createOccurrence({
        askId: standingAsk.id,
        roleId: doorRole.id,
        startsAt: new Date("2026-09-03T23:00:00Z"),
        endsAt: new Date("2026-09-04T03:00:00Z"), // 4h
      });
      const upcomingClaim = await repo.createOccurrenceClaim({
        occurrenceId: upcoming.id,
        signupId: standingSignup.id,
      });

      // Past claimed slot, checked in per-occurrence — 3.5h derived.
      const past = await repo.createOccurrence({
        askId: standingAsk.id,
        roleId: doorRole.id,
        startsAt: new Date("2026-05-07T23:00:00Z"),
        endsAt: new Date("2026-05-08T02:30:00Z"), // 3.5h
      });
      const pastClaim = await repo.createOccurrenceClaim({
        occurrenceId: past.id,
        signupId: standingSignup.id,
      });
      await repo.updateOccurrenceClaim(pastClaim.id, {
        checkedInAt: new Date("2026-05-07T23:04:00Z"),
      });

      // CANCELLED occurrence with a still-CLAIMED claim — omitted. The
      // volunteer is told by `cancelShiftOccurrence`'s fan-out, not by a
      // row wearing a status that would blame them for the cancellation.
      const cancelled = await repo.createOccurrence({
        askId: standingAsk.id,
        roleId: doorRole.id,
        startsAt: new Date("2026-10-01T23:00:00Z"),
        endsAt: new Date("2026-10-02T03:00:00Z"),
      });
      const cancelledClaim = await repo.createOccurrenceClaim({
        occurrenceId: cancelled.id,
        signupId: standingSignup.id,
      });
      await repo.updateOccurrence(cancelled.id, { status: "CANCELLED" });

      // WITHDRAWN claim on a live occurrence — gone by the volunteer's own
      // choice.
      const dropped = await repo.createOccurrence({
        askId: standingAsk.id,
        roleId: doorRole.id,
        startsAt: new Date("2026-10-08T23:00:00Z"),
        endsAt: new Date("2026-10-09T03:00:00Z"),
      });
      const droppedClaim = await repo.createOccurrenceClaim({
        occurrenceId: dropped.id,
        signupId: standingSignup.id,
      });
      await repo.updateOccurrenceClaim(droppedClaim.id, {
        status: "WITHDRAWN",
      });

      // A SECOND standing ask the volunteer holds with NO claims — its
      // parent row must survive untouched.
      const { ask: claimlessAsk, role: claimlessRole } = await seedAskWithRole(
        prisma,
        org.id,
      );
      const claimlessSignup = await repo.createSignup({
        askId: claimlessAsk.id,
        roleId: claimlessRole.id,
        humanId: human.id,
        contactEmail: uniqueEmail(),
        status: "APPROVED",
      });

      const rows = await repo.listCommitmentsByHuman(human.id, NOW);

      // The parent of the claim-bearing signup is REPLACED by its dates —
      // no windowless phantom sitting beside them.
      expect(rows.map((r) => r.claimId ?? r.signupId)).toEqual([
        pastClaim.id, // 2026-05-07
        upcomingClaim.id, // 2026-09-03
        claimlessSignup.id, // windowless — always last
      ]);
      expect(rows.some((r) => r.signupId === standingSignup.id && r.claimId === null)).toBe(false);
      // Neither excluded claim produced a row.
      expect(
        rows.some((r) => r.claimId === cancelledClaim.id || r.claimId === droppedClaim.id),
      ).toBe(false);

      const byClaim = new Map(rows.map((r) => [r.claimId, r]));

      // The upcoming slot: the OCCURRENCE's window, not the ask's
      // open-ended one, and APPROVED (claimed, not yet worked).
      expect(byClaim.get(upcomingClaim.id)).toMatchObject({
        signupId: standingSignup.id,
        occurrenceId: upcoming.id,
        status: "APPROVED",
        source: "ASK_WINDOW",
        title: "Basement Thursdays",
        roleName: "Door",
        askId: standingAsk.id,
        eventId: null,
        cadence: "RECURRING",
        hoursWorked: null,
        // 4h from the OCCURRENCE. The ask window (2026-01-01 → open) is
        // never an hours source — that path credits thousands of hours.
        hoursCredited: 4,
        checkedInAt: null,
      });
      expect(byClaim.get(upcomingClaim.id)!.startsAt?.toISOString()).toBe(
        "2026-09-03T23:00:00.000Z",
      );
      expect(byClaim.get(upcomingClaim.id)!.endsAt?.toISOString()).toBe(
        "2026-09-04T03:00:00.000Z",
      );

      // The worked slot: CHECKED_IN off the CLAIM's own check-in, 3.5h.
      expect(byClaim.get(pastClaim.id)).toMatchObject({
        occurrenceId: past.id,
        status: "CHECKED_IN",
        hoursCredited: 3.5,
      });
      expect(byClaim.get(pastClaim.id)!.checkedInAt?.toISOString()).toBe(
        "2026-05-07T23:04:00.000Z",
      );

      // The claim-less standing signup keeps its parent row exactly as before.
      expect(byClaim.get(null)).toMatchObject({
        signupId: claimlessSignup.id,
        claimId: null,
        occurrenceId: null,
        source: "ASK_WINDOW",
        startsAt: null,
        cadence: "ONGOING",
      });

      // THE FEED IS UNTOUCHED: occurrence rows must not appear in calendars
      // people are already subscribed to. The claimed slots are APPROVED
      // commitments inside the feed's window, so only the .ics read model
      // keeps them out — while the parent ask-window signup the feed has
      // ALWAYS carried is still there, un-suppressed. The page's
      // de-duplication is a page rule, not a feed rule.
      const feed = await repo.listUpcomingSignupsForFeed(
        human.id,
        new Date("2026-01-01T00:00:00Z"),
      );
      expect(feed.map((f) => f.signupId)).toEqual([standingSignup.id]);
      expect(feed[0]!.startsAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(
        feed.every((f) => !("occurrenceId" in f) && !("claimId" in f)),
      ).toBe(true);
    },
    300_000,
  );
});
