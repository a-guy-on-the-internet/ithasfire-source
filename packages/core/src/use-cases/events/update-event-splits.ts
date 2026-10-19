import { createHash } from "node:crypto";
import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  PayoutSchedule,
  PayoutTermsLineRecord,
} from "@th/types/repos/payout-terms";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import {
  assessCapSatisfiability,
  isCompleteAllocation,
  SPLITS_TARGET_PCT,
} from "../../lib/pricing/caps-satisfiable";
import { fail } from "@th/errors";
import { getEntityDefaultPayoutSchedule } from "../agreements/_shared/ensure-entity-default-primary-terms";
import { ensurePayoutRoutingActor } from "../../lib/event-edit-rights";
import { resaleClauseOfTerms } from "../../lib/resale-clause";
import {
  assertDealWritable,
  lockDealEvent,
  notifyDealChange,
  recordDealChange,
  type DealChangeNoticeDeps,
  type DealFence,
} from "../deals/_shared/deal-freeze";

const SPLIT_KIND = ["PRIMARY", "RESALE"] as const;

const lineInputSchema = z
  .object({
    /** Existing line ID when editing. Omitted means create. */
    id: z.string().uuid().optional(),
    payeeRef: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("org"), id: z.string().uuid() }),
      z.object({ kind: z.literal("human"), id: z.string().uuid() }),
    ]),
    /** Ignored for non-PRIMARY kinds (server enforces). */
    ticketTypeId: z.string().uuid().nullable(),
    /**
     * Basis points (0–10000), and a WHOLE PERCENT — i.e. a multiple of 100.
     *
     * `PayoutTermsLine.percent` is an `Int` of whole percent, so the write
     * below does `Math.round(percentBps / 100)`. Without this constraint a
     * client could hand the rounder 1250 and have it silently persist 13% —
     * a 0.5pt shift of real settlement money, invisible in the audit log
     * because the log records the POST-rounding value. Refusing at the wire
     * means the only way to move a share is to say exactly what you mean.
     *
     * If sub-percent shares are ever wanted, the fix is to migrate the column
     * to basis points (and every reader of `.percent`), not to relax this.
     */
    percentBps: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .refine((v) => v % 100 === 0, {
        message: "percentBps must be a whole percent (a multiple of 100)",
      }),
    floorCents: z.number().int().min(0).default(0),
    /**
     * WHOLE PERCENT (0–100), unlike `percentBps` above — this value is
     * persisted to `PayoutTermsLine.capPercent` verbatim, and every reader of
     * that column (`lineCapCents`, `payoutTermsLineSchema`,
     * `upsertAgreementLine`) treats it as whole percent.
     *
     * It used to accept up to 10000, i.e. it looked like basis points and was
     * stored as percent. A client that meant 50% by sending 5000 got a cap of
     * 5000% — a ceiling 50x the basis, which can never bind, so the cap
     * silently did nothing. No caller in this repo sends bps here (the splits
     * editor does not surface caps at all yet), so this is a tightening with
     * no live payload behind it.
     */
    capPercent: z.number().int().min(0).max(100).nullable().optional(),
    priority: z.number().int().min(0).default(0),
  })
  .strict();

export const updateEventSplitsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
    kind: z.enum(SPLIT_KIND),
    lines: z.array(lineInputSchema),
    clientKey: z.string().min(8).max(64),
    /**
     * freeze-the-deal FR-004: true = the editor knowingly changes a frozen
     * deal (every payee is told). Without it a frozen event's splits are
     * refused (DEAL_FROZEN). Ignored when the deal is not frozen.
     */
    frozenChange: z.boolean().optional(),
  })
  .strict();

export const updateEventSplitsOutputSchema = z
  .object({
    payoutTermsId: z.string().uuid(),
    lineCount: z.number().int().nonnegative(),
    totalAllocatedBps: z.number().int(),
  })
  .strict();

export type UpdateEventSplitsInput = z.infer<
  typeof updateEventSplitsInputSchema
>;
export type UpdateEventSplitsOutput = z.infer<
  typeof updateEventSplitsOutputSchema
>;

export type UpdateEventSplitsDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "events"
    | "payoutTerms"
    | "payees"
    | "audit"
    | "agreements"
    // The frozen-change notice (freeze-the-deal FR-006).
    | "organizations"
    | "humans"
  >;
  authz: Pick<AuthZPort, "canEditEvent">;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
} & Omit<DealChangeNoticeDeps, "logger">;

type StoredResponse = {
  payloadHash: string;
  response: UpdateEventSplitsOutput;
};

/**
 * Authoritative writer for an event's PRIMARY or RESALE payout terms.
 *
 * Behavior:
 *   1. Resolve / create the underlying PayoutTerms row for `kind` (mints a
 *      single-use draft if `Event.payoutTermsId` / `resalePayoutTermsId`
 *      isn't set yet).
 *   2. Resolve every payeeRef into a Payee, creating one when the
 *      org/human exists but has no Payee yet — Connect onboarding flips
 *      `payoutsEnabled` later in a separate flow.
 *   3. Stamp `requiresConfirmation` per line: false when the payee
 *      matches the event owner, true otherwise.
 *   4. Preserve confirmation state on lines whose share fields didn't
 *      change. Reset to PENDING + clear confirmedAt when share changes.
 *   5. Replace lines atomically inside `repos.tx()`.
 *
 * Idempotency keyed by `(eventId, kind, clientKey)`. The same payload
 * replayed returns the cached response; a different payload under the
 * same client key throws `conflict`.
 */
export async function updateEventSplits(
  deps: UpdateEventSplitsDeps,
  rawInput: unknown,
): Promise<UpdateEventSplitsOutput> {
  const input = parseInput(updateEventSplitsInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  const canEdit = await deps.authz.canEditEvent({
    actorHumanId: input.actorHumanId,
    eventId: input.eventId,
  });
  if (!canEdit.allowed) {
    throw fail("INSUFFICIENT_ROLE");
  }
  // PAYOUT ROUTING: owner-only (owner ruling 2026-09-28). `canEditEvent`
  // admits a human owner's edit-role delegates; splits decide who gets paid,
  // so on a human-owned event only the owner passes. Org arm unchanged.
  ensurePayoutRoutingActor(event, input.actorHumanId, "INSUFFICIENT_ROLE");

  // ticketTypeId scoping is PRIMARY-only.
  if (input.kind !== "PRIMARY") {
    for (const line of input.lines) {
      if (line.ticketTypeId !== null) {
        throw fail("TICKET_TYPE_SCOPE_ONLY_VALID_FOR_PRIMARY");
      }
    }
  }

  const idemKey = `event-splits:${input.eventId}:${input.kind}:${input.clientKey}`;
  const payloadHash = buildPayloadHash(input);

  const replay = await deps.idempotency.get<StoredResponse>(idemKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return replay.response;
  }

  const claimed = await deps.idempotency.begin(idemKey, 300);
  if (!claimed) {
    const afterWait = await deps.idempotency.get<StoredResponse>(idemKey);
    if (afterWait) {
      if (afterWait.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return afterWait.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const result = await deps.repos.tx(async (tx) => {
      // freeze-the-deal: the event row FIRST, before any terms lock (the
      // order in deal-freeze.ts). "update": a first save mints and links the
      // event's terms, an UPDATE of this row.
      await lockDealEvent(tx, { kind: "EVENT", eventId: input.eventId }, "update");
      // Re-read the event inside the transaction: the pre-tx read above is
      // only a fast-fail. A concurrent finalizeBookingAgreement could have
      // stamped `Event.payoutTermsId` since then, and resolving the terms
      // from the stale snapshot would let this use case mint a fresh draft
      // and clobber the booking linkage via linkPayoutTerms.
      const txEvent = await tx.events.getById(input.eventId);
      if (!txEvent) {
        throw fail("EVENT_NOT_FOUND");
      }

      const ownerSubjectType: "ORGANIZATION" | "HUMAN" | null = txEvent.orgId
        ? "ORGANIZATION"
        : txEvent.humanId
          ? "HUMAN"
          : null;
      const ownerSubjectId = txEvent.orgId ?? txEvent.humanId ?? null;

      // Resolve / create the terms row for this kind.
      let termsId =
        input.kind === "PRIMARY"
          ? txEvent.payoutTermsId
          : txEvent.resalePayoutTermsId;
      // freeze-the-deal FR-004, read under the event row lock (and, for
      // existing terms, the terms lock): set in each branch below.
      let fence: DealFence;
      if (termsId) {
        // ── P4b (deal terms) ── the terms row lock, taken the moment the
        // terms are known (review B1, round 2). Event terms are never
        // deal-written — deals live on booking-agreement terms, refused just
        // below — so this is not about deal writes: two concurrent splits
        // saves each run replaceLines (delete, then insert), and without a
        // lock the second's delete can miss the first's uncommitted insert,
        // leaving BOTH sets of lines. Every writer of PayoutTermsLine locks.
        await tx.deals.lockTerms(termsId);
        // Security fence: PayoutTerms owned by a two-party booking
        // `Agreement` are managed exclusively by the booking-agreements
        // engine (party RBAC + per-payee confirmation lifecycle). Once
        // finalizeBookingAgreement stamps those terms onto the event, the
        // event editor must not be able to unilaterally rewrite the
        // counterparty's confirmed lines here. Same discriminator as the
        // rest of the fence (`requireDraftBookingAgreement`,
        // `fetchExistingAgreement`). Booking agreements only ever reference
        // PRIMARY terms, so the RESALE path never trips this in practice;
        // checking unconditionally is defense in depth.
        const bookingAgreement =
          await tx.agreements.getByPayoutTermsId(termsId);
        if (bookingAgreement) {
          throw fail("AGREEMENT_FINALIZED");
        }
        // organiser-resale-share FR-001: the share is split over the RESALE
        // lines, so removing the last one while a clause is set and a ticket
        // type allows resale would strand every listing
        // (AGREEMENT_MISSING_LINES at list and checkout). Under the lock,
        // which the ticket-type gates and `setResaleClause` also take.
        if (input.kind === "RESALE" && input.lines.length === 0) {
          const terms = await tx.payoutTerms.getById(termsId);
          if (terms && resaleClauseOfTerms(terms) !== null) {
            const resaleOn = (await tx.events.listTicketTypes(input.eventId)).some(
              (tt) => tt.resaleAllowed === true,
            );
            if (resaleOn) {
              throw fail("AGREEMENT_MISSING_LINES", {
                meta: { reason: "resale_share_needs_lines", payoutTermsId: termsId },
              });
            }
          }
        }
        fence = await assertDealWritable(tx, {
          scope: { kind: "EVENT", eventId: input.eventId },
          frozenChange: input.frozenChange,
        });
      } else {
        // Fenced BEFORE the mint, so a frozen change's "before" records these
        // terms as absent (null), not as the empty row minted just below.
        fence = await assertDealWritable(tx, {
          scope: { kind: "EVENT", eventId: input.eventId },
          frozenChange: input.frozenChange,
        });
        // Fresh PRIMARY drafts inherit the owner entity's default payout
        // schedule (set on the payout settings page) so it genuinely applies
        // to events; without this seed the schema default would silently win.
        // RESALE drafts are left untouched — resale has its own default
        // pointer and lifecycle.
        let inheritedSchedule: PayoutSchedule | null = null;
        if (input.kind === "PRIMARY" && ownerSubjectType && ownerSubjectId) {
          inheritedSchedule = await getEntityDefaultPayoutSchedule(tx, {
            type: ownerSubjectType,
            id: ownerSubjectId,
          });
        }

        const created = await tx.payoutTerms.createDraft({
          kind: input.kind,
          settlementCurrency: "usd",
          ...(inheritedSchedule
            ? { payoutSchedule: inheritedSchedule }
            : {}),
        });
        termsId = created.id;
        await tx.events.linkPayoutTerms({
          eventId: input.eventId,
          payoutTermsId: termsId,
          kind: input.kind,
        });
      }

      // Snapshot existing lines so we can preserve confirmation state on
      // unchanged share / floor / cap.
      const existingLines = await tx.payoutTerms.listLines(termsId);
      const existingById = new Map<string, PayoutTermsLineRecord>(
        existingLines.map((l) => [l.id, l]),
      );

      // Resolve each input payeeRef → Payee (creating PENDING ones when missing).
      const resolvedLines = await Promise.all(
        input.lines.map(async (line) => {
          const subjectType =
            line.payeeRef.kind === "org" ? "ORGANIZATION" : "HUMAN";
          let payee = await tx.payees.getBySubject({
            type: subjectType,
            id: line.payeeRef.id,
          });
          let payeeId: string;
          if (!payee) {
            const created = await tx.payees.upsertForSubject({
              subjectType,
              subjectId: line.payeeRef.id,
            });
            payeeId = created.id;
          } else {
            payeeId = payee.id;
          }
          const isOwner =
            ownerSubjectType !== null &&
            ownerSubjectType === subjectType &&
            ownerSubjectId === line.payeeRef.id;

          // PayoutTermsLine.percent is stored as whole percent (0–100); the
          // API takes basis points because that is what the read surfaces.
          // The schema guarantees a multiple of 100, so this is an EXACT
          // conversion — `Math.round` is belt-and-braces, not a rounding
          // policy. It must never become one: rounding here moves settlement
          // money and the audit log only ever sees the result.
          const persistedPercent = Math.round(line.percentBps / 100);

          // Confirmation-state preservation: when an existing line's
          // share-shaping fields are unchanged, keep its confirmation
          // state. Anything else resets to PENDING (or null for owner).
          const prior = line.id ? existingById.get(line.id) : undefined;
          const shareUnchanged =
            !!prior &&
            prior.percent === persistedPercent &&
            prior.floorCents === line.floorCents &&
            (prior.capPercent ?? null) === (line.capPercent ?? null) &&
            prior.payeeId === payeeId &&
            (prior.ticketTypeId ?? null) === (line.ticketTypeId ?? null);

          let confirmationStatus: PayoutTermsLineRecord["confirmationStatus"] =
            null;
          let confirmedAt: Date | null = null;
          if (!isOwner) {
            if (shareUnchanged && prior) {
              confirmationStatus = prior.confirmationStatus ?? "PENDING";
              confirmedAt = prior.confirmedAt;
            } else {
              confirmationStatus = "PENDING";
              confirmedAt = null;
            }
          }

          return {
            id: line.id,
            payeeId: payeeId,
            ticketTypeId: line.ticketTypeId ?? null,
            percent: persistedPercent,
            floorCents: line.floorCents,
            capPercent: line.capPercent ?? null,
            priority: line.priority,
            rounding: prior?.rounding ?? "FLOOR",
            requiresConfirmation: !isOwner,
            confirmationStatus,
            confirmedAt,
            counterPercentBps: shareUnchanged
              ? (prior?.counterPercentBps ?? null)
              : null,
            counterNote: shareUnchanged ? (prior?.counterNote ?? null) : null,
          };
        }),
      );

      // Caps must be able to reach the whole basis — the same predicate
      // `publishEvent`'s Gate 1b runs, applied at the WRITE so a live event's
      // terms cannot be rewritten into an unsettleable shape. This use case
      // has no event-status guard, so without it an already-selling event's
      // caps could be lowered mid-sale and every subsequent order would
      // quietly leave cents unallocated (no split row, no payee credit, and
      // nothing downstream that compares against the basis).
      //
      // Gated on `isCompleteAllocation` because this editor accepts PARTIAL
      // sets on purpose: a deal is composed a line at a time and "< 100%" is
      // refused at publish, not at every save. Only a set that claims to
      // divide the whole basis is held to being able to.
      const activeLines = resolvedLines.filter(
        (l) => l.confirmationStatus !== "DECLINED",
      );
      const capReport = assessCapSatisfiability(activeLines);
      if (isCompleteAllocation(activeLines) && !capReport.satisfiable) {
        throw fail("SPLITS_CAPS_UNSATISFIABLE", {
          meta: {
            eventId: input.eventId,
            payoutTermsId: termsId,
            totalCapPct: capReport.totalCapPct,
            totalAllocatedPct: capReport.totalPercent,
            targetPct: SPLITS_TARGET_PCT,
          },
        });
      }

      // RESALE lines split the whole resale share over themselves (finalize
      // runs `computeOrderSplits` over them alone; there is no remainder
      // line). Over 100%, the remainder pass takes the excess back a cent at
      // a time, last line first, so a recipient who agreed to their
      // percentage is paid less than it. Every line counts: finalize reads
      // them all, whatever their confirmation status.
      if (input.kind === "RESALE") {
        const totalPct = resolvedLines.reduce((sum, l) => sum + l.percent, 0);
        if (totalPct > SPLITS_TARGET_PCT) {
          throw fail("RESALE_SPLITS_OVER_TOTAL", {
            meta: {
              eventId: input.eventId,
              payoutTermsId: termsId,
              totalAllocatedPct: totalPct,
              targetPct: SPLITS_TARGET_PCT,
            },
          });
        }
      }

      await tx.payoutTerms.replaceLines(termsId, resolvedLines);

      const change = await recordDealChange(tx, fence, {
        actorHumanId: input.actorHumanId,
        at: deps.clock.now(),
      });

      // Total back to bps for the API (storage is percent).
      const total = resolvedLines.reduce((sum, l) => sum + l.percent * 100, 0);

      return { payoutTermsId: termsId, total, change };
    });

    const now = deps.clock.now();
    await deps.repos.audit.log({
      entity: "event",
      entityId: input.eventId,
      action: "event_splits_updated",
      data: {
        kind: input.kind,
        payoutTermsId: result.payoutTermsId,
        lineCount: input.lines.length,
        totalAllocatedBps: result.total,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });

    const response = updateEventSplitsOutputSchema.parse({
      payoutTermsId: result.payoutTermsId,
      lineCount: input.lines.length,
      totalAllocatedBps: result.total,
    });

    await deps.idempotency.commit<StoredResponse>(idemKey, {
      payloadHash,
      response,
    });

    deps.logger?.info("events.update_splits", {
      eventId: input.eventId,
      kind: input.kind,
      lineCount: input.lines.length,
      payoutTermsId: result.payoutTermsId,
    });

    // freeze-the-deal FR-006: after the commit. Best effort: never throws,
    // so it can never fail the (already saved) response.
    if (result.change) await notifyDealChange(deps, result.change);

    return response;
  } catch (err) {
    await deps.idempotency.fail(idemKey, describeError(err));
    throw asKnownError("update_event_splits", err);
  }
}

function buildPayloadHash(input: UpdateEventSplitsInput): string {
  const hash = createHash("sha256");
  hash.update(input.eventId);
  hash.update(input.kind);
  for (const line of input.lines) {
    hash.update(line.id ?? "new");
    hash.update(line.payeeRef.kind);
    hash.update(line.payeeRef.id);
    hash.update(String(line.ticketTypeId ?? ""));
    hash.update(String(line.percentBps));
    hash.update(String(line.floorCents));
    hash.update(String(line.capPercent ?? ""));
    hash.update(String(line.priority));
  }
  return hash.digest("hex");
}
