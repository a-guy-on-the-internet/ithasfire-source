import { z } from "zod";
import {
  MAX_DONATION_AMOUNT_CENTS,
  PWYW_SETTING_ABOVE_CAP_MESSAGE,
} from "../../lib/pricing/pay-what-you-want";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord, EventStatus } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { TicketTypeStatus } from "@th/ports/repos/tickets";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  ensureFeePolicyResolvableForPaidTicketing,
  ticketTypeNeedsFeePolicy,
} from "./_shared/ensure-fee-policy-for-paid-ticketing";
import {
  ensureStripeConnectedForPaidTicketing,
  ticketTypeRequiresStripe,
} from "./_shared/ensure-stripe-connected-for-paid-ticketing";
import { eventHasTicketSales } from "./_shared/ticket-sales-lock";
import { ensureSeatSectionsBelongToEvent } from "../events/_shared/ensure-seat-sections-of-event";
import { ensureStoredOverridesGatedForTierWrites } from "../events/_shared/seat-price-override-rules";
import { normalizeScheduledPrice } from "../../lib/ticket-types/scheduled-price";
import { normalizeSalesWindow } from "../../lib/ticket-types/sales-window";
import { requireEventResaleClauseSet } from "../../lib/resale-clause";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import { markForSearchReindex } from "../search/search-reindex-marks";
const IDEMPOTENCY_TTL_SECONDS = 120;

export const upsertTicketTypeInputSchema = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .transform((value) => value.trim()),
  description: z
    .string()
    .trim()
    .max(280)
    .nullish()
    .transform((value) => {
      if (value == null) return null;
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    }),
  priceCents: z.coerce.number().int().min(0),
  pricingMode: z.enum(["FIXED", "ADJUSTABLE"]).optional().default("FIXED"),
  /** Minimum amount in cents the buyer must pay (ADJUSTABLE mode). */
  minimumCents: z.coerce
    .number()
    .int()
    .min(0)
    // The same per-ticket cap checkout enforces: a minimum above it could
    // never be paid, and a suggestion above it could never be held.
    .max(MAX_DONATION_AMOUNT_CENTS, { message: PWYW_SETTING_ABOVE_CAP_MESSAGE })
    .optional()
    .nullable()
    .default(null),
  /** Suggested amount shown as the default in checkout (ADJUSTABLE mode). */
  suggestedCents: z.coerce
    .number()
    .int()
    .min(0)
    // The same per-ticket cap checkout enforces: a minimum above it could
    // never be paid, and a suggestion above it could never be held.
    .max(MAX_DONATION_AMOUNT_CENTS, { message: PWYW_SETTING_ABOVE_CAP_MESSAGE })
    .optional()
    .nullable()
    .default(null),
  capacity: z.coerce.number().int().min(1),
  seatSectionId: z
    .string()
    .uuid()
    .nullish()
    .transform((value) => value ?? null),
  resaleAllowed: z.boolean().optional().default(false),
  resaleCapCents: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .nullable()
    .default(null),
  transferAllowed: z.boolean().optional().default(true),
  /**
   * Scheduled price change (FR-005) — the post-flip price in cents and the
   * ABSOLUTE UTC instant it takes effect. Both null or both set;
   * `normalizeScheduledPrice` rejects a half-configuration with
   * TICKET_TYPE_SCHEDULE_INCOMPLETE rather than ignoring it.
   *
   * 0 is a legitimate value (a tier that becomes free at T), so `.min(0)` and
   * NOT `.positive()`.
   *
   * FR-007: the admin UI (SHIPPED in Phase 1c) collects a WALL-CLOCK date/time
   * and resolves it against `Event.timezone` with `zonedWallClockToInstant`
   * (apps/web/src/lib/template-shift-offset) before it reaches this schema,
   * previewing the resolved moment back to the organizer.
   *
   * NOT luxon. An earlier revision of this comment said luxon; apps/web carries
   * NO date library (verified — no luxon/date-fns/dayjs in its package.json),
   * Phase 1c correctly added none, and `zonedWallClockToInstant` is the repo's
   * Intl-based converter, which additionally REJECTS an instant that doesn't
   * read back to the requested wall clock (how DST gaps get caught). Do not
   * "fix" this by adding luxon.
   *
   * It must also NOT use PAYOUT_TZ / REFUND_TZ (America/Chicago) — a price flip
   * on that shortcut fires at the wrong hour for any non-Central event. This
   * boundary takes an INSTANT and does no zone arithmetic of its own.
   */
  scheduledPriceCents: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .nullable()
    .default(null),
  scheduledPriceAt: z.coerce.date().optional().nullable().default(null),
  /**
   * Per-type sales window (ticket-type-packs FR-014, adopted by FR-009). The
   * two bounds are INDEPENDENT — unlike the scheduled price there is no
   * both-or-neither rule, because "opens Friday, never closes" and "closes
   * Friday" are both legitimate. `normalizeSalesWindow` rejects an inverted or
   * zero-width window with TICKET_TYPE_SALES_WINDOW_INVALID.
   *
   * Absolute UTC instants. Same FR-007 discipline as `scheduledPriceAt`: the
   * admin resolves the organizer's wall clock against `Event.timezone` with
   * `zonedWallClockToInstant` before it reaches this schema — never
   * browser-local arithmetic, never PAYOUT_TZ / REFUND_TZ. This boundary takes
   * an INSTANT and does no zone arithmetic of its own.
   */
  salesOpenAt: z.coerce.date().optional().nullable().default(null),
  salesCloseAt: z.coerce.date().optional().nullable().default(null),
  clientKey: z.string().min(8),
});

export const upsertTicketTypeOutputSchema = z.object({
  ticketTypeId: z.uuid(),
  status: z.enum(["DRAFT", "ACTIVE"] as const satisfies TicketTypeStatus[]),
});

export type UpsertTicketTypeInput = z.infer<typeof upsertTicketTypeInputSchema>;
export type UpsertTicketTypeOutput = z.infer<
  typeof upsertTicketTypeOutputSchema
>;

export type UpsertTicketTypeDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Best-effort Sentry reporter, forwarded to the fee-policy scope walk so a
   * per-scope repo failure is reported against the scope that broke before the
   * walk rethrows it (the transaction is already condemned by then; the walk
   * never fabricates a `null` out of a fault).
   */
  reportError?: ReporterPort;
};

interface StoredTicketTypeRecord {
  payloadHash: string;
  response: UpsertTicketTypeOutput;
}

export async function upsertTicketType(
  deps: UpsertTicketTypeDeps,
  rawInput: unknown,
): Promise<UpsertTicketTypeOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "upsertTicketType" });

  const execute = async () => {
    const input = parseInput(upsertTicketTypeInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `ticket-type:create:${input.actorHumanId}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredTicketTypeRecord>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredTicketTypeRecord>(idempotencyKey);
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
        const event = await ensureEventExists(tx, input.eventId);

        // FR-003 (community-managed-event-listings): RSVP events never carry
        // ticket types — reject creation before any authz/pricing work.
        if (event.attendanceMode === "RSVP") {
          throw fail("EVENT_NOT_TICKETED");
        }

        await ensureEventAccessible(tx, event, input.actorHumanId);
        ensureEventIsEditable(event);

        // Sales lock: once the event has sold a ticket the admin editor stops
        // offering new ticket types, and the server refuses them with the
        // same measure — see `_shared/ticket-sales-lock`.
        if (await eventHasTicketSales(tx, event.id)) {
          throw fail("TICKET_TYPE_LOCKED_BY_SALES");
        }

        // ── Adjustable pricing validation ─────────────────────────────
        const isAdjustable = input.pricingMode === "ADJUSTABLE";
        const minimumCents = isAdjustable ? (input.minimumCents ?? 0) : null;
        const suggestedCents = isAdjustable
          ? (input.suggestedCents ?? null)
          : null;

        if (
          isAdjustable &&
          suggestedCents != null &&
          minimumCents != null &&
          suggestedCents < minimumCents
        ) {
          throw fail("SUGGESTED_BELOW_MINIMUM");
        }

        // ADJUSTABLE ticket types cannot be resold — the price is buyer-chosen,
        // so secondary market pricing doesn't apply.
        const resaleAllowed = isAdjustable ? false : input.resaleAllowed;
        // A new type allowing resale needs the event's clause set first
        // (organiser-resale-share FR-001), as `updateTicketType` refuses.
        if (resaleAllowed) {
          // Event row before RESALE terms (see `requireEventResaleClauseSet`):
          // the TicketType INSERT below takes FOR KEY SHARE on the event, and
          // publish holds the event FOR UPDATE and then locks the terms, so
          // taking the terms lock first here would be the opposite order.
          await tx.events.lockRows({ ids: [event.id], mode: "share" });
          await requireEventResaleClauseSet(tx, event);
        }

        // Same reasoning for a scheduled price change: there is no
        // list price to flip when the buyer names the amount. Cleared BEFORE
        // validation so an ADJUSTABLE type carrying a stray schedule is
        // normalized rather than rejected — but a FIXED type with only half a
        // schedule throws TICKET_TYPE_SCHEDULE_INCOMPLETE.
        const schedule = isAdjustable
          ? { scheduledPriceCents: null, scheduledPriceAt: null }
          : normalizeScheduledPrice({
              scheduledPriceCents: input.scheduledPriceCents,
              scheduledPriceAt: input.scheduledPriceAt,
            });

        // Sales window (FR-014). Deliberately NOT cleared for ADJUSTABLE: a
        // pay-what-you-can tier that only opens at doors-time is a coherent
        // configuration, and the window says nothing about the PRICE. The
        // schedule clear above exists because those fields are prices;
        // this one is sellability.
        const salesWindow = normalizeSalesWindow({
          salesOpenAt: input.salesOpenAt,
          salesCloseAt: input.salesCloseAt,
        });

        // For ADJUSTABLE mode, priceCents is ignored — use 0 as the stored value.
        const effectivePriceCents = isAdjustable ? 0 : input.priceCents;

        // Stripe gate. The predicate widens the old `effectivePriceCents > 0`
        // test to cover a type that takes money WITHOUT a positive price
        // today: a scheduled flip to a paid price (FR-005). Without this, a $0-now / $20-at-T tier is
        // created with no connected account and every sale fails from T onward.
        //
        // SHARED with `updateTicketType`, which performs the same flip by
        // editing an existing free tier — see
        // `_shared/ensure-stripe-connected-for-paid-ticketing`. ADJUSTABLE
        // keeps its NARROWER historical rule there (a pure pay-what-you-want
        // with no minimum needs no connected account).
        const requiresStripe = ticketTypeRequiresStripe({
          priceCents: effectivePriceCents,
          scheduledPriceCents: schedule.scheduledPriceCents,
          pricingMode: input.pricingMode,
          minimumCents,
        });

        // Fee-policy gate. Its predicate is WIDER than `requiresStripe` above
        // and is evaluated separately, on purpose: `requiresStripe` excludes a
        // pure pay-what-you-want tier with no minimum (a narrower historical
        // rule this change does not touch), but `publishEvent` DOES treat
        // ADJUSTABLE as paid. Sharing the Stripe branch would leave the ticket
        // editor accepting a tier that publish then rejects, so the two gates
        // are asked their own questions. See `ticketTypeNeedsFeePolicy`.
        const needsFeePolicy = ticketTypeNeedsFeePolicy({
          priceCents: effectivePriceCents,
          scheduledPriceCents: schedule.scheduledPriceCents,
          pricingMode: input.pricingMode,
        });

        // The seat section must be one of THIS event's (the store only needs
        // it to exist). Ahead of the money gates on purpose: a section of
        // another event is refused as not found, never as "requires Stripe",
        // and the same way as an id no section has. No read without a section.
        await ensureSeatSectionsBelongToEvent(tx.seats, event.id, [
          input.seatSectionId,
        ]);

        // Hoisted above the money gates (it used to be declared with the
        // create below) because the fee-policy scope walk is evaluated AT an
        // instant, and every write in this transaction must share it.
        const now = deps.clock.now();

        if (requiresStripe) {
          await ensureStripeConnectedForPaidTicketing(tx, event);
        }

        if (needsFeePolicy) {
          await ensureFeePolicyResolvableForPaidTicketing(tx, event, now, {
            logger: scopedLogger,
            reportError: deps.reportError,
            source: "upsertTicketType",
          });
        }

        const status = deriveTicketTypeStatus(event.status);

        // Stored seat price overrides. A FREE FIXED tier ran neither gate
        // above, yet checkout charges a seat of its section at the seat's
        // stored override: creating it on a section that already holds a paid
        // one starts taking money. Run the override write's own gates first.
        // A paid tier passed them above and is skipped here, with no read.
        await ensureStoredOverridesGatedForTierWrites(
          tx,
          event,
          [
            {
              before: null,
              after: {
                status,
                pricingMode: input.pricingMode,
                seatSectionId: input.seatSectionId ?? null,
                priceCents: effectivePriceCents,
                scheduledPriceCents: schedule.scheduledPriceCents,
                minimumCents,
              },
            },
          ],
          now,
          {
            logger: scopedLogger,
            reportError: deps.reportError,
            source: "upsertTicketType",
          },
        );

        const normalizedName = input.name;
        const existing = await tx.tickets.findTicketTypeByName(
          event.id,
          normalizedName,
        );
        if (existing) {
          throw fail("TICKET_TYPE_NAME_TAKEN");
        }

        const created = await tx.tickets.createTicketType({
          eventId: event.id,
          name: normalizedName,
          description: input.description,
          priceCents: effectivePriceCents,
          pricingMode: input.pricingMode,
          minimumCents,
          suggestedCents,
          capacity: input.capacity,
          status,
          createdAt: now,
          seatSectionId: input.seatSectionId,
          resaleAllowed,
          resaleCapCents: input.resaleCapCents,
          transferAllowed: input.transferAllowed,
          scheduledPriceCents: schedule.scheduledPriceCents,
          scheduledPriceAt: schedule.scheduledPriceAt,
          salesOpenAt: salesWindow.salesOpenAt,
          salesCloseAt: salesWindow.salesCloseAt,
        });

        await tx.audit.log({
          entity: "ticket_type",
          entityId: created.id,
          action: "created",
          data: {
            eventId: event.id,
            name: created.name,
            priceCents: created.priceCents,
            capacity: created.capacity,
            actorHumanId: input.actorHumanId,
          },
          at: now,
        });

        // A new tier moves the event document's stamped pricing.
        if (event.status === "PUBLISHED") {
          await markForSearchReindex(tx, [{ kind: "event", id: event.id }], now);
        }

        return upsertTicketTypeOutputSchema.parse({
          ticketTypeId: created.id,
          status: created.status,
        });
      });

      await deps.idempotency.commit<StoredTicketTypeRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("upsert_ticket_type", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("upsertTicketType", execute);
  }

  return execute();
}

// Exported for reuse by applyTicketTypeTemplate (same guard semantics).
export async function ensureEventExists(
  tx: TxRepos,
  eventId: string,
): Promise<EventRecord> {
  const event = await tx.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  return event;
}

export async function ensureEventAccessible(
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
    return;
  }

  await ensureActorHoldsHumanEventRole(tx.authz, event.humanId, actorHumanId);
}

export function ensureEventIsEditable(event: EventRecord): void {
  if (event.status === "ARCHIVED") {
    throw fail("EVENT_ARCHIVED");
  }
  if (event.status !== "DRAFT" && event.status !== "PUBLISHED") {
    throw fail("EVENT_NOT_EDITABLE");
  }
}

function deriveTicketTypeStatus(eventStatus: EventStatus): TicketTypeStatus {
  return eventStatus === "DRAFT" ? "DRAFT" : "ACTIVE";
}

function buildPayloadHash(input: UpsertTicketTypeInput): string {
  const payload = {
    eventId: input.eventId,
    name: input.name,
    description: input.description,
    priceCents: input.priceCents,
    pricingMode: input.pricingMode,
    minimumCents: input.minimumCents,
    suggestedCents: input.suggestedCents,
    capacity: input.capacity,
    seatSectionId: input.seatSectionId,
    resaleAllowed: input.resaleAllowed,
    resaleCapCents: input.resaleCapCents,
    transferAllowed: input.transferAllowed,
    // Part of the payload identity: a retry that changes the flip price or
    // instant is a DIFFERENT ticket type, and must surface
    // IDEMPOTENCY_KEY_CONFLICT rather than replay the first response. Dates
    // serialize to a stable ISO string under JSON.stringify.
    scheduledPriceCents: input.scheduledPriceCents,
    scheduledPriceAt: input.scheduledPriceAt,
    // Same reasoning as the schedule pair: a retry that moves the on-sale
    // window is a DIFFERENT ticket type and must surface
    // IDEMPOTENCY_KEY_CONFLICT rather than replay the first response.
    salesOpenAt: input.salesOpenAt,
    salesCloseAt: input.salesCloseAt,
  };
  return JSON.stringify(payload);
}
