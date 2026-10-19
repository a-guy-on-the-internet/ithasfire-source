import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PLATFORM_VOLUNTEER_WAIVER_BODY,
  PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID,
} from "../constants";

// The fixed id and body are a contract between code and SQL: the migration
// inserts the platform "Standard Volunteer Waiver" row under this exact id
// with this exact body, the dev seed upserts the same constants, and later
// steps (picker one-click, ownership checks) reference them. These tests pin
// the sides together so none can drift silently.

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../db/prisma/migrations",
);
// The migration that INSERTS the row (id, name, FK posture).
const MIGRATION_PATH = resolve(
  MIGRATIONS_DIR,
  "20260707150000_add_ask_waiver_template/migration.sql",
);
// The LATEST migration that revises the body. Re-point this when a newer
// revision ships.
const BODY_MIGRATION_PATH = resolve(
  MIGRATIONS_DIR,
  "20261017200000_volunteer_waiver_place_wording/migration.sql",
);

describe("PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID", () => {
  it("is a well-formed v4-style UUID", () => {
    expect(PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("matches the id inserted by the platform-default migration", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    expect(sql).toContain(`'${PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID}'`);
    expect(sql).toContain("'Standard Volunteer Waiver'");
    // The liability gate must never be silently disarmed by a template delete.
    expect(sql).toContain("ON DELETE RESTRICT");
  });

  it("matches the body written by the latest revising migration byte-for-byte", () => {
    const sql = readFileSync(BODY_MIGRATION_PATH, "utf8");
    // The SQL literal is the constant with apostrophes doubled ('' escaping),
    // closed by the quote: a stray trailing newline in either copy breaks
    // the match.
    expect(sql).toContain(
      `'${PLATFORM_VOLUNTEER_WAIVER_BODY.replaceAll("'", "''")}'`,
    );
  });

  it("the revising migration bumps the version of the platform row only, once", () => {
    const sql = readFileSync(BODY_MIGRATION_PATH, "utf8");
    expect(sql).toContain(`"version" = 2,`);
    expect(sql).toContain(`WHERE "id" = '${PLATFORM_VOLUNTEER_WAIVER_TEMPLATE_ID}'`);
    // Idempotent on the version, not the body: the dev seed writes the new
    // body without bumping "version", so a body guard would skip the bump.
    expect(sql).toContain(`AND "version" < 2;`);
  });

  it("never says venue; names the party as the place's owners and operators", () => {
    expect(PLATFORM_VOLUNTEER_WAIVER_BODY).not.toMatch(/\bvenues?\b/i);
    // Sections 1 (employment status), 4 (release) and 6 (rules) name people,
    // not the location (owner ruling 2026-10-17).
    expect(
      PLATFORM_VOLUNTEER_WAIVER_BODY.match(/the place's owners and operators/g),
    ).toHaveLength(3);
  });
});
