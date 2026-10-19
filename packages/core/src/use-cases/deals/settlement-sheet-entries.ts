/**
 * Typing into the settlement sheet (FR-004 data): money the platform never
 * saw, the actuals of estimated costs, money that already changed hands.
 * The organiser side writes (`organiserAccess.canEdit`); a SETTLED sheet
 * refuses every write until it is reopened. No money moves.
 *
 * Every write runs in one transaction that first takes the sheet's row lock
 * (`DealsRepo.lockDraftSheet`, a guarded UPDATE … WHERE status = 'DRAFT'): a
 * write and "Mark settled" can never interleave, and a write queued behind a
 * committed "Mark settled" is refused, not slipped into a settled sheet.
 *
 * Participants come from the deal's terms (`dealParticipantIds`) plus the
 * payees the ledger shows were paid per order under lines the terms no
 * longer have (W1): a row can never put a stranger on the sheet.
 */
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { fail as failApp } from "@th/errors";

import { fail } from "../../lib/errors";
import { parseInput } from "../../lib/io";
import {
  plainTextMultilineOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import {
  OFF_PLATFORM_AMOUNT_KINDS,
  dealParticipantIds,
  type DealTerms,
} from "../../lib/settlement";
import { resolveDealRemainder, toDealTerms } from "./_shared/deal-from-storage";
import {
  ledgerOnlyPayeeIdsOf,
  organiserAccess,
  refuseOrganiserAction,
} from "./_shared/settlement-sheet";
import { MAX_STORED_DEAL_CENTS } from "./set-agreement-deal";

const centsSchema = z.number().int().nonnegative().max(MAX_STORED_DEAL_CENTS);

export type SettlementSheetWriteDeps = {
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
};

type WriteContext = {
  tx: TxRepos;
  event: EventRecord;
  sheetId: string;
  terms: DealTerms;
  participants: Set<string>;
  now: Date;
};

/**
 * Authorize, then run `write` inside one transaction holding the sheet's
 * DRAFT lock, with the deal's terms read in that same transaction.
 */
async function withDraftSheet<T>(
  deps: SettlementSheetWriteDeps,
  input: { eventId: string; actorHumanId: string },
  write: (ctx: WriteContext) => Promise<T>,
): Promise<T> {
  const event = await deps.repos.events.getById(input.eventId);
  if (!event) throw failApp("EVENT_NOT_FOUND");
  const access = await organiserAccess(deps.repos, event, input.actorHumanId);
  if (!access.canEdit) refuseOrganiserAction(event);
  if (!event.payoutTermsId) throw failApp("PRIMARY_AGREEMENT_MISSING");
  const payoutTermsId = event.payoutTermsId;
  const now = deps.clock.now();

  return deps.repos.tx(async (tx) => {
    const sheet = await tx.deals.ensureSheet(event.id);
    if (!(await tx.deals.lockDraftSheet(sheet.id))) {
      throw failApp("SETTLEMENT_SHEET_SETTLED");
    }
    const deal = await tx.deals.getTermsDeal(payoutTermsId);
    if (!deal) throw failApp("PRIMARY_AGREEMENT_MISSING");
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
    if (!remainder) throw failApp("DEAL_REMAINDER_UNRESOLVED");
    const terms = toDealTerms(deal, remainder.payeeId);
    const termsParticipants = dealParticipantIds(terms);
    // A payee paid per order under a line the deal no longer has is a
    // participant of the SHEET (W1): a direct payment to or from a removed
    // act is a legitimate row.
    const ledgerOnly = ledgerOnlyPayeeIdsOf(
      await tx.deals.readEventTicketLedger(event.id),
      termsParticipants,
    );
    return write({
      tx,
      event,
      sheetId: sheet.id,
      terms,
      participants: new Set([...termsParticipants, ...ledgerOnly]),
      now,
    });
  });
}

const base = {
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
};

// ── Off-platform money (M4, M11) ──────────────────────────────────────────

export const upsertSheetOffPlatformInputSchema = z
  .object({
    ...base,
    /** Present = edit that row; absent = add a row. */
    rowId: z.uuid().optional(),
    kind: z.enum(OFF_PLATFORM_AMOUNT_KINDS),
    label: plainTextRequired(200),
    /** Null = "Not entered" (never $0). */
    amountCents: centsSchema.nullable(),
    /** Who has it in hand (the door cash box). */
    heldByPayeeId: z.uuid(),
    /** Who it belongs to; null = the remainder holder (M11). */
    ownerPayeeId: z.uuid().nullable().default(null),
  })
  .strict();

export const sheetWriteOutputSchema = z
  .object({ eventId: z.uuid(), id: z.string() })
  .strict();
export type SheetWriteOutput = z.infer<typeof sheetWriteOutputSchema>;

export async function upsertSheetOffPlatform(
  deps: SettlementSheetWriteDeps,
  rawInput: unknown,
): Promise<SheetWriteOutput> {
  const input = parseInput(upsertSheetOffPlatformInputSchema, rawInput);
  return withDraftSheet(deps, input, async ({ tx, event, sheetId, participants, now }) => {
    if (!participants.has(input.heldByPayeeId)) {
      fail("invalid_input", "deal_off_platform_unknown_holder");
    }
    if (input.ownerPayeeId !== null && !participants.has(input.ownerPayeeId)) {
      fail("invalid_input", "deal_off_platform_unknown_owner");
    }
    const before = input.rowId
      ? ((await tx.deals.getSheetByEventId(event.id))?.offPlatform.find(
          (o) => o.id === input.rowId,
        ) ?? null)
      : null;
    if (input.rowId && !before) throw failApp("SETTLEMENT_ENTRY_NOT_FOUND");
    const row = await tx.deals.upsertOffPlatform({
      sheetId,
      id: input.rowId,
      kind: input.kind,
      label: input.label,
      amountCents: input.amountCents,
      heldByPayeeId: input.heldByPayeeId,
      ownerPayeeId: input.ownerPayeeId,
      enteredByHumanId: input.actorHumanId,
      enteredAt: now,
    });
    if (!row) throw failApp("SETTLEMENT_ENTRY_NOT_FOUND");
    await tx.audit.log({
      entity: "settlementSheet",
      entityId: sheetId,
      action: "settlement_sheet.off_platform_set",
      data: { actorHumanId: input.actorHumanId, eventId: event.id, before, after: row },
      at: now,
    });
    return sheetWriteOutputSchema.parse({ eventId: event.id, id: row.id });
  });
}

export const removeSheetOffPlatformInputSchema = z
  .object({ ...base, rowId: z.uuid() })
  .strict();

export async function removeSheetOffPlatform(
  deps: SettlementSheetWriteDeps,
  rawInput: unknown,
): Promise<SheetWriteOutput> {
  const input = parseInput(removeSheetOffPlatformInputSchema, rawInput);
  return withDraftSheet(deps, input, async ({ tx, event, sheetId, now }) => {
    const before = (await tx.deals.getSheetByEventId(event.id))?.offPlatform.find(
      (o) => o.id === input.rowId,
    );
    if (!before || !(await tx.deals.deleteOffPlatform(sheetId, input.rowId))) {
      throw failApp("SETTLEMENT_ENTRY_NOT_FOUND");
    }
    await tx.audit.log({
      entity: "settlementSheet",
      entityId: sheetId,
      action: "settlement_sheet.off_platform_removed",
      data: { actorHumanId: input.actorHumanId, eventId: event.id, before },
      at: now,
    });
    return sheetWriteOutputSchema.parse({ eventId: event.id, id: input.rowId });
  });
}

// ── Actuals of estimated costs (NFR-002) ──────────────────────────────────

export const setSheetDeductionActualInputSchema = z
  .object({ ...base, deductionId: z.uuid(), amountCents: centsSchema })
  .strict();

export async function setSheetDeductionActual(
  deps: SettlementSheetWriteDeps,
  rawInput: unknown,
): Promise<SheetWriteOutput> {
  const input = parseInput(setSheetDeductionActualInputSchema, rawInput);
  return withDraftSheet(deps, input, async ({ tx, event, sheetId, terms, now }) => {
    const deduction = terms.deductions.find((d) => d.id === input.deductionId);
    if (!deduction) fail("invalid_input", "deal_unknown_deduction_actual");
    // An agreed cost (a rental struck in the booking) is not re-typed after
    // the show; only an estimate takes an actual (08-07 §5 provenance).
    if (!deduction.estimated) fail("invalid_input", "deal_deduction_not_estimated");
    const before =
      (await tx.deals.getSheetByEventId(event.id))?.deductionActuals.find(
        (a) => a.deductionId === input.deductionId,
      ) ?? null;
    const row = await tx.deals.upsertDeductionActual({
      sheetId,
      deductionId: input.deductionId,
      amountCents: input.amountCents,
      enteredByHumanId: input.actorHumanId,
      enteredAt: now,
    });
    await tx.audit.log({
      entity: "settlementSheet",
      entityId: sheetId,
      action: "settlement_sheet.deduction_actual_set",
      data: { actorHumanId: input.actorHumanId, eventId: event.id, before, after: row },
      at: now,
    });
    return sheetWriteOutputSchema.parse({ eventId: event.id, id: row.id });
  });
}

export const clearSheetDeductionActualInputSchema = z
  .object({ ...base, deductionId: z.uuid() })
  .strict();

export async function clearSheetDeductionActual(
  deps: SettlementSheetWriteDeps,
  rawInput: unknown,
): Promise<SheetWriteOutput> {
  const input = parseInput(clearSheetDeductionActualInputSchema, rawInput);
  return withDraftSheet(deps, input, async ({ tx, event, sheetId, now }) => {
    const before = (await tx.deals.getSheetByEventId(event.id))?.deductionActuals.find(
      (a) => a.deductionId === input.deductionId,
    );
    if (!before || !(await tx.deals.deleteDeductionActual(sheetId, input.deductionId))) {
      throw failApp("SETTLEMENT_ENTRY_NOT_FOUND");
    }
    await tx.audit.log({
      entity: "settlementSheet",
      entityId: sheetId,
      action: "settlement_sheet.deduction_actual_cleared",
      data: { actorHumanId: input.actorHumanId, eventId: event.id, before },
      at: now,
    });
    return sheetWriteOutputSchema.parse({ eventId: event.id, id: before.id });
  });
}

// ── Money that already changed hands (M10) ────────────────────────────────

export const addSheetDirectPaymentInputSchema = z
  .object({
    ...base,
    fromPayeeId: z.uuid(),
    toPayeeId: z.uuid(),
    amountCents: centsSchema.min(1),
    /** "Deposit already paid" and the like. */
    label: plainTextRequired(200),
    note: plainTextMultilineOptional(1000).nullable().default(null),
  })
  .strict();

export async function addSheetDirectPayment(
  deps: SettlementSheetWriteDeps,
  rawInput: unknown,
): Promise<SheetWriteOutput> {
  const input = parseInput(addSheetDirectPaymentInputSchema, rawInput);
  return withDraftSheet(deps, input, async ({ tx, event, sheetId, participants, now }) => {
    if (input.fromPayeeId === input.toPayeeId) {
      fail("invalid_input", "deal_direct_payment_to_self");
    }
    if (!participants.has(input.fromPayeeId) || !participants.has(input.toPayeeId)) {
      fail("invalid_input", "deal_direct_payment_unknown_party");
    }
    const row = await tx.deals.createDirectPayment({
      sheetId,
      fromPayeeId: input.fromPayeeId,
      toPayeeId: input.toPayeeId,
      amountCents: input.amountCents,
      label: input.label,
      note: input.note ? input.note : null,
      enteredByHumanId: input.actorHumanId,
      enteredAt: now,
    });
    await tx.audit.log({
      entity: "settlementSheet",
      entityId: sheetId,
      action: "settlement_sheet.direct_payment_added",
      data: { actorHumanId: input.actorHumanId, eventId: event.id, after: row },
      at: now,
    });
    return sheetWriteOutputSchema.parse({ eventId: event.id, id: row.id });
  });
}

export const removeSheetDirectPaymentInputSchema = z
  .object({ ...base, paymentId: z.uuid() })
  .strict();

export async function removeSheetDirectPayment(
  deps: SettlementSheetWriteDeps,
  rawInput: unknown,
): Promise<SheetWriteOutput> {
  const input = parseInput(removeSheetDirectPaymentInputSchema, rawInput);
  return withDraftSheet(deps, input, async ({ tx, event, sheetId, now }) => {
    const before = (await tx.deals.getSheetByEventId(event.id))?.directPayments.find(
      (d) => d.id === input.paymentId,
    );
    if (!before || !(await tx.deals.deleteDirectPayment(sheetId, input.paymentId))) {
      throw failApp("SETTLEMENT_ENTRY_NOT_FOUND");
    }
    await tx.audit.log({
      entity: "settlementSheet",
      entityId: sheetId,
      action: "settlement_sheet.direct_payment_removed",
      data: { actorHumanId: input.actorHumanId, eventId: event.id, before },
      at: now,
    });
    return sheetWriteOutputSchema.parse({ eventId: event.id, id: input.paymentId });
  });
}
