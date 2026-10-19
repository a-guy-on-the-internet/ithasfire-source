import {
  bookingInboxTabOf,
  type BookingInboxTab,
  type BookingInboxTabInput,
} from "./booking-inbox-tabs";

// ─────────────────────────────────────────────────────────────────────────────
// `?request=<id>` — LANDING ON ONE ROW.
//
// The admin agreement page's "Back to booking" link and the event editor's
// "Open booking thread" link both point at the inbox with the request id in
// the query string. The inbox is a list of stage tabs with rows that expand
// inline, so "open this request" means three things at once: pick the tab the
// row is filed under (the same classifier the tabs read, so the row is
// guaranteed to be ON that tab), expand it, and bring it into view.
//
// PURE ON PURPOSE. The decision — which tab, which row, or nothing — is a
// function of the loaded list and the param, so it is testable without the
// inbox around it. `null` for a missing or unknown id: the caller does nothing
// (no toast, no error — the row may have been deleted, or belong to a venue
// this inbox does not show), and the URL is left alone.
//
// The query-string name is shared with `adminBookingHref`, which WRITES it.
// ─────────────────────────────────────────────────────────────────────────────

export const BOOKING_INBOX_REQUEST_PARAM = "request";

export type BookingInboxDeepLink = {
  id: string;
  tab: BookingInboxTab;
};

export function resolveBookingInboxDeepLink<
  T extends BookingInboxTabInput & { id: string },
>(rows: readonly T[], requestId: string | null | undefined): BookingInboxDeepLink | null {
  if (!requestId) return null;
  const row = rows.find((r) => r.id === requestId);
  if (!row) return null;
  return { id: row.id, tab: bookingInboxTabOf(row) };
}

/**
 * The DOM node for a row, in either DataTable mode: the table renders
 * `tr[data-row-key]`, the card list renders `{testIdBase}-row-{key}`.
 * Null when the row has not rendered yet (or the test double has no rows).
 */
export function findBookingInboxRowElement(
  root: ParentNode,
  testIdBase: string,
  id: string,
): Element | null {
  // jsdom has no `CSS.escape`; ids are uuids, so a quote-escape is enough.
  const key =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/["\\]/g, "\\$&");
  return (
    root.querySelector(`tr[data-row-key="${key}"]`) ??
    root.querySelector(`[data-testid="${testIdBase}-row-${key}"]`)
  );
}
