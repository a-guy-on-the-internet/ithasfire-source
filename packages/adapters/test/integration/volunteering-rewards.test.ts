/**
 * Integration coverage for the comp-ticket reward surface of the volunteering
 * Prisma repo (step B1/B2 of the 2026-06-29 volunteer-comp-tickets spec),
 * against real Postgres.
 *
 * What a stubbed repo can't verify:
 *
 *  - The raw partial unique index "VolunteerReward_ask_level_key" (SQL-only —
 *    invisible to the Prisma schema) actually rejects a SECOND ask-level
 *    (roleId IS NULL) reward, while `@@unique([askId, roleId])` alone would
 *    let two through (Postgres treats NULLs as distinct). A role-level reward
 *    coexists with the ask-level one, and the adapter maps both P2002s to the
 *    domain conflict `{ code: "duplicate_reward" }`.
 *  - `getRewardForSignup` resolution: an active role-specific reward wins over
 *    the ask-level one; inactive rewards are skipped.
 *  - `getRewardForUpdate` genuinely serializes concurrent budget mutations:
 *    two interactive transactions each read-check-increment under FOR UPDATE
 *    and, with maxGrants = 1, the counter never overshoots.
 *  - `createGrant` idempotency (`@@unique([rewardId, signupId])` → duplicate_grant)
 *    and the increment / floored-decrement budget counter.
 *  - `listGrantsByAsk` surfaces the LIVE joined `Ticket.status` on the ledger.
 *
 * Harness mirrors volunteering-asks.test.ts: an ephemeral database per suite
 * (Testcontainers), migrated via `prisma migrate deploy`, dropped in afterAll.
 * When no database is reachable, setup fails and every test skips cleanly.
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

const uniqueEmail = () => `vol-reward-${randomUUID()}@example.test`;

describe("Prisma volunteering repo integration – comp-ticket rewards", () => {
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
      console.error("[volunteering-rewards.test] setup failed:", err);
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
        name: `Vol Reward Org ${tag}`,
        slug: `vol-reward-org-${tag}`,
        status: "ACTIVE",
      },
    });
  }

  async function seedEvent(db: PrismaClient, orgId: string) {
    const tag = randomUUID().slice(0, 8);
    return db.event.create({
      data: {
        orgId,
        title: `Vol Reward Event ${tag}`,
        startsAt: new Date("2027-03-01T20:00:00Z"),
        endsAt: new Date("2027-03-01T23:00:00Z"),
        status: "PUBLISHED",
        volunteeringEnabled: true,
        timezone: "America/Chicago",
        addressText: "123 Test St",
      },
    });
  }

  async function seedTicketType(
    db: PrismaClient,
    eventId: string,
    priceCents = 2500,
  ) {
    const tag = randomUUID().slice(0, 8);
    return db.ticketType.create({
      data: {
        eventId,
        name: `GA ${tag}`,
        priceCents,
        capacity: 100,
      },
    });
  }

  async function seedHuman(db: PrismaClient) {
    return db.human.create({
      data: { name: `Vol Human ${randomUUID().slice(0, 8)}` },
    });
  }

  /**
   * EVENT-subject ask + one ask-owned role — the minimal reward fixture.
   * Rewards attach to EVENT-subject asks only (v1 resolution).
   */
  async function seedEventAskWithRole(db: PrismaClient, eventId: string, orgId: string) {
    const repo = makeVolunteeringRepo(db);
    const ask = await repo.createAsk({
      subjectType: "EVENT",
      subjectId: eventId,
      orgId,
      title: `Event crew ${randomUUID().slice(0, 8)}`,
      status: "OPEN",
    });
    const role = await repo.createEventRole({ askId: ask.id, name: "Door" });
    return { repo, ask, role };
  }

  async function seedSignup(
    repo: ReturnType<typeof makeVolunteeringRepo>,
    args: { askId: string; roleId: string; status?: "PENDING" | "APPROVED" | "CHECKED_IN" },
  ) {
    return repo.createSignup({
      askId: args.askId,
      roleId: args.roleId,
      contactEmail: uniqueEmail(),
      status: args.status ?? "APPROVED",
    });
  }

  // ── upsertReward + uniqueness ──────────────────────────────────────────

  test(
    "upsertReward creates then updates; ask-level partial unique + role coexistence",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const org = await seedOrg(prisma);
      const event = await seedEvent(prisma, org.id);
      const ticketType = await seedTicketType(prisma, event.id);
      const { repo, ask, role } = await seedEventAskWithRole(prisma, event.id, org.id);

      // Create the ask-level reward.
      const created = await repo.upsertReward({
        askId: ask.id,
        ticketTypeId: ticketType.id,
        maxGrants: 50,
      });
      expect(created).toMatchObject({
        askId: ask.id,
        roleId: null,
        ticketTypeId: ticketType.id,
        trigger: "ON_CHECK_IN", // default
        maxGrants: 50,
        grantsUsed: 0,
        active: true,
      });

      // Upsert again for the same (askId, null) → UPDATE the same row.
      const updated = await repo.upsertReward({
        askId: ask.id,
        ticketTypeId: ticketType.id,
        trigger: "ON_APPROVAL",
        maxGrants: null,
      });
      expect(updated.id).toBe(created.id);
      expect(updated).toMatchObject({
        roleId: null,
        trigger: "ON_APPROVAL",
        maxGrants: null,
      });

      // A role-level reward coexists with the ask-level one.
      const roleReward = await repo.upsertReward({
        askId: ask.id,
        roleId: role.id,
        ticketTypeId: ticketType.id,
        maxGrants: 5,
      });
      expect(roleReward.id).not.toBe(created.id);
      expect(roleReward.roleId).toBe(role.id);

      // A SECOND ask-level reward (roleId null) is rejected by the raw
      // partial unique index — mapped to the domain conflict. We force the
      // create path by inserting a *different* row via the adapter's create
      // branch: upsert would UPDATE, so assert the DB-level guard directly.
      await expect(
        prisma.volunteerReward.create({
          data: {
            askId: ask.id,
            roleId: null,
            ticketTypeId: ticketType.id,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      // And a second role-level reward on the SAME role → @@unique fires too.
      await expect(
        prisma.volunteerReward.create({
          data: {
            askId: ask.id,
            roleId: role.id,
            ticketTypeId: ticketType.id,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      const fetched = await repo.getReward(created.id);
      expect(fetched).toEqual(updated);
    },
    300_000,
  );

  test(
    "concurrent upsertReward on the same (ask, null) maps the loser to duplicate_reward",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const db = prisma;
      const org = await seedOrg(db);
      const event = await seedEvent(db, org.id);
      const ticketType = await seedTicketType(db, event.id);
      const { ask } = await seedEventAskWithRole(db, event.id, org.id);

      // Two concurrent interactive txs each upsert the ask-level reward.
      // Both findFirst → null → create; the loser's create blocks on the
      // partial unique index and, on the winner's commit, fails P2002 — the
      // adapter must surface it as the domain conflict, never a raw P2002.
      const upsert = () =>
        db.$transaction(async (tx) =>
          makeVolunteeringRepo(tx).upsertReward({
            askId: ask.id,
            ticketTypeId: ticketType.id,
          }),
        );

      const results = await Promise.allSettled([upsert(), upsert()]);

      // Every rejection is the mapped domain conflict — no unmapped P2002.
      for (const r of results) {
        if (r.status === "rejected") {
          expect(r.reason).toMatchObject({ code: "duplicate_reward" });
        }
      }
      // At least one succeeded, and exactly one ask-level row ever landed.
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      const count = await db.volunteerReward.count({
        where: { askId: ask.id, roleId: null },
      });
      expect(count).toBe(1);
    },
    300_000,
  );

  // ── listRewardsByAsk full config ───────────────────────────────────────

  test(
    "listRewardsByAsk returns ask-level + role-level rewards incl. inactive, oldest first",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const org = await seedOrg(prisma);
      const event = await seedEvent(prisma, org.id);
      const ticketType = await seedTicketType(prisma, event.id);
      const { repo, ask, role } = await seedEventAskWithRole(
        prisma,
        event.id,
        org.id,
      );

      // Empty before any config.
      expect(await repo.listRewardsByAsk(ask.id)).toEqual([]);

      // Ask-level reward first, then a role-level one, then deactivate the
      // role reward — listRewardsByAsk must still return BOTH (inactive
      // included) so the config form / complete ledger can show them.
      const askReward = await repo.upsertReward({
        askId: ask.id,
        ticketTypeId: ticketType.id,
        maxGrants: 50,
      });
      const roleReward = await repo.upsertReward({
        askId: ask.id,
        roleId: role.id,
        ticketTypeId: ticketType.id,
        active: false,
      });

      const all = await repo.listRewardsByAsk(ask.id);
      expect(all).toHaveLength(2);
      // Oldest first: ask-level reward was created before the role one.
      expect(all.map((r) => r.id)).toEqual([askReward.id, roleReward.id]);
      expect(all[0]).toMatchObject({ roleId: null, active: true, maxGrants: 50 });
      // The inactive role reward is NOT filtered out.
      expect(all[1]).toMatchObject({ roleId: role.id, active: false });

      // Scoped to the ask — a second ask (on its own event, per the one-ask-
      // per-event unique index) never leaks its rewards in.
      const otherEvent = await seedEvent(prisma, org.id);
      const otherTicketType = await seedTicketType(prisma, otherEvent.id);
      const other = await seedEventAskWithRole(prisma, otherEvent.id, org.id);
      await other.repo.upsertReward({
        askId: other.ask.id,
        ticketTypeId: otherTicketType.id,
      });
      expect(await repo.listRewardsByAsk(ask.id)).toHaveLength(2);
    },
    300_000,
  );

  // ── getRewardForSignup resolution ──────────────────────────────────────

  test(
    "getRewardForSignup: role-specific overrides ask-level; inactive skipped",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const org = await seedOrg(prisma);
      const event = await seedEvent(prisma, org.id);
      const ticketType = await seedTicketType(prisma, event.id);
      const { repo, ask, role } = await seedEventAskWithRole(prisma, event.id, org.id);
      const otherRole = await repo.createEventRole({ askId: ask.id, name: "Bar" });

      const askReward = await repo.upsertReward({
        askId: ask.id,
        ticketTypeId: ticketType.id,
      });

      // No role reward yet → falls back to the ask-level reward.
      expect((await repo.getRewardForSignup(ask.id, role.id))?.id).toBe(
        askReward.id,
      );

      // Add a role-specific reward → it wins for that role only.
      const roleReward = await repo.upsertReward({
        askId: ask.id,
        roleId: role.id,
        ticketTypeId: ticketType.id,
      });
      expect((await repo.getRewardForSignup(ask.id, role.id))?.id).toBe(
        roleReward.id,
      );
      // The other role still resolves to the ask-level reward.
      expect((await repo.getRewardForSignup(ask.id, otherRole.id))?.id).toBe(
        askReward.id,
      );

      // Deactivate the role reward → the role falls back to ask-level.
      await repo.upsertReward({
        askId: ask.id,
        roleId: role.id,
        ticketTypeId: ticketType.id,
        active: false,
      });
      expect((await repo.getRewardForSignup(ask.id, role.id))?.id).toBe(
        askReward.id,
      );

      // Deactivate the ask reward too → nothing resolves.
      await repo.upsertReward({
        askId: ask.id,
        ticketTypeId: ticketType.id,
        active: false,
      });
      expect(await repo.getRewardForSignup(ask.id, role.id)).toBeNull();
    },
    300_000,
  );

  // ── getRewardForUpdate budget serialization ────────────────────────────

  test(
    "getRewardForUpdate serializes concurrent budget increments (no overshoot)",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const db = prisma;
      const org = await seedOrg(db);
      const event = await seedEvent(db, org.id);
      const ticketType = await seedTicketType(db, event.id);
      const { repo, ask } = await seedEventAskWithRole(db, event.id, org.id);
      const reward = await repo.upsertReward({
        askId: ask.id,
        ticketTypeId: ticketType.id,
        maxGrants: 1,
      });

      // Two concurrent interactive txs each: FOR UPDATE-lock the reward,
      // read grantsUsed, and only increment if budget remains. The lock
      // forces them to run one-at-a-time, so with maxGrants = 1 exactly one
      // increment lands and the counter never reaches 2.
      const claim = () =>
        db.$transaction(
          async (tx) => {
            const txRepo = makeVolunteeringRepo(tx);
            const locked = await txRepo.getRewardForUpdate(reward.id);
            if (!locked) return false;
            if (locked.maxGrants != null && locked.grantsUsed >= locked.maxGrants) {
              return false;
            }
            // Small delay while holding the lock (the interactive tx stays
            // open across the await) to widen the race window.
            await new Promise((r) => setTimeout(r, 50));
            await txRepo.incrementGrantsUsed(reward.id);
            return true;
          },
          { timeout: 20_000 },
        );

      const results = await Promise.all([claim(), claim()]);
      const wins = results.filter(Boolean).length;
      expect(wins).toBe(1);

      const after = await repo.getReward(reward.id);
      expect(after?.grantsUsed).toBe(1);
    },
    300_000,
  );

  // ── grants: idempotency + budget counter ───────────────────────────────

  test(
    "createGrant unique → duplicate_grant; increment / floored-decrement",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const org = await seedOrg(prisma);
      const event = await seedEvent(prisma, org.id);
      const ticketType = await seedTicketType(prisma, event.id, 3000);
      const { repo, ask, role } = await seedEventAskWithRole(prisma, event.id, org.id);
      const reward = await repo.upsertReward({
        askId: ask.id,
        ticketTypeId: ticketType.id,
        maxGrants: 10,
      });
      const signup = await seedSignup(repo, { askId: ask.id, roleId: role.id });

      const grant = await repo.createGrant({
        rewardId: reward.id,
        signupId: signup.id,
        contactEmail: signup.contactEmail,
        faceValueCents: 3000,
      });
      expect(grant).toMatchObject({
        rewardId: reward.id,
        signupId: signup.id,
        status: "GRANTED",
        faceValueCents: 3000,
        compOrderId: null,
        ticketId: null,
      });

      // Second grant for the same (reward, signup) → idempotency conflict.
      await expect(
        repo.createGrant({
          rewardId: reward.id,
          signupId: signup.id,
          contactEmail: signup.contactEmail,
          faceValueCents: 3000,
        }),
      ).rejects.toMatchObject({ code: "duplicate_grant" });

      // Lookups.
      expect((await repo.getGrant(grant.id))?.id).toBe(grant.id);
      expect(
        (await repo.getGrantByRewardAndSignup(reward.id, signup.id))?.id,
      ).toBe(grant.id);
      expect((await repo.listGrantsBySignup(signup.id)).map((g) => g.id)).toEqual([
        grant.id,
      ]);

      // Budget counter: increment, then floored decrement.
      await repo.incrementGrantsUsed(reward.id);
      expect((await repo.getReward(reward.id))?.grantsUsed).toBe(1);
      await repo.decrementGrantsUsed(reward.id);
      expect((await repo.getReward(reward.id))?.grantsUsed).toBe(0);
      // Decrement floors at 0 — never negative.
      await repo.decrementGrantsUsed(reward.id);
      expect((await repo.getReward(reward.id))?.grantsUsed).toBe(0);

      // updateGrantStatus: redeem then the ledger reflects it.
      const redeemedAt = new Date("2027-03-01T21:00:00Z");
      const redeemed = await repo.updateGrantStatus(grant.id, {
        status: "REDEEMED",
        redeemedAt,
      });
      expect(redeemed.status).toBe("REDEEMED");
      expect(redeemed.redeemedAt?.toISOString()).toBe(redeemedAt.toISOString());
    },
    300_000,
  );

  // ── ledger: joined ticket status ───────────────────────────────────────

  test(
    "listGrantsByAsk surfaces the live joined Ticket.status",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const db = prisma;
      const org = await seedOrg(db);
      const event = await seedEvent(db, org.id);
      const ticketType = await seedTicketType(db, event.id, 4200);
      const { repo, ask, role } = await seedEventAskWithRole(db, event.id, org.id);
      const reward = await repo.upsertReward({
        askId: ask.id,
        roleId: role.id,
        ticketTypeId: ticketType.id,
      });
      const owner = await seedHuman(db);

      // Grant A: linked to a SCANNED comp ticket (effectively redeemed).
      const signupA = await seedSignup(repo, { askId: ask.id, roleId: role.id });
      const ticket = await db.ticket.create({
        data: {
          eventId: event.id,
          ticketTypeId: ticketType.id,
          ownerHumanId: owner.id,
          code: `comp-${randomUUID()}`,
          status: "SCANNED",
        },
      });
      const grantA = await repo.createGrant({
        rewardId: reward.id,
        signupId: signupA.id,
        humanId: owner.id,
        contactEmail: signupA.contactEmail,
        ticketId: ticket.id,
        faceValueCents: 4200,
      });

      // Grant B: no ticket linked yet.
      const signupB = await seedSignup(repo, { askId: ask.id, roleId: role.id });
      const grantB = await repo.createGrant({
        rewardId: reward.id,
        signupId: signupB.id,
        contactEmail: signupB.contactEmail,
        faceValueCents: 4200,
      });

      const ledger = await repo.listGrantsByAsk(ask.id);
      const byId = new Map(ledger.map((r) => [r.id, r]));
      expect(byId.size).toBe(2);

      const rowA = byId.get(grantA.id)!;
      expect(rowA).toMatchObject({
        rewardRoleId: role.id,
        rewardTicketTypeId: ticketType.id,
        ticketStatus: "SCANNED",
        faceValueCents: 4200,
      });

      const rowB = byId.get(grantB.id)!;
      expect(rowB.ticketStatus).toBeNull();

      // Status filter narrows the ledger.
      await repo.updateGrantStatus(grantB.id, {
        status: "REVOKED",
        revokedAt: new Date(),
        revokeReason: "withdrawn",
      });
      const onlyRevoked = await repo.listGrantsByAsk(ask.id, {
        status: "REVOKED",
      });
      expect(onlyRevoked.map((r) => r.id)).toEqual([grantB.id]);
    },
    300_000,
  );

  // ── coordinator-safe per-signup status batch ───────────────────────────

  test(
    "listRewardGrantStatusesBySignupIds: GRANTED / REDEEMED (scanned) / REVOKED / absent",
    async ({ skip }) => {
      if (runtimeError || !prisma) return skip();
      const db = prisma;
      const org = await seedOrg(db);
      const event = await seedEvent(db, org.id);
      const ticketType = await seedTicketType(db, event.id, 4200);
      const { repo, ask, role } = await seedEventAskWithRole(db, event.id, org.id);
      const reward = await repo.upsertReward({
        askId: ask.id,
        roleId: role.id,
        ticketTypeId: ticketType.id,
      });
      const owner = await seedHuman(db);

      // GRANTED: a plain live grant, no ticket linked.
      const grantedSignup = await seedSignup(repo, { askId: ask.id, roleId: role.id });
      await repo.createGrant({
        rewardId: reward.id,
        signupId: grantedSignup.id,
        contactEmail: grantedSignup.contactEmail,
        faceValueCents: 4200,
      });

      // REDEEMED derived from a SCANNED ticket even though status is still
      // GRANTED and redeemedAt is unstamped.
      const scannedSignup = await seedSignup(repo, { askId: ask.id, roleId: role.id });
      const ticket = await db.ticket.create({
        data: {
          eventId: event.id,
          ticketTypeId: ticketType.id,
          ownerHumanId: owner.id,
          code: `comp-${randomUUID()}`,
          status: "SCANNED",
        },
      });
      await repo.createGrant({
        rewardId: reward.id,
        signupId: scannedSignup.id,
        humanId: owner.id,
        contactEmail: scannedSignup.contactEmail,
        ticketId: ticket.id,
        faceValueCents: 4200,
      });

      // REVOKED grant.
      const revokedSignup = await seedSignup(repo, { askId: ask.id, roleId: role.id });
      const revokedGrant = await repo.createGrant({
        rewardId: reward.id,
        signupId: revokedSignup.id,
        contactEmail: revokedSignup.contactEmail,
        faceValueCents: 4200,
      });
      await repo.updateGrantStatus(revokedGrant.id, {
        status: "REVOKED",
        revokedAt: new Date(),
        revokeReason: "withdrawn",
      });

      // A signup with NO grant at all.
      const noGrantSignup = await seedSignup(repo, { askId: ask.id, roleId: role.id });

      const rows = await repo.listRewardGrantStatusesBySignupIds([
        grantedSignup.id,
        scannedSignup.id,
        revokedSignup.id,
        noGrantSignup.id,
      ]);
      const byId = new Map(rows.map((r) => [r.signupId, r.status]));

      expect(byId.get(grantedSignup.id)).toBe("GRANTED");
      // SCANNED ticket → REDEEMED, derived (not from grant.status).
      expect(byId.get(scannedSignup.id)).toBe("REDEEMED");
      expect(byId.get(revokedSignup.id)).toBe("REVOKED");
      // No grant → absent from the result (no "none" row).
      expect(byId.has(noGrantSignup.id)).toBe(false);
      expect(rows).toHaveLength(3);

      // Coordinator-safe shape: bare { signupId, status } only — no money /
      // PII fields leak (NFR-003).
      for (const r of rows) {
        expect(Object.keys(r).sort()).toEqual(["signupId", "status"]);
      }

      // Empty input short-circuits to an empty result (no query).
      expect(await repo.listRewardGrantStatusesBySignupIds([])).toEqual([]);
    },
    300_000,
  );
});
