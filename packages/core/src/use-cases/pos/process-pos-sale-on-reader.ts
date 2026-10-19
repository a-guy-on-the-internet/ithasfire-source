import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";
import { assertDoorSellsEvent } from "./_shared/door-event-gate";

import { parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireScannerAccessOnOrg } from "../../lib/rbac";
import { requireTicketingEventId } from "../orders/_shared/require-ticketing-order";

// ── Schema ───────────────────────────────────────────────────────────────────

export const processPosSaleOnReaderInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  /** Order created by `startPosSale`, still PENDING with a linked PI. */
  orderId: z.string().uuid(),
  /** Our `pos_readers.id` — NOT the Stripe `tmr_xxx`. */
  posReaderId: z.string().uuid(),
});

export type ProcessPosSaleOnReaderInput = z.infer<
  typeof processPosSaleOnReaderInputSchema
>;

export const processPosSaleOnReaderOutputSchema = z.object({
  orderId: z.string().uuid(),
  /**
   * Stripe's view of the reader action right after dispatch. Almost always
   * `in_progress` — the buyer hasn't tapped yet. Authoritative completion
   * comes from the webhook; poll `completePosSale` for it.
   */
  actionStatus: z.enum(["in_progress", "succeeded", "failed"]),
});

export type ProcessPosSaleOnReaderOutput = z.infer<
  typeof processPosSaleOnReaderOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type ProcessPosSaleOnReaderDeps = {
  repos: Repos;
  authz: AuthZPort;
  payments: PaymentProcessorPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Pushes an already-created PaymentIntent to a countertop reader.
 *
 * Sequencing: `startPosSale` creates the PENDING order + card-present PI, then
 * this dispatches it. They are separate because the cart is worth persisting
 * even if the reader turns out to be offline — the operator retries the
 * dispatch, not the whole sale.
 *
 * We never touch the reader over the network. This calls Stripe, and Stripe
 * relays to the reader on the connection the reader already holds open.
 *
 * SECURITY — the ownership check below is the whole reason `pos_readers`
 * exists. Every reader is registered on the PLATFORM Stripe account, so the
 * Stripe API will happily dispatch to ANY `tmr_xxx` we name. Without comparing
 * the reader's org to the event's org, an operator at org A could push a
 * charge onto org B's reader sitting on a counter across town. The check is
 * against the ORDER's event, not a client-supplied orgId, so it cannot be
 * spoofed by the caller.
 *
 * Auth: ORG_SCAN_ROLES on the event's org — same bar as taking the sale.
 */
export async function processPosSaleOnReader(
  deps: ProcessPosSaleOnReaderDeps,
  rawInput: unknown,
): Promise<ProcessPosSaleOnReaderOutput> {
  const input = parseInput(processPosSaleOnReaderInputSchema, rawInput);

  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }
  if (order.paymentChannel !== "POS") {
    throw fail("NOT_A_POS_ORDER");
  }
  if (order.status !== "PENDING") {
    // Already finalised (or cancelled) — re-dispatching would prompt the buyer
    // to pay for something that is already paid.
    throw fail("ORDER_NOT_PENDING");
  }
  if (!order.stripePaymentIntentId) {
    // startPosSale links the PI immediately after creating it, so a PENDING
    // POS order without one means that call died between the two writes.
    throw fail("PAYMENT_INTENT_MISMATCH");
  }

  const event = await deps.repos.events.getById(requireTicketingEventId(order));
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (!event.orgId) {
    throw fail("EVENT_NOT_ORG_OWNED");
  }

  await requireScannerAccessOnOrg({
    repos: deps.repos,
    authz: deps.authz,
    orgId: event.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_SCAN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  // Never put a charge on a reader for an event the door no longer sells: a
  // sale started before the event was cancelled (or unpublished) must not be
  // tapped after it. The cancellation voids such sales; this stops the tap
  // in the gap before it does.
  assertDoorSellsEvent(event);

  const reader = await deps.repos.posReaders.getById({ id: input.posReaderId });
  if (!reader) {
    throw fail("POS_READER_NOT_FOUND");
  }
  if (reader.orgId !== event.orgId) {
    throw fail("POS_READER_ORG_MISMATCH");
  }

  let result: { actionStatus: "in_progress" | "succeeded" | "failed" };
  try {
    result = await deps.payments.processPaymentIntentOnReader({
      readerId: reader.stripeReaderId,
      paymentIntentId: order.stripePaymentIntentId,
    });
  } catch (err) {
    const mapped = mapReaderDispatchError(err);
    deps.logger?.warn("pos.reader.dispatch_failed", {
      actorHumanId: input.actorHumanId,
      orderId: order.id,
      posReaderId: reader.id,
      stripeReaderId: reader.stripeReaderId,
      mapped,
    });
    deps.metrics?.increment("pos.reader_dispatch.failed", {
      eventId: event.id,
      reason: mapped ?? "unknown",
    });
    if (mapped) {
      throw fail(mapped);
    }
    throw err;
  }

  deps.logger?.info("pos.reader.dispatched", {
    actorHumanId: input.actorHumanId,
    orgId: event.orgId,
    orderId: order.id,
    posReaderId: reader.id,
    actionStatus: result.actionStatus,
  });
  deps.metrics?.increment("pos.reader_dispatch.success", { eventId: event.id });

  return processPosSaleOnReaderOutputSchema.parse({
    orderId: order.id,
    actionStatus: result.actionStatus,
  });
}

/**
 * Maps the two Stripe failures an operator can actually fix into typed codes.
 * Everything else stays an unmapped throw so it reaches Sentry as a real bug
 * rather than being flattened into a friendly-but-wrong message.
 */
function mapReaderDispatchError(
  err: unknown,
): "POS_READER_OFFLINE" | "POS_READER_BUSY" | null {
  if (typeof err !== "object" || err === null) {
    return null;
  }
  const code = (err as { code?: unknown }).code;
  if (code === "terminal_reader_offline") {
    return "POS_READER_OFFLINE";
  }
  if (
    code === "terminal_reader_busy" ||
    code === "terminal_reader_collected_data_invalid" ||
    code === "terminal_reader_invalid_state"
  ) {
    return "POS_READER_BUSY";
  }
  return null;
}
