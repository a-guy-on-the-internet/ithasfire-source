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

import { makeEventHumansRepo } from "../event-humans";

// ---------------------------------------------------------------------------
// Real-Postgres coverage for EventHuman.orgId (lineup-booking-requests v3,
// FR-015 / L18): a lineup row can be a GROUP.
//
// What is SQL-level and therefore tested here, not against a fake:
//   · "EventHuman_identity_check" — at most one of humanId / orgId. NOT
//     "exactly one of the three": a linked row keeps externalName as its
//     stage name (`linkHuman`), and that shape must stay legal; a row naming
//     nobody stays app-enforced (the track-record suite plants one on
//     purpose — see the migration);
//   · the (eventId, orgId) unique, with NULLs distinct;
//   · ON DELETE CASCADE from Organization;
//   · the adapter's `attach({ orgId })` upsert on that key.
//
// THE DDL IS THE SHIPPED MIGRATIONS (house precedent, see
// booking-request-acts.integration.test.ts): the baseline's own EventHuman
// table, unique and FKs, then 20260925120000_booking_request_acts and
// 20261001120000_lineup_v3 run whole. Event / Human / Organization /
// BookingRequest are id-only stubs — enough for every FK and cascade to be
// real; none of their DDL is under test.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../db/prisma/migrations",
);

const read = (name: string) =>
  readFileSync(resolve(MIGRATIONS_DIR, name, "migration.sql"), "utf8");

const BASELINE_SQL = read("20260407000000_consolidated_baseline");

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
  `CREATE TABLE "Event" ("id" TEXT PRIMARY KEY);`,
  `CREATE TABLE "Human" ("id" TEXT PRIMARY KEY);`,
  `CREATE TABLE "Organization" ("id" TEXT PRIMARY KEY);`,
  `CREATE TABLE "BookingRequest" ("id" TEXT PRIMARY KEY, "performerOwnerType" TEXT, "performerOwnerId" TEXT);`,
  statementFrom(BASELINE_SQL, `CREATE TABLE "EventHuman"`),
  statementFrom(BASELINE_SQL, `CREATE UNIQUE INDEX "EventHuman_eventId_humanId_key"`),
  statementFrom(BASELINE_SQL, `ALTER TABLE "EventHuman" ADD CONSTRAINT "EventHuman_eventId_fkey"`),
  statementFrom(BASELINE_SQL, `ALTER TABLE "EventHuman" ADD CONSTRAINT "EventHuman_humanId_fkey"`),
  read("20260925120000_booking_request_acts"),
  read("20261001120000_lineup_v3"),
].join("\n\n");

const EVENT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const EVENT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const ORG_1 = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const HUMAN_1 = "11111111-1111-4111-8111-111111111111";

describe("EventHuman.orgId — a lineup row can be a group (integration)", () => {
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
    await pool?.query(
      `TRUNCATE "EventHuman", "Event", "Human", "Organization" CASCADE`,
    );
    await pool?.query(`INSERT INTO "Event" ("id") VALUES ($1), ($2)`, [
      EVENT_A,
      EVENT_B,
    ]);
    await pool?.query(`INSERT INTO "Human" ("id") VALUES ($1)`, [HUMAN_1]);
    await pool?.query(`INSERT INTO "Organization" ("id") VALUES ($1)`, [
      ORG_1,
    ]);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  const repo = () => makeEventHumansRepo(prisma!);

  /** Raw insert that bypasses the adapter, for CHECK / unique assertions. */
  async function rawInsert(cols: Record<string, unknown>) {
    const all = {
      id: crypto.randomUUID(),
      eventId: EVENT_A,
      updatedAt: new Date(),
      ...cols,
    };
    const keys = Object.keys(all);
    await pool!.query(
      `INSERT INTO "EventHuman" (${keys.map((k) => `"${k}"`).join(", ")})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(all),
    );
  }

  test("attach({ orgId }) links the group and reads it back", async () => {
    const row = await repo().attach({
      eventId: EVENT_A,
      orgId: ORG_1,
      role: "PERFORMER",
      sortOrder: 1,
    });
    expect(row).toMatchObject({
      eventId: EVENT_A,
      orgId: ORG_1,
      humanId: null,
      externalName: null,
      role: "PERFORMER",
      sortOrder: 1,
    });
    await expect(repo().getById(row.id)).resolves.toMatchObject({
      orgId: ORG_1,
    });
  });

  test("attach({ orgId }) is idempotent per (event, org), like the human upsert", async () => {
    const first = await repo().attach({
      eventId: EVENT_A,
      orgId: ORG_1,
      role: "PERFORMER",
    });
    const again = await repo().attach({
      eventId: EVENT_A,
      orgId: ORG_1,
      role: "DJ",
      sortOrder: 4,
    });
    // Same row, untouched (update: {}).
    expect(again).toMatchObject({ id: first.id, role: "PERFORMER" });
    // The same group on another event is its own row.
    const elsewhere = await repo().attach({
      eventId: EVENT_B,
      orgId: ORG_1,
      role: "PERFORMER",
    });
    expect(elsewhere.id).not.toBe(first.id);
  });

  test("human and free-text rows still attach, with orgId null", async () => {
    const person = await repo().attach({
      eventId: EVENT_A,
      humanId: HUMAN_1,
      role: "PERFORMER",
    });
    const freeText = await repo().attach({
      eventId: EVENT_A,
      externalName: "Junco",
      role: "PERFORMER",
    });
    expect(person.orgId).toBeNull();
    expect(freeText.orgId).toBeNull();
  });

  describe("EventHuman_identity_check", () => {
    const identity = /EventHuman_identity_check/;

    test("a row cannot be a person AND a group", async () => {
      await expect(
        rawInsert({ humanId: HUMAN_1, orgId: ORG_1 }),
      ).rejects.toThrow(identity);
      // The adapter refuses it up front, with a typed error, before any write.
      await expect(
        repo().attach({
          eventId: EVENT_A,
          humanId: HUMAN_1,
          orgId: ORG_1,
          role: "PERFORMER",
        }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        message: "event_human_person_and_group",
      });
      const { rows } = await pool!.query(`SELECT 1 FROM "EventHuman"`);
      expect(rows).toHaveLength(0);
    });

    test("person AND group on the UPDATE path is refused too (no silent orgId drop)", async () => {
      // The (event, human) row already exists, so the human upsert would hit
      // `update: {}` — the CHECK never fires there. The adapter must refuse.
      const existing = await repo().attach({
        eventId: EVENT_A,
        humanId: HUMAN_1,
        role: "PERFORMER",
      });
      await expect(
        repo().attach({
          eventId: EVENT_A,
          humanId: HUMAN_1,
          orgId: ORG_1,
          role: "PERFORMER",
        }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        message: "event_human_person_and_group",
      });
      await expect(repo().getById(existing.id)).resolves.toMatchObject({
        humanId: HUMAN_1,
        orgId: null,
      });
      const { rows } = await pool!.query(`SELECT 1 FROM "EventHuman"`);
      expect(rows).toHaveLength(1);
    });

    test("a row naming nobody is left to the app, not the CHECK", async () => {
      // Deliberate (migration comment): event-humans-acts-by-place plants one
      // and prod was not counted. attachEventHuman refuses it
      // (HUMAN_ID_OR_EXTERNAL_NAME_REQUIRED).
      await expect(rawInsert({})).resolves.toBeUndefined();
    });

    test("a LINKED row may keep its stage name (linkHuman's shape stays legal)", async () => {
      await expect(
        rawInsert({ humanId: HUMAN_1, externalName: "DJ Stage Name" }),
      ).resolves.toBeUndefined();
      await expect(
        rawInsert({ eventId: EVENT_B, orgId: ORG_1, externalName: "The Band" }),
      ).resolves.toBeUndefined();
      // And the adapter's own link path passes the CHECK.
      const freeText = await repo().attach({
        eventId: EVENT_B,
        externalName: "Soon linked",
        role: "PERFORMER",
      });
      await expect(
        repo().linkHuman({ id: freeText.id, humanId: HUMAN_1 }),
      ).resolves.toMatchObject({
        humanId: HUMAN_1,
        externalName: "Soon linked",
        orgId: null,
      });
    });
  });

  test("one row per group per event; NULL orgIds never collide", async () => {
    await rawInsert({ orgId: ORG_1 });
    await expect(rawInsert({ orgId: ORG_1 })).rejects.toThrow(
      /EventHuman_eventId_orgId_key/,
    );
    await rawInsert({ externalName: "Same" });
    await expect(rawInsert({ externalName: "Same" })).resolves.toBeUndefined();
  });

  test("deleting the organization cascades its lineup rows", async () => {
    const row = await repo().attach({
      eventId: EVENT_A,
      orgId: ORG_1,
      role: "PERFORMER",
    });
    await pool!.query(`DELETE FROM "Organization" WHERE "id" = $1`, [ORG_1]);
    await expect(repo().getById(row.id)).resolves.toBeNull();
  });

  test("orgId must reference a real organization", async () => {
    await expect(
      rawInsert({ orgId: "99999999-9999-4999-8999-999999999999" }),
    ).rejects.toThrow(/EventHuman_orgId_fkey/);
  });
});
