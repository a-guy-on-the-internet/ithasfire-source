import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { TxRepos } from "@th/ports/repos";

// ─────────────────────────────────────────────────────────────────────────────
// resolveChargeContext — the order / event / owner behind a Stripe charge.
//
// Mirrors the private resolution in `disputes/shared.ts`
// (`resolveOrder` + `resolveDisputeContext` + `deriveOwner` +
// `deriveMembershipOwner`) without touching it: an early fraud warning needs
// the same "who sold this" answer a dispute does, so a warning and its later
// dispute land on the same order and the same owner. Keep the two in step —
// if the dispute resolver learns a new lookup, teach this one too.
//
// Resolution order: a previously stored orderId (a replay must not re-link),
// then the PaymentIntent (Order.stripePaymentIntentId), then an explicit
// metadata orderId. Owner: the event's org/human for ticketing; the single
// positive-split payee for a membership invoice (which has no event).
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvedChargeOwner = {
  ownerOrgId: string | null;
  ownerHumanId: string | null;
};

export type ResolvedChargeContext = {
  order: OrderRecord | null;
  event: EventRecord | null;
  owner: ResolvedChargeOwner | null;
  /** Why linkage stopped short, for the audit row. Null when fully linked. */
  unresolvedReason:
    | "order_not_found"
    | "metadata_event_mismatch"
    | "event_not_found"
    | "event_owner_not_found"
    | "membership_owner_unresolved"
    | null;
};

export type ResolveChargeContextInput = {
  existingOrderId?: string | null;
  paymentIntentId?: string | null;
  metadataOrderId?: string | null;
  /** Stripe metadata `eventId` (PaymentIntent, then charge), if stamped. */
  metadataEventId?: string | null;
};

export type ChargeContextRepos = Pick<
  TxRepos,
  "orders" | "events" | "splits" | "payees"
>;

export async function resolveChargeContext(
  repos: ChargeContextRepos,
  input: ResolveChargeContextInput,
): Promise<ResolvedChargeContext> {
  const order = await resolveOrder(repos, input);
  if (!order) {
    return { order: null, event: null, owner: null, unresolvedReason: "order_not_found" };
  }

  // Same rule as the dispute resolver: a stamped eventId that disagrees with
  // the order links the ORDER (the money is real) but never an owner — the
  // mismatch is a signal something was re-pointed and a human should look.
  if (input.metadataEventId && input.metadataEventId !== order.eventId) {
    return { order, event: null, owner: null, unresolvedReason: "metadata_event_mismatch" };
  }

  const event = order.eventId ? await repos.events.getById(order.eventId) : null;
  if (!event) {
    if (order.kind === "MEMBERSHIP") {
      const owner = await deriveMembershipOwner(repos, order.id);
      return owner
        ? { order, event: null, owner, unresolvedReason: null }
        : { order, event: null, owner: null, unresolvedReason: "membership_owner_unresolved" };
    }
    return { order, event: null, owner: null, unresolvedReason: "event_not_found" };
  }

  const owner = deriveOwner(event);
  if (!owner) {
    return { order, event, owner: null, unresolvedReason: "event_owner_not_found" };
  }
  return { order, event, owner, unresolvedReason: null };
}

async function resolveOrder(
  repos: ChargeContextRepos,
  input: ResolveChargeContextInput,
): Promise<OrderRecord | null> {
  if (input.existingOrderId) {
    const order = await repos.orders.getById(input.existingOrderId);
    if (order) return order;
  }
  if (input.paymentIntentId) {
    const ref = await repos.orders.findByPaymentIntent(input.paymentIntentId);
    if (ref) {
      const order = await repos.orders.getById(ref.id);
      if (order) return order;
    }
  }
  if (input.metadataOrderId) {
    return repos.orders.getById(input.metadataOrderId);
  }
  return null;
}

function deriveOwner(event: EventRecord): ResolvedChargeOwner | null {
  if (event.orgId) return { ownerOrgId: event.orgId, ownerHumanId: null };
  if (event.humanId) return { ownerOrgId: null, ownerHumanId: event.humanId };
  return null;
}

async function deriveMembershipOwner(
  repos: ChargeContextRepos,
  orderId: string,
): Promise<ResolvedChargeOwner | null> {
  const splits = await repos.splits.getForOrder(orderId);
  const payeeIds = [
    ...new Set(splits.filter((s) => s.amountCents > 0).map((s) => s.payeeId)),
  ];
  const [payeeId] = payeeIds;
  if (payeeIds.length !== 1 || !payeeId) return null;
  const payee = await repos.payees.getById(payeeId);
  if (!payee) return null;
  return payee.subjectType === "ORGANIZATION"
    ? { ownerOrgId: payee.subjectId, ownerHumanId: null }
    : { ownerOrgId: null, ownerHumanId: payee.subjectId };
}
