"use client";

import { use, useMemo, useState, useCallback } from "react";
import { YStack, XStack, styled } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Badge,
  Text,
  Spinner,
  useTranslations,
  useFormatters,
} from "@th/ui";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";
import { AdminTabBar, type AdminTab } from "../_components/AdminTabBar";
import {
  ActionBar,
  TableContainer,
  FilterRow,
  Pagination,
} from "@/components/AdminTableParts";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDateShort, fmtCurrency, truncateId } from "@/lib/format";
import { claimResolutionKey } from "@/lib/resale-claims";
import {
  ClaimStatusBadge,
  CLAIM_KIND_LABEL_KEY,
} from "@/app/platform/claims/_components/ClaimMobileCard";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ResaleTab = "listings" | "claims";

type ListingStatus = "ACTIVE" | "HELD" | "SOLD" | "CANCELLED" | "EXPIRED";

interface ListingRow {
  id: string;
  ticketId: string;
  eventId: string;
  askPriceCents: number;
  currency: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  ticketTypeName: string | null;
  facePriceCents: number | null;
  sectionName: string | null;
  sectionId: string | null;
  seatLabel: string | null;
  seatRow: string | null;
  seatNumber: number | null;
}

interface ClaimRow {
  id: string;
  kind: string;
  status: string;
  /** Null on a non-"full" row (staff should always get "full"). */
  claimantId: string | null;
  respondentId: string | null;
  deadline: string | null;
  /** True once the claim's order is REFUNDED: the only proof of a refund. */
  refundConfirmed: boolean;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status badge helpers
// ─────────────────────────────────────────────────────────────────────────────

const LISTING_STATUS_TONE: Record<
  ListingStatus,
  "success" | "warning" | "info" | "neutral" | "danger"
> = {
  ACTIVE: "success",
  HELD: "warning",
  SOLD: "info",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
};

function ListingStatusBadge({
  status,
  t,
}: {
  status: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const key =
    `admin.resaleStatus${status.charAt(0).toUpperCase()}${status.slice(1).toLowerCase()}` as const;
  const tone = LISTING_STATUS_TONE[status as ListingStatus] ?? "neutral";
  return (
    <Badge tone={tone} size="sm">
      {!(status in LISTING_STATUS_TONE)
        ? status
        : String(t(key))}
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives
// ─────────────────────────────────────────────────────────────────────────────

const Container = styled(YStack, { padding: 24, gap: 16, flex: 1 });

const HeaderRow = styled(XStack, {
  justifyContent: "space-between",
  alignItems: "flex-start",
  flexWrap: "wrap",
  gap: 12,
});

const SelectWrapper = styled(XStack, {
  gap: 8,
  alignItems: "center",
});

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

type PageProps = { params: Promise<{ slug: string }> };

export default function AdminResalePage({ params }: PageProps) {
  const { slug } = use(params);
  const t = useTranslations();
  const { currentOwner, isLoading: ownerLoading } = useCurrentAdminOwner(slug);

  const [activeTab, setActiveTab] = useState<ResaleTab>("listings");

  const tabs: AdminTab<ResaleTab>[] = useMemo(
    () => [
      { value: "listings", label: String(t("admin.resaleListingsTab")) },
      { value: "claims", label: String(t("admin.resaleClaimsTab")) },
    ],
    [t],
  );

  if (ownerLoading || !currentOwner) {
    return (
      <Container alignItems="center" justifyContent="center">
        <Spinner size="lg" />
      </Container>
    );
  }

  // Derive owner type/id
  const ownerType =
    currentOwner.kind === "human"
      ? ("HUMAN" as const)
      : ("ORGANIZATION" as const);
  const ownerId =
    currentOwner.kind === "human" ? currentOwner.humanId : currentOwner.orgId;

  return (
    <AdminEmailVerificationGate mode="block">
      <Container>
        <YStack gap={4}>
          <Text variant="h3">{String(t("admin.resaleTitle"))}</Text>
          <Text fontSize={14} color="$color11">
            {String(t("admin.resaleSubtitle"))}
          </Text>
        </YStack>

        <AdminTabBar
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />

        {activeTab === "listings" ? (
          <ListingsTab ownerType={ownerType} ownerId={ownerId} />
        ) : (
          <ClaimsTab ownerType={ownerType} ownerId={ownerId} />
        )}
      </Container>
    </AdminEmailVerificationGate>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Listings tab
// ─────────────────────────────────────────────────────────────────────────────

function ListingsTab({
  ownerType,
  ownerId,
}: {
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { page, pageSize, setPage } = useAdminTableParams();
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // Load org events
  const eventsQuery = trpc.events.listMine.useQuery(
    { ownerType, ownerId, limit: 100 },
    { staleTime: 60_000 },
  );
  const events = eventsQuery.data?.items ?? [];

  // Load listings for the selected event
  const listingsQuery = trpc.resale.listEventListings.useQuery(
    {
      eventId: selectedEventId ?? "",
      limit: pageSize,
      offset: page * pageSize,
    },
    {
      enabled: Boolean(selectedEventId),
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  // Auto-select first event once loaded
  const autoSelected = useMemo(() => {
    if (selectedEventId || events.length === 0) return;
    return events[0]?.id;
  }, [events, selectedEventId]);

  if (autoSelected && !selectedEventId) {
    // Safe: only fires once
    setSelectedEventId(autoSelected);
  }

  const rows: ListingRow[] = listingsQuery.data?.items ?? [];
  const totalRows = listingsQuery.data?.total ?? 0;
  const totalPages = Math.ceil(totalRows / pageSize);

  const handleEventChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedEventId(e.target.value || null);
      setPage(0);
    },
    [setPage],
  );

  const columns: DataTableColumn<ListingRow>[] = useMemo(
    () => [
      {
        id: "id",
        header: String(t("admin.resaleListingId")),
        cell: (row) => (
          <Text fontSize={13} fontFamily="$mono">
            {truncateId(row.id)}
          </Text>
        ),
        width: 100,
      },
      {
        id: "ticketTypeName",
        header: String(t("admin.resaleTicketType")),
        cell: (row) => <Text fontSize={13}>{row.ticketTypeName ?? "—"}</Text>,
        width: 140,
      },
      {
        id: "sectionName",
        header: String(t("admin.resaleSection")),
        cell: (row) => {
          if (!row.sectionName) return <Text fontSize={13}>—</Text>;
          const seat =
            row.seatLabel ??
            (row.seatRow && row.seatNumber != null
              ? `${row.seatRow}${row.seatNumber}`
              : null);
          return (
            <Text fontSize={13}>
              {row.sectionName}
              {seat ? ` / ${seat}` : ""}
            </Text>
          );
        },
        width: 160,
      },
      {
        id: "askPriceCents",
        header: String(t("admin.resaleAskPrice")),
        cell: (row) => (
          <Text variant="bodySmall" weight="bold">
            {fmtCurrency(fmt, row.askPriceCents, row.currency)}
          </Text>
        ),
        width: 100,
      },
      {
        id: "facePriceCents",
        header: String(t("admin.resaleFacePrice")),
        cell: (row) => (
          <Text variant="bodySmall" tone="muted">
            {row.facePriceCents != null
              ? fmtCurrency(fmt, row.facePriceCents, row.currency)
              : "—"}
          </Text>
        ),
        width: 100,
      },
      {
        id: "status",
        header: String(t("admin.resaleStatus")),
        cell: (row) => <ListingStatusBadge status={row.status} t={t} />,
        width: 100,
      },
      {
        id: "createdAt",
        header: String(t("admin.resaleCreated")),
        cell: (row) => (
          <Text variant="bodySmall">{fmtDateShort(fmt, row.createdAt)}</Text>
        ),
        width: 120,
      },
    ],
    [t, fmt],
  );

  const isLoading = eventsQuery.isLoading || listingsQuery.isLoading;
  const error = listingsQuery.error;

  return (
    <YStack gap={12}>
      <FilterRow
        hasActiveFilters={Boolean(selectedEventId)}
        onClearAll={() => setSelectedEventId(null)}
      >
        <SelectWrapper>
          <Text fontSize={13} color="$color11">
            {String(t("admin.resaleSelectEvent"))}:
          </Text>
          <select
            value={selectedEventId ?? ""}
            onChange={handleEventChange}
            style={{
              padding: "6px 10px",
              borderRadius: 0,
              border: "1px solid var(--borderColor)",
              fontSize: 13,
              background: "var(--background)",
              color: "var(--color)",
              maxWidth: 320,
            }}
          >
            {events.length === 0 && (
              <option value="">
                {eventsQuery.isLoading
                  ? String(t("admin.resaleLoadingEvents"))
                  : String(t("admin.resaleNoEvents"))}
              </option>
            )}
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.title}
              </option>
            ))}
          </select>
        </SelectWrapper>
      </FilterRow>

      {error && (
        <Text color="$red10" fontSize={13}>
          {String(
            t("admin.resaleFailedToLoad", { error: formatErrorMessage(error, t) }),
          )}
        </Text>
      )}

      <TableContainer>
        <DataTable
          columns={columns}
          rows={rows}
          isLoading={isLoading}
          emptyState={
            <Text variant="body" tone="muted">
              {String(t("admin.resaleNoListings"))}
            </Text>
          }
        />
      </TableContainer>

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      )}

      <ActionBar
        onRefresh={() => listingsQuery.refetch()}
        countLabel={String(
          t("admin.resaleListingsCount", { count: totalRows }),
        )}
      />
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Claims tab
// ─────────────────────────────────────────────────────────────────────────────

function ClaimsTab({
  ownerType,
  ownerId,
}: {
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { page, pageSize, setPage } = useAdminTableParams();
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // Load org events
  const eventsQuery = trpc.events.listMine.useQuery(
    { ownerType, ownerId, limit: 100 },
    { staleTime: 60_000 },
  );
  const events = eventsQuery.data?.items ?? [];

  // Load claims for the selected event
  const claimsQuery = trpc.claims.list.useQuery(
    {
      eventId: selectedEventId ?? undefined,
      limit: pageSize,
      offset: page * pageSize,
    },
    {
      enabled: Boolean(selectedEventId),
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  // Auto-select first event
  const autoSelected = useMemo(() => {
    if (selectedEventId || events.length === 0) return;
    return events[0]?.id;
  }, [events, selectedEventId]);

  if (autoSelected && !selectedEventId) {
    setSelectedEventId(autoSelected);
  }

  const rows: ClaimRow[] = useMemo(
    () =>
      (claimsQuery.data?.items ?? []).map((c) => ({
        id: c.id,
        kind: c.kind,
        status: c.status,
        claimantId: c.view === "full" ? c.claimantId : null,
        respondentId: c.view === "full" ? c.respondentId : null,
        deadline: c.deadline ?? null,
        refundConfirmed: c.refundConfirmed,
        createdAt: c.createdAt,
      })),
    [claimsQuery.data],
  );
  const totalRows = claimsQuery.data?.total ?? 0;
  const totalPages = Math.ceil(totalRows / pageSize);

  const handleEventChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedEventId(e.target.value || null);
      setPage(0);
    },
    [setPage],
  );

  const columns: DataTableColumn<ClaimRow>[] = useMemo(
    () => [
      {
        id: "id",
        header: String(t("admin.pclId")),
        cell: (row) => (
          <Text fontSize={13} fontFamily="$mono">
            {truncateId(row.id)}
          </Text>
        ),
        width: 100,
      },
      {
        id: "kind",
        header: String(t("admin.pclKind")),
        cell: (row) => (
          <Text fontSize={13}>
            {String(t(CLAIM_KIND_LABEL_KEY[row.kind] ?? row.kind))}
          </Text>
        ),
        width: 120,
      },
      {
        id: "status",
        header: String(t("admin.pclStatus")),
        cell: (row) => <ClaimStatusBadge status={row.status} />,
        width: 110,
      },
      {
        id: "claimantId",
        header: String(t("admin.pclBuyer")),
        cell: (row) => (
          <Text fontSize={13} fontFamily="$mono">
            {row.claimantId ? truncateId(row.claimantId) : "—"}
          </Text>
        ),
        width: 100,
      },
      {
        id: "respondentId",
        header: String(t("admin.pclSeller")),
        cell: (row) => (
          <Text fontSize={13} fontFamily="$mono">
            {row.respondentId ? truncateId(row.respondentId) : "—"}
          </Text>
        ),
        width: 100,
      },
      {
        id: "resolution",
        header: String(t("admin.pclResolution")),
        // Read from status + refundConfirmed, never the raw `resolution`
        // code: an approved claim is not "refunded" until Stripe confirms.
        cell: (row) => {
          const key = claimResolutionKey(row);
          return (
            <Text fontSize={13} tone={key ? undefined : "muted"}>
              {key ? String(t(key)) : "—"}
            </Text>
          );
        },
        width: 120,
      },
      {
        // When the buyer's filing window closed; not a reply or decision
        // cut-off (claims never expire: owner rulings Q8/Q9).
        id: "deadline",
        header: String(t("resaleClaim.windowClosedColumn")),
        cell: (row) => (
          <Text variant="bodySmall">
            {row.deadline ? fmtDateShort(fmt, row.deadline) : "—"}
          </Text>
        ),
        width: 120,
      },
      {
        id: "createdAt",
        header: String(t("admin.pclCreated")),
        cell: (row) => (
          <Text variant="bodySmall">{fmtDateShort(fmt, row.createdAt)}</Text>
        ),
        width: 120,
      },
    ],
    [t, fmt],
  );

  const isLoading = eventsQuery.isLoading || claimsQuery.isLoading;
  const error = claimsQuery.error;

  return (
    <YStack gap={12}>
      <FilterRow
        hasActiveFilters={Boolean(selectedEventId)}
        onClearAll={() => setSelectedEventId(null)}
      >
        <SelectWrapper>
          <Text fontSize={13} color="$color11">
            {String(t("admin.resaleSelectEvent"))}:
          </Text>
          <select
            value={selectedEventId ?? ""}
            onChange={handleEventChange}
            style={{
              padding: "6px 10px",
              borderRadius: 0,
              border: "1px solid var(--borderColor)",
              fontSize: 13,
              background: "var(--background)",
              color: "var(--color)",
              maxWidth: 320,
            }}
          >
            {events.length === 0 && (
              <option value="">
                {eventsQuery.isLoading
                  ? String(t("admin.resaleLoadingEvents"))
                  : String(t("admin.resaleNoEvents"))}
              </option>
            )}
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.title}
              </option>
            ))}
          </select>
        </SelectWrapper>
      </FilterRow>

      {error && (
        <Text color="$red10" fontSize={13}>
          {String(
            t("admin.resaleClaimsFailedToLoad", {
              error: formatErrorMessage(error, t),
            }),
          )}
        </Text>
      )}

      <TableContainer>
        <DataTable
          columns={columns}
          rows={rows}
          isLoading={isLoading}
          emptyState={
            <Text variant="body" tone="muted">
              {String(t("admin.resaleNoClaims"))}
            </Text>
          }
        />
      </TableContainer>

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      )}

      <ActionBar
        onRefresh={() => claimsQuery.refetch()}
        countLabel={String(
          t("admin.resaleClaimsCount", { count: totalRows }),
        )}
      />
    </YStack>
  );
}
