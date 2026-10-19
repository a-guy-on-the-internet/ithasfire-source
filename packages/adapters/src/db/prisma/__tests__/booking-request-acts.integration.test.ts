import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeBookingRequestsRepo } from "../booking-requests";

// ---------------------------------------------------------------------------
// Real-Postgres coverage for the bill methods on BookingRequestsRepo
// (lineup-booking-requests v2, FR-001): addActs / listActsForRequests /
// getActForOwner / setActConfirmation — and the v3 additions (FR-001,
// FR-009, L13, L17): soft remove (`removedAt`, filtered by every reader),
// restore, reorder, role, and TAGGED groups.
//
// The load-bearing semantics are SQL-level, which is why this is not a
// fake-Prisma test: the unique on (bookingRequestId, actOwnerType,
// actOwnerId) with NULLs distinct (free-text acts never collide), the
// hand-written CHECKs that pin the row shape by source, the guarded CAS, and
// ON DELETE CASCADE from the request.
//
// THE DDL IS THE SHIPPED MIGRATION, RUN WHOLE (house precedent: the
// booking-request-messages integration suite reads migration bytes rather than
// retyping them). Two prerequisites are set up first: the EventHumanRole enum,
// lifted from the baseline migration, and a "BookingRequest" stub carrying
// only `id` + the sender pair — enough for the migration's FK (and cascade) to
// be real and for SELF rows to read the sender off the request. The stub is
// deliberate: the full BookingRequest DDL spans a dozen migrations and none of
// it is under test here.
//
// The v3 migration (20261001120000_lineup_v3) runs whole too. It also adds
// EventHuman.orgId, so its own prerequisites come first: an "Organization"
// stub (id only, for the FK) and the baseline's own CREATE TABLE "EventHuman".
// EventHuman itself is covered in event-humans-org.integration.test.ts.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../db/prisma/migrations",
);

const BASELINE_SQL = readFileSync(
  resolve(MIGRATIONS_DIR, "20260407000000_consolidated_baseline/migration.sql"),
  "utf8",
);

const ACTS_MIGRATION_SQL = readFileSync(
  resolve(MIGRATIONS_DIR, "20260925120000_booking_request_acts/migration.sql"),
  "utf8",
);

const LINEUP_V3_MIGRATION_SQL = readFileSync(
  resolve(MIGRATIONS_DIR, "20261001120000_lineup_v3/migration.sql"),
  "utf8",
);

function statementFrom(sql: string, startsWith: string): string {
  const start = sql.indexOf(startsWith);
  if (start === -1) {
    throw new Error(
      `Migration DDL not found: ${startsWith}. The schema moved — re-point this test at the migration that owns it. Do NOT retype the DDL here.`,
    );
  }
  const end = sql.indexOf(";", start);
  if (end === -1) {
    throw new Error(`Unterminated statement in migration: ${startsWith}`);
  }
  return sql.slice(start, end + 1);
}

const SETUP_SQL = [
  statementFrom(BASELINE_SQL, `CREATE TYPE "EventHumanRole"`),
  `CREATE TABLE "BookingRequest" ("id" TEXT PRIMARY KEY, "performerOwnerType" TEXT, "performerOwnerId" TEXT);`,
  ACTS_MIGRATION_SQL,
  // v3 prerequisites (it also alters EventHuman) — see the header.
  `CREATE TABLE "Organization" ("id" TEXT PRIMARY KEY);`,
  statementFrom(BASELINE_SQL, `CREATE TABLE "EventHuman"`),
  LINEUP_V3_MIGRATION_SQL,
].join("\n\n");

const REQUEST_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const REQUEST_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const REQUEST_OTHER = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
/** An unclaimed anonymous inquiry — no sender pair. */
const REQUEST_ANON = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
const SENDER_ORG = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const HUMAN_1 = "11111111-1111-4111-8111-111111111111";
const HUMAN_2 = "22222222-2222-4222-8222-222222222222";

describe("bookingRequests bill methods (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(SETUP_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool?.query(`TRUNCATE "BookingRequest" CASCADE`);
    // REQUEST_A is sent by an ORG; B / OTHER by HUMAN_2; ANON by nobody.
    await pool?.query(
      `INSERT INTO "BookingRequest" ("id", "performerOwnerType", "performerOwnerId")
       VALUES ($1, 'organization', $5), ($2, 'human', $6), ($3, 'human', $6), ($4, NULL, NULL)`,
      [REQUEST_A, REQUEST_B, REQUEST_OTHER, REQUEST_ANON, SENDER_ORG, HUMAN_2],
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  const repo = () => makeBookingRequestsRepo(prisma!);

  /** Raw insert that bypasses the adapter, for CHECK assertions. */
  async function rawInsert(cols: Record<string, unknown>) {
    const all = {
      id: crypto.randomUUID(),
      bookingRequestId: REQUEST_A,
      updatedAt: new Date(),
      ...cols,
    };
    const keys = Object.keys(all);
    await pool!.query(
      `INSERT INTO "BookingRequestAct" (${keys.map((k) => `"${k}"`).join(", ")})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(all),
    );
  }

  test("addActs inserts in the given order and stamps confirmation by source", async () => {
    const invitedAt = new Date("2026-09-25T12:00:00.000Z");
    const rows = await repo().addActs(REQUEST_A, [
      {
        source: "TAGGED",
        actOwnerType: "human",
        actOwnerId: HUMAN_1,
        sortOrder: 0,
        invitedAt,
      },
      // No owner fields: the adapter copies the request row's sender pair.
      { source: "SELF", sortOrder: 1, role: "DJ" },
      {
        source: "EXTERNAL",
        externalName: "The Weeds",
        externalUrl: "https://theweeds.example",
        sortOrder: 2,
      },
    ]);

    expect(rows.map((r) => r.source)).toEqual(["TAGGED", "SELF", "EXTERNAL"]);
    const [tagged, self, external] = rows;
    expect(tagged).toMatchObject({
      bookingRequestId: REQUEST_A,
      actOwnerType: "human",
      actOwnerId: HUMAN_1,
      externalName: null,
      confirmation: "PENDING",
      invitedAt,
      role: "PERFORMER",
      respondedAt: null,
      declineReason: null,
    });
    // The sender speaks for their own act; a free-text act has no one to ask.
    expect(self).toMatchObject({
      actOwnerType: "organization",
      actOwnerId: SENDER_ORG,
      confirmation: "CONFIRMED",
      role: "DJ",
      invitedAt: null,
    });
    expect(external).toMatchObject({
      actOwnerType: null,
      actOwnerId: null,
      externalName: "The Weeds",
      externalUrl: "https://theweeds.example",
      confirmation: "CONFIRMED",
    });
  });

  test("SELF takes the sender pair off the request, whoever that is", async () => {
    const [self] = await repo().addActs(REQUEST_B, [
      { source: "SELF", sortOrder: 0 },
    ]);
    expect(self).toMatchObject({ actOwnerType: "human", actOwnerId: HUMAN_2 });
  });

  test("SELF on a missing request / a sender-less inquiry is a typed error", async () => {
    await expect(
      repo().addActs(crypto.randomUUID(), [{ source: "SELF", sortOrder: 0 }]),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "booking_request_not_found",
    });
    await expect(
      repo().addActs(REQUEST_ANON, [{ source: "SELF", sortOrder: 0 }]),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "booking_request_self_act_without_sender",
    });
    // Nothing was written by either attempt.
    const { rows } = await pool!.query(`SELECT 1 FROM "BookingRequestAct"`);
    expect(rows).toHaveLength(0);
  });

  test("addActs([]) is a no-op", async () => {
    await expect(repo().addActs(REQUEST_A, [])).resolves.toEqual([]);
    const { rows } = await pool!.query(`SELECT 1 FROM "BookingRequestAct"`);
    expect(rows).toHaveLength(0);
  });

  test("the same platform act twice on one request is a typed conflict", async () => {
    await repo().addActs(REQUEST_A, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 0 },
    ]);
    await expect(
      repo().addActs(REQUEST_A, [
        { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 1 },
      ]),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_act_duplicate",
    });
    // …but the same human on ANOTHER request is fine.
    await expect(
      repo().addActs(REQUEST_B, [
        { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 0 },
      ]),
    ).resolves.toHaveLength(1);
  });

  test("free-text acts never collide (NULL owner columns are distinct)", async () => {
    const rows = await repo().addActs(REQUEST_A, [
      { source: "EXTERNAL", externalName: "Same Name", sortOrder: 0 },
      { source: "EXTERNAL", externalName: "Same Name", sortOrder: 1 },
    ]);
    expect(rows).toHaveLength(2);
  });

  test("a DECLINED human cannot be re-tagged on the same request", async () => {
    await repo().addActs(REQUEST_A, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 0 },
    ]);
    await repo().setActConfirmation({
      bookingRequestId: REQUEST_A,
      actOwnerType: "human",
      actOwnerId: HUMAN_1,
      expectedFrom: "PENDING",
      to: "DECLINED",
      respondedAt: new Date(),
    });
    await expect(
      repo().addActs(REQUEST_A, [
        { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 0 },
      ]),
    ).rejects.toMatchObject({ message: "booking_request_act_duplicate" });
  });

  test("listActsForRequests: one query, scoped, ordered by request then sortOrder", async () => {
    // Inserted out of sortOrder on purpose.
    await repo().addActs(REQUEST_B, [
      { source: "EXTERNAL", externalName: "B-second", sortOrder: 1 },
      { source: "EXTERNAL", externalName: "B-first", sortOrder: 0 },
    ]);
    await repo().addActs(REQUEST_A, [
      { source: "EXTERNAL", externalName: "A-third", sortOrder: 2 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_2, sortOrder: 0 },
    ]);
    await repo().addActs(REQUEST_OTHER, [
      { source: "EXTERNAL", externalName: "not asked for", sortOrder: 0 },
    ]);

    const rows = await repo().listActsForRequests([REQUEST_B, REQUEST_A]);
    expect(
      rows.map((r) => [r.bookingRequestId, r.externalName ?? r.actOwnerId]),
    ).toEqual([
      [REQUEST_A, HUMAN_2],
      [REQUEST_A, "A-third"],
      [REQUEST_B, "B-first"],
      [REQUEST_B, "B-second"],
    ]);
    await expect(repo().listActsForRequests([])).resolves.toEqual([]);
  });

  test("listActsForRequests breaks sortOrder ties deterministically (createdAt, id)", async () => {
    // Core assigns distinct sortOrders; this pins that a corrupt tie still
    // reads in ONE stable order rather than whatever the planner returns.
    await pool!.query(
      `INSERT INTO "BookingRequestAct"
         ("id", "bookingRequestId", "source", "externalName", "confirmation", "sortOrder", "createdAt", "updatedAt")
       VALUES ('zz', $1, 'EXTERNAL', 'Z', 'CONFIRMED', 0, '2026-01-01', now()),
              ('aa', $1, 'EXTERNAL', 'A', 'CONFIRMED', 0, '2026-01-01', now())`,
      [REQUEST_A],
    );
    const rows = await repo().listActsForRequests([REQUEST_A]);
    expect(rows.map((r) => r.id)).toEqual(["aa", "zz"]);
  });

  const TAGGED_KEY = {
    bookingRequestId: REQUEST_A,
    actOwnerType: "human",
    actOwnerId: HUMAN_1,
  } as const;

  test("getActForOwner finds an act only by its owner key", async () => {
    const [act] = await repo().addActs(REQUEST_A, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 0 },
    ]);
    await expect(repo().getActForOwner(TAGGED_KEY)).resolves.toMatchObject({
      id: act!.id,
      confirmation: "PENDING",
    });
    // Another human, or the right human on another request → nothing.
    await expect(
      repo().getActForOwner({ ...TAGGED_KEY, actOwnerId: HUMAN_2 }),
    ).resolves.toBeNull();
    await expect(
      repo().getActForOwner({ ...TAGGED_KEY, bookingRequestId: REQUEST_B }),
    ).resolves.toBeNull();
  });

  test("setActConfirmation: another human's id cannot answer the act", async () => {
    await repo().addActs(REQUEST_A, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 0 },
    ]);
    await expect(
      repo().setActConfirmation({
        ...TAGGED_KEY,
        actOwnerId: HUMAN_2,
        expectedFrom: "PENDING",
        to: "CONFIRMED",
        respondedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_act_state_changed",
    });
    // The right act on the wrong request: also zero rows.
    await expect(
      repo().setActConfirmation({
        ...TAGGED_KEY,
        bookingRequestId: REQUEST_B,
        expectedFrom: "PENDING",
        to: "DECLINED",
        respondedAt: new Date(),
      }),
    ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    // Untouched.
    await expect(repo().getActForOwner(TAGGED_KEY)).resolves.toMatchObject({
      confirmation: "PENDING",
      respondedAt: null,
    });
  });

  test("setActConfirmation is a CAS: first answer wins, the second conflicts", async () => {
    await repo().addActs(REQUEST_A, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 0 },
    ]);
    const respondedAt = new Date("2026-09-26T10:00:00.000Z");

    const confirmed = await repo().setActConfirmation({
      ...TAGGED_KEY,
      expectedFrom: "PENDING",
      to: "CONFIRMED",
      respondedAt,
      // Ignored for CONFIRMED — a reason only ever rides a decline.
      declineReason: "should not persist",
    });
    expect(confirmed).toMatchObject({
      confirmation: "CONFIRMED",
      respondedAt,
      declineReason: null,
    });

    await expect(
      repo().setActConfirmation({
        ...TAGGED_KEY,
        expectedFrom: "PENDING",
        to: "DECLINED",
        respondedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_act_state_changed",
    });
    // The lost race changed nothing.
    await expect(repo().getActForOwner(TAGGED_KEY)).resolves.toMatchObject({
      confirmation: "CONFIRMED",
      respondedAt,
    });
  });

  test("a decline keeps its reason", async () => {
    await repo().addActs(REQUEST_A, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 0 },
    ]);
    const declined = await repo().setActConfirmation({
      ...TAGGED_KEY,
      expectedFrom: "PENDING",
      to: "DECLINED",
      respondedAt: new Date(),
      declineReason: "booked that night",
    });
    expect(declined).toMatchObject({
      confirmation: "DECLINED",
      declineReason: "booked that night",
    });
  });

  test("setActConfirmation on a missing act is the same conflict", async () => {
    await expect(
      repo().setActConfirmation({
        ...TAGGED_KEY,
        expectedFrom: "PENDING",
        to: "CONFIRMED",
        respondedAt: new Date(),
      }),
    ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
  });

  test("deleting the request cascades its bill", async () => {
    await repo().addActs(REQUEST_A, [
      { source: "EXTERNAL", externalName: "Gone soon", sortOrder: 0 },
    ]);
    await pool!.query(`DELETE FROM "BookingRequest" WHERE "id" = $1`, [REQUEST_A]);
    await expect(repo().listActsForRequests([REQUEST_A])).resolves.toEqual([]);
  });

  test("setActConfirmation: CONFIRMED → DECLINED (consent withdrawn) is a CAS on CONFIRMED", async () => {
    await repo().addActs(REQUEST_A, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 0 },
    ]);
    // Still PENDING: a CONFIRMED-expecting write matches nothing.
    await expect(
      repo().setActConfirmation({
        ...TAGGED_KEY,
        expectedFrom: "CONFIRMED",
        to: "DECLINED",
        respondedAt: new Date(),
      }),
    ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    await repo().setActConfirmation({
      ...TAGGED_KEY,
      expectedFrom: "PENDING",
      to: "CONFIRMED",
      respondedAt: new Date(),
    });
    const withdrawnAt = new Date("2026-09-27T09:00:00.000Z");
    await expect(
      repo().setActConfirmation({
        ...TAGGED_KEY,
        expectedFrom: "CONFIRMED",
        to: "DECLINED",
        respondedAt: withdrawnAt,
        declineReason: "changed plans",
      }),
    ).resolves.toMatchObject({
      confirmation: "DECLINED",
      respondedAt: withdrawnAt,
      declineReason: "changed plans",
    });
  });

  test("setActConfirmation never touches a SELF row (the WHERE is TAGGED-only)", async () => {
    // REQUEST_B's sender is HUMAN_2, so its SELF row is keyed ("human", HUMAN_2)
    // — the same key shape a tagged human's answer uses.
    await repo().addActs(REQUEST_B, [{ source: "SELF", sortOrder: 0 }]);
    await expect(
      repo().setActConfirmation({
        bookingRequestId: REQUEST_B,
        actOwnerType: "human",
        actOwnerId: HUMAN_2,
        expectedFrom: "CONFIRMED",
        to: "DECLINED",
        respondedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_act_state_changed",
    });
    await expect(
      repo().getActForOwner({
        bookingRequestId: REQUEST_B,
        actOwnerType: "human",
        actOwnerId: HUMAN_2,
      }),
    ).resolves.toMatchObject({ source: "SELF", confirmation: "CONFIRMED" });
  });

  test("lockBill holds a transaction-scoped advisory lock on the bill key", async () => {
    const key = `booking_request_bill:${REQUEST_A}`;
    const tryLock = async () => {
      const { rows } = await pool!.query<{ got: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got`,
        [key],
      );
      return rows[0]!.got;
    };

    await prisma!.$transaction(async (tx) => {
      await makeBookingRequestsRepo(tx).lockBill(REQUEST_A);
      // Another connection cannot take the same key while this tx holds it…
      expect(await tryLock()).toBe(false);
      // …but a different request's bill is independent.
      const { rows } = await pool!.query<{ got: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got`,
        [`booking_request_bill:${REQUEST_B}`],
      );
      expect(rows[0]!.got).toBe(true);
    });
    // Released at COMMIT.
    expect(await tryLock()).toBe(true);
  });

  test("promoteActToSelf turns the EXTERNAL row into the sender's SELF row (passes the CHECKs)", async () => {
    const [own, other] = await repo().addActs(REQUEST_A, [
      { source: "EXTERNAL", externalName: "Own Act", externalUrl: "https://own.example", sortOrder: 0 },
      { source: "EXTERNAL", externalName: "Other Act", sortOrder: 1 },
    ]);

    const promoted = await repo().promoteActToSelf({
      bookingRequestId: REQUEST_A,
      actId: own!.id,
    });

    expect(promoted).toMatchObject({
      id: own!.id,
      source: "SELF",
      actOwnerType: "organization",
      actOwnerId: SENDER_ORG,
      externalName: null,
      externalUrl: null,
      confirmation: "CONFIRMED",
      sortOrder: 0,
    });
    const rows = await repo().listActsForRequests([REQUEST_A]);
    expect(rows.map((r) => [r.id, r.source])).toEqual([
      [own!.id, "SELF"],
      [other!.id, "EXTERNAL"],
    ]);
  });

  test("promoteActToSelf: wrong request / not free text / sender-less / duplicate are typed errors", async () => {
    const [tagged, external] = await repo().addActs(REQUEST_A, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 0 },
      { source: "EXTERNAL", externalName: "Free", sortOrder: 1 },
    ]);
    const [anonExternal] = await repo().addActs(REQUEST_ANON, [
      { source: "EXTERNAL", externalName: "Anon Act", sortOrder: 0 },
    ]);

    // Another request's row: scoped away.
    await expect(
      repo().promoteActToSelf({ bookingRequestId: REQUEST_B, actId: external!.id }),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_request_act_state_changed" });
    // Not an EXTERNAL row.
    await expect(
      repo().promoteActToSelf({ bookingRequestId: REQUEST_A, actId: tagged!.id }),
    ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    // No sender pair to copy.
    await expect(
      repo().promoteActToSelf({ bookingRequestId: REQUEST_ANON, actId: anonExternal!.id }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "booking_request_self_act_without_sender",
    });
    // The sender already has a SELF row on this request → the unique key.
    await repo().addActs(REQUEST_A, [{ source: "SELF", sortOrder: 2 }]);
    await expect(
      repo().promoteActToSelf({ bookingRequestId: REQUEST_A, actId: external!.id }),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_request_act_duplicate" });
    // Nothing changed on the refused rows.
    const rows = await repo().listActsForRequests([REQUEST_A]);
    expect(rows.find((r) => r.id === external!.id)).toMatchObject({ source: "EXTERNAL" });
  });

  // ── lineup v3 ──────────────────────────────────────────────────────────────

  describe("v3: TAGGED groups and role labels through the adapter", () => {
    test("addActs tags an organization as PENDING, keyed like a human", async () => {
      const [group] = await repo().addActs(REQUEST_B, [
        {
          source: "TAGGED",
          actOwnerType: "organization",
          actOwnerId: SENDER_ORG,
          sortOrder: 0,
          role: "OTHER",
          customRoleLabel: "Backing band",
        },
      ]);
      expect(group).toMatchObject({
        source: "TAGGED",
        actOwnerType: "organization",
        actOwnerId: SENDER_ORG,
        confirmation: "PENDING",
        role: "OTHER",
        customRoleLabel: "Backing band",
        removedAt: null,
      });
      // The group answers through the same owner-keyed CAS.
      await expect(
        repo().setActConfirmation({
          bookingRequestId: REQUEST_B,
          actOwnerType: "organization",
          actOwnerId: SENDER_ORG,
          expectedFrom: "PENDING",
          to: "CONFIRMED",
          respondedAt: new Date(),
        }),
      ).resolves.toMatchObject({ confirmation: "CONFIRMED" });
      // …and is unique per request like any platform act.
      await expect(
        repo().addActs(REQUEST_B, [
          {
            source: "TAGGED",
            actOwnerType: "organization",
            actOwnerId: SENDER_ORG,
            sortOrder: 1,
          },
        ]),
      ).rejects.toMatchObject({ message: "booking_request_act_duplicate" });
    });
  });

  describe("v3: removedAt (soft remove) is filtered by every reader", () => {
    async function seedBill() {
      return repo().addActs(REQUEST_A, [
        { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 0 },
        { source: "SELF", sortOrder: 1 },
        { source: "EXTERNAL", externalName: "Junco", sortOrder: 2 },
      ]);
    }

    test("softRemoveAct stamps removedAt; list / getActForOwner stop returning it", async () => {
      const [tagged, self, external] = await seedBill();
      const at = new Date("2026-10-01T09:00:00.000Z");

      const removed = await repo().softRemoveAct({
        bookingRequestId: REQUEST_A,
        actId: tagged!.id,
        at,
      });
      expect(removed).toMatchObject({ id: tagged!.id, removedAt: at, confirmation: "PENDING" });

      // Live bill: the removed row is gone for every default reader.
      const live = await repo().listActsForRequests([REQUEST_A]);
      expect(live.map((r) => r.id)).toEqual([self!.id, external!.id]);
      await expect(repo().getActForOwner(TAGGED_KEY)).resolves.toBeNull();

      // …and back only when asked for.
      const all = await repo().listActsForRequests([REQUEST_A], { includeRemoved: true });
      expect(all.map((r) => r.id)).toEqual([tagged!.id, self!.id, external!.id]);
      await expect(
        repo().getActForOwner(TAGGED_KEY, { includeRemoved: true }),
      ).resolves.toMatchObject({ id: tagged!.id, removedAt: at });
    });

    test("a removed row still holds its key: the same identity cannot be INSERTED again", async () => {
      const [tagged] = await seedBill();
      await repo().softRemoveAct({ bookingRequestId: REQUEST_A, actId: tagged!.id, at: new Date() });
      await expect(
        repo().addActs(REQUEST_A, [
          { source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1, sortOrder: 3 },
        ]),
      ).rejects.toMatchObject({ code: "conflict", message: "booking_request_act_duplicate" });
    });

    test("a removed act can neither answer nor be promoted", async () => {
      const [tagged] = await seedBill();
      const [anonExternal] = await repo().addActs(REQUEST_B, [
        { source: "EXTERNAL", externalName: "Own act", sortOrder: 0 },
      ]);
      await repo().softRemoveAct({ bookingRequestId: REQUEST_A, actId: tagged!.id, at: new Date() });
      await repo().softRemoveAct({ bookingRequestId: REQUEST_B, actId: anonExternal!.id, at: new Date() });

      await expect(
        repo().setActConfirmation({
          ...TAGGED_KEY,
          expectedFrom: "PENDING",
          to: "CONFIRMED",
          respondedAt: new Date(),
        }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
      await expect(
        repo().promoteActToSelf({ bookingRequestId: REQUEST_B, actId: anonExternal!.id }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    });

    test("softRemoveAct: foreign request, unknown id, already removed → typed conflict", async () => {
      const [tagged] = await seedBill();
      for (const input of [
        { bookingRequestId: REQUEST_B, actId: tagged!.id },
        { bookingRequestId: REQUEST_A, actId: crypto.randomUUID() },
      ]) {
        await expect(
          repo().softRemoveAct({ ...input, at: new Date() }),
        ).rejects.toMatchObject({ code: "conflict", message: "booking_request_act_state_changed" });
      }
      await repo().softRemoveAct({ bookingRequestId: REQUEST_A, actId: tagged!.id, at: new Date() });
      await expect(
        repo().softRemoveAct({ bookingRequestId: REQUEST_A, actId: tagged!.id, at: new Date() }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    });

    test("restoreAct: SELF comes back CONFIRMED; a TAGGED act is asked again (PENDING)", async () => {
      const [tagged, self] = await seedBill();
      await repo().setActConfirmation({
        ...TAGGED_KEY,
        expectedFrom: "PENDING",
        to: "CONFIRMED",
        respondedAt: new Date(),
      });
      await repo().softRemoveAct({ bookingRequestId: REQUEST_A, actId: self!.id, at: new Date() });
      await repo().softRemoveAct({ bookingRequestId: REQUEST_A, actId: tagged!.id, at: new Date() });

      await expect(
        repo().restoreAct({ bookingRequestId: REQUEST_A, actId: self!.id, sortOrder: 0 }),
      ).resolves.toMatchObject({
        source: "SELF",
        removedAt: null,
        sortOrder: 0,
        confirmation: "CONFIRMED",
      });
      const invitedAt = new Date("2026-10-02T12:00:00.000Z");
      await expect(
        repo().restoreAct({ bookingRequestId: REQUEST_A, actId: tagged!.id, sortOrder: 5, invitedAt }),
      ).resolves.toMatchObject({
        removedAt: null,
        sortOrder: 5,
        confirmation: "PENDING",
        respondedAt: null,
        invitedAt,
      });
      // Restoring a LIVE row is refused.
      await expect(
        repo().restoreAct({ bookingRequestId: REQUEST_A, actId: self!.id, sortOrder: 0 }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    });

    test("restoreAct never brings back a pass (L14), nor another request's row", async () => {
      const [tagged] = await seedBill();
      await repo().setActConfirmation({
        ...TAGGED_KEY,
        expectedFrom: "PENDING",
        to: "DECLINED",
        respondedAt: new Date(),
      });
      await repo().softRemoveAct({ bookingRequestId: REQUEST_A, actId: tagged!.id, at: new Date() });
      await expect(
        repo().restoreAct({ bookingRequestId: REQUEST_A, actId: tagged!.id, sortOrder: 0 }),
      ).rejects.toMatchObject({ code: "conflict", message: "booking_request_act_state_changed" });
      await expect(
        repo().restoreAct({ bookingRequestId: REQUEST_B, actId: tagged!.id, sortOrder: 0 }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
      // Still removed, still DECLINED.
      await expect(
        repo().getActForOwner(TAGGED_KEY, { includeRemoved: true }),
      ).resolves.toMatchObject({ confirmation: "DECLINED", removedAt: expect.any(Date) });
    });

    test("setActSortOrders rewrites the live order and ignores removed rows", async () => {
      const [tagged, self, external] = await seedBill();
      await repo().softRemoveAct({ bookingRequestId: REQUEST_A, actId: self!.id, at: new Date() });

      const reordered = await repo().setActSortOrders({
        bookingRequestId: REQUEST_A,
        orderedActIds: [external!.id, tagged!.id],
      });
      expect(reordered.map((r) => [r.id, r.sortOrder])).toEqual([
        [external!.id, 0],
        [tagged!.id, 1],
      ]);
      await expect(
        repo().listActsForRequests([REQUEST_A]).then((rows) => rows.map((r) => r.id)),
      ).resolves.toEqual([external!.id, tagged!.id]);
    });

    test("setActSortOrders refuses a stale plan before writing anything", async () => {
      const [tagged, self, external] = await seedBill();
      await repo().softRemoveAct({ bookingRequestId: REQUEST_A, actId: self!.id, at: new Date() });
      const [otherRequestAct] = await repo().addActs(REQUEST_B, [
        { source: "EXTERNAL", externalName: "Elsewhere", sortOrder: 0 },
      ]);
      const stale = [
        [external!.id], // missing a live act
        [external!.id, tagged!.id, self!.id], // names a removed act
        [external!.id, external!.id], // duplicate
        [external!.id, otherRequestAct!.id], // foreign act
      ];
      for (const orderedActIds of stale) {
        await expect(
          repo().setActSortOrders({ bookingRequestId: REQUEST_A, orderedActIds }),
        ).rejects.toMatchObject({ code: "conflict", message: "booking_request_bill_changed" });
      }
      const rows = await repo().listActsForRequests([REQUEST_A]);
      expect(rows.map((r) => [r.id, r.sortOrder])).toEqual([
        [tagged!.id, 0],
        [external!.id, 2],
      ]);
    });

    test("setActRole changes a live act's role; the label CHECK still guards it", async () => {
      const [tagged, , external] = await seedBill();
      await expect(
        repo().setActRole({
          bookingRequestId: REQUEST_A,
          actId: external!.id,
          role: "OTHER",
          customRoleLabel: "MC",
        }),
      ).resolves.toMatchObject({ role: "OTHER", customRoleLabel: "MC" });
      await expect(
        repo().setActRole({
          bookingRequestId: REQUEST_A,
          actId: external!.id,
          role: "DJ",
          customRoleLabel: "MC",
        }),
      ).rejects.toThrow(/BookingRequestAct_custom_role_label_check/);
      // A removed act, or another request's, matches nothing.
      await repo().softRemoveAct({ bookingRequestId: REQUEST_A, actId: tagged!.id, at: new Date() });
      await expect(
        repo().setActRole({
          bookingRequestId: REQUEST_A,
          actId: tagged!.id,
          role: "DJ",
          customRoleLabel: null,
        }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
      await expect(
        repo().setActRole({
          bookingRequestId: REQUEST_B,
          actId: external!.id,
          role: "DJ",
          customRoleLabel: null,
        }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    });
  });

  describe("SQL CHECKs (raw inserts that bypass the adapter)", () => {
    const shape = /BookingRequestAct_source_shape_check/;
    const pending = /BookingRequestAct_pending_only_tagged_check/;

    test("TAGGED may be a human OR an organization (v3 L17 relaxed the CHECK)", async () => {
      await expect(
        rawInsert({
          source: "TAGGED",
          actOwnerType: "organization",
          actOwnerId: SENDER_ORG,
        }),
      ).resolves.toBeUndefined();
      await expect(
        rawInsert({ source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1 }),
      ).resolves.toBeUndefined();
    });

    test("a custom role label only rides role OTHER", async () => {
      const label = /BookingRequestAct_custom_role_label_check/;
      await expect(
        rawInsert({
          source: "EXTERNAL",
          externalName: "Named",
          confirmation: "CONFIRMED",
          role: "PERFORMER",
          customRoleLabel: "Hype man",
        }),
      ).rejects.toThrow(label);
      await expect(
        rawInsert({
          source: "EXTERNAL",
          externalName: "Named",
          confirmation: "CONFIRMED",
          role: "OTHER",
          customRoleLabel: "Hype man",
        }),
      ).resolves.toBeUndefined();
    });

    test("SELF/TAGGED need the owner pair and no externalName", async () => {
      await expect(
        rawInsert({ source: "TAGGED", actOwnerType: "human", actOwnerId: null }),
      ).rejects.toThrow(shape);
      await expect(
        rawInsert({
          source: "SELF",
          actOwnerType: "human",
          actOwnerId: HUMAN_1,
          externalName: "Also a name",
          confirmation: "CONFIRMED",
        }),
      ).rejects.toThrow(shape);
    });

    test("owner type is closed to human | organization", async () => {
      await expect(
        rawInsert({
          source: "SELF",
          actOwnerType: "org",
          actOwnerId: SENDER_ORG,
          confirmation: "CONFIRMED",
        }),
      ).rejects.toThrow(shape);
      // Relaxing TAGGED did not open the vocabulary.
      await expect(
        rawInsert({ source: "TAGGED", actOwnerType: "org", actOwnerId: SENDER_ORG }),
      ).rejects.toThrow(shape);
    });

    test("EXTERNAL needs a name and no owner pair", async () => {
      await expect(
        rawInsert({ source: "EXTERNAL", confirmation: "CONFIRMED" }),
      ).rejects.toThrow(shape);
      await expect(
        rawInsert({
          source: "EXTERNAL",
          externalName: "Named",
          actOwnerType: "human",
          actOwnerId: HUMAN_1,
          confirmation: "CONFIRMED",
        }),
      ).rejects.toThrow(shape);
    });

    test("SELF and EXTERNAL rows are never PENDING (the column default)", async () => {
      await expect(
        rawInsert({ source: "EXTERNAL", externalName: "Named" }),
      ).rejects.toThrow(pending);
      await expect(
        rawInsert({ source: "SELF", actOwnerType: "human", actOwnerId: HUMAN_1 }),
      ).rejects.toThrow(pending);
      // A TAGGED row may be.
      await expect(
        rawInsert({ source: "TAGGED", actOwnerType: "human", actOwnerId: HUMAN_1 }),
      ).resolves.toBeUndefined();
    });
  });
});
