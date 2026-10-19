import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  projectSettlementForViewer,
  settlementViewSchema,
  visiblePayeeIds,
} from "./_shared/deal-visibility";
import {
  acknowledgedIncompleteSchema,
  currentSheet,
  ledgerSummarySchema,
  sheetCompletenessSchema,
  loadSheetContext,
  sheetEntriesSchema,
  type ComputedSheet,
  type SheetContext,
} from "./_shared/settlement-sheet";
import {
  dealPayeeSchema,
  dealRemainderSourceSchema,
  describePayees,
} from "./get-agreement-deal";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getEventSettlementInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

export const getEventSettlementOutputSchema = z
  .object({
    eventId: z.uuid(),
    /** DRAFT until the organiser marks it settled after the show. */
    status: z.enum(["DRAFT", "SETTLED"]),
    /** True when this is the frozen copy (SETTLED), never recomputed. */
    frozen: z.boolean(),
    /** Who settled it, when, by which engine. Null for an OWN_LINE viewer. */
    settled: z
      .object({
        byHumanId: z.string(),
        at: z.date(),
        engineVersion: z.number().int(),
        /** W2: settled on purpose while money was missing, and what was. */
        acknowledgedIncomplete: acknowledgedIncompleteSchema.nullable(),
      })
      .strict()
      .nullable(),
    reopened: z.object({ byHumanId: z.string(), at: z.date() }).strict().nullable(),
    eventEnded: z.boolean(),
    viewer: z
      .object({
        visibility: z.enum(["FULL", "OWN_LINE"]),
        canEdit: z.boolean(),
        canMarkSettled: z.boolean(),
      })
      .strict(),
    /** Null for an OWN_LINE viewer. */
    remainder: z
      .object({ payeeId: z.string(), source: dealRemainderSourceSchema })
      .strict()
      .nullable(),
    sheet: settlementViewSchema,
    /** Who typed what, when. Empty for an OWN_LINE viewer (its amounts are in `sheet`). */
    entries: sheetEntriesSchema,
    /** Order coverage. Null for an OWN_LINE viewer. */
    ledger: ledgerSummarySchema.nullable(),
    /**
     * W2: whether the sheet holds all the money it should — the calculator's
     * own check plus what was left out of it. Null for an OWN_LINE viewer.
     */
    completeness: sheetCompletenessSchema.nullable(),
    /** Typed-in rows the deal can no longer place. Empty for OWN_LINE. */
    staleEntryIds: z.array(z.string()),
    payees: z.array(dealPayeeSchema),
  })
  .strict();

export type GetEventSettlementInput = z.infer<typeof getEventSettlementInputSchema>;
export type GetEventSettlementOutput = z.infer<typeof getEventSettlementOutputSchema>;

export type GetEventSettlementDeps = {
  repos: Pick<
    Repos,
    | "events"
    | "deals"
    | "agreements"
    | "bookingRequests"
    | "payees"
    | "authz"
    | "humans"
    | "organizations"
  >;
  clock: ClockPort;
  /** Typed-in rows the deal can no longer place are left out and reported. */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The event settlement sheet (FR-004 data): `computeDealSettlement` in ACTUAL
 * mode on the ledger's ticket money net of refunds, with what was typed in
 * and who typed it, and the settled status. Shaped for the viewer on the
 * server (M5); never public.
 */
export async function getEventSettlement(
  deps: GetEventSettlementDeps,
  rawInput: unknown,
): Promise<GetEventSettlementOutput> {
  const input = parseInput(getEventSettlementInputSchema, rawInput);
  const ctx = await loadSheetContext(deps.repos, {
    eventId: input.eventId,
    actorHumanId: input.actorHumanId,
    now: deps.clock.now(),
  });
  const computed = await currentSheet(deps.repos, ctx, {
    reportError: deps.reportError,
  });
  const view = await buildSettlementView(deps.repos, ctx, computed);
  return getEventSettlementOutputSchema.parse(view);
}

/** Shared with the CSV export: the sheet exactly as this viewer may see it. */
export async function buildSettlementView(
  repos: Pick<Repos, "payees" | "humans" | "organizations">,
  ctx: SheetContext,
  computed: ComputedSheet & { frozen: boolean },
): Promise<GetEventSettlementOutput> {
  const sheet = projectSettlementForViewer(computed.result, ctx.viewer);
  const stored = ctx.sheet;
  const status = stored?.status ?? "DRAFT";
  if (ctx.viewer.visibility === "OWN_LINE") {
    // M5/M14 (review B2, round 2): a payee who is not a party gets ITS OWN
    // LINE and whether the sheet is settled — nothing else of the sheet.
    // Not who settled it or when, not the engine that froze it, not an
    // acknowledgement that it was settled incomplete, not a reopen, not
    // who typed which row (its own rows' amounts are in `sheet`), not the
    // ledger, completeness, stale rows or the remainder holder.
    return {
      eventId: ctx.event.id,
      status,
      frozen: computed.frozen,
      settled: null,
      reopened: null,
      eventEnded: ctx.eventEnded,
      viewer: { visibility: "OWN_LINE", canEdit: false, canMarkSettled: false },
      remainder: null,
      sheet,
      entries: { offPlatform: [], deductionActuals: [], directPayments: [] },
      ledger: null,
      completeness: null,
      staleEntryIds: [],
      payees: await describePayees(repos, visiblePayeeIds(sheet)),
    };
  }
  return {
    eventId: ctx.event.id,
    status,
    frozen: computed.frozen,
    settled:
      stored?.status === "SETTLED" &&
      stored.settledByHumanId &&
      stored.settledAt &&
      stored.engineVersion !== null
        ? {
            byHumanId: stored.settledByHumanId,
            at: stored.settledAt,
            engineVersion: stored.engineVersion,
            acknowledgedIncomplete: computed.acknowledgedIncomplete,
          }
        : null,
    reopened:
      stored?.reopenedAt && stored.reopenedByHumanId
        ? { byHumanId: stored.reopenedByHumanId, at: stored.reopenedAt }
        : null,
    eventEnded: ctx.eventEnded,
    viewer: {
      visibility: "FULL",
      canEdit: ctx.access.canEdit,
      canMarkSettled: ctx.access.canSettle,
    },
    remainder: computed.remainder,
    sheet,
    entries: computed.entries,
    ledger: computed.ledger,
    completeness: computed.completeness,
    staleEntryIds: computed.staleEntryIds,
    payees: await describePayees(repos, visiblePayeeIds(sheet)),
  };
}
