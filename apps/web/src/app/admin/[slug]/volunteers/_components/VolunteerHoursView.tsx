"use client";

import { useCallback, useMemo, type CSSProperties } from "react";
import { useParams } from "next/navigation";
import { YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Badge,
  Button,
  NextLinkAnchor,
  Text,
  useNotify,
  useTranslations,
  useFormatters,
} from "@th/ui";
import { Download } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  rowsToCsv,
  downloadCsv,
  type CsvColumnDef,
} from "@/lib/csv-export";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import {
  ActionBar,
  AdminTableErrorState,
  TableContainer,
  SearchBar,
  FilterRow,
  FilterChips,
  Pagination,
  NoResults,
} from "@/components/AdminTableParts";
import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";
import { dateInputToLocalDate, inclusiveEndToExclusive } from "./date-range";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface VolunteerHoursRow {
  volunteerKey: string;
  humanId: string | null;
  contactEmail: string;
  contactName: string | null;
  totalHours: number;
  eventsCount: number;
  signupsCount: number;
  lastShiftAt: Date;
}

// Native date inputs styled to match the strict-Swiss filter controls used
// on the per-event volunteers Signups tab (raw element + token-backed CSS
// vars, since Tamagui's TextInput ignores type="date" on web).
const DATE_INPUT_STYLE: CSSProperties = {
  minHeight: 44,
  padding: "8px 12px",
  fontSize: 16,
  borderRadius: 0,
  border: "1px solid var(--borderColor, #211C16)",
  background: "var(--surface, #FDFAF3)",
  color: "var(--color, #211C16)",
  // Lets the input shrink below the native date control's intrinsic width
  // on 320px phones, and fill the line when its label wraps above it.
  flex: "1 1 auto",
  minWidth: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// View
// ─────────────────────────────────────────────────────────────────────────────

export function VolunteerHoursView() {
  // Role-action sweep note: this org-summary surface has NO mutating affordances
  // — it is a read-only hours aggregate plus a client-side CSV export (a read
  // operation over already-loaded data, not a server mutation). Check-in and
  // other volunteer mutations live on each event's Signups page, not here, so
  // there is nothing to gate on this page. The read query
  // (volunteer.hours.orgSummary) admits any org member (ORG_ANY_ROLE), which is
  // why the nav offers this page to every role.
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const { slug } = useParams<{ slug: string }>();
  const {
    currentOwner,
    isLoading: isOwnerLoading,
    ownerEntities,
  } = useCurrentAdminOwner(slug);
  // `/admin` sends a person with no groups straight to their own dashboard,
  // so "Choose an account" is only a real choice when they have a group.
  const hasGroup = Boolean(
    ownerEntities.ownersWithSlugs?.some((o) => o.kind === "org"),
  );

  const orgId = currentOwner?.kind === "org" ? currentOwner.orgId : null;

  // ── Filters (URL-synced) ────────────────────────────────────────────────
  // All filter state rides the shared hook so refresh/back/share preserves
  // it: `from`/`to` hold the raw YYYY-MM-DD input values (a garbage URL
  // value fails dateInputToLocalDate's format check and never reaches the
  // query) and `accepted` is "1" when the accepted-only scope is on.
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
  } = useAdminTableParams({ extraKeys: ["from", "to", "accepted"] });

  const fromStr = extra.from ?? "";
  const toStr = extra.to ?? "";
  // Recognition/grant view: count only APPROVED | CHECKED_IN signups.
  // Default OFF — the all-statuses view is the one that reconciles with
  // per-event hours exports.
  const acceptedOnly = extra.accepted === "1";

  // setPage(0) batches the page reset into the same commit as the filter
  // change — the hook's own post-commit reset then no-ops instead of
  // costing a stale-offset fetch (mirrors PlacesTable's chip handlers).
  const handleFromChange = useCallback(
    (value: string) => {
      setExtra("from", value || undefined);
      setPage(0);
    },
    [setExtra, setPage],
  );
  const handleToChange = useCallback(
    (value: string) => {
      setExtra("to", value || undefined);
      setPage(0);
    },
    [setExtra, setPage],
  );

  const currentYearStart = `${new Date().getFullYear()}-01-01`;
  const isThisYearPreset = fromStr === currentYearStart && toStr === "";

  // Standard admin-table chip grammar (see PlacesTable): resting = no chip
  // = default scope. The date-range default is ALL TIME (both inputs
  // empty), so there is deliberately NO "All time" chip — it would sit
  // permanently selected at rest. Deselecting "This year" (or Clear
  // filters) falls back to it, which is exactly what the old "All time"
  // preset button did.
  const rangeChipOptions = useMemo(
    () => [
      {
        value: "thisYear" as const,
        label: String(t("admin.volunteerHoursPresetThisYear")),
      },
    ],
    [t],
  );

  const clearFilters = useCallback(() => {
    handleSearchChange("");
    setExtra("from", undefined);
    setExtra("to", undefined);
    setExtra("accepted", undefined);
    // Same-commit page reset (see the handlers above) — the hook's own
    // post-commit reset then no-ops.
    setPage(0);
  }, [handleSearchChange, setExtra, setPage]);

  // ── Query ───────────────────────────────────────────────────────────────

  const dateRange = useMemo(() => {
    const from = dateInputToLocalDate(fromStr);
    const pickedTo = dateInputToLocalDate(toStr);
    return {
      from: from ?? undefined,
      to: pickedTo ? inclusiveEndToExclusive(pickedTo) : undefined,
    };
  }, [fromStr, toStr]);

  const { data, isLoading, error, refetch } =
    trpc.volunteer.hours.orgSummary.useQuery(
      {
        orgId: orgId!,
        from: dateRange.from,
        to: dateRange.to,
        acceptedOnly,
      },
      {
        enabled: !!orgId,
        staleTime: 30_000,
        placeholderData: keepPreviousData,
      },
    );

  const allRows = useMemo<VolunteerHoursRow[]>(
    () =>
      (data?.rows ?? []).map((row) => ({
        volunteerKey: row.volunteerKey,
        humanId: row.humanId,
        contactEmail: row.contactEmail,
        contactName: row.contactName,
        totalHours: row.totalHours,
        eventsCount: row.eventsCount,
        signupsCount: row.signupsCount,
        lastShiftAt: new Date(row.lastShiftAt),
      })),
    [data],
  );

  // Client-side search over name + email (server has no query param).
  const filteredRows = useMemo(() => {
    if (!debouncedSearch) return allRows;
    const q = debouncedSearch.toLowerCase();
    return allRows.filter(
      (r) =>
        r.contactEmail.toLowerCase().includes(q) ||
        (r.contactName?.toLowerCase().includes(q) ?? false),
    );
  }, [allRows, debouncedSearch]);

  // Client-side pagination (server returns the full aggregate).
  const totalRows = filteredRows.length;
  const totalPages = Math.ceil(totalRows / pageSize);
  const rows = useMemo(
    () => filteredRows.slice(page * pageSize, (page + 1) * pageSize),
    [filteredRows, page, pageSize],
  );

  // ── CSV export ──────────────────────────────────────────────────────────
  // Exports the date-range + search-filtered set (all pages). Headers stay
  // literal English so org totals reconcile against the per-event hours CSV
  // (also unlocalized, serialised server-side).
  const handleExportCsv = useCallback(() => {
    try {
      const csvColumns: CsvColumnDef<VolunteerHoursRow>[] = [
        { header: "Name", value: (r) => r.contactName },
        { header: "Email", value: (r) => r.contactEmail },
        { header: "Guest", value: (r) => (r.humanId ? "no" : "yes") },
        { header: "Total Hours", value: (r) => r.totalHours },
        { header: "Events", value: (r) => r.eventsCount },
        { header: "Signups", value: (r) => r.signupsCount },
        { header: "Last Shift", value: (r) => r.lastShiftAt.toISOString() },
      ];
      const safeSlug =
        slug
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "org";
      const filename = `volunteer-hours-${safeSlug}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      downloadCsv(rowsToCsv(filteredRows, csvColumns), filename);
    } catch (err) {
      toast.danger({
        id: "volunteer-hours-export-failed",
        title: t("admin.volunteerHoursExportFailed") as string,
        message: formatErrorMessage(err),
      });
    }
  }, [filteredRows, slug, toast, t]);

  // ── Columns ─────────────────────────────────────────────────────────────

  const columns = useMemo<DataTableColumn<VolunteerHoursRow>[]>(
    () => [
      {
        id: "volunteer",
        header: String(t("admin.volunteerHoursVolunteerColumn")),
        width: 3,
        truncate: false,
        sortValue: (row) => row.contactName ?? row.contactEmail,
        cell: (row) => (
          <YStack gap="$1">
            <XStack gap="$2" alignItems="center">
              <Text
                variant="body"
                style={{
                  fontWeight: 700,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.contactName ?? row.contactEmail}
              </Text>
              {!row.humanId ? (
                <Badge tone="neutral" size="sm">
                  {String(t("admin.volunteerHoursGuestBadge"))}
                </Badge>
              ) : null}
            </XStack>
            {row.contactName ? (
              <Text variant="caption" tone="muted">
                {row.contactEmail}
              </Text>
            ) : null}
          </YStack>
        ),
      },
      {
        id: "totalHours",
        header: String(t("admin.volunteerHoursTotalHoursColumn")),
        width: 1.2,
        align: "right",
        noWrap: true,
        sortValue: (row) => row.totalHours,
        cell: (row) => (
          <Text variant="body" style={{ fontWeight: 700 }}>
            {fmt.number(row.totalHours, { maximumFractionDigits: 2 })}
          </Text>
        ),
      },
      {
        id: "eventsCount",
        header: String(t("admin.volunteerHoursEventsColumn")),
        width: 1,
        align: "right",
        noWrap: true,
        sortValue: (row) => row.eventsCount,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {fmt.number(row.eventsCount)}
          </Text>
        ),
      },
      {
        id: "signupsCount",
        header: String(t("admin.volunteerHoursSignupsColumn")),
        width: 1,
        align: "right",
        noWrap: true,
        sortValue: (row) => row.signupsCount,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {fmt.number(row.signupsCount)}
          </Text>
        ),
      },
      {
        id: "lastShiftAt",
        header: String(t("admin.volunteerHoursLastShiftColumn")),
        width: 1.5,
        noWrap: true,
        sortValue: (row) => row.lastShiftAt,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {fmt.dateTime(row.lastShiftAt)}
          </Text>
        ),
      },
    ],
    [t, fmt],
  );

  // ── Early returns ───────────────────────────────────────────────────────

  if (isOwnerLoading || (!!orgId && isLoading)) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("admin.volunteerHoursLoading"))}
      >
        {null}
      </AdminPageData>
    );
  }

  if (!currentOwner) {
    return (
      <YStack padding="$4">
        <Text>{String(t("admin.unableToDetermineOwnerAudiences"))}</Text>
      </YStack>
    );
  }

  // Defensive: VolunteersHome returns early for a person, so this notice only
  // shows if the view is mounted directly.
  if (!orgId) {
    return (
      <YStack
        gap="$4"
        flex={1}
        padding="$4"
        maxWidth={1440}
        marginHorizontal="auto"
        width="100%"
      >
        <AdminPageHeader
          title={String(t("admin.volunteerHoursTitle"))}
          subtitle={String(t("admin.volunteerHoursSubtitle"))}
        />
        <YStack padding="$8" alignItems="center" gap="$3">
          <Text variant="body" tone="muted" textAlign="center" maxWidth={480}>
            {String(t("admin.volunteerHoursHumanOwnerNotice"))}
          </Text>
          {hasGroup ? (
            <NextLinkAnchor
              href="/admin"
              data-testid="volunteers-choose-account"
              style={{ textDecoration: "none" }}
            >
              <Button tag="span" variant="secondary">
                {String(t("admin.chooseAccountLink"))}
              </Button>
            </NextLinkAnchor>
          ) : null}
        </YStack>
      </YStack>
    );
  }

  if (error) {
    return (
      <YStack padding="$4" flex={1}>
        <AdminTableErrorState
          message={formatErrorMessage(error)}
          onRetry={() => {
            void refetch();
          }}
          testId="volunteer-hours-error"
        />
      </YStack>
    );
  }

  const hasActiveFilters =
    debouncedSearch.length > 0 || fromStr !== "" || toStr !== "" || acceptedOnly;

  const summaryLabel = (() => {
    if (totalRows === 0) return undefined;
    const start = page * pageSize + 1;
    const end = Math.min((page + 1) * pageSize, totalRows);
    return String(
      t("admin.volunteerHoursNOfTotal", { start, end, total: totalRows }),
    );
  })();

  const fromInputId = "volunteer-hours-filter-from";
  const toInputId = "volunteer-hours-filter-to";

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      <AdminPageHeader
        title={String(t("admin.volunteerHoursTitle"))}
        subtitle={String(t("admin.volunteerHoursSubtitle"))}
        trailing={
          <Button
            size="$3"
            variant="secondary"
            onPress={handleExportCsv}
            disabled={filteredRows.length === 0}
            data-testid="volunteer-hours-export-csv"
          >
            <Download size={16} />
            {String(t("admin.volunteerHoursExportCsv"))}
          </Button>
        }
      />

      {/* Filters row — search + date range + URL-synced scope chips, in the
          standard FilterRow assembly (mirrors PlacesTable). The date inputs
          stay raw <input type="date"> elements (no DS date picker exists)
          with inline labels (they wrap above the input on narrow screens). */}
      <FilterRow hasActiveFilters={hasActiveFilters} onClearAll={clearFilters}>
        <SearchBar
          value={searchQuery}
          onChangeText={handleSearchChange}
          placeholder={String(t("admin.volunteerHoursSearchPlaceholder"))}
          testId="volunteer-hours-search"
        />
        <XStack
          gap="$2"
          alignItems="center"
          flexWrap="wrap"
          flexShrink={1}
          minWidth={0}
        >
          <label htmlFor={fromInputId}>
            <Text variant="label" tone="muted">
              {String(t("admin.volunteerHoursFilterFrom"))}
            </Text>
          </label>
          <input
            id={fromInputId}
            type="date"
            value={fromStr}
            max={toStr || undefined}
            onChange={(e) => handleFromChange(e.target.value)}
            data-testid="volunteer-hours-filter-from"
            style={DATE_INPUT_STYLE}
          />
        </XStack>
        <XStack
          gap="$2"
          alignItems="center"
          flexWrap="wrap"
          flexShrink={1}
          minWidth={0}
        >
          <label htmlFor={toInputId}>
            <Text variant="label" tone="muted">
              {String(t("admin.volunteerHoursFilterTo"))}
            </Text>
          </label>
          <input
            id={toInputId}
            type="date"
            value={toStr}
            min={fromStr || undefined}
            onChange={(e) => handleToChange(e.target.value)}
            data-testid="volunteer-hours-filter-to"
            style={DATE_INPUT_STYLE}
          />
        </XStack>
        {/* Non-default range scope only — nothing selected = the ALL TIME
            default; deselecting the chip clears both dates and falls back
            to it. */}
        <FilterChips
          options={rangeChipOptions}
          selected={isThisYearPreset ? "thisYear" : undefined}
          onSelect={(value) => {
            if (value === "thisYear") {
              setExtra("from", currentYearStart);
              setExtra("to", undefined);
            } else {
              setExtra("from", undefined);
              setExtra("to", undefined);
            }
            setPage(0);
          }}
        />
        {/* Independent ACCEPTED-ONLY toggle — orthogonal to the range-scope
            group, so it stays a separate FilterChips, but icon={null}
            renders it as a continuation of the one chip row (single leading
            funnel icon total). */}
        <FilterChips
          options={[
            {
              value: "1",
              label: String(t("admin.volunteerHoursAcceptedOnlyLabel")),
            },
          ]}
          selected={acceptedOnly ? "1" : undefined}
          onSelect={(value) => {
            setExtra("accepted", value);
            setPage(0);
          }}
          icon={null}
          // Two chip groups share this row — distinct group names so screen
          // readers don't announce both as "Filters".
          ariaLabel="Signup status filter"
        />
      </FilterRow>

      {acceptedOnly ? (
        <Text
          variant="caption"
          tone="muted"
          testId="volunteer-hours-accepted-only-caption"
        >
          {String(t("admin.volunteerHoursAcceptedOnlyCaption"))}
        </Text>
      ) : null}

      {/* Table — no minWidth here: a fixed 640px on this wrapper made the
          whole PAGE pan horizontally on phones. The table keeps its 640px
          minimum inside the scoped scroll container below instead. */}
      <YStack flex={1} minWidth={0} width="100%">
        <ActionBar
          onRefresh={() => {
            void refetch();
          }}
          countLabel={summaryLabel}
        />

        <TableContainer>
          {/* Scoped horizontal scroll: phones swipe the table sideways
              inside this container; the page itself never pans. Focusable
              so keyboard users can scroll it with arrow keys. */}
          <div
            data-testid="volunteer-hours-table-scroll"
            tabIndex={0}
            role="region"
            aria-label={String(t("admin.volunteerHoursTitle"))}
            style={{
              maxWidth: "100%",
              overflowX: "auto",
              WebkitOverflowScrolling: "touch",
            }}
          >
            <div style={{ minWidth: 640 }}>
              <DataTable
                rows={rows}
                columns={columns}
                clientSort
                getRowKey={(row) => row.volunteerKey}
                isLoading={isLoading}
                emptyState={
                  hasActiveFilters ? (
                    <NoResults
                      title={String(t("admin.volunteerHoursNoMatches"))}
                      description={String(
                        t("admin.volunteerHoursNoMatchesDescription"),
                      )}
                      onClearFilters={clearFilters}
                    />
                  ) : (
                    <YStack
                      padding="$8"
                      alignItems="center"
                      justifyContent="center"
                      gap="$3"
                    >
                      <Text variant="h4" weight="bold" textAlign="center">
                        {String(t("admin.volunteerHoursEmptyTitle"))}
                      </Text>
                      <Text
                        variant="body"
                        tone="muted"
                        textAlign="center"
                        maxWidth={360}
                      >
                        {String(t("admin.volunteerHoursEmptyDescription"))}
                      </Text>
                    </YStack>
                  )
                }
                testIdBase="volunteer-hours-table"
              />
            </div>
          </div>
        </TableContainer>

        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
        />
      </YStack>
    </YStack>
  );
}
