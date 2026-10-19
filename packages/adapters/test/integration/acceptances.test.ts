/**
 * Acceptance-ledger uniqueness guarantees against real Postgres.
 *
 * The unit tests (src/db/prisma/__tests__/acceptances.test.ts) exercise the
 * adapter contract through an in-memory fake. These tests run the real
 * Prisma adapter so we know:
 *
 *  - the SQL-only unique index "AcceptanceRecord_human_doc_version_scope_key"
 *    (migration 20260612000000) really is NULLS NOT DISTINCT — GLOBAL-scope
 *    rows with scopeId NULL (buyer ToS / refund policy, the main case)
 *    cannot duplicate,
 *  - concurrent `create` races have exactly one surviving row and BOTH
 *    callers get a row back (no error),
 *  - a duplicate insert inside an interactive transaction does NOT abort
 *    the transaction — createMany({ skipDuplicates: true }) maps to
 *    ON CONFLICT DO NOTHING, unlike a caught P2002 which would poison the
 *    tx with "current transaction is aborted". An order-creating tx must
 *    never fail because the human concurrently accepted elsewhere.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import type { CreateAcceptanceRecordInput } from "@th/ports/repos/acceptances";

import { createPrismaRepos } from "../../src/db/prisma";

const ACCEPTED_AT = new Date("2026-06-12T12:00:00.000Z");

describe("Prisma adapters integration – acceptance records", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  let humanId: string;

  beforeAll(async () => {
    try {
      pgContainer = await startPostgresContainer();
      await runPrismaMigrateDeploy(pgContainer.databaseUrl);
      process.env.DATABASE_URL = pgContainer.databaseUrl;
      pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const human = await prisma.human.create({
        data: { name: "Acceptance Tester", status: "ACTIVE" },
      });
      humanId = human.id;
    } catch (err) {
      runtimeError = err as Error;
      console.error("[acceptances.test] setup failed:", err);
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

  beforeEach(async () => {
    if (!prisma) return;
    await prisma.acceptanceRecord.deleteMany({});
  }, 60_000);

  function buildInput(
    overrides?: Partial<CreateAcceptanceRecordInput>,
  ): CreateAcceptanceRecordInput {
    return {
      humanId,
      documentType: "BUYER_TERMS",
      documentVersion: "2026-06-10",
      documentTextSnapshot: "By purchasing you agree…",
      scopeType: "GLOBAL",
      scopeId: null,
      acceptedAt: ACCEPTED_AT,
      ipAddress: "203.0.113.7",
      userAgent: "vitest-integration",
      metadata: null,
      ...overrides,
    };
  }

  // ── 1. The index itself ────────────────────────────────────────────────────
  test("unique index exists and is NULLS NOT DISTINCT", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const [index] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'AcceptanceRecord'
        AND indexname = 'AcceptanceRecord_human_doc_version_scope_key'
    `;
    expect(index).toBeDefined();
    expect(index!.indexdef).toContain("UNIQUE");
    expect(index!.indexdef).toContain("NULLS NOT DISTINCT");
  }, 300_000);

  // ── 2. GLOBAL / NULL-scopeId duplicates (the main case) ───────────────────
  test("second GLOBAL (scopeId NULL) create returns the existing row; only one row survives", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    const first = await repos.acceptances.create(buildInput());
    const second = await repos.acceptances.create(
      buildInput({
        acceptedAt: new Date("2026-06-12T12:00:05.000Z"),
        ipAddress: "198.51.100.9",
      }),
    );

    expect(second.id).toBe(first.id);
    expect(second.ipAddress).toBe("203.0.113.7"); // winner's forensics survive

    const count = await prisma.acceptanceRecord.count({
      where: { humanId, documentType: "BUYER_TERMS" },
    });
    expect(count).toBe(1);
  }, 300_000);

  // ── 3. Concurrent create race ──────────────────────────────────────────────
  test("concurrent creates for the same key: both resolve, exactly one row", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    const results = await Promise.allSettled([
      repos.acceptances.create(buildInput()),
      repos.acceptances.create(buildInput({ ipAddress: "198.51.100.9" })),
    ]);

    // Hard requirement: nobody errors — the loser adopts the winner's row.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const [a, b] = results as Array<
      PromiseFulfilledResult<{ id: string }>
    >;
    expect(a.value.id).toBe(b.value.id);

    const count = await prisma.acceptanceRecord.count({
      where: { humanId, documentType: "BUYER_TERMS" },
    });
    expect(count).toBe(1);
  }, 300_000);

  // ── 4. Duplicate inside an interactive tx must not abort it ───────────────
  test("a duplicate create inside repos.tx leaves the transaction healthy", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);

    // Another session already holds the key (e.g. a checkout on a second
    // device committed first).
    const winner = await repos.acceptances.create(buildInput());

    // The order-creating tx: hits the duplicate, then keeps writing. If the
    // duplicate aborted the tx, the follow-up write — and the whole order —
    // would fail with "current transaction is aborted".
    const { duplicate, refundPolicy } = await repos.tx(async (tx) => {
      const duplicate = await tx.acceptances.create(
        buildInput({ ipAddress: "198.51.100.9" }),
      );
      const refundPolicy = await tx.acceptances.create(
        buildInput({
          documentType: "REFUND_POLICY",
          documentVersion: "2026-06-10",
        }),
      );
      return { duplicate, refundPolicy };
    });

    expect(duplicate.id).toBe(winner.id);
    expect(refundPolicy.documentType).toBe("REFUND_POLICY");

    const rows = await prisma.acceptanceRecord.findMany({
      where: { humanId },
      select: { documentType: true },
    });
    expect(rows).toHaveLength(2); // BUYER_TERMS ×1, REFUND_POLICY ×1
  }, 300_000);

  // ── 5. Non-null scopeId behaves the same; distinct scopes stay distinct ───
  test("ORGANIZATION-scoped duplicates collapse per scopeId", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repos = createPrismaRepos(prisma);
    const orgScoped = buildInput({
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
      scopeType: "ORGANIZATION",
      scopeId: "org_alpha",
    });

    const first = await repos.acceptances.create(orgScoped);
    const replay = await repos.acceptances.create(orgScoped);
    const otherOrg = await repos.acceptances.create({
      ...orgScoped,
      scopeId: "org_beta",
    });

    expect(replay.id).toBe(first.id);
    expect(otherOrg.id).not.toBe(first.id);

    const count = await prisma.acceptanceRecord.count({
      where: { humanId, documentType: "CHARGEBACK_TERMS_ORGANIZER" },
    });
    expect(count).toBe(2);
  }, 300_000);
});
