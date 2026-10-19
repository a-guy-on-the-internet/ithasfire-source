import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { BookingRequestMessageRow } from "@th/ports/repos/booking-request-messages";

import { parseInput } from "../../../lib/io";
import { normalizeLegacySystemEntry } from "../../../lib/legacy-place-values";
import { bookingRequestMessageOutputSchema } from "./post-message";
import {
  isPartiesOnlySystemEntry,
  isSenderOnlySystemEntry,
  isVenueInternalSystemEntry,
} from "./_shared/system-entries";
import {
  ensureBookingThreadReader,
  requireBookingRequest,
} from "./_shared/thread-access";

// ─────────────────────────────────────────────────────────────────────────────
// listBookingRequestMessages — one thread page, oldest first (chat reading
// order), cursor = message id (house convention; see the port doc).
//
// Read-only: closed (DECLINED/WITHDRAWN/EXPIRED) threads still list — the
// calm read-only state of FR-002/FR-005. Read receipts are NOT stamped here
// (deliberate split from the 2026-07-14 sketch): `mark-read` is its own
// use case so polling a thread never mutates.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export const listBookingRequestMessagesInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    bookingRequestId: z.string().uuid(),
    /**
     * The reader's declared side — verified (see thread-access). "ACT" is a
     * confirmed tagged artist on the bill: read-only (lineup v2, FR-008).
     */
    side: z.enum(["VENUE", "PERFORMER", "ACT"]),
    cursor: z.string().uuid().nullable().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export const listBookingRequestMessagesOutputSchema = z
  .object({
    items: z.array(bookingRequestMessageOutputSchema),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();

export type ListBookingRequestMessagesUseCaseInput = z.infer<
  typeof listBookingRequestMessagesInputSchema
>;
export type ListBookingRequestMessagesOutput = z.infer<
  typeof listBookingRequestMessagesOutputSchema
>;

export type ListBookingRequestMessagesDeps = {
  /** See post-message.ts for the Required<> staging note. */
  repos: Repos & Required<Pick<Repos, "bookingRequestMessages">>;
  logger?: LoggerPort;
  /**
   * Best-effort reporter for the one deliberate swallow here: the act-state
   * read behind `dropWithdrawnActConfirmations` failing, which degrades by
   * hiding EVERY act confirmation on the page (fail closed). ReporterPort
   * convention — a throwing reporter changes nothing.
   */
  reportError?: ReporterPort;
};

/**
 * The ledger kinds whose visibility depends on the act's CURRENT state: "X
 * joined the bill" and (v3 FR-010) "X joined and is on the lineup". Both are
 * hidden from the venue / act sides once the act is no longer joined.
 */
const ACT_STATE_GATED_KINDS: ReadonlySet<string> = new Set([
  "booking_request.act_confirmed",
  "booking_request.act_joined_lineup",
]);

export async function listBookingRequestMessages(
  deps: ListBookingRequestMessagesDeps,
  rawInput: unknown,
): Promise<ListBookingRequestMessagesOutput> {
  const input = parseInput(listBookingRequestMessagesInputSchema, rawInput);

  const request = await requireBookingRequest(
    deps.repos.bookingRequests,
    input.bookingRequestId,
  );
  // READ gate: membership-any — whoever sees the request in a list surface
  // may read its thread (thread-access module doc).
  await ensureBookingThreadReader(
    deps.repos,
    request,
    input.actorHumanId,
    input.side,
  );

  const page = await deps.repos.bookingRequestMessages.listForRequest({
    bookingRequestId: request.id,
    cursor: input.cursor ?? null,
    limit: input.limit,
  });

  // Ledger rows written before 2026-10-18 spell some kinds and params the
  // old way; every reader past this line sees the current spelling only
  // (`lib/legacy-place-values`). The stored rows are append-only and stay
  // as they are.
  const rows = page.items.map(normalizeLegacySystemEntry);

  // Venue-internal ledger kinds never reach the PERFORMER side, and
  // sender-only kinds (a declined act, lineup v2 FR-004) never reach the
  // VENUE side (the gate lives with the data, not the renderer — a client
  // that does not know to hide a kind must not receive it). A confirmed ACT
  // (FR-008) sees what the venue sees and nothing venue-internal on top:
  // it is neither party. The cursor is unaffected: it is the repo page's
  // last row, hidden or not.
  const items = rows.filter((row) => {
    switch (input.side) {
      case "PERFORMER":
        return !isVenueInternalSystemEntry(row.systemKind);
      case "VENUE":
        return !isSenderOnlySystemEntry(row.systemKind);
      case "ACT":
        // ── P3b (asks) ── asks and answers are the two parties' only.
        return (
          !isSenderOnlySystemEntry(row.systemKind) &&
          !isVenueInternalSystemEntry(row.systemKind) &&
          !isPartiesOnlySystemEntry(row.systemKind)
        );
      default: {
        const exhaustive: never = input.side;
        return exhaustive;
      }
    }
  });

  // A confirmation that was later WITHDRAWN (CONFIRMED → DECLINED) must not
  // keep saying "X confirmed" to anyone who may not see declined acts —
  // FR-004: a declined act is absent from the venue's thread, not struck.
  // The sender keeps the full history (confirmed, then declined).
  const visible =
    input.side === "PERFORMER"
      ? items
      : await dropWithdrawnActConfirmations(deps, request, items, input.side);

  return listBookingRequestMessagesOutputSchema.parse({
    // A joined ACT never learns who else is still only INVITED (v3 FR-013):
    // the venue may see invited acts by name, an act on the bill may not.
    items: input.side === "ACT" ? visible.map(redactForAct) : visible,
    nextCursor: page.nextCursor,
  });
}

const BILL_CHANGED_KIND = "booking_request.bill_changed";

/**
 * The ACT side's copy of a `booking_request.bill_changed` entry (v3 FR-013,
 * coordinator ruling 2026-09-30): ONLY that the bill changed
 * (`changed: true`), plus the names of joined and by-name acts that were
 * added or removed — the same acts the invite page shows
 * (`get-booking-request-act-invite`). Invited adds are dropped without a
 * trace, and no count or flag passes. Every other row is unchanged. The
 * stored entry is untouched — this is the read side's view.
 */
export function redactForAct(
  row: BookingRequestMessageRow,
): BookingRequestMessageRow {
  const data = row.systemData;
  if (row.systemKind !== BILL_CHANGED_KIND || !data) return row;
  // Fail closed: only rows that are plainly joined / by-name pass.
  const shown = (key: "added" | "removed", stateField: "state" | "wasState") =>
    (Array.isArray(data[key]) ? (data[key] as unknown[]) : []).filter((item) => {
      const state =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)[stateField]
          : undefined;
      return state === "joined" || state === "by_name";
    });
  // Built from scratch, not spread: nothing else on the stored entry —
  // `otherRemovedCount`, `reordered`, `roleChanged`, or a count of the
  // invited adds — reaches the act. Each could tell it an invited act came,
  // went, moved or changed role. It reads only that the bill changed.
  return {
    ...row,
    systemData: {
      added: shown("added", "state"),
      removed: shown("removed", "wasState"),
      changed: true,
    },
  };
}

/**
 * Drop every `booking_request.act_confirmed` — and (v3 FR-010)
 * `booking_request.act_joined_lineup` — entry whose act is no longer
 * CONFIRMED (withdrawn → DECLINED, or gone). ONE bill read per call, and
 * none at all when the page carries neither kind (the common case).
 *
 * The read INCLUDES sender-removed acts (v3 FR-001): an act that joined and
 * was later taken off the bill keeps its CONFIRMED state on the removed row,
 * so its "joined the bill" line stays — it is true history, and the later
 * `bill_changed` entry says it left. An act removed while invited, or one
 * that passed, is not CONFIRMED and its line (if any) goes, as before.
 *
 * A restored act joins AGAIN (restore puts a TAGGED row back to PENDING), so
 * one act can have two `act_confirmed` entries. Only the LATEST on the page
 * is kept: the venue reads "X joined" once, at the moment that still holds.
 * Per page: an older page fetched on its own may still show the earlier
 * line (pages are oldest-first; a cross-page dedupe would need every later
 * page read up front).
 *
 * DELIBERATE SWALLOW, FAIL CLOSED: if the bill cannot be read, EVERY act
 * confirmation on the page is hidden — showing one we could not check might
 * tell the venue a withdrawn artist is on the bill. The rest of the thread
 * still renders. Logged AND reported (ReporterPort convention).
 */
async function dropWithdrawnActConfirmations(
  deps: ListBookingRequestMessagesDeps,
  request: BookingRequestRecord,
  items: BookingRequestMessageRow[],
  side: "VENUE" | "ACT",
): Promise<BookingRequestMessageRow[]> {
  const gated = (row: BookingRequestMessageRow) =>
    row.systemKind !== null && ACT_STATE_GATED_KINDS.has(row.systemKind);
  if (!items.some(gated)) {
    return items;
  }

  let stillConfirmed: Set<string>;
  try {
    const acts = await deps.repos.bookingRequests.listActsForRequests(
      [request.id],
      { includeRemoved: true },
    );
    stillConfirmed = new Set(
      acts.filter((act) => act.confirmation === "CONFIRMED").map((act) => act.id),
    );
  } catch (error) {
    deps.logger?.error("booking_requests.messages.act_state_lookup_failed", {
      bookingRequestId: request.id,
      side,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: {
          useCase: "listBookingRequestMessages",
          step: "actConfirmations",
        },
        extra: { bookingRequestId: request.id, side },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // fail-closed fallback into a thrown error.
    }
    stillConfirmed = new Set();
  }

  // The latest entry per (kind, act) on this page (items are oldest-first,
  // so the last one seen wins).
  const latestOf = new Map<string, string>();
  for (const row of items) {
    if (!gated(row)) continue;
    const actId = row.systemData?.actId;
    if (typeof actId === "string") {
      latestOf.set(`${row.systemKind}:${actId}`, row.id);
    }
  }

  return items.filter((row) => {
    if (!gated(row)) return true;
    const actId = row.systemData?.actId;
    return (
      typeof actId === "string" &&
      stillConfirmed.has(actId) &&
      latestOf.get(`${row.systemKind}:${actId}`) === row.id
    );
  });
}
