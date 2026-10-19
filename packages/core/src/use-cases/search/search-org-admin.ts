import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventOwnerType, EventStatus } from "@th/ports/repos/events";
import type { BuyerOrderSummary } from "@th/ports/repos/orders";
import { orderStatusSchema } from "@th/schema";
import { orderIdentifierFromQuery as parseOrderIdentifier } from "@th/types/order-identifier";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { redactPlaceLocation } from "../../lib/location/redact-place-location";
import { requireOwnerAccess, ORG_ANY_ROLE } from "../../lib/rbac";
import { resolvePlaceAddressUnlocks } from "../places/_shared/place-address-unlock";

const ALL_EVENT_STATUSES: EventStatus[] = [
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
  "CANCELLED",
  "COMPLETED",
];

/** Max distinct event titles surfaced inline per attendee before "+N more". */
const ATTENDEE_EVENT_TITLE_CAP = 3;

const eventStatusSchema = z.enum([
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
  "CANCELLED",
  "COMPLETED",
]);

/**
 * The result groups this use case owns.
 *
 * `order` (FR-012) is a group of at most ONE row, resolved only when the query
 * is id-shaped. It was added after the other three: widening the enum is
 * backward-compatible (older callers simply never send it), and it is included
 * in {@link ALL_SEARCH_GROUPS} so the default — `types` absent — attempts the
 * lookup.
 */
const searchGroupSchema = z.enum(["event", "attendee", "venue", "order"]);

const ALL_SEARCH_GROUPS: SearchOrgAdminGroup[] = [
  "event",
  "attendee",
  "venue",
  "order",
];

export type SearchOrgAdminGroup = z.infer<typeof searchGroupSchema>;

/**
 * Id-shape detection lives in `@th/types` because the Prisma adapter needs the
 * SAME rule for the order-list search predicate — if the two ever disagreed,
 * an id the spotlight resolves would vanish on the orders page it hands off
 * to. Re-exported here so this use case stays the one import site for callers
 * that think in terms of admin search.
 */
export { orderIdentifierFromQuery } from "@th/types/order-identifier";

/**
 * Facets are OPTIONAL and ADDITIVE — absent means "today's behaviour". Every
 * array facet is `.nonempty()` on purpose: an empty array would otherwise be a
 * silent second encoding of "no facet" for statuses/categoryIds while meaning
 * "fetch nothing" for types. Rejecting `[]` at the boundary keeps absent and
 * empty from diverging, and the UI never needs to send one (clearing a facet
 * drops the key).
 */
export const searchOrgAdminInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
    ownerId: z.string().uuid(),
    query: z.string().trim().max(120).default(""),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /**
     * Result groups to fetch. Absent = all of {@link ALL_SEARCH_GROUPS}. A
     * group left out here has its repo query SKIPPED entirely (never
     * fetched-and-hidden) and returns an empty list with `{ shown: 0,
     * total: 0 }` — never a stale total for a query that never ran.
     */
    types: z.array(searchGroupSchema).nonempty().optional(),
    /** Events-only. Absent = ALL_EVENT_STATUSES (today's behaviour). */
    statuses: z.array(eventStatusSchema).nonempty().optional(),
    /**
     * Events-only inclusive filter on `startsAt`. Coerced because these
     * arrive over tRPC as ISO strings (matching list-org-settlements' date
     * bounds convention).
     */
    dateRange: z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .strict()
      .optional(),
    /** Events-only filter on `Event.categoryId`. */
    categoryIds: z.array(z.string().uuid()).nonempty().optional(),
    /**
     * Events-only. Widens the category filter to also match events with NO
     * category (`categoryId IS NULL`), which `categoryIds` structurally cannot
     * express — SQL `IN` never matches NULL, so an admin who picks any
     * category otherwise loses every uncategorised event and has no id they
     * could add to get them back.
     *
     * Alone (no `categoryIds`) it means "ONLY uncategorised", not "everything"
     * — a real filter, pinned by test at every layer.
     *
     * Unlike the arrays above, `false` is NOT rejected: those are `.nonempty()`
     * because `[]` would be a second, silent spelling of "absent". A boolean
     * has no such ambiguity — `false` and absent both mean "do not widen", so
     * they are deliberately INDISTINGUISHABLE here and downstream. The UI still
     * drops the key when false, which keeps URLs and query keys clean.
     */
    includeUncategorised: z.boolean().optional(),
  })
  .strict();

const eventSuggestionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().nullable(),
    status: eventStatusSchema,
    startsAt: z.coerce.date().nullable(),
    slug: z.string().nullable(),
  })
  .strict();

const attendeeSuggestionSchema = z
  .object({
    /**
     * In practice always a string: `Order.buyerHumanId` is NOT NULL with a
     * required `buyer Human` relation, so guest checkouts have a Human too.
     * The schema stays `.nullable()` only because narrowing a shipped output
     * field ripples into every consumer for no behavioural gain — read it as
     * "wire-compatible", NOT as "guests have no id".
     */
    buyerHumanId: z.string().uuid().nullable(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    /** Up to ATTENDEE_EVENT_TITLE_CAP distinct event titles this buyer purchased into. */
    eventTitles: z.array(z.string()),
    /** Remaining event count beyond the capped titles (0 when none hidden). */
    moreCount: z.number().int().min(0),
    /**
     * FR-013. This buyer's COMPLETED orders with the searched owner, all-time
     * — not the number on this page, and not narrowed by the search query.
     * (The query filters on buyer identity, so every order of a matching buyer
     * matches; the aggregate and the page describe the same set.)
     *
     * "Completed" = `COMPLETED_ORDER_STATUSES`: everything except PENDING
     * (an abandoned cart is not a purchase) and CANCELLED. So **0 is a real,
     * correct value** for a buyer who appears in the attendees list on the
     * strength of a pending cart alone — render it as "0 orders", never as an
     * empty or broken cell.
     */
    orderCount: z.number().int().min(0),
    /**
     * Most recent completed order for this buyer under the searched owner.
     * Null when `orderCount` is 0. Sourced from `occurredAt`, which is stamped
     * at checkout start and not restamped on settlement — "last ordered", not
     * a payment date.
     */
    lastOrderAt: z.coerce.date().nullable(),
  })
  .strict();

const venueSuggestionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    /**
     * The real formatted address for an EXACT venue, or for a withheld one
     * when the actor passes `canManagePlace`. Otherwise the venue's public
     * area label — never the street (D5). Same field, so the spotlight row
     * renders either without a branch.
     */
    address: z.string().nullable(),
  })
  .strict();

/**
 * FR-012. The single order matched by an id-shaped query, when the actor has
 * finance access to the owner. Deliberately minimal — a search result row, not
 * an order detail payload (that is `orders.getOrgOrder`).
 */
const orderSuggestionSchema = z
  .object({
    id: z.string().uuid(),
    status: orderStatusSchema,
    buyerName: z.string().nullable(),
    buyerEmail: z.string().nullable(),
    eventTitle: z.string(),
    amountGrossCents: z.number().int(),
    currency: z.string(),
    occurredAt: z.coerce.date(),
  })
  .strict();

/**
 * Per-group counts, with `shown` and `total` kept APART on purpose.
 *
 * `counts` used to be the length of the returned page, which saturates at
 * `limit` — an org with 200 matching drafts at `limit: 20` reported "20". A UI
 * cannot tell a saturated page length from a real total by looking at a bare
 * number, so the type now forces the distinction:
 *  - `shown` — rows in THIS response (≤ limit);
 *  - `total` — matches in the whole owner scope, from the repo's own count.
 *
 * A group excluded via `types` reports `{ shown: 0, total: 0 }` — its query
 * never ran, so there is no total to report and a stale one would be a lie.
 *
 * ⚠️ DO NOT RENDER THESE AS A FRACTION ("N of M"). For events and venues the
 * two share a unit, but for ATTENDEES they do not: `shown` is buyers deduped
 * out of a page of ORDERS, while `total` is distinct buyers across the whole
 * scope. If the top `limit` orders all belong to one whale, attendees reports
 * `shown: 1, total: 137` — and there is no pagination on this path, so the
 * other 136 are not reachable by asking for more. Render them as separate
 * facts ("137 attendees" / a page of results), never as a ratio.
 */
const groupCountSchema = z
  .object({
    shown: z.number().int().min(0),
    total: z.number().int().min(0),
  })
  .strict();

export const searchOrgAdminOutputSchema = z
  .object({
    events: z.array(eventSuggestionSchema),
    attendees: z.array(attendeeSuggestionSchema),
    venues: z.array(venueSuggestionSchema),
    /**
     * `null` whenever there is no order to show — not id-shaped, no match,
     * actor lacks finance access, or the `order` group was filtered out. All
     * four are the same observable result on purpose (NFR-002).
     */
    order: orderSuggestionSchema.nullable(),
    counts: z
      .object({
        events: groupCountSchema,
        /**
         * `total` is DISTINCT BUYERS, matching what `attendees` contains after
         * dedupe — never `orders.listForOrg().total`, which counts ORDERS and
         * would be a different number wearing an attendee label.
         */
        attendees: groupCountSchema,
        venues: groupCountSchema,
      })
      .strict(),
  })
  .strict();

export type SearchOrgAdminInput = z.infer<typeof searchOrgAdminInputSchema>;
export type SearchOrgAdminOutput = z.infer<typeof searchOrgAdminOutputSchema>;

/**
 * `authz` is narrowed to `canManagePlace` on purpose, and used for ONE thing:
 * deciding whether a WITHHELD venue in the venues group shows its real
 * address (D5 — the manage bar, never "any org membership"). It is probed
 * only for withheld venues the actor could plausibly manage, so the common
 * keystroke costs nothing extra.
 *
 * Finance-ness is still derived from the `OrgMembership` that
 * `requireOwnerAccess` already fetched — do not reach for
 * `authz.canFinanceOrg` here; that would re-read the same row on a path that
 * fires on every keystroke.
 */
export type SearchOrgAdminDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "canManagePlace">;
  logger?: LoggerPort;
};

/** Repo row shapes, so a skipped group can resolve an empty page in-place. */
type EventItems = Awaited<ReturnType<Repos["events"]["listByOwner"]>>["items"];
type VenueItems = Awaited<
  ReturnType<Repos["places"]["listAccessibleByHuman"]>
>["items"];

type AttendeeAccumulator = {
  buyerHumanId: string;
  name: string | null;
  email: string | null;
  titles: string[];
  seenTitles: Set<string>;
};

/**
 * `buyerHumanId` is non-null: `Order.buyerHumanId` is `String` (NOT NULL) with
 * a REQUIRED `buyer Human` relation (`order.prisma`), so every order — guest
 * checkouts included — has a Human row behind it. Guest buyers get a Human,
 * they just don't get an account.
 */
type AttendeeOrderRow = {
  buyerHumanId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  eventTitle: string;
  occurredAt?: Date | null;
};

function accumulateAttendees(
  orders: ReadonlyArray<AttendeeOrderRow>,
  /**
   * Owner-scoped per-buyer aggregates (FR-013), keyed by buyer.
   *
   * A MISSING entry means ZERO completed orders, not "unknown": the repo
   * filters to {@link COMPLETED_ORDER_STATUSES}, so a buyer whose only orders
   * are abandoned PENDING carts legitimately has no row. Falling back to a
   * page-derived count here would reinstate exactly the cart-counting lie the
   * filter removes.
   */
  summaries: ReadonlyMap<string, BuyerOrderSummary> = new Map(),
): SearchOrgAdminOutput["attendees"] {
  const byBuyer = new Map<string, AttendeeAccumulator>();

  for (const order of orders) {
    let acc = byBuyer.get(order.buyerHumanId);
    if (!acc) {
      acc = {
        buyerHumanId: order.buyerHumanId,
        name: order.buyerName,
        email: order.buyerEmail,
        titles: [],
        seenTitles: new Set<string>(),
      };
      byBuyer.set(order.buyerHumanId, acc);
    }
    if (order.eventTitle && !acc.seenTitles.has(order.eventTitle)) {
      acc.seenTitles.add(order.eventTitle);
      acc.titles.push(order.eventTitle);
    }
  }

  return Array.from(byBuyer.values()).map((acc) => {
    const summary = summaries.get(acc.buyerHumanId);
    return {
      buyerHumanId: acc.buyerHumanId,
      name: acc.name,
      email: acc.email,
      eventTitles: acc.titles.slice(0, ATTENDEE_EVENT_TITLE_CAP),
      moreCount: Math.max(0, acc.titles.length - ATTENDEE_EVENT_TITLE_CAP),
      orderCount: summary?.orderCount ?? 0,
      lastOrderAt: summary?.lastOrderAt ?? null,
    };
  });
}

/**
 * Fetch a page of the owner's order buyers, the true distinct-buyer total, and
 * each page buyer's owner-scoped order aggregates.
 *
 * Two sequential waves, per NFR-004's ≤2 round-trips per group:
 *   1. the page and the distinct-buyer count, in parallel;
 *   2. one grouped aggregate over the page's buyer ids (bounded by `limit`,
 *      never an N+1).
 */
async function loadAttendees(
  repos: Repos,
  args: {
    ownerType: EventOwnerType;
    ownerId: string;
    searchQuery: string | undefined;
    limit: number;
  },
): Promise<{ attendees: SearchOrgAdminOutput["attendees"]; total: number }> {
  const [page, total] = await Promise.all([
    // `skipTotal`: this group's total comes from countDistinctBuyersForOwner
    // (buyers, not orders), so the list's own COUNT is pure waste — and it is
    // the expensive shape, on every debounced keystroke.
    args.ownerType === "ORGANIZATION"
      ? repos.orders.listForOrg({
          orgId: args.ownerId,
          searchQuery: args.searchQuery,
          limit: args.limit,
          skipTotal: true,
        })
      : repos.orders.listForHumanOwnedEvents({
          ownerHumanId: args.ownerId,
          searchQuery: args.searchQuery,
          limit: args.limit,
          skipTotal: true,
        }),
    repos.orders.countDistinctBuyersForOwner({
      ownerType: args.ownerType,
      ownerId: args.ownerId,
      searchQuery: args.searchQuery,
    }),
  ]);

  // The org and human list results are structurally identical for everything
  // this use case reads; widen once so the union doesn't leak downstream.
  // NOTE `page.total` is deliberately NOT read — it is -1 under `skipTotal`.
  const items: AttendeeOrderRow[] = page.items;

  const buyerHumanIds = Array.from(
    new Set(items.map((item) => item.buyerHumanId)),
  );

  const summaries = buyerHumanIds.length
    ? await repos.orders.summarizeBuyerOrdersForOwner({
        ownerType: args.ownerType,
        ownerId: args.ownerId,
        buyerHumanIds,
      })
    : [];

  return {
    attendees: accumulateAttendees(
      items,
      new Map(summaries.map((summary) => [summary.buyerHumanId, summary])),
    ),
    total,
  };
}

/**
 * Live, org-scoped admin search across Events (incl. drafts), Attendees
 * (order buyers, incl. guests), and Venues. Unlike the public discovery
 * projection, this hits live repos so drafts and non-public buyers are visible.
 *
 * An id-shaped query additionally resolves at most ONE of the owner's own
 * orders (FR-012), via an owner-scoped repo lookup.
 *
 * AuthZ is split: events + venues require any org role (or human ownership);
 * attendees AND the order lookup additionally require finance access. A
 * non-finance actor still gets events + venues — the attendees group is simply
 * omitted and `order` stays null, never an error.
 *
 * Both halves of that split are answered by ONE `getOrgMembership` read:
 * `requireOwnerAccess` returns the membership row and its derived `canFinance`.
 * This use case must not call `authz.canFinanceOrg` — that would re-read the
 * same row on a path that fires on every keystroke.
 *
 * Facets (`types`, `statuses`, `dateRange`, `categoryIds`) narrow WHAT is
 * fetched, never WHO may fetch it: `requireOwnerAccess` runs before any repo
 * read regardless of which facets are set, and there is deliberately no staff
 * scope-override path here.
 *
 * Error handling (NFR-006): every repo call goes through
 * `callOrDependencyFailed`, which logs and RETHROWS. There is deliberately no
 * catch-and-fallback branch anywhere in this use case — in particular a failed
 * order lookup fails the search rather than silently omitting the row, which
 * would be indistinguishable from "no such order". No swallow ⇒ no
 * `reportError` obligation; adding one later means adding `reportError` too.
 */
export async function searchOrgAdmin(
  deps: SearchOrgAdminDeps,
  rawInput: unknown,
): Promise<SearchOrgAdminOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "searchOrgAdmin" });

  const execute = async (): Promise<SearchOrgAdminOutput> => {
    const input = parseInput(searchOrgAdminInputSchema, rawInput);
    const query = input.query.trim();

    // Events + venues access: any org member, or the human owner themselves.
    // The membership row this fetches ALSO answers finance-ness (`canFinance`),
    // so the gated groups below cost no second authz round-trip — this path
    // fires on every facet click and every keystroke.
    const access = await requireOwnerAccess({
      repos: deps.repos,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ANY_ROLE,
      errorCode: "INSUFFICIENT_ROLE",
    });

    // Which groups the caller asked for. Absent `types` = all of them (today's
    // behaviour). A filtered-out group's repo query never fires.
    const requestedGroups = new Set<SearchOrgAdminGroup>(
      input.types ?? ALL_SEARCH_GROUPS,
    );
    const wantEvents = requestedGroups.has("event");
    const wantVenues = requestedGroups.has("venue");
    const wantAttendees = requestedGroups.has("attendee");

    // FR-012. Only an id-shaped query can produce an order row; a text query
    // must not issue an order query at all.
    const orderIdentifier = requestedGroups.has("order")
      ? parseOrderIdentifier(query)
      : null;
    const wantOrder = orderIdentifier !== null;

    // Attendees and the order lookup are finance-gated, and a caller who lacks
    // finance access has those groups OMITTED — never an error (NFR-002: no
    // existence oracle, no "you lack permission" copy).
    //
    // This is read off the membership row `requireOwnerAccess` already fetched
    // rather than re-probed via `deps.authz.canFinanceOrg`, which would issue a
    // second `getOrgMembership` for the identical row. The DECISION is
    // unchanged — see the equivalence note on `OwnerAccessResult` in
    // `lib/rbac.ts`. For a HUMAN owner the actor is already proven to BE the
    // owner, which is why `canFinance` is `true` there (matching the explicit
    // `ownerType === "HUMAN" ? true` short-circuit this replaces).
    const financeAllowed = access.canFinance;

    const attendeesAllowed = wantAttendees && financeAllowed;
    const orderLookupAllowed = wantOrder && financeAllowed;

    const [eventsResult, venuesResult, attendeesResult, orderRow] =
      await Promise.all([
        wantEvents
          ? callOrDependencyFailed(
              async () => {
                const result = await deps.repos.events.listByOwner({
                  ownerType: input.ownerType,
                  ownerId: input.ownerId,
                  // Facets are events-only and forwarded verbatim; absent keys
                  // stay absent so the repo sees exactly today's input shape.
                  status: input.statuses ?? ALL_EVENT_STATUSES,
                  query,
                  limit: input.limit,
                  ...(input.dateRange ? { dateRange: input.dateRange } : {}),
                  ...(input.categoryIds
                    ? { categoryIds: input.categoryIds }
                    : {}),
                  // Only forwarded when true: `false` and absent mean the same
                  // thing to the repo, so sending `false` would be noise.
                  ...(input.includeUncategorised
                    ? { includeUncategorised: true }
                    : {}),
                });
                // `pageInfo.total` is the count the repo already runs beside
                // its findMany — the page length would saturate at `limit`.
                return { items: result.items, total: result.pageInfo.total };
              },
              scopedLogger,
              { action: "repos.events.listByOwner", ownerId: input.ownerId },
            )
          : Promise.resolve<{ items: EventItems; total: number }>({
              items: [],
              total: 0,
            }),
        wantVenues
          ? callOrDependencyFailed(
              async () => {
                const result = await deps.repos.places.listAccessibleByHuman({
                  humanId: input.actorHumanId,
                  orgIds:
                    input.ownerType === "ORGANIZATION"
                      ? [input.ownerId]
                      : undefined,
                  // The repo matches the street of EXACT venues only, so any
                  // role clearing the bar above cannot probe a withheld
                  // venue's street by watching what comes back.
                  query: query || undefined,
                  ownedOnly: true,
                  includeOwnedUnverified: true,
                  limit: input.limit,
                });
                return { items: result.items, total: result.pageInfo.total };
              },
              scopedLogger,
              {
                action: "repos.places.listAccessibleByHuman",
                ownerId: input.ownerId,
              },
            )
          : Promise.resolve<{ items: VenueItems; total: number }>({
              items: [],
              total: 0,
            }),
        attendeesAllowed
          ? callOrDependencyFailed(
              () =>
                loadAttendees(deps.repos, {
                  ownerType: input.ownerType,
                  ownerId: input.ownerId,
                  searchQuery: query || undefined,
                  limit: input.limit,
                }),
              scopedLogger,
              { action: "repos.orders.listForOwner", ownerId: input.ownerId },
            )
          : Promise.resolve<{
              attendees: SearchOrgAdminOutput["attendees"];
              total: number;
            }>({ attendees: [], total: 0 }),
        orderLookupAllowed && orderIdentifier
          ? callOrDependencyFailed(
              () =>
                // Owner scope travels WITH the identifier into a single
                // where-clause: a foreign org's id and a nonexistent id are
                // the same `null` from the same code path (NFR-002).
                deps.repos.orders.findForOwner({
                  ownerType: input.ownerType,
                  ownerId: input.ownerId,
                  ...orderIdentifier,
                }),
              scopedLogger,
              { action: "repos.orders.findForOwner", ownerId: input.ownerId },
            )
          : Promise.resolve(null),
      ]);

    const events = eventsResult.items.map((event) => ({
      id: event.id,
      title: event.title,
      status: event.status,
      startsAt: event.startsAt,
      slug: event.slug,
    }));

    // A venue that withholds its address shows it only to a viewer who
    // passes `canManagePlace` (D5). An org SCANNER / VIEWER / FINANCE member
    // clears `requireOwnerAccess` above (any role) — that bar admits them to
    // the search, not to where the house is.
    const unlockedVenueIds =
      venuesResult.items.length > 0
        ? await callOrDependencyFailed(
            () =>
              resolvePlaceAddressUnlocks(
                { repos: deps.repos, authz: deps.authz },
                input.actorHumanId,
                venuesResult.items,
              ),
            scopedLogger,
            { action: "authz.canManagePlace", ownerId: input.ownerId },
          )
        : new Set<string>();

    const venues = venuesResult.items.map((place) => {
      const location = redactPlaceLocation(place, {
        viewerCanSeeExact: unlockedVenueIds.has(place.id),
      });
      return {
        id: place.id,
        name: place.name,
        address: location.isExact
          ? location.formattedAddress
          : location.areaLabel,
      };
    });

    const attendees = attendeesResult.attendees;

    return searchOrgAdminOutputSchema.parse({
      events,
      attendees,
      venues,
      order: orderRow
        ? {
            id: orderRow.id,
            status: orderRow.status,
            buyerName: orderRow.buyerName,
            buyerEmail: orderRow.buyerEmail,
            eventTitle: orderRow.eventTitle,
            amountGrossCents: orderRow.amountGrossCents,
            currency: orderRow.currency,
            occurredAt: orderRow.occurredAt,
          }
        : null,
      counts: {
        events: { shown: events.length, total: eventsResult.total },
        attendees: { shown: attendees.length, total: attendeesResult.total },
        venues: { shown: venues.length, total: venuesResult.total },
      },
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("searchOrgAdmin", execute);
  }

  return execute();
}
