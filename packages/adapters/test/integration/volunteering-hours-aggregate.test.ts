/**
 * Integration coverage for `aggregateHoursByVolunteer` in the volunteering
 * Prisma repo, against real Postgres.
 *
 * The method is a single parameterized raw-SQL aggregate that unit tests
 * with a stubbed repo cannot verify:
 *
 *  - the per-row hours COALESCE (`hoursWorked` override wins, else the
 *    shift's scheduled duration ROUNDed to 2dp *before* SUM — so the org
 *    total reconciles against per-event export rows),
 *  - shiftless signups without an override contributing NULL to the SUM
 *    (skipped) while still counting in `signupsCount` / `eventsCount`,
 *  - the grouping key (`humanId` when linked, else the lowercased
 *    `contactEmail` so differently-cased shadow emails fold together),
 *  - the `from`/`to` range filters on the activity instant
 *    (`COALESCE(shift.startsAt, signup.createdAt)`; from inclusive,
 *    to exclusive),
 *  - the `acceptedOnly` status filter, which compares the Postgres enum
 *    column on its text projection (`vs."status"::text IN (...)` via
 *    Prisma.sql composition) — an operator-level detail that only a real
 *    database can prove.
 *
 * Harness: same pattern as volunteering-occupancy — an ephemeral database
 * per suite (Testcontainers, or a throwaway database created on a host
 * Postgres when TESTCONTAINERS_REUSE_DATABASE_URL is set), migrated via
 * `prisma migrate deploy` and dropped in afterAll. Every test seeds its
 * own org → events → roles/shifts → signups chain with unique ids, so
 * reruns are safe and seeded dev data is never touched. When no database
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

type SignupStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "CHECKED_IN"
  | "NO_SHOW";

const uniqueEmail = (label: string) =>
  `vol-hours-${label}-${randomUUID()}@example.test`;

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Prisma volunteering repo integration – aggregateHoursByVolunteer", () => {
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
      console.error("[volunteering-hours-aggregate.test] setup failed:", err);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    // Drops the ephemeral database (or stops the container) — all fixture
    // rows go with it, so nothing leaks between runs.
    if (pgContainer) await pgContainer.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  // ── Fixture helpers ──────────────────────────────────────────────────────
  // Each test seeds its own Organization → Event ×2 chain; the aggregate is
  // org-scoped, so a fresh org per test fully isolates fixtures.

  async function seedOrgWithTwoEvents(db: PrismaClient) {
    const tag = randomUUID().slice(0, 8);
    const org = await db.organization.create({
      data: {
        name: `Vol Hours Org ${tag}`,
        slug: `vol-hours-org-${tag}`,
        status: "ACTIVE",
      },
    });
    const [event1, event2] = await Promise.all([
      db.event.create({
        data: {
          orgId: org.id,
          title: `Vol Hours Event 1 ${tag}`,
          startsAt: new Date("2027-03-01T18:00:00Z"),
          endsAt: new Date("2027-03-01T23:00:00Z"),
          status: "PUBLISHED",
          volunteeringEnabled: true,
        },
      }),
      db.event.create({
        data: {
          orgId: org.id,
          title: `Vol Hours Event 2 ${tag}`,
          startsAt: new Date("2027-03-05T18:00:00Z"),
          endsAt: new Date("2027-03-05T23:00:00Z"),
          status: "PUBLISHED",
          volunteeringEnabled: true,
        },
      }),
    ]);
    return { orgId: org.id, event1Id: event1.id, event2Id: event2.id };
  }

  /** Role + optional shift. Role names are tagged — `@@unique([eventId, name])`. */
  async function createRoleWithShift(
    db: PrismaClient,
    eventId: string,
    shift?: { startsAt: Date; endsAt: Date },
  ) {
    const role = await db.eventVolunteerRole.create({
      data: { eventId, name: `Role ${randomUUID().slice(0, 8)}` },
    });
    if (!shift) return { roleId: role.id, shiftId: null as string | null };
    const created = await db.eventVolunteerShift.create({
      data: { roleId: role.id, startsAt: shift.startsAt, endsAt: shift.endsAt },
    });
    return { roleId: role.id, shiftId: created.id as string | null };
  }

  async function createSignup(
    db: PrismaClient,
    args: {
      eventId: string;
      roleId: string;
      shiftId?: string | null;
      humanId?: string | null;
      contactEmail: string;
      contactName?: string | null;
      status: SignupStatus;
      /** Passed as a string so the Decimal(5,2) column gets an exact value. */
      hoursWorked?: string | null;
    },
  ) {
    return db.volunteerSignup.create({
      data: {
        eventId: args.eventId,
        roleId: args.roleId,
        shiftId: args.shiftId ?? null,
        humanId: args.humanId ?? null,
        contactEmail: args.contactEmail,
        contactName: args.contactName ?? null,
        status: args.status,
        hoursWorked: args.hoursWorked ?? null,
      },
    });
  }

  const byKey = (rows: Array<{ volunteerKey: string }>) =>
    new Map(rows.map((r) => [r.volunteerKey, r] as const));

  test(
    "default (all statuses) reconciles override-or-scheduled hours per volunteer",
    async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }
      const fx = await seedOrgWithTwoEvents(prisma);

      // V1 — account-linked. APPROVED on a 4h shift (scheduled wins, no
      // override) + CHECKED_IN with a 2.5h override on a 3h shift (override
      // must beat the schedule).
      const human = await prisma.human.create({ data: { name: "Vol One" } });
      const v1Email = uniqueEmail("v1");
      const r1 = await createRoleWithShift(prisma, fx.event1Id, {
        startsAt: new Date("2027-03-01T10:00:00Z"),
        endsAt: new Date("2027-03-01T14:00:00Z"), // 4h
      });
      await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: r1.roleId,
        shiftId: r1.shiftId,
        humanId: human.id,
        contactEmail: v1Email,
        contactName: "Vol One",
        status: "APPROVED",
      });
      const r2 = await createRoleWithShift(prisma, fx.event2Id, {
        startsAt: new Date("2027-03-04T18:00:00Z"),
        endsAt: new Date("2027-03-04T21:00:00Z"), // 3h scheduled — override wins
      });
      await createSignup(prisma, {
        eventId: fx.event2Id,
        roleId: r2.roleId,
        shiftId: r2.shiftId,
        humanId: human.id,
        contactEmail: v1Email,
        contactName: "Vol One",
        status: "CHECKED_IN",
        hoursWorked: "2.50",
      });

      // V2 — shadow (no humanId). PENDING 3h + WITHDRAWN 4h both count in
      // the default all-statuses view; the APPROVED shiftless/no-override
      // signup contributes NULL hours but still bumps the counts.
      const v2Email = uniqueEmail("v2");
      const r3 = await createRoleWithShift(prisma, fx.event1Id, {
        startsAt: new Date("2027-03-02T10:00:00Z"),
        endsAt: new Date("2027-03-02T13:00:00Z"), // 3h
      });
      await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: r3.roleId,
        shiftId: r3.shiftId,
        contactEmail: v2Email,
        status: "PENDING",
      });
      const r4 = await createRoleWithShift(prisma, fx.event2Id, {
        startsAt: new Date("2027-03-05T09:00:00Z"),
        endsAt: new Date("2027-03-05T13:00:00Z"), // 4h
      });
      await createSignup(prisma, {
        eventId: fx.event2Id,
        roleId: r4.roleId,
        shiftId: r4.shiftId,
        contactEmail: v2Email,
        status: "WITHDRAWN",
      });
      const r5 = await createRoleWithShift(prisma, fx.event2Id); // shiftless
      await createSignup(prisma, {
        eventId: fx.event2Id,
        roleId: r5.roleId,
        contactEmail: v2Email,
        status: "APPROVED",
      });

      // V3 — proves rounding happens per row, *before* SUM. Two 50-minute
      // shifts: 50/60 = 0.8333… → 0.83 each → 1.66 total. Rounding after
      // SUM would give 1.67 instead.
      const v3Email = uniqueEmail("v3");
      const r6 = await createRoleWithShift(prisma, fx.event1Id, {
        startsAt: new Date("2027-03-01T10:00:00Z"),
        endsAt: new Date("2027-03-01T10:50:00Z"),
      });
      const r7 = await createRoleWithShift(prisma, fx.event1Id, {
        startsAt: new Date("2027-03-02T12:00:00Z"),
        endsAt: new Date("2027-03-02T12:50:00Z"),
      });
      await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: r6.roleId,
        shiftId: r6.shiftId,
        contactEmail: v3Email,
        status: "APPROVED",
      });
      await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: r7.roleId,
        shiftId: r7.shiftId,
        contactEmail: v3Email,
        status: "APPROVED",
      });

      const rows = await makeVolunteeringRepo(
        prisma,
      ).aggregateHoursByVolunteer(fx.orgId);

      expect(rows).toHaveLength(3);
      const map = byKey(rows);

      const v1 = map.get(human.id);
      expect(v1).toBeDefined();
      expect(v1).toMatchObject({
        humanId: human.id,
        contactName: "Vol One",
        totalHours: 6.5, // 4.00 scheduled + 2.50 override
        eventsCount: 2,
        signupsCount: 2,
      });
      expect(v1!.lastShiftAt.getTime()).toBe(
        new Date("2027-03-04T18:00:00Z").getTime(),
      );

      const v2 = map.get(`email:${v2Email.toLowerCase()}`);
      expect(v2).toBeDefined();
      expect(v2).toMatchObject({
        humanId: null,
        totalHours: 7, // 3.00 PENDING + 4.00 WITHDRAWN; shiftless adds 0
        eventsCount: 2,
        signupsCount: 3, // shiftless/no-override still counts here
      });
      // lastShiftAt = max activity instant; the shiftless signup's createdAt
      // (today) loses to the 2027 shift start.
      expect(v2!.lastShiftAt.getTime()).toBe(
        new Date("2027-03-05T09:00:00Z").getTime(),
      );

      const v3 = map.get(`email:${v3Email.toLowerCase()}`);
      expect(v3).toBeDefined();
      // Per-row 2dp: 0.83 + 0.83 = 1.66 (NOT round(1.6667) = 1.67).
      expect(v3!.totalHours).toBe(1.66);
      expect(v3!.signupsCount).toBe(2);
      expect(v3!.eventsCount).toBe(1);

      // ORDER BY totalHours DESC.
      expect(rows.map((r) => r.totalHours)).toEqual([7, 6.5, 1.66]);
    },
    300_000,
  );

  test(
    "acceptedOnly keeps APPROVED + CHECKED_IN hours and drops all-excluded volunteers",
    async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }
      const fx = await seedOrgWithTwoEvents(prisma);

      // Mixed-status volunteer: APPROVED 4h + CHECKED_IN override 2.5h stay;
      // PENDING 3h must vanish from the accepted view.
      const mixedEmail = uniqueEmail("mixed");
      const ra = await createRoleWithShift(prisma, fx.event1Id, {
        startsAt: new Date("2027-04-01T10:00:00Z"),
        endsAt: new Date("2027-04-01T14:00:00Z"), // 4h
      });
      await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: ra.roleId,
        shiftId: ra.shiftId,
        contactEmail: mixedEmail,
        status: "APPROVED",
      });
      const rb = await createRoleWithShift(prisma, fx.event2Id, {
        startsAt: new Date("2027-04-02T10:00:00Z"),
        endsAt: new Date("2027-04-02T13:00:00Z"),
      });
      await createSignup(prisma, {
        eventId: fx.event2Id,
        roleId: rb.roleId,
        shiftId: rb.shiftId,
        contactEmail: mixedEmail,
        status: "CHECKED_IN",
        hoursWorked: "2.50",
      });
      const rc = await createRoleWithShift(prisma, fx.event1Id, {
        startsAt: new Date("2027-04-03T10:00:00Z"),
        endsAt: new Date("2027-04-03T13:00:00Z"), // 3h — PENDING, excluded
      });
      await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: rc.roleId,
        shiftId: rc.shiftId,
        contactEmail: mixedEmail,
        status: "PENDING",
      });

      // Never-accepted volunteer: PENDING + WITHDRAWN only — must lose the
      // whole row, not just hours.
      const neverEmail = uniqueEmail("never");
      const rd = await createRoleWithShift(prisma, fx.event1Id, {
        startsAt: new Date("2027-04-04T10:00:00Z"),
        endsAt: new Date("2027-04-04T12:00:00Z"),
      });
      await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: rd.roleId,
        shiftId: rd.shiftId,
        contactEmail: neverEmail,
        status: "PENDING",
      });
      const re = await createRoleWithShift(prisma, fx.event2Id, {
        startsAt: new Date("2027-04-05T10:00:00Z"),
        endsAt: new Date("2027-04-05T15:00:00Z"),
      });
      await createSignup(prisma, {
        eventId: fx.event2Id,
        roleId: re.roleId,
        shiftId: re.shiftId,
        contactEmail: neverEmail,
        status: "WITHDRAWN",
      });

      const repo = makeVolunteeringRepo(prisma);

      // Sanity: the default view sees both volunteers and all hours.
      const allRows = await repo.aggregateHoursByVolunteer(fx.orgId);
      expect(byKey(allRows).get(`email:${mixedEmail.toLowerCase()}`))
        .toMatchObject({ totalHours: 9.5, signupsCount: 3 });
      expect(byKey(allRows).get(`email:${neverEmail.toLowerCase()}`))
        .toMatchObject({ totalHours: 7, signupsCount: 2 });

      const accepted = await repo.aggregateHoursByVolunteer(
        fx.orgId,
        undefined,
        { acceptedOnly: true },
      );

      // Never-accepted volunteer has no row at all.
      expect(accepted).toHaveLength(1);
      const mixed = byKey(accepted).get(`email:${mixedEmail.toLowerCase()}`);
      expect(mixed).toBeDefined();
      expect(mixed).toMatchObject({
        totalHours: 6.5, // 4.00 APPROVED + 2.50 CHECKED_IN; PENDING 3h gone
        eventsCount: 2,
        signupsCount: 2,
      });
      // PENDING shift (Apr 3) excluded — last accepted activity is Apr 2.
      expect(mixed!.lastShiftAt.getTime()).toBe(
        new Date("2027-04-02T10:00:00Z").getTime(),
      );
    },
    300_000,
  );

  test(
    "groups by humanId when linked, else by lowercased contactEmail",
    async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }
      const fx = await seedOrgWithTwoEvents(prisma);

      // Linked volunteer: same humanId across both events, *different*
      // contact emails — humanId must still fold them into one row.
      const human = await prisma.human.create({ data: { name: "Linked Vol" } });
      const r1 = await createRoleWithShift(prisma, fx.event1Id, {
        startsAt: new Date("2027-05-01T10:00:00Z"),
        endsAt: new Date("2027-05-01T12:00:00Z"), // 2h
      });
      await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: r1.roleId,
        shiftId: r1.shiftId,
        humanId: human.id,
        contactEmail: uniqueEmail("linked-a"),
        status: "APPROVED",
      });
      const r2 = await createRoleWithShift(prisma, fx.event2Id, {
        startsAt: new Date("2027-05-02T10:00:00Z"),
        endsAt: new Date("2027-05-02T13:00:00Z"), // 3h
      });
      await createSignup(prisma, {
        eventId: fx.event2Id,
        roleId: r2.roleId,
        shiftId: r2.shiftId,
        humanId: human.id,
        contactEmail: uniqueEmail("linked-b"),
        status: "APPROVED",
      });

      // Shadow volunteer: same email, different casing across events —
      // LOWER() must fold them into one row.
      const tag = randomUUID().slice(0, 8);
      const upperEmail = `Shadow-Vol-${tag}@Example.Test`;
      const lowerEmail = upperEmail.toLowerCase();
      const r3 = await createRoleWithShift(prisma, fx.event1Id, {
        startsAt: new Date("2027-05-03T10:00:00Z"),
        endsAt: new Date("2027-05-03T11:00:00Z"), // 1h
      });
      await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: r3.roleId,
        shiftId: r3.shiftId,
        contactEmail: upperEmail,
        status: "APPROVED",
      });
      const r4 = await createRoleWithShift(prisma, fx.event2Id, {
        startsAt: new Date("2027-05-04T10:00:00Z"),
        endsAt: new Date("2027-05-04T12:00:00Z"), // 2h
      });
      await createSignup(prisma, {
        eventId: fx.event2Id,
        roleId: r4.roleId,
        shiftId: r4.shiftId,
        contactEmail: lowerEmail,
        status: "APPROVED",
      });

      const rows = await makeVolunteeringRepo(
        prisma,
      ).aggregateHoursByVolunteer(fx.orgId);

      expect(rows).toHaveLength(2);
      const map = byKey(rows);

      const linked = map.get(human.id);
      expect(linked).toBeDefined();
      expect(linked).toMatchObject({
        volunteerKey: human.id,
        humanId: human.id,
        totalHours: 5,
        eventsCount: 2,
        signupsCount: 2,
      });

      const shadow = map.get(`email:${lowerEmail}`);
      expect(shadow).toBeDefined();
      expect(shadow).toMatchObject({
        humanId: null,
        totalHours: 3,
        eventsCount: 2,
        signupsCount: 2,
      });
      // contactEmail surfaces one of the stored variants (MAX) — same
      // address modulo case either way.
      expect(shadow!.contactEmail.toLowerCase()).toBe(lowerEmail);
    },
    300_000,
  );

  test(
    "range filters on shift start (createdAt fallback when shiftless); from inclusive, to exclusive",
    async ({ skip }) => {
      if (runtimeError || !prisma) {
        skip();
        return;
      }
      const fx = await seedOrgWithTwoEvents(prisma);
      const email = uniqueEmail("range");

      const from = new Date("2027-06-10T10:00:00Z");
      const to = new Date("2027-07-01T00:00:00Z");

      // S1 — shift starts exactly at `from` (inclusive bound), 2h.
      const r1 = await createRoleWithShift(prisma, fx.event1Id, {
        startsAt: from,
        endsAt: new Date("2027-06-10T12:00:00Z"),
      });
      await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: r1.roleId,
        shiftId: r1.shiftId,
        contactEmail: email,
        status: "APPROVED",
      });

      // S2 — shift starts exactly at `to` (exclusive bound), 3h. Must be
      // filtered out of the [from, to) window.
      const r2 = await createRoleWithShift(prisma, fx.event1Id, {
        startsAt: to,
        endsAt: new Date("2027-07-01T03:00:00Z"),
      });
      await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: r2.roleId,
        shiftId: r2.shiftId,
        contactEmail: email,
        status: "APPROVED",
      });

      // S3 — shiftless: its activity instant is createdAt (≈ now), far
      // outside the 2027 window.
      const r3 = await createRoleWithShift(prisma, fx.event1Id);
      const s3 = await createSignup(prisma, {
        eventId: fx.event1Id,
        roleId: r3.roleId,
        contactEmail: email,
        status: "APPROVED",
      });

      const repo = makeVolunteeringRepo(prisma);

      // [from, to): only S1. `from` proven inclusive, `to` proven exclusive,
      // and S3's createdAt fallback keeps it out of the 2027 window.
      const windowed = await repo.aggregateHoursByVolunteer(fx.orgId, {
        from,
        to,
      });
      expect(windowed).toHaveLength(1);
      expect(windowed[0]).toMatchObject({
        totalHours: 2,
        eventsCount: 1,
        signupsCount: 1,
      });
      expect(windowed[0]!.lastShiftAt.getTime()).toBe(from.getTime());

      // from-only (open upper bound): S1 + S2 — exercises the Prisma.empty
      // composition branch for `to`.
      const fromOnly = await repo.aggregateHoursByVolunteer(fx.orgId, {
        from,
      });
      expect(fromOnly).toHaveLength(1);
      expect(fromOnly[0]).toMatchObject({ totalHours: 5, signupsCount: 2 });

      // A window around "now" catches only the shiftless signup via its
      // createdAt fallback — and its NULL hours surface as totalHours 0
      // through the outer COALESCE(SUM(...), 0).
      const nowWindow = await repo.aggregateHoursByVolunteer(fx.orgId, {
        from: new Date(Date.now() - 60 * 60 * 1000),
        to: new Date(Date.now() + 60 * 60 * 1000),
      });
      expect(nowWindow).toHaveLength(1);
      expect(nowWindow[0]).toMatchObject({
        totalHours: 0,
        eventsCount: 1,
        signupsCount: 1,
      });
      expect(nowWindow[0]!.lastShiftAt.getTime()).toBe(
        s3.createdAt.getTime(),
      );
    },
    300_000,
  );
});
