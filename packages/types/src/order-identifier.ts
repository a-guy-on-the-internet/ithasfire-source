/**
 * Order identifier parsing AND formatting — shared by the admin search use case
 * (FR-012), the owner-scoped order list queries, and every surface that renders
 * an order code, so none of them can disagree about what "an order id" looks
 * like.
 *
 * Both directions live in ONE module deliberately. The bug this module exists
 * to prevent was real: orders carried a random 10-char base-36 `shortId` that
 * some surfaces displayed while the dashboard displayed the 8-hex tail of the
 * UUID, so a single order showed two different codes in two places and the code
 * an admin copied from one screen resolved to nothing in the other. Keeping
 * `formatOrderCode` next to `orderIdentifierFromQuery` makes the displayed code
 * and the parseable code impossible to drift apart — the round trip is pinned
 * by a test.
 *
 * Lives in `@th/types` rather than in a use case because BOTH the core layer
 * and the Prisma adapter need it: `searchOrgAdmin` decides whether to attempt
 * a lookup at all, and `orders.listForOrg` / `listForHumanOwnedEvents` add an
 * identifier arm to their search predicate so the FR-012 hand-off
 * (`/admin/<slug>/orders?q=<id>`) actually resolves.
 */

/** Canonical 8-4-4-4-12 hex UUID, the shape of `Order.id`. */
const ORDER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many trailing characters of `Order.id` make up the displayed code. */
const ORDER_CODE_LENGTH = 8;

/**
 * The 8-hex-char TAIL of `Order.id`, uppercased — the code every surface
 * renders (see `formatOrderCode`). It is not a full UUID, so without this arm
 * the code a user is most likely to copy resolves to nothing.
 *
 * Gated on HEX specifically, not on length: an 8-letter English word must not
 * trigger an order lookup, whereas `DB21B2C3` must.
 */
const ORDER_ID_SUFFIX_PATTERN = /^[0-9a-f]{8}$/i;

/**
 * The single, canonical order code for display: the last 8 hex characters of
 * the order UUID, uppercased. No leading `#` — callers add it where their
 * layout wants one (`#{formatOrderCode(order.id)}`).
 *
 * The output round-trips through `orderIdentifierFromQuery`, so a user can
 * paste a code they see straight into admin search — but that holds only while
 * the id ENDS IN 8 HEX CHARACTERS, because the parser is hex-gated
 * (`ORDER_ID_SUFFIX_PATTERN`) to keep ordinary words from triggering a lookup.
 * `Order.id` is `@default(uuid())`, so production always satisfies it. A
 * hand-written id (`order-1` in a seed or fixture) still formats — to `ORDER-1`
 * — but no search will resolve it. That degrades quietly rather than throwing,
 * which is right for a display helper; just don't read the round trip as
 * unconditional.
 */
export function formatOrderCode(orderId: string): string {
  return orderId.slice(-ORDER_CODE_LENGTH).toUpperCase();
}

export type OrderIdentifier = {
  /** Exact `Order.id`. Unique. */
  id?: string;
  /**
   * Suffix of `Order.id`. NOT unique by construction (32 bits), so a consumer
   * that must resolve exactly one order has to handle multiple matches — see
   * `OrdersRepo.findForOwner`, which returns `null` rather than guessing.
   */
  idSuffix?: string;
};

/**
 * Decide whether a query is an ORDER IDENTIFIER, and of which kind.
 *
 * Returns `null` for anything that is not id-shaped. Callers use that to avoid
 * issuing an order-identifier query at all — a text search must not turn into
 * an id lookup, and an unsargable `id LIKE '%text%'` must never reach the DB.
 *
 * Two deliberate leniencies:
 *  - a single leading `#` is stripped, because order codes are rendered as
 *    `#DB21B2C3` and people paste what they see;
 *  - matching is case-insensitive and normalised down, because `Order.id` is
 *    stored lowercase but the code is displayed (and typed) uppercase.
 *
 * Known imprecision, accepted: an 8-letter hex-only word ("deadbeef")
 * satisfies the id-suffix shape. It costs one owner-scoped lookup that finds
 * nothing. Requiring a digit would reject genuine codes that happen to have
 * none.
 *
 * Two arms, by specificity — full UUID (36 chars), then id suffix (8). The
 * lengths are disjoint, so the order is documentation rather than tie-breaking.
 */
export function orderIdentifierFromQuery(
  query: string,
): OrderIdentifier | null {
  const candidate = query.trim().replace(/^#/, "").trim();
  if (!candidate) return null;
  if (ORDER_UUID_PATTERN.test(candidate))
    return { id: candidate.toLowerCase() };
  if (ORDER_ID_SUFFIX_PATTERN.test(candidate))
    return { idSuffix: candidate.toLowerCase() };
  return null;
}

/** A Prisma `Order` where-clause fragment matching one identifier arm. */
export type OrderIdentifierClause =
  | { id: string }
  | { id: { endsWith: string; mode: "insensitive" } };

/**
 * The identifier arms of a search predicate, as clauses ready to drop into a
 * Prisma `OR`.
 *
 * EXACT equality for the id arm, never `contains`: `Order.id` is the PK. The
 * suffix arm cannot use an index — it is a deliberate, bounded exception so the
 * 8-hex code every surface displays is findable, and it is confined to the `id`
 * column rather than widened into a general substring search.
 *
 * Returns `[]` for anything not id-shaped, so ordinary text search emits
 * exactly the predicate it emitted before this existed.
 */
export function orderIdentifierClauses(
  query: string | null | undefined,
): OrderIdentifierClause[] {
  const identifier = orderIdentifierFromQuery(query ?? "");
  if (!identifier) return [];
  return [
    ...(identifier.id ? [{ id: identifier.id }] : []),
    ...(identifier.idSuffix
      ? [
          {
            id: { endsWith: identifier.idSuffix, mode: "insensitive" as const },
          },
        ]
      : []),
  ];
}
