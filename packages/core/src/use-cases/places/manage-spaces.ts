import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { CalendarsRepo } from "@th/ports/repos/calendars";
import type { SpaceRow, SpacesRepo, SpaceStatus } from "@th/ports/repos/spaces";
import { fail } from "@th/errors";
import { parseInput } from "../../lib/io";
import { plainTextRequired } from "../../lib/sanitize-plain-text";
import {
  calendarsStrandedByRetiring,
  primaryPromotionsForRetiring,
} from "./_shared/calendar-active-space";
import { ensurePlaceOwnerAccess } from "./_shared/ensure-place-owner-access";

// ─────────────────────────────────────────────────────────────────────────────
// Spaces management (venue-hierarchy FR-001;
// docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml).
//
// Spaces are the concrete physical resources conflicts resolve to. They are
// RETIRED, never hard-deleted (the port exposes no delete), and a place can
// never reach zero ACTIVE spaces — nor can any ONE of its calendars (owner
// ruling 2026-09-23; see ./_shared/calendar-active-space.ts).
//
// CROSS-PLACE ISOLATION: nothing in the schema stops addressing org A's space
// through org B's place. Every operation that accepts a `spaceId` therefore
// re-fetches the row and asserts `space.placeId === input.placeId` INSIDE the
// same `repos.tx()` as the mutation. A foreign space id is deliberately
// indistinguishable from a missing one (`SPACE_NOT_FOUND`).
// ─────────────────────────────────────────────────────────────────────────────

export type ManageSpacesDeps = {
  /**
   * `spaces` and `calendars` are both required on the aggregate — the
   * `Required<Pick>` is redundant but harmless, kept so this type reads as an
   * explicit statement of what the use case consumes. `calendars` is here for
   * the per-calendar retire guard (owner ruling 2026-09-23).
   */
  repos: Repos & Required<Pick<Repos, "spaces" | "calendars">>;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Transaction-scoped spaces repo. The repo is REQUIRED on the aggregate
 * (Step 5), so this guard is unreachable — it exists to fail loudly instead
 * of `undefined`-crashing if a hand-built test/composition bag regresses.
 */
function spacesIn(tx: TxRepos): SpacesRepo {
  if (!tx.spaces) {
    throw fail("NOT_CONFIGURED", { message: "spaces repo missing from tx" });
  }
  return tx.spaces;
}

/** Twin of {@link spacesIn} for the calendars repo (also required on the aggregate). */
function calendarsIn(tx: TxRepos): CalendarsRepo {
  if (!tx.calendars) {
    throw fail("NOT_CONFIGURED", { message: "calendars repo missing from tx" });
  }
  return tx.calendars;
}

const spaceRowSchema = z.object({
  id: z.string(),
  placeId: z.string(),
  name: z.string(),
  capacity: z.number().int().nullable(),
  sortOrder: z.number().int(),
  status: z.enum(["ACTIVE", "RETIRED"] satisfies readonly SpaceStatus[]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// ── List ────────────────────────────────────────────────────────────────────

export const listSpacesInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    /** Include RETIRED spaces (admin/history views). Defaults to false. */
    includeRetired: z.boolean().optional().default(false),
  })
  .strict();

export type ListSpacesInput = z.infer<typeof listSpacesInputSchema>;

export const listSpacesOutputSchema = z.array(spaceRowSchema);

/** Owner-gated: spaces are admin-facing only (no public per-space surfaces). */
export async function listSpaces(
  deps: ManageSpacesDeps,
  rawInput: unknown,
): Promise<SpaceRow[]> {
  const input = parseInput(listSpacesInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  return deps.repos.spaces.listByPlace({
    placeId: input.placeId,
    includeRetired: input.includeRetired,
  });
}

// ── Create ──────────────────────────────────────────────────────────────────

export const createSpaceInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    name: plainTextRequired(140),
    capacity: z
      .number()
      .int()
      .positive()
      .max(200_000)
      .nullable()
      .optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

/** `UseCaseInput` suffix: avoids shadowing `@th/ports`' repo-level `CreateSpaceInput`. */
export type CreateSpaceUseCaseInput = z.infer<typeof createSpaceInputSchema>;

export const createSpaceOutputSchema = spaceRowSchema;

export async function createSpace(
  deps: ManageSpacesDeps,
  rawInput: unknown,
): Promise<SpaceRow> {
  const input = parseInput(createSpaceInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  const space = await deps.repos.tx(async (tx) => {
    const spaces = spacesIn(tx);
    const created = await spaces.create({
      placeId: input.placeId,
      name: input.name,
      capacity: input.capacity ?? null,
      sortOrder: input.sortOrder ?? 0,
    });
    await tx.audit.log({
      entity: "space",
      entityId: created.id,
      action: "created",
      data: {
        placeId: input.placeId,
        actorHumanId: input.actorHumanId,
        name: input.name,
      },
      at: deps.clock.now(),
    });
    return created;
  });

  deps.logger?.info("space_created", { spaceId: space.id, placeId: input.placeId });
  return space;
}

// ── Update ──────────────────────────────────────────────────────────────────

export const updateSpaceInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    spaceId: z.string().uuid(),
    patch: z
      .object({
        name: plainTextRequired(140).optional(),
        capacity: z
          .number()
          .int()
          .positive()
          .max(200_000)
          .nullable()
          .optional(),
        sortOrder: z.number().int().min(0).max(100_000).optional(),
      })
      .strict(),
  })
  .strict();

/** `UseCaseInput` suffix: avoids shadowing `@th/ports`' repo-level `UpdateSpaceInput`. */
export type UpdateSpaceUseCaseInput = z.infer<typeof updateSpaceInputSchema>;

export const updateSpaceOutputSchema = spaceRowSchema;

export async function updateSpace(
  deps: ManageSpacesDeps,
  rawInput: unknown,
): Promise<SpaceRow> {
  const input = parseInput(updateSpaceInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  const space = await deps.repos.tx(async (tx) => {
    const spaces = spacesIn(tx);
    // Same-place assert INSIDE the mutation's transaction (cross-place
    // isolation — see module header).
    const existing = await spaces.findById(input.spaceId);
    if (!existing || existing.placeId !== input.placeId) {
      throw fail("SPACE_NOT_FOUND");
    }

    const updated = await spaces.update({
      id: input.spaceId,
      ...input.patch,
    });
    await tx.audit.log({
      entity: "space",
      entityId: input.spaceId,
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

  deps.logger?.info("space_updated", { spaceId: space.id, placeId: input.placeId });
  return space;
}

// ── Set status (retire / reactivate) ────────────────────────────────────────

export const setSpaceStatusInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid(),
    spaceId: z.string().uuid(),
    status: z.enum(["ACTIVE", "RETIRED"] satisfies readonly SpaceStatus[]),
  })
  .strict();

export type SetSpaceStatusInput = z.infer<typeof setSpaceStatusInputSchema>;

export const setSpaceStatusOutputSchema = spaceRowSchema;

/**
 * Retire / reactivate a space — the ONLY lifecycle exit (no hard delete).
 *
 * TWO invariants, both true, both read inside the same transaction as the
 * write:
 *
 * 1. A PLACE can never reach zero ACTIVE spaces →
 *    `CANNOT_RETIRE_LAST_ACTIVE_SPACE`.
 * 2. No ONE CALENDAR of that place may be left with zero ACTIVE spaces →
 *    `CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR`, whose `meta.calendars`
 *    names the blockers so the venue can go fix them.
 *
 * The place-level count does NOT imply the per-calendar one: a place with
 * three rooms, where calendar A is joined only to room 1, keeps two active
 * rooms when room 1 retires and strands calendar A. That is exactly how
 * roomless calendars came into existence before the owner ruling of
 * 2026-09-23 (see ./_shared/calendar-active-space.ts).
 *
 * ── AUTO-PROMOTION, not refusal (owner ruling 2026-09-24) ──
 * Since the invariant became a DB constraint, every calendar names a
 * `primarySpaceId` the FK pins to an ACTIVE space. Retiring a space that is
 * some calendar's primary therefore CANNOT succeed until that calendar is
 * repointed — but refusing on those grounds would be a refusal about
 * bookkeeping, not about the venue: the calendar may well have three other
 * active rooms. So this use case PROMOTES the calendar's next active room
 * instead, and only refuses when the room being retired is genuinely a
 * calendar's last active one. That keeps
 * `CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR` a statement about the venue.
 *
 * ── ORDER OF OPERATIONS IS THE CONCURRENCY ARGUMENT ──
 * The advisory lock that used to serialize this against `assignCalendarSpaces`
 * is GONE (2026-09-24). What replaces it is not "nothing":
 *
 *   PRE-WRITE the stranded check runs on a possibly-stale read. Its job is the
 *   MESSAGE — naming the blocking calendars, and refusing before the FK can
 *   answer in Postgres wording. It is deliberately not trusted as the guard.
 *
 *   THE WRITES take real row locks. Promoting a calendar's primary locks that
 *   Calendar row, which is exactly the row `CalendarsRepo.setSpaces` writes
 *   unconditionally — so a concurrent space reassignment on the same calendar
 *   cannot interleave, it queues. Retiring the Space itself is refused
 *   outright by the FK if any calendar still names it.
 *
 *   POST-WRITE the check runs AGAIN, on a fresh statement snapshot. By then
 *   this transaction has blocked on (and therefore seen the commit of) every
 *   transaction that touched those rows, so this read is the sound one. It
 *   catches a racing reassignment that un-joins the very room we just promoted
 *   to.
 *
 *   Since 2026-09-24 that state is ALSO refused by the database — the second
 *   composite FK "Calendar_primary_space_joined_fkey" (migration
 *   20260924160000_calendar_primary_space_joined) makes "primary is not one of
 *   my joins" unrepresentable. So this re-read is no longer what makes the
 *   invariant hold; it is what makes the REFUSAL LEGIBLE. Remove it and the
 *   same interleaving still cannot commit, but it fails at COMMIT with a bare
 *   `DriverAdapterError` that nothing can map to a typed error, i.e. a 500
 *   instead of `CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR` naming the
 *   calendar. Both halves are measured in
 *   packages/adapters/test/integration/calendar-primary-space-race.test.ts.
 *
 * Retiring a space deliberately does NOT detach its CalendarSpace joins:
 * reactivation restores the calendar wiring exactly as it was.
 */
export async function setSpaceStatus(
  deps: ManageSpacesDeps,
  rawInput: unknown,
): Promise<SpaceRow> {
  const input = parseInput(setSpaceStatusInputSchema, rawInput);

  await ensurePlaceOwnerAccess(deps.repos, input.placeId, input.actorHumanId);

  /** Calendars repointed by the auto-promotion, for the audit row. */
  const promoted: { calendarId: string; spaceId: string }[] = [];

  const space = await deps.repos.tx(async (tx) => {
    // Reset per attempt — `repos.tx` may retry the callback, and an audit row
    // claiming promotions from a rolled-back attempt would be a lie.
    promoted.length = 0;
    const spaces = spacesIn(tx);
    const calendars = calendarsIn(tx);

    const existing = await spaces.findById(input.spaceId);
    if (!existing || existing.placeId !== input.placeId) {
      throw fail("SPACE_NOT_FOUND");
    }

    if (existing.status === input.status) {
      // Idempotent no-op — nothing to write, nothing to audit.
      return existing;
    }

    if (input.status === "RETIRED") {
      const activeCount = await spaces.countActiveForPlace(input.placeId);
      if (activeCount <= 1) {
        throw fail("CANNOT_RETIRE_LAST_ACTIVE_SPACE", {
          meta: { placeId: input.placeId, spaceId: input.spaceId },
        });
      }

      // Per-calendar arm. `listByPlace` returns each calendar's joined spaces
      // INCLUDING retired ones (documented on `CalendarWithSpacesRow.spaces`
      // in packages/types/src/repos/calendars.ts), which is exactly what
      // "would this leave the calendar roomless?" needs — and it is the same
      // read the calendars admin already runs, so no new port surface.
      const before = await calendars.listByPlace(input.placeId);
      const stranded = calendarsStrandedByRetiring(before, input.spaceId);
      if (stranded.length > 0) {
        throw fail("CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR", {
          meta: {
            placeId: input.placeId,
            spaceId: input.spaceId,
            calendars: stranded,
          },
        });
      }

      // AUTO-PROMOTE every calendar this space is the primary of. Nothing here
      // is stranded (the check above refused those), so each promotion has a
      // real ACTIVE survivor to move to. This must precede `setStatus`: the FK
      // refuses the retire outright while any calendar still names the space.
      for (const promotion of primaryPromotionsForRetiring(
        before,
        input.spaceId,
      )) {
        await calendars.setPrimarySpace(promotion);
        promoted.push(promotion);
      }
    }

    const updated = await spaces.setStatus({
      id: input.spaceId,
      status: input.status,
    });

    if (input.status === "RETIRED") {
      // THE SOUND CHECK (see the ordering note in the doc above). A fresh
      // statement snapshot, taken after this transaction has queued behind
      // every writer that touched the rows above — so unlike the pre-write
      // read, this one cannot be overtaken. Catches the interleaving the FK
      // structurally cannot see: a concurrent `assignCalendarSpaces` that
      // un-joined the room we just promoted to.
      const after = calendarsStrandedByRetiring(
        await calendars.listByPlace(input.placeId),
        input.spaceId,
      );
      if (after.length > 0) {
        throw fail("CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR", {
          meta: {
            placeId: input.placeId,
            spaceId: input.spaceId,
            calendars: after,
            // Distinguishes the two throw sites in logs and in Sentry: this
            // one only fires when something raced us.
            raced: true,
          },
        });
      }
    }

    await tx.audit.log({
      entity: "space",
      entityId: input.spaceId,
      action: "space.status_changed",
      data: {
        placeId: input.placeId,
        actorHumanId: input.actorHumanId,
        from: existing.status,
        to: input.status,
        // Empty on a reactivate and on a retire that displaced nothing.
        promotedPrimaries: promoted,
      },
      at: deps.clock.now(),
    });
    return updated;
  });

  deps.logger?.info("space_status_changed", {
    spaceId: space.id,
    placeId: input.placeId,
    status: space.status,
    promotedPrimaries: promoted.length,
  });
  return space;
}
