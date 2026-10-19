import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  eventOwnerNotWithheldSubquerySql,
  eventOwnerNotWithheldWhere,
  NO_WITHHELD_OWNERS,
  ownerBannedFromStanding,
  SEARCH_DOC_NOT_WITHHELD_SQL,
  withEventOwnerNotWithheld,
  WITHHELD_HUMAN_IDS_SQL,
  WITHHELD_ORG_IDS_SQL,
} from "../banned-owner";

// Shapes of each encoding of the withheld-owner rule. The SQL is executed
// against a real database in `banned-owner.integration.test.ts`.

describe("ownerBannedFromStanding (opt-in single-row reads)", () => {
  const owner = (status: string) => ({ human: { status } });

  it.each([
    ["no owner at all (community listing)", {}, false],
    ["an ACTIVE human owner", { human: { status: "ACTIVE" } }, false],
    ["a SUSPENDED human owner", { human: { status: "SUSPENDED" } }, false],
    ["a BANNED human owner", { human: { status: "BANNED" } }, true],
    ["an org with no OWNER rows", { org: { members: [] } }, false],
    [
      "an org whose sole OWNER is banned",
      { org: { members: [owner("BANNED")] } },
      true,
    ],
    [
      "an org whose every OWNER is banned",
      { org: { members: [owner("BANNED"), owner("BANNED")] } },
      true,
    ],
    [
      "an org with a second, un-banned OWNER",
      { org: { members: [owner("BANNED"), owner("ACTIVE")] } },
      false,
    ],
  ])("%s → %s", (_label, row, expected) => {
    expect(ownerBannedFromStanding(row)).toBe(expected);
  });
});

describe("Prisma where encoding (id set)", () => {
  it("adds NO filter at all when nothing is withheld", () => {
    expect(eventOwnerNotWithheldWhere(NO_WITHHELD_OWNERS)).toBeNull();
    const where = { status: "PUBLISHED" as const };
    expect(withEventOwnerNotWithheld(where, NO_WITHHELD_OWNERS)).toBe(where);
  });

  it("is NULL-safe per column (a NULL owner id is never withheld)", () => {
    expect(
      eventOwnerNotWithheldWhere({ humanIds: ["h1"], orgIds: ["o1"] }),
    ).toEqual({
      AND: [
        { OR: [{ humanId: null }, { humanId: { notIn: ["h1"] } }] },
        { OR: [{ orgId: null }, { orgId: { notIn: ["o1"] } }] },
      ],
    });
    expect(
      eventOwnerNotWithheldWhere({ humanIds: [], orgIds: ["o1"] }),
    ).toEqual({
      AND: [{ OR: [{ orgId: null }, { orgId: { notIn: ["o1"] } }] }],
    });
  });

  it("merges into an existing AND instead of clobbering it", () => {
    const existing = { placeId: "p1" };
    const merged = withEventOwnerNotWithheld(
      { status: "PUBLISHED", AND: [existing] },
      { humanIds: ["h1"], orgIds: [] },
    );
    expect(merged.AND).toEqual([
      existing,
      { AND: [{ OR: [{ humanId: null }, { humanId: { notIn: ["h1"] } }] }] },
    ]);
  });
});

describe("raw SQL encoding (subquery over the banned set)", () => {
  it("binds no values and wraps IN (subquery) in COALESCE for NULL owner ids", () => {
    const sql = eventOwnerNotWithheldSubquerySql("e");
    expect(sql.values).toEqual([]);
    expect(sql.sql).toContain('NOT COALESCE(e."humanId" IN (');
    expect(sql.sql).toContain('NOT COALESCE(e."orgId" IN (');
    expect(sql.sql).toContain("'BANNED'::\"HumanStatus\"");
  });

  it("the org set requires a banned OWNER and no un-banned OWNER, driven from banned humans", () => {
    const text = WITHHELD_ORG_IDS_SQL.sql;
    expect(text).toMatch(/bh\.status = 'BANNED'/);
    expect(text).toMatch(/bm\.role = 'OWNER'/);
    expect(text).toMatch(/NOT EXISTS \([\s\S]*bh2\.status <> 'BANNED'/);
  });

  it("the search filter covers human, organization and event documents", () => {
    const text = SEARCH_DOC_NOT_WITHHELD_SQL.sql;
    expect(text).toContain("d.human_id IN (");
    expect(text).toContain("d.org_id_ref IN (");
    expect(text).toContain("d.owner_human_id IN (");
    expect(text).toContain("d.org_id IN (");
  });
});

// The withheld-set lookup relies on a PARTIAL index Prisma's datamodel cannot
// express, so no schema diff would notice it going missing. Guard it here,
// against the migration SQL as shipped (read from disk, not retyped).
describe("Human_banned_id_idx (partial index guard)", () => {
  const migrationsDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../db/prisma/migrations",
  );
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(resolve(migrationsDir, name, "migration.sql"), "utf8"),
    }));

  it("is created exactly once, on BANNED humans only", () => {
    const creators = migrations.filter((m) =>
      /CREATE\s+INDEX\s+"Human_banned_id_idx"/i.test(m.sql),
    );
    expect(creators.map((m) => m.name)).toEqual([
      "20260929140000_ban_hardening_session_ip_and_banned_index",
    ]);
    expect(creators[0]!.sql).toMatch(
      /CREATE INDEX "Human_banned_id_idx" ON "Human" \("id"\) WHERE "status" = 'BANNED';/,
    );
  });

  it("is never dropped by a later migration", () => {
    const droppers = migrations.filter((m) =>
      /DROP\s+INDEX[^;]*"?Human_banned_id_idx"?/i.test(m.sql),
    );
    expect(droppers.map((m) => m.name)).toEqual([]);
  });

  it("matches the predicate the lookup filters on", () => {
    expect(WITHHELD_HUMAN_IDS_SQL.sql).toContain(
      "bh.status = 'BANNED'::\"HumanStatus\"",
    );
  });
});
