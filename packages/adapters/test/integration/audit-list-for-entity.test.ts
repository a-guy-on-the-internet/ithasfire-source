import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeAuditRepo } from "../../src/db/prisma/audit";

const UPDATED = "entity_page.community_updated";
const HANDOVER = "entity_page.community_handover";

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 9, 14, 12, minutes));
}

describe("Prisma adapters integration – audit.listForEntity", () => {
  let pg: PostgresTestContainer | undefined;
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  // Unique per run: the shared test server keeps rows between files.
  const pageId = randomUUID();
  const otherPageId = randomUUID();

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);
      process.env.DATABASE_URL = pg.databaseUrl;
      // Driver-adapter mode, as packages/db/src/index.ts constructs it.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      await prisma.auditLog.createMany({
        data: [
          { entity: "entity_page", entityId: pageId, action: UPDATED, at: at(1), data: { actorHumanId: "mod-1" } },
          { entity: "entity_page", entityId: pageId, action: UPDATED, at: at(3), data: { actorHumanId: "mod-2" } },
          { entity: "entity_page", entityId: pageId, action: HANDOVER, at: at(2), data: { actorHumanId: "owner" } },
          // Same page, another action; another page; another entity.
          { entity: "entity_page", entityId: pageId, action: "entity_page.draft_published", at: at(4) },
          { entity: "entity_page", entityId: otherPageId, action: UPDATED, at: at(5) },
          { entity: "place", entityId: pageId, action: UPDATED, at: at(6) },
          // A contains-match the exact filter must NOT take.
          { entity: "entity_page_x", entityId: pageId, action: UPDATED, at: at(7) },
        ],
      });
    } catch (error) {
      runtimeError = error as Error;
      // eslint-disable-next-line no-console
      console.error("audit listForEntity integration setup failed:", error);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.auditLog.deleteMany({
        where: { entityId: { in: [pageId, otherPageId] } },
      });
      await prisma.$disconnect();
    }
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  test("exact entity / entityId / action match, newest first", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeAuditRepo(prisma);
    const rows = await repo.listForEntity({
      entity: "entity_page",
      entityId: pageId,
      actions: [UPDATED],
      limit: 10,
    });
    expect(rows.map((row) => [row.action, row.at, row.actorHumanId])).toEqual([
      [UPDATED, at(3), "mod-2"],
      [UPDATED, at(1), "mod-1"],
    ]);
  }, 60_000);

  test("`after` is strict and `limit` bounds the read", async ({ skip }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const repo = makeAuditRepo(prisma);
    const [handover] = await repo.listForEntity({
      entity: "entity_page",
      entityId: pageId,
      actions: [HANDOVER],
      limit: 1,
    });
    expect(handover?.at).toEqual(at(2));

    const after = await repo.listForEntity({
      entity: "entity_page",
      entityId: pageId,
      actions: [UPDATED],
      after: at(2),
      limit: 10,
    });
    expect(after.map((row) => row.at)).toEqual([at(3)]);

    const strict = await repo.listForEntity({
      entity: "entity_page",
      entityId: pageId,
      actions: [UPDATED],
      after: at(3),
      limit: 10,
    });
    expect(strict).toEqual([]);

    const both = await repo.listForEntity({
      entity: "entity_page",
      entityId: pageId,
      actions: [UPDATED, HANDOVER],
      limit: 2,
    });
    expect(both.map((row) => row.at)).toEqual([at(3), at(2)]);
  }, 60_000);
});
