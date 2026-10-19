/**
 * Pure helpers for the public booking-request ("request to play") form.
 * Kept free of React so they can be unit-tested like `safe-block-url`.
 *
 * Server-side limits live in
 * `packages/core/src/use-cases/booking-requests/create-booking-request.ts`
 * (message 10–2000 chars, 1–10 ISO dates, typed link slots must be http(s)
 * URLs, set-length must be a preset, fee amount only for a paying fee type).
 * The form is intentionally tighter (max 3 dates) to keep the pitch focused.
 * The single-source-of-truth constants (`BOOKING_SET_LENGTH_PRESETS`,
 * `BOOKING_FEE_AMOUNT_MAX_CENTS`) are imported from core's dependency-free
 * `constants` leaf (NOT the use-case barrel) so this client bundle never pulls
 * the schema graph's `sanitize-html` transitive dep, while the two never drift.
 */

import {
  BOOKING_SET_LENGTH_PRESETS,
  BOOKING_FEE_AMOUNT_MAX_CENTS,
  BOOKING_FEE_DEFAULT_CURRENCY,
} from "@th/core/use-cases/booking-requests/constants";
import {
  toMinorUnits,
  toMajorUnits,
  currencyFractionDigits,
} from "@th/core/lib/currency-utils";
import type {
  BookingFeeType,
  BookingIntent,
} from "@th/types/repos/booking-requests";

import { getAppErrorCode } from "@/lib/app-error";
import { formatSetLength } from "@/lib/booking-requests";

import {
  buildBookingBillPayload,
  type BookingBillActDraft,
  type BookingBillErrorKey,
  type BookingBillPayload,
} from "./booking-bill.helpers";
import type {
  BookingStandardField,
  BookingStandardsByIntent,
  BookingStandardsPayload,
} from "./booking-standards.helpers";

export { formatSetLength };
export type { BookingIntent };

/** Who the request goes out as; the panel resolves the list per intent. */
export type BookingSender = {
  ownerType: "human" | "org";
  ownerId: string;
  label: string;
  /**
   * PERFORM only: whether this identity has performer mode, which gates its
   * own row on the bill (lineup v2 D3). Absent on RENT/USE senders.
   */
  performerEnabled?: boolean;
};

export const BOOKING_MESSAGE_MIN = 10;
export const BOOKING_MESSAGE_MAX = 2000;
export const BOOKING_MAX_DATES = 3;
export const BOOKING_ACT_NAME_MAX = 120;
export const BOOKING_LINEUP_MIN = 1;
export const BOOKING_LINEUP_MAX = 100;
export const BOOKING_TECH_NEEDS_MAX = 2000;
export const BOOKING_LINK_MAX = 2000;

/** Set-length presets (minutes) — re-exported from core for the picker. */
export { BOOKING_SET_LENGTH_PRESETS, BOOKING_FEE_AMOUNT_MAX_CENTS };

/** The currency fee amounts are entered/echoed in (platform base, always usd). */
export const BOOKING_FEE_CURRENCY = BOOKING_FEE_DEFAULT_CURRENCY;

/** Selectable fee-ask types (empty string = unspecified in the form). */
export const BOOKING_FEE_TYPES = [
  "GUARANTEE",
  "DOOR_SPLIT",
  "NEGOTIABLE",
] as const satisfies readonly BookingFeeType[];

/** Fee types that carry a concrete amount (mirrors the server cross-field rule). */
const PAYING_FEE_TYPES: readonly BookingFeeType[] = ["GUARANTEE", "DOOR_SPLIT"];

/** Server phone shape: `/^[+0-9 ()\-.]{5,30}$/`. */
const PHONE_RE = /^[+0-9 ()\-.]{5,30}$/;

export type BookingRequestFormValues = {
  message: string;
  /** ISO `YYYY-MM-DD` strings; empty entries are dropped before validation. */
  preferredDates: string[];
  /** Raw input — empty string means "not provided". */
  expectedDraw: string;
  genre: string;
  // ── Expanded pitch fields (2026-07-11) ──────────────────────────────────
  /** Act / band name. */
  actName?: string;
  /** Raw numeric input for the lineup size. */
  lineupSize?: string;
  /** Raw select value — "" or one of `BOOKING_SET_LENGTH_PRESETS` as a string. */
  setLengthMinutes?: string;
  /** Contact phone (raw). */
  contactPhone?: string;
  /** Tech / backline / rider needs (multiline free text). */
  techNeeds?: string;
  /** Fee-ask type; "" means unspecified. */
  feeType?: "" | BookingFeeType;
  /** Raw major-unit (dollars) money input; converted to cents on submit. */
  feeAmountDollars?: string;
  /** Typed link slots — replace the legacy generic `links` array. */
  linkMusic?: string;
  linkVideo?: string;
  linkSocial?: string;
  linkEpk?: string;
  /**
   * Sender identity type. Only HUMAN senders can attach verified stats
   * (FR-009) — orgs have no stats aggregate, so the flag is gated out here
   * regardless of `includeVerifiedStats`.
   */
  senderOwnerType?: "human" | "org";
  /**
   * Whether the sending human's verified stats meet the sharing threshold
   * (`performers.getMyStatus` → `human.statsEligible`). The flag is only ever
   * emitted when this is `true` — an ineligible sender would just make the
   * server store a null snapshot, so it's gated out here (and the checkbox is
   * hidden in the UI — defense in depth alongside the server's own gate).
   */
  senderStatsEligible?: boolean;
  /**
   * Human opt-in to attach a point-in-time snapshot of their verified platform
   * stats to this request. Independent of the public `stats` block's
   * visibility. Server only persists a snapshot when the sender is eligible
   * (3+ shows) — an ineligible human simply yields a null snapshot.
   */
  includeVerifiedStats?: boolean;
  /**
   * The bill (lineup v3, board F1). Who is sending, so a tag of the sender
   * itself is caught before the server's ACT_NOT_TAGGABLE `self`.
   */
  senderOwnerId?: string;
  /**
   * "I'm on the bill" as the form shows it — already forced off for a sender
   * without performer mode. Undefined (a caller that predates the bill) = on.
   */
  billIncludeSelf?: boolean;
  /** The other acts, in bill order. */
  billActs?: readonly BookingBillActDraft[];
};

export type BookingRequestFormErrorKey =
  | "admin.bkErrMessageTooShort"
  | "admin.bkErrDates"
  | "admin.bkErrDraw"
  | "admin.bkErrActName"
  | "admin.bkErrLineup"
  | "admin.bkErrSetLength"
  | "admin.bkErrPhone"
  | "admin.bkErrTechNeeds"
  | "admin.bkErrFeeAmount"
  | "admin.bkErrLinkInvalid";

export type BookingRequestPayload = {
  message: string;
  preferredDates: string[];
  expectedDraw?: number;
  genre?: string;
  actName?: string;
  lineupSize?: number;
  setLengthMinutes?: number;
  contactPhone?: string;
  techNeeds?: string;
  feeType?: BookingFeeType;
  feeAmountCents?: number;
  linkMusic?: string;
  linkVideo?: string;
  linkSocial?: string;
  linkEpk?: string;
  includeVerifiedStats?: boolean;
};

/**
 * A requested night: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` once the picker has
 * also captured a start time. Mirrors `bookingPreferredDateSchema` in
 * `@th/core` — this client gate rejecting what the server accepts is what made
 * the picker silently unsubmittable ("Pick at least one preferred date") while
 * every server-side test passed.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validates form values; returns either the wire payload for
 * `bookingRequests.create` or the i18n key of the first problem found.
 */
export function buildBookingRequestPayload(
  values: BookingRequestFormValues,
):
  | { ok: true; payload: BookingRequestPayload }
  | { ok: false; errorKey: BookingRequestFormErrorKey } {
  const message = values.message.trim();
  if (
    message.length < BOOKING_MESSAGE_MIN ||
    message.length > BOOKING_MESSAGE_MAX
  ) {
    return { ok: false, errorKey: "admin.bkErrMessageTooShort" };
  }

  const dates = values.preferredDates
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  if (
    dates.length < 1 ||
    dates.length > BOOKING_MAX_DATES ||
    dates.some((d) => !ISO_DATE_RE.test(d))
  ) {
    return { ok: false, errorKey: "admin.bkErrDates" };
  }

  let expectedDraw: number | undefined;
  const drawRaw = values.expectedDraw.trim();
  if (drawRaw.length > 0) {
    const parsed = Number(drawRaw);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1_000_000) {
      return { ok: false, errorKey: "admin.bkErrDraw" };
    }
    expectedDraw = parsed;
  }

  const genre = values.genre.trim();

  // ── Act ──────────────────────────────────────────────────────────────────
  const actName = (values.actName ?? "").trim();
  if (actName.length > BOOKING_ACT_NAME_MAX) {
    return { ok: false, errorKey: "admin.bkErrActName" };
  }

  let lineupSize: number | undefined;
  const lineupRaw = (values.lineupSize ?? "").trim();
  if (lineupRaw.length > 0) {
    const parsed = Number(lineupRaw);
    if (
      !Number.isInteger(parsed) ||
      parsed < BOOKING_LINEUP_MIN ||
      parsed > BOOKING_LINEUP_MAX
    ) {
      return { ok: false, errorKey: "admin.bkErrLineup" };
    }
    lineupSize = parsed;
  }

  // ── Performance ──────────────────────────────────────────────────────────
  let setLengthMinutes: number | undefined;
  const setLengthRaw = (values.setLengthMinutes ?? "").trim();
  if (setLengthRaw.length > 0) {
    const parsed = Number(setLengthRaw);
    if (
      !Number.isInteger(parsed) ||
      !(BOOKING_SET_LENGTH_PRESETS as readonly number[]).includes(parsed)
    ) {
      return { ok: false, errorKey: "admin.bkErrSetLength" };
    }
    setLengthMinutes = parsed;
  }

  const contactPhone = (values.contactPhone ?? "").trim();
  if (contactPhone.length > 0 && !PHONE_RE.test(contactPhone)) {
    return { ok: false, errorKey: "admin.bkErrPhone" };
  }

  const techNeeds = (values.techNeeds ?? "").trim();
  if (techNeeds.length > BOOKING_TECH_NEEDS_MAX) {
    return { ok: false, errorKey: "admin.bkErrTechNeeds" };
  }

  // ── Fee ──────────────────────────────────────────────────────────────────
  const feeTypeRaw = values.feeType ?? "";
  const feeType: BookingFeeType | undefined =
    feeTypeRaw === "" ? undefined : feeTypeRaw;
  const isPayingFee =
    feeType !== undefined && PAYING_FEE_TYPES.includes(feeType);

  // Cross-field rule (mirrors the server refine): a fee amount is only ever
  // emitted for GUARANTEE / DOOR_SPLIT. For NEGOTIABLE or an unspecified fee
  // type the amount is dropped entirely — never sent.
  let feeAmountCents: number | undefined;
  if (isPayingFee) {
    const amountRaw = (values.feeAmountDollars ?? "").trim();
    if (amountRaw.length > 0) {
      const dollars = Number(amountRaw);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        return { ok: false, errorKey: "admin.bkErrFeeAmount" };
      }
      const cents = toMinorUnits(dollars, BOOKING_FEE_CURRENCY);
      if (
        !Number.isInteger(cents) ||
        cents <= 0 ||
        cents > BOOKING_FEE_AMOUNT_MAX_CENTS
      ) {
        return { ok: false, errorKey: "admin.bkErrFeeAmount" };
      }
      feeAmountCents = cents;
    }
  }

  // ── Typed links ──────────────────────────────────────────────────────────
  const linkSlots: {
    key: "linkMusic" | "linkVideo" | "linkSocial" | "linkEpk";
    raw: string;
  }[] = [
    { key: "linkMusic", raw: (values.linkMusic ?? "").trim() },
    { key: "linkVideo", raw: (values.linkVideo ?? "").trim() },
    { key: "linkSocial", raw: (values.linkSocial ?? "").trim() },
    { key: "linkEpk", raw: (values.linkEpk ?? "").trim() },
  ];
  const links: Partial<
    Record<"linkMusic" | "linkVideo" | "linkSocial" | "linkEpk", string>
  > = {};
  for (const slot of linkSlots) {
    if (slot.raw.length === 0) continue;
    if (slot.raw.length > BOOKING_LINK_MAX || !isValidHttpUrl(slot.raw)) {
      return { ok: false, errorKey: "admin.bkErrLinkInvalid" };
    }
    links[slot.key] = slot.raw;
  }

  // FR-009: only HUMAN senders with stats worth sharing emit the flag. Gate
  // here so an org sender — or an ineligible human (whose snapshot would be
  // null) — can never emit it even if `includeVerifiedStats` is somehow set
  // (the UI also hides the checkbox in both cases — defense in depth).
  const includeVerifiedStats =
    values.includeVerifiedStats === true &&
    values.senderOwnerType === "human" &&
    values.senderStatsEligible === true;

  return {
    ok: true,
    payload: {
      message,
      preferredDates: dates,
      ...(expectedDraw !== undefined ? { expectedDraw } : {}),
      ...(genre.length > 0 ? { genre } : {}),
      ...(actName.length > 0 ? { actName } : {}),
      ...(lineupSize !== undefined ? { lineupSize } : {}),
      ...(setLengthMinutes !== undefined ? { setLengthMinutes } : {}),
      ...(contactPhone.length > 0 ? { contactPhone } : {}),
      ...(techNeeds.length > 0 ? { techNeeds } : {}),
      ...(feeType !== undefined ? { feeType } : {}),
      ...(feeAmountCents !== undefined ? { feeAmountCents } : {}),
      ...links,
      ...(includeVerifiedStats ? { includeVerifiedStats: true } : {}),
    },
  };
}

/** The place-page pitch's payload: the shared pitch plus the bill. */
export type BookingRequestWithBillPayload = BookingRequestPayload & {
  /** Omitted when the bill is the sender alone (the server's own default). */
  bill?: BookingBillPayload;
};

/**
 * {@link buildBookingRequestPayload} plus the bill (lineup v3, board F1) —
 * the signed-in place-page dialog's entry point. A separate function so the
 * embed, which shares the pitch builder but posts an anonymous inquiry that
 * takes no `bill`, keeps its payload and error-key types unchanged.
 *
 * The bill is validated AFTER the pitch fields, so the first error the
 * reader sees is still the first field on the form. `bill` is omitted when
 * it equals the server's default (the sender alone), so a pitch that never
 * touched it is byte-identical to the pre-bill payload.
 */
export function buildBookingRequestPayloadWithBill(
  values: BookingRequestFormValues,
):
  | { ok: true; payload: BookingRequestWithBillPayload }
  | { ok: false; errorKey: BookingRequestFormErrorKey | BookingBillErrorKey } {
  const pitch = buildBookingRequestPayload(values);
  if (!pitch.ok) return pitch;
  const billResult = buildBookingBillPayload({
    ...(values.billIncludeSelf !== undefined
      ? { includeSelf: values.billIncludeSelf }
      : {}),
    ...(values.billActs ? { acts: values.billActs } : {}),
    ...(values.senderOwnerType && values.senderOwnerId
      ? {
          sender: {
            ownerType: values.senderOwnerType,
            ownerId: values.senderOwnerId,
          },
        }
      : {}),
  });
  if (!billResult.ok) return { ok: false, errorKey: billResult.errorKey };
  return {
    ok: true,
    payload: billResult.bill
      ? { ...pitch.payload, bill: billResult.bill }
      : pitch.payload,
  };
}

/** Parses a whole number in `[min, max]`; anything else is "not provided". */
function parseWholeIn(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

/**
 * The PERFORM form's values as the standards rail evaluates them, LIVE —
 * field by field what {@link buildBookingRequestPayloadWithBill} would put on
 * the wire for that field, or null where the builder would drop or refuse it
 * (venue-booking-standards, contract 1 in core's standard-fields.ts: never a
 * tick on raw text the server would not receive).
 *
 * Why not the builder itself: it stops at the first problem, so one short
 * message would blank every tick. This walks each field on its own with the
 * builder's own rules; a test pins that for every input the builder accepts,
 * `isFieldSatisfied` agrees on this and on the builder's output. The submit
 * gate still runs over the builder's real output.
 */
export function pitchStandardsPayload(
  values: BookingRequestFormValues,
): BookingStandardsPayload {
  const message = values.message.trim();
  const dates = values.preferredDates
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  const datesOk =
    dates.length >= 1 &&
    dates.length <= BOOKING_MAX_DATES &&
    dates.every((d) => ISO_DATE_RE.test(d));
  const setLength = parseWholeIn(
    values.setLengthMinutes ?? "",
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  );
  const techNeeds = (values.techNeeds ?? "").trim();
  const link = (raw: string | undefined): string | null => {
    const value = (raw ?? "").trim();
    return value.length > 0 &&
      value.length <= BOOKING_LINK_MAX &&
      isValidHttpUrl(value)
      ? value
      : null;
  };
  const bill = buildBookingBillPayload({
    ...(values.billIncludeSelf !== undefined
      ? { includeSelf: values.billIncludeSelf }
      : {}),
    ...(values.billActs ? { acts: values.billActs } : {}),
    ...(values.senderOwnerType && values.senderOwnerId
      ? {
          sender: {
            ownerType: values.senderOwnerType,
            ownerId: values.senderOwnerId,
          },
        }
      : {}),
  });
  return {
    message:
      message.length >= BOOKING_MESSAGE_MIN &&
      message.length <= BOOKING_MESSAGE_MAX
        ? message
        : null,
    preferredDates: datesOk ? dates : null,
    expectedDraw: parseWholeIn(values.expectedDraw, 1, 1_000_000),
    genre: values.genre.trim() || null,
    lineupSize: parseWholeIn(
      values.lineupSize ?? "",
      BOOKING_LINEUP_MIN,
      BOOKING_LINEUP_MAX,
    ),
    setLengthMinutes:
      setLength !== null &&
      (BOOKING_SET_LENGTH_PRESETS as readonly number[]).includes(setLength)
        ? setLength
        : null,
    techNeeds:
      techNeeds.length > 0 && techNeeds.length <= BOOKING_TECH_NEEDS_MAX
        ? techNeeds
        : null,
    feeType: values.feeType ? values.feeType : null,
    linkMusic: link(values.linkMusic),
    linkVideo: link(values.linkVideo),
    linkSocial: link(values.linkSocial),
    linkEpk: link(values.linkEpk),
    bill: bill.ok ? (bill.bill ?? null) : null,
  };
}

/* ── Booking DEFAULTS (account-settings editor) ─────────────────────────────
   The "Booking defaults" editor saves reusable pitch values that later prefill
   THIS form (via `performers.getBookingDefaults`). It mirrors the
   booking-request field validation exactly — same constants, phone regex,
   http(s) URL check, and dollars→cents conversion — but differs in two ways:
     • every field is optional (no required message or preferred dates), and
     • a save carries the FULL desired form state, so an empty field is sent as
       `null` to CLEAR the stored value (the server treats null/omitted as
       cleared). `genre` is not stored here (it comes from Human.genreTags) and
       `feeCurrency` is server-derived — neither is emitted.
   Returns a per-field error map so the editor can show inline field errors. */

/** Message-template cap — same ceiling as the booking message (no lower bound). */
export const BOOKING_MESSAGE_TEMPLATE_MAX = BOOKING_MESSAGE_MAX;

export type BookingDefaultsFormValues = {
  actName: string;
  lineupSize: string;
  setLengthMinutes: string;
  contactPhone: string;
  techNeeds: string;
  messageTemplate: string;
  feeType: "" | BookingFeeType;
  feeAmountDollars: string;
  linkMusic: string;
  linkVideo: string;
  linkSocial: string;
  linkEpk: string;
  includeVerifiedStats: boolean;
};

export type BookingDefaultsField =
  | "actName"
  | "lineupSize"
  | "setLengthMinutes"
  | "contactPhone"
  | "techNeeds"
  | "messageTemplate"
  | "feeAmount"
  | "linkMusic"
  | "linkVideo"
  | "linkSocial"
  | "linkEpk";

export type BookingDefaultsFieldErrorKey =
  | "admin.bkErrActName"
  | "admin.bkErrLineup"
  | "admin.bkErrSetLength"
  | "admin.bkErrPhone"
  | "admin.bkErrTechNeeds"
  | "admin.bkErrFeeAmount"
  | "admin.bkErrLinkInvalid"
  | "account.sBkDefMsgTooLong";

/**
 * Wire payload for `performers.updateBookingDefaults` (minus owner identity,
 * server-derived `feeCurrency`, and profile-sourced `genre`). `null` clears a
 * field; the save always carries every field so omissions read as "cleared".
 */
export type BookingDefaultsPayload = {
  actName: string | null;
  lineupSize: number | null;
  setLengthMinutes: number | null;
  contactPhone: string | null;
  techNeeds: string | null;
  messageTemplate: string | null;
  feeType: BookingFeeType | null;
  feeAmountCents: number | null;
  linkMusic: string | null;
  linkVideo: string | null;
  linkSocial: string | null;
  linkEpk: string | null;
  includeVerifiedStats: boolean;
};

/**
 * Validates the booking-defaults editor values, returning the wire payload for
 * `performers.updateBookingDefaults` or a per-field map of i18n error keys.
 */
export function buildBookingDefaultsPayload(
  values: BookingDefaultsFormValues,
):
  | { ok: true; payload: BookingDefaultsPayload }
  | {
      ok: false;
      errors: Partial<Record<BookingDefaultsField, BookingDefaultsFieldErrorKey>>;
    } {
  const errors: Partial<
    Record<BookingDefaultsField, BookingDefaultsFieldErrorKey>
  > = {};

  const actName = values.actName.trim();
  if (actName.length > BOOKING_ACT_NAME_MAX) {
    errors.actName = "admin.bkErrActName";
  }

  let lineupSize: number | null = null;
  const lineupRaw = values.lineupSize.trim();
  if (lineupRaw.length > 0) {
    const parsed = Number(lineupRaw);
    if (
      !Number.isInteger(parsed) ||
      parsed < BOOKING_LINEUP_MIN ||
      parsed > BOOKING_LINEUP_MAX
    ) {
      errors.lineupSize = "admin.bkErrLineup";
    } else {
      lineupSize = parsed;
    }
  }

  let setLengthMinutes: number | null = null;
  const setLengthRaw = values.setLengthMinutes.trim();
  if (setLengthRaw.length > 0) {
    const parsed = Number(setLengthRaw);
    if (
      !Number.isInteger(parsed) ||
      !(BOOKING_SET_LENGTH_PRESETS as readonly number[]).includes(parsed)
    ) {
      errors.setLengthMinutes = "admin.bkErrSetLength";
    } else {
      setLengthMinutes = parsed;
    }
  }

  const contactPhone = values.contactPhone.trim();
  if (contactPhone.length > 0 && !PHONE_RE.test(contactPhone)) {
    errors.contactPhone = "admin.bkErrPhone";
  }

  const techNeeds = values.techNeeds.trim();
  if (techNeeds.length > BOOKING_TECH_NEEDS_MAX) {
    errors.techNeeds = "admin.bkErrTechNeeds";
  }

  const messageTemplate = values.messageTemplate.trim();
  if (messageTemplate.length > BOOKING_MESSAGE_TEMPLATE_MAX) {
    errors.messageTemplate = "account.sBkDefMsgTooLong";
  }

  // Cross-field fee rule (mirrors the server refine + the booking form): an
  // amount only rides GUARANTEE / DOOR_SPLIT; anything else clears it.
  const feeType: BookingFeeType | null =
    values.feeType === "" ? null : values.feeType;
  const isPayingFee = feeType === "GUARANTEE" || feeType === "DOOR_SPLIT";
  let feeAmountCents: number | null = null;
  if (isPayingFee) {
    const amountRaw = values.feeAmountDollars.trim();
    if (amountRaw.length > 0) {
      const dollars = Number(amountRaw);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        errors.feeAmount = "admin.bkErrFeeAmount";
      } else {
        const cents = toMinorUnits(dollars, BOOKING_FEE_CURRENCY);
        if (
          !Number.isInteger(cents) ||
          cents <= 0 ||
          cents > BOOKING_FEE_AMOUNT_MAX_CENTS
        ) {
          errors.feeAmount = "admin.bkErrFeeAmount";
        } else {
          feeAmountCents = cents;
        }
      }
    }
  }

  const linkValues: Record<
    "linkMusic" | "linkVideo" | "linkSocial" | "linkEpk",
    string | null
  > = { linkMusic: null, linkVideo: null, linkSocial: null, linkEpk: null };
  for (const field of [
    "linkMusic",
    "linkVideo",
    "linkSocial",
    "linkEpk",
  ] as const) {
    const raw = values[field].trim();
    if (raw.length === 0) continue;
    if (raw.length > BOOKING_LINK_MAX || !isValidHttpUrl(raw)) {
      errors[field] = "admin.bkErrLinkInvalid";
    } else {
      linkValues[field] = raw;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    payload: {
      actName: actName.length > 0 ? actName : null,
      lineupSize,
      setLengthMinutes,
      contactPhone: contactPhone.length > 0 ? contactPhone : null,
      techNeeds: techNeeds.length > 0 ? techNeeds : null,
      messageTemplate: messageTemplate.length > 0 ? messageTemplate : null,
      feeType,
      feeAmountCents,
      linkMusic: linkValues.linkMusic,
      linkVideo: linkValues.linkVideo,
      linkSocial: linkValues.linkSocial,
      linkEpk: linkValues.linkEpk,
      includeVerifiedStats: values.includeVerifiedStats,
    },
  };
}

/**
 * cents → the major-unit (dollars) string the fee-amount input echoes. Used to
 * prefill both surfaces from a saved `feeAmountCents`.
 */
export function centsToFeeAmountInput(cents: number): string {
  return toMajorUnits(cents, BOOKING_FEE_CURRENCY).toFixed(
    currencyFractionDigits(BOOKING_FEE_CURRENCY),
  );
}

type TrpcLikeError = {
  data?: { code?: string; meta?: Record<string, unknown> | null } | null;
  message?: string;
};

/**
 * Maps `bookingRequests.create` failures to a user-facing i18n key.
 * Canonical AppErrorCodes come from the use case (`DUPLICATE_OPEN_REQUEST`,
 * `PERFORMER_MODE_REQUIRED`, `PLACE_NOT_VERIFIED`,
 * `PLACE_NOT_ACCEPTING_REQUESTS`, `PLACE_NOT_TAKING_REQUESTS`,
 * `NOT_RESOURCE_OWNER`), plus the bill's (lineup v3 FR-002):
 * `ACT_NOT_TAGGABLE` (meta.reason duplicate / self / not_taggable),
 * `BILL_NOT_ALLOWED`, and `RATE_LIMITED` scoped to the daily tag budget.
 */
export function mapCreateBookingRequestError(err: unknown): string {
  const e = err as TrpcLikeError;
  const code = getAppErrorCode(err);
  const meta = e?.data?.meta ?? null;
  if (code === "DUPLICATE_OPEN_REQUEST") return "admin.bkErrDuplicate";
  if (code === "PERFORMER_MODE_REQUIRED") {
    // Since lineup v2 (D3) performer mode gates the SENDER'S OWN ROW on the
    // bill, not sending — so the fix is the mode or stepping off the bill.
    return "admin.bkErrBillPerformerMode";
  }
  if (code === "ACT_NOT_TAGGABLE") {
    if (meta?.reason === "duplicate") return "admin.bkErrBillDuplicate";
    if (meta?.reason === "self") return "admin.bkErrBillSelfTag";
    return "admin.bkErrBillNotTaggable";
  }
  if (code === "BILL_NOT_ALLOWED") return "admin.bkErrBillNotAllowed";
  // venue-booking-standards FR-006: the pitch misses an item the place
  // REQUIRES. The forms name the items themselves (readStandardsUnmet); this
  // key is the fallback when the meta carries no labels.
  if (code === "STANDARDS_UNMET") return "admin.bkErrStandardsUnmet";
  if (
    code === "RATE_LIMITED" &&
    (meta?.scope === "lineup_tag_budget" || e?.message === "lineup_tag_budget")
  ) {
    return "admin.bkErrBillTagBudget";
  }
  if (
    code === "PLACE_NOT_ACCEPTING_REQUESTS" ||
    code === "PLACE_NOT_VERIFIED" ||
    // ── P3a (unclaimed venues) ── an unclaimed place takes no requests.
    code === "PLACE_NOT_TAKING_REQUESTS"
  ) {
    return "admin.bkErrNotAccepting";
  }
  if (code === "NOT_RESOURCE_OWNER" || e?.data?.code === "FORBIDDEN") {
    return "admin.bkErrForbidden";
  }
  // Intent/config refusals ride `INVALID_INPUT` with a machine key in the
  // message (create-booking-request.ts: "no new error code"). The dialog only
  // offers what `places.getBookingOptions` listed, so a hit here is a stale
  // form — the copy tells the reader to pick again rather than "try again".
  if (code === "INVALID_INPUT") {
    if (e?.message === "calendar_rejects_intent") {
      return "admin.bkErrCalendarRejectsIntent";
    }
    if (e?.message === "space_not_on_calendar") {
      return "admin.bkErrSpaceNotOnCalendar";
    }
  }
  return "admin.bkErrGeneric";
}

/** One unmet REQUIRED item as the server names it — the place's own label. */
export type StandardsUnmetItem = { field: BookingStandardField; label: string };

/**
 * The items a STANDARDS_UNMET refusal names (`meta.items`, enforce-booking-
 * standards.ts), or null for any other error. Entries without a usable label
 * are skipped; an empty result is still a STANDARDS_UNMET (`[]`), so the
 * caller can fall back to {@link mapCreateBookingRequestError}'s copy.
 */
export function readStandardsUnmet(err: unknown): StandardsUnmetItem[] | null {
  if (getAppErrorCode(err) !== "STANDARDS_UNMET") return null;
  const items = (err as TrpcLikeError)?.data?.meta?.items;
  if (!Array.isArray(items)) return [];
  const out: StandardsUnmetItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const { field, label } = item as { field?: unknown; label?: unknown };
    if (typeof field !== "string" || typeof label !== "string") continue;
    if (label.trim().length === 0) continue;
    out.push({ field: field as BookingStandardField, label: label.trim() });
  }
  return out;
}

/* ── Intents (venue-confirmation-and-booking-intents spec, 2026-08-27) ─────
   The calendar is the config layer: each one says which intents it accepts.
   Everything below is a pure function of the `places.getBookingOptions` read
   so the dialog's offer/default/filter logic is pinned by unit tests rather
   than discovered in a browser. */

/** Display order — PERFORM first because it is today's default. */
export const BOOKING_INTENTS = ["PERFORM", "RENT", "USE"] as const;

/** Intents that ask for a ROOM rather than a night on the bill. */
export type SpaceIntent = Extract<BookingIntent, "RENT" | "USE">;

/** One calendar as `places.getBookingOptions` returns it. */
export type BookingOptionCalendar = {
  id: string;
  name: string;
  isDefault: boolean;
  acceptsPerform: boolean;
  acceptsRent: boolean;
  acceptsUse: boolean;
  rentalRateCents: number | null;
  rentalRateCurrency: string | null;
  rentalRateVisible: boolean;
  spaces: { id: string; name: string }[];
  /**
   * FR-004: the effective standards + examples per intent this calendar
   * takes, resolved server-side. Optional here only so test doubles that
   * predate it still type; the wire always sends it.
   */
  standards?: BookingStandardsByIntent;
};

/**
 * Whether a calendar takes this kind of request — its own three switches,
 * plus, for the two room intents, that it actually has a room.
 *
 * ROOM GATE RESTORED 2026-09-23, reversing its removal on 2026-09-22. The
 * owner ruling that day — "roomless calendars shouldn't be legal anywhere" —
 * makes a calendar with no active space INVALID DATA rather than a venue
 * configuration, and `manage-spaces` / `manage-calendars` now refuse every
 * write that would produce one. What is left in the wild is debt, so RENT and
 * USE fail closed on it: offering a calendar whose request could only ever
 * mint spaceless is worse than not offering it.
 *
 * `spaces` here is already ACTIVE-only — `getPlaceBookingOptions` filters
 * retired rooms out of the wire shape — so `length > 0` IS "has an active
 * space".
 *
 * Do not drop this again. The 09-22 reasoning ("RENT/USE need a room to
 * block; the server guard says the same") was wrong on both counts and is
 * deliberately not restored with the clause; the reason above is the one that
 * holds.
 *
 * PERFORM is deliberately ungated: a pitch for a night on the bill is routed
 * by calendar, and a venue with modelling debt should still be able to take
 * one.
 */
export function calendarAcceptsIntent(
  calendar: BookingOptionCalendar,
  intent: BookingIntent,
): boolean {
  switch (intent) {
    case "PERFORM":
      return calendar.acceptsPerform;
    case "RENT":
      return calendar.acceptsRent && calendar.spaces.length > 0;
    case "USE":
      return calendar.acceptsUse && calendar.spaces.length > 0;
  }
}

export function calendarsForIntent(
  calendars: readonly BookingOptionCalendar[],
  intent: BookingIntent,
): BookingOptionCalendar[] {
  return calendars.filter((c) => calendarAcceptsIntent(c, intent));
}

/**
 * The intents at least one calendar accepts, in display order. A place with
 * NO calendars (pre-hierarchy) still takes a pitch — the server routes it
 * unrouted, exactly as before — and nothing else.
 */
export function offeredIntents(
  calendars: readonly BookingOptionCalendar[],
): BookingIntent[] {
  if (calendars.length === 0) return ["PERFORM"];
  return BOOKING_INTENTS.filter(
    (intent) => calendarsForIntent(calendars, intent).length > 0,
  );
}

/* ── Place-page CTAs ─────────────────────────────────────────────────────── */

/** One booking button: which intent it opens the dialog on. */
export type BookingCta = {
  intent: BookingIntent;
  /** "play" → "Play here"; "space" → "Rent or use a space". */
  kind: "play" | "space";
};

/**
 * Which of the two CTAs a place page shows (spec, UI/Flow › Place page):
 * each only when some calendar accepts it, neither when a claimed venue has
 * opted out. Before the options read settles — and if it fails — today's
 * single "Play here" stands, so the first paint and the degraded state both
 * match the pre-intent page.
 */
export function bookingCtas(args: {
  offered: readonly BookingIntent[];
  acceptsBookingRequests: boolean;
  settled: boolean;
  failed: boolean;
}): BookingCta[] {
  const { offered, acceptsBookingRequests, settled, failed } = args;
  if (!settled || failed) return [{ intent: "PERFORM", kind: "play" }];
  if (!acceptsBookingRequests) return [];
  const ctas: BookingCta[] = [];
  if (offered.includes("PERFORM")) ctas.push({ intent: "PERFORM", kind: "play" });
  if (offered.includes("RENT")) ctas.push({ intent: "RENT", kind: "space" });
  else if (offered.includes("USE")) ctas.push({ intent: "USE", kind: "space" });
  return ctas;
}

/**
 * Which intent the dialog opens on. The trigger's request wins when it is
 * offered; otherwise performer mode picks PERFORM (spec: "performer mode
 * sets the DEFAULT intent"). Without performer mode the first offered ROOM
 * intent leads — landing a non-performer on the performer-mode gate when the
 * venue also rents would answer a question they did not ask — and PERFORM is
 * last resort. Null when the place offers nothing — the caller renders the
 * not-accepting copy.
 */
export function pickDefaultIntent(args: {
  offered: readonly BookingIntent[];
  requested?: BookingIntent | null;
  performerModeOn: boolean;
}): BookingIntent | null {
  const { offered, requested, performerModeOn } = args;
  if (requested && offered.includes(requested)) return requested;
  if (performerModeOn && offered.includes("PERFORM")) return "PERFORM";
  return (
    offered.find((intent) => intent !== "PERFORM") ?? offered[0] ?? null
  );
}

/** The place's default calendar when it is in the list, else the first. */
export function defaultCalendarId(
  calendars: readonly BookingOptionCalendar[],
): string | null {
  return (calendars.find((c) => c.isDefault) ?? calendars[0])?.id ?? null;
}

/* ── RENT / USE ("space") request payload ────────────────────────────────── */

/** Mirrors `BOOKING_PURPOSE_MAX_LENGTH` in the create use case. */
export const BOOKING_PURPOSE_MAX = 200;
/** Mirrors `EXPECTED_ATTENDANCE_MAX` in the create use case. */
export const BOOKING_ATTENDANCE_MAX = 1_000_000;

export type SpaceRequestFormValues = {
  intent: SpaceIntent;
  calendarId: string;
  /** Place-local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Place-local wall clock, `HH:MM`. */
  startTime: string;
  endTime: string;
  purpose: string;
  /** Raw numeric input — empty means "not provided". */
  expectedAttendance: string;
  contactPhone: string;
  /** IANA zone the wall clock is read in — the venue's, never the viewer's. */
  timeZone: string;
};

export type SpaceRequestFormErrorKey =
  | "admin.bkErrWindow"
  | "admin.bkErrWindowOrder"
  | "admin.bkErrPurpose"
  | "admin.bkErrAttendance"
  | "admin.bkErrPhone";

export type SpaceRequestPayload = {
  intent: SpaceIntent;
  calendarId: string;
  /** ISO-8601 instants. */
  requestedStartsAt: string;
  requestedEndsAt: string;
  purpose: string;
  expectedAttendance?: number;
  contactPhone?: string;
};

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * UTC offset of `timeZone` at `instant`, in ms. Built on `Intl` alone so the
 * client carries no tz database; the venue's zone is whatever the server
 * reported. Throws on an unknown zone — callers catch and fall back.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * A place-local wall clock (`YYYY-MM-DD` + `HH:MM`) → the instant it names in
 * `timeZone`. The inverse of core's `toLocalParts`.
 *
 * Away from a DST edge one offset lookup settles it. At an edge the offset
 * at the first guess differs from the offset at the answer, so a second
 * candidate is tried and the one that round-trips wins. A wall clock that
 * does not exist (the spring-forward gap) round-trips through neither, and
 * resolves to the instant AFTER the gap — what every calendar app does. Null
 * for malformed input or a zone the runtime does not know.
 */
export function wallClockToInstant(
  date: string,
  time: string,
  timeZone: string,
): Date | null {
  if (!DATE_ONLY_RE.test(date) || !TIME_RE.test(time)) return null;
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  // `Date.UTC` rolls "2027-13-01" over to 2028 instead of failing; a day that
  // does not survive the round trip is not a day.
  const day = new Date(wall);
  if (day.getUTCMonth() !== mo! - 1 || day.getUTCDate() !== d) return null;
  try {
    const offsetAtWall = zoneOffsetMs(new Date(wall), timeZone);
    const first = wall - offsetAtWall;
    const offsetAtFirst = zoneOffsetMs(new Date(first), timeZone);
    if (offsetAtFirst === offsetAtWall) return new Date(first);
    const second = wall - offsetAtFirst;
    if (zoneOffsetMs(new Date(second), timeZone) === offsetAtFirst) {
      return new Date(second);
    }
    return new Date(Math.max(first, second));
  } catch {
    return null;
  }
}

/**
 * The requested window's two instants, or the key of what is wrong with it.
 * Shared by {@link buildSpaceRequestPayload} and the live
 * {@link spaceStandardsPayload}, so the rail's window tick and the payload
 * read the clock the same way.
 */
function resolveSpaceWindow(
  values: Pick<SpaceRequestFormValues, "date" | "startTime" | "endTime" | "timeZone">,
):
  | { ok: true; startsAt: Date; endsAt: Date }
  | { ok: false; errorKey: "admin.bkErrWindow" | "admin.bkErrWindowOrder" } {
  const date = values.date.trim();
  const startTime = values.startTime.trim();
  const endTime = values.endTime.trim();
  if (
    !DATE_ONLY_RE.test(date) ||
    !TIME_RE.test(startTime) ||
    !TIME_RE.test(endTime)
  ) {
    return { ok: false, errorKey: "admin.bkErrWindow" };
  }
  if (startTime === endTime) {
    return { ok: false, errorKey: "admin.bkErrWindowOrder" };
  }
  const startsAt = wallClockToInstant(date, startTime, values.timeZone);
  let endsAt = wallClockToInstant(date, endTime, values.timeZone);
  if (endsAt && startsAt && endsAt.getTime() < startsAt.getTime()) {
    endsAt = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
  }
  if (!startsAt || !endsAt) {
    return { ok: false, errorKey: "admin.bkErrWindow" };
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    return { ok: false, errorKey: "admin.bkErrWindowOrder" };
  }
  return { ok: true, startsAt, endsAt };
}

/**
 * The RENT/USE form's values as the standards rail evaluates them, LIVE —
 * the same per-field posture as {@link pitchStandardsPayload}. `timeZone` is
 * null until the place's zone has loaded; the window reads as not provided
 * until then (the submit waits on it too).
 */
export function spaceStandardsPayload(
  values: Omit<SpaceRequestFormValues, "intent" | "calendarId" | "timeZone"> & {
    timeZone: string | null;
  },
): BookingStandardsPayload {
  const purpose = values.purpose.trim();
  const span = values.timeZone
    ? resolveSpaceWindow({ ...values, timeZone: values.timeZone })
    : null;
  return {
    purpose:
      purpose.length > 0 && purpose.length <= BOOKING_PURPOSE_MAX
        ? purpose
        : null,
    expectedAttendance: parseWholeIn(
      values.expectedAttendance,
      1,
      BOOKING_ATTENDANCE_MAX,
    ),
    requestedStartsAt: span?.ok ? span.startsAt.toISOString() : null,
    requestedEndsAt: span?.ok ? span.endsAt.toISOString() : null,
  };
}

/**
 * Validates the RENT/USE form; returns the wire fields for
 * `bookingRequests.create` or the i18n key of the first problem found (same
 * posture as `buildBookingRequestPayload`).
 *
 * An end clock EARLIER than the start rolls to the next day — a hire from
 * 8pm to 1am is one booking, and the venue reads it that way. An end EQUAL to
 * the start is refused (a zero-length window is a typo, not an overnight).
 *
 * No `spaceId`: a RENT/USE request names a DATE on a CALENDAR, and the room
 * is chosen at accept/confirm on the draft event (owner ruling — see the
 * block comment atop `components/bookings/HoldDatePicker.tsx`). The wire
 * still accepts one; this form no longer has one to send.
 */
export function buildSpaceRequestPayload(
  values: SpaceRequestFormValues,
):
  | { ok: true; payload: SpaceRequestPayload }
  | { ok: false; errorKey: SpaceRequestFormErrorKey } {
  const span = resolveSpaceWindow(values);
  if (!span.ok) return span;
  const { startsAt, endsAt } = span;

  const purpose = values.purpose.trim();
  if (purpose.length === 0 || purpose.length > BOOKING_PURPOSE_MAX) {
    return { ok: false, errorKey: "admin.bkErrPurpose" };
  }

  let expectedAttendance: number | undefined;
  const attendanceRaw = values.expectedAttendance.trim();
  if (attendanceRaw.length > 0) {
    const parsed = Number(attendanceRaw);
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > BOOKING_ATTENDANCE_MAX
    ) {
      return { ok: false, errorKey: "admin.bkErrAttendance" };
    }
    expectedAttendance = parsed;
  }

  const contactPhone = values.contactPhone.trim();
  if (contactPhone.length > 0 && !PHONE_RE.test(contactPhone)) {
    return { ok: false, errorKey: "admin.bkErrPhone" };
  }

  return {
    ok: true,
    payload: {
      intent: values.intent,
      calendarId: values.calendarId,
      requestedStartsAt: startsAt.toISOString(),
      requestedEndsAt: endsAt.toISOString(),
      purpose,
      ...(expectedAttendance !== undefined ? { expectedAttendance } : {}),
      ...(contactPhone.length > 0 ? { contactPhone } : {}),
    },
  };
}

/**
 * True when the ends-at clock reads earlier than the start — the window
 * crosses midnight. Drives the "ends the next day" hint under the inputs.
 */
export function isOvernightWindow(startTime: string, endTime: string): boolean {
  return (
    TIME_RE.test(startTime) && TIME_RE.test(endTime) && endTime < startTime
  );
}
