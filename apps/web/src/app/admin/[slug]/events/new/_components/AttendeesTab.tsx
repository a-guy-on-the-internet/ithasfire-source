"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  OverflowTooltip,
  Text,
  Button,
  Badge,
  Spinner,
  useTranslations,
  useFormatters,
  useNotify,
} from "@th/ui";
import { ChevronDown, Download } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import {
  ActionBar,
  AdminTableErrorState,
  FilterChips,
  FilterRow,
  NoResults,
  Pagination,
  SearchBar,
  TableContainer,
} from "@/components/AdminTableParts";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import { usePageClamp } from "@/hooks/usePageClamp";
import { rowsToCsv, downloadCsv } from "@/lib/csv-export";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDate, fmtCurrency } from "@/lib/format";
import { AttendeeDetailPanel } from "../../[id]/attendees/_components/AttendeeDetailPanel";
import { EventOpsShell } from "../../[id]/_components/EventOpsShell";
import type { OrderSource, OrderStatus } from "@th/types";
import { formatOrderCode } from "@th/types/order-identifier";

interface AttendeeRow {
  orderId: string;
  buyerHumanId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  ticketCount: number;
  amountGrossCents: number;
  currency: string;
  status: OrderStatus;
  source: OrderSource;
  occurredAt: Date;
}

/**
 * Chip-able statuses, in the order they appear.
 *
 * Deliberately NOT the whole OrderStatus enum. Unfiltered, the use case scopes
 * to `SUCCEEDED + PART_REFUNDED` — the orders that represent someone actually
 * holding a ticket — so per the FilterChips convention there is no chip for
 * that default. These three are the money-exception scopes an organizer
 * reconciles after the show; PENDING and CANCELLED orders have no attendee
 * behind them and would just be enum noise here.
 */
const ATTENDEE_STATUS_FILTERS = [
  "REFUNDED",
  "PART_REFUNDED",
  "DISPUTED",
] as const satisfies readonly OrderStatus[];

function getStatusBadgeTone(
  status: OrderStatus,
): "info" | "success" | "warning" | "neutral" | "danger" {
  switch (status) {
    case "SUCCEEDED":
      return "success";
    case "PART_REFUNDED":
      return "warning";
    case "PENDING":
      return "info";
    case "REFUNDED":
    case "CANCELLED":
      return "danger";
    case "DISPUTED":
      return "warning";
    default:
      return "neutral";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cell fragments — shared by the table columns AND the mobile card so the two
// modes cannot drift into telling different stories about the same order.
//
// Every piece of per-field logic lives here exactly once: the em-dash
// fallbacks, the `formatOrderCode` derivation, the COMP marker that rides on
// the amount, the nowrap rules that keep money and timestamps from breaking
// mid-token. A hand-written second copy inside the card is precisely how a
// mobile view ends up quietly disagreeing with the desktop one.
// ─────────────────────────────────────────────────────────────────────────────

function AttendeeBuyerName({ row }: { row: AttendeeRow }) {
  return row.buyerName ? (
    <OverflowTooltip
      variant="body"
      style={{ fontWeight: 700 }}
      text={row.buyerName}
    />
  ) : (
    <Text variant="body" style={{ fontWeight: 700 }}>
      —
    </Text>
  );
}

/**
 * `compact` drops the email to caption/muted for the card, where it sits
 * directly under the name as secondary identification rather than owning its
 * own column. Only the TYPE SCALE differs — the value and its fallback stay
 * single-sourced.
 */
function AttendeeBuyerEmail({
  row,
  compact = false,
}: {
  row: AttendeeRow;
  compact?: boolean;
}) {
  if (!row.buyerEmail) {
    return (
      <Text variant={compact ? "caption" : "body"} tone="muted">
        —
      </Text>
    );
  }
  return compact ? (
    <OverflowTooltip variant="caption" tone="muted" text={row.buyerEmail} />
  ) : (
    <OverflowTooltip variant="body" text={row.buyerEmail} />
  );
}

function AttendeeOrderCode({ row }: { row: AttendeeRow }) {
  // Montserrat-only product: no mono override. Tabular numerals keep the
  // codes column-aligned.
  //
  // `formatOrderCode` — the 8-hex TAIL, uppercased — is the ONE order code.
  // This rendered `slice(0, 8)` (the HEAD), which is also 8 hex chars: it
  // satisfies admin search's identifier shape and then resolves to nothing, so
  // an admin reading a code off this column searched for it and got an empty
  // list. Bare (no `#`) because the "Order code" column header labels it.
  return (
    <Text
      variant="caption"
      tone="muted"
      style={{
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
        // Tamagui Text base pre-wrap re-enables mid-token wrapping at narrow
        // widths (live-measured "000000"/"00" at 900px); IDs never break.
        whiteSpace: "nowrap",
      }}
    >
      {formatOrderCode(row.orderId)}
    </Text>
  );
}

/**
 * The table column renders the bare number beneath a "Tickets" header; the
 * card has no header, so `labelled` pluralises the unit into the value. One
 * component either way.
 */
function AttendeeTicketCount({
  row,
  labelled = false,
}: {
  row: AttendeeRow;
  labelled?: boolean;
}) {
  const t = useTranslations();
  if (labelled) {
    return (
      <Text
        variant="caption"
        tone="muted"
        style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
      >
        {String(
          t("admin.attendeeTicketCountLabel", { count: row.ticketCount }),
        )}
      </Text>
    );
  }
  return (
    <Text variant="body" textAlign="center">
      {row.ticketCount}
    </Text>
  );
}

/**
 * A comp is a $0 order, so this read "$0.00" for both a complimentary ticket
 * and a genuinely free one. The marker goes here rather than in its own column
 * because the ambiguity IS the amount — and it costs no horizontal space on
 * the ~99% of rows that are sales.
 */
function AttendeeAmount({ row }: { row: AttendeeRow }) {
  const t = useTranslations();
  const fmt = useFormatters();
  return (
    <XStack
      justifyContent="flex-end"
      alignItems="center"
      gap="$2"
      flexWrap="nowrap"
    >
      {row.source === "COMP" ? (
        <Badge tone="info" size="sm">
          {String(t("admin.attendeeCompBadge"))}
        </Badge>
      ) : null}
      <Text
        variant="body"
        textAlign="right"
        // nowrap on the Text itself: money never breaks mid-number
        // (live-measured "$360." / "00" at 900px without it).
        style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
      >
        {fmtCurrency(fmt, row.amountGrossCents, row.currency)}
      </Text>
    </XStack>
  );
}

function AttendeeStatusBadge({ row }: { row: AttendeeRow }) {
  return (
    <Badge tone={getStatusBadgeTone(row.status)} size="sm">
      {row.status.replaceAll("_", " ")}
    </Badge>
  );
}

function AttendeeDate({ row }: { row: AttendeeRow }) {
  const fmt = useFormatters();
  return (
    // nowrap on the Text itself: the column's `noWrap` only styles the
    // <td>/wrapper, and Tamagui's web Text base sets `white-space: pre-wrap`
    // on the element, overriding the td and re-enabling the wrap.
    <Text variant="caption" tone="muted" style={{ whiteSpace: "nowrap" }}>
      {fmtDate(fmt, row.occurredAt)}
    </Text>
  );
}

/**
 * The `{name}` half of the expander's accessible name.
 *
 * Four expanders all reading "Expand details" is ambiguous for screen-reader
 * and voice users — there is no way to say which one you mean. `buyerName` and
 * `buyerEmail` are BOTH nullable (and either can be whitespace), so the chain
 * is name → email → a generic "this attendee", which is what keeps a degenerate
 * row from producing "…for null".
 *
 * The order code is NOT part of this chain: the ICU message appends `{code}`
 * unconditionally, so every label carries it regardless of which branch fires.
 *
 * NOT a hook: it is called from `rowActions.render`, once per row inside
 * DataTable's map, where the hook count would vary with the row count.
 */
function attendeeRowLabel(
  row: AttendeeRow,
  t: ReturnType<typeof useTranslations>,
): string {
  const named = row.buyerName?.trim() || row.buyerEmail?.trim() || "";
  return named || String(t("admin.attendeeUnnamedBuyer"));
}

/**
 * Card rendering below 600px, via DataTable's `renderMobileCard` (which flips
 * on the shared, SSR-safe `useIsBelowMobileBreakpoint` — the same mechanism
 * CompTicketsTab uses, not a bespoke hook and not a JS media query here).
 *
 * The attendee table is eight columns wide and `table-layout: fixed;
 * width: 100%`, so on a phone it never overflows and therefore never scrolls —
 * it just crushes. Live-measured at 320px: a `td` content box of 2px against a
 * 119px buyer name, the date column clipped away entirely, and a probe for any
 * `overflow-x: auto|scroll` box with `scrollWidth > clientWidth` returning
 * nothing at all. The data was not merely ugly, it was unreachable. Card mode
 * is the fix and it carries every column's information.
 *
 * The chevron is `aria-hidden`: DataTableCardList already makes the whole card
 * the pressable (`role="button"` + `aria-expanded`), so a real button here
 * would put a second, identically-named control on every row — the exact
 * defect the desktop expander's row-context label exists to remove.
 *
 * `expandable` false (a viewer without finance rights) drops the chevron: the
 * card is then not pressable at all, so a chevron would promise an expand
 * that does not exist.
 */
function AttendeeMobileCard({
  row,
  isExpanded,
  expandable,
}: {
  row: AttendeeRow;
  isExpanded: boolean;
  expandable: boolean;
}) {
  return (
    <YStack gap="$2" minWidth={0}>
      <XStack gap="$2" alignItems="flex-start" minWidth={0}>
        <YStack flex={1} minWidth={0} gap={2}>
          <AttendeeBuyerName row={row} />
          <AttendeeBuyerEmail row={row} compact />
        </YStack>
        {expandable ? (
          <ChevronDown
            size={16}
            aria-hidden
            style={{
              flexShrink: 0,
              marginTop: 2,
              transform: isExpanded ? "rotate(180deg)" : undefined,
              transition: "transform 0.15s ease",
            }}
          />
        ) : null}
      </XStack>

      {/* Two aligned columns per row, NOT a "·"-separated run, and the pairs
          are chosen against a MEASURED width rather than an estimated one.
          The card's content column is 174px at a 320px viewport (live-measured
          — card 198px, less 12px padding a side; the page chrome outside it is
          fixed by EventOpsShell/ContentArea and is not ours to reclaim).
          A "·"-separated run wrapped mid-run at a DIFFERENT point per row
          ($55.00 stayed up, $110.00 did not) and orphaned a leading "·" onto
          its own line. Status+quantity (~154px) and amount+reference (~148px)
          both clear 174px; a comp adds its badge to the money line and wraps
          gracefully on the ~1% of rows that have one. */}
      <XStack
        gap="$2"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        minWidth={0}
      >
        <AttendeeStatusBadge row={row} />
        <AttendeeTicketCount row={row} labelled />
      </XStack>

      <XStack
        gap="$2"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        minWidth={0}
      >
        <AttendeeAmount row={row} />
        <AttendeeOrderCode row={row} />
      </XStack>

      {/* Last and alone: the full timestamp is the widest value on the card
          (~132px) and pairs with nothing at this width. */}
      <AttendeeDate row={row} />
    </YStack>
  );
}

export type AttendeesTabProps = {
  slug: string;
  eventId: string;
};

/**
 * The attendees ops surface. Renders its own `EventOpsShell` — the docblock
 * that used to describe this as "embedded in the EventBuilder without
 * route-level chrome" is stale: the event-builder regroup moved every ops tab
 * onto its own route, and `attendees/page.tsx` is now the sole consumer.
 *
 * The shell lives here rather than in the page because the filter row it slots
 * is driven by this component's search / status state.
 */
export function AttendeesTab({ slug, eventId }: AttendeesTabProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const { currentOwner, isLoading: ownerLoading } = useCurrentAdminOwner(slug);
  // Export is finance-only server-side; this only decides whether to offer the
  // button. The procedure is the real boundary. The row expand keys off it
  // too: the detail panel reads `orders.getOrgOrder`, which is
  // `canFinanceOrg` (OWNER / ADMIN / FINANCE), while this list admits EDITOR.
  const { canFinance } = useAdminOwnerCapabilities(currentOwner);

  const orgId = currentOwner?.kind === "org" ? currentOwner.orgId : undefined;
  // The row expand needs BOTH: finance rights for `getOrgOrder`, and an org
  // to ask it about. A personal workspace has `canFinance` true but no org,
  // which would give an expander over an empty panel. (The org-only early
  // return below also stops that case today; this keeps the expander honest
  // if that return ever moves.)
  const canExpand = canFinance && Boolean(orgId);

  // URL-synced search + pagination (?q= / ?p= / ?ps=), 300ms debounce.
  // `status` rides along as an extra key (?status=) so a "show me the disputed
  // orders" view is a shareable link, and changing it resets to page 0.
  const {
    searchQuery,
    debouncedSearch,
    page,
    pageSize,
    extra,
    handleSearchChange,
    setPage,
    setPageSize,
    setExtra,
  } = useAdminTableParams({ extraKeys: ["status"] });

  // Only a value the server will accept survives — a hand-edited
  // `?status=nonsense` is dropped rather than 400ing the query into an error
  // card the user can't clear.
  const statusFilter = ATTENDEE_STATUS_FILTERS.find(
    (candidate) => candidate === extra.status,
  );

  const handleStatusSelect = useCallback(
    (next: OrderStatus | undefined) => {
      setExtra("status", next);
    },
    [setExtra],
  );
  const [expandedOrderIds, setExpandedOrderIds] = useState<Set<string>>(
    new Set(),
  );

  const toggleExpandAttendee = useCallback((orderId: string) => {
    setExpandedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }, []);

  const attendeesQuery = trpc.orders.searchEventAttendees.useQuery(
    {
      orgId: orgId ?? "",
      eventId,
      query: debouncedSearch,
      ...(statusFilter ? { status: statusFilter } : {}),
      limit: pageSize,
      offset: page * pageSize,
    },
    {
      enabled: !!orgId,
      staleTime: 15_000,
      placeholderData: keepPreviousData,
    },
  );

  const attendeeRows: AttendeeRow[] = useMemo(() => {
    const items = attendeesQuery.data?.items;
    if (!items?.length) return [];
    return items.map((item) => ({
      ...item,
      occurredAt: new Date(item.occurredAt),
    }));
  }, [attendeesQuery.data?.items]);

  // Computed above the early returns: usePageClamp is a hook and must run
  // unconditionally.
  const totalAttendees = attendeesQuery.data?.pageInfo?.total ?? 0;
  const totalPages = Math.ceil(totalAttendees / pageSize);

  // Stale/shared URLs (?p=3 against a shrunken dataset) snap back to the
  // last real page once the query settles, instead of stranding an empty
  // "no attendees" state with the pager hidden.
  usePageClamp({
    page,
    totalPages,
    isFetching: attendeesQuery.isFetching,
    setPage,
  });

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // ── CSV export ────────────────────────────────────────────────────────
  // Finance-gated server-side (one tier narrower than this table's own read)
  // and audit-logged. Fetched on demand rather than as a live query — an
  // export is an action, and pre-fetching one would write an audit entry
  // every time the page rendered.
  const [isExporting, setIsExporting] = useState(false);

  const handleExportCsv = useCallback(async () => {
    if (!orgId) return;
    setIsExporting(true);
    try {
      const result = await utils.orders.exportEventAttendees.fetch({
        orgId,
        eventId,
        query: debouncedSearch,
        ...(statusFilter ? { status: statusFilter } : {}),
      });

      const csv = rowsToCsv(result.rows, [
        { header: String(t("admin.nameColumn")), value: (r) => r.buyerName },
        { header: String(t("admin.emailColumn")), value: (r) => r.buyerEmail },
        { header: String(t("admin.orderId")), value: (r) => r.orderId },
        { header: String(t("admin.ticketCount")), value: (r) => r.ticketCount },
        {
          header: String(t("admin.amountColumn")),
          // Raw major units, not the localised display string — a CSV is read
          // by a spreadsheet, and "$1,234.00" would land as text.
          value: (r) => (r.amountGrossCents / 100).toFixed(2),
        },
        { header: "Currency", value: (r) => r.currency.toUpperCase() },
        { header: String(t("admin.statusColumn")), value: (r) => r.status },
        { header: "Source", value: (r) => r.source },
        {
          header: String(t("admin.dateColumn")),
          value: (r) => new Date(r.occurredAt).toISOString(),
        },
      ]);

      downloadCsv(
        csv,
        `attendees-${eventId}-${new Date().toISOString().slice(0, 10)}.csv`,
      );

      // The server caps one export; say so rather than letting a short file
      // pass for the whole list.
      if (result.truncated) {
        toast.warning({
          id: "attendees-export-truncated",
          title: String(t("admin.attendeesExportTruncatedTitle")),
          message: String(
            t("admin.attendeesExportTruncatedBody", {
              count: result.rows.length,
              total: result.total,
            }),
          ),
        });
      }
    } catch (err) {
      toast.danger({
        id: "attendees-export-failed",
        title: String(t("admin.attendeesExportFailed")),
        message: formatErrorMessage(err),
      });
    } finally {
      setIsExporting(false);
    }
  }, [orgId, eventId, debouncedSearch, statusFilter, utils, t, toast]);

  // One clear path, not two. FilterRow's "clear filters" and the empty state's
  // recovery button both point here — a query-only clear would leave a status
  // chip active and the table still looking empty, which reads as a broken
  // button. Keyboard users stay in the search field afterwards.
  const handleClearAll = useCallback(() => {
    handleSearchChange("");
    setExtra("status", undefined);
    searchInputRef.current?.focus();
  }, [handleSearchChange, setExtra]);

  const columns: DataTableColumn<AttendeeRow>[] = useMemo(
    () => [
      // Name + email cells use OverflowTooltip INSTEAD of the column-level
      // `tooltipValue`. tooltipValue wraps the cell in the DS Tooltip, whose
      // TooltipRoot/TooltipAnchorFrame are `display: inline-flex` — they
      // shrink-wrap to the nowrap text's min-content (the FULL string), so
      // the cell's `width: 100%` chain to the fixed-layout <td> breaks and
      // text-overflow has nothing to overflow (live-measured: scrollWidth ===
      // clientWidth, hard clip at the td edge, no "…"). OverflowTooltip owns
      // its own `display: block; width: 100%; min-width: 0` container +
      // clipped Text, so the width chain from the <td> stays intact, the
      // ellipsis genuinely engages, and the tooltip appears only when the
      // value is actually clipped. Same component AttendeeDetailPanel already
      // uses for these very fields.
      {
        id: "buyerName",
        header: String(t("admin.nameColumn")),
        width: 2,
        sortValue: (row) => row.buyerName,
        searchValue: (row) => row.buyerName ?? "",
        cell: (row) => <AttendeeBuyerName row={row} />,
      },
      {
        // 2.8/0.9 split with orderId (was 2.5/1.2): live-measured at 1440 the
        // email needed ~250px to render un-ellipsized while the 8-char order
        // id held ~152px for ~75px of content — reallocate the slack.
        id: "buyerEmail",
        header: String(t("admin.emailColumn")),
        width: 2.8,
        sortValue: (row) => row.buyerEmail,
        searchValue: (row) => row.buyerEmail ?? "",
        cell: (row) => <AttendeeBuyerEmail row={row} />,
      },
      {
        id: "orderId",
        // "Order code", NOT "Order ID": this column renders the 8-hex
        // `formatOrderCode` value, while the detail panel that expands right
        // beneath it renders the raw UUID under "Order ID". Sharing one label
        // put two different strings for one order on the same screen.
        header: String(t("admin.orderCode")),
        width: 0.9,
        noWrap: true,
        tooltipValue: (row) => row.orderId,
        cell: (row) => <AttendeeOrderCode row={row} />,
      },
      {
        id: "ticketCount",
        header: String(t("admin.ticketCount")),
        width: 0.8,
        align: "center",
        sortValue: (row) => row.ticketCount,
        cell: (row) => <AttendeeTicketCount row={row} />,
      },
      {
        id: "amountGrossCents",
        header: String(t("admin.amountColumn")),
        width: 1.2,
        align: "right",
        noWrap: true,
        sortValue: (row) => row.amountGrossCents,
        cell: (row) => <AttendeeAmount row={row} />,
      },
      {
        id: "status",
        header: String(t("admin.statusColumn")),
        // Mirrors OrdersTable's status column: badges must never ellipsize
        // ("SUCC…"), and 1.5 gives the longest label (PART REFUNDED) room at
        // the sm badge's 12px/+0.8 tracking.
        width: 1.5,
        noWrap: true,
        truncate: false,
        cell: (row) => <AttendeeStatusBadge row={row} />,
      },
      {
        id: "occurredAt",
        header: String(t("admin.dateColumn")),
        // 1.8 (was 1.5): the full "Jul 28, 2026, 10:18 PM" timestamp measured
        // ~113px — exactly the old column's content box at 1440, so the last
        // token wrapped ("… 10:18" / "PM") and drove a 66px row.
        width: 1.8,
        noWrap: true,
        sortValue: (row) => row.occurredAt,
        cell: (row) => <AttendeeDate row={row} />,
      },
    ],
    // Only the HEADERS read `t` now — every cell body lives in a fragment
    // component with its own `useTranslations` / `useFormatters`, so the card
    // and the column render the identical thing by construction.
    [t],
  );

  const rowActions = useMemo(
    () => ({
      header: "",
      width: 0.5,
      render: (row: AttendeeRow) => {
        const isExpanded = expandedOrderIds.has(row.orderId);
        // Row context, not a bare "Expand details". Live-measured before this
        // change: a probe over every button's accessible name returned
        // [["Expand details", 4]] — four controls, one name, no way for a
        // screen-reader or voice user to say which one they mean.
        //
        // The order code rides along unconditionally because two orders from
        // the SAME buyer are ordinary. It is the 8-hex TAIL of the order id,
        // which `@th/types/order-identifier` documents as NOT unique by
        // construction (32 bits) — so this is a very strong disambiguator on a
        // 25-row page, not a proof of uniqueness.
        const name = attendeeRowLabel(row, t);
        const code = formatOrderCode(row.orderId);
        return (
          <XStack justifyContent="flex-end">
            <Button
              variant={isExpanded ? "primary" : "ghost"}
              size="$1"
              icon
              onPress={() => toggleExpandAttendee(row.orderId)}
              aria-label={String(
                isExpanded
                  ? t("admin.attendeeCollapseDetailsFor", { name, code })
                  : t("admin.attendeeExpandDetailsFor", { name, code }),
              )}
            >
              <ChevronDown
                size={14}
                style={{
                  transform: isExpanded ? "rotate(180deg)" : undefined,
                  transition: "transform 0.15s ease",
                }}
              />
            </Button>
          </XStack>
        );
      },
    }),
    [expandedOrderIds, toggleExpandAttendee, t],
  );

  if (ownerLoading) {
    return (
      <YStack
        padding="$6"
        alignItems="center"
        justifyContent="center"
        minHeight={240}
      >
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.loading"))}
        </Text>
      </YStack>
    );
  }

  if (!orgId) {
    return (
      <YStack padding="$6">
        <Text variant="body" tone="muted">
          {String(t("admin.attendeesOrgOnly"))}
        </Text>
      </YStack>
    );
  }

  const isSearching = debouncedSearch.length > 0;
  // Either narrowing means "you are looking at a subset" — the count label and
  // the empty state both key off this rather than the query alone.
  const isFiltered = isSearching || statusFilter !== undefined;

  const countLabel = attendeesQuery.isLoading
    ? String(t("admin.searching"))
    : isFiltered
      ? String(t("admin.nResults", { count: totalAttendees }))
      : String(t("admin.nAttendees", { count: totalAttendees }));

  return (
    <EventOpsShell
      title={String(t("pageActions.attendees"))}
      purpose={String(t("admin.opsAttendeesPurpose"))}
      actions={
        // Finance only, and hidden rather than disabled for everyone else —
        // the server enforces the same set, so showing EDITOR a button that
        // can only 403 would be a worse answer than not offering it. The
        // export itself is audit-logged; see `exportEventAttendees`.
        canFinance ? (
          <Button
            variant="secondary"
            size="$3"
            onPress={() => void handleExportCsv()}
            disabled={isExporting}
            testID="attendees-export-csv"
          >
            {isExporting ? <Spinner size="sm" /> : <Download size={16} />}
            {String(t("admin.attendeesExportCsv"))}
          </Button>
        ) : null
      }
      filters={
        /* SearchBar carries `flex: 1` to grow along its parent's MAIN axis —
           which is horizontal only inside a row. Bare in a column it grows
           VERTICALLY instead, centring a 44px input inside a half-page band
           (the "weird padding" this work started from). FilterRow is the row
           wrapper every other admin table uses, and it owns the clear
           affordance so the field itself does not need one. */
        <FilterRow
          hasActiveFilters={
            searchQuery.length > 0 || statusFilter !== undefined
          }
          onClearAll={handleClearAll}
        >
          <SearchBar
            value={searchQuery}
            onChangeText={handleSearchChange}
            placeholder={String(t("admin.searchAttendeesPlaceholder"))}
            testId="attendee-search-input"
            inputRef={searchInputRef}
            // Server caps the query at z.string().max(200) — truncate at the
            // input instead of letting an oversized paste 400 into an error
            // card.
            maxLength={200}
          />
          {/* The use case has always accepted a `status` input; nothing ever
              sent one, so isolating the refunded or disputed orders after a
              show meant scanning pages by eye. */}
          <FilterChips<OrderStatus>
            options={ATTENDEE_STATUS_FILTERS.map((value) => ({
              value,
              label: value.replaceAll("_", " "),
            }))}
            selected={statusFilter}
            onSelect={handleStatusSelect}
          />
        </FilterRow>
      }
    >
      {attendeesQuery.isError ? (
        <AdminTableErrorState
          message={formatErrorMessage(attendeesQuery.error)}
          onRetry={() => {
            void attendeesQuery.refetch();
          }}
          testId="attendees-table-error"
        />
      ) : (
        <YStack flex={1} minHeight={0}>
          <ActionBar
            onRefresh={() => {
              void attendeesQuery.refetch();
            }}
            countLabel={countLabel}
          />

          {/* TableContainer owns scrolling (overflow auto) so a wide table
              pans instead of being clipped by the old overflow="hidden"
              wrapper. */}
          <TableContainer>
            <DataTable
              columns={columns}
              rows={attendeeRows}
              getRowKey={(row) => row.orderId}
              isLoading={attendeesQuery.isLoading}
              // The expand is finance-only — the panel's `getOrgOrder` is
              // `canFinanceOrg` server-side, so an EDITOR who expanded a row
              // got an error where the order should be. Withholding all three
              // props removes every affordance, not just the panel: no
              // expander column, no click/Enter/Space toggle on the row (the
              // table's key handler calls `onRowPress?.`), and on cards no
              // `role="button"` / `aria-expanded` (DataTableCardList derives
              // both from `onRowPress`).
              onRowPress={
                canExpand
                  ? (row) => toggleExpandAttendee(row.orderId)
                  : undefined
              }
              rowActions={canExpand ? rowActions : undefined}
              // Below 600px DataTable swaps the whole table for a card list
              // (and drops `rowActions` with it — the card IS the pressable,
              // so expand/collapse survives via `onRowPress` +
              // `renderExpandedRow` with `aria-expanded` on the card).
              renderMobileCard={(row) => (
                <AttendeeMobileCard
                  row={row}
                  isExpanded={expandedOrderIds.has(row.orderId)}
                  expandable={canExpand}
                />
              )}
              renderExpandedRow={
                canExpand
                  ? (row) =>
                      expandedOrderIds.has(row.orderId) && orgId ? (
                        <AttendeeDetailPanel
                          orderId={row.orderId}
                          orgId={orgId}
                        />
                      ) : null
                  : undefined
              }
              emptyState={
                <NoResults
                  title={
                    isFiltered
                      ? String(t("admin.noMatchingAttendees"))
                      : String(t("admin.noAttendeesYet"))
                  }
                  // A status-only filter has no query to quote back, so it
                  // gets the generic "adjust your filters" line instead of
                  // "no matches for ''".
                  description={
                    isSearching
                      ? String(
                          t("admin.noMatchesForQuery", {
                            query: debouncedSearch,
                          }),
                        )
                      : isFiltered
                        ? String(t("admin.noAttendeesForFilters"))
                        : String(t("admin.noAttendeesDescription"))
                  }
                  onClearFilters={isFiltered ? handleClearAll : undefined}
                />
              }
              clientSort
              testIdBase="attendees-table"
            />
          </TableContainer>

          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
            total={totalAttendees}
          />
        </YStack>
      )}
    </EventOpsShell>
  );
}
