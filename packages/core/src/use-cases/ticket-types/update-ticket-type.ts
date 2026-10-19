import { z } from "zod";
import {
  MAX_DONATION_AMOUNT_CENTS,
  PWYW_SETTING_ABOVE_CAP_MESSAGE,
} from "../../lib/pricing/pay-what-you-want";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  TicketTypeRecord,
  TicketTypeStatus,
  UpdateTicketTypeInput as TicketTypePatch,
} from "@th/ports/repos/tickets";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import { describeError, parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { normalizeScheduledPrice } from "../../lib/ticket-types/scheduled-price";
import { normalizeSalesWindow } from "../../lib/ticket-types/sales-window";
import { requireEventResaleClauseSet } from "../../lib/resale-clause";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { ensureStoredOverridesGatedForTierWrites } from "../events/_shared/seat-price-override-rules";
import {
  ensureFeePolicyResolvableForPaidTicketing,
  ticketTypeNeedsFeePolicy,
} from "./_shared/ensure-fee-policy-for-paid-ticketing";
import {
  ensureStripeConnectedForPaidTicketing,
  ticketTypeRequiresStripe,
} from "./_shared/ensure-stripe-connected-for-paid-ticketing";
import { eventHasTicketSales } from "./_shared/ticket-sales-lock";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

export const updateTicketTypeInputSchema = z.object({
  actorHumanId: z.uuid(),
  ticketTypeId: z.uuid(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .transform((v) => v.trim())
    .optional(),
  description: z
    .string()
    .trim()
    .max(280)
    .optional()
    .nullable()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const trimmed = v.trim();
      return trimmed.length === 0 ? null : trimmed;
    }),
  priceCents: z.coerce.number().int().min(0).optional(),
  pricingMode: z.enum(["FIXED", "ADJUSTABLE"]).optional(),
  // Capped like checkout: a minimum or suggestion above it could never be paid.
  minimumCents: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_DONATION_AMOUNT_CENTS, { message: PWYW_SETTING_ABOVE_CAP_MESSAGE })
    .optional()
    .nullable(),
  // Capped like checkout: a minimum or suggestion above it could never be paid.
  suggestedCents: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_DONATION_AMOUNT_CENTS, { message: PWYW_SETTING_ABOVE_CAP_MESSAGE })
    .optional()
    .nullable(),
  capacity: z.coerce.number().int().min(1).optional(),
  resaleAllowed: z.boolean().optional(),
  resaleCapCents: z.coerce.number().int().min(0).optional().nullable(),
  /**
   * Scheduled price change (FR-005). PARTIAL-UPDATE semantics: `undefined`
   * leaves the stored value alone, `null` clears it. Because either field can
   * be omitted, the invariant is validated against the MERGED pair below — so
   * clearing only the date on a scheduled row is rejected with
   * TICKET_TYPE_SCHEDULE_INCOMPLETE instead of leaving the row half-configured.
   *
   * `scheduledPriceAt` is an absolute UTC instant; the admin resolves the
   * organizer's wall-clock choice against `Event.timezone` with
   * `zonedWallClockToInstant` (apps/web/src/lib/template-shift-offset) before
   * calling — NOT luxon, which this repo's web app deliberately does not carry
   * (FR-007 — and never PAYOUT_TZ / REFUND_TZ, which hardcode America/Chicago).
   * This boundary takes an INSTANT and does no zone arithmetic of its own.
   */
  scheduledPriceCents: z.coerce.number().int().min(0).optional().nullable(),
  scheduledPriceAt: z.coerce.date().optional().nullable(),
  /**
   * Per-type sales window (FR-014). Same PARTIAL-UPDATE semantics as the
   * schedule: `undefined` leaves the stored bound alone, `null` clears it. The
   * ordering invariant is validated against the MERGED pair, so setting only
   * `salesOpenAt` to an instant after the stored `salesCloseAt` is rejected
   * with TICKET_TYPE_SALES_WINDOW_INVALID instead of persisting an inverted
   * window nobody can buy from.
   *
   * Absolute UTC instants; the admin resolves the organizer's wall clock
   * against `Event.timezone` before calling (FR-007). This boundary does no
   * zone arithmetic of its own.
   */
  salesOpenAt: z.coerce.date().optional().nullable(),
  salesCloseAt: z.coerce.date().optional().nullable(),
});

export const updateTicketTypeOutputSchema = z.object({
  ticketTypeId: z.uuid(),
  name: z.string(),
  priceCents: z.number().int(),
  capacity: z.number().int(),
  status: z.enum(["DRAFT", "ACTIVE"] as const satisfies TicketTypeStatus[]),
});

export type UpdateTicketTypeInput = z.infer<typeof updateTicketTypeInputSchema>;
export type UpdateTicketTypeOutput = z.infer<
  typeof updateTicketTypeOutputSchema
>;

export type UpdateTicketTypeDeps = {
  repos: Repos;
  /**
   * Required (FR-003). Forwarded to the post-edit reindex so the refreshed
   * document carries the EFFECTIVE price at the moment of the edit (FR-008) —
   * which matters most here, since this is the use case that WRITES the
   * schedule. Also stamps the audit row (previously a bare `new Date()`).
   */
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Optional search port. When provided, a price edit reindexes the parent
   * event so its card badge reflects the new lowest price and fee-inclusive
   * buyer total. Best-effort — never fails the edit.
   */
  search?: MultiSearchPort;
  /** Best-effort reporter for the fire-and-forget reindex failure branch. */
  reportError?: ReporterPort;
};

export async function updateTicketType(
  deps: UpdateTicketTypeDeps,
  rawInput: unknown,
): Promise<UpdateTicketTypeOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "updateTicketType" });

  const execute = async (): Promise<UpdateTicketTypeOutput> => {
    const input = parseInput(updateTicketTypeInputSchema, rawInput);

    let reindexEventId: string | null = null;

    const result = await deps.repos.tx(async (tx) => {
      const ticketType = await tx.tickets.getTicketTypeById(input.ticketTypeId);
      if (!ticketType) {
        throw fail("TICKET_TYPE_NOT_FOUND");
      }

      const event = await tx.events.getById(ticketType.eventId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }

      await ensureActorCanEdit(tx, event, input.actorHumanId);
      ensureEventIsEditable(event);

      reindexEventId = event.id;

      const isAdjustable =
        (input.pricingMode ?? ticketType.pricingMode) === "ADJUSTABLE";

      // Merge the partial schedule against the stored row BEFORE validating,
      // so "clear the date but keep the price" is rejected rather than
      // persisted as a half-configuration. ADJUSTABLE types have no list price
      // to flip, so the schedule is cleared outright (same rule as
      // resaleAllowed / resaleCapCents below).
      const schedule = isAdjustable
        ? { scheduledPriceCents: null, scheduledPriceAt: null }
        : normalizeScheduledPrice({
            scheduledPriceCents:
              input.scheduledPriceCents !== undefined
                ? input.scheduledPriceCents
                : ticketType.scheduledPriceCents,
            scheduledPriceAt:
              input.scheduledPriceAt !== undefined
                ? input.scheduledPriceAt
                : ticketType.scheduledPriceAt,
          });

      // Merge the partial window against the stored row BEFORE validating, for
      // the same reason the schedule does: a request that moves only ONE bound
      // must be checked against the OTHER bound as stored, or "open at 20:00"
      // on a tier that closes at 18:00 persists an unsellable window. The
      // window is NOT cleared for ADJUSTABLE — it is sellability, not a price.
      const salesWindow = normalizeSalesWindow({
        salesOpenAt:
          input.salesOpenAt !== undefined
            ? input.salesOpenAt
            : ticketType.salesOpenAt,
        salesCloseAt:
          input.salesCloseAt !== undefined
            ? input.salesCloseAt
            : ticketType.salesCloseAt,
      });

      // The exact row patch this request writes. Built once so the sales lock
      // below judges the SAME values the write persists (including the
      // ADJUSTABLE clamps and the merged schedule / window pairs).
      const patch: TicketTypePatch = {
        id: ticketType.id,
        name: input.name,
        description: input.description,
        priceCents: isAdjustable ? 0 : input.priceCents,
        pricingMode: input.pricingMode,
        minimumCents:
          input.pricingMode !== undefined
            ? isAdjustable
              ? (input.minimumCents ?? 0)
              : null
            : input.minimumCents,
        suggestedCents:
          input.pricingMode !== undefined
            ? isAdjustable
              ? (input.suggestedCents ?? null)
              : null
            : input.suggestedCents,
        capacity: input.capacity,
        resaleAllowed: isAdjustable ? false : input.resaleAllowed,
        resaleCapCents: isAdjustable ? null : input.resaleCapCents,
        // Always written as a pair — the merged, validated values.
        scheduledPriceCents: schedule.scheduledPriceCents,
        scheduledPriceAt: schedule.scheduledPriceAt,
        // Written as the merged, validated pair for the same reason.
        salesOpenAt: salesWindow.salesOpenAt,
        salesCloseAt: salesWindow.salesCloseAt,
      };

      // ── Sales lock ────────────────────────────────────────────────────
      // Once the event has sold a ticket, the admin editor locks its ticket
      // types; this is the server half of that lock. Only a request that would
      // CHANGE a locked column is refused — capacity is outside the lock, and
      // an identical resend is not a change. The sales read runs only when
      // there is something to refuse, so capacity-only edits cost what they
      // did before.
      const lockedChanges = salesLockedColumnsChanged(input, patch, ticketType);
      if (
        lockedChanges.length > 0 &&
        (await eventHasTicketSales(tx, event.id))
      ) {
        throw fail("TICKET_TYPE_LOCKED_BY_SALES", {
          meta: { fields: lockedChanges },
        });
      }

      // ── Resale needs the event's clause (organiser-resale-share FR-001) ──
      // Switching resale ON is refused while the event's RESALE terms carry
      // no clause: every resale pays the event side a share set up front.
      // Only the transition: a type already allowing resale (before the
      // clause existed) keeps its unrelated edits; publish holds the line.
      if (patch.resaleAllowed === true && !ticketType.resaleAllowed) {
        await requireEventResaleClauseSet(tx, event);
      }

      // If renaming, check for name conflicts with other ticket types on same event
      if (input.name && input.name !== ticketType.name) {
        const existing = await tx.tickets.findTicketTypeByName(
          event.id,
          input.name,
        );
        if (existing && existing.id !== ticketType.id) {
          throw fail("TICKET_TYPE_NAME_TAKEN");
        }
      }

      // ── Free → paid flip gates ─────────────────────────────────────────
      // This use case is the OTHER way a tier becomes money-taking: editing an
      // existing free tier's price (or scheduling a flip) rather than adding a
      // new paid tier through `upsertTicketType`. Since `publishEvent` now lets
      // a FREE event publish with no fee policy pinned to its payout terms —
      // and never runs its Stripe check on an event with no paid tiers — a flip
      // performed here on such an event would otherwise be discovered by the
      // BUYER at checkout (AGREEMENT_MISSING_FEE_POLICY / a failed charge
      // against an owner with no Connect account). Gating only the create path
      // would not be a gate.
      //
      // BOTH gates fire ONLY on the TRANSITION (was-free → now-paid), never on
      // an edit to an already-paid tier: an event that is already selling has a
      // policy and a payee by construction, and re-gating would let an
      // unrelated platform blip block routine edits like a capacity change.
      //
      // The two predicates differ ON PURPOSE — `ticketTypeRequiresStripe`
      // excludes a pure pay-what-you-want tier with no minimum (a narrower
      // historical rule), `ticketTypeNeedsFeePolicy` includes it because
      // `publishEvent` treats ADJUSTABLE as paid. Each gate is asked its own
      // question, on the same transition.
      const mergedPriceCents = isAdjustable
        ? 0
        : (input.priceCents ?? ticketType.priceCents);
      const mergedPricingMode = input.pricingMode ?? ticketType.pricingMode;
      const mergedTicketType = {
        priceCents: mergedPriceCents,
        scheduledPriceCents: schedule.scheduledPriceCents,
        pricingMode: mergedPricingMode,
        // The ADJUSTABLE arm's term. `?? stored ?? 0` can read HIGHER than the
        // value actually persisted in one shape (an explicit `null` clear, or a
        // pricingMode switch that resets the minimum to 0, on a tier whose
        // stored minimum was positive) — but never LOWER, so it cannot open a
        // hole. And an over-read is unreachable anyway: a stored minimum above
        // zero already makes the STORED side require Stripe, which means there
        // is no transition to gate.
        minimumCents: isAdjustable
          ? (input.minimumCents ?? ticketType.minimumCents ?? 0)
          : null,
      };
      const storedTicketType = {
        priceCents: ticketType.priceCents,
        scheduledPriceCents: ticketType.scheduledPriceCents,
        pricingMode: ticketType.pricingMode,
        minimumCents: ticketType.minimumCents,
      };

      // Stripe first, mirroring `upsertTicketType`'s ordering so a tier missing
      // BOTH preconditions reports the same code from either write path.
      if (
        !ticketTypeRequiresStripe(storedTicketType) &&
        ticketTypeRequiresStripe(mergedTicketType)
      ) {
        await ensureStripeConnectedForPaidTicketing(tx, event);
      }

      if (
        !ticketTypeNeedsFeePolicy(storedTicketType) &&
        ticketTypeNeedsFeePolicy(mergedTicketType)
      ) {
        await ensureFeePolicyResolvableForPaidTicketing(
          tx,
          event,
          deps.clock.now(),
          {
            logger: scopedLogger,
            reportError: deps.reportError,
            source: "updateTicketType",
          },
        );
      }

      // Stored seat price overrides. A switch to FIXED makes this tier start
      // charging the overrides its section already stores (an ADJUSTABLE tier
      // ignores them). A FREE FIXED tier triggers neither transition above,
      // so the override write's own gates run here. No read when the mode
      // does not become FIXED, or when the tier is paid. A switch to
      // ADJUSTABLE is never refused by this.
      await ensureStoredOverridesGatedForTierWrites(
        tx,
        event,
        [
          {
            before: ticketType,
            after: {
              ...mergedTicketType,
              status: ticketType.status,
              seatSectionId: ticketType.seatSectionId ?? null,
            },
          },
        ],
        deps.clock.now(),
        {
          logger: scopedLogger,
          reportError: deps.reportError,
          source: "updateTicketType",
        },
      );

      const updated = await tx.tickets.updateTicketType(patch);

      await tx.audit.log({
        entity: "ticket_type",
        entityId: updated.id,
        action: "updated",
        data: {
          eventId: event.id,
          name: updated.name,
          priceCents: updated.priceCents,
          capacity: updated.capacity,
          actorHumanId: input.actorHumanId,
          // FR-008 write side: record the schedule on the audit row so a
          // "why did this event's browse price change at 6pm?" question has an
          // answer that does not depend on the search index.
          scheduledPriceCents: schedule.scheduledPriceCents,
          scheduledPriceAt: schedule.scheduledPriceAt,
          // FR-014 write side: an organizer asking "why did this tier stop
          // selling at 6pm?" gets an answer from the audit row, not from
          // guesswork.
          salesOpenAt: salesWindow.salesOpenAt,
          salesCloseAt: salesWindow.salesCloseAt,
        },
        at: deps.clock.now(),
      });

      // The event's document stamps the tier pricing (see below).
      await markForSearchReindex(
        tx,
        [{ kind: "event", id: event.id }],
        deps.clock.now(),
      );

      return updateTicketTypeOutputSchema.parse({
        ticketTypeId: updated.id,
        name: updated.name,
        priceCents: updated.priceCents,
        capacity: updated.capacity,
        status: updated.status,
      });
    });

    // A price edit changes both `minPaidPriceCents` and the fee-inclusive
    // `lowestBuyerTotalCents` stamped on the event's search document. Reindex so
    // the card badge is not stale. Best-effort + fire-and-forget.
    if (reindexEventId) {
      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        "updateTicketType",
        { kind: "event", id: reindexEventId },
      );
    }

    return result;
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateTicketType", execute);
  }

  return execute();
}

async function ensureActorCanEdit(
  tx: TxRepos,
  event: EventRecord,
  actorHumanId: string,
): Promise<void> {
  if (event.orgId) {
    await requireOrgMembership({
      repos: tx,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else {
    await ensureActorHoldsHumanEventRole(tx.authz, event.humanId, actorHumanId);
  }
}

function ensureEventIsEditable(event: EventRecord): void {
  if (event.status === "ARCHIVED" || event.status === "CANCELLED") {
    throw fail("EVENT_NOT_EDITABLE");
  }
}

type SalesLockedColumn = keyof TicketTypePatch & keyof TicketTypeRecord;
type UpdateInputKey = keyof UpdateTicketTypeInput;

/**
 * Columns the sales lock covers — the fields the admin editor disables once
 * the event has sold a ticket — each paired with the INPUT keys that can write
 * it. `pricingMode` is a source for the columns its clamps rewrite (price,
 * minimum/suggested, resale, schedule).
 *
 * NOT here, on purpose:
 * - `capacity` — the owner is reconsidering capacity on ticket types; the
 *   server keeps accepting capacity edits after sales, as it always has.
 * - `description` — the editor has no description control, so it has nothing
 *   to mirror.
 */
const SALES_LOCKED_COLUMNS: ReadonlyArray<{
  column: SalesLockedColumn;
  sources: ReadonlyArray<UpdateInputKey>;
}> = [
  { column: "name", sources: ["name"] },
  { column: "priceCents", sources: ["priceCents", "pricingMode"] },
  { column: "pricingMode", sources: ["pricingMode"] },
  { column: "minimumCents", sources: ["minimumCents", "pricingMode"] },
  { column: "suggestedCents", sources: ["suggestedCents", "pricingMode"] },
  { column: "resaleAllowed", sources: ["resaleAllowed", "pricingMode"] },
  { column: "resaleCapCents", sources: ["resaleCapCents", "pricingMode"] },
  {
    column: "scheduledPriceCents",
    sources: ["scheduledPriceCents", "scheduledPriceAt", "pricingMode"],
  },
  {
    column: "scheduledPriceAt",
    sources: ["scheduledPriceCents", "scheduledPriceAt", "pricingMode"],
  },
  { column: "salesOpenAt", sources: ["salesOpenAt", "salesCloseAt"] },
  { column: "salesCloseAt", sources: ["salesOpenAt", "salesCloseAt"] },
];

/** Columns the ADJUSTABLE clamp in `updateTicketType` forces on every write. */
const ADJUSTABLE_CLAMPED_COLUMNS: ReadonlySet<SalesLockedColumn> = new Set([
  "priceCents",
  "resaleAllowed",
  "resaleCapCents",
  "scheduledPriceCents",
  "scheduledPriceAt",
]);

/**
 * The locked columns this request would change, in declaration order.
 *
 * A column counts as changed only when BOTH hold:
 * 1. the request supplied one of its source keys (omitted = unchanged — the
 *    partial-update contract), so a capacity-only request never trips the
 *    lock, even on a row whose stored state the clamps would tidy; and
 * 2. the value the patch writes differs from the stored one. Money is integer
 *    cents compared with `===`; instants by `getTime()`; `null` is a value.
 *    An identical resend therefore passes.
 *
 * Both sides are normalised FOR THE COMPARISON ONLY (the patch that is written
 * is untouched), so a value the editor cannot round-trip — or a column the
 * ADJUSTABLE clamp rewrites regardless of input — is not mistaken for a change
 * and does not block a capacity edit through the editor after a sale:
 * - ADJUSTABLE on both sides: priceCents, resaleAllowed, resaleCapCents,
 *   scheduledPriceCents and scheduledPriceAt are skipped. They are exactly the
 *   columns the clamp above forces (0 / false / null / null), so on an older
 *   row that still carries other values the "change" is the clamp's, not the
 *   request's. No charge path reads them on an ADJUSTABLE tier. The clamped
 *   values are still written.
 * - ADJUSTABLE on both sides: minimumCents / suggestedCents compare `0` equal
 *   to `null`. They are NOT equivalent for buyers (a suggested 0 still drives
 *   the pay-what-you-want preset chips, the mobile "From $x" and the admin
 *   Sell catalogue prefill). The lock treats them as equal only because the editor cannot
 *   round-trip a stored 0: it shows it as an empty field and saves `null`.
 *   That rewrite is pre-existing editor behaviour; this lock does not add it.
 * - FIXED on both sides: minimumCents / suggestedCents are skipped (the editor
 *   always sends `null` for them on a fixed-price tier).
 * - resaleAllowed false on both sides: resaleCapCents is skipped (the editor
 *   sends `null` for the cap while resale is off). Note the stored cap is not
 *   entirely inert: `createResaleCheckout` still reads the live cap for older
 *   listings that have no pricingSnapshot.
 */
function salesLockedColumnsChanged(
  input: UpdateTicketTypeInput,
  patch: TicketTypePatch,
  stored: TicketTypeRecord,
): SalesLockedColumn[] {
  const nextMode = patch.pricingMode ?? stored.pricingMode;
  const bothAdjustable =
    nextMode === "ADJUSTABLE" && stored.pricingMode === "ADJUSTABLE";
  const bothFixed = nextMode === "FIXED" && stored.pricingMode === "FIXED";
  const resaleOffBothSides =
    !(patch.resaleAllowed ?? stored.resaleAllowed) && !stored.resaleAllowed;

  const isBuyerAmount = (column: SalesLockedColumn) =>
    column === "minimumCents" || column === "suggestedCents";
  const normalise = (column: SalesLockedColumn, value: unknown): unknown =>
    bothAdjustable && isBuyerAmount(column) && value === 0 ? null : value;

  const changed: SalesLockedColumn[] = [];
  for (const { column, sources } of SALES_LOCKED_COLUMNS) {
    if (!sources.some((key) => input[key] !== undefined)) continue;
    if (bothAdjustable && ADJUSTABLE_CLAMPED_COLUMNS.has(column)) continue;
    if (bothFixed && isBuyerAmount(column)) continue;
    if (resaleOffBothSides && column === "resaleCapCents") continue;
    const next = patch[column];
    if (next === undefined) continue;
    if (
      !sameColumnValue(
        normalise(column, next),
        normalise(column, stored[column]),
      )
    ) {
      changed.push(column);
    }
  }
  return changed;
}

function sameColumnValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  }
  return a === b;
}
