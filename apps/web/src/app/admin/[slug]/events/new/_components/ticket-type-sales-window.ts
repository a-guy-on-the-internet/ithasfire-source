import {
  formatZonedInstant,
  isKnownTimeZone,
  resolveZonedWallClockToIso,
} from "./ticket-type-schedule";
import { toDateTimeLocalValue } from "./event-builder-helpers";

/**
 * The organizer-facing half of the per-type SALES WINDOW
 * (docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-013, adopting
 * FR-009 / ticket-type-packs FR-014).
 *
 * WHY THIS EXISTS AT ALL. `TicketType.salesOpenAt` / `salesCloseAt` shipped
 * with columns, five checkout enforcement sites and per-tier buyer states — and
 * no way for an organizer to set one. FR-013 was added after 2a and 2b had
 * shipped, when `grep -rn "salesOpenAt|salesCloseAt" apps/web apps/scanner
 * apps/mobile` returned zero hits. This module is the missing control's pure
 * half.
 *
 * It is the sibling of `ticket-type-schedule.ts` and deliberately shares that
 * module's wall-clock resolver, zone guard and read-back formatter. What it does
 * NOT share is the rules, which differ in three ways that each caused a
 * different bug class if copied across:
 *
 *  1. THE TWO BOUNDS ARE INDEPENDENT. The scheduled price is both-or-neither;
 *     a window is not. "Opens Friday, never closes" (advance sales that run to
 *     the door) and "closes Friday, on sale until then" (an advance tier that
 *     hands over to a door tier) are both legitimate single-bound
 *     configurations, and `normalizeSalesWindow` in core accepts them. Copying
 *     the both-or-neither rule here would make half the feature unreachable.
 *
 *  2. ZERO WIDTH IS REJECTED, not merely inversion. The interval is HALF-OPEN —
 *     `salesOpenAt` INCLUSIVE, `salesCloseAt` EXCLUSIVE (see
 *     `resolveTicketTypeSaleState`: `now < opensAt` refuses, `now >= closesAt`
 *     refuses) — so `open === close` is an EMPTY interval and the tier could
 *     never sell a single ticket while looking fully configured. Core throws
 *     TICKET_TYPE_SALES_WINDOW_INVALID for both; this resolver makes both
 *     unreachable from the UI by refusing the submit first.
 *
 *  3. THE WINDOW SURVIVES `ADJUSTABLE`. `upsertTicketType` clears the door
 *     price and the scheduled price for a pay-what-you-want tier because those
 *     are PRICES and a buyer-chosen price has nothing to override. It
 *     deliberately does NOT clear the window, because a window is about
 *     SELLABILITY and says nothing about the amount. So the control stays
 *     mounted in both pricing modes — see the note at its mount site.
 *
 * Everything else is the FR-007 discipline verbatim: the organizer picks a WALL
 * CLOCK, it resolves against `Event.timezone` through the repo's bracketing
 * `zonedWallClockToInstant` (never luxon, which apps/web does not carry; never
 * `PAYOUT_TZ`/`REFUND_TZ`, which hardcode America/Chicago), and an unknown or
 * missing zone REFUSES rather than degrading to UTC or to the browser's clock.
 *
 * `zonedWallClockToInstant` is the ONE resolver for wall clocks in this app —
 * the event builder's own `toIsoInTimeZone` goes through it too. Anything new
 * that converts a wall clock should call it rather than probing the zone
 * itself: a single probe cannot see both sides of a transition.
 */

/** The editor's form state for the "limit when this tier sells" affordance. */
export type SalesWindowDraft = {
  /**
   * Whether the affordance is switched on. Collapsed (`false`) by default —
   * the overwhelming majority of tiers sell for as long as the event does
   * (NFR-001), and this costs that case one line.
   */
  enabled: boolean;
  /** Wall clock the organizer picked for the OPENING bound, in the EVENT's zone. */
  openLocal: string;
  /** Wall clock for the CLOSING bound, in the EVENT's zone. */
  closeLocal: string;
};

export const emptySalesWindowDraft = (): SalesWindowDraft => ({
  enabled: false,
  openLocal: "",
  closeLocal: "",
});

/**
 * What a draft means for a submit.
 *
 * `set` carries each bound INDEPENDENTLY — either may be `null` while the other
 * is an instant. That is the whole difference from the scheduled price's
 * resolution type, and it is why this is a separate type rather than a reuse.
 *
 * `error` carries i18n KEYS, never rendered copy, so this stays pure and
 * locale-agnostic — the same contract as `TicketAmountField` and
 * `ScheduledPriceResolution`.
 */
export type SalesWindowResolution =
  | { kind: "unset"; salesOpenAt: null; salesCloseAt: null }
  | {
      kind: "set";
      /** ISO 8601 UTC instant, or `null` for "no opening bound". */
      salesOpenAt: string | null;
      /** ISO 8601 UTC instant, or `null` for "no closing bound". */
      salesCloseAt: string | null;
    }
  | {
      kind: "error";
      /** Which control to point the organizer at. */
      field: "open" | "close" | "window";
      titleKey: string;
      messageKey: string;
      /**
       * How the INLINE copy should read — not how badly the submit is blocked.
       * Every `error` blocks equally; what differs is whether the organizer did
       * something WRONG or simply hasn't finished yet.
       *
       *  - `danger` — the pair on screen is contradictory (inverted, zero-width)
       *    or a bound is unreadable. Red, with the alert glyph and `role="alert"`.
       *  - `pending` — nothing is wrong, the form is incomplete (ticked but both
       *    bounds blank, or the event's zone hasn't arrived). Muted, no alert
       *    role: it materialises the instant the organizer ticks the box, and a
       *    red shout for "you haven't typed anything yet" is how people learn to
       *    ignore the message that matters.
       */
      tone: "danger" | "pending";
    };

/** The `error` arm on its own — what a control renders inline. */
export type SalesWindowProblem = Extract<
  SalesWindowResolution,
  { kind: "error" }
>;

/**
 * Resolve one bound's wall clock in `timeZone` to the absolute instant it
 * names, as an ISO 8601 UTC string. `null` when the value is not a readable
 * wall clock or the zone id is unknown.
 *
 * Thin by design: the conversion, its DST behaviour and its out-of-range
 * refusals all live in `resolveZonedWallClockToIso` and are documented and
 * tested there. Re-exported under this name so a window call site reads as one.
 *
 * Two of that resolver's caveats are restated because their CONSEQUENCE differs
 * for a window:
 *
 *  - SECONDS TRUNCATE TO THE MINUTE. A `:ss` some browsers emit is tolerated
 *    but ignored, so a bound lands on the top of the minute. Harmless here: the
 *    control has no seconds affordance, and the boundary an organizer cannot
 *    see is worse than one rounded to where they can.
 *  - NOT ROUND-TRIP STABLE ACROSS THE AMBIGUOUS FALL-BACK HOUR. A stored bound
 *    that is the SECOND occurrence of 01:30 seeds the form as the wall clock
 *    "01:30", which re-resolves to the FIRST occurrence — so a TOUCHED re-save
 *    moves it an hour earlier, SHORTENING the window by an hour if it is the
 *    closing bound (or opening the tier an hour early if it is the opening
 *    one). Irreducible for a `datetime-local` field, which carries no offset
 *    and so cannot express which 01:30 was meant, and unreachable from this
 *    form — a second occurrence can only be written by a caller that is not
 *    this form (a template apply, a duplicate), and an UNTOUCHED save sends
 *    `undefined` and never rewrites it. Named so nobody rediscovers it as a
 *    mystery. Same shape as the note on `resolveScheduledPriceAtIso`.
 */
export function resolveSalesWindowBoundIso(
  atLocal: string,
  timeZone: string,
): string | null {
  return resolveZonedWallClockToIso(atLocal, timeZone);
}

/**
 * Read a draft into what the mutation should send.
 *
 * The order of the checks is the order the organizer can act on them: the zone
 * first (nothing below can be true without it), then each bound on its own (so
 * an unreadable date names ITS field), and only then the two compared.
 */
export function resolveSalesWindow(
  draft: SalesWindowDraft,
  opts: {
    /** `Event.timezone`, e.g. "America/Chicago". NEVER the browser's. */
    timeZone: string;
  },
): SalesWindowResolution {
  if (!draft.enabled) {
    return { kind: "unset", salesOpenAt: null, salesCloseAt: null };
  }

  // No usable zone gets its OWN refusal, ahead of the per-bound reads.
  //
  // The caller passes `eventTimezone ?? ""`, so this arm is live whenever the
  // event query has not resolved (or has gone back to undefined after the
  // organizer already filled a bound). Without it, an unknown zone makes every
  // bound unreadable and the organizer is told "That opening date and time
  // couldn't be read. Pick it again." — pointing at a field that is perfectly
  // fine, for a condition that re-picking cannot fix. The dates are not the
  // problem; the missing zone is, and `ttWindowTimezonePending` says so.
  //
  // What does NOT change is the important half: an unknown zone still REFUSES
  // rather than resolving against UTC or the browser's clock.
  if (!isKnownTimeZone(opts.timeZone)) {
    return {
      kind: "error",
      field: "window",
      titleKey: "admin.ttWindowInvalidTitle",
      messageKey: "admin.ttWindowTimezonePending",
      tone: "pending",
    };
  }

  const openRaw = draft.openLocal.trim();
  const closeRaw = draft.closeLocal.trim();

  // Ticked but empty. NOT silently treated as "no window": the organizer opened
  // this deliberately, and banking their intent as nothing is how a tier meant
  // to open on Friday quietly goes on sale immediately. The message names the
  // way out (untick) so the refusal is never a dead end.
  if (openRaw.length === 0 && closeRaw.length === 0) {
    return {
      kind: "error",
      field: "window",
      titleKey: "admin.ttWindowInvalidTitle",
      messageKey: "admin.ttWindowEmptyMessage",
      tone: "pending",
    };
  }

  let salesOpenAt: string | null = null;
  if (openRaw.length > 0) {
    salesOpenAt = resolveSalesWindowBoundIso(openRaw, opts.timeZone);
    if (salesOpenAt == null) {
      return {
        kind: "error",
        field: "open",
        titleKey: "admin.ttWindowInvalidTitle",
        messageKey: "admin.ttWindowOpenInvalidMessage",
        tone: "danger",
      };
    }
  }

  let salesCloseAt: string | null = null;
  if (closeRaw.length > 0) {
    salesCloseAt = resolveSalesWindowBoundIso(closeRaw, opts.timeZone);
    if (salesCloseAt == null) {
      return {
        kind: "error",
        field: "close",
        titleKey: "admin.ttWindowInvalidTitle",
        messageKey: "admin.ttWindowCloseInvalidMessage",
        tone: "danger",
      };
    }
  }

  // The core invariant, enforced here so TICKET_TYPE_SALES_WINDOW_INVALID is
  // unreachable through this form. Core rejects both orderings with ONE code;
  // the organizer gets TWO messages, because "you set it backwards" and "you
  // set both to the same moment" are different mistakes with different fixes.
  const order = classifySalesWindowOrder(salesOpenAt, salesCloseAt);
  if (order != null) {
    return {
      kind: "error",
      field: "close",
      titleKey: "admin.ttWindowInvalidTitle",
      messageKey:
        order === "inverted"
          ? "admin.ttWindowOrderMessage"
          : "admin.ttWindowZeroWidthMessage",
      tone: "danger",
    };
  }

  return { kind: "set", salesOpenAt, salesCloseAt };
}

/**
 * Which of the two rejected orderings a resolved pair is, or `null` when the
 * pair is fine (or incomplete).
 *
 * Split out because the single "opening must be earlier … a tier that opens and
 * closes at the same moment can never sell" string described BOTH cases and was
 * therefore wrong for whichever one the organizer was actually in: shown for an
 * inverted pair, its second sentence asserted a zero-width window they had not
 * configured. The `>=` in the invariant already knew the difference; only the
 * copy didn't.
 *
 * `zeroWidth` is not a lesser problem than `inverted`: with a half-open
 * interval (`salesOpenAt` inclusive, `salesCloseAt` exclusive) open === close is
 * an EMPTY interval, so the tier is permanently unbuyable while looking fully
 * configured.
 */
export function classifySalesWindowOrder(
  salesOpenAtIso: string | null,
  salesCloseAtIso: string | null,
): "inverted" | "zeroWidth" | null {
  if (salesOpenAtIso == null || salesCloseAtIso == null) return null;
  const open = new Date(salesOpenAtIso).getTime();
  const close = new Date(salesCloseAtIso).getTime();
  if (Number.isNaN(open) || Number.isNaN(close)) return null;
  if (open > close) return "inverted";
  if (open === close) return "zeroWidth";
  return null;
}

// NOTE — there is deliberately no second "is this inverted" predicate here.
//
// There used to be (`isSalesWindowInverted`): the control ran it to decide
// whether to show the inline error while the submit ran `resolveSalesWindow`,
// and the two disagreed about what was blocking. The predicate covered exactly
// one of the resolver's five refusals, so the panel could show a refusal the
// button ignored — and block on four the panel never mentioned. The editor now
// resolves ONCE per form and feeds that single answer to both the inline
// message and the Add/Save button's disabled state.

/**
 * Seed the draft from a stored ticket type — what the organizer sees when they
 * RE-OPEN a windowed row.
 *
 * The two fields are typed OPTIONAL because they are a recent addition to
 * `events.listTicketTypesForEdit`; a caller that hasn't got them gets a
 * disabled draft rather than a half one. Every check is `== null`, never
 * falsy — there is no falsy `Date`, but the habit is what keeps a `0`-shaped
 * bug out of the next field added here.
 *
 * ENABLED WHEN EITHER BOUND IS PRESENT, not both: a single-bound window is a
 * complete configuration (unlike the schedule), so seeding it as "off" would
 * make an untouched Save look like a removal in the UI even though the touched
 * latch stops it from being one.
 *
 * MUST NOT THROW. Both callers are places where an exception is catastrophic
 * rather than cosmetic — `handleStartEdit` is a click handler and the re-seed
 * effect runs during render commit, so a `RangeError` out of
 * `Intl.DateTimeFormat` (which `toDateTimeLocalValue` builds from the zone, and
 * `Event.timezone` is a bare `z.string()` server-side) would unmount the whole
 * builder through the error boundary and lose unsaved work on an unrelated
 * form. Hence the explicit zone guard.
 */
export function salesWindowDraftFromTicketType(
  tt: {
    salesOpenAt?: string | Date | null;
    salesCloseAt?: string | Date | null;
  },
  timeZone: string,
): SalesWindowDraft {
  const open = tt.salesOpenAt;
  const close = tt.salesCloseAt;
  if (open == null && close == null) return emptySalesWindowDraft();
  if (!isKnownTimeZone(timeZone)) return emptySalesWindowDraft();

  const openLocal = open == null ? "" : toDateTimeLocalValue(open, timeZone);
  const closeLocal = close == null ? "" : toDateTimeLocalValue(close, timeZone);
  // Both unreadable (an invalid stored instant) — nothing to show, so nothing
  // to enable.
  if (!openLocal && !closeLocal) return emptySalesWindowDraft();

  return { enabled: true, openLocal, closeLocal };
}

/**
 * The persisted read-back: what a SAVED window says on the ticket LIST, without
 * opening the editor.
 *
 * Returns i18n KEY + pre-formatted values, never rendered copy, so the module
 * stays pure and `Intl` keeps ownership of date-part order per locale (es reads
 * "vie, 3 oct"). `null` when there is no window, when the event's timezone is
 * not known yet, or when nothing renders — a window shown on the WRONG clock is
 * worse than one not shown at all, since this line is the organizer's only
 * verification surface once the form is closed.
 *
 * TENSE FOLLOWS THE CLOCK, as it does for the scheduled price: a window whose
 * closing bound has passed reads "Sales ended …" rather than "On sale until …",
 * which would be a promise the tier is no longer keeping.
 */
export type SalesWindowSummary = {
  key:
    | "admin.ttWindowSummaryRange"
    | "admin.ttWindowSummaryFrom"
    | "admin.ttWindowSummaryUntil"
    | "admin.ttWindowSummaryEnded";
  /** Only the arguments the chosen key actually references. */
  values: Record<string, string>;
};

export function describeSalesWindow(
  tt: {
    salesOpenAt?: string | Date | null;
    salesCloseAt?: string | Date | null;
  },
  timeZone: string | null,
  formatDateTime: (value: Date, options: Intl.DateTimeFormatOptions) => string,
  now: Date,
): SalesWindowSummary | null {
  if (!timeZone) return null;
  const openIso = toIsoOrNull(tt.salesOpenAt);
  const closeIso = toIsoOrNull(tt.salesCloseAt);
  if (openIso == null && closeIso == null) return null;

  const opens =
    openIso == null
      ? null
      : formatZonedInstant(openIso, timeZone, formatDateTime);
  const closes =
    closeIso == null
      ? null
      : formatZonedInstant(closeIso, timeZone, formatDateTime);

  // `>=`, matching `resolveTicketTypeSaleState`: the closing bound is
  // EXCLUSIVE, so at exactly that instant sales have already ended.
  if (closes != null && new Date(closeIso!).getTime() <= now.getTime()) {
    return { key: "admin.ttWindowSummaryEnded", values: { closes } };
  }
  if (opens != null && closes != null) {
    return { key: "admin.ttWindowSummaryRange", values: { opens, closes } };
  }
  if (opens != null) {
    return { key: "admin.ttWindowSummaryFrom", values: { opens } };
  }
  if (closes != null) {
    return { key: "admin.ttWindowSummaryUntil", values: { closes } };
  }
  return null;
}

/** Normalize the two shapes a stored bound arrives in to an ISO string. */
function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}
