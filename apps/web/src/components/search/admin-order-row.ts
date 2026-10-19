/**
 * admin-order-row — the FR-012 order result, formatted once for both surfaces.
 *
 * `search.adminOrgSearch` returns at most one `order` for an id-shaped query,
 * and BOTH the ⌘K overlay and `/admin/[slug]/search` render it. The spec wants
 * those two surfaces to agree on what exists; letting each format the same row
 * its own way is how they stop agreeing.
 *
 * Pure: takes the translator and the locale formatters as arguments so it can
 * be unit-tested without a provider, and so neither surface reaches for
 * `toLocaleDateString(undefined, …)` (the BROWSER locale) behind the app's back.
 */

import { formatOrderCode } from "@th/types/order-identifier";

import { fmtCurrency } from "@/lib/format";

import {
  ORDER_HAPPY_PATH_STATUS,
  ORDER_STATUS_LABEL_KEY,
} from "./spotlight-admin-facets";

/** The `order` slice of `search.adminOrgSearch`'s output. */
export type AdminOrderResult = {
  id: string;
  status: string;
  buyerName: string | null;
  buyerEmail: string | null;
  eventTitle: string;
  amountGrossCents: number;
  currency: string;
  occurredAt: Date | string;
};

/** Narrow on purpose: nothing here interpolates, so no `values` bag is needed. */
type Translate = (key: string) => unknown;
type Formatters = {
  currency: (amount: number, currency: string) => string;
  dateTime: (value: Date, options?: Intl.DateTimeFormatOptions) => string;
};

/**
 * What an admin actually recognises: the ONE order code, rendered `#DB21B2C3`
 * exactly as the dashboard, the order panel and the wallet pass render it. 36
 * characters of hex is not an identifier anyone reads.
 */
export function formatOrderRowTitle(order: AdminOrderResult): string {
  return `#${formatOrderCode(order.id)}`;
}

/**
 * The order's status label, or null on the happy path.
 *
 * SUCCEEDED is omitted exactly as the event row omits PUBLISHED — annotating
 * every row with "Paid" is noise that makes the rows which DO need attention
 * harder to spot.
 *
 * Kept OUT of {@link formatOrderRowDetail} on purpose. The detail line is one
 * nowrap+ellipsis run, so at 320px it clips around the amount — burying the
 * status there means a DISPUTED order loses the single annotation the row
 * exists to surface. Callers place it where their layout protects it: the page
 * puts it in the right-hand column (matching its event rows), and the overlay,
 * which has only one line, leads with it.
 */
export function formatOrderRowStatus(
  order: AdminOrderResult,
  t: Translate,
): string | null {
  if (order.status === ORDER_HAPPY_PATH_STATUS) return null;
  const key = ORDER_STATUS_LABEL_KEY[order.status];
  return key ? String(t(key)) : order.status;
}

/** Buyer · event · amount · date. Status is separate — see above. */
export function formatOrderRowDetail(
  order: AdminOrderResult,
  fmt: Formatters,
): string {
  const parts: string[] = [];

  const buyer = order.buyerName ?? order.buyerEmail;
  if (buyer) parts.push(buyer);
  if (order.eventTitle) parts.push(order.eventTitle);

  parts.push(fmtCurrency(fmt, order.amountGrossCents, order.currency));

  const occurredAt = new Date(order.occurredAt);
  if (!Number.isNaN(occurredAt.getTime())) {
    parts.push(
      fmt.dateTime(occurredAt, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    );
  }

  return parts.join(" · ");
}

/**
 * The overlay's single-line subtitle: status FIRST so it is never the thing
 * the ellipsis eats, matching `formatEventSubtitle`'s ordering.
 */
export function formatOrderRowSubtitle(
  order: AdminOrderResult,
  t: Translate,
  fmt: Formatters,
): string {
  return [formatOrderRowStatus(order, t), formatOrderRowDetail(order, fmt)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Where the row lands — FR-012's hand-off, `/orders?q=<order identifier>`.
 *
 * The displayed code travels, not the raw UUID: a pre-filled search box showing
 * `DB21B2C3` is legible where 36 characters of hex is not, and it is the same
 * string the row's title shows, so the hand-off is self-evidently consistent.
 *
 * ## This depends on the orders list matching order identifiers
 *
 * The org orders table filters through `orders.listOrgOrders` →
 * `repos.orders.listForOrg` (and `listForHumanOwnedEvents` for human-owned
 * scope). Those predicates must match the id and its 8-hex tail alongside buyer
 * name/email, which they do because BOTH build their where-clause with
 * `orderSearchWhere` — the only function in
 * `packages/adapters/src/db/prisma/orders.ts` that calls
 * `orderIdentifierClauses`. (`countDistinctBuyersForOwner` uses it too, so the
 * attendee count agrees with the list it labels.)
 *
 * Do NOT read the platform-wide `listAll` as cover for this: it hand-rolls
 * `{ id: { contains: trimmed, mode: "insensitive" } }` and never touches
 * `orderIdentifierClauses`. It happens to match a pasted code by substring, but
 * it is a different predicate on a different (platform, not owner) scope, and
 * this hand-off does not go through it.
 *
 * Without the identifier arm this link resolves to an EMPTY list: a dead end at
 * the exact moment the admin found what they searched for. If that arm is ever
 * removed, this hand-off breaks silently — nothing here can detect it, because
 * an unmatched `?q=` is indistinguishable from an org with no such order.
 */
export function adminOrderRowHref(
  orgSlug: string,
  order: AdminOrderResult,
): string {
  const identifier = formatOrderCode(order.id);
  return `/admin/${orgSlug}/orders?q=${encodeURIComponent(identifier)}`;
}
