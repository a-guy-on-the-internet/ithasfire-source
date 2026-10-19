import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { SavedSnippetRecord } from "@th/types/repos/saved-snippets";
import { SAVED_SNIPPETS_MAX_PER_KIND } from "@th/types/repos/saved-snippets";

import { parseInput } from "../../lib/io";
import { BOOKING_REASON_MAX } from "../booking-requests/messages/_shared/system-entries";
import { lockListAndCopyStarters } from "./_shared/copy-starters";
import {
  resolveSavedSnippetOwner,
  savedSnippetOwnerInputSchema,
} from "./_shared/saved-snippet-owner";
import {
  savedSnippetKindInputSchema,
  savedSnippetOutputSchema,
  starterLocaleInputSchema,
  toSavedSnippetOutput,
} from "./_shared/saved-snippet-schemas";

// ─────────────────────────────────────────────────────────────────────────────
// listSavedSnippets (booking-the-night FR-013): the reasons the picker offers,
// and the list the booking settings manage.
//
// FIRST USE COPIES THE STARTERS. A list that has never been used gets the
// platform starters, once, under the list lock (`lockListAndCopyStarters`), so
// two first reads at once copy them exactly once.
//
// THE COMMON READ TAKES NO LOCK. A plain list read first; only an EMPTY list
// goes on to read the list row's state (still no lock), and only a list whose
// starters were never copied opens the locking transaction. A list that has
// reasons in it, or one whose owner deleted every reason, never locks. (An
// empty first read whose state says "copied" re-reads the list once: another
// first use may have committed between the two reads.)
//
// `maxBodyLength` narrows the picker to reasons that fit the field it fills
// (an act's pass takes 240; every other reason field 1000). `total` counts
// the whole list either way, so the settings screen can show the cap.
//
// DEGRADES, NEVER BLOCKS A DECLINE. If copying the starters fails, the read
// returns the list without them (logger.error + reportError, ReporterPort
// convention) and the next read tries again. The reason field still works.
// ─────────────────────────────────────────────────────────────────────────────

export type ListSavedSnippetsDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "savedSnippets"
    | "authz"
    | "places"
    | "placeBookingGrants"
    | "humanDelegates"
    | "calendars"
    | "humans"
    | "audit"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Reports a failed starter copy the read degraded past. */
  reportError?: ReporterPort;
};

export const listSavedSnippetsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    owner: savedSnippetOwnerInputSchema,
    kind: savedSnippetKindInputSchema,
    /** Only reasons whose body fits this many characters. */
    maxBodyLength: z.number().int().min(1).max(BOOKING_REASON_MAX).optional(),
    locale: starterLocaleInputSchema,
  })
  .strict();

export const listSavedSnippetsOutputSchema = z
  .object({
    /** Whose list this resolved to — the UI says "yours" or the organisation's. */
    ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
    snippets: z.array(savedSnippetOutputSchema),
    /** Every reason in the list, before `maxBodyLength`. */
    total: z.number().int().min(0),
    /** The per-list cap. */
    max: z.number().int(),
  })
  .strict();

export type ListSavedSnippetsInput = z.input<typeof listSavedSnippetsInputSchema>;
export type ListSavedSnippetsOutput = z.infer<typeof listSavedSnippetsOutputSchema>;

export async function listSavedSnippets(
  deps: ListSavedSnippetsDeps,
  rawInput: unknown,
): Promise<ListSavedSnippetsOutput> {
  const input = parseInput(listSavedSnippetsInputSchema, rawInput);
  const now = deps.clock.now();
  const owner = await resolveSavedSnippetOwner(deps.repos, {
    actorHumanId: input.actorHumanId,
    owner: input.owner,
    access: "read",
    now,
  });
  const key = { ...owner, kind: input.kind };

  let rows: SavedSnippetRecord[] = await deps.repos.savedSnippets.listByOwner(key);
  if (rows.length === 0) {
    const state = await deps.repos.savedSnippets.getListState(key);
    if (state?.startersCopiedAt) {
      // Copied — maybe by a concurrent first use that committed between the
      // two reads above. Re-read once so its starters are not missed.
      rows = await deps.repos.savedSnippets.listByOwner(key);
    } else {
      try {
        rows = await deps.repos.tx(async (tx) => {
          await lockListAndCopyStarters(tx, {
            key,
            actorHumanId: input.actorHumanId,
            requestedLocale: input.locale ?? null,
            now,
          });
          return tx.savedSnippets.listByOwner(key);
        });
      } catch (err) {
        const context = {
          ownerType: key.ownerType,
          ownerId: key.ownerId,
          kind: key.kind,
          actorHumanId: input.actorHumanId,
        };
        deps.logger?.error("saved_snippets.starter_copy_failed", { err, ...context });
        try {
          deps.reportError?.(err, {
            tags: { useCase: "listSavedSnippets", step: "copy_starters" },
            extra: context,
          });
        } catch {
          // A throwing reporter never changes the read (ReporterPort contract).
        }
        // `rows` is still the empty list read above.
      }
    }
  }

  const fitting =
    input.maxBodyLength === undefined
      ? rows
      : rows.filter((row) => row.body.length <= input.maxBodyLength!);

  return listSavedSnippetsOutputSchema.parse({
    ownerType: owner.ownerType,
    snippets: fitting.map(toSavedSnippetOutput),
    total: rows.length,
    max: SAVED_SNIPPETS_MAX_PER_KIND,
  });
}
