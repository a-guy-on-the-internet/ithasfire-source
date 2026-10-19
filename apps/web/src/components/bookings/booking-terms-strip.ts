import {
  AGREEMENT_STATUS_LABEL_KEYS,
  agreementStatusTone,
  type AgreementStatus,
} from "@/lib/booking-agreements";

// ─────────────────────────────────────────────────────────────────────────────
// THE TERMS THAT ACTUALLY BIND, rendered inside the conversation about them.
//
// WHY IT EXISTS. A booking's prose and its binding header live on two different
// pages, and the thread never showed the header. Observed end to end: the act
// pitched three dates, the accept seeded `proposedDate` from the FIRST one
// (Sep 18), the venue then wrote "Sep 18 is spoken for, but Sep 25 is open",
// the act replied "Sep 25 works" — and nobody opened the agreement. The header
// still said Sep 18, the event was created correctly FROM that header, and the
// show is booked on the one night both parties ruled out in writing.
//
// Nothing in the chain is broken. The failure is that you negotiate in prose
// directly underneath a date field you cannot see. So the fix is to show the
// field, not to guess at the prose: this module NEVER reads message text. It
// takes the agreement the server already resolved and turns it into three
// labelled values plus a route to where they can be changed. The human does
// the comparing — a date parser pointed at free text would be wrong in public.
//
// PURE ON PURPOSE, same contract as `booking-stage-rail.ts`: no JSX, no hooks,
// no lucide. Every branch here (terminal status, absent value, pitch
// provenance) is a function of (agreement, provenance, translator, formatters),
// which is what makes it cheap to pin. `BookingTermsStrip.tsx` is the only
// renderer and renders nothing this file did not decide.
//
// PROVENANCE IS THE SERVER'S ANSWER, never re-derived. `pitchProvenance` says
// which header fields still hold exactly what the accept seeded from the act's
// pitch — i.e. which values the venue has never actually chosen. On the
// specimen above, `proposedDate` was `true`: the binding date was nobody's
// decision. `true` is the ONLY signal a label may use; the UI must not compute
// its own (see the schema docblock in `get-booking-agreement.ts`).
// ─────────────────────────────────────────────────────────────────────────────

/** Values are pre-formatted strings — nothing here needs a plural or a skeleton. */
type Translate = (key: string, values?: Record<string, string>) => string;

export type BookingTermsFieldKey = "date" | "end" | "guarantee";

export type BookingTermsField = {
  key: BookingTermsFieldKey;
  /** Localized field name — the SAME labels the agreement editor uses. */
  label: string;
  /** Formatted value, or the em-dash placeholder when the header holds null. */
  value: string;
  /** False when the header holds null — the placeholder is showing. */
  present: boolean;
  /**
   * The stored value is still exactly what the accept seeded from the pitch.
   * Straight from the server's `pitchProvenance`; an absent flag is `false`,
   * because "we could not attribute it" must never read as "the act asked for
   * this".
   */
  fromPitch: boolean;
};

export type BookingTermsView = {
  /** Always three, always in header order: start, end, money. */
  fields: BookingTermsField[];
  /** Kicker — "Terms on file" while live, past tense once the arc ended. */
  heading: string;
  /** Localized agreement status word, for the badge beside the kicker. */
  statusLabel: string;
  statusTone: "success" | "info" | "warning" | "neutral" | "danger";
  /**
   * The route-out's label, and it is a PROMISE the strip has to keep.
   *
   * "Change terms" only when the server says the viewer may actually edit the
   * header right now (`mayEdit` = DRAFT status + edit-level access on their
   * side). Every other case — a proposed agreement, an accepted one, a
   * view-only org role, an ended arc — reads "View agreement", because a verb
   * the destination page will refuse is worse than no verb. The editable
   * window is exactly the one where the CTA earns its keep anyway: DRAFT is
   * when the terms are being set and the prose is flying.
   */
  linkLabel: string;
  /**
   * The agreement can no longer change: declined, cancelled, expired,
   * disputed — or fulfilled, where the show already happened. The strip then
   * reads as a record of what was, not as live terms.
   */
  ended: boolean;
  /** At least one live field is still the act's un-chosen ask. */
  anyFromPitch: boolean;
};

/**
 * Statuses past which the header is history.
 *
 * FULFILLED sits here with the negative four deliberately: the event happened,
 * so its terms are a record rather than something a reader might still go
 * change. Five of the nine enum members are written today (DRAFT, PROPOSED,
 * ACCEPTED, DECLINED, and FULFILLED — written only by `completeEvent` when a
 * finalized event is marked COMPLETED) — the rest are handled so a future row
 * cannot make a thread render wrong, not because the happy path uses them.
 */
const ENDED_STATUSES: ReadonlySet<string> = new Set([
  "DECLINED",
  "CANCELLED",
  "EXPIRED",
  "DISPUTED",
  "FULFILLED",
]);

/** What a null header field prints. */
const ABSENT = "—";

export type BookingTermsProvenance = {
  proposedDate: boolean;
  proposedEndDate: boolean;
  guaranteeCents: boolean;
  description: boolean;
} | null;

export type DescribeBookingTermsArgs = {
  status: string;
  proposedDate: Date | string | null;
  proposedEndDate: Date | string | null;
  guaranteeCents: number | null;
  /** Server-derived; null when there is no originating pitch to attribute to. */
  pitchProvenance: BookingTermsProvenance;
  /** Straight from the read: may THIS viewer edit the header right now? */
  mayEdit: boolean;
  t: Translate;
  /** `useFormatters().dateTime` with the caller's date+time style applied. */
  formatDateTime: (value: Date) => string;
  /** `fmtCurrency` bound to the viewer's formatters. */
  formatMoney: (cents: number) => string;
};

/** Coerce a wire value to a usable Date, or null for absent/unparseable. */
function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function describeBookingTerms({
  status,
  proposedDate,
  proposedEndDate,
  guaranteeCents,
  pitchProvenance,
  mayEdit,
  t,
  formatDateTime,
  formatMoney,
}: DescribeBookingTermsArgs): BookingTermsView {
  const ended = ENDED_STATUSES.has(status);

  const start = toDate(proposedDate);
  const end = toDate(proposedEndDate);

  const fields: BookingTermsField[] = [
    {
      key: "date",
      label: t("admin.baProposedDateLabel"),
      value: start ? formatDateTime(start) : ABSENT,
      present: start !== null,
      fromPitch: pitchProvenance?.proposedDate === true,
    },
    {
      key: "end",
      label: t("admin.baProposedEndDateLabel"),
      value: end ? formatDateTime(end) : ABSENT,
      present: end !== null,
      fromPitch: pitchProvenance?.proposedEndDate === true,
    },
    {
      key: "guarantee",
      label: t("admin.baGuaranteeLabel"),
      // `!== null` rather than truthiness: a $0 guarantee is a decision, and
      // printing an em-dash for it would report a settled term as unset.
      value: guaranteeCents !== null ? formatMoney(guaranteeCents) : ABSENT,
      present: guaranteeCents !== null,
      fromPitch: pitchProvenance?.guaranteeCents === true,
    },
  ];

  // A status this build has never heard of (a rollback behind a newer writer)
  // still gets a word rather than a raw enum member or a blank badge, and is
  // never coloured as if we knew whether it was good or bad news.
  const knownStatusKey = AGREEMENT_STATUS_LABEL_KEYS[status as AgreementStatus];
  const statusKey = knownStatusKey ?? "admin.bkStageUnknownState";
  const statusTone = knownStatusKey
    ? agreementStatusTone(status as AgreementStatus)
    : ("neutral" as const);

  return {
    fields,
    heading: t(ended ? "booking.termsHeadingEnded" : "booking.termsHeading"),
    statusLabel: t(statusKey),
    statusTone,
    linkLabel: t(
      mayEdit && !ended ? "booking.termsChange" : "booking.entryOpenAgreement",
    ),
    ended,
    // Nothing is still "waiting to be chosen" on an agreement that ended, so
    // the nudge is suppressed there even when the flags are set.
    anyFromPitch: !ended && fields.some((field) => field.fromPitch),
  };
}
