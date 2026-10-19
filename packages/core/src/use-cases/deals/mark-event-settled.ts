/**
 * "Mark settled" and its one way back (FR-004). Neither moves money (stage 1).
 *
 * MARK SETTLED — the organiser (OWNER/ADMIN of the owning org, or the human
 * owner; never a delegate), only once the show is over. In ONE transaction
 * holding the sheet's lock: compute the sheet on the real numbers, freeze the
 * engine version, the inputs and the output into the row, flip DRAFT →
 * SETTLED. From then on the sheet is read from that copy and every write is
 * refused, so a later engine change or a late ledger entry can never rewrite
 * what both sides filed.
 *
 * REOPEN — in scope, and minimal: the same people, a reason, SETTLED → DRAFT.
 * Without it a sheet settled on a typo is permanent short of a database
 * edit; with it, reopening is visible (`reopenedAt/By` on the sheet) and the
 * frozen copy it discards is kept in the audit log with the reason. Nothing
 * was paid on the strength of the settled sheet in stage 1, so reopening it
 * unwinds nothing.
 */
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { fail } from "@th/errors";

import { isEventPast } from "../../lib/event-ended";
import { parseInput } from "../../lib/io";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import { resolveDealRemainder, toDealTerms } from "./_shared/deal-from-storage";
import {
  computeDraftSheet,
  freezeSheet,
  organiserAccess,
  refuseOrganiserAction,
} from "./_shared/settlement-sheet";

export type MarkEventSettledDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "events"
    | "deals"
    | "agreements"
    | "bookingRequests"
    | "payees"
    | "authz"
    | "audit"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * B2: the sheet being frozen can be a degraded one (typed-in rows the deal
   * can no longer place are left out). That swallow is reported here, as on
   * every other read of the sheet — a settled copy is the last place for it
   * to go unseen. ReporterPort convention.
   */
  reportError?: ReporterPort;
};

async function requireSettler(
  repos: MarkEventSettledDeps["repos"],
  eventId: string,
  actorHumanId: string,
): Promise<EventRecord> {
  const event = await repos.events.getById(eventId);
  if (!event) throw fail("EVENT_NOT_FOUND");
  const access = await organiserAccess(repos, event, actorHumanId);
  if (!access.canSettle) refuseOrganiserAction(event);
  return event;
}

export const markEventSettledInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    /**
     * W2: settle a sheet that is still missing money (not entered, estimates,
     * rows left out, orders with no credit, door cash not entered against
     * cash sales) on purpose. Recorded in the frozen copy and the audit row.
     */
    acknowledgeIncomplete: z.boolean().default(false),
  })
  .strict();

export const markEventSettledOutputSchema = z
  .object({
    eventId: z.uuid(),
    status: z.literal("SETTLED"),
    settledAt: z.date(),
    engineVersion: z.number().int(),
  })
  .strict();
export type MarkEventSettledOutput = z.infer<typeof markEventSettledOutputSchema>;

export async function markEventSettled(
  deps: MarkEventSettledDeps,
  rawInput: unknown,
): Promise<MarkEventSettledOutput> {
  const input = parseInput(markEventSettledInputSchema, rawInput);
  const event = await requireSettler(deps.repos, input.eventId, input.actorHumanId);
  const now = deps.clock.now();
  // A draft that never went on sale has no night to settle.
  if (
    event.publishedAt === null &&
    event.status !== "PUBLISHED" &&
    event.status !== "COMPLETED"
  ) {
    throw fail("SETTLEMENT_EVENT_NOT_PUBLISHED");
  }
  if (!isEventPast(event, now)) throw fail("SETTLEMENT_EVENT_NOT_ENDED");
  if (!event.payoutTermsId) throw fail("PRIMARY_AGREEMENT_MISSING");
  const payoutTermsId = event.payoutTermsId;

  const result = await deps.repos.tx(async (tx) => {
    const { id: sheetId } = await tx.deals.ensureSheet(event.id);
    // The lock first: no write can land between the read below and the flip.
    if (!(await tx.deals.lockDraftSheet(sheetId))) {
      throw fail("SETTLEMENT_SHEET_SETTLED");
    }
    const deal = await tx.deals.getTermsDeal(payoutTermsId);
    if (!deal) throw fail("PRIMARY_AGREEMENT_MISSING");
    const agreement = await tx.agreements.getByEventId(event.id);
    const bookingRequest = agreement
      ? await tx.bookingRequests.findByAgreementId(agreement.id)
      : null;
    const remainder = await resolveDealRemainder(tx, {
      deal,
      event,
      agreement,
      bookingRequest,
    });
    if (!remainder) throw fail("DEAL_REMAINDER_UNRESOLVED");
    const sheet = await tx.deals.getSheetByEventId(event.id);

    const computed = await computeDraftSheet(
      tx,
      { event, terms: toDealTerms(deal, remainder.payeeId), remainder, sheet },
      { reportError: deps.reportError },
    );
    if (!computed.completeness.complete && !input.acknowledgeIncomplete) {
      throw fail("SETTLEMENT_SHEET_INCOMPLETE", {
        meta: { eventId: event.id, reasons: computed.completeness.reasons },
      });
    }
    const acknowledgedIncomplete = computed.completeness.complete
      ? null
      : { byHumanId: input.actorHumanId, reasons: computed.completeness.reasons };
    const snapshot = freezeSheet({ ...computed, acknowledgedIncomplete });
    const settled = await tx.deals.markSheetSettled({
      sheetId,
      settledByHumanId: input.actorHumanId,
      settledAt: now,
      engineVersion: computed.result.engineVersion,
      snapshot,
    });
    if (!settled) throw fail("SETTLEMENT_SHEET_SETTLED");

    await tx.audit.log({
      entity: "settlementSheet",
      entityId: sheetId,
      action: "settlement_sheet.settled",
      data: {
        actorHumanId: input.actorHumanId,
        eventId: event.id,
        engineVersion: computed.result.engineVersion,
        grossCents: computed.result.waterfall.grossCents,
        complete: computed.completeness.complete,
        acknowledgedIncomplete,
        staleEntryIds: computed.staleEntryIds,
        positions: computed.result.payees.map((p) => ({
          payeeId: p.payeeId,
          entitlementCents: p.entitlementCents,
          paidThroughPlatformCents: p.paidThroughPlatformCents,
          settleDirectlyCents: p.settleDirectlyCents,
        })),
      },
      at: now,
    });
    return { engineVersion: computed.result.engineVersion };
  });

  deps.logger?.info("deals.event_settled", {
    eventId: event.id,
    actorHumanId: input.actorHumanId,
  });

  return markEventSettledOutputSchema.parse({
    eventId: event.id,
    status: "SETTLED",
    settledAt: now,
    engineVersion: result.engineVersion,
  });
}

export const reopenEventSettlementInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    /** Why the settled sheet is reopened — kept in the audit log. */
    reason: plainTextMultilineRequired(1000),
  })
  .strict();

export const reopenEventSettlementOutputSchema = z
  .object({ eventId: z.uuid(), status: z.literal("DRAFT"), reopenedAt: z.date() })
  .strict();
export type ReopenEventSettlementOutput = z.infer<
  typeof reopenEventSettlementOutputSchema
>;

export async function reopenEventSettlement(
  deps: MarkEventSettledDeps,
  rawInput: unknown,
): Promise<ReopenEventSettlementOutput> {
  const input = parseInput(reopenEventSettlementInputSchema, rawInput);
  const event = await requireSettler(deps.repos, input.eventId, input.actorHumanId);
  const now = deps.clock.now();

  await deps.repos.tx(async (tx) => {
    const sheet = await tx.deals.getSheetByEventId(event.id);
    if (!sheet || !(await tx.deals.lockSettledSheet(sheet.id))) {
      throw fail("SETTLEMENT_SHEET_NOT_SETTLED");
    }
    // Re-read under the lock: the copy the audit row keeps is the one reopened.
    const locked = await tx.deals.getSheetByEventId(event.id);
    const reopened = await tx.deals.reopenSheet({
      sheetId: sheet.id,
      reopenedByHumanId: input.actorHumanId,
      reopenedAt: now,
    });
    if (!reopened) throw fail("SETTLEMENT_SHEET_NOT_SETTLED");
    await tx.audit.log({
      entity: "settlementSheet",
      entityId: sheet.id,
      action: "settlement_sheet.reopened",
      data: {
        actorHumanId: input.actorHumanId,
        eventId: event.id,
        reason: input.reason,
        previous: {
          settledByHumanId: locked?.settledByHumanId ?? null,
          settledAt: locked?.settledAt ?? null,
          engineVersion: locked?.engineVersion ?? null,
          snapshot: locked?.snapshot ?? null,
        },
      },
      at: now,
    });
  });

  deps.logger?.info("deals.event_settlement_reopened", {
    eventId: event.id,
    actorHumanId: input.actorHumanId,
  });

  return reopenEventSettlementOutputSchema.parse({
    eventId: event.id,
    status: "DRAFT",
    reopenedAt: now,
  });
}
