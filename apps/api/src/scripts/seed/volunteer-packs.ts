/**
 * volunteer-packs.ts — the launch volunteer-role catalogue (FR-018 of
 * docs/specs/2026-07-27/volunteer-role-packs.spec.yaml).
 *
 * Five platform-curated packs, seeded through the normal seed path so dev,
 * staging and prod start from the same reviewed baseline. A catalogue row is
 * an ordinary `VolunteerRoleTemplate` with `orgId = null`, `isPlatform = true`
 * and `packId` set; `VolunteerPack` carries only the metadata.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 *
 * Everything here is keyed on stable identity, never on row ids:
 *
 *   - a pack on `VolunteerPack.key` (unique);
 *   - a catalogue role on (`packId`, `name`) — exactly the identity the
 *     partial unique index `VolunteerRoleTemplate_platform_pack_name_key`
 *     enforces, and the identity an org's fork carries as provenance, so a
 *     re-seed must not churn role ids (`EventVolunteerRole.templateId` points
 *     at them, and FR-011's shadowing matches on name);
 *   - a shift preset on (`templateId`, `label`).
 *
 * ── DEFAULT MODE IS INSTALL-ONLY ───────────────────────────────────────────
 *
 * FR-018 says the catalogue is "seeded through the normal seed path so dev,
 * staging and prod start identical; DB-MANAGED FROM THEN ON", and the whole
 * premise of the feature is that staff author the catalogue at
 * `/platform/volunteer-packs` without a deploy. This script runs on EVERY
 * `deploy-prod` dispatch — including one for an unrelated web fix — so
 * anything it overwrites or deletes is staff work destroyed by a deploy that
 * had nothing to do with the catalogue.
 *
 * So the default (`{ refresh: false, prune: false }`) is INSTALL-ONLY:
 *
 *   - CREATE packs, roles and shift presets that do not exist. A fresh
 *     environment converges on the reviewed git baseline; a pack or role
 *     added to this file later still propagates.
 *   - NEVER update an existing row's content. A description a staff member
 *     fixed in prod stays fixed.
 *   - NEVER delete. A role staff added is not the seed's to remove; retiring
 *     a catalogue role is a deliberate staff action through
 *     `upsertVolunteerPack`, which is transactional and audited (FR-015).
 *   - CURATION is always the database's after the first insert: `status`,
 *     `rankFirst`, `sortOrder`, `targetCategoryIds`. Publishing is a
 *     separately-audited staff action (`setVolunteerPackStatus`, FR-015); a
 *     re-seed must not silently re-publish a pack staff deliberately pulled.
 *     `targetCategoryIds` has one exception — it is BACKFILLED when empty, so
 *     a pack inserted before the category taxonomy existed isn't stuck
 *     untargeted forever. That is a repair of an absent value, never an
 *     overwrite of a chosen one, so it runs in both modes.
 *
 * Two opt-ins widen that, and BOTH are off in `deploy-dev.yml` /
 * `deploy-prod.yml`:
 *
 *   - `refresh` — push this file's CONTENT (pack name/blurb, role name,
 *     description, capacity, sort order, un-archive; every shift field) over
 *     existing rows. This is how a typo fixed in git reaches an environment,
 *     and it is exactly what reverts staff edits, so it is a deliberate
 *     operator action: `pnpm seed:volunteer-packs -- --refresh`.
 *   - `prune` — delete catalogue rows the baseline no longer names, plus
 *     case-folded duplicate rows. Pinned to `isPlatform: true` so an org's
 *     fork is never reachable from here.
 *
 * `seed-data.ts` passes BOTH: `pnpm seed:dev` drops and recreates the schema,
 * so there is no staff work to protect and full convergence is the point.
 *
 * Residual, stated plainly: install-only cannot tell "this row was never
 * installed here" from "staff deleted it on purpose" — there is no tombstone
 * on a catalogue role. A role or preset staff deleted is therefore
 * re-created by a later install-only run. That is additive and audited
 * (`volunteer_pack.seed_installed`), not destructive, and is the milder half
 * of the trade.
 *
 * ── Audit ──────────────────────────────────────────────────────────────────
 *
 * A converged re-seed writes NOTHING — no updates, no deletes, no audit rows.
 * Anything it does change is recorded against `entity: "volunteer_pack"`
 * (FR-015), the only review trail once catalogue content lives in the
 * database:
 *
 *   - `volunteer_pack.seed_installed` — rows created (or targeting backfilled)
 *   - `volunteer_pack.seed_refreshed` — existing content overwritten
 *   - `volunteer_pack.seed_pruned`    — rows deleted, written in the SAME
 *     transaction as the delete, matching every sibling deletion path
 *     (`reconcilePackRoles`, `removeVolunteerPack`)
 *
 * All five packs are created LIVE.
 *
 * ── Shift encoding ─────────────────────────────────────────────────────────
 *
 * Every seeded preset is ANCHORED (FR-004/FR-005): a wall-clock catalogue
 * time is the exact bug the anchor work exists to fix — "load-in 16:00" is two
 * hours after the show on a 14:00 matinee.
 *
 * The anchor + `offsetMinutes` place the START only. `startMinuteOfDay` /
 * `endMinuteOfDay` on an anchored preset stop naming a wall clock and carry
 * only the DURATION (see `templateShiftDurationMinutes` and the doc comment on
 * `VolunteerRoleTemplateShift.offsetMinutes`). `anchoredShift` below is the one
 * place that encoding is written, and it refuses the two shapes that fail
 * downstream:
 *
 *   - `start === end` (a stored 24-hour shift) — it LOADS into the editor but
 *     cannot be re-saved: `parseShiftDraftFields` rejects it as
 *     `ends_equal_start`;
 *   - `endsNextDay && end > start` — rejected by `roleTemplateShiftDraftSchema`,
 *     because `endsNextDay` is derived and a round-tripped one goes stale.
 *
 * There is no EVENT_END anchor for a shift's END, so "runs until the show
 * ends" is expressed as a duration measured from a NOMINAL show length per
 * pack (`nominalShowMinutes`). That is a catalogue default an organizer edits
 * in the composer before applying, not a claim about their specific event.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { volunteerPackRoleInputSchema } from "@th/core/use-cases/platform/volunteer-packs";

// ── Shift encoding ───────────────────────────────────────────────────────────

const MINUTES_PER_DAY = 24 * 60;

/**
 * Wall clock the two minute columns fall back to on an anchored preset.
 *
 * Mirrors `ANCHORED_CARRIER_START_TIME` in
 * `apps/web/src/lib/template-shift-offset.ts`: the columns still round-trip, so
 * flipping a preset back to "clock time" in the editor yields a sane 12:00
 * start rather than midnight. Noon also leaves room for every duration this
 * catalogue currently seeds (longest is 6h) to land inside the same day, so
 * every seeded row's `endsNextDay` is false. That is a property of the
 * current content, not of the encoding: `anchoredShift` handles a wrap
 * correctly (`d >= 720` sets `endsNextDay`), it just never has to.
 */
const ANCHORED_CARRIER_START_MINUTE = 12 * 60;

type SeedShiftInput = {
  label: string;
  /** WALL_CLOCK is deliberately unreachable from the catalogue — see above. */
  anchor: "EVENT_START" | "EVENT_END";
  /** Signed minutes from the anchor; negative = before it. */
  offsetMinutes: number;
  /** How long the shift runs. 1..1439 — see the two rejected shapes above. */
  durationMinutes: number;
  capacity?: number;
  notes?: string;
};

type EncodedShift = {
  label: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  startDayOffset: number;
  endsNextDay: boolean;
  capacity: number | null;
  position: number;
  anchor: "EVENT_START" | "EVENT_END";
  offsetMinutes: number;
  notes: string | null;
};

/**
 * Encode an anchored preset's duration into the two minute columns.
 *
 * Throws rather than clamps: a bad catalogue entry must fail the seed loudly,
 * not ship a row that organizers cannot re-save.
 */
function anchoredShift(input: SeedShiftInput, position: number): EncodedShift {
  const { durationMinutes } = input;
  if (!Number.isInteger(durationMinutes)) {
    throw new Error(
      `[volunteer-packs] "${input.label}": durationMinutes must be an integer`,
    );
  }
  if (durationMinutes < 1 || durationMinutes >= MINUTES_PER_DAY) {
    // 0 and 1440 both encode to end === start, which loads but cannot be
    // re-saved (`ends_equal_start`). Anything longer than a day is
    // `startDayOffset`'s job.
    throw new Error(
      `[volunteer-packs] "${input.label}": durationMinutes must be 1..${
        MINUTES_PER_DAY - 1
      }, got ${durationMinutes}`,
    );
  }
  if (Math.abs(input.offsetMinutes) > MINUTES_PER_DAY) {
    throw new Error(
      `[volunteer-packs] "${input.label}": offsetMinutes must be within ±${MINUTES_PER_DAY}`,
    );
  }

  const startMinuteOfDay = ANCHORED_CARRIER_START_MINUTE;
  const endMinuteOfDay = (startMinuteOfDay + durationMinutes) % MINUTES_PER_DAY;
  const endsNextDay = endMinuteOfDay < startMinuteOfDay;

  return {
    label: input.label,
    startMinuteOfDay,
    endMinuteOfDay,
    startDayOffset: 0,
    endsNextDay,
    capacity: input.capacity ?? null,
    position,
    anchor: input.anchor,
    offsetMinutes: input.offsetMinutes,
    notes: input.notes ?? null,
  };
}

// ── Catalogue ────────────────────────────────────────────────────────────────

type SeedRole = {
  name: string;
  description: string;
  /** Suggested crew size when the role is pulled onto an event. */
  defaultCapacity?: number;
  /** Omitted = a role with no shift (standing help, or a table that is just "there"). */
  shifts?: SeedShiftInput[];
};

type SeedPack = {
  key: string;
  name: string;
  blurb: string;
  /**
   * Assumed run time of the kind of event this pack is for, used only to turn
   * "runs until the show ends" into a duration. Never persisted.
   */
  nominalShowMinutes: number;
  /** CURATION — applied on first insert only (see the header). */
  sortOrder: number;
  /**
   * Category slugs this pack suits, resolved to ids at seed time. Ranking
   * only, and inert until an org-category signal exists (FR-013): a missing
   * slug degrades ranking and never breaks the pack.
   */
  targetCategorySlugs: string[];
  roles: SeedRole[];
};

const HOUSE_SHOW_MINUTES = 3 * 60;
const DIY_MINUTES = 4 * 60;
const PERFORMING_ARTS_MINUTES = 150; // 2h30, curtain to curtain, interval included
const CLUB_NIGHT_MINUTES = 4 * 60;

export const LAUNCH_VOLUNTEER_PACKS: SeedPack[] = [
  {
    key: "house-show",
    name: "House show",
    blurb:
      "Living rooms, porches, and backyards. A small crew, a clear safety contact, and a plan for the neighbours.",
    nominalShowMinutes: HOUSE_SHOW_MINUTES,
    sortOrder: 0,
    targetCategorySlugs: ["music", "community"],
    roles: [
      {
        name: "Door & donations",
        description: "Takes the suggested donation and keeps a headcount.",
        defaultCapacity: 1,
        shifts: [
          {
            // Doors open before the first act, same lead-in as the DIY pack's
            // "Doors". Starting AT the show would miss the arrivals the role
            // exists for.
            label: "Doors to close",
            anchor: "EVENT_START",
            offsetMinutes: -30,
            durationMinutes: 30 + HOUSE_SHOW_MINUTES,
          },
        ],
      },
      {
        name: "Host & house rules",
        description:
          "Greets people at the door and explains how the space works.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Welcome",
            anchor: "EVENT_START",
            offsetMinutes: -30,
            durationMinutes: 90,
          },
        ],
      },
      {
        name: "Sound",
        description: "Runs the one PA and swaps the acts over.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Set up and run sound",
            anchor: "EVENT_START",
            offsetMinutes: -120,
            durationMinutes: 120 + HOUSE_SHOW_MINUTES,
            notes: "Bring your own cables if you have them.",
          },
        ],
      },
      {
        name: "Neighbour watch",
        description: "Parking, street noise, and keeping the block sweet.",
        defaultCapacity: 2,
        shifts: [
          {
            label: "Outside",
            anchor: "EVENT_START",
            offsetMinutes: 0,
            durationMinutes: HOUSE_SHOW_MINUTES + 30,
          },
        ],
      },
      {
        name: "Safety point person",
        description: "The named contact if something goes wrong.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "On call",
            anchor: "EVENT_START",
            offsetMinutes: 0,
            durationMinutes: HOUSE_SHOW_MINUTES,
            notes: "Keep your phone on you and know where the exits are.",
          },
        ],
      },
      {
        name: "Reset the room",
        description: "Chairs back, bottles out, floor swept.",
        defaultCapacity: 3,
        shifts: [
          {
            label: "Reset",
            anchor: "EVENT_END",
            offsetMinutes: 0,
            durationMinutes: 60,
          },
        ],
      },
    ],
  },

  {
    key: "diy-all-ages",
    name: "DIY & all-ages space",
    blurb:
      "Collective-run rooms, basements, and record shops. Everyone gets in, and everyone pitches in.",
    nominalShowMinutes: DIY_MINUTES,
    sortOrder: 1,
    targetCategorySlugs: ["music", "community"],
    roles: [
      {
        name: "Door & cover",
        description: "Takes the cover, stamps hands, and counts the room.",
        defaultCapacity: 2,
        shifts: [
          {
            label: "Doors",
            anchor: "EVENT_START",
            offsetMinutes: -30,
            durationMinutes: 150,
          },
        ],
      },
      {
        name: "Safer space",
        description:
          "Trained point of contact for the room; handles de-escalation.",
        defaultCapacity: 2,
        shifts: [
          {
            label: "On the floor",
            anchor: "EVENT_START",
            offsetMinutes: 0,
            durationMinutes: DIY_MINUTES,
            notes: "Read the safer-space policy before your first shift.",
          },
        ],
      },
      {
        name: "Sound",
        description: "Runs the board and does line checks.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Line check to last band",
            anchor: "EVENT_START",
            offsetMinutes: -120,
            durationMinutes: 120 + DIY_MINUTES,
          },
        ],
      },
      {
        name: "Stage manager",
        description: "Keeps changeovers tight and runs the set clock.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Changeovers",
            anchor: "EVENT_START",
            offsetMinutes: -60,
            durationMinutes: 60 + DIY_MINUTES,
          },
        ],
      },
      {
        name: "Merch",
        description: "Sells for the touring bands and settles the count.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Merch table",
            anchor: "EVENT_START",
            offsetMinutes: 0,
            durationMinutes: DIY_MINUTES + 30,
          },
        ],
      },
      {
        name: "Snack & water table",
        description: "Free water and cheap snacks all night.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Table",
            anchor: "EVENT_START",
            offsetMinutes: 0,
            durationMinutes: DIY_MINUTES,
          },
        ],
      },
      {
        name: "Load-in help",
        description: "Meets the vans and hauls gear inside.",
        defaultCapacity: 3,
        shifts: [
          {
            label: "Load-in",
            anchor: "EVENT_START",
            offsetMinutes: -180,
            durationMinutes: 180,
            notes: "Closed-toe shoes. Park round the back.",
          },
        ],
      },
      {
        name: "Cleanup & lockup",
        description: "Strike, sweep, and lock the doors.",
        defaultCapacity: 3,
        shifts: [
          {
            label: "Cleanup",
            anchor: "EVENT_END",
            offsetMinutes: 0,
            durationMinutes: 120,
          },
        ],
      },
      {
        // No shift on purpose: the table is set up once and looks after itself.
        name: "Info & zine table",
        description: "Local orgs, mutual aid, and flyers for the next show.",
        defaultCapacity: 1,
      },
    ],
  },

  {
    key: "performing-arts",
    name: "Performing arts",
    blurb:
      "Theatres, dance companies, and recital halls. Front of house from doors to lock-up.",
    nominalShowMinutes: PERFORMING_ARTS_MINUTES,
    sortOrder: 2,
    targetCategorySlugs: ["arts"],
    roles: [
      {
        name: "Front of house lead",
        description: "Runs the lobby, briefs the ushers, and calls the house.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Front of house",
            anchor: "EVENT_START",
            offsetMinutes: -60,
            durationMinutes: 60 + PERFORMING_ARTS_MINUTES + 30,
          },
        ],
      },
      {
        name: "Ushers",
        description: "Scans tickets, seats patrons, and hands out programmes.",
        defaultCapacity: 4,
        shifts: [
          {
            label: "Doors to final curtain",
            anchor: "EVENT_START",
            offsetMinutes: -45,
            durationMinutes: 45 + PERFORMING_ARTS_MINUTES,
          },
        ],
      },
      {
        name: "Box office & will call",
        description: "Sells at the door and hands over held tickets.",
        defaultCapacity: 2,
        shifts: [
          {
            label: "Box office",
            anchor: "EVENT_START",
            offsetMinutes: -60,
            durationMinutes: 120,
            notes: "Stays open an hour past curtain for latecomers.",
          },
        ],
      },
      {
        name: "Coat check",
        description: "Tags coats and bags, and returns them after the show.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Coat check",
            anchor: "EVENT_START",
            offsetMinutes: -45,
            durationMinutes: 45 + PERFORMING_ARTS_MINUTES + 30,
          },
        ],
      },
      {
        name: "Concessions",
        description:
          "Sells drinks and snacks before curtain and at the interval.",
        defaultCapacity: 2,
        shifts: [
          {
            label: "Concessions",
            anchor: "EVENT_START",
            offsetMinutes: -45,
            durationMinutes: 45 + PERFORMING_ARTS_MINUTES,
          },
        ],
      },
      {
        name: "Accessible seating host",
        description:
          "Meets patrons who need step-free seating and gets them settled.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Doors and seating",
            anchor: "EVENT_START",
            offsetMinutes: -45,
            durationMinutes: 75,
          },
        ],
      },
      {
        name: "Intermission crew",
        description: "Resets the lobby, clears glasses, and moves the queue.",
        defaultCapacity: 2,
        shifts: [
          {
            // Mid-show: half a nominal running time after curtain. The only
            // preset in the catalogue positioned by a show's INTERIOR rather
            // than an edge, so it degrades worst when the real running time
            // differs — hence the note.
            label: "Interval",
            anchor: "EVENT_START",
            offsetMinutes: PERFORMING_ARTS_MINUTES / 2,
            durationMinutes: 45,
            notes:
              "Starts 75 minutes after curtain, which assumes a 2h30 running time. Move it to your actual interval before you publish.",
          },
        ],
      },
      {
        name: "Backstage runner",
        description:
          "Fetches, carries, and passes messages between the stage and the booth.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Backstage",
            anchor: "EVENT_START",
            offsetMinutes: -60,
            durationMinutes: 60 + PERFORMING_ARTS_MINUTES,
          },
        ],
      },
      {
        name: "Lock-up",
        description: "Sweeps the house, closes the lobby, and locks the doors.",
        defaultCapacity: 2,
        shifts: [
          {
            label: "Lock-up",
            anchor: "EVENT_END",
            offsetMinutes: 30,
            durationMinutes: 60,
          },
        ],
      },
    ],
  },

  {
    key: "club-night",
    name: "Club night",
    blurb:
      "A ticketed show with a load-in and a load-out. Doors, bar, stage, and vans.",
    nominalShowMinutes: CLUB_NIGHT_MINUTES,
    sortOrder: 3,
    targetCategorySlugs: ["nightlife", "music"],
    roles: [
      {
        name: "Door & check-in",
        description: "Scans tickets, checks IDs, and counts the room.",
        defaultCapacity: 2,
        shifts: [
          {
            label: "Doors",
            anchor: "EVENT_START",
            offsetMinutes: -30,
            durationMinutes: 30 + CLUB_NIGHT_MINUTES,
          },
        ],
      },
      {
        name: "Merch",
        description: "Sells for the bands and settles the count at the end.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Merch table",
            anchor: "EVENT_START",
            offsetMinutes: 0,
            durationMinutes: CLUB_NIGHT_MINUTES + 30,
          },
        ],
      },
      {
        name: "Bar back",
        description: "Keeps ice, glassware, and stock moving to the bar.",
        defaultCapacity: 2,
        shifts: [
          {
            label: "Bar",
            anchor: "EVENT_START",
            offsetMinutes: -60,
            durationMinutes: 60 + CLUB_NIGHT_MINUTES,
          },
        ],
      },
      {
        name: "Stage hand",
        description: "Moves gear, sets the stage, and runs changeovers.",
        defaultCapacity: 3,
        shifts: [
          {
            label: "Load-in and changeovers",
            anchor: "EVENT_START",
            offsetMinutes: -120,
            durationMinutes: 120 + CLUB_NIGHT_MINUTES,
            notes: "Closed-toe shoes.",
          },
        ],
      },
      {
        name: "Sound assist",
        description: "Helps the engineer with line checks and mic swaps.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Line check to last set",
            anchor: "EVENT_START",
            offsetMinutes: -120,
            durationMinutes: 120 + CLUB_NIGHT_MINUTES,
          },
        ],
      },
      {
        name: "Green room host",
        description: "Looks after the artists — rider, water, and set times.",
        defaultCapacity: 1,
        shifts: [
          {
            // Artist hospitality is the LAST job to finish, not the first:
            // same 2h lead-in as the stage roles, and it runs the whole show.
            label: "Hospitality",
            anchor: "EVENT_START",
            offsetMinutes: -120,
            durationMinutes: 120 + CLUB_NIGHT_MINUTES,
          },
        ],
      },
      {
        name: "Load-out",
        description: "Strikes the stage and loads the vans.",
        defaultCapacity: 3,
        shifts: [
          {
            label: "Load-out",
            anchor: "EVENT_END",
            offsetMinutes: 0,
            durationMinutes: 120,
          },
        ],
      },
      {
        name: "Photo & video",
        description: "Shoots the night for the venue and the bands.",
        defaultCapacity: 1,
        shifts: [
          {
            label: "Shoot",
            anchor: "EVENT_START",
            offsetMinutes: -30,
            durationMinutes: 30 + CLUB_NIGHT_MINUTES,
          },
        ],
      },
    ],
  },

  {
    // Deliberately SHIFT-FREE. Shift occurrences for standing asks are
    // specs/2026-07-07/generic-volunteer-shifts-occurrences.spec.yaml, which is
    // not built; seeding presets here would collide with it.
    key: "standing-crew",
    name: "Standing crew",
    blurb:
      "Ongoing help that isn't tied to one show — the people who keep things running between nights.",
    nominalShowMinutes: 0,
    sortOrder: 4,
    targetCategorySlugs: [],
    roles: [
      {
        name: "Street team",
        description: "Posters, flyers, and word of mouth around town.",
      },
      {
        name: "Social & content",
        description: "Posts show announcements and clips between events.",
      },
      {
        name: "Newsletter",
        description: "Writes and sends the what's-on email.",
      },
      {
        name: "Grant writing",
        description: "Researches funders and drafts applications.",
      },
      {
        name: "Photo archive",
        description: "Sorts, tags, and files show photos.",
      },
      {
        name: "Sound engineer pool",
        description: "On-call engineers to ring when a show needs one.",
      },
      {
        name: "Open-mic host",
        // The one role in this pack performed AT an event, so the standing
        // commitment is spelled out: it is "host the residency", not "host
        // this Thursday". Per-night shifts arrive with the unbuilt
        // 2026-07-07 occurrences spec.
        description:
          "Hosts the recurring open mic — runs the sign-up list and MCs. An ongoing commitment across the run, not a single night.",
      },
      {
        name: "Driver",
        description: "Airport runs, gear pickups, and getting people home.",
      },
      {
        name: "Gear maintenance",
        description:
          "Repairs cables, replaces heads, and keeps the kit working.",
      },
    ],
  },
];

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Encode a pack's roles and validate them against the SAME zod schema the
 * staff editor writes through (`volunteerPackRoleInputSchema`, which nests
 * `roleTemplateShiftDraftSchema`).
 *
 * Running the catalogue through the real schema is the point: it is what
 * guarantees a seeded preset is one an organizer can open, edit and re-save,
 * rather than a shape only raw SQL can produce. Exported so a unit test can
 * assert it without touching a database.
 */
export function encodeVolunteerPackRoles(pack: SeedPack) {
  const seenNames = new Set<string>();

  return pack.roles.map((role, index) => {
    const nameKey = role.name.trim().toLowerCase();
    if (seenNames.has(nameKey)) {
      // Mirrors the partial unique index: one pack cannot list two "Door"s.
      // (Two DIFFERENT packs both listing one is fine and is what this
      // catalogue actually requires — "Sound", "Merch".)
      throw new Error(
        `[volunteer-packs] pack "${pack.key}" lists "${role.name}" twice`,
      );
    }
    seenNames.add(nameKey);

    const shifts = (role.shifts ?? []).map((shift, position) =>
      anchoredShift(shift, position),
    );
    const labels = new Set(shifts.map((s) => s.label.trim().toLowerCase()));
    if (labels.size !== shifts.length) {
      // Shift presets are reconciled by label; duplicates would make a re-seed
      // non-deterministic.
      throw new Error(
        `[volunteer-packs] pack "${pack.key}" role "${role.name}" has duplicate shift labels`,
      );
    }

    const parsed = volunteerPackRoleInputSchema.parse({
      name: role.name,
      description: role.description,
      defaultCapacity: role.defaultCapacity ?? null,
      sortOrder: index,
      // OMITTED, not `[]`: `[]` means "clear the shifts", which is the same
      // outcome here but says something different.
      ...(role.shifts ? { shifts } : {}),
    });

    return {
      parsed,
      shifts,
      sortOrder: index,
      // OMITTED `shifts` means "this role's presets are not this catalogue's
      // business" (standing crew), which is a different statement from `[]`
      // ("it has none"). Only the latter makes existing presets stale.
      declaresShifts: role.shifts !== undefined,
    };
  });
}

// ── Seed ─────────────────────────────────────────────────────────────────────

export type VolunteerPackSeedOptions = {
  /**
   * Overwrite an existing pack / role / shift's CONTENT with this file's
   * baseline.
   *
   * OFF by default, and OFF in `deploy-dev.yml` / `deploy-prod.yml`. The seed
   * runs on every deploy dispatch, including one for an unrelated web fix, so
   * a description a staff member fixed at `/platform/volunteer-packs` must not
   * be silently reverted by it. Turn it on deliberately when you want git to
   * win: `pnpm seed:volunteer-packs -- --refresh`.
   */
  refresh?: boolean;
  /**
   * Delete catalogue rows the baseline no longer names, plus case-folded
   * duplicate rows.
   *
   * OFF by default, and OFF in both deploy workflows. Retiring a catalogue
   * role is a deliberate staff action through `upsertVolunteerPack`, which is
   * transactional and audited (FR-015); a deploy is not. When it IS on, every
   * delete runs in the same transaction as a `volunteer_pack.seed_pruned`
   * audit row, so the loss is forensically visible.
   */
  prune?: boolean;
};

type ExistingRole = {
  id: string;
  name: string;
  description: string | null;
  defaultCapacity: number | null;
  sortOrder: number;
  archived: boolean;
};

type ExistingShift = {
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

const foldKey = (value: string) => value.trim().toLowerCase();

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Group rows by a case-folded key, keeping EVERY row that lands on one.
 *
 * A `Map<key, row>` built from an array silently keeps only the last colliding
 * row, and that is how reconciliation stops converging. Collisions are
 * reachable in both directions: there is no unique constraint at all on
 * (`templateId`, `label`), and the FR-003 partial index on (`packId`, `name`)
 * is case-SENSITIVE, so "Load-out" twice, or "Door" alongside "door", both
 * survive the database. With a plain Map the seed would update whichever row
 * happened to come last out of `findMany` — ordering that is not a contract and
 * can flip run to run — and leave the other one untouched AND undeleted, so it
 * outlived every re-seed and showed as a doubled preset in the organiser's
 * shift composer.
 *
 * Here the bucket is ordered explicitly, the first row is the one the seed
 * reconciles, and the rest are duplicates the prune removes.
 */
function groupByKey<T>(
  rows: readonly T[],
  key: (row: T) => string,
  order: (a: T, b: T) => number,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of [...rows].sort(order)) {
    const bucket = out.get(key(row));
    if (bucket) bucket.push(row);
    else out.set(key(row), [row]);
  }
  return out;
}

function roleContentDiffers(
  existing: ExistingRole,
  desired: {
    name: string;
    description?: string | null;
    defaultCapacity?: number | null;
  },
  sortOrder: number,
): boolean {
  return (
    existing.name !== desired.name ||
    existing.description !== (desired.description ?? null) ||
    existing.defaultCapacity !== (desired.defaultCapacity ?? null) ||
    existing.sortOrder !== sortOrder ||
    // A catalogue role is never archived; un-archive so a hand-edited row
    // converges back on the reviewed baseline.
    existing.archived
  );
}

type ShiftWriteData = Omit<EncodedShift, "label"> & { label: string };

function shiftContentDiffers(
  existing: ExistingShift,
  desired: ShiftWriteData,
): boolean {
  return (
    existing.label !== desired.label ||
    existing.startMinuteOfDay !== desired.startMinuteOfDay ||
    existing.endMinuteOfDay !== desired.endMinuteOfDay ||
    existing.startDayOffset !== desired.startDayOffset ||
    existing.endsNextDay !== desired.endsNextDay ||
    existing.capacity !== desired.capacity ||
    existing.position !== desired.position ||
    existing.anchor !== desired.anchor ||
    existing.offsetMinutes !== desired.offsetMinutes ||
    existing.notes !== desired.notes
  );
}

/**
 * Install the launch catalogue (FR-018).
 *
 * INSTALL-ONLY by default — creates what is missing, updates nothing, deletes
 * nothing. See the header for why, and for the two opt-ins that widen it.
 * A converged re-seed performs zero writes and emits zero audit rows.
 *
 * Written with plain Prisma calls rather than through `upsertVolunteerPack`,
 * matching `ensureCategories` / `ensurePlatformWaivers`: the staff use case
 * requires an `actorHumanId` for its RBAC check and audit row, and no such
 * human is guaranteed to exist on a fresh production database.
 * `curatedByHumanId` stays null until a staff member actually edits a pack.
 * The content is still validated against the staff editor's schema by
 * `encodeVolunteerPackRoles`, and every change still writes an AuditLog row
 * (FR-015) — the seed just names itself as the actor instead of a human.
 */
export async function ensureVolunteerPacks(
  prisma: PrismaClient,
  options: VolunteerPackSeedOptions = {},
) {
  const refresh = options.refresh ?? false;
  const prune = options.prune ?? false;

  console.log(
    `Seeding platform volunteer packs (refresh=${refresh}, prune=${prune})...`,
  );

  // Resolve targeting slugs once. Ranking only — a missing category is skipped
  // rather than fatal.
  const wantedSlugs = [
    ...new Set(LAUNCH_VOLUNTEER_PACKS.flatMap((p) => p.targetCategorySlugs)),
  ];
  const categories = wantedSlugs.length
    ? await prisma.category.findMany({
        where: { slug: { in: wantedSlugs } },
        select: { id: true, slug: true },
      })
    : [];
  const categoryIdBySlug = new Map(categories.map((c) => [c.slug, c.id]));

  const summary = {
    /** Packs the catalogue declares (processed), not packs written. */
    packCount: 0,
    roleCount: 0,
    shiftCount: 0,
    createdPacks: 0,
    createdRoles: 0,
    createdShifts: 0,
    updatedPacks: 0,
    updatedRoles: 0,
    updatedShifts: 0,
    removedRoles: 0,
    removedShifts: 0,
    /** Deletions the baseline wanted and `prune: false` withheld. */
    withheldRoleDeletes: 0,
    withheldShiftDeletes: 0,
  };

  for (const pack of LAUNCH_VOLUNTEER_PACKS) {
    const encodedRoles = encodeVolunteerPackRoles(pack);

    const targetCategoryIds = pack.targetCategorySlugs
      .map((slug) => categoryIdBySlug.get(slug))
      .filter((id): id is string => Boolean(id));

    const createdRoleNames: string[] = [];
    const createdShiftLabels: string[] = [];
    const updatedRoleNames: string[] = [];
    const updatedShiftLabels: string[] = [];
    const candidateRoles: { id: string; name: string }[] = [];
    const candidateShifts: { id: string; label: string }[] = [];
    let packCreated = false;
    let packBackfilled = false;
    let packRefreshed = false;

    const priorPack = await prisma.volunteerPack.findUnique({
      where: { key: pack.key },
      select: { id: true, name: true, blurb: true, targetCategoryIds: true },
    });

    let packId: string;
    if (!priorPack) {
      const row = await prisma.volunteerPack.create({
        data: {
          key: pack.key,
          name: pack.name,
          blurb: pack.blurb,
          status: "LIVE",
          targetCategoryIds,
          rankFirst: false,
          sortOrder: pack.sortOrder,
        },
        select: { id: true },
      });
      packId = row.id;
      packCreated = true;
      summary.createdPacks += 1;
    } else {
      packId = priorPack.id;
      const data: Record<string, unknown> = {};

      // BACKFILL — a repair of an absent value, never an overwrite of a chosen
      // one, so it runs in both modes. A pack inserted before the category
      // taxonomy existed (a bootstrap that ran the two seed scripts the other
      // way round) would otherwise be stuck untargeted forever with no way for
      // a re-seed to fix it. A staff member who has actually picked categories
      // is never touched.
      if (
        priorPack.targetCategoryIds.length === 0 &&
        targetCategoryIds.length > 0
      ) {
        data.targetCategoryIds = targetCategoryIds;
        packBackfilled = true;
      }

      if (refresh) {
        // CONTENT. `status` / `rankFirst` / `sortOrder` are deliberately absent
        // even here: publishing is `setVolunteerPackStatus`, and no mode of
        // this seed re-publishes a pack staff pulled.
        if (priorPack.name !== pack.name) data.name = pack.name;
        if (priorPack.blurb !== pack.blurb) data.blurb = pack.blurb;
        packRefreshed = "name" in data || "blurb" in data;
      }

      if (Object.keys(data).length > 0) {
        await prisma.volunteerPack.update({
          where: { id: packId },
          data,
          select: { id: true },
        });
        summary.updatedPacks += 1;
      }
    }
    summary.packCount += 1;

    // PLATFORM-ONLY: an org's fork carries the same packId and must never be
    // reachable from here.
    const existingRoles = await prisma.volunteerRoleTemplate.findMany({
      where: { packId, isPlatform: true },
      select: {
        id: true,
        name: true,
        description: true,
        defaultCapacity: true,
        sortOrder: true,
        archived: true,
      },
    });

    // One query for the whole pack's presets rather than one per role. The
    // seed talks to Neon on every deploy, and 41 extra sequential round-trips
    // is 41 extra chances to time out on a project that has already lost four
    // days to a Neon compute-quota outage.
    const existingShifts: ExistingShift[] = existingRoles.length
      ? await prisma.volunteerRoleTemplateShift.findMany({
          where: { templateId: { in: existingRoles.map((r) => r.id) } },
          select: {
            id: true,
            templateId: true,
            label: true,
            startMinuteOfDay: true,
            endMinuteOfDay: true,
            startDayOffset: true,
            endsNextDay: true,
            capacity: true,
            position: true,
            anchor: true,
            offsetMinutes: true,
            notes: true,
          },
        })
      : [];

    const rolesByName = groupByKey<ExistingRole>(
      existingRoles,
      (r) => foldKey(r.name),
      // Deterministic winner on a collision. NOT `findMany` order, which is
      // not a contract and made "which duplicate survives" flip run to run.
      (a, b) => a.sortOrder - b.sortOrder || byId(a.id, b.id),
    );
    const shiftsByTemplate = new Map<string, ExistingShift[]>();
    for (const row of existingShifts) {
      const bucket = shiftsByTemplate.get(row.templateId);
      if (bucket) bucket.push(row);
      else shiftsByTemplate.set(row.templateId, [row]);
    }

    const unclaimedRoleKeys = new Set(rolesByName.keys());

    for (const { parsed, shifts, sortOrder, declaresShifts } of encodedRoles) {
      const nameKey = foldKey(parsed.name);
      unclaimedRoleKeys.delete(nameKey);
      const roleBucket = rolesByName.get(nameKey) ?? [];
      const roleMatch = roleBucket[0];

      let templateId: string;
      if (!roleMatch) {
        const row = await prisma.volunteerRoleTemplate.create({
          data: {
            orgId: null,
            isPlatform: true,
            packId,
            name: parsed.name,
            description: parsed.description ?? null,
            defaultCapacity: parsed.defaultCapacity ?? null,
            sortOrder,
          },
          select: { id: true },
        });
        templateId = row.id;
        createdRoleNames.push(parsed.name);
        summary.createdRoles += 1;
      } else {
        templateId = roleMatch.id;
        if (refresh && roleContentDiffers(roleMatch, parsed, sortOrder)) {
          await prisma.volunteerRoleTemplate.update({
            where: { id: roleMatch.id },
            data: {
              name: parsed.name,
              description: parsed.description ?? null,
              defaultCapacity: parsed.defaultCapacity ?? null,
              sortOrder,
              archived: false,
            },
            select: { id: true },
          });
          updatedRoleNames.push(parsed.name);
          summary.updatedRoles += 1;
        }
      }
      summary.roleCount += 1;

      // Case-folded duplicates of a role the baseline DOES name.
      for (const dup of roleBucket.slice(1)) {
        candidateRoles.push({ id: dup.id, name: dup.name });
      }

      // Shift presets, reconciled by (templateId, label) so a re-seed never
      // churns ids.
      const shiftBuckets = groupByKey(
        shiftsByTemplate.get(templateId) ?? [],
        (s) => foldKey(s.label),
        (a, b) => a.position - b.position || byId(a.id, b.id),
      );
      const unclaimedShiftKeys = new Set(shiftBuckets.keys());

      for (const shift of shifts) {
        const labelKey = foldKey(shift.label);
        unclaimedShiftKeys.delete(labelKey);
        const shiftBucket = shiftBuckets.get(labelKey) ?? [];
        const shiftMatch = shiftBucket[0];

        const data: ShiftWriteData = {
          label: shift.label,
          startMinuteOfDay: shift.startMinuteOfDay,
          endMinuteOfDay: shift.endMinuteOfDay,
          startDayOffset: shift.startDayOffset,
          endsNextDay: shift.endsNextDay,
          capacity: shift.capacity,
          position: shift.position,
          anchor: shift.anchor,
          offsetMinutes: shift.offsetMinutes,
          notes: shift.notes,
        };

        if (!shiftMatch) {
          await prisma.volunteerRoleTemplateShift.create({
            data: { templateId, ...data },
          });
          createdShiftLabels.push(`${parsed.name} — ${shift.label}`);
          summary.createdShifts += 1;
        } else if (refresh && shiftContentDiffers(shiftMatch, data)) {
          await prisma.volunteerRoleTemplateShift.update({
            where: { id: shiftMatch.id },
            data,
          });
          updatedShiftLabels.push(`${parsed.name} — ${shift.label}`);
          summary.updatedShifts += 1;
        }
        summary.shiftCount += 1;

        for (const dup of shiftBucket.slice(1)) {
          candidateShifts.push({ id: dup.id, label: dup.label });
        }
      }

      // `declaresShifts` false = the catalogue says nothing about this role's
      // presets (standing crew), which is not the same as saying it has none.
      if (declaresShifts) {
        for (const key of unclaimedShiftKeys) {
          for (const row of shiftBuckets.get(key) ?? []) {
            candidateShifts.push({ id: row.id, label: row.label });
          }
        }
      }
    }

    for (const key of unclaimedRoleKeys) {
      for (const row of rolesByName.get(key) ?? []) {
        candidateRoles.push({ id: row.id, name: row.name });
      }
    }

    // ── Deletes + audit, in one transaction ──────────────────────────────
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    let shiftDeleteAt = -1;
    let roleDeleteAt = -1;

    if (prune) {
      if (candidateShifts.length > 0) {
        shiftDeleteAt = ops.length;
        ops.push(
          prisma.volunteerRoleTemplateShift.deleteMany({
            where: { id: { in: candidateShifts.map((s) => s.id) } },
          }),
        );
      }
      if (candidateRoles.length > 0) {
        roleDeleteAt = ops.length;
        ops.push(
          prisma.volunteerRoleTemplate.deleteMany({
            // `isPlatform: true` pinned again at the delete: an org fork
            // sharing this packId is not this seed's to remove.
            where: {
              id: { in: candidateRoles.map((r) => r.id) },
              isPlatform: true,
            },
          }),
        );
      }
      if (candidateShifts.length > 0 || candidateRoles.length > 0) {
        ops.push(
          prisma.auditLog.create({
            data: {
              entity: "volunteer_pack",
              entityId: packId,
              action: "volunteer_pack.seed_pruned",
              data: {
                actor: "seed:volunteer-packs",
                key: pack.key,
                removedNames: candidateRoles.map((r) => r.name),
                removedShiftLabels: candidateShifts.map((s) => s.label),
              },
            },
          }),
        );
      }
    } else {
      summary.withheldRoleDeletes += candidateRoles.length;
      summary.withheldShiftDeletes += candidateShifts.length;
    }

    if (
      packCreated ||
      packBackfilled ||
      createdRoleNames.length > 0 ||
      createdShiftLabels.length > 0
    ) {
      ops.push(
        prisma.auditLog.create({
          data: {
            entity: "volunteer_pack",
            entityId: packId,
            action: "volunteer_pack.seed_installed",
            data: {
              actor: "seed:volunteer-packs",
              key: pack.key,
              packCreated,
              targetingBackfilled: packBackfilled,
              createdRoles: createdRoleNames,
              createdShifts: createdShiftLabels,
            },
          },
        }),
      );
    }

    if (
      packRefreshed ||
      updatedRoleNames.length > 0 ||
      updatedShiftLabels.length > 0
    ) {
      ops.push(
        prisma.auditLog.create({
          data: {
            entity: "volunteer_pack",
            entityId: packId,
            action: "volunteer_pack.seed_refreshed",
            data: {
              actor: "seed:volunteer-packs",
              key: pack.key,
              packMetadata: packRefreshed,
              updatedRoles: updatedRoleNames,
              updatedShifts: updatedShiftLabels,
            },
          },
        }),
      );
    }

    if (ops.length > 0) {
      const results = await prisma.$transaction(ops);
      if (shiftDeleteAt >= 0) {
        summary.removedShifts += (
          results[shiftDeleteAt] as { count: number }
        ).count;
      }
      if (roleDeleteAt >= 0) {
        summary.removedRoles += (
          results[roleDeleteAt] as { count: number }
        ).count;
      }
    }
  }

  const changes = [
    summary.createdPacks > 0 ? `+${summary.createdPacks} pack(s)` : null,
    summary.createdRoles > 0 ? `+${summary.createdRoles} role(s)` : null,
    summary.createdShifts > 0 ? `+${summary.createdShifts} shift(s)` : null,
    summary.updatedPacks > 0 ? `~${summary.updatedPacks} pack(s)` : null,
    summary.updatedRoles > 0 ? `~${summary.updatedRoles} role(s)` : null,
    summary.updatedShifts > 0 ? `~${summary.updatedShifts} shift(s)` : null,
    summary.removedRoles > 0 ? `-${summary.removedRoles} role(s)` : null,
    summary.removedShifts > 0 ? `-${summary.removedShifts} shift(s)` : null,
  ].filter(Boolean);

  console.log(
    `  ${summary.packCount} volunteer packs, ${summary.roleCount} catalogue roles, ` +
      `${summary.shiftCount} shift presets — ` +
      (changes.length > 0 ? `changes: ${changes.join(", ")}` : "no changes"),
  );

  const withheld = summary.withheldRoleDeletes + summary.withheldShiftDeletes;
  if (withheld > 0) {
    // Loud, not silent: the operator should know the DB holds catalogue rows
    // this file no longer names, and that removing them is a staff action.
    console.log(
      `  NOTE: ${summary.withheldRoleDeletes} role(s) and ${summary.withheldShiftDeletes} shift(s) ` +
        `in the database are not named by the git baseline and were LEFT IN PLACE ` +
        `(pruning is off by default — pass --prune to remove them).`,
    );
  }

  return { ...summary, refresh, prune };
}
