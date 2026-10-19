import type { LocationObfuscationScope } from "./obfuscation-key";

/**
 * WHAT an event's obfuscation circle is keyed to — and therefore which events
 * share one.
 *
 * Keying by the event id alone gave every event its own independent circle.
 * An organizer who runs a weekly show at their house as separate events (a
 * series, or just re-listing it) handed out one fresh sample per event, and
 * the average of N independent circle centres converges on the house. So the
 * circle is keyed to the LOCATION instead, and every event at that location
 * draws the SAME circle chain — N events, one sample.
 *
 * The tiers, most specific first:
 *
 *   "event-point"   owner + the TRUE point rounded to 1e-5° (~1 m). The
 *                   point, not the address TEXT: "St" / "Street", a zip, a
 *                   unit number or a stray comma each made a new subject — a
 *                   new independent sample of the same house. Two spellings
 *                   that geocode to one point are one subject.
 *                   BOUND TO THE OWNER on purpose: a point-only key would let
 *                   anyone publish their own OBSCURED event at a guessed
 *                   location and compare its circle with the target's —
 *                   identical circles confirm the guess, which is exactly the
 *                   oracle the key exists to remove. An owner can only
 *                   reproduce circles for their own events. The point never
 *                   leaves the server: it is only HMAC input under the server
 *                   key (`obfuscation-key.ts`).
 *   "event-series"  the series id, for an event with no usable point (or no
 *                   owner) that belongs to a series.
 *   "event"         the event id — the last resort, and the tier for
 *                   ownerless (community) listings, whose point key anyone
 *                   could reproduce.
 *
 * Events at a WITHHELD venue never reach this: they draw the venue's own
 * circle (`projectPublicEventLocation`); an EXACT venue's events are keyed
 * here like any other event.
 */

/** The event fields the subject reads. Structural; all but `id` optional. */
export interface EventCircleSubjectSource {
  id: string;
  orgId?: string | null;
  humanId?: string | null;
  /** The event's TRUE point — the row's coordinates. */
  lat?: number | null;
  lng?: number | null;
  /**
   * The event's series, when the caller knows it. `EventRecord` does not
   * carry it, and no read path supplies it today: every event with public
   * coordinates also has a point, so the point tier always wins first. A
   * caller that supplies it must do so on EVERY surface that draws that
   * event, or two surfaces draw two circles.
   */
  seriesId?: string | null;
}

export interface EventCircleSubject {
  scope: Extract<
    LocationObfuscationScope,
    "event-point" | "event-series" | "event"
  >;
  id: string;
}

/** Decimal places the point is rounded to: 1e-5° ≈ 1.1 m of latitude. */
const POINT_KEY_DECIMALS = 5;

/**
 * The point as it enters the subject: rounded to 1e-5°, a fixed decimal
 * string (never exponent notation), `-0` folded to `0`. Null when either
 * coordinate is missing or not finite.
 */
export function roundPointForCircle(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }
  const fix = (value: number) => {
    const text = value.toFixed(POINT_KEY_DECIMALS);
    return Number(text) === 0 ? (0).toFixed(POINT_KEY_DECIMALS) : text;
  };
  return `${fix(lat)},${fix(lng)}`;
}

export function eventCircleSubject(
  event: EventCircleSubjectSource,
): EventCircleSubject {
  const owner = event.orgId
    ? `org:${event.orgId}`
    : event.humanId
      ? `human:${event.humanId}`
      : null;
  const point = roundPointForCircle(event.lat, event.lng);
  if (owner && point) {
    return { scope: "event-point", id: `${owner}\u001e${point}` };
  }
  if (event.seriesId) {
    return { scope: "event-series", id: event.seriesId };
  }
  return { scope: "event", id: event.id };
}
