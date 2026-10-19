/**
 * Integration coverage for the platform-catalogue half of the volunteering
 * role-template tables (2026-07-27 volunteer-role-packs spec, FR-002 →
 * FR-004, FR-009, NFR-002), against real Postgres.
 *
 * What a stubbed repo cannot prove:
 *
 *  - The raw partial unique index
 *    "VolunteerRoleTemplate_platform_pack_name_key" (SQL-only, invisible to
 *    Prisma) rejects a second "Door" IN THE SAME PACK while still allowing a
 *    "Door" in a different one, now that @@unique([orgId, name]) no longer
 *    constrains catalogue rows (Postgres treats NULLs as distinct).
 *  - The CHECK constraint "VolunteerRoleTemplate_platform_pack_check" keeps
 *    every platform row inside that index (a pack-less one would key on
 *    (NULL, name) and escape it) and turns "deleting a pack deletes its
 *    platform roles" from a comment into a DB failure.
 *  - `listRoleTemplates` really returns org rows UNION LIVE platform rows in
 *    ONE query, with zero rows from any other org and zero rows under a
 *    DRAFT pack.
 *  - `getRoleTemplateUsableBy` resolves "this org's row or a LIVE catalogue
 *    row" and nothing wider — a foreign row and a DRAFT-pack row both come
 *    back null rather than 403-shaped.
 *  - The new shift columns default to (WALL_CLOCK, 0, NULL), so an existing
 *    preset keeps its exact meaning with no backfill.
 *  - Deleting a pack SetNulls `packId` and leaves org forks intact — the
 *    reason the platform-row cascade has to be done in the use case, and the
 *    reason the FK cannot be Cascade.
 *
 * Harness: same pattern as volunteering-asks / event-saves — an ephemeral
 * database per suite (Testcontainers, or a throwaway database on a host
 * Postgres when TESTCONTAINERS_REUSE_DATABASE_URL is set), migrated via
 * `prisma migrate deploy`. The repo's Prisma client runs in driver-adapter
 * mode, so it MUST be constructed with PrismaPg — a bare `new PrismaClient()`
 * throws and every test silently skips. When no database is reachable,
 * setup fails and the tests skip cleanly.
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

describe("Prisma volunteering repo integration – role packs", () => {
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
      // eslint-disable-next-line no-console
      console.error("[volunteering-role-packs.test] setup failed:", err);
    }
  }, 300_000);

  // Timed out like `beforeAll`: stopping a real Testcontainer routinely takes
  // longer than vitest's 10s default hook timeout, which fails the SUITE even
  // when every assertion passed. (The CI reuse path only drops a database, so
  // this only bites locally.)
  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pgContainer) await pgContainer.stop();
  }, 120_000);

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  // ── Fixture helpers ────────────────────────────────────────────────────

  async function seedOrg(db: PrismaClient, label: string) {
    const tag = randomUUID().slice(0, 8);
    return db.organization.create({
      data: {
        name: `Pack ${label} ${tag}`,
        slug: `pack-${label}-${tag}`,
        status: "ACTIVE",
      },
    });
  }

  async function seedPack(
    db: PrismaClient,
    status: "DRAFT" | "LIVE",
    name = "House show",
  ) {
    return db.volunteerPack.create({
      data: {
        key: `pack-${randomUUID().slice(0, 8)}`,
        name,
        blurb: "Roles for a living-room show",
        status,
        targetCategoryIds: [],
      },
    });
  }

  /** A catalogue row: no owning org, isPlatform true, pack-backed. */
  async function seedPlatformRole(
    db: PrismaClient,
    packId: string,
    name: string,
  ) {
    return db.volunteerRoleTemplate.create({
      data: { orgId: null, isPlatform: true, packId, name },
    });
  }

  async function seedOrgRole(db: PrismaClient, orgId: string, name: string) {
    return db.volunteerRoleTemplate.create({
      data: { orgId, isPlatform: false, name },
    });
  }

  // ── FR-003: the partial unique index ───────────────────────────────────

  test("role names are unique PER PACK, not per catalogue", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const packA = await seedPack(db, "LIVE", "House show");
    const packB = await seedPack(db, "LIVE", "Club night");
    const name = `Door ${randomUUID().slice(0, 8)}`;

    // One pack cannot list the same role twice.
    await seedPlatformRole(db, packA.id, name);
    await expect(seedPlatformRole(db, packA.id, name)).rejects.toMatchObject({
      code: "P2002",
    });

    // ...but a DIFFERENT pack listing the same role is allowed, and is what
    // FR-018's launch catalogue actually requires — "Sound" belongs to both
    // the house-show and DIY packs, "Merch" to both DIY and club-night. An
    // index on ("name") WHERE "orgId" IS NULL would make that unseedable.
    await expect(seedPlatformRole(db, packB.id, name)).resolves.toMatchObject({
      name,
      packId: packB.id,
    });

    // ...and the same name is still free for EVERY org, because the index is
    // partial (WHERE "orgId" IS NULL) and the org unique is (orgId, name).
    const orgA = await seedOrg(db, "a");
    const orgB = await seedOrg(db, "b");
    await expect(seedOrgRole(db, orgA.id, name)).resolves.toMatchObject({
      name,
    });
    await expect(seedOrgRole(db, orgB.id, name)).resolves.toMatchObject({
      name,
    });
  }, 60_000);

  test("a platform row cannot exist without a pack (CHECK constraint)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;

    // Without this, a pack-less platform row would key on (NULL, name) in the
    // partial unique index — and Postgres indexes NULLs as distinct, so it
    // would escape the uniqueness rule entirely.
    await expect(
      db.volunteerRoleTemplate.create({
        data: {
          orgId: null,
          isPlatform: true,
          packId: null,
          name: `Loose ${randomUUID().slice(0, 8)}`,
        },
      }),
    ).rejects.toThrow(/VolunteerRoleTemplate_platform_pack_check/);
  }, 60_000);

  // ── Constraint → domain-error translation ──────────────────────────────

  test("a duplicate pack key surfaces as a real AppError, not a bare object", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const key = `pack-${randomUUID().slice(0, 8)}`;

    await repo.createPack({ key, name: "House show" });
    const error = await repo
      .createPack({ key, name: "House show again" })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toMatchObject({ code: "VOLUNTEER_PACK_KEY_TAKEN" });
    // `instanceof Error` is the point of the change: a bare object literal
    // reaches Sentry with no stack at all.
    expect(error).toBeInstanceOf(Error);
    expect((error as { cause?: unknown }).cause).toMatchObject({
      code: "P2002",
    });
  }, 60_000);

  test("a concurrent staff upsert of the same catalogue role name maps to TEMPLATE_NAME_TAKEN", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const pack = await seedPack(db, "DRAFT");
    const name = `Door ${randomUUID().slice(0, 8)}`;

    await repo.createPlatformRoleTemplate({ packId: pack.id, name });

    // `upsertVolunteerPack` reconciles by name against a read taken earlier in
    // the transaction, so two staff saving the same pack at once both decide
    // to CREATE. Untranslated, the loser's P2002 on
    // `VolunteerRoleTemplate_platform_pack_name_key` surfaced as an opaque 500.
    const error = await repo
      .createPlatformRoleTemplate({ packId: pack.id, name })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
    expect(error).toBeInstanceOf(Error);
    expect((error as { cause?: unknown }).cause).toMatchObject({
      code: "P2002",
    });
  }, 60_000);

  test("an org-side name race on createRoleTemplate maps to TEMPLATE_NAME_TAKEN", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const org = await seedOrg(db, "race");
    const name = `Door ${randomUUID().slice(0, 8)}`;

    await repo.createRoleTemplate({ orgId: org.id, name });

    // The reachable race: org admin A clicks "Customise" on the catalogue's
    // "Door" (the fork writes through THIS method) while admin B saves a
    // hand-made "Door" in another tab. Both in-transaction name prechecks pass
    // and the loser violates @@unique([orgId, name]). Untranslated it escaped
    // as an opaque 500 instead of the CONFLICT the UI recovers from with its
    // rename dialog. `@@unique([orgId, name])` is the only unique reachable
    // here — the id is a fresh uuid and the catalogue's partial index is
    // WHERE "orgId" IS NULL — so the mapping is precise.
    const error = await repo.createRoleTemplate({ orgId: org.id, name }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
    expect(error).toBeInstanceOf(Error);
    expect((error as { cause?: unknown }).cause).toMatchObject({
      code: "P2002",
    });
  }, 60_000);

  // ── FR-009 / NFR-002: the org-scoped list ──────────────────────────────

  test("listRoleTemplates returns org rows + LIVE platform rows, and zero foreign rows", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);

    const orgA = await seedOrg(db, "a");
    const orgB = await seedOrg(db, "b");
    const livePack = await seedPack(db, "LIVE");
    const draftPack = await seedPack(db, "DRAFT", "Unpublished");

    const tag = randomUUID().slice(0, 8);
    const ownRole = await seedOrgRole(db, orgA.id, `A Bar ${tag}`);
    const foreignRole = await seedOrgRole(db, orgB.id, `B Bar ${tag}`);
    const liveRole = await seedPlatformRole(db, livePack.id, `Live ${tag}`);
    const draftRole = await seedPlatformRole(db, draftPack.id, `Draft ${tag}`);

    const orgOnly = await repo.listRoleTemplates(orgA.id);
    expect(orgOnly.map((t) => t.id)).toEqual([ownRole.id]);

    const withPlatform = await repo.listRoleTemplates(orgA.id, {
      includePlatform: true,
    });
    const ids = withPlatform.map((t) => t.id);
    expect(ids).toContain(ownRole.id);
    expect(ids).toContain(liveRole.id);
    // The two things that must never appear in an organizer-facing response:
    expect(ids).not.toContain(foreignRole.id);
    expect(ids).not.toContain(draftRole.id);
    expect(
      withPlatform.every((t) => t.orgId === orgA.id || t.orgId === null),
    ).toBe(true);

    // Flags travel with the rows so the UI can tag / lock them.
    expect(withPlatform.find((t) => t.id === ownRole.id)).toMatchObject({
      isPlatform: false,
      packId: null,
    });
    expect(withPlatform.find((t) => t.id === liveRole.id)).toMatchObject({
      isPlatform: true,
      orgId: null,
      packId: livePack.id,
    });

    // Org rows sort ahead of catalogue rows.
    expect(ids.indexOf(ownRole.id)).toBeLessThan(ids.indexOf(liveRole.id));
  }, 60_000);

  test("archived platform rows respect includeArchived like org rows", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const org = await seedOrg(db, "arch");
    const pack = await seedPack(db, "LIVE");
    const role = await seedPlatformRole(
      db,
      pack.id,
      `Retired ${randomUUID().slice(0, 8)}`,
    );
    await db.volunteerRoleTemplate.update({
      where: { id: role.id },
      data: { archived: true },
    });

    const active = await repo.listRoleTemplates(org.id, {
      includePlatform: true,
    });
    expect(active.map((t) => t.id)).not.toContain(role.id);

    const all = await repo.listRoleTemplates(org.id, {
      includePlatform: true,
      includeArchived: true,
    });
    expect(all.map((t) => t.id)).toContain(role.id);
  }, 60_000);

  // ── FR-010 / NFR-002: the apply-path lookup ────────────────────────────

  test("getRoleTemplateUsableBy resolves own + LIVE platform rows and nothing wider", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);

    const orgA = await seedOrg(db, "usable-a");
    const orgB = await seedOrg(db, "usable-b");
    const livePack = await seedPack(db, "LIVE");
    const draftPack = await seedPack(db, "DRAFT", "Unpublished");

    const tag = randomUUID().slice(0, 8);
    const ownRole = await seedOrgRole(db, orgA.id, `Own ${tag}`);
    const foreignRole = await seedOrgRole(db, orgB.id, `Foreign ${tag}`);
    const liveRole = await seedPlatformRole(db, livePack.id, `Live ${tag}`);
    const draftRole = await seedPlatformRole(db, draftPack.id, `Draft ${tag}`);

    await expect(
      repo.getRoleTemplateUsableBy(ownRole.id, orgA.id),
    ).resolves.toMatchObject({ id: ownRole.id });
    await expect(
      repo.getRoleTemplateUsableBy(liveRole.id, orgA.id),
    ).resolves.toMatchObject({ id: liveRole.id, isPlatform: true });

    // Another org's row and an unpublished catalogue row are simply absent —
    // the caller 404s without confirming they exist.
    await expect(
      repo.getRoleTemplateUsableBy(foreignRole.id, orgA.id),
    ).resolves.toBeNull();
    await expect(
      repo.getRoleTemplateUsableBy(draftRole.id, orgA.id),
    ).resolves.toBeNull();

    // A null tenant (an ask with no owning org) sees the LIVE catalogue only,
    // never "any row".
    await expect(
      repo.getRoleTemplateUsableBy(liveRole.id, null),
    ).resolves.toMatchObject({ id: liveRole.id });
    await expect(
      repo.getRoleTemplateUsableBy(ownRole.id, null),
    ).resolves.toBeNull();
  }, 60_000);

  // ── FR-004: the new shift columns ──────────────────────────────────────

  test("shift presets default to WALL_CLOCK / 0 / null — no backfill needed", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const org = await seedOrg(db, "shifts");
    const template = await seedOrgRole(
      db,
      org.id,
      `Setup ${randomUUID().slice(0, 8)}`,
    );

    // Written the way the pre-anchor editor writes: no anchor fields at all.
    const [shift] = await repo.upsertRoleTemplateShifts(template.id, [
      { label: "Load-in", startMinuteOfDay: 960, endMinuteOfDay: 1110 },
    ]);
    expect(shift).toMatchObject({
      startMinuteOfDay: 960,
      endMinuteOfDay: 1110,
      anchor: "WALL_CLOCK",
      offsetMinutes: 0,
      notes: null,
    });

    // ...and the columns round-trip when they ARE supplied (staff packs).
    const [anchored] = await repo.upsertRoleTemplateShifts(template.id, [
      {
        label: "Load-in",
        startMinuteOfDay: 960,
        endMinuteOfDay: 1110,
        anchor: "EVENT_START",
        offsetMinutes: -180,
        notes: "Meet at the loading dock",
      },
    ]);
    expect(anchored).toMatchObject({
      anchor: "EVENT_START",
      offsetMinutes: -180,
      notes: "Meet at the loading dock",
    });
  }, 60_000);

  // ── Pack deletion (FR-002 cascade decision) ────────────────────────────

  test("deleting a pack with platform roles still attached FAILS", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const pack = await seedPack(db, "LIVE");
    await seedPlatformRole(db, pack.id, `Door ${randomUUID().slice(0, 8)}`);

    // The FK is SetNull (fork-safe), so without the CHECK this would quietly
    // succeed and leave a live-but-invisible platform row behind. Instead it
    // raises, forcing the remove-pack use case to delete platform roles first
    // inside the same transaction. This is the enforceable version of that
    // requirement — the use case does not exist yet.
    await expect(
      db.volunteerPack.delete({ where: { id: pack.id } }),
    ).rejects.toThrow(/VolunteerRoleTemplate_platform_pack_check/);

    // Nothing was destroyed on the way to the failure.
    await expect(
      db.volunteerPack.findUnique({ where: { id: pack.id } }),
    ).resolves.toMatchObject({ id: pack.id });
  }, 60_000);

  test("deleting a pack SetNulls packId on org forks, which survive", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const org = await seedOrg(db, "fork");
    const pack = await seedPack(db, "LIVE");
    const tag = randomUUID().slice(0, 8);
    const platformRole = await seedPlatformRole(db, pack.id, `Door ${tag}`);
    // An org's fork keeps packId as provenance.
    const fork = await db.volunteerRoleTemplate.create({
      data: {
        orgId: org.id,
        isPlatform: false,
        packId: pack.id,
        name: `Door ${tag}`,
      },
    });

    // What remove-pack must do: platform roles first, then the pack, in one
    // transaction.
    await db.$transaction([
      db.volunteerRoleTemplate.deleteMany({
        where: { packId: pack.id, isPlatform: true },
      }),
      db.volunteerPack.delete({ where: { id: pack.id } }),
    ]);

    await expect(
      db.volunteerRoleTemplate.findUnique({ where: { id: platformRole.id } }),
    ).resolves.toBeNull();

    // The fork outlives the catalogue row it came from — this is why the FK
    // is SetNull rather than Cascade.
    const survivingFork = await db.volunteerRoleTemplate.findUnique({
      where: { id: fork.id },
    });
    expect(survivingFork).toMatchObject({ orgId: org.id, packId: null });
  }, 60_000);

  // ── Pack CRUD repo surface (FR-014 … FR-016) ───────────────────────────
  //
  // Everything above works the tables through raw Prisma. The block below
  // exercises the REPO methods the staff use cases actually call, which is
  // where an isPlatform-scoping slip would live.

  test("targetCategoryIds is NOT NULL with an empty-array default", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const pack = await repo.createPack({
      key: `notnull-${randomUUID().slice(0, 8)}`,
      name: "Probe",
    });
    expect(pack.targetCategoryIds).toEqual([]);

    // Prisma cannot express array nullability — the client types this
    // `string[]` either way — so a nullable column would be a type lie its
    // drift describer can't see. Assert the column agrees with the type.
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "VolunteerPack" SET "targetCategoryIds" = NULL WHERE "id" = $1`,
        pack.id,
      ),
    ).rejects.toThrow();
  }, 60_000);

  test("remove-pack's repo sequence deletes catalogue rows and spares forks", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const org = await seedOrg(db, "repo-fork");
    const pack = await repo.createPack({
      key: `remove-${randomUUID().slice(0, 8)}`,
      name: "DIY space",
      status: "LIVE",
    });
    const tag = randomUUID().slice(0, 8);
    const catalogueRole = await repo.createPlatformRoleTemplate({
      packId: pack.id,
      name: `Merch ${tag}`,
    });
    const fork = await repo.createRoleTemplate({
      orgId: org.id,
      name: `Merch ${tag}`,
      packId: pack.id,
    });

    // Exactly what `removeVolunteerPack` does, in one transaction.
    await db.$transaction(async (tx) => {
      const txRepo = makeVolunteeringRepo(tx as unknown as PrismaClient);
      expect(await txRepo.deletePlatformRoleTemplatesByPack(pack.id)).toBe(1);
      expect(await txRepo.countPlatformRoleTemplatesByPack(pack.id)).toBe(0);
      await txRepo.deletePack(pack.id);
    });

    expect(await repo.getPack(pack.id)).toBeNull();
    expect(await repo.getRoleTemplate(catalogueRole.id)).toBeNull();
    expect(await repo.getRoleTemplate(fork.id)).toMatchObject({
      orgId: org.id,
      isPlatform: false,
      packId: null,
    });
  }, 60_000);

  test("deletePlatformRoleTemplates never touches an org row", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const org = await seedOrg(db, "delete-guard");
    const orgRole = await seedOrgRole(
      db,
      org.id,
      `Bar ${randomUUID().slice(0, 8)}`,
    );

    // The where clause pins isPlatform, so an org row's id is a no-op rather
    // than data loss — the property that makes the staff editor's role diff
    // safe to run against ids it did not itself vet.
    expect(await repo.deletePlatformRoleTemplates([orgRole.id])).toBe(0);
    expect(await repo.getRoleTemplate(orgRole.id)).not.toBeNull();
  }, 60_000);

  test("listLivePacksWithRoles returns catalogue rows only, never org forks", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const org = await seedOrg(db, "picker");
    const live = await repo.createPack({
      key: `picker-${randomUUID().slice(0, 8)}`,
      name: "Picker pack",
      status: "LIVE",
    });
    const draft = await repo.createPack({
      key: `hidden-${randomUUID().slice(0, 8)}`,
      name: "Unfinished",
      status: "DRAFT",
    });
    const tag = randomUUID().slice(0, 8);
    await repo.createPlatformRoleTemplate({
      packId: live.id,
      name: `Sound ${tag}`,
    });
    await repo.createPlatformRoleTemplate({
      packId: draft.id,
      name: `Secret ${tag}`,
    });
    // An org fork carries the same packId; it must not reach anyone's picker.
    await repo.createRoleTemplate({
      orgId: org.id,
      name: `Sound ${tag}`,
      packId: live.id,
    });

    const packs = await repo.listLivePacksWithRoles();
    const picker = packs.find((row) => row.id === live.id);
    expect(picker).toBeDefined();
    expect(picker!.roles).toHaveLength(1);
    expect(picker!.roles[0]).toMatchObject({ isPlatform: true, orgId: null });
    // DRAFT packs are unreachable through this read entirely.
    expect(packs.some((row) => row.id === draft.id)).toBe(false);
  }, 60_000);

  test("listPacks counts catalogue roles and org forks separately", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const org = await seedOrg(db, "counts");
    const pack = await repo.createPack({
      key: `counted-${randomUUID().slice(0, 8)}`,
      name: "Counted",
    });
    const tag = randomUUID().slice(0, 8);
    await repo.createPlatformRoleTemplate({
      packId: pack.id,
      name: `A ${tag}`,
    });
    await repo.createPlatformRoleTemplate({
      packId: pack.id,
      name: `B ${tag}`,
    });
    await repo.createRoleTemplate({
      orgId: org.id,
      name: `A ${tag}`,
      packId: pack.id,
    });

    const packs = await repo.listPacks();
    expect(packs.find((row) => row.id === pack.id)).toMatchObject({
      roleCount: 2,
      forkCount: 1,
    });

    // The staff list is status-blind by default; a LIVE filter narrows it.
    const liveOnly = await repo.listPacks({ status: "LIVE" });
    expect(liveOnly.some((row) => row.id === pack.id)).toBe(false);
  }, 60_000);

  test("getPackWithRoles is status-blind (the staff preview, FR-016)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const pack = await repo.createPack({
      key: `preview-${randomUUID().slice(0, 8)}`,
      name: "Unpublished",
    });
    await repo.createPlatformRoleTemplate({
      packId: pack.id,
      name: `Usher ${randomUUID().slice(0, 8)}`,
    });

    const previewed = await repo.getPackWithRoles(pack.id);
    expect(previewed).toMatchObject({ status: "DRAFT" });
    expect(previewed!.roles).toHaveLength(1);
  }, 60_000);

  test("shift presets round-trip anchor, offsetMinutes and notes (FR-005)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const db = prisma;
    const repo = makeVolunteeringRepo(db);
    const org = await seedOrg(db, "anchored");
    const template = await repo.createRoleTemplate({
      orgId: org.id,
      name: `Anchored ${randomUUID().slice(0, 8)}`,
    });

    await repo.upsertRoleTemplateShifts(template.id, [
      {
        label: "Load-in",
        startMinuteOfDay: 16 * 60,
        endMinuteOfDay: 18 * 60 + 30,
        anchor: "EVENT_START",
        offsetMinutes: -180,
        notes: "Meet at the loading dock",
      },
    ]);

    // The whole point of extending the draft schema: a replace-set write must
    // persist these, not reset them to the column defaults.
    const [stored] = await repo.listRoleTemplateShifts(template.id);
    expect(stored).toMatchObject({
      anchor: "EVENT_START",
      offsetMinutes: -180,
      notes: "Meet at the loading dock",
    });

    // …and a draft that omits them still writes a plain wall-clock preset.
    await repo.upsertRoleTemplateShifts(template.id, [
      { label: "Plain", startMinuteOfDay: 600, endMinuteOfDay: 720 },
    ]);
    const [plain] = await repo.listRoleTemplateShifts(template.id);
    expect(plain).toMatchObject({
      anchor: "WALL_CLOCK",
      offsetMinutes: 0,
      notes: null,
    });
  }, 60_000);
});
