/**
 * Launch volunteer-role catalogue (FR-018,
 * docs/specs/2026-07-27/volunteer-role-packs.spec.yaml).
 *
 * Two things are under test and neither needs a database:
 *
 *  1. The CONTENT is the deliverable, so it is asserted like code — role
 *     counts, the deliberate cross-pack name reuse, and (most importantly) the
 *     absence of the two stored shift shapes that load into the editor but
 *     cannot be re-saved.
 *  2. `ensureVolunteerPacks` is idempotent against an in-memory Prisma double:
 *     the second run must UPDATE, never duplicate, and must not re-publish a
 *     pack staff deliberately unpublished.
 */
import { describe, expect, it } from "vitest";

import {
  LAUNCH_VOLUNTEER_PACKS,
  encodeVolunteerPackRoles,
  ensureVolunteerPacks,
} from "../src/scripts/seed/volunteer-packs";

const MINUTES_PER_DAY = 24 * 60;

/**
 * Local copy of `templateShiftDurationMinutes`
 * (apps/web/src/lib/template-shift-offset.ts) — the reader that decides how
 * long a seeded preset actually runs. Duplicated rather than imported because
 * apps/api's vitest config aliases packages/*, not apps/web.
 */
function decodeDuration(shift: {
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  endsNextDay: boolean;
}): number {
  let duration =
    shift.endMinuteOfDay -
    shift.startMinuteOfDay +
    (shift.endsNextDay ? MINUTES_PER_DAY : 0);
  if (duration <= 0) duration += MINUTES_PER_DAY;
  return duration;
}

const packByKey = (key: string) => {
  const pack = LAUNCH_VOLUNTEER_PACKS.find((p) => p.key === key);
  if (!pack) throw new Error(`missing pack ${key}`);
  return pack;
};

describe("launch volunteer-pack catalogue (FR-018)", () => {
  it("ships the five packs with the role counts the spec names", () => {
    expect(LAUNCH_VOLUNTEER_PACKS.map((p) => p.key)).toEqual([
      "house-show",
      "diy-all-ages",
      "performing-arts",
      "club-night",
      "standing-crew",
    ]);

    expect(
      Object.fromEntries(
        LAUNCH_VOLUNTEER_PACKS.map((p) => [p.key, p.roles.length]),
      ),
    ).toEqual({
      "house-show": 6,
      "diy-all-ages": 9,
      "performing-arts": 9,
      "club-night": 8,
      "standing-crew": 9,
    });
  });

  it("every pack validates against the staff editor's own schema", () => {
    // `encodeVolunteerPackRoles` parses with `volunteerPackRoleInputSchema`,
    // which nests `roleTemplateShiftDraftSchema`. If a seeded preset were a
    // shape the staff editor cannot produce, this throws.
    for (const pack of LAUNCH_VOLUNTEER_PACKS) {
      expect(() => encodeVolunteerPackRoles(pack)).not.toThrow();
    }
  });

  it("reuses role names ACROSS packs, which the per-pack index allows", () => {
    // The FR-003 index is ("packId", "name") WHERE "orgId" IS NULL. An earlier
    // catalogue-GLOBAL index would have made this catalogue unseedable.
    const packsWith = (role: string) =>
      LAUNCH_VOLUNTEER_PACKS.filter((p) =>
        p.roles.some((r) => r.name === role),
      ).map((p) => p.key);

    expect(packsWith("Sound")).toEqual(["house-show", "diy-all-ages"]);
    expect(packsWith("Merch")).toEqual(["diy-all-ages", "club-night"]);
  });

  it("never lists the same role twice within one pack", () => {
    for (const pack of LAUNCH_VOLUNTEER_PACKS) {
      const names = pack.roles.map((r) => r.name.trim().toLowerCase());
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("leaves the standing-crew pack completely shift-free", () => {
    // Shift occurrences for standing asks are the unbuilt 2026-07-07 spec;
    // seeding presets here would collide with it.
    for (const role of packByKey("standing-crew").roles) {
      expect(role.shifts).toBeUndefined();
    }
  });

  it("anchors every seeded shift — no wall-clock catalogue times", () => {
    // A wall-clock preset is the exact bug the anchor work fixes: "load-in
    // 16:00" is two hours after the show on a 14:00 matinee.
    const anchors = LAUNCH_VOLUNTEER_PACKS.flatMap((p) =>
      encodeVolunteerPackRoles(p).flatMap(({ shifts }) =>
        shifts.map((s) => s.anchor),
      ),
    );
    expect(anchors.length).toBeGreaterThan(0);
    expect([...new Set(anchors)].sort()).toEqual(["EVENT_END", "EVENT_START"]);
  });

  it("avoids both unsaveable stored shift shapes", () => {
    for (const pack of LAUNCH_VOLUNTEER_PACKS) {
      for (const { shifts } of encodeVolunteerPackRoles(pack)) {
        for (const shift of shifts) {
          // `start === end` loads but `parseShiftDraftFields` rejects it as
          // `ends_equal_start`, so the organizer can never re-save the role.
          expect(shift.startMinuteOfDay).not.toBe(shift.endMinuteOfDay);
          // `endsNextDay && end > start` is rejected by
          // `roleTemplateShiftDraftSchema` — the flag is derived, never
          // round-tripped.
          if (shift.endsNextDay) {
            expect(shift.endMinuteOfDay).toBeLessThanOrEqual(
              shift.startMinuteOfDay,
            );
          }
          expect(shift.startMinuteOfDay).toBeGreaterThanOrEqual(0);
          expect(shift.startMinuteOfDay).toBeLessThan(MINUTES_PER_DAY);
          expect(shift.endMinuteOfDay).toBeGreaterThanOrEqual(0);
          expect(shift.endMinuteOfDay).toBeLessThan(MINUTES_PER_DAY);
          expect(Math.abs(shift.offsetMinutes)).toBeLessThanOrEqual(
            MINUTES_PER_DAY,
          );
        }
      }
    }
  });

  it("encodes the intended duration into the two minute columns", () => {
    // On an anchored preset the minute columns carry only the LENGTH; the
    // anchor + offset place the start. Round-trip every seeded row through the
    // reader that resolution actually uses.
    for (const pack of LAUNCH_VOLUNTEER_PACKS) {
      const encoded = encodeVolunteerPackRoles(pack);
      pack.roles.forEach((role, index) => {
        (role.shifts ?? []).forEach((declared, position) => {
          const stored = encoded[index]!.shifts[position]!;
          expect(decodeDuration(stored)).toBe(declared.durationMinutes);
        });
      });
    }
  });

  it("times the marquee presets the way the spec describes them", () => {
    const shiftOf = (packKey: string, roleName: string) => {
      const pack = packByKey(packKey);
      const index = pack.roles.findIndex((r) => r.name === roleName);
      expect(index).toBeGreaterThanOrEqual(0);
      return encodeVolunteerPackRoles(pack)[index]!.shifts[0]!;
    };

    // "Sound — EVENT_START −2h → EVENT_END" on a nominal 3h house show:
    // starts two hours early and runs 2h + 3h.
    const houseSound = shiftOf("house-show", "Sound");
    expect(houseSound.anchor).toBe("EVENT_START");
    expect(houseSound.offsetMinutes).toBe(-120);
    expect(decodeDuration(houseSound)).toBe(120 + 180);

    // "Reset the room — EVENT_END, 1h long".
    const reset = shiftOf("house-show", "Reset the room");
    expect(reset.anchor).toBe("EVENT_END");
    expect(reset.offsetMinutes).toBe(0);
    expect(decodeDuration(reset)).toBe(60);

    // "Load-out anchors EVENT_END and runs 2h" — named explicitly by FR-018.
    const loadOut = shiftOf("club-night", "Load-out");
    expect(loadOut.anchor).toBe("EVENT_END");
    expect(loadOut.offsetMinutes).toBe(0);
    expect(decodeDuration(loadOut)).toBe(120);

    // Intermission crew sits MID-show: half a nominal 2h30 running time in.
    const interval = shiftOf("performing-arts", "Intermission crew");
    expect(interval.anchor).toBe("EVENT_START");
    expect(interval.offsetMinutes).toBe(75);
    expect(decodeDuration(interval)).toBe(45);
  });
});

describe("catalogue shift timings that a review caught", () => {
  const shiftOf = (packKey: string, roleName: string) => {
    const pack = packByKey(packKey);
    const index = pack.roles.findIndex((r) => r.name === roleName);
    expect(index).toBeGreaterThanOrEqual(0);
    return encodeVolunteerPackRoles(pack)[index]!.shifts[0]!;
  };

  it("keeps the club-night green room host on until the show ends", () => {
    // `-120 / CLUB_NIGHT_MINUTES` clocked hospitality OFF two hours before the
    // last set. Artist hospitality is the last job to finish, not the first.
    const hospitality = shiftOf("club-night", "Green room host");
    expect(hospitality.anchor).toBe("EVENT_START");
    expect(hospitality.offsetMinutes).toBe(-120);
    expect(decodeDuration(hospitality)).toBe(120 + 4 * 60);

    // It now matches the other pre-doors club-night roles exactly.
    for (const role of ["Stage hand", "Sound assist"]) {
      const other = shiftOf("club-night", role);
      expect(other.offsetMinutes).toBe(hospitality.offsetMinutes);
      expect(decodeDuration(other)).toBe(decodeDuration(hospitality));
    }
  });

  it("opens the house-show door shift BEFORE the show, like the DIY one", () => {
    // "Doors to close" at offset 0 started AT the show, missing the arrivals
    // the role exists for.
    const houseDoor = shiftOf("house-show", "Door & donations");
    const diyDoor = shiftOf("diy-all-ages", "Door & cover");
    expect(houseDoor.offsetMinutes).toBe(-30);
    expect(houseDoor.offsetMinutes).toBe(diyDoor.offsetMinutes);
    // …and still runs through to close: 30m of doors + the nominal 3h show.
    expect(decodeDuration(houseDoor)).toBe(30 + 3 * 60);
  });

  it("warns the organiser that the interval preset assumes a 2h30 running time", () => {
    // The only preset positioned by a show's INTERIOR rather than an edge, so
    // it degrades worst when the real running time differs.
    const interval = shiftOf("performing-arts", "Intermission crew");
    expect(interval.notes).toMatch(/2h30/);
    expect(interval.notes).toMatch(/interval/i);
  });

  it("frames the open-mic host as a standing commitment", () => {
    // The one role in the deliberately shift-free standing-crew pack that is
    // performed AT an event, so an organiser would otherwise expect a shift.
    const role = packByKey("standing-crew").roles.find(
      (r) => r.name === "Open-mic host",
    )!;
    expect(role.shifts).toBeUndefined();
    expect(role.description).toMatch(/recurring|ongoing/i);
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

type PackRow = {
  id: string;
  key: string;
  name: string;
  blurb: string | null;
  status: string;
  targetCategoryIds: string[];
  rankFirst: boolean;
  sortOrder: number;
};
type TemplateRow = {
  id: string;
  orgId: string | null;
  isPlatform: boolean;
  packId: string | null;
  name: string;
  description: string | null;
  defaultCapacity: number | null;
  sortOrder: number;
  archived: boolean;
};
type ShiftRow = {
  id: string;
  templateId: string;
  label: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  startDayOffset: number;
  endsNextDay: boolean;
  capacity: number | null;
  position: number;
  anchor: string;
  offsetMinutes: number;
  notes: string | null;
};
type AuditRow = {
  entity: string;
  entityId: string | null;
  action: string;
  data: Record<string, unknown>;
};

/**
 * In-memory Prisma double covering exactly the surface `ensureVolunteerPacks`
 * touches. Enough to prove the properties FR-018 actually asks for — a re-run
 * updates rather than duplicating, and (post-review) an install-only re-run
 * does not touch staff-authored content at all — without a database.
 */
function makeFakePrisma(initialCategorySlugs: string[] = []) {
  const categorySlugs = [...initialCategorySlugs];
  const packs: PackRow[] = [];
  const templates: TemplateRow[] = [];
  const shifts: ShiftRow[] = [];
  const auditLogs: AuditRow[] = [];
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;

  const counts = {
    packCreates: 0,
    packUpdates: 0,
    roleCreates: 0,
    roleUpdates: 0,
    shiftCreates: 0,
    shiftUpdates: 0,
  };

  const prisma = {
    // Array form only — that is all the seed uses, and every op in the array
    // is a real (already-issued) fake promise.
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    category: {
      findMany: async ({ where }: any) =>
        categorySlugs
          .filter((slug) => where.slug.in.includes(slug))
          .map((slug) => ({ id: `cat-${slug}`, slug })),
    },
    auditLog: {
      create: async ({ data }: any) => {
        auditLogs.push(data as AuditRow);
        return data;
      },
    },
    volunteerPack: {
      findUnique: async ({ where }: any) => {
        const found = packs.find((p) => p.key === where.key);
        return found
          ? {
              id: found.id,
              name: found.name,
              blurb: found.blurb,
              targetCategoryIds: found.targetCategoryIds,
            }
          : null;
      },
      create: async ({ data }: any) => {
        const row: PackRow = { id: id("pack"), ...data };
        packs.push(row);
        counts.packCreates += 1;
        return { id: row.id };
      },
      update: async ({ where, data }: any) => {
        const row = packs.find((p) => p.id === where.id);
        if (!row) throw new Error("pack not found");
        Object.assign(row, data);
        counts.packUpdates += 1;
        return { id: row.id };
      },
    },
    volunteerRoleTemplate: {
      findMany: async ({ where }: any) =>
        templates
          .filter(
            (t) =>
              t.packId === where.packId && t.isPlatform === where.isPlatform,
          )
          .map((t) => ({ ...t })),
      create: async ({ data }: any) => {
        const row: TemplateRow = { id: id("tpl"), archived: false, ...data };
        templates.push(row);
        counts.roleCreates += 1;
        return { id: row.id };
      },
      update: async ({ where, data }: any) => {
        const row = templates.find((t) => t.id === where.id);
        if (!row) throw new Error("template not found");
        Object.assign(row, data);
        counts.roleUpdates += 1;
        return { id: row.id };
      },
      deleteMany: async ({ where }: any) => {
        const doomed = templates.filter(
          (t) =>
            where.id.in.includes(t.id) && t.isPlatform === where.isPlatform,
        );
        for (const t of doomed) {
          templates.splice(templates.indexOf(t), 1);
          // Cascade, same as the FK.
          for (const s of shifts.filter((x) => x.templateId === t.id)) {
            shifts.splice(shifts.indexOf(s), 1);
          }
        }
        return { count: doomed.length };
      },
    },
    volunteerRoleTemplateShift: {
      findMany: async ({ where }: any) =>
        shifts
          .filter((s) =>
            where.templateId?.in
              ? where.templateId.in.includes(s.templateId)
              : s.templateId === where.templateId,
          )
          .map((s) => ({ ...s })),
      create: async ({ data }: any) => {
        const row: ShiftRow = { id: id("shift"), ...data };
        shifts.push(row);
        counts.shiftCreates += 1;
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = shifts.find((s) => s.id === where.id);
        if (!row) throw new Error("shift not found");
        Object.assign(row, data);
        counts.shiftUpdates += 1;
        return row;
      },
      deleteMany: async ({ where }: any) => {
        const doomed = shifts.filter((s) => where.id.in.includes(s.id));
        for (const s of doomed) shifts.splice(shifts.indexOf(s), 1);
        return { count: doomed.length };
      },
    },
  };

  return {
    prisma: prisma as any,
    packs,
    templates,
    shifts,
    auditLogs,
    counts,
    categorySlugs,
  };
}

const ALL_SLUGS = ["music", "community", "arts", "nightlife"];

/** Fully seed a database the way `pnpm seed:dev` does. */
async function seedFresh(slugs: string[] = ALL_SLUGS) {
  const f = makeFakePrisma(slugs);
  const first = await ensureVolunteerPacks(f.prisma, {
    refresh: true,
    prune: true,
  });
  f.auditLogs.length = 0;
  return { f, first };
}

describe("ensureVolunteerPacks", () => {
  it("is re-runnable: a second seed updates in place and duplicates nothing", async () => {
    const f = makeFakePrisma(ALL_SLUGS);

    const first = await ensureVolunteerPacks(f.prisma, {
      refresh: true,
      prune: true,
    });
    const packsAfterFirst = f.packs.length;
    const templatesAfterFirst = f.templates.map((t) => t.id).sort();
    const shiftsAfterFirst = f.shifts.map((s) => s.id).sort();

    expect(first).toMatchObject({
      packCount: 5,
      roleCount: 41, // 6 + 9 + 9 + 8 + 9
      createdPacks: 5,
      createdRoles: 41,
      removedRoles: 0,
    });

    const second = await ensureVolunteerPacks(f.prisma, {
      refresh: true,
      prune: true,
    });

    expect(f.packs.length).toBe(packsAfterFirst);
    // Row IDENTITY survives, not just the count: `EventVolunteerRole.templateId`
    // points at these rows and FR-011's shadowing matches on (packId, name).
    expect(f.templates.map((t) => t.id).sort()).toEqual(templatesAfterFirst);
    expect(f.shifts.map((s) => s.id).sort()).toEqual(shiftsAfterFirst);
    // A CONVERGED re-seed writes nothing at all — not even a no-op UPDATE.
    // That is what makes "the seed changed something" a signal worth auditing.
    expect(second).toMatchObject({
      createdPacks: 0,
      createdRoles: 0,
      createdShifts: 0,
      updatedPacks: 0,
      updatedRoles: 0,
      updatedShifts: 0,
      removedRoles: 0,
      removedShifts: 0,
    });
    expect(f.counts.packCreates).toBe(5);
    expect(f.counts.roleCreates).toBe(41);
    expect(f.counts.packUpdates).toBe(0);
    expect(f.counts.roleUpdates).toBe(0);
    expect(f.counts.shiftUpdates).toBe(0);
  });

  it("creates every pack LIVE and never re-publishes one staff unpublished", async () => {
    const { f } = await seedFresh();
    expect(f.packs.every((p) => p.status === "LIVE")).toBe(true);

    // Staff pull a pack (the separately-audited `setVolunteerPackStatus`).
    const pulled = f.packs.find((p) => p.key === "club-night")!;
    pulled.status = "DRAFT";
    pulled.sortOrder = 99;
    pulled.rankFirst = true;

    // Even the most aggressive mode leaves curation alone.
    await ensureVolunteerPacks(f.prisma, { refresh: true, prune: true });

    expect(pulled.status).toBe("DRAFT");
    expect(pulled.sortOrder).toBe(99);
    expect(pulled.rankFirst).toBe(true);
    expect(pulled.name).toBe("Club night");
  });

  it("resolves targeting by slug and skips categories that do not exist", async () => {
    // Only "music" exists — the rest degrade the ranking hint rather than
    // failing the seed.
    const { f } = await seedFresh(["music"]);

    expect(
      f.packs.find((p) => p.key === "house-show")!.targetCategoryIds,
    ).toEqual(["cat-music"]);
    expect(
      f.packs.find((p) => p.key === "performing-arts")!.targetCategoryIds,
    ).toEqual([]);
    expect(
      f.packs.find((p) => p.key === "standing-crew")!.targetCategoryIds,
    ).toEqual([]);
  });

  it("backfills empty targeting later — in install-only mode too — but never overwrites a staff choice", async () => {
    // Packs inserted before the category taxonomy existed (a bootstrap that
    // ran the two seed scripts the other way round) would otherwise stay
    // untargeted forever with no way to repair them. Filling an ABSENT value
    // is a repair, not an overwrite, so it is the one write install-only makes
    // to an existing row.
    const { f } = await seedFresh([]);
    expect(
      f.packs.find((p) => p.key === "performing-arts")!.targetCategoryIds,
    ).toEqual([]);

    // Categories arrive; staff have separately re-targeted one pack by hand.
    f.categorySlugs.push(...ALL_SLUGS);
    const houseShow = f.packs.find((p) => p.key === "house-show")!;
    houseShow.targetCategoryIds = ["cat-hand-picked"];

    await ensureVolunteerPacks(f.prisma); // install-only

    expect(
      f.packs.find((p) => p.key === "performing-arts")!.targetCategoryIds,
    ).toEqual(["cat-arts"]);
    expect(houseShow.targetCategoryIds).toEqual(["cat-hand-picked"]);
    // …and it is audited, not silent.
    expect(
      f.auditLogs.filter(
        (a) =>
          a.action === "volunteer_pack.seed_installed" &&
          a.data.targetingBackfilled === true,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("writes catalogue rows as orgId=null + isPlatform + packId", async () => {
    const { f } = await seedFresh([]);

    for (const row of f.templates) {
      expect(row.orgId).toBeNull();
      expect(row.isPlatform).toBe(true);
      // The DB CHECK `VolunteerRoleTemplate_platform_pack_check` requires this.
      expect(row.packId).toBeTruthy();
    }
  });
});

// ── The deploy must not destroy staff-authored catalogue content ─────────────

describe("ensureVolunteerPacks — install-only default (the deploy path)", () => {
  /**
   * The traced review scenario, end to end: staff add a role and fix a typo at
   * /platform/volunteer-packs, then an UNRELATED deploy runs the seed.
   */
  async function withStaffEdits() {
    const { f } = await seedFresh();

    const barBack = f.templates.find((t) => t.name === "Bar back")!;
    const clubPackId = barBack.packId!;

    // 1. Staff fix a typo in an existing catalogue role's description.
    barBack.description = "Keeps ice, glassware and stock moving to the bar.";

    // 2. Staff add a brand-new role with a shift preset.
    f.templates.push({
      id: "tpl-coat-check",
      orgId: null,
      isPlatform: true,
      packId: clubPackId,
      name: "Coat check",
      description: "Tags coats and returns them at the end of the night.",
      defaultCapacity: 1,
      sortOrder: 99,
      archived: false,
    });
    f.shifts.push({
      id: "shift-coat-check",
      templateId: "tpl-coat-check",
      label: "Coat check",
      startMinuteOfDay: 720,
      endMinuteOfDay: 990,
      startDayOffset: 0,
      endsNextDay: false,
      capacity: null,
      position: 0,
      anchor: "EVENT_START",
      offsetMinutes: -30,
      notes: null,
    });

    return { f, barBack, clubPackId };
  }

  it("SURVIVES an unrelated deploy: the staff role and the staff typo fix are both intact", async () => {
    const { f, barBack } = await withStaffEdits();

    // Exactly what `deploy-prod.yml` runs: no --refresh, no --prune.
    const result = await ensureVolunteerPacks(f.prisma);

    expect(f.templates.find((t) => t.id === "tpl-coat-check")).toBeDefined();
    expect(f.shifts.find((s) => s.id === "shift-coat-check")).toBeDefined();
    expect(barBack.description).toBe(
      "Keeps ice, glassware and stock moving to the bar.",
    );
    expect(result.removedRoles).toBe(0);
    expect(result.updatedRoles).toBe(0);
    // The seed still knows the row is unaccounted for — it just refuses to act.
    expect(result.withheldRoleDeletes).toBe(1);
    // And a no-op run leaves no audit noise.
    expect(f.auditLogs).toEqual([]);
  });

  it("is idempotent across many install-only runs", async () => {
    const { f } = await withStaffEdits();
    const before = f.templates.map((t) => t.id).sort();

    for (let i = 0; i < 3; i += 1) await ensureVolunteerPacks(f.prisma);

    expect(f.templates.map((t) => t.id).sort()).toEqual(before);
    expect(f.auditLogs).toEqual([]);
  });

  it("still installs a pack or role the git baseline added later", async () => {
    const { f } = await seedFresh();
    // Simulate a role that never made it into this environment.
    const doomed = f.templates.find((t) => t.name === "Load-out")!;
    f.templates.splice(f.templates.indexOf(doomed), 1);
    f.shifts
      .filter((s) => s.templateId === doomed.id)
      .forEach((s) => f.shifts.splice(f.shifts.indexOf(s), 1));

    const result = await ensureVolunteerPacks(f.prisma);

    expect(result.createdRoles).toBe(1);
    expect(f.templates.some((t) => t.name === "Load-out")).toBe(true);
    // Additive changes ARE audited, so a resurrection is never invisible.
    const installed = f.auditLogs.filter(
      (a) => a.action === "volunteer_pack.seed_installed",
    );
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      entity: "volunteer_pack",
      action: "volunteer_pack.seed_installed",
    });
    expect(installed[0]!.data).toMatchObject({
      key: "club-night",
      createdRoles: ["Load-out"],
    });
  });

  it("does not overwrite a staff edit even when the git content differs", async () => {
    const { f, barBack } = await withStaffEdits();
    await ensureVolunteerPacks(f.prisma);
    expect(f.counts.roleUpdates).toBe(0);
    expect(barBack.description).toMatch(/glassware and stock/);
  });
});

describe("ensureVolunteerPacks — opt-in prune", () => {
  it("removes the stale role and writes an AuditLog row naming it", async () => {
    const { f } = await seedFresh(["music"]);

    const housePackId = f.templates.find(
      (t) => t.name === "Door & donations",
    )!.packId!;
    // A role staff added that the reviewed baseline does not name.
    f.templates.push({
      id: "tpl-stale",
      orgId: null,
      isPlatform: true,
      packId: housePackId,
      name: "Retired role",
      description: null,
      defaultCapacity: null,
      sortOrder: 99,
      archived: false,
    });
    // An org's fork carries the SAME packId as provenance (FR-011) and must
    // survive — the delete pins `isPlatform: true` for exactly this.
    f.templates.push({
      id: "tpl-fork",
      orgId: "org-1",
      isPlatform: false,
      packId: housePackId,
      name: "Door & donations",
      description: null,
      defaultCapacity: null,
      sortOrder: 0,
      archived: false,
    });

    const result = await ensureVolunteerPacks(f.prisma, { prune: true });

    expect(result.removedRoles).toBe(1);
    expect(f.templates.find((t) => t.id === "tpl-stale")).toBeUndefined();
    expect(f.templates.find((t) => t.id === "tpl-fork")).toBeDefined();

    const pruned = f.auditLogs.filter(
      (a) => a.action === "volunteer_pack.seed_pruned",
    );
    expect(pruned).toHaveLength(1);
    expect(pruned[0]).toMatchObject({
      entity: "volunteer_pack",
      entityId: housePackId,
      action: "volunteer_pack.seed_pruned",
    });
    expect(pruned[0]!.data).toMatchObject({
      key: "house-show",
      removedNames: ["Retired role"],
    });
  });

  it("prunes a stale SHIFT preset and names it in the same audit row", async () => {
    const { f } = await seedFresh(["music"]);
    const reset = f.templates.find((t) => t.name === "Reset the room")!;
    f.shifts.push({
      id: "shift-extra",
      templateId: reset.id,
      label: "Second sweep",
      startMinuteOfDay: 720,
      endMinuteOfDay: 780,
      startDayOffset: 0,
      endsNextDay: false,
      capacity: null,
      position: 5,
      anchor: "EVENT_END",
      offsetMinutes: 60,
      notes: null,
    });

    const result = await ensureVolunteerPacks(f.prisma, { prune: true });

    expect(result.removedShifts).toBe(1);
    expect(f.shifts.find((s) => s.id === "shift-extra")).toBeUndefined();
    expect(
      f.auditLogs.find((a) => a.action === "volunteer_pack.seed_pruned")!.data,
    ).toMatchObject({ removedShiftLabels: ["Second sweep"] });
  });

  it("leaves a role's presets alone when the catalogue declares no shifts for it", async () => {
    // Standing-crew roles OMIT `shifts` — "not this catalogue's business",
    // which is not the same statement as `[]` ("it has none").
    const { f } = await seedFresh([]);
    const streetTeam = f.templates.find((t) => t.name === "Street team")!;
    f.shifts.push({
      id: "shift-standing",
      templateId: streetTeam.id,
      label: "Flyer run",
      startMinuteOfDay: 600,
      endMinuteOfDay: 720,
      startDayOffset: 0,
      endsNextDay: false,
      capacity: null,
      position: 0,
      anchor: "EVENT_START",
      offsetMinutes: 0,
      notes: null,
    });

    await ensureVolunteerPacks(f.prisma, { refresh: true, prune: true });

    expect(f.shifts.find((s) => s.id === "shift-standing")).toBeDefined();
  });
});

describe("ensureVolunteerPacks — opt-in refresh", () => {
  it("pushes the git baseline back over a hand-edited row", async () => {
    const { f } = await seedFresh();
    const barBack = f.templates.find((t) => t.name === "Bar back")!;
    barBack.description = "typo'd by hand";
    barBack.archived = true;

    const result = await ensureVolunteerPacks(f.prisma, { refresh: true });

    expect(barBack.description).toBe(
      "Keeps ice, glassware, and stock moving to the bar.",
    );
    expect(barBack.archived).toBe(false);
    expect(result.updatedRoles).toBe(1);

    const refreshed = f.auditLogs.filter(
      (a) => a.action === "volunteer_pack.seed_refreshed",
    );
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]!.data).toMatchObject({
      key: "club-night",
      updatedRoles: ["Bar back"],
    });
  });

  it("rewrites a hand-edited shift preset and audits the label", async () => {
    const { f } = await seedFresh();
    const loadOut = f.shifts.find((s) => s.label === "Load-out")!;
    loadOut.offsetMinutes = 999;

    const result = await ensureVolunteerPacks(f.prisma, { refresh: true });

    expect(loadOut.offsetMinutes).toBe(0);
    expect(result.updatedShifts).toBe(1);
    expect(
      f.auditLogs.find((a) => a.action === "volunteer_pack.seed_refreshed")!
        .data,
    ).toMatchObject({ updatedShifts: ["Load-out — Load-out"] });
  });
});

// ── Label / name collisions ──────────────────────────────────────────────────

describe("ensureVolunteerPacks — duplicate labels and names converge", () => {
  it("reconciles ONE of two identically-labelled shifts and prunes the other", async () => {
    // Nothing constrains (templateId, label): no unique index, and neither the
    // shift schema nor the staff editor rejects a duplicate label. A
    // `Map<label, id>` kept only the last row out of `findMany`, updated that
    // one, and left the other untouched AND undeleted — so it survived every
    // re-seed and showed as a doubled preset in the shift composer.
    const { f } = await seedFresh();
    const loadOut = f.shifts.find((s) => s.label === "Load-out")!;
    f.shifts.push({
      ...loadOut,
      id: "shift-dup",
      position: 7,
      offsetMinutes: 555,
    });

    const result = await ensureVolunteerPacks(f.prisma, {
      refresh: true,
      prune: true,
    });

    expect(result.removedShifts).toBe(1);
    const survivors = f.shifts.filter((s) => s.label === "Load-out");
    expect(survivors).toHaveLength(1);
    // The lower `position` wins, deterministically — not whichever row
    // `findMany` happened to return last.
    expect(survivors[0]!.id).toBe(loadOut.id);
    expect(survivors[0]!.offsetMinutes).toBe(0);
  });

  it("picks the same survivor regardless of row order", async () => {
    // The old collapse depended on `findMany` ordering, so which row survived
    // could flip between runs.
    const ids: string[] = [];
    for (const reversed of [false, true]) {
      const { f } = await seedFresh();
      const loadOut = f.shifts.find((s) => s.label === "Load-out")!;
      const dup: (typeof f.shifts)[number] = {
        ...loadOut,
        id: "shift-dup",
        position: 7,
      };
      if (reversed) f.shifts.unshift(dup);
      else f.shifts.push(dup);

      await ensureVolunteerPacks(f.prisma, { refresh: true, prune: true });
      ids.push(f.shifts.filter((s) => s.label === "Load-out")[0]!.id);
    }
    expect(ids[0]).toBe(ids[1]);
  });

  it("collapses case-folded duplicate ROLE names the same way", async () => {
    // The FR-003 partial unique index is ("packId", "name") — case-SENSITIVE —
    // so "Load-out" alongside "load-out" reaches the database.
    const { f } = await seedFresh();
    const loadOut = f.templates.find((t) => t.name === "Load-out")!;
    f.templates.push({
      ...loadOut,
      id: "tpl-dup",
      name: "load-out",
      sortOrder: 42,
    });

    const result = await ensureVolunteerPacks(f.prisma, {
      refresh: true,
      prune: true,
    });

    expect(result.removedRoles).toBe(1);
    expect(f.templates.find((t) => t.id === "tpl-dup")).toBeUndefined();
    expect(f.templates.find((t) => t.id === loadOut.id)).toBeDefined();
    expect(
      f.auditLogs.find((a) => a.action === "volunteer_pack.seed_pruned")!.data,
    ).toMatchObject({ removedNames: ["load-out"] });
  });

  it("leaves duplicates in place under install-only, and says so", async () => {
    const { f } = await seedFresh();
    const loadOut = f.shifts.find((s) => s.label === "Load-out")!;
    f.shifts.push({ ...loadOut, id: "shift-dup", position: 7 });

    const result = await ensureVolunteerPacks(f.prisma);

    expect(result.removedShifts).toBe(0);
    expect(result.withheldShiftDeletes).toBe(1);
    expect(f.shifts.find((s) => s.id === "shift-dup")).toBeDefined();
  });
});
