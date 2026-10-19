import type { BookingIntent } from "@th/types/repos/booking-requests";

import { fail } from "@th/errors";

import {
  loadEffectiveBookingStandardsForCalendar,
  type LoadEffectiveBookingStandardsDeps,
  type LoadEffectiveBookingStandardsInput,
} from "./load-effective-booking-standards";
import { unmetRequiredStandards } from "./resolve-booking-standards";
import type { BookingStandardsPayload } from "./standard-fields";

// ─────────────────────────────────────────────────────────────────────────────
// FR-006: the server half of "required items block submit". Shared by the
// two PITCH entrances — `createBookingRequest` (signed in) and
// `createBookingInquiry` (the anonymous embed) — so both refuse the same
// payload with the same list, and the form's inline errors (which run the
// same `unmetRequiredStandards` over the built payload) agree with both.
//
// Deliberately NOT part of `runBookingRequestGates`: the event-first path and
// the legacy-migration path run that walk too, and neither is a pitch.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Throws STANDARDS_UNMET `{ items: [{ field, label }] }` when the routed
 * calendar's effective standards for `intent` have REQUIRED items `payload`
 * does not satisfy. `label` is the VENUE's literal wording — only venue items
 * can be REQUIRED (platform defaults are SUGGESTED by type).
 *
 * Fails OPEN on a degraded read: the loader already logged + reported it and
 * resolved the platform defaults, which block nothing (NFR-002).
 */
export async function assertBookingStandardsMet(
  deps: LoadEffectiveBookingStandardsDeps,
  input: {
    place: LoadEffectiveBookingStandardsInput["place"];
    calendarId: string | null;
    intent: BookingIntent;
    /** The PARSED create payload — the same values the form's ticks evaluate. */
    payload: BookingStandardsPayload;
  },
): Promise<void> {
  const { effective } = await loadEffectiveBookingStandardsForCalendar(deps, {
    place: input.place,
    calendarId: input.calendarId,
    intent: input.intent,
  });
  const unmet = unmetRequiredStandards(effective.standards, input.payload);
  if (unmet.length > 0) {
    throw fail("STANDARDS_UNMET", {
      meta: {
        items: unmet.map((standard) => ({
          field: standard.field,
          label: standard.label,
        })),
      },
    });
  }
}
