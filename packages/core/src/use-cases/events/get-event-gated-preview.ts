import { DateTime } from "luxon";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { parseInput } from "../../lib/io";
import { resolveVisibleImageKeys } from "../moderation/gate-image-visibility";
import { isEventPubliclyReadable } from "./_shared/event-public-readability";
import { fail } from "@th/errors";

/**
 * Returns only the minimal "preview" data for a gated event:
 * - Event name (title)
 * - Hero image URL (first image if available)
 * - The DATE the gate shows (`gateDate`, a zone-free local `YYYY-MM-DD`) —
 *   owner ruling 2026-09-29: a gate may say WHEN, never WHERE. The event's
 *   IANA zone is NOT sent: "America/Boise" or "Europe/Madrid" names a city
 *   or country, so the calendar day is resolved here, server-side, and only
 *   the day leaves.
 *
 * This endpoint intentionally does NOT expose:
 * - Description, location (no city, no address, no venue), pricing,
 *   organizer, the rest of the schedule, etc.
 *
 * The output is IDENTITY-FREE: it rides an edge-cached gated document, so
 * every field must be the same for every viewer. The date is event-intrinsic
 * (it depends on the clock, not on who is asking).
 *
 * Use this when the event is password/application-gated and the viewer
 * hasn't unlocked access yet. This prevents inspector-savvy users from
 * accessing protected data.
 *
 * PUBLIC and anonymous, so it answers only for an event whose page is
 * publicly readable (`isEventPubliclyReadable`, place-address-withholding
 * N3): a DRAFT, or an event cancelled / archived without ever going live,
 * is EVENT_NOT_FOUND like a missing id. Otherwise this was an any-id → slug
 * oracle for drafts, whose slugs then read everything else.
 */

export const getEventGatedPreviewInputSchema = z
  .object({
    eventId: z.uuid(),
  })
  .strict();

export const getEventGatedPreviewOutputSchema = z.object({
  eventId: z.uuid(),
  slug: z.string(),
  title: z.string(),
  heroImageUrl: z.string().nullable(),
  /**
   * The date the gate shows, as the event's LOCAL calendar day
   * (`YYYY-MM-DD`, computed in the event's zone). Deliberately carries
   * neither an instant nor a zone — the zone names a place.
   *
   * Source instant: a single-date event → `Event.startsAt`. A recurring
   * listing (`recurrenceSchedule` set) → the first UPCOMING occurrence still
   * SCHEDULED, the same "lead date" rule `listEventDates` uses for the public
   * schedule; `null` when it has none (drained or ended — never the row's
   * own `startsAt`, which on a recurring listing is a past or synthetic
   * instant: the zero-dates ruling). Also `null` when the event has no
   * usable zone — no date beats a guessed one.
   */
  gateDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
})
  // The preview rides an edge-cached public document: an unknown key (an
  // instant, a zone) must never pass through.
  .strict();

export type GetEventGatedPreviewInput = z.infer<
  typeof getEventGatedPreviewInputSchema
>;
export type GetEventGatedPreviewOutput = z.infer<
  typeof getEventGatedPreviewOutputSchema
>;

export type GetEventGatedPreviewDeps = {
  repos: Pick<
    Repos,
    "events" | "images" | "imageModerationRecords" | "eventDates"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Best-effort reporter (ReporterPort convention). The recurring listing's
   * next-date read is swallowed to `gateDate: null` so it can never take the
   * gate wall down with it.
   */
  reportError?: ReporterPort;
};

/**
 * How many upcoming occurrence rows to scan for the first SCHEDULED one.
 * Cancelled nights sort in among them (see `EventDatesRepo.listUpcoming`), so
 * this is a bound on "how many called-off nights in a row before we give up
 * and show no date" — a wide one.
 */
const NEXT_DATE_SCAN_LIMIT = 50;

export async function getEventGatedPreview(
  deps: GetEventGatedPreviewDeps,
  rawInput: unknown,
): Promise<GetEventGatedPreviewOutput> {
  const input = parseInput(getEventGatedPreviewInputSchema, rawInput);
  const event = await deps.repos.events.getById(input.eventId, {
    withOwnerStanding: true,
  });
  if (!event || !isEventPubliclyReadable(event)) {
    throw fail("EVENT_NOT_FOUND");
  }

  // Get the current slug for the event
  const slug = event.slug ?? event.id;

  // Get primary image for this event, then apply the moderation visibility
  // gate — a pending/flagged hero must not leak on the gated preview.
  const imageRefMap = await deps.repos.images.getPrimaryImageRefs([event.id]);
  const primaryRef = imageRefMap.get(event.id) ?? null;
  let heroImageUrl: string | null = null;
  if (primaryRef) {
    const visibleKeys = await resolveVisibleImageKeys(deps.repos, [
      primaryRef.key,
    ]);
    heroImageUrl = visibleKeys.has(primaryRef.key) ? primaryRef.publicUrl : null;
  }

  const gateInstant = await resolveGateDate(deps, event);
  const gateDate = toLocalCalendarDate(gateInstant, event.timezone ?? null);
  if (gateInstant && !gateDate && event.timezone) {
    // An unknown zone is a data defect; the gate just shows no date, so make
    // it visible here rather than only as a missing date on the wall.
    deps.logger?.error("events.get_gated_preview.invalid_timezone", {
      eventId: event.id,
      timezone: event.timezone,
    });
  }

  deps.logger?.info("events.get_gated_preview", { eventId: event.id, slug });

  return getEventGatedPreviewOutputSchema.parse({
    eventId: event.id,
    slug,
    title: event.title,
    heroImageUrl,
    gateDate,
  });
}

/**
 * The instant whose local day the gate shows — see `gateDate` on the output
 * schema.
 *
 * Recurring listings read their occurrence rows; a failed read degrades to
 * `null` (no date on the wall) and is reported, never thrown: the date is
 * decoration on the gate, the gate itself must still render.
 */
async function resolveGateDate(
  deps: GetEventGatedPreviewDeps,
  event: {
    id: string;
    startsAt: Date;
    recurrenceSchedule?: unknown;
  },
): Promise<Date | null> {
  if (!event.recurrenceSchedule) {
    return event.startsAt ?? null;
  }
  try {
    const upcoming = await deps.repos.eventDates.listUpcoming({
      eventId: event.id,
      now: deps.clock.now(),
      limit: NEXT_DATE_SCAN_LIMIT,
    });
    // The lead date is the first still-SCHEDULED row, never `upcoming[0]` —
    // a called-off night sorts first like any other.
    return upcoming.find((d) => d.status === "SCHEDULED")?.startsAt ?? null;
  } catch (err) {
    deps.logger?.error("events.get_gated_preview.next_date_failed", {
      eventId: event.id,
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "getEventGatedPreview", step: "nextDate" },
        extra: { eventId: event.id },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // graceful null fallback into a thrown error.
    }
    return null;
  }
}

/**
 * The instant's calendar day in `zone`, as `YYYY-MM-DD`. `null` without an
 * instant or a valid zone (Luxon marks an unknown zone invalid rather than
 * throwing). `fromJSDate` is used rather than `fromObject`, which reads the
 * clock.
 */
function toLocalCalendarDate(
  instant: Date | null,
  zone: string | null,
): string | null {
  if (!instant || !zone) return null;
  const local = DateTime.fromJSDate(instant, { zone });
  return local.isValid ? local.toISODate() : null;
}
