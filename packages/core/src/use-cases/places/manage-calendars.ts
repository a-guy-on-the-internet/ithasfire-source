import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  CalendarAvailabilityRow,
  CalendarRow,
  CalendarsRepo,
  CalendarWithSpacesRow,
} from "@th/ports/repos/calendars";
import type { SpaceRow, SpacesRepo } from "@th/ports/repos/spaces";
import type { ReporterPort } from "@th/ports/reporter";
import { fail } from "@th/errors";
import type { NotifyAvailabilitySetupNeededFn } from "./notify-availability-setup-needed";
import { parseInput } from "../../lib/io";
import {
  plainTextMultilineOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import { slugSegment } from "../../lib/slug-utils";
import { listSpacesOutputSchema } from "./manage-spaces";
import { pickPrimarySpace } from "./_shared/calendar-active-space";
import { ensurePlaceOwnerAccess } from "./_shared/ensure-place-owner-access";

// ─────────────────────────────────────────────────────────────────────────────
// Calendars management (venue-hierarchy FR-002/FR-003/FR-007;
// docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml).
//
// A Calendar is a place's named programming stream ("Social Club", "Drkmttr
// Live Music") joined M:N onto Spaces. Event rendering filters on
// `Event.calendarId`, never the space join (FR-005).
//
// CROSS-PLACE ISOLATION: nothing in the schema stops joining org A's calendar
// to org B's space. Every operation that accepts a `calendarId` or `spaceId`
// re-fetches the row(s) and asserts `.placeId === input.placeId` INSIDE the
// same `repos.tx()` as the mutation. A foreign id is deliberately
// indistinguishable from a missing one (`CALENDAR_NOT_FOUND` /
// `SPACE_NOT_FOUND`).
//
// Scope notes (Step 3):
// - `isDefault` is NEVER written here. The default calendar is minted at place
//   creation (upsert-place); changing which calendar is default is out of
//   scope for this step.
// - `slug` is immutable after create (no slug history exists for calendars —
//   a rename would break public calendar-embed URLs silently).
// - No destructive calendar op exists in this scope (the ≥1-calendar-per-place
//   invariant has no deleter to defend against yet).
// ─────────────────────────────────────────────────────────────────────────────

export type ManageCalendarsDeps = {
  /**
   * `spaces`/`calendars` are required on the aggregate since Step 5 — the
   * `Required<Pick>` is now redundant but harmless, kept as an explicit
   * statement of what the use case consumes. `spaces` is needed for the
   * per-space same-place asserts in {@link assignCalendarSpaces}.
   */
  repos: Repos & Required<Pick<Repos, "spaces" | "calendars">>;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Availability-onboarding FR-003 (docs/specs/2026-08-31): a Calendar created
   * for a place with ZERO CalendarAvailability rows programs nothing — nudge
   * the acting staff human. The hook owns the unconfigured suppression AND the
   * durable once-per-place idempotency (`availability-setup:{placeId}`), so
   * {@link createCalendar} calls it unconditionally post-commit. Optional;
   * failures are swallowed (+ reported) — never fail the committed create.
   */
  notifyAvailabilitySetupNeeded?: NotifyAvailabilitySetupNeededFn;
  /** Best-effort reporter for the notification swallow branch. */
  reportError?: ReporterPort;
};

/** Strict 24-hour wall-clock "HH:mm" (00:00–23:59). */
const TIME_24H_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Explicit slug input: lowercase kebab, mirrors what derivation produces. */
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CALENDAR_SLUG_MAX = 64;
const CALENDAR_SLUG_FALLBACK = "calendar";

/** See `spacesIn` in manage-spaces.ts — same unreachable-wiring guard. */
function calendarsIn(tx: TxRepos): CalendarsRepo {
  if (!tx.calendars) {
    throw fail("NOT_CONFIGURED", { message: "calendars repo missing from tx" });
  }
  return tx.calendars;
}

function spacesIn(tx: TxRepos): SpacesRepo {
  if (!tx.spaces) {
    throw fail("NOT_CONFIGURED", { message: "spaces repo missing from tx" });
  }
  return tx.spaces;
}

const eventTemplateSchema = z.record(z.string(), z.unknown());

// ── Output row schemas ──────────────────────────────────────────────────────
// Transport `.output()` contracts (Step-6 review; mirrors manage-spaces.ts's
// spaceRowSchema). Shapes mirror the `@th/ports` row DTOs exactly — an adapter
// that starts projecting extra columns gets them stripped at the boundary
// instead of silently leaking them to clients.

export const calendarRowSchema = z.object({
  id: z.string(),
  placeId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  /** The calendar's guaranteed-ACTIVE room — see `CalendarRow.primarySpaceId`. */
  primarySpaceId: z.string(),
  defaultStartTime: z.string().nullable(),
  defaultCategoryId: z.string().nullable(),
  eventTemplate: eventTemplateSchema.nullable(),
  // Booking config layer (venue-confirmation spec) — read-only through these
  // procedures for now; the create/update inputs gain them in Step 2.
  acceptsPerform: z.boolean(),
  acceptsRent: z.boolean(),
  acceptsUse: z.boolean(),
  rentalRateCents: z.number().int().nullable(),
  rentalRateCurrency: z.string().nullable(),
  rentalRateVisible: z.boolean(),
  rentalMode: z.enum(["REQUEST", "INSTANT"]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/** Spaces ride the SAME schema the spaces procedures output (no drift copy). */
export const calendarWithSpacesRowSchema = calendarRowSchema.extend({
  spaces: listSpacesOutputSchema,
});

export const calendarAvailabilityRowSchema = z.object({
  id: z.string(),
  placeId: z.string(),
  /** Null = PLACE-WIDE row ("All calendars") — see CalendarAvailabilityRow. */
  calendarId: z.string().nullable(),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  date: z.date().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  isOpen: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// ── List ────────────────────────────────────────────────────────────────────

export const listCalendarsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
  })
  .strict();

export type ListCalendarsInput = z.infer<typeof listCalendarsInputSchema>;

export const listCalendarsOutputSchema = z.array(calendarWithSpacesRowSchema);

/** Owner-gated management read: calendars WITH their joined spaces. */
export async function listCalendars(
  deps: ManageCalendarsDeps,
  rawInput: unknown,
): Promise<CalendarWithSpacesRow[]> {
  const input = parseInput(listCalendarsInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  return deps.repos.calendars.listByPlace(input.placeId);
}

// ── Create ──────────────────────────────────────────────────────────────────

/**
 * Booking config layer (venue-confirmation spec, docs/specs/2026-08-27
 * "Calendar is the config layer"): which intents the calendar accepts, its
 * flat rental rate, and whether the rate shows publicly. Shared by create and
 * update; every field optional (omitted = DB default on create, untouched on
 * update). `rentalMode` is deliberately NOT accepted — `INSTANT` is reserved
 * for its own spec; every calendar stays `REQUEST` until then.
 */
const calendarBookingConfigInputShape = {
  acceptsPerform: z.boolean().optional(),
  acceptsRent: z.boolean().optional(),
  acceptsUse: z.boolean().optional(),
  /** Flat rate per booking, integer minor units, ≥ 0; null = no rate stated. */
  rentalRateCents: z.number().int().min(0).nullable().optional(),
  /** ISO-4217, three uppercase letters; null = unset. */
  rentalRateCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Must be a 3-letter ISO currency code")
    .nullable()
    .optional(),
  rentalRateVisible: z.boolean().optional(),
} as const;

/**
 * A rate is an amount AND a currency: both set, or both null. Omitted counts
 * as null on create (the DB default), and a patch that carries one must
 * carry the other — the resulting row is then always a valid pair without
 * reading the current row.
 */
export function refineRentalRatePair(
  value: { rentalRateCents?: number | null; rentalRateCurrency?: string | null },
  ctx: z.RefinementCtx,
): void {
  const cents = value.rentalRateCents ?? null;
  const currency = value.rentalRateCurrency ?? null;
  if ((cents === null) !== (currency === null)) {
    ctx.addIssue({
      code: "custom",
      message: "rental_rate_requires_amount_and_currency",
      path: [cents === null ? "rentalRateCents" : "rentalRateCurrency"],
    });
  }
}

/**
 * The PATCH form of the pair rule: a patch that carries either half (even as
 * null) must carry both, so the resulting row is a valid pair without
 * reading the current one. A patch carrying neither leaves the rate alone.
 */
function refineRentalRatePatch(
  value: { rentalRateCents?: number | null; rentalRateCurrency?: string | null },
  ctx: z.RefinementCtx,
): void {
  const hasCents = value.rentalRateCents !== undefined;
  const hasCurrency = value.rentalRateCurrency !== undefined;
  if (hasCents !== hasCurrency) {
    ctx.addIssue({
      code: "custom",
      message: "rental_rate_patch_requires_both_halves",
      path: [hasCents ? "rentalRateCurrency" : "rentalRateCents"],
    });
    return;
  }
  if (hasCents) refineRentalRatePair(value, ctx);
}

export const createCalendarInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    name: plainTextRequired(140),
    /** Optional explicit slug; derived from `name` when absent. */
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .max(CALENDAR_SLUG_MAX)
      .regex(SLUG_REGEX, "Must be a lowercase kebab-case slug")
      .optional(),
    description: plainTextMultilineOptional(1000).nullable().optional(),
    defaultStartTime: z
      .string()
      .regex(TIME_24H_REGEX, "Must be HH:mm (24h)")
      .nullable()
      .optional(),
    defaultCategoryId: z.string().uuid().nullable().optional(),
    eventTemplate: eventTemplateSchema.nullable().optional(),
    /**
     * Spaces the calendar schedules into, joined in the SAME transaction as
     * the calendar row. REQUIRED, min 1 — every calendar has ≥1 space
     * (venue-confirmation spec). Every id must belong to `placeId`, and at
     * least one must be ACTIVE — see {@link createCalendar}.
     */
    spaceIds: z.array(z.string().uuid()).min(1).max(200),
    ...calendarBookingConfigInputShape,
  })
  .strict()
  .superRefine(refineRentalRatePair);

/** The booking-config keys present on the input, and nothing else. */
function pickBookingConfig(input: {
  acceptsPerform?: boolean;
  acceptsRent?: boolean;
  acceptsUse?: boolean;
  rentalRateCents?: number | null;
  rentalRateCurrency?: string | null;
  rentalRateVisible?: boolean;
}) {
  return {
    ...(input.acceptsPerform !== undefined ? { acceptsPerform: input.acceptsPerform } : {}),
    ...(input.acceptsRent !== undefined ? { acceptsRent: input.acceptsRent } : {}),
    ...(input.acceptsUse !== undefined ? { acceptsUse: input.acceptsUse } : {}),
    ...(input.rentalRateCents !== undefined ? { rentalRateCents: input.rentalRateCents } : {}),
    ...(input.rentalRateCurrency !== undefined ? { rentalRateCurrency: input.rentalRateCurrency } : {}),
    ...(input.rentalRateVisible !== undefined ? { rentalRateVisible: input.rentalRateVisible } : {}),
  };
}

/** `UseCaseInput` suffix: avoids shadowing `@th/ports`' repo-level `CreateCalendarInput`. */
export type CreateCalendarUseCaseInput = z.infer<
  typeof createCalendarInputSchema
>;

export const createCalendarOutputSchema = calendarRowSchema;

/**
 * Create a (non-default) calendar.
 *
 * Slug behaviour:
 * - Absent → derived from `name` via the shared `slugSegment` slugifier (the
 *   same primitive place slugs use), then de-duped against the place's
 *   existing calendars with a numeric suffix ("live-music", "live-music-2").
 * - Explicit → collision with an existing slug of the SAME place throws
 *   `CALENDAR_SLUG_TAKEN` (the caller chose it; silently renaming it would be
 *   surprising).
 * - Race backstop: two concurrent creates can pass the in-tx pre-check and
 *   land on the `@@unique([placeId, slug])` index — the Step-5 adapter maps
 *   that P2002 to `CALENDAR_SLUG_TAKEN` (see CalendarsRepo.create docs).
 *
 * `isDefault` is never set here — see the module header.
 *
 * Spaces: `spaceIds` (≥1) are re-fetched and asserted to belong to
 * `input.placeId` INSIDE the transaction — the same cross-place choke point
 * as {@link assignCalendarSpaces} — then joined by the repo in the same
 * transaction as the calendar row. At least one of them must be ACTIVE
 * (`CALENDAR_REQUIRES_ACTIVE_SPACE`): the schema's `min(1)` buys one JOIN,
 * and a calendar joined only to retired rooms is exactly the roomless
 * calendar the 2026-09-23 ruling outlaws.
 */
export async function createCalendar(
  deps: ManageCalendarsDeps,
  rawInput: unknown,
): Promise<CalendarRow> {
  const input = parseInput(createCalendarInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  const uniqueSpaceIds = [...new Set(input.spaceIds)];

  const calendar = await deps.repos.tx(async (tx) => {
    const calendars = calendarsIn(tx);
    const spaces = spacesIn(tx);
    // Same-place assert on every space BEFORE the calendar row exists
    // (mirrors assignCalendarSpaces: a missing id and a foreign one are
    // indistinguishable — SPACE_NOT_FOUND names the first offender).
    const spaceRows = await spaces.findByIds(uniqueSpaceIds);
    const spacesById = new Map(spaceRows.map((space) => [space.id, space]));
    const resolved: SpaceRow[] = [];
    for (const spaceId of uniqueSpaceIds) {
      const space = spacesById.get(spaceId);
      if (!space || space.placeId !== input.placeId) {
        throw fail("SPACE_NOT_FOUND", { meta: { spaceId } });
      }
      resolved.push(space);
    }
    // ≥1 ACTIVE space, not merely ≥1 join — the schema's `min(1)` cannot say
    // this (owner ruling 2026-09-23). Retired rooms may still be carried on
    // the set, they just cannot be the whole of it. The first ACTIVE member is
    // also the PRIMARY the DB pins this calendar to (2026-09-24), so one pick
    // answers both questions.
    const primary = pickPrimarySpace(resolved);
    if (!primary) {
      throw fail("CALENDAR_REQUIRES_ACTIVE_SPACE", {
        meta: { placeId: input.placeId, spaceIds: uniqueSpaceIds },
      });
    }

    const existing = await calendars.listByPlace(input.placeId);
    const taken = new Set(existing.map((c) => c.slug));

    let slug: string;
    if (input.slug) {
      if (taken.has(input.slug)) {
        throw fail("CALENDAR_SLUG_TAKEN", {
          meta: { placeId: input.placeId, slug: input.slug },
        });
      }
      slug = input.slug;
    } else {
      const base = slugSegment(
        input.name,
        CALENDAR_SLUG_FALLBACK,
        CALENDAR_SLUG_MAX,
      );
      slug = base;
      let n = 2;
      while (taken.has(slug)) {
        // Suffix headroom: `base` may already sit at CALENDAR_SLUG_MAX, so
        // trim it to leave room for `-${n}` — a slug the system minted must
        // round-trip through the explicit-slug schema (`.max` + kebab regex).
        // Strip any hyphen the cut leaves dangling so the regex still holds.
        const trimmed = base
          .slice(0, CALENDAR_SLUG_MAX - (String(n).length + 1))
          .replace(/-+$/, "");
        slug = `${trimmed}-${n}`;
        n += 1;
      }
    }

    const created = await calendars.create({
      placeId: input.placeId,
      name: input.name,
      slug,
      description: input.description ?? null,
      defaultStartTime: input.defaultStartTime ?? null,
      defaultCategoryId: input.defaultCategoryId ?? null,
      eventTemplate: input.eventTemplate ?? null,
      // isDefault intentionally omitted (defaults to false) — the default
      // calendar exists from place creation.
      spaceIds: uniqueSpaceIds,
      // The room the DB will hold this calendar to (owner ruling 2026-09-24).
      // The FK refuses anything RETIRED, so a space retired between the read
      // above and this write surfaces as CALENDAR_REQUIRES_ACTIVE_SPACE from
      // the adapter rather than committing a roomless calendar.
      primarySpaceId: primary.id,
      // Booking config (only what was given — the DB owns the defaults:
      // perform on, rent/use off, mode REQUEST).
      ...pickBookingConfig(input),
    });
    await tx.audit.log({
      entity: "calendar",
      entityId: created.id,
      action: "created",
      data: {
        placeId: input.placeId,
        actorHumanId: input.actorHumanId,
        name: input.name,
        slug,
        spaceIds: uniqueSpaceIds,
      },
      at: deps.clock.now(),
    });
    return created;
  });

  deps.logger?.info("calendar_created", {
    calendarId: calendar.id,
    placeId: input.placeId,
  });

  // ── Availability-onboarding FR-003: calendar created, place unconfigured ──
  // Post-commit, best-effort. Unconditional call: the hook returns without
  // sending when the place already has availability rows, and its durable
  // claim caps the nudge at one per place.
  if (deps.notifyAvailabilitySetupNeeded) {
    try {
      await deps.notifyAvailabilitySetupNeeded({
        placeId: input.placeId,
        actorHumanId: input.actorHumanId,
      });
    } catch (error) {
      deps.logger?.error("places.availability_setup_notify_failed", {
        placeId: input.placeId,
        calendarId: calendar.id,
        actorHumanId: input.actorHumanId,
        err: error,
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "createCalendar" },
          extra: { placeId: input.placeId, calendarId: calendar.id },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never fail the
        // committed create.
      }
    }
  }

  return calendar;
}

// ── Update ──────────────────────────────────────────────────────────────────

export const updateCalendarInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    calendarId: z.string().uuid(),
    // No `slug` / `isDefault` — see the module header.
    patch: z
      .object({
        name: plainTextRequired(140).optional(),
        description: plainTextMultilineOptional(1000).nullable().optional(),
        defaultStartTime: z
          .string()
          .regex(TIME_24H_REGEX, "Must be HH:mm (24h)")
          .nullable()
          .optional(),
        defaultCategoryId: z.string().uuid().nullable().optional(),
        /** Prefill defaults blob — must be a plain object when present. */
        eventTemplate: eventTemplateSchema.nullable().optional(),
        ...calendarBookingConfigInputShape,
      })
      .strict()
      .superRefine(refineRentalRatePatch),
  })
  .strict();

/** `UseCaseInput` suffix: avoids shadowing `@th/ports`' repo-level `UpdateCalendarInput`. */
export type UpdateCalendarUseCaseInput = z.infer<
  typeof updateCalendarInputSchema
>;

export const updateCalendarOutputSchema = calendarRowSchema;

export async function updateCalendar(
  deps: ManageCalendarsDeps,
  rawInput: unknown,
): Promise<CalendarRow> {
  const input = parseInput(updateCalendarInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  const calendar = await deps.repos.tx(async (tx) => {
    const calendars = calendarsIn(tx);
    // Same-place assert INSIDE the mutation's transaction (cross-place
    // isolation — see module header).
    const existing = await calendars.findById(input.calendarId);
    if (!existing || existing.placeId !== input.placeId) {
      throw fail("CALENDAR_NOT_FOUND");
    }

    const updated = await calendars.update({
      id: input.calendarId,
      ...input.patch,
    });
    await tx.audit.log({
      entity: "calendar",
      entityId: input.calendarId,
      action: "updated",
      data: {
        placeId: input.placeId,
        actorHumanId: input.actorHumanId,
        patch: input.patch,
      },
      at: deps.clock.now(),
    });
    return updated;
  });

  deps.logger?.info("calendar_updated", {
    calendarId: calendar.id,
    placeId: input.placeId,
  });
  return calendar;
}

// ── Assign spaces ────────────────────────────────────────────────────────────

export const assignCalendarSpacesInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    calendarId: z.string().uuid(),
    /**
     * FULL replacement set, min 1 — every calendar has ≥1 space
     * (venue-confirmation spec). An empty set is `invalid_input` at the
     * boundary; the repo refuses it too (`calendar_requires_space`). The use
     * case additionally requires ≥1 ACTIVE space in the set — see
     * {@link assignCalendarSpaces}.
     */
    spaceIds: z.array(z.string().uuid()).min(1).max(200),
  })
  .strict();

export type AssignCalendarSpacesInput = z.infer<
  typeof assignCalendarSpacesInputSchema
>;

/** Returns the place's FULL refreshed calendar list (same shape as list). */
export const assignCalendarSpacesOutputSchema = z.array(
  calendarWithSpacesRowSchema,
);

/**
 * Replace a calendar's CalendarSpace joins. THE cross-place choke point: the
 * join table has no guard, so the calendar AND every space are re-fetched and
 * asserted to belong to `input.placeId` inside the transaction before
 * `setSpaces` runs.
 *
 * The resulting set must contain at least one ACTIVE space
 * (`CALENDAR_REQUIRES_ACTIVE_SPACE`, owner ruling 2026-09-23). Deliberately
 * "at least one", not "all": the admin checklist lists retired rooms so an
 * owner can keep or un-join them, and re-submitting an existing retired join
 * alongside a live room must keep working.
 *
 * REPOINTS THE PRIMARY. `Calendar.primarySpaceId` is FK-pinned to an ACTIVE
 * Space (owner ruling 2026-09-24) but NOT to the calendar's own join set, so a
 * replacement that dropped the current primary and left the column alone would
 * leave it naming a room the calendar no longer serves. The primary therefore
 * travels WITH the set: it becomes the first ACTIVE member of the NEW set,
 * which is a no-op when the current primary survives (`pickPrimarySpace`
 * returns the same row) and a repoint when it does not.
 *
 * The ACTIVE check is still check-then-act against a space another transaction
 * may be retiring — but the advisory lock that used to serialize that is gone
 * (2026-09-24). The FK is the backstop: a primary retired out from under this
 * write fails "Calendar_primarySpaceId_primarySpaceStatus_fkey", which the
 * adapter maps back to `CALENDAR_REQUIRES_ACTIVE_SPACE`. And the unconditional
 * `primarySpaceId` write inside `setSpaces` takes the Calendar row's lock,
 * which is what makes a concurrent `setSpaceStatus` serialize behind this one
 * instead of promoting around it.
 */
export async function assignCalendarSpaces(
  deps: ManageCalendarsDeps,
  rawInput: unknown,
): Promise<CalendarWithSpacesRow[]> {
  const input = parseInput(assignCalendarSpacesInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  const uniqueSpaceIds = [...new Set(input.spaceIds)];

  await deps.repos.tx(async (tx) => {
    const calendars = calendarsIn(tx);
    const spaces = spacesIn(tx);

    const calendar = await calendars.findById(input.calendarId);
    if (!calendar || calendar.placeId !== input.placeId) {
      throw fail("CALENDAR_NOT_FOUND");
    }

    // ONE batched read for the whole set (SpacesRepo.findByIds) — same
    // semantics as the per-id loop it replaced: a missing id and a foreign
    // one are indistinguishable (SPACE_NOT_FOUND names the first offender).
    const spaceRows = await spaces.findByIds(uniqueSpaceIds);
    const spacesById = new Map(spaceRows.map((space) => [space.id, space]));
    const resolved: SpaceRow[] = [];
    for (const spaceId of uniqueSpaceIds) {
      const space = spacesById.get(spaceId);
      if (!space || space.placeId !== input.placeId) {
        throw fail("SPACE_NOT_FOUND", { meta: { spaceId } });
      }
      resolved.push(space);
    }
    // The REPLACEMENT set must leave the calendar a room to schedule into
    // (owner ruling 2026-09-23) — an all-retired set is a roomless calendar by
    // another route. Retired ids may ride along for history; they just cannot
    // be the whole set. The same pick names the PRIMARY the DB will hold this
    // calendar to (2026-09-24), so one decision serves both.
    const primary = pickPrimarySpace(resolved);
    if (!primary) {
      throw fail("CALENDAR_REQUIRES_ACTIVE_SPACE", {
        meta: {
          placeId: input.placeId,
          calendarId: input.calendarId,
          spaceIds: uniqueSpaceIds,
        },
      });
    }

    await calendars.setSpaces({
      calendarId: input.calendarId,
      spaceIds: uniqueSpaceIds,
      primarySpaceId: primary.id,
    });
    await tx.audit.log({
      entity: "calendar",
      entityId: input.calendarId,
      action: "calendar.spaces_assigned",
      data: {
        placeId: input.placeId,
        actorHumanId: input.actorHumanId,
        spaceIds: uniqueSpaceIds,
        primarySpaceId: primary.id,
      },
      at: deps.clock.now(),
    });
  });

  deps.logger?.info("calendar_spaces_assigned", {
    calendarId: input.calendarId,
    placeId: input.placeId,
    spaceCount: uniqueSpaceIds.length,
  });
  return deps.repos.calendars.listByPlace(input.placeId);
}

// ── Availability: list ──────────────────────────────────────────────────────

export const listCalendarAvailabilityInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
  })
  .strict();

export type ListCalendarAvailabilityInput = z.infer<
  typeof listCalendarAvailabilityInputSchema
>;

export const listCalendarAvailabilityOutputSchema = z.array(
  calendarAvailabilityRowSchema,
);

/**
 * Owner-gated: ALL availability rows for the place — calendar-scoped rows AND
 * place-wide rows (`calendarId` null = applies to every calendar, FR-007).
 * One merged read on purpose (see CalendarsRepo.listAvailabilityForPlace).
 */
export async function listCalendarAvailability(
  deps: ManageCalendarsDeps,
  rawInput: unknown,
): Promise<CalendarAvailabilityRow[]> {
  const input = parseInput(listCalendarAvailabilityInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  return deps.repos.calendars.listAvailabilityForPlace(input.placeId);
}

// ── Availability: upsert ────────────────────────────────────────────────────

/**
 * FULL-PUT semantics: every field of the row is a full replacement — nothing
 * here is a partial patch (the superRefine's dayOfWeek-XOR-date check already
 * forces callers to restate the row's shape on every write). That is why
 * `isOpen` is REQUIRED with no default: with a `.default(true)`, editing a
 * blackout's note while omitting `isOpen` would silently reopen every
 * calendar on that date. Omitting it must be a validation error, never a
 * silent `true`.
 */
export const upsertCalendarAvailabilityInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    /** Present = update that row; absent = create. */
    id: z.string().uuid().optional(),
    /** Null/absent = PLACE-WIDE row ("All calendars"). */
    calendarId: z.string().uuid().nullable().optional(),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    date: z.coerce.date().nullable().optional(),
    startTime: z
      .string()
      .regex(TIME_24H_REGEX, "Must be HH:mm (24h)")
      .nullable()
      .optional(),
    endTime: z
      .string()
      .regex(TIME_24H_REGEX, "Must be HH:mm (24h)")
      .nullable()
      .optional(),
    /** REQUIRED — see the schema doc above (full-PUT, no silent reopen). */
    isOpen: z.boolean(),
    note: plainTextMultilineOptional(500).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // The schema documents the shape as an exclusive-or: a row is EITHER a
    // recurring weekday window (dayOfWeek set, date null) OR a specific-date
    // exception (date set, dayOfWeek null) — never both, never neither.
    const hasDay = v.dayOfWeek != null;
    const hasDate = v.date != null;
    if (hasDay === hasDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of dayOfWeek or date",
      });
    }
  });

/** `UseCaseInput` suffix: avoids shadowing `@th/ports`' repo-level type. */
export type UpsertCalendarAvailabilityUseCaseInput = z.infer<
  typeof upsertCalendarAvailabilityInputSchema
>;

export const upsertCalendarAvailabilityOutputSchema =
  calendarAvailabilityRowSchema;

export async function upsertCalendarAvailability(
  deps: ManageCalendarsDeps,
  rawInput: unknown,
): Promise<CalendarAvailabilityRow> {
  const input = parseInput(upsertCalendarAvailabilityInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  const row = await deps.repos.tx(async (tx) => {
    const calendars = calendarsIn(tx);

    // Same-place assert on the scoping calendar (place-wide rows skip this —
    // they carry no calendarId to forge).
    if (input.calendarId != null) {
      const calendar = await calendars.findById(input.calendarId);
      if (!calendar || calendar.placeId !== input.placeId) {
        throw fail("CALENDAR_NOT_FOUND");
      }
    }

    if (input.id) {
      // The row must belong to this place (a foreign row id reads as missing),
      // and its place-wide/per-calendar scoping is immutable on update (port
      // contract) — re-scoping is delete + create.
      const rows = await calendars.listAvailabilityForPlace(input.placeId);
      const existing = rows.find((r) => r.id === input.id);
      if (!existing) {
        throw fail("AVAILABILITY_NOT_FOUND");
      }
      if ((input.calendarId ?? null) !== existing.calendarId) {
        throw fail("AVAILABILITY_NOT_FOUND", {
          meta: { reason: "calendar_scope_immutable" },
        });
      }
    }

    const upserted = await calendars.upsertAvailability({
      id: input.id,
      placeId: input.placeId,
      calendarId: input.calendarId ?? null,
      dayOfWeek: input.dayOfWeek ?? null,
      date: input.date ?? null,
      startTime: input.startTime ?? null,
      endTime: input.endTime ?? null,
      isOpen: input.isOpen,
      note: input.note ?? null,
    });
    await tx.audit.log({
      entity: "calendar_availability",
      entityId: upserted.id,
      action: input.id ? "updated" : "created",
      data: {
        placeId: input.placeId,
        calendarId: input.calendarId ?? null,
        actorHumanId: input.actorHumanId,
        isOpen: input.isOpen,
      },
      at: deps.clock.now(),
    });
    return upserted;
  });

  deps.logger?.info("calendar_availability_upserted", {
    id: row.id,
    placeId: input.placeId,
    calendarId: row.calendarId,
  });
  return row;
}

// ── Availability: delete ────────────────────────────────────────────────────

export const deleteCalendarAvailabilityInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    id: z.string().uuid(),
  })
  .strict();

/** `UseCaseInput` suffix: avoids shadowing `@th/ports`' repo-level type. */
export type DeleteCalendarAvailabilityUseCaseInput = z.infer<
  typeof deleteCalendarAvailabilityInputSchema
>;

export const deleteCalendarAvailabilityOutputSchema = z.object({
  deleted: z.literal(true),
});

/**
 * Idempotent delete. Cross-place isolation is enforced by the PORT contract
 * here: the adapter deletes with BOTH `id` AND `placeId` in the WHERE clause,
 * so a forged row id from another place matches zero rows and no-ops.
 */
export async function deleteCalendarAvailability(
  deps: ManageCalendarsDeps,
  rawInput: unknown,
): Promise<{ deleted: true }> {
  const input = parseInput(deleteCalendarAvailabilityInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  await deps.repos.tx(async (tx) => {
    await calendarsIn(tx).deleteAvailability({
      id: input.id,
      placeId: input.placeId,
    });
    await tx.audit.log({
      entity: "calendar_availability",
      entityId: input.id,
      action: "deleted",
      data: { placeId: input.placeId, actorHumanId: input.actorHumanId },
      at: deps.clock.now(),
    });
  });

  deps.logger?.info("calendar_availability_deleted", {
    id: input.id,
    placeId: input.placeId,
  });
  return { deleted: true };
}
