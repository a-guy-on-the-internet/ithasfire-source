/**
 * spotlight-admin-facets — the PURE admin facet model (FR-004 / FR-011).
 *
 * Extracted out of `SpotlightAdminFacets.tsx` when Phase B gave the model a
 * second consumer: `/admin/[slug]/search` needs the state shape, the
 * facet → tRPC-input mapping and the URL param names, but not the 640px
 * overlay's expander component (nor its `"use client"` boundary, its `trpc`
 * import, or its React dependency). A page importing a client component just
 * to reach `buildAdminFacetInput` would drag all of that behind it.
 *
 * Nothing here renders or touches React — every export is a plain value or a
 * pure function, which is what makes the mapping unit-testable without a DOM.
 *
 * `SpotlightAdminFacets.tsx` re-exports this module verbatim, so the Phase A
 * import path keeps working.
 *
 * Empty arrays are never emitted: `searchOrgAdminInputSchema` marks every array
 * facet `.nonempty()`, so "no facet" means the key is ABSENT, not `[]`.
 */

// ── Facet model ──────────────────────────────────────────────────────────────

/** The three result groups the entity pills select between. */
export const ADMIN_GROUPS = ["event", "attendee", "venue"] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number];

/**
 * Render order for the result sections, including FR-012's order row.
 *
 * `order` is deliberately NOT in {@link ADMIN_GROUPS}: it is not a pill and not
 * a `types[]` value the user can pin to — it is a group of at most one row the
 * backend resolves when the query is id-shaped. Someone who pasted an order id
 * wants that answer first, so it leads.
 */
export const ADMIN_RESULT_GROUPS = [
  "order",
  "event",
  "attendee",
  "venue",
] as const;
export type AdminResultGroup = (typeof ADMIN_RESULT_GROUPS)[number];

/** Event statuses the status facet can select. `ALL` = send no `statuses` key. */
export const ADMIN_STATUS_FACETS = [
  "ALL",
  "DRAFT",
  "PUBLISHED",
  "COMPLETED",
  "CANCELLED",
  "ARCHIVED",
] as const;
export type AdminStatusFacet = (typeof ADMIN_STATUS_FACETS)[number];

/** A concrete `EventStatus` — every status facet except the `ALL` sentinel. */
export type AdminEventStatus = Exclude<AdminStatusFacet, "ALL">;

export const ADMIN_DATE_FACETS = ["ANY", "UPCOMING", "PAST", "CUSTOM"] as const;
export type AdminDateFacet = (typeof ADMIN_DATE_FACETS)[number];

export type AdminFacetState = {
  status: AdminStatusFacet;
  date: AdminDateFacet;
  /**
   * `Date.now()` FROZEN at the moment a relative date facet was picked.
   * Recomputing `now` per render would re-key the tRPC query on every tick and
   * refetch in a loop.
   */
  dateAnchorMs: number | null;
  /** `yyyy-mm-dd` from the native date inputs (CUSTOM only). */
  customFrom: string;
  customTo: string;
  categoryId: string | null;
  /**
   * "Uncategorised" — a PEER of the categories in the same facet, not a
   * separate control, and deliberately NOT a `categoryId` sentinel.
   *
   * `Event.categoryId` is nullable and SQL `IN` never matches NULL, so an
   * uncategorised event is unreachable through `categoryId` no matter what
   * value is put there. It also COMPOSES: "Music" plus this is "Music or
   * uncategorised", and this alone is "only uncategorised".
   */
  includeUncategorised: boolean;
};

export const EMPTY_ADMIN_FACETS: AdminFacetState = {
  status: "ALL",
  date: "ANY",
  dateAnchorMs: null,
  customFrom: "",
  customTo: "",
  categoryId: null,
  includeUncategorised: false,
};

/** The facet slice of `search.adminOrgSearch`'s input. Absent key = no filter. */
export type AdminFacetInput = {
  statuses?: [AdminEventStatus, ...AdminEventStatus[]];
  dateRange?: { from?: Date; to?: Date };
  categoryIds?: [string, ...string[]];
  /** Only ever `true`. `false` is indistinguishable from absent server-side. */
  includeUncategorised?: true;
};

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `yyyy-mm-dd` → local midnight. Returns null for an empty/partial input. */
export function localStartOfDay(value: string): Date | null {
  const parts = ISO_DATE.exec(value);
  if (!parts) return null;
  return new Date(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    0,
    0,
    0,
    0,
  );
}

/**
 * `yyyy-mm-dd` → local end of day. The backend bound is INCLUSIVE on
 * `startsAt`, and a user picking "to: the 10th" means "through the 10th" — a
 * midnight bound would silently drop every event that day.
 */
export function localEndOfDay(value: string): Date | null {
  const parts = ISO_DATE.exec(value);
  if (!parts) return null;
  return new Date(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    23,
    59,
    59,
    999,
  );
}

/** A `Date` → the `yyyy-mm-dd` its LOCAL calendar day is, for a date input. */
export function toLocalDateInputValue(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * True when `date` is the EARLIEST INSTANT THAT EXISTS on its local day — i.e.
 * exactly what `localStartOfDay` would emit for that day.
 *
 * Deliberately not `getHours() === 0`. In zones whose DST transition lands at
 * midnight (America/Santiago, America/Havana, Asia/Beirut, Asia/Tehran) that
 * day has no 00:00 at all, so `new Date(y, m, d, 0, 0, 0, 0)` yields 01:00 —
 * and a literal hour check would call a custom range's own lower bound "not
 * midnight" one day a year. Round-tripping through the constructor asks the
 * right question: is this the start of its day, whenever that happens to be?
 */
export function isLocalStartOfDay(date: Date): boolean {
  const start = localStartOfDay(toLocalDateInputValue(date));
  return start?.getTime() === date.getTime();
}

/** True when `date` is the LATEST instant on its local day (see above). */
export function isLocalEndOfDay(date: Date): boolean {
  const end = localEndOfDay(toLocalDateInputValue(date));
  return end?.getTime() === date.getTime();
}

/** The `dateRange` filter this state implies, or undefined for "no filter". */
export function buildAdminDateRange(
  state: AdminFacetState,
): { from?: Date; to?: Date } | undefined {
  switch (state.date) {
    case "UPCOMING":
      return state.dateAnchorMs == null
        ? undefined
        : { from: new Date(state.dateAnchorMs) };
    case "PAST":
      return state.dateAnchorMs == null
        ? undefined
        : { to: new Date(state.dateAnchorMs) };
    case "CUSTOM": {
      const from = localStartOfDay(state.customFrom);
      const to = localEndOfDay(state.customTo);
      // "Custom" with both fields blank is a mode, not a filter.
      if (!from && !to) return undefined;
      return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    }
    default:
      return undefined;
  }
}

/**
 * Facet state → the tRPC input slice. Only keys that carry a real filter are
 * emitted, so `{}` means "today's unfiltered behaviour".
 */
export function buildAdminFacetInput(state: AdminFacetState): AdminFacetInput {
  const input: AdminFacetInput = {};
  if (state.status !== "ALL") input.statuses = [state.status];
  const dateRange = buildAdminDateRange(state);
  if (dateRange) input.dateRange = dateRange;
  if (state.categoryId) input.categoryIds = [state.categoryId];
  // Emitted only when true — `false` is the absent case, and sending it would
  // re-key the tRPC query for a filter that does nothing.
  if (state.includeUncategorised) input.includeUncategorised = true;
  return input;
}

/**
 * True when at least one facet resolves to a real server-side filter.
 *
 * `includeUncategorised` counts on its own: alone it means "ONLY uncategorised
 * events", which is a genuine filter, not a no-op. Missing it here would leave
 * the mobile `FILTERS (n)` badge — and the facet-only search intent that badge
 * describes — blind to it.
 */
export function hasActiveAdminFacets(state: AdminFacetState): boolean {
  const input = buildAdminFacetInput(state);
  return Boolean(
    input.statuses ??
      input.dateRange ??
      input.categoryIds ??
      input.includeUncategorised,
  );
}

/**
 * Carry the active facets onto the "View all" hand-off URL.
 *
 * These param NAMES (`status` / `date` / `from` / `to` / `category` / `uncat`)
 * plus `type` are the contract between the overlay and `/admin/[slug]/search`; the
 * page's parser (`_lib/admin-search-url.ts`) reads exactly these, and a rename
 * here silently drops every deep-linked filter. Both surfaces write through
 * THIS function so the two can never desync.
 *
 * ## Why the MODE is serialised and not just inferred from the bounds
 *
 * `from`/`to` alone cannot express every date state. "Custom range" with both
 * fields still blank — which is exactly what the UI produces on the first
 * click of that pill — carries no bound at all, so a bounds-only URL reads
 * back as "Any date" and the mode collapses under the user on the next
 * commit. `date` is therefore written whenever the facet is not ANY, even when
 * it contributes no filter, because the MODE is user state in its own right.
 */
export function appendAdminFacetParams(
  params: URLSearchParams,
  state: AdminFacetState,
  activeGroup: AdminGroup | null,
): void {
  const input = buildAdminFacetInput(state);
  if (input.statuses) params.set("status", input.statuses[0]);
  if (state.date !== "ANY") params.set("date", state.date);
  if (input.dateRange?.from)
    params.set("from", input.dateRange.from.toISOString());
  if (input.dateRange?.to) params.set("to", input.dateRange.to.toISOString());
  if (input.categoryIds) params.set("category", input.categoryIds[0]);
  // Written ONLY when on, and only ever as "1" — so the parser's `=== "1"` test
  // makes `build ∘ parse` exact and the URL → state effect never re-writes.
  if (input.includeUncategorised) params.set("uncat", "1");
  if (activeGroup) params.set("type", activeGroup);
}

// ── Label keys ───────────────────────────────────────────────────────────────

export const ADMIN_STATUS_LABEL_KEY: Record<AdminStatusFacet, string> = {
  ALL: "spotlight.statusAll",
  DRAFT: "spotlight.statusDraft",
  PUBLISHED: "spotlight.statusPublished",
  COMPLETED: "spotlight.statusCompleted",
  CANCELLED: "spotlight.statusCancelled",
  ARCHIVED: "spotlight.statusArchived",
};

/**
 * The "no category" peer option in the category facet. One definition, read by
 * BOTH the ⌘K overlay and `/admin/[slug]/search`, so the option can never exist
 * on one surface and not the other.
 */
export const ADMIN_UNCATEGORISED_LABEL_KEY = "spotlight.categoryUncategorised";

export const ADMIN_DATE_LABEL_KEY: Record<AdminDateFacet, string> = {
  ANY: "spotlight.dateAny",
  UPCOMING: "spotlight.dateUpcoming",
  PAST: "spotlight.datePast",
  CUSTOM: "spotlight.dateCustom",
};

/**
 * Row-level status labels. Deliberately distinct from the facet labels:
 * the facet reads "Drafts" (a bucket), a single row reads "Draft" (this one).
 */
export const EVENT_STATUS_LABEL_KEY: Record<AdminEventStatus, string> = {
  DRAFT: "spotlight.eventStatusDraft",
  PUBLISHED: "spotlight.eventStatusPublished",
  COMPLETED: "spotlight.eventStatusCompleted",
  CANCELLED: "spotlight.eventStatusCancelled",
  ARCHIVED: "spotlight.eventStatusArchived",
};

/** Entity-pill / group-header labels for the three pill groups. */
export const ADMIN_GROUP_LABEL_KEY: Record<AdminGroup, string> = {
  event: "spotlight.adminTypeEvents",
  attendee: "spotlight.adminTypeAttendees",
  venue: "spotlight.adminTypeVenues",
};

/** Section headers, including FR-012's order group. */
export const ADMIN_RESULT_GROUP_LABEL_KEY: Record<AdminResultGroup, string> = {
  ...ADMIN_GROUP_LABEL_KEY,
  order: "spotlight.adminTypeOrder",
};

/**
 * Order status labels for the FR-012 row.
 *
 * Deliberately `spotlight.*` and not the `admin.status*` set the orders table
 * uses: that set has no `statusProcessing` entry in either catalog, so reusing
 * it would render the raw key `admin.statusProcessing` on a PROCESSING order.
 */
export const ORDER_STATUS_LABEL_KEY: Record<string, string> = {
  PENDING: "spotlight.orderStatusPending",
  PROCESSING: "spotlight.orderStatusProcessing",
  SUCCEEDED: "spotlight.orderStatusSucceeded",
  PART_REFUNDED: "spotlight.orderStatusPartRefunded",
  REFUNDED: "spotlight.orderStatusRefunded",
  DISPUTED: "spotlight.orderStatusDisputed",
  CANCELLED: "spotlight.orderStatusCancelled",
};

/**
 * The status an order row does NOT annotate — a paid order is the happy path
 * and printing "Succeeded" on every row is noise. Mirrors the event row, which
 * only shows a status when it isn't PUBLISHED.
 */
export const ORDER_HAPPY_PATH_STATUS = "SUCCEEDED";
