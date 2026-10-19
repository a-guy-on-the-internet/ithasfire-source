import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeFeePoliciesRepo } from "../fee-policies";

// ---------------------------------------------------------------------------
// Integration coverage for the DB backstop "at most one ACTIVE FeePolicy per
// scope" (migration 20260812130000_fee_policy_one_active_per_scope).
//
// The invariant used to live ONLY in code — `feePolicies.lockScopeGuard`, an
// advisory lock a future caller of `upsert` can simply forget. The existing
// `@@unique([scopeType, scopeId, status, version])` cannot express it because
// GLOBAL rows carry `scopeId IS NULL` and Postgres treats NULLs as distinct,
// which is why the partial index keys on `COALESCE("scopeId", '')`. None of
// that is provable against a mocked Prisma client — it is Postgres semantics —
// so this hits real Postgres.
//
// THE MIGRATION SQL IS READ FROM DISK, NOT RETYPED HERE. A hand-copied index
// definition in a test file is green by construction: it would keep passing
// after someone weakened or deleted the shipped DDL. Everything asserted below
// is asserted about the exact bytes that will run on prod.
// ---------------------------------------------------------------------------

const MIGRATION_SQL = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations/20260812130000_fee_policy_one_active_per_scope/migration.sql",
  ),
  "utf8",
);

/**
 * Standalone DDL for just `FeePolicy` + the three enums it references. Column
 * naming mirrors Prisma's default mapping (quoted PascalCase table, camelCase
 * columns) — `FeePolicy` has NO `@@map`, which is precisely why the migration's
 * identifiers are camelCase rather than the snake_case of the
 * `support_thread_one_active_per_human` precedent it follows.
 *
 * The `@@unique([scopeType, scopeId, status, version])` from the model is
 * included on purpose: half the point of the new index is that this one does
 * NOT catch duplicate ACTIVE GLOBAL rows, and a test that omitted it could not
 * tell the two apart.
 */
const TABLE_SQL = `
CREATE TYPE "FeePolicyScopeType" AS ENUM ('GLOBAL', 'ORG', 'EVENT');
CREATE TYPE "FeePolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "PaymentFeeType" AS ENUM ('ABSORB', 'PASS_THROUGH');

CREATE TABLE "FeePolicy" (
  "id" TEXT NOT NULL,
  "scopeType" "FeePolicyScopeType" NOT NULL,
  "scopeId" TEXT,
  "status" "FeePolicyStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "buyerFeePct" DECIMAL(5,4) NOT NULL,
  "maxFeeCents" INTEGER,
  "minFeeCents" INTEGER NOT NULL DEFAULT 0,
  "maxPlatformFeeCents" INTEGER,
  "platformFixedCents" INTEGER NOT NULL DEFAULT 0,
  "feeMode" "PaymentFeeType" NOT NULL DEFAULT 'PASS_THROUGH',
  "processsorFeePct" DECIMAL(5,4) NOT NULL,
  "processorFixedCents" INTEGER NOT NULL,
  "payoutPct" DECIMAL(5,4) NOT NULL,
  "payoutFixedCents" INTEGER NOT NULL,
  "monthlyPayoutCents" INTEGER NOT NULL,
  "payoutMinimumCents" INTEGER NOT NULL DEFAULT 1000,
  "connectAccountFeeCents" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT,
  "createdBy" TEXT NOT NULL,
  "approvedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FeePolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FeePolicy_scopeType_scopeId_status_version_key"
  ON "FeePolicy" ("scopeType", "scopeId", "status", "version");
`;

const INDEX_NAME = "FeePolicy_one_active_per_scope_key";

const UPSERT_INPUT = {
  scopeType: "GLOBAL" as const,
  scopeId: null,
  buyerFeePct: 0.0333,
  maxFeeCents: 50,
  minFeeCents: 0,
  maxPlatformFeeCents: null,
  platformFixedCents: 0,
  feeMode: "PASS_THROUGH" as const,
  processsorFeePct: 0.029,
  processorFixedCents: 30,
  payoutPct: 0.0025,
  payoutFixedCents: 25,
  monthlyPayoutCents: 200,
  payoutMinimumCents: 1000,
  connectAccountFeeCents: 0,
  actorHumanId: "system:test",
};

describe("FeePolicy one-ACTIVE-per-scope index (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool!.query(`DROP INDEX IF EXISTS "${INDEX_NAME}"`);
    await pool!.query(`TRUNCATE "FeePolicy"`);
    // Apply the SHIPPED migration, whole, every time — the pre-flight DO block
    // included. It is idempotent (`CREATE UNIQUE INDEX IF NOT EXISTS`) because
    // the dev databases here are db-push-managed.
    await pool!.query(MIGRATION_SQL);
  });

  // Explicit timeout: tearing a Testcontainers Postgres down routinely takes
  // longer than vitest's 10s default hook timeout, which fails the SUITE after
  // every test in it has already passed.
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  async function insert(row: {
    id: string;
    scopeType: "GLOBAL" | "ORG" | "EVENT";
    scopeId: string | null;
    status: "DRAFT" | "ACTIVE" | "ARCHIVED";
    version: number;
  }) {
    await pool!.query(
      `INSERT INTO "FeePolicy"
        ("id","scopeType","scopeId","status","version","effectiveFrom",
         "buyerFeePct","processsorFeePct","processorFixedCents",
         "payoutPct","payoutFixedCents","monthlyPayoutCents","createdBy")
       VALUES ($1,$2,$3,$4,$5, now(), 0.0333, 0.029, 30, 0.0025, 25, 200, 'system:test')`,
      [row.id, row.scopeType, row.scopeId, row.status, row.version],
    );
  }

  test("the migration installs a PARTIAL unique index keyed on COALESCE(scopeId, '')", async () => {
    const { rows } = await pool!.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'FeePolicy' AND indexname = $1`,
      [INDEX_NAME],
    );

    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toContain("UNIQUE INDEX");
    expect(def).toContain(`COALESCE("scopeId", ''::text)`);
    // Partial: DRAFT and ARCHIVED rows are outside the gate, so version history
    // and drafts stay unbounded.
    expect(def).toMatch(/WHERE \(status = 'ACTIVE'/);
  });

  test("REFUSES a second ACTIVE row for the same GLOBAL scope (scopeId IS NULL)", async () => {
    await insert({
      id: "g1",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ACTIVE",
      version: 1,
    });

    // Different `version`, so the existing @@unique does not fire — and it
    // could not fire even on the SAME version, because NULLs compare distinct.
    // This is the exact hole the new index closes.
    await expect(
      insert({
        id: "g2",
        scopeType: "GLOBAL",
        scopeId: null,
        status: "ACTIVE",
        version: 2,
      }),
    ).rejects.toMatchObject({ code: "23505", constraint: INDEX_NAME });
  });

  test("the OLD @@unique really is powerless here (proof the COALESCE is load-bearing)", async () => {
    await pool!.query(`DROP INDEX "${INDEX_NAME}"`);

    await insert({
      id: "g1",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ACTIVE",
      version: 1,
    });
    // Byte-identical tuple (GLOBAL, NULL, ACTIVE, 1) — accepted, because
    // Postgres treats NULL `scopeId` values as distinct.
    await insert({
      id: "g2",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ACTIVE",
      version: 1,
    });

    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "FeePolicy" WHERE "status" = 'ACTIVE'`,
    );
    expect(rows[0]!.n).toBe("2");
  });

  test("ALLOWS one ACTIVE row per DIFFERENT scope", async () => {
    await insert({
      id: "g1",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ACTIVE",
      version: 1,
    });
    await insert({
      id: "o1",
      scopeType: "ORG",
      scopeId: "org-a",
      status: "ACTIVE",
      version: 1,
    });
    await insert({
      id: "o2",
      scopeType: "ORG",
      scopeId: "org-b",
      status: "ACTIVE",
      version: 1,
    });
    await insert({
      id: "e1",
      scopeType: "EVENT",
      scopeId: "evt-a",
      status: "ACTIVE",
      version: 1,
    });

    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "FeePolicy" WHERE "status" = 'ACTIVE'`,
    );
    expect(rows[0]!.n).toBe("4");

    // …but still only one per scope.
    await expect(
      insert({
        id: "o1b",
        scopeType: "ORG",
        scopeId: "org-a",
        status: "ACTIVE",
        version: 2,
      }),
    ).rejects.toMatchObject({ code: "23505", constraint: INDEX_NAME });
  });

  test("ALLOWS one ACTIVE alongside any number of ARCHIVED/DRAFT rows for the same scope", async () => {
    await insert({
      id: "a1",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ARCHIVED",
      version: 1,
    });
    await insert({
      id: "a2",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ARCHIVED",
      version: 2,
    });
    await insert({
      id: "a3",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ARCHIVED",
      version: 3,
    });
    await insert({
      id: "d1",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "DRAFT",
      version: 4,
    });
    await insert({
      id: "g1",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ACTIVE",
      version: 5,
    });

    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "FeePolicy"`,
    );
    expect(rows[0]!.n).toBe("5");
  });

  test("REFUSES flipping an ARCHIVED row back to ACTIVE while one is already ACTIVE", async () => {
    // The index guards UPDATEs, not just INSERTs — an un-archive is the other
    // way a scope ends up with two live policies.
    await insert({
      id: "a1",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ARCHIVED",
      version: 1,
    });
    await insert({
      id: "g1",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ACTIVE",
      version: 2,
    });

    await expect(
      pool!.query(`UPDATE "FeePolicy" SET "status" = 'ACTIVE' WHERE "id" = 'a1'`),
    ).rejects.toMatchObject({ code: "23505", constraint: INDEX_NAME });
  });

  test("the PRODUCTION write path (feePolicies.upsert, archive-then-create) still works under the index", async () => {
    const repo = makeFeePoliciesRepo(prisma!);

    const v1 = await repo.upsert(UPSERT_INPUT);
    expect(v1.version).toBe(1);

    // Second reconcile with changed economics: archives v1, mints v2. This is
    // the exact sequence the deploy-time reconciler runs, and the whole point
    // of adding the index was that it must NOT break it.
    const v2 = await repo.upsert({ ...UPSERT_INPUT, maxFeeCents: 75 });
    expect(v2.version).toBe(2);

    const { rows } = await pool!.query<{ status: string; version: number }>(
      `SELECT "status", "version" FROM "FeePolicy" ORDER BY "version"`,
    );
    expect(rows).toEqual([
      { status: "ARCHIVED", version: 1 },
      { status: "ACTIVE", version: 2 },
    ]);
  });

  test("the migration FAILS LOUDLY, naming the scopes, when the data already violates", async () => {
    // Pre-existing duplicates are deliberately NOT auto-repaired: picking a
    // winner between two ACTIVE fee policies is an economics decision. What the
    // migration owes an unattended deploy job is a diagnosable error rather
    // than Postgres' generic "Key ... is duplicated".
    await pool!.query(`DROP INDEX "${INDEX_NAME}"`);
    await insert({
      id: "g1",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ACTIVE",
      version: 1,
    });
    await insert({
      id: "g2",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ACTIVE",
      version: 2,
    });
    await insert({
      id: "o1",
      scopeType: "ORG",
      scopeId: "org-a",
      status: "ACTIVE",
      version: 1,
    });
    await insert({
      id: "o2",
      scopeType: "ORG",
      scopeId: "org-a",
      status: "ACTIVE",
      version: 2,
    });

    await expect(pool!.query(MIGRATION_SQL)).rejects.toMatchObject({
      message: expect.stringContaining("GLOBAL/<null-or-empty> (2 ACTIVE rows)"),
    });
    await expect(pool!.query(MIGRATION_SQL)).rejects.toMatchObject({
      message: expect.stringContaining("ORG/org-a (2 ACTIVE rows)"),
    });

    // And it did NOT half-apply: no index was created behind the exception.
    const { rows } = await pool!.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
      [INDEX_NAME],
    );
    expect(rows).toHaveLength(0);
  });

  test("re-applying the migration over an existing index is a no-op, not an error", async () => {
    // dev DBs here are db-push-managed, so a migration legitimately re-runs
    // over a schema that already has the index.
    await insert({
      id: "g1",
      scopeType: "GLOBAL",
      scopeId: null,
      status: "ACTIVE",
      version: 1,
    });

    await expect(pool!.query(MIGRATION_SQL)).resolves.toBeDefined();

    const { rows } = await pool!.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
      [INDEX_NAME],
    );
    expect(rows).toHaveLength(1);
  });
});
