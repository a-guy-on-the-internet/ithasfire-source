import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestAskKind } from "@th/ports/repos/booking-requests";
import type { BookingStandardField } from "@th/types/repos/booking-standards";
import { fail } from "@th/errors";

import { parseInput } from "../../../lib/io";
import { loadEffectiveBookingStandardsForCalendar } from "../../booking-standards/load-effective-booking-standards";
import { isFieldSatisfied } from "../../booking-standards/standard-fields";
import {
  ensureBookingThreadReader,
  requireBookingRequest,
} from "../messages/_shared/thread-access";
import {
  bookingRequestAskKindSchema,
  bookingRequestAskOutputSchema,
  toAskOutput,
} from "./_shared/ask-schemas";

// ─────────────────────────────────────────────────────────────────────────────
// The ask READS (venue-booking-standards v1.1 FR-009b / FR-009c).
//
//   · `listBookingRequestAsks` — every ask on the thread, oldest first, with
//     its answer (and an attachment answer's file facts). Thread READ gate on
//     VENUE | PERFORMER — a read-only ACT is refused by the schema.
//   · `listBookingRequestAskSuggestions` — the venue's "Ask for…" list: the
//     effective standards (FR-003: the request's calendar + intent) the pitch
//     left empty, each pre-typed, minus what is already asked. Venue side
//     only.
// ─────────────────────────────────────────────────────────────────────────────

export const listBookingRequestAsksInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    side: z.enum(["VENUE", "PERFORMER"]),
  })
  .strict();

export const listBookingRequestAsksOutputSchema = z
  .object({ asks: z.array(bookingRequestAskOutputSchema) })
  .strict();

export type ListBookingRequestAsksOutput = z.infer<
  typeof listBookingRequestAsksOutputSchema
>;

export type ListBookingRequestAsksDeps = {
  repos: Repos;
  logger?: LoggerPort;
  /** The suggestions read degrades on a failed standards read and reports it. */
  reportError?: ReporterPort;
};

export async function listBookingRequestAsks(
  deps: ListBookingRequestAsksDeps,
  rawInput: unknown,
): Promise<ListBookingRequestAsksOutput> {
  const input = parseInput(listBookingRequestAsksInputSchema, rawInput);

  const request = await requireBookingRequest(
    deps.repos.bookingRequests,
    input.bookingRequestId,
  );
  await ensureBookingThreadReader(
    deps.repos,
    request,
    input.actorHumanId,
    input.side,
  );

  const asks = await deps.repos.bookingRequests.listAsks(request.id);
  const wantsFiles = asks.some((ask) => ask.answerAttachmentId !== null);
  // `listAttachments` is live-only: a deleted answer file reads as gone.
  const files = wantsFiles
    ? new Map(
        (await deps.repos.bookingRequests.listAttachments(request.id)).map(
          (file) => [file.id, file],
        ),
      )
    : new Map();

  return listBookingRequestAsksOutputSchema.parse({
    asks: asks.map((ask) =>
      toAskOutput(
        ask,
        ask.answerAttachmentId ? (files.get(ask.answerAttachmentId) ?? null) : null,
      ),
    ),
  });
}

// ── Suggestions ("Ask for…", FR-009c) ───────────────────────────────────────

/**
 * Standard field → the ask kind it is pre-typed as. The spec names LINK_VIDEO
 * → LINK, SET_LENGTH → SET_LENGTH, TECH_NEEDS → TEXT and custom → FILE; the
 * other link fields follow LINK_VIDEO, and every other askable field is
 * TEXT. `null` = never suggested: the fields the form always collects
 * (message, dates, the requested window) and the bill, which has its own
 * editor.
 */
export const ASK_KIND_FOR_STANDARD_FIELD: Record<
  BookingStandardField,
  BookingRequestAskKind | null
> = {
  MESSAGE: null,
  PREFERRED_DATES: null,
  REQUESTED_WINDOW: null,
  BILL: null,
  LINK_MUSIC: "LINK",
  LINK_VIDEO: "LINK",
  LINK_SOCIAL: "LINK",
  LINK_EPK: "LINK",
  SET_LENGTH: "SET_LENGTH",
  TECH_NEEDS: "TEXT",
  EXPECTED_DRAW: "TEXT",
  GENRE: "TEXT",
  LINEUP_SIZE: "TEXT",
  FEE: "TEXT",
  PURPOSE: "TEXT",
  EXPECTED_ATTENDANCE: "TEXT",
  CUSTOM: "FILE",
};

export const listBookingRequestAskSuggestionsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
  })
  .strict();

const suggestionSchema = z
  .object({
    field: z.string(),
    kind: bookingRequestAskKindSchema,
    requirement: z.enum(["REQUIRED", "SUGGESTED"]),
    source: z.enum(["calendar", "place", "platform"]),
    /** The venue's literal wording (venue items); null for platform items. */
    label: z.string().nullable(),
    hint: z.string().nullable(),
    /** i18n keys (platform items); null for venue items. */
    labelKey: z.string().nullable(),
    hintKey: z.string().nullable(),
  })
  .strict();

export const listBookingRequestAskSuggestionsOutputSchema = z
  .object({
    suggestions: z.array(suggestionSchema),
    /** The standards read failed and fell back to the platform defaults. */
    degraded: z.boolean(),
  })
  .strict();

export type ListBookingRequestAskSuggestionsOutput = z.infer<
  typeof listBookingRequestAskSuggestionsOutputSchema
>;

export async function listBookingRequestAskSuggestions(
  deps: ListBookingRequestAsksDeps,
  rawInput: unknown,
): Promise<ListBookingRequestAskSuggestionsOutput> {
  const input = parseInput(listBookingRequestAskSuggestionsInputSchema, rawInput);

  const request = await requireBookingRequest(
    deps.repos.bookingRequests,
    input.bookingRequestId,
  );
  await ensureBookingThreadReader(
    deps.repos,
    request,
    input.actorHumanId,
    "VENUE",
  );
  if (request.direction !== "TO_VENUE") {
    return listBookingRequestAskSuggestionsOutputSchema.parse({
      suggestions: [],
      degraded: false,
    });
  }

  const place = await deps.repos.places.getById(request.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  // Outside any transaction (the loader degrades on a failed read).
  const { effective, degraded } = await loadEffectiveBookingStandardsForCalendar(
    { repos: deps.repos, logger: deps.logger, reportError: deps.reportError },
    { place, calendarId: request.calendarId, intent: request.intent },
  );

  const asked = (await deps.repos.bookingRequests.listAsks(request.id)).filter(
    (ask) => ask.status !== "WITHDRAWN" && ask.standardField !== null,
  );

  const suggestions = effective.standards.flatMap((standard) => {
    const kind = ASK_KIND_FOR_STANDARD_FIELD[standard.field] ?? null;
    if (kind === null) return [];
    const label = standard.source === "platform" ? null : standard.label;
    // A known field the pitch filled is not suggested. Custom lines have no
    // pitch field, so they always are.
    if (standard.field !== "CUSTOM" && isFieldSatisfied(standard.field, request)) {
      return [];
    }
    const alreadyAsked = asked.some(
      (ask) =>
        ask.standardField === standard.field &&
        (standard.field !== "CUSTOM" || ask.label === label),
    );
    if (alreadyAsked) return [];
    return [
      {
        field: standard.field,
        kind,
        requirement: standard.requirement,
        source: standard.source,
        label,
        hint: standard.source === "platform" ? null : standard.hint,
        labelKey: standard.source === "platform" ? standard.labelKey : null,
        hintKey: standard.source === "platform" ? standard.hintKey : null,
      },
    ];
  });

  return listBookingRequestAskSuggestionsOutputSchema.parse({
    suggestions,
    degraded,
  });
}
