"use client";

import { useMemo, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useTheme, YStack, XStack } from "tamagui";
import { PlatformContainer } from "../_components/PlatformPageParts";
import { FilterChips } from "@/components/AdminTableParts";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSortState,
  Button,
  Text,
  Badge,
  TextInput,
  useTranslations,
  useFormatters,
} from "@th/ui";
import { Users, Search, RefreshCw, X } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDate, truncateId } from "@/lib/format";
import { useIsMobile } from "@/hooks/useIsMobile";
import { HumanActions } from "./_components/HumanActions";
import {
  FlaggedSignupBadge,
  flaggedMatchAccounts,
  type FlaggedSignupMatch,
  HumanMobileCard,
  HumanStatusBadge,
  HumanVerifiedBadge,
} from "./_components/HumanMobileCard";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type VerifiedFilter = "all" | "verified" | "unverified";

interface OrgMembershipSummary {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: string;
}

interface PlatformHumanRow {
  id: string;
  name: string | null;
  status: string;
  roles: string[];
  trustTier: string;
  createdAt: Date;
  identity: {
    authUserId: string;
    email: string;
    emailVerified: boolean;
    phone: string | null;
    phoneVerified: boolean;
    username: string | null;
    displayUsername: string | null;
    image: string | null;
  } | null;
  memberships: OrgMembershipSummary[];
  /** Force-verify pre-flight; see `HumanActions`. */
  holdsEmailAttachedRows: boolean | null;
}

const PAGE_SIZE = 25;
/** Flagged sign-ups the filter can show (the query's page cap). */
const FLAGGED_LIMIT = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformHumansPage() {
  return (
    <Suspense>
      <PlatformHumansPageContent />
    </Suspense>
  );
}

function PlatformHumansPageContent() {
  const t = useTranslations();
  const fmt = useFormatters();
  const theme = useTheme();
  const isMobile = useIsMobile();

  // ── Deep-link prefill ──────────────────────────────────────────────────────
  // The support inbox links here with `?q=<display name>` to surface one
  // attendee. We accept a free-text query only (name) — never the email — and
  // seed the search box with it.
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";

  // ── State ────────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [debouncedSearch, setDebouncedSearch] = useState(initialQuery);
  const [verifiedFilter, setVerifiedFilter] = useState<VerifiedFilter>("all");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<DataTableSortState>({
    columnId: "createdAt",
    direction: "desc",
  });

  // Search debounce
  const searchTimeout = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchTimeout[0]) clearTimeout(searchTimeout[0]);
      searchTimeout[0] = setTimeout(() => {
        setDebouncedSearch(value.trim());
        setPage(0);
      }, 300);
    },
    [searchTimeout],
  );

  // Derive emailVerified filter
  const emailVerifiedParam = useMemo(() => {
    if (verifiedFilter === "verified") return true;
    if (verifiedFilter === "unverified") return false;
    return undefined;
  }, [verifiedFilter]);

  // Derive sort param
  const sortParam = useMemo(() => {
    if (sort.columnId === "createdAt") {
      return sort.direction === "asc"
        ? ("createdAt_asc" as const)
        : ("createdAt_desc" as const);
    }
    if (sort.columnId === "name") {
      return sort.direction === "asc"
        ? ("name_asc" as const)
        : ("name_desc" as const);
    }
    return "createdAt_desc" as const;
  }, [sort]);

  // ── Staff capability ───────────────────────────────────────────────────────
  // The four human-management mutations (setHumanStatus / forceVerifyEmail /
  // unlinkAuthAccount / deleteHuman) are ADMIN-only server-side. Derive the
  // platform ADMIN capability the same way the Categories page reads staff
  // roles, and thread it into HumanActions so non-admin staff (REVIEWER /
  // SUPPORT) never see actions that would 403. The list stays visible to any
  // staff — listHumans is any-staff.
  const staffAccessQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    staleTime: 60_000,
  });
  const isPlatformAdmin = (staffAccessQuery.data?.roles ?? []).includes(
    "ADMIN",
  );

  // ── Flagged sign-ups (ban-that-sticks) ───────────────────────────────────
  // Accounts that signed up in the last 30 days from a network a banned human
  // used. Derived server-side on every read — nothing is stored on the human.
  // Drives the row badge and, when the chip is on, which rows the table shows.
  const flaggedQuery = trpc.platform.listFlaggedSignups.useQuery(
    { limit: FLAGGED_LIMIT },
    { staleTime: 30_000 },
  );
  const flaggedById = useMemo(() => {
    const map = new Map<string, FlaggedSignupMatch[]>();
    for (const item of flaggedQuery.data?.items ?? []) {
      map.set(item.humanId, item.matches);
    }
    return map;
  }, [flaggedQuery.data?.items]);
  const flaggedTotal = flaggedQuery.data?.pageInfo.total ?? null;

  // ── Query ────────────────────────────────────────────────────────────────
  const { data, isLoading, error, refetch } = trpc.platform.listHumans.useQuery(
    {
      searchQuery: debouncedSearch || undefined,
      emailVerified: emailVerifiedParam,
      humanIds: flaggedOnly ? [...flaggedById.keys()] : undefined,
      sort: sortParam,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    },
    {
      staleTime: 30_000,
      placeholderData: keepPreviousData,
      // The flagged filter needs the flagged ids first.
      enabled: !flaggedOnly || flaggedQuery.isSuccess,
    },
  );

  const rows: PlatformHumanRow[] = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map((item) => ({
      ...item,
      createdAt: new Date(item.createdAt),
    }));
  }, [data?.items]);

  const totalRows = data?.pageInfo?.total ?? 0;
  const totalPages = Math.ceil(totalRows / PAGE_SIZE);

  const summaryLabel = useMemo(() => {
    if (!data?.pageInfo) return undefined;
    const start = page * PAGE_SIZE + 1;
    const end = Math.min((page + 1) * PAGE_SIZE, totalRows);
    if (totalRows === 0) return String(t("admin.phNoHumansYet"));
    return String(t("admin.nOfTotal", { start, end, total: totalRows }));
  }, [data?.pageInfo, page, totalRows, t]);

  // ── Columns ──────────────────────────────────────────────────────────────
  const columns: DataTableColumn<PlatformHumanRow>[] = useMemo(
    () => [
      {
        id: "id",
        header: "ID",
        width: 1,
        cell: (row) => (
          <Text
            variant="body"
            style={{
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {truncateId(row.id)}
          </Text>
        ),
      },
      {
        id: "name",
        header: String(t("admin.phColName")),
        width: 1.8,
        cell: (row) => (
          <YStack gap="$1" minWidth={0}>
            <Text
              variant="body"
              weight="bold"
              tone={row.name ? "default" : "muted"}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.name || "\u2014"}
            </Text>
            {flaggedById.has(row.id) ? (
              <XStack>
                <FlaggedSignupBadge />
              </XStack>
            ) : null}
          </YStack>
        ),
      },
      {
        id: "email",
        header: String(t("admin.phColEmail")),
        width: 2.2,
        cell: (row) => (
          <Text
            variant="body"
            tone={row.identity?.email ? "default" : "muted"}
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.identity?.email || "\u2014"}
          </Text>
        ),
      },
      // While the "Flagged sign-ups" filter is on, the Username slot shows
      // which banned account(s) each row shares a network with instead —
      // same column budget, so the narrow Status/Verified columns do not
      // shrink further. Wraps, never truncates: the names ARE the point.
      flaggedOnly
        ? ({
            id: "sameNetwork",
            header: String(t("admin.phColSameNetwork")),
            width: 1.3,
            cell: (row: PlatformHumanRow) => (
              <Text variant="bodySmall" tone="default">
                {flaggedMatchAccounts(t, flaggedById.get(row.id) ?? [])}
              </Text>
            ),
          } satisfies DataTableColumn<PlatformHumanRow>)
        : {
            id: "username",
            header: String(t("admin.phColUsername")),
            width: 1.3,
            cell: (row) => (
              <Text
                variant="body"
                tone={row.identity?.username ? "default" : "muted"}
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.identity?.displayUsername ||
                  row.identity?.username ||
                  "\u2014"}
              </Text>
            ),
          },
      {
        id: "status",
        header: String(t("admin.phColStatus")),
        width: 1,
        cell: (row) => <HumanStatusBadge status={row.status} />,
      },
      {
        id: "verified",
        header: String(t("admin.phColVerified")),
        width: 1,
        cell: (row) => (
          <HumanVerifiedBadge verified={Boolean(row.identity?.emailVerified)} />
        ),
      },
      {
        id: "orgs",
        header: String(t("admin.phColOrganizations")),
        width: 2.5,
        cell: (row) => {
          if (!row.memberships.length) {
            return (
              <Text variant="body" tone="muted">
                {"\u2014"}
              </Text>
            );
          }
          return (
            <XStack gap="$1" flexWrap="wrap">
              {row.memberships.map((m) => (
                <Badge key={m.orgId} tone="neutral" size="sm">
                  {m.orgName} ({m.role})
                </Badge>
              ))}
            </XStack>
          );
        },
      },
      {
        id: "createdAt",
        header: String(t("admin.phColJoined")),
        width: 1.5,
        noWrap: true,
        cell: (row) => (
          <Text variant="body" tone="default">
            {fmtDate(fmt, row.createdAt)}
          </Text>
        ),
      },
      {
        id: "actions",
        header: "",
        width: 0.5,
        cell: (row) => (
          <HumanActions
            row={row}
            onMutationSuccess={() => refetch()}
            isPlatformAdmin={isPlatformAdmin}
          />
        ),
      },
    ],
    [t, fmt, isPlatformAdmin, refetch, flaggedById, flaggedOnly],
  );

  // ── Filter handlers ──────────────────────────────────────────────────────
  const handleVerifiedToggle = useCallback((filter: VerifiedFilter) => {
    setVerifiedFilter((prev) => (prev === filter ? "all" : filter));
    setPage(0);
  }, []);

  const handleFlaggedToggle = useCallback(() => {
    setFlaggedOnly((prev) => !prev);
    setPage(0);
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setDebouncedSearch("");
    setVerifiedFilter("all");
    setFlaggedOnly(false);
    setPage(0);
  }, []);

  const hasActiveFilters =
    Boolean(debouncedSearch) || verifiedFilter !== "all" || flaggedOnly;

  // ── Error state ──────────────────────────────────────────────────────────
  if (error) {
    return (
      <PlatformContainer size="lg">
        <YStack gap="$3">
          <Text variant="body" tone="error">
            {String(
              t("admin.plFailedToLoadOrders", {
                error: formatErrorMessage(error),
              }),
            )}
          </Text>
          <Button variant="secondary" size="$2" onPress={() => refetch()}>
            {String(t("admin.retry"))}
          </Button>
        </YStack>
      </PlatformContainer>
    );
  }

  return (
    <PlatformContainer size="lg">
      {/* Header */}
      <YStack gap={8}>
        <XStack gap={8} alignItems="center">
          <Users size={20} color={theme.color?.val} />
          <Text variant="h2" tag="h1" weight="bold">
            {String(t("admin.phTitle"))}
          </Text>
        </XStack>
        <Text variant="body" tone="muted">
          {String(t("admin.phSubtitle"))}
        </Text>
      </YStack>

      {/* Filters */}
      <YStack gap="$3">
        <XStack gap="$3" flexWrap="wrap" alignItems="center">
          {/* Floor of icon + gap + 240px field, as before the field could
              shrink: the row still wraps under 640px where it used to. */}
          <XStack
            alignItems="center"
            gap="$2"
            flex={1}
            maxWidth={340}
            minWidth="min(100%, 264px)"
          >
            <Search size={16} color={theme.colorMuted?.val} />
            {/* TextInput's frame is a fixed 240px and does not shrink; this
                box does, so at 320 the field fits the column. */}
            <XStack flex={1} minWidth={0} maxWidth={240}>
              <TextInput
                fullWidth
                value={searchQuery}
                onChangeText={handleSearchChange}
                placeholder={t("admin.phSearchPlaceholder") as string}
              />
            </XStack>
          </XStack>

          {/* Verified filter */}
          <FilterChips<"verified" | "unverified">
            options={[
              { value: "verified", label: String(t("admin.phFilterVerified")) },
              {
                value: "unverified",
                label: String(t("admin.phFilterUnverified")),
              },
            ]}
            selected={verifiedFilter === "all" ? undefined : verifiedFilter}
            onSelect={(v) => handleVerifiedToggle(v ?? "all")}
          />

          {/* Flagged sign-ups filter — the label carries the total once known */}
          <FilterChips<"flagged">
            options={[
              {
                value: "flagged",
                label:
                  flaggedTotal === null
                    ? String(t("admin.phFilterFlagged"))
                    : String(
                        t("admin.phFilterFlaggedCount", {
                          count: flaggedTotal,
                        }),
                      ),
              },
            ]}
            selected={flaggedOnly ? "flagged" : undefined}
            onSelect={() => handleFlaggedToggle()}
          />

          {hasActiveFilters && (
            <Button variant="ghost" size="$2" onPress={clearFilters}>
              <X size={14} aria-hidden />
              {String(t("admin.clearFilters"))}
            </Button>
          )}
        </XStack>
        {/* Without the flagged query the badges are silently absent, so say
            so; and say when the filter shows only the newest FLAGGED_LIMIT. */}
        {flaggedQuery.error ? (
          <Text variant="caption" tone="error">
            {String(
              t("admin.phFlaggedLoadFailed", {
                error: formatErrorMessage(flaggedQuery.error, t),
              }),
            )}
          </Text>
        ) : flaggedOnly &&
          flaggedTotal !== null &&
          flaggedTotal > FLAGGED_LIMIT ? (
          <Text variant="caption" tone="muted">
            {String(
              t("admin.phFlaggedTruncated", {
                shown: FLAGGED_LIMIT,
                total: flaggedTotal,
              }),
            )}
          </Text>
        ) : null}
      </YStack>

      {/* Action bar */}
      <XStack paddingHorizontal="$1" paddingVertical="$2" alignItems="center">
        <Button
          variant="ghost"
          size="$2"
          onPress={() => refetch()}
          aria-label={t("admin.plRefresh") as string}
          paddingHorizontal="$3"
        >
          <RefreshCw size={14} aria-hidden />
          {String(t("admin.plRefresh"))}
        </Button>
        <XStack flex={1} />
        {summaryLabel && (
          <Text variant="caption" tone="muted" paddingHorizontal="$3">
            {summaryLabel}
          </Text>
        )}
      </XStack>

      {/* Table — the 1000px table floor drops only below useIsMobile's 600px
          breakpoint, the same breakpoint DataTable uses for card mode, so the
          page never pans horizontally on phones; the scoped scroll wrapper
          still handles desktop windows narrower than the floor. */}
      <XStack overflow="scroll" flex={1}>
        <YStack flex={1} minWidth={isMobile ? 0 : 1000}>
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            isLoading={isLoading}
            sort={sort}
            onSortChange={(newSort) => {
              setSort(newSort);
              setPage(0);
            }}
            // Card mode (<600px). The table's only interactive control is the
            // HumanActions menu, rendered in a plain "actions" column that
            // card mode does not show — the card surfaces the same menu so
            // suspend/ban/verify/manage/delete stay reachable on phones.
            renderMobileCard={(row) => (
              <HumanMobileCard
                row={row}
                flaggedMatches={flaggedById.get(row.id)}
                actions={
                  <HumanActions
                    row={row}
                    onMutationSuccess={() => refetch()}
                    triggerSize="lg"
                    isPlatformAdmin={isPlatformAdmin}
                  />
                }
              />
            )}
            testIdBase="platform-humans-table"
            emptyState={
              <YStack
                padding="$8"
                alignItems="center"
                justifyContent="center"
                gap="$3"
              >
                <Users size={32} color="var(--colorMuted)" />
                <Text variant="h4" weight="bold">
                  {hasActiveFilters
                    ? String(t("admin.phNoMatchingHumans"))
                    : String(t("admin.phNoHumansYet"))}
                </Text>
                <Text
                  variant="body"
                  tone="muted"
                  textAlign="center"
                  maxWidth={360}
                >
                  {hasActiveFilters
                    ? String(t("admin.phNoMatchingHumansDesc"))
                    : String(t("admin.phNoHumansYetDesc"))}
                </Text>
                {hasActiveFilters && (
                  <Button variant="secondary" size="$2" onPress={clearFilters}>
                    {String(t("admin.clearFilters"))}
                  </Button>
                )}
              </YStack>
            }
          />
        </YStack>
      </XStack>

      {/* Pagination */}
      {totalPages > 1 && (
        <XStack
          justifyContent="center"
          alignItems="center"
          gap="$3"
          paddingVertical="$3"
        >
          <Button
            variant="secondary"
            size="$2"
            onPress={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            {String(t("admin.plPrevious"))}
          </Button>
          <Text variant="bodySmall" tone="muted">
            {String(
              t("admin.plPage", { current: page + 1, total: totalPages }),
            )}
          </Text>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            {String(t("admin.plNext"))}
          </Button>
        </XStack>
      )}
    </PlatformContainer>
  );
}
