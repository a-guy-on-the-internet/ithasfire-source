/**
 * Pure helpers for the "Request to book" embed widget
 * (spec 2026-07-13 booking-request-embed-button FR-002/NFR-005).
 *
 * Validation is a thin wrapper around the platform booking form's
 * `buildBookingRequestPayload` (single source of truth for pitch-field rules —
 * message bounds, ISO dates, set-length presets, fee cross-field rule, http(s)
 * links), translated to hardcoded English copy: the embed surface deliberately
 * doesn't use the locale catalogs (see EMBED_ORIGIN_BLOCKED_MESSAGE's note in
 * lib/embed-host-origin.ts and EmbedErrorScreen's inline strings).
 */

import {
  BOOKING_ACT_NAME_MAX,
  buildBookingRequestPayload,
  type BookingRequestFormErrorKey,
  type BookingRequestPayload,
} from "@/app/p/[slug]/_components/blocks/request-to-play-form.helpers";
import {
  EMBED_ORIGIN_BLOCKED_MESSAGE,
} from "@/lib/embed-host-origin";
import { getAppErrorCode } from "@/lib/app-error";
import type { BookingFeeType } from "@th/types/repos/booking-requests";

// ─────────────────────────────────────────────────────────────────────────────
// Form model
// ─────────────────────────────────────────────────────────────────────────────

/** Max preferred dates the embed form offers — same cap as the platform form. */
export const EMBED_BOOKING_MAX_DATES = 3;

/** Raw (string-typed) values of the shared pitch fields. */
export type EmbedPitchValues = {
  actName: string;
  message: string;
  /** ISO `YYYY-MM-DD`; empty entries dropped before validation. */
  preferredDates: string[];
  expectedDraw: string;
  genre: string;
  lineupSize: string;
  setLengthMinutes: string;
  techNeeds: string;
  feeType: "" | BookingFeeType;
  feeAmountDollars: string;
  linkMusic: string;
  linkVideo: string;
  linkSocial: string;
  linkEpk: string;
};

export const EMPTY_PITCH_VALUES: EmbedPitchValues = {
  actName: "",
  message: "",
  preferredDates: [""],
  expectedDraw: "",
  genre: "",
  lineupSize: "",
  setLengthMinutes: "",
  techNeeds: "",
  feeType: "",
  feeAmountDollars: "",
  linkMusic: "",
  linkVideo: "",
  linkSocial: "",
  linkEpk: "",
};

/** Fields an inline validation error can attach to. */
export type EmbedPitchField =
  | "actName"
  | "message"
  | "dates"
  | "expectedDraw"
  | "genre"
  | "lineupSize"
  | "setLength"
  | "techNeeds"
  | "feeAmount"
  | "links";

export type EmbedPitchError = { field: EmbedPitchField; message: string };

/** Fields living inside the collapsed "More details" section. */
export const PITCH_DETAIL_FIELDS: ReadonlySet<EmbedPitchField> = new Set([
  "expectedDraw",
  "genre",
  "lineupSize",
  "setLength",
  "techNeeds",
  "feeAmount",
  "links",
]);

/** Deterministic DOM ids so errors can move focus to the offending input. */
export function pitchFieldId(idBase: string, field: EmbedPitchField): string {
  return `${idBase}-${field}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation (client mirror of the server rules)
// ─────────────────────────────────────────────────────────────────────────────

/** Platform-form error keys → embed field + English copy. */
const FORM_ERROR_COPY: Record<BookingRequestFormErrorKey, EmbedPitchError> = {
  "admin.bkErrMessageTooShort": {
    field: "message",
    message: "Your pitch needs at least 10 characters.",
  },
  "admin.bkErrDates": {
    field: "dates",
    message: "Pick at least one preferred date.",
  },
  "admin.bkErrDraw": {
    field: "expectedDraw",
    message: "Expected draw must be a whole number greater than zero.",
  },
  "admin.bkErrActName": {
    field: "actName",
    message: `Act name must be ${BOOKING_ACT_NAME_MAX} characters or fewer.`,
  },
  "admin.bkErrLineup": {
    field: "lineupSize",
    message: "Lineup size must be between 1 and 100.",
  },
  "admin.bkErrSetLength": {
    field: "setLength",
    message: "Choose one of the set length options.",
  },
  // Unreachable — the embed form has no phone field — kept for exhaustiveness.
  "admin.bkErrPhone": {
    field: "message",
    message: "Enter a valid phone number.",
  },
  "admin.bkErrTechNeeds": {
    field: "techNeeds",
    message: "Tech needs must be 2,000 characters or fewer.",
  },
  "admin.bkErrFeeAmount": {
    field: "feeAmount",
    message: "Enter a valid fee amount.",
  },
  "admin.bkErrLinkInvalid": {
    field: "links",
    message: "Links must be full web addresses (https://…).",
  },
};

export type BuildEmbedPitchResult =
  | { ok: true; payload: BookingRequestPayload }
  | { ok: false; error: EmbedPitchError };

/**
 * Validates the pitch fields and builds the wire payload shared by BOTH
 * submission paths (`embeds.createBookingInquiry` pitch subset and
 * `bookingRequests.create`). Anonymous submissions require an act name — the
 * inquiry has no sender profile to name it.
 */
export function buildEmbedPitchPayload(
  values: EmbedPitchValues,
  opts: { requireActName: boolean; senderOwnerType?: "human" | "org" },
): BuildEmbedPitchResult {
  if (opts.requireActName && values.actName.trim().length === 0) {
    return {
      ok: false,
      error: { field: "actName", message: "Enter your act or band name." },
    };
  }

  const result = buildBookingRequestPayload({
    message: values.message,
    preferredDates: values.preferredDates,
    expectedDraw: values.expectedDraw,
    genre: values.genre,
    actName: values.actName,
    lineupSize: values.lineupSize,
    setLengthMinutes: values.setLengthMinutes,
    techNeeds: values.techNeeds,
    feeType: values.feeType,
    feeAmountDollars: values.feeAmountDollars,
    linkMusic: values.linkMusic,
    linkVideo: values.linkVideo,
    linkSocial: values.linkSocial,
    linkEpk: values.linkEpk,
    ...(opts.senderOwnerType ? { senderOwnerType: opts.senderOwnerType } : {}),
    // The embed form never offers the verified-stats opt-in.
    includeVerifiedStats: false,
  });

  if (!result.ok) {
    return { ok: false, error: FORM_ERROR_COPY[result.errorKey] };
  }
  return { ok: true, payload: result.payload };
}

// ── Anonymous contact fields ─────────────────────────────────────────────────

export const CONTACT_NAME_MAX = 120;

/** Pragmatic client-side email shape check; the server runs the full rule. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateContactName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Enter your name.";
  if (trimmed.length > CONTACT_NAME_MAX) {
    return `Name must be ${CONTACT_NAME_MAX} characters or fewer.`;
  }
  return null;
}

export function validateContactEmail(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Enter your email address.";
  if (trimmed.length > 320 || !EMAIL_RE.test(trimmed)) {
    return "Enter a valid email address.";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Submit-error mapping (tRPC appCodes → embed English copy)
// ─────────────────────────────────────────────────────────────────────────────

export type EmbedSubmitErrorKind =
  | "duplicate"
  | "turnstile"
  | "notAccepting"
  | "rateLimited"
  | "origin"
  | "unauthorized"
  | "performerMode"
  | "notOwner"
  | "generic";

export type EmbedSubmitError = {
  kind: EmbedSubmitErrorKind;
  message: string;
};

/**
 * Maps `embeds.createBookingInquiry` / `bookingRequests.create` failures to
 * user-facing copy (mapCreateBookingRequestError pattern, English inline).
 * appCodes are checked before the coarse tRPC buckets so e.g. an
 * EMBED_ORIGIN_NOT_ALLOWED FORBIDDEN keeps its specific message.
 */
export function mapEmbedBookingSubmitError(err: unknown): EmbedSubmitError {
  const appCode = getAppErrorCode(err);
  const data = (
    err as {
      data?: { code?: string; meta?: Record<string, unknown> };
    } | null
  )?.data;
  const trpcCode = data?.code;
  const metaScope = data?.meta?.scope;

  if (appCode === "DUPLICATE_OPEN_REQUEST") {
    return {
      kind: "duplicate",
      message:
        "You already have an open request with this place. They can reply to that one.",
    };
  }
  if (
    appCode === "TURNSTILE_TOKEN_REQUIRED" ||
    appCode === "TURNSTILE_VERIFICATION_FAILED"
  ) {
    return {
      kind: "turnstile",
      message: "Human verification failed. Complete the check and try again.",
    };
  }
  if (
    appCode === "PLACE_NOT_ACCEPTING_REQUESTS" ||
    appCode === "PLACE_NOT_VERIFIED" ||
    // ── P3a (unclaimed venues) ── an unclaimed place takes no requests.
    appCode === "PLACE_NOT_TAKING_REQUESTS"
  ) {
    return {
      kind: "notAccepting",
      message: "This place isn't taking booking requests right now.",
    };
  }
  if (appCode === "EMBED_ORIGIN_NOT_ALLOWED") {
    return { kind: "origin", message: EMBED_ORIGIN_BLOCKED_MESSAGE };
  }
  if (appCode === "PERFORMER_MODE_REQUIRED") {
    return {
      kind: "performerMode",
      message: "Performer mode is required to send booking requests.",
    };
  }
  if (appCode === "NOT_RESOURCE_OWNER") {
    return {
      kind: "notOwner",
      message: "You don't have access to submit as that profile.",
    };
  }
  // Per-place daily cap (30/day on embeds.createBookingInquiry): arrives as
  // TOO_MANY_REQUESTS with appCode RATE_LIMITED + meta.scope, so it must be
  // discriminated BEFORE the generic per-IP branch — the venue's daily budget
  // is exhausted, not the visitor's connection, and the window is up to 24h.
  if (metaScope === "booking_inquiry_place_daily") {
    return {
      kind: "rateLimited",
      message:
        "This place has reached today's booking request limit. Please try again tomorrow.",
    };
  }
  if (trpcCode === "TOO_MANY_REQUESTS") {
    return {
      kind: "rateLimited",
      message:
        "Too many requests from this connection. Wait a minute and try again.",
    };
  }
  if (trpcCode === "UNAUTHORIZED") {
    return {
      kind: "unauthorized",
      message: "Your session expired. Log in again to continue.",
    };
  }
  if (trpcCode === "FORBIDDEN") {
    return { kind: "origin", message: EMBED_ORIGIN_BLOCKED_MESSAGE };
  }
  return {
    kind: "generic",
    message: "Something went wrong sending your request. Please try again.",
  };
}
