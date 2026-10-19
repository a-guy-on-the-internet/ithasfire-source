"use client";

/**
 * /platform/roles — grant/revoke platform HumanRoles (ADMIN-only mutations).
 *
 * Before this page existed, roles were only settable via
 * `pnpm seed:admin` (apps/api/src/scripts/reference-data/seed-platform-admin.ts) or raw
 * psql. That script remains the bootstrap path for the very first platform
 * ADMIN — there is a chicken-and-egg problem where no ADMIN exists yet to
 * use this UI, so it is NOT replaced by this page.
 *
 * Step-up 2FA enforcement on top of this ADMIN gate is a separate, planned
 * follow-up — not built here.
 */

import { useCallback, useMemo, useState, Suspense } from "react";
import { useTheme, XStack, YStack } from "tamagui";
import { keepPreviousData } from "@tanstack/react-query";
import { ShieldCheck, Search, RefreshCw, X } from "lucide-react";

import {
  DataTable,
  type DataTableColumn,
  type DataTableSortState,
  Button,
  Text,
  TextInput,
  useNotify,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { truncateId } from "@/lib/format";
import { useIsMobile } from "@/hooks/useIsMobile";
import { PlatformContainer } from "../_components/PlatformPageParts";
import { FilterChips } from "@/components/AdminTableParts";

import { RoleBadgeList } from "./_components/RoleBadgeList";
import { GrantRoleSelect } from "./_components/GrantRoleSelect";
import { RolesMobileCard } from "./_components/RolesMobileCard";
import {
  ALL_HUMAN_ROLES,
  type HumanRoleValue,
} from "./_components/roles-constants";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PlatformRoleRow {
  id: string;
  name: string | null;
  roles: string[];
  identity: { email: string } | null;
}

const PAGE_SIZE = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformRolesPage() {
  return (
    <Suspense>
      <PlatformRolesPageContent />
    </Suspense>
  );
}

function PlatformRolesPageContent() {
  const theme = useTheme();
  const isMobile = useIsMobile();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  // ── State ────────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<HumanRoleValue | undefined>(
    undefined,
  );
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<DataTableSortState>({
    columnId: "createdAt",
    direction: "desc",
  });

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

  const sortParam = useMemo(() => {
    if (sort.columnId === "name") {
      return sort.direction === "asc"
        ? ("name_asc" as const)
        : ("name_desc" as const);
    }
    return sort.direction === "asc"
      ? ("createdAt_asc" as const)
      : ("createdAt_desc" as const);
  }, [sort]);

  // ── Staff capability ─────────────────────────────────────────────────────
  // grantRole/revokeRole are ADMIN-only server-side; non-admin staff (who can
  // still reach this page — nav rbac is STAFF_TECH, not ADMIN-only) get a
  // read-only roster: badges with no revoke "x", no grant control. Mirrors
  // the /platform/humans isPlatformAdmin gate.
  const staffAccessQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    staleTime: 60_000,
  });
  const isPlatformAdmin = (staffAccessQuery.data?.roles ?? []).includes(
    "ADMIN",
  );
  const actorHumanId = staffAccessQuery.data?.actorHumanId;

  // ── Query ────────────────────────────────────────────────────────────────
  const { data, isLoading, error, refetch } = trpc.platform.listHumans.useQuery(
    {
      searchQuery: debouncedSearch || undefined,
      sort: sortParam,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    },
    {
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  const allRows: PlatformRoleRow[] = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map((item) => ({
      id: item.id,
      name: item.name,
      roles: item.roles,
      identity: item.identity ? { email: item.identity.email } : null,
    }));
  }, [data?.items]);

  // Role filter is a client-side refine of the CURRENT PAGE only — listHumans
  // has no server-side role filter (adding one is a bigger change than this
  // admin UI warrants; the roster is staff-sized, not attendee-sized). Good
  // enough for a first cut; flagged here rather than silently pretending it's
  // a real cross-page filter.
  const rows = useMemo(
    () =>
      roleFilter
        ? allRows.filter((r) => r.roles.includes(roleFilter))
        : allRows,
    [allRows, roleFilter],
  );

  const totalRows = data?.pageInfo?.total ?? 0;
  const totalPages = Math.ceil(totalRows / PAGE_SIZE);
  const hasActiveFilters = Boolean(debouncedSearch) || roleFilter !== undefined;

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setDebouncedSearch("");
    setRoleFilter(undefined);
    setPage(0);
  }, []);

  // ── Mutations ────────────────────────────────────────────────────────────
  const grantMut = trpc.platform.grantRole.useMutation({
    meta: { silent: true },
  });
  const revokeMut = trpc.platform.revokeRole.useMutation({
    meta: { silent: true },
  });

  const handleGrant = useCallback(
    async (targetHumanId: string, role: HumanRoleValue) => {
      try {
        const result = await grantMut.mutateAsync({ targetHumanId, role });
        toast.success({
          title: result.granted ? `Granted ${role}` : `Already had ${role}`,
        });
        void utils.platform.listHumans.invalidate();
      } catch (err) {
        toast.danger({
          title: "Failed to grant role",
          message: formatErrorMessage(err),
        });
      }
    },
    [grantMut, toast, utils],
  );

  const handleRevoke = useCallback(
    async (targetHumanId: string, role: HumanRoleValue) => {
      try {
        const result = await revokeMut.mutateAsync({ targetHumanId, role });
        toast.success({
          title: result.revoked ? `Revoked ${role}` : `Didn't have ${role}`,
        });
        void utils.platform.listHumans.invalidate();
      } catch (err) {
        toast.danger({
          title: "Failed to revoke role",
          message: formatErrorMessage(err),
        });
      }
    },
    [revokeMut, toast, utils],
  );

  const mutationInFlight = grantMut.isPending || revokeMut.isPending;

  // ── Columns ──────────────────────────────────────────────────────────────
  const columns: DataTableColumn<PlatformRoleRow>[] = useMemo(
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
        header: "Name",
        width: 1.6,
        cell: (row) => (
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
            {row.name || "—"}
          </Text>
        ),
      },
      {
        id: "email",
        header: "Email",
        width: 2,
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
            {row.identity?.email || "—"}
          </Text>
        ),
      },
      {
        id: "roles",
        header: "Roles",
        width: 2.5,
        cell: (row) => (
          <RoleBadgeList
            roles={row.roles}
            isPlatformAdmin={isPlatformAdmin}
            disabled={mutationInFlight}
            onRevoke={(role) => handleRevoke(row.id, role)}
            isOwnRow={row.id === actorHumanId}
          />
        ),
      },
      {
        id: "grant",
        header: "",
        width: 1.4,
        cell: (row) =>
          isPlatformAdmin ? (
            <GrantRoleSelect
              heldRoles={row.roles}
              disabled={mutationInFlight}
              onGrant={(role) => handleGrant(row.id, role)}
            />
          ) : null,
      },
    ],
    [
      isPlatformAdmin,
      mutationInFlight,
      handleGrant,
      handleRevoke,
      actorHumanId,
    ],
  );

  // ── Error state ──────────────────────────────────────────────────────────
  if (error) {
    return (
      <PlatformContainer size="lg">
        <YStack gap="$3">
          <Text variant="body" tone="error">
            {`Failed to load humans: ${formatErrorMessage(error)}`}
          </Text>
          <Button variant="secondary" size="$2" onPress={() => refetch()}>
            Retry
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
          <ShieldCheck size={20} color={theme.color?.val} />
          <Text variant="h2" tag="h1" weight="bold">
            Platform Roles
          </Text>
        </XStack>
        <Text variant="body" tone="muted">
          Grant or revoke platform staff roles. The very first ADMIN is
          bootstrapped via `pnpm seed:admin` — this page is for everything after
          that.
        </Text>
      </YStack>

      {/* Filters */}
      <YStack gap="$3">
        <XStack gap="$3" flexWrap="wrap" alignItems="center">
          <XStack alignItems="center" gap="$2" flex={1} maxWidth={340}>
            <Search size={16} color={theme.colorMuted?.val} />
            <TextInput
              flex={1}
              value={searchQuery}
              onChangeText={handleSearchChange}
              placeholder="Search by name or email"
            />
          </XStack>

          <FilterChips<HumanRoleValue>
            options={ALL_HUMAN_ROLES.map((role) => ({
              value: role,
              label: role,
            }))}
            selected={roleFilter}
            onSelect={(v) => {
              setRoleFilter(v);
              setPage(0);
            }}
          />

          {hasActiveFilters && (
            <Button variant="ghost" size="$2" onPress={clearFilters}>
              <X size={14} aria-hidden />
              Clear filters
            </Button>
          )}
        </XStack>
      </YStack>

      {/* Action bar */}
      <XStack paddingHorizontal="$1" paddingVertical="$2" alignItems="center">
        <Button
          variant="ghost"
          size="$2"
          onPress={() => refetch()}
          aria-label="Refresh"
          paddingHorizontal="$3"
        >
          <RefreshCw size={14} aria-hidden />
          Refresh
        </Button>
        <XStack flex={1} />
        {data?.pageInfo && (
          <Text variant="caption" tone="muted" paddingHorizontal="$3">
            {totalRows === 0
              ? "No humans yet"
              : `${page * PAGE_SIZE + 1}–${Math.min(
                  (page + 1) * PAGE_SIZE,
                  totalRows,
                )} of ${totalRows}`}
          </Text>
        )}
      </XStack>

      {/* Table */}
      <XStack overflow="scroll" flex={1}>
        <YStack flex={1} minWidth={isMobile ? 0 : 900}>
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
            renderMobileCard={(row) => (
              <RolesMobileCard
                row={row}
                isPlatformAdmin={isPlatformAdmin}
                revokeDisabled={mutationInFlight}
                onRevoke={(role) => handleRevoke(row.id, role)}
                isOwnRow={row.id === actorHumanId}
                grantControl={
                  <GrantRoleSelect
                    heldRoles={row.roles}
                    disabled={mutationInFlight}
                    onGrant={(role) => handleGrant(row.id, role)}
                  />
                }
              />
            )}
            testIdBase="platform-roles-table"
            emptyState={
              <YStack
                padding="$8"
                alignItems="center"
                justifyContent="center"
                gap="$3"
              >
                <ShieldCheck size={32} color="var(--colorMuted)" />
                <Text variant="h4" weight="bold">
                  {hasActiveFilters ? "No matching humans" : "No humans yet"}
                </Text>
                {roleFilter && (
                  <Text
                    variant="body"
                    tone="muted"
                    textAlign="center"
                    maxWidth={360}
                  >
                    The role filter only checks the current page — try clearing
                    it or searching by name/email instead.
                  </Text>
                )}
                {hasActiveFilters && (
                  <Button variant="secondary" size="$2" onPress={clearFilters}>
                    Clear filters
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
            Previous
          </Button>
          <Text variant="bodySmall" tone="muted">
            {`Page ${page + 1} of ${totalPages}`}
          </Text>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
          </Button>
        </XStack>
      )}
    </PlatformContainer>
  );
}
