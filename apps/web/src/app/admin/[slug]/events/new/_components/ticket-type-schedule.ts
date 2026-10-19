import { zonedWallClockToInstant } from "@/lib/template-shift-offset";
import type { TicketAmountField } from "./TicketTypeEditor";
import { toDateTimeLocalValue } from "./event-builder-helpers";

/**
 * The organizer-facing half of the scheduled price change
 * (docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-005 / FR-007).
 *
 * `TicketType.scheduledPriceAt` is an ABSOLUTE UTC instant. The organizer,
 * however, picks a WALL CLOCK — "8pm on the 3rd" — and means it on the venue's
 * clock, not on whatever clock the laptop they're editing from happens to be
 * set to. Everything here exists to make that one conversion explicit,
 * testable, and readable back.
 *
 * Three rules this module encodes, all of them load-bearing:
 *
 *  1. WALL CLOCK RESOLVES AGAINST `Event.timezone`, NEVER THE BROWSER'S. The
 *     conversion goes through {@link zonedWallClockToInstant}, the repo's
 *     existing bracketing resolver in `src/lib/template-shift-offset.ts` (the
 *     volunteer-shift work's FR-006 lesson, already DST-tested there).
 *     Deliberately NOT the `PAYOUT_TZ` / `REFUND_TZ` pattern from
 *     packages/core/src/lib/payout-scheduling — those hardcode
 *     America/Chicago, and the spec names them as the wrong precedent: a flip
 *     on that shortcut fires at the wrong hour for every non-Central event.
 *     NO NEW DEPENDENCY: apps/web does not have luxon and this does not add
 *     it; `Intl.DateTimeFormat` does the zone arithmetic.
 *
 *     `zonedWallClockToInstant` is the ONE resolver for wall clocks in this
 *     app — the event builder's own `toIsoInTimeZone` (`startsAt` / `endsAt`)
 *     goes through it too. Anything new that converts a wall clock should call
 *     it rather than probing the zone itself: a single probe at the naive UTC
 *     instant cannot see both sides of a transition, and is an hour wrong for
 *     any reading that lands on the far side of one. The transition-day cases
 *     are pinned both here and in `__tests__/event-builder-helpers.dst.test.ts`.
 *
 *  2. BOTH OR NEITHER. `normalizeScheduledPrice` in core rejects a
 *     half-configuration with TICKET_TYPE_SCHEDULE_INCOMPLETE. This resolver
 *     makes that unreachable from the UI by never producing one: it returns
 *     either a complete pair, an explicit `{ price: null, at: null }`, or an
 *     error that stops the submit before it starts.
 *
 *  3. MONEY IS READ BY THE SHARED PARSER. The post-flip price is a free-text
 *     field like every other money field in this editor, so it goes through
 *     `resolveTicketAmountField` (injected — see `readAmount`) rather than a
 *     second dollars→cents conversion. `parseFloat` on "15,50" is 15, and
 *     that bug class is not being reintroduced for the sake of one new field.
 */

/**
 * `<input type="datetime-local">` wall clock: `YYYY-MM-DDTHH:mm[:ss]`.
 *
 * Components are RANGE-CHECKED, not just shaped. `\d{2}` alone accepts
 * "2026-13-45T99:99", which `Date.UTC` then normalizes silently — month 13
 * rolls into the next year, hour 99 into four days later — so a value the
 * organizer could never have meant would resolve to a real instant and save
 * without complaint. Out of range now means `null`, i.e. a refused submit.
 * Day is capped at 31 here; 31 February is left to `readsBackAs` inside
 * `zonedWallClockToInstant`, which rejects any instant that doesn't read back
 * as the wall clock it was asked for.
 */
const WALL_CLOCK_PATTERN =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * Is this an IANA zone id the runtime actually knows?
 *
 * Checked explicitly because `zonedWallClockToInstant` DEGRADES an unknown
 * zone to UTC rather than throwing — sensible for its own caller (a volunteer
 * shift draft that stays editable beats no draft at all), and the wrong
 * default here. Silently resolving a price flip against UTC would put the
 * money change up to 14 hours off with nothing on screen to show for it, and
 * the read-back — which is the organizer's only check — would have vanished
 * anyway, since `Intl` DOES throw on an unknown zone when formatting. So an
 * unknown zone means no resolution at all, and the submit refuses.
 *
 * EXPORTED for `ticket-type-sales-window.ts` (Phase 2c), which owes the
 * organizer the same promise — refuse rather than degrade — on the two window
 * bounds. Shared rather than re-declared so a future fix lands in one place;
 * `event-builder-helpers.ts` carries a third copy that predates both and is
 * left alone here.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The editor's form state for the "price changes later" affordance. */
export type ScheduledPriceDraft = {
  /**
   * Whether the affordance is switched on. Collapsed (`false`) by default —
   * this is an advanced option and the overwhelming majority of ticket types
   * will never touch it.
   */
  enabled: boolean;
  /** Free-text money field for the post-flip price. */
  priceDollars: string;
  /** Wall clock the organizer picked, in the EVENT's timezone. */
  atLocal: string;
};

export const emptyScheduledPriceDraft = (): ScheduledPriceDraft => ({
  enabled: false,
  priceDollars: "",
  atLocal: "",
});

/**
 * What a draft means for a submit.
 *
 * `unset` carries the explicit null PAIR rather than an absence, so a caller
 * physically cannot send one field without the other.
 *
 * `error` carries i18n KEYS, never rendered copy, so this stays pure and
 * locale-agnostic — same contract as `TicketAmountField`.
 */
export type ScheduledPriceResolution =
  | { kind: "unset"; scheduledPriceCents: null; scheduledPriceAt: null }
  | {
      kind: "set";
      scheduledPriceCents: number;
      /** ISO 8601 UTC instant, ready for the tRPC boundary. */
      scheduledPriceAt: string;
      /**
       * The resolved instant is at or before `now`. A WARNING, not a refusal:
       * backdating is legitimate (an organizer recording a price step that
       * already happened), so the UI says so and still submits.
       */
      isPast: boolean;
    }
  | {
      kind: "error";
      /** Which control to point the organizer at. */
      field: "price" | "at";
      titleKey: string;
      messageKey: string;
      /**
       * How the INLINE copy should read — not how badly the submit is blocked.
       * Every `error` blocks equally; what differs is whether the organizer got
       * something WRONG or simply hasn't finished yet. `pending` renders muted
       * and without `role="alert"`, because "you haven't typed the new price
       * yet" fires the instant the panel is opened. Mirrors the sales window's
       * tone, and for the same reason.
       */
      tone: "danger" | "pending";
    };

/** The `error` arm on its own — what a control renders inline. */
export type ScheduledPriceProblem = Extract<
  ScheduledPriceResolution,
  { kind: "error" }
>;

/**
 * Resolve the organizer's wall clock in `timeZone` to the absolute instant it
 * names, as an ISO 8601 UTC string. `null` when the value isn't a readable
 * wall clock or the zone id is unknown.
 *
 * DST, pinned by test in both directions (see
 * `__tests__/ticket-type-schedule.test.ts`):
 *
 *  - SPRING FORWARD, the reading that never happens (02:30 on a US
 *    spring-forward day): resolves with the PRE-transition offset, landing one
 *    transition step later on the wall clock (03:30 local). That is what
 *    ECMAScript's own `UTC(t)` does with an impossible reading, so it is the
 *    least surprising of the available wrong answers for an input that names
 *    no instant.
 *  - FALL BACK, the reading that happens twice (01:30 on a US fall-back day):
 *    resolves to the FIRST occurrence — the earlier of the two instants, which
 *    is the one an organizer means by "until 1:30".
 *  - Readings on the FAR SIDE of a transition (03:30 on either day) resolve
 *    with the correct post-transition offset. That is the case a SINGLE probe
 *    at the naive UTC instant gets an hour wrong, and the reason the bracketing
 *    resolver is the one to reach for.
 *
 * SECONDS ARE TRUNCATED. The pattern tolerates a `:ss` because some browsers
 * emit one, but only hour and minute are read — a flip resolves to the top of
 * the minute. Deliberate: the control has no seconds affordance, and a price
 * boundary the organizer cannot see or set is worse than none.
 *
 * NOT ROUND-TRIP STABLE ACROSS THE AMBIGUOUS FALL-BACK HOUR. A stored instant
 * that is the SECOND occurrence of 01:30 seeds the form as the wall clock
 * "01:30", which re-resolves to the FIRST occurrence — so a TOUCHED re-save
 * moves the flip an hour earlier. This is irreducible for a `datetime-local`
 * field, which carries no offset and therefore cannot express which of the two
 * 01:30s was meant. It is also unreachable from this UI, since a second
 * occurrence can only be written by a caller that isn't this form (a template
 * apply, a duplicate) — and an UNTOUCHED save sends `undefined` and never
 * rewrites it. Named here so nobody rediscovers it as a mystery.
 */
export function resolveScheduledPriceAtIso(
  atLocal: string,
  timeZone: string,
): string | null {
  return resolveZonedWallClockToIso(atLocal, timeZone);
}

/**
 * The conversion itself, free of any opinion about WHAT is being scheduled.
 *
 * Extracted so Phase 2c's sales window (`ticket-type-sales-window.ts`) resolves
 * its two bounds through the SAME code path as the price flip rather than a
 * second copy. A second copy is how the two halves of one feature end up
 * disagreeing about a DST boundary — and it would be a copy of the most
 * delicate thirty lines in this feature. `resolveScheduledPriceAtIso` stays as
 * the named entry point for the schedule (and keeps its own test coverage,
 * which therefore exercises this body too).
 */
export function resolveZonedWallClockToIso(
  atLocal: string,
  timeZone: string,
): string | null {
  const trimmed = atLocal.trim();
  if (!WALL_CLOCK_PATTERN.test(trimmed)) return null;
  if (!isKnownTimeZone(timeZone)) return null;

  const [datePart, timePart] = trimmed.split("T");
  const [year, month, day] = datePart!.split("-").map(Number);
  const [hour, minute] = timePart!.split(":").map(Number);

  try {
    const instant = zonedWallClockToInstant(
      {
        year: year!,
        month: month!,
        day: day!,
        hour: hour!,
        minute: minute!,
      },
      timeZone,
    );
    return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
  } catch {
    // Defensive only. `zonedWallClockToInstant` already degrades an
    // unrecognized zone id to UTC internally rather than throwing, but a throw
    // here would take the whole ticket editor down over one optional field.
    return null;
  }
}

/**
 * Read a draft into what the mutation should send.
 *
 * `readAmount` is injected rather than imported so this module stays pure and
 * free of a cycle with `TicketTypeEditor` — the caller passes the editor's own
 * `resolveTicketAmountField`, so there is exactly one money reader in this
 * feature and the tests exercise the real one.
 */
export function resolveScheduledPriceChange(
  draft: ScheduledPriceDraft,
  opts: {
    /** `Event.timezone`, e.g. "America/Chicago". NEVER the browser's. */
    timeZone: string;
    readAmount: (raw: string, copy: "price" | "amount") => TicketAmountField;
    /** Injected so "is this in the past" is testable. */
    now: Date;
  },
): ScheduledPriceResolution {
  if (!draft.enabled) {
    return { kind: "unset", scheduledPriceCents: null, scheduledPriceAt: null };
  }

  // Price first: it is the field the organizer types, so an error here is the
  // one they can act on without re-opening a date picker.
  const amount = opts.readAmount(draft.priceDollars, "amount");
  if (amount.kind === "error") {
    return {
      kind: "error",
      field: "price",
      titleKey: amount.titleKey,
      messageKey: amount.messageKey,
      // Unreadable money is a real mistake, not an unfinished field.
      tone: "danger",
    };
  }
  // Blank is NOT 0 here. Elsewhere in this editor a blank price means "free",
  // but a blank *scheduled* price means the organizer hasn't finished — and
  // banking it as $0 would silently schedule the tier to become free.
  // 0 typed explicitly is still legal (a free-after-T tier) and lands in the
  // `cents` arm below.
  if (amount.kind === "blank") {
    return {
      kind: "error",
      field: "price",
      titleKey: "admin.ttScheduleIncompleteTitle",
      messageKey: "admin.ttSchedulePriceRequiredMessage",
      tone: "pending",
    };
  }

  if (draft.atLocal.trim().length === 0) {
    return {
      kind: "error",
      field: "at",
      titleKey: "admin.ttScheduleIncompleteTitle",
      messageKey: "admin.ttScheduleAtRequiredMessage",
      tone: "pending",
    };
  }

  // A missing/unknown zone gets its own message, ahead of reading the date.
  //
  // The caller passes `eventTimezone ?? ""`, so this is live whenever the event
  // query has not resolved (or regresses to undefined after the organizer has
  // already typed). Sharing the "couldn't be read" copy blamed a date that is
  // perfectly fine for a condition re-picking it cannot fix. Placed HERE rather
  // than at the top so the price-first ordering above is untouched — that
  // ordering is deliberate, and this changes only the misdiagnosis. What does
  // not change: an unknown zone still REFUSES rather than resolving against UTC.
  if (!isKnownTimeZone(opts.timeZone)) {
    return {
      kind: "error",
      field: "at",
      titleKey: "admin.ttScheduleIncompleteTitle",
      messageKey: "admin.ttScheduleTimezonePending",
      tone: "pending",
    };
  }

  const iso = resolveScheduledPriceAtIso(draft.atLocal, opts.timeZone);
  if (iso == null) {
    return {
      kind: "error",
      field: "at",
      titleKey: "admin.ttScheduleIncompleteTitle",
      messageKey: "admin.ttScheduleAtInvalidMessage",
      tone: "danger",
    };
  }

  return {
    kind: "set",
    scheduledPriceCents: amount.cents,
    scheduledPriceAt: iso,
    isPast: new Date(iso).getTime() <= opts.now.getTime(),
  };
}

/**
 * The organizer's read-back of an instant, on the EVENT's clock —
 * "Fri, Oct 3, 12:00 AM CDT".
 *
 * Not optional polish. Q-002 (RESOLVED): the organizer is the only person who
 * can catch a timezone mistake, so without this FR-007's correctness is
 * unverifiable by anyone. `timeZoneName: "short"` is the part that does the
 * work — it is what turns "did this land on the venue's clock?" from a
 * question into something visible.
 *
 * Date-part ORDER is left to `Intl` via the injected formatter (es reads
 * "vie, 3 oct"), so this never hand-assembles a locale.
 */
export function formatZonedInstant(
  atIso: string,
  timeZone: string,
  formatDateTime: (value: Date, options: Intl.DateTimeFormatOptions) => string,
): string | null {
  const instant = new Date(atIso);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    return formatDateTime(instant, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    });
  } catch {
    // Unknown zone id — drop the hint rather than taking the editor down.
    return null;
  }
}

/**
 * Seed the draft from a stored ticket type — the persisted half of Q-002's
 * read-back, i.e. what the organizer sees when they RE-OPEN a scheduled row.
 *
 * The two fields are typed OPTIONAL because they are a recent addition to
 * `events.listTicketTypesForEdit`; a caller that hasn't got them (or a
 * half-configured legacy row) gets a disabled draft rather than a half one.
 * Every check is `== null`, never falsy: a stored `0` is a real "free after T"
 * schedule and must seed as ENABLED.
 *
 * MUST NOT THROW. Both callers are places where an exception is catastrophic
 * rather than cosmetic: `handleStartEdit` is a click handler, and the re-seed
 * effect runs during render commit — a throw from either unmounts the builder
 * through the error boundary, losing unsaved work on an unrelated form. That
 * is a live risk because `toDateTimeLocalValue` builds an
 * `Intl.DateTimeFormat` with the zone, which throws `RangeError` on an
 * unrecognized id, and `Event.timezone` is a bare `z.string()` server-side, so
 * a bad stored value is possible in principle. Hence the explicit zone guard:
 * unknown zone means a DISABLED draft, matching what this module promises
 * everywhere else — no resolution, no read-back, refused submit — instead of
 * an exception.
 */
export function scheduledPriceDraftFromTicketType(
  tt: {
    scheduledPriceCents?: number | null;
    scheduledPriceAt?: string | Date | null;
  },
  timeZone: string,
): ScheduledPriceDraft {
  const cents = tt.scheduledPriceCents;
  const at = tt.scheduledPriceAt;
  // `== null` and never a falsy test: 0 is a legitimate scheduled price.
  if (cents == null || at == null) return emptyScheduledPriceDraft();
  if (!isKnownTimeZone(timeZone)) return emptyScheduledPriceDraft();
  const atLocal = toDateTimeLocalValue(at, timeZone);
  if (!atLocal) return emptyScheduledPriceDraft();
  return {
    enabled: true,
    priceDollars: (cents / 100).toFixed(2),
    atLocal,
  };
}
