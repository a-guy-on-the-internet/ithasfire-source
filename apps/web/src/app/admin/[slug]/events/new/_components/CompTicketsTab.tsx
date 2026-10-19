"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { XStack, YStack, type TamaguiElement } from "tamagui";
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  OverflowTooltip,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";
import { Gift } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import {
  ActionBar,
  AdminTableErrorState,
  FilterChips,
  FilterRow,
  NoResults,
  TableContainer,
} from "@/components/AdminTableParts";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDate } from "@/lib/format";
import type { OrderStatus } from "@th/types";

import { EventOpsShell } from "../../[id]/_components/EventOpsShell";
import { IssueCompDialog } from "./IssueCompDialog";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the comp came to exist. SERVER-DERIVED (`listCompOrders` reads it off the
 * presence of a VolunteerRewardGrant) and the ONLY correct discriminator — a
 * null `reason` does NOT mean "volunteer reward" and must never be read that
 * way.
 */
const COMP_ORIGINS = ["HAND_ISSUED", "VOLUNTEER_REWARD"] as const;
type CompOrigin = (typeof COMP_ORIGINS)[number];

interface CompRow {
  orderId: string;
  occurredAt: Date;
  status: OrderStatus;
  recipientHumanId: string;
  recipientName: string | null;
  recipientEmail: string | null;
  ticketTypes: Array<{
    ticketTypeId: string;
    name: string | null;
    quantity: number;
  }>;
  quantity: number;
  reason: string | null;
  origin: CompOrigin;
  issuedByHumanId: string | null;
  issuedByName: string | null;
}

/**
 * The whole ledger in one request.
 *
 * `listCompOrders` caps a page at 200 and its own docblock notes comps run to
 * tens per event, so one request is normally the entire ledger — which is what
 * lets the origin chip and the column sort work over ALL the comps rather than
 * over whichever 25 happened to be on screen (a client-side filter across a
 * server-paged list is a lie: "1 comp" when page 2 holds four more). The rare
 * event that exceeds this says so, above the table, instead of silently
 * truncating.
 */
const COMP_LEDGER_LIMIT = 200;

// ─────────────────────────────────────────────────────────────────────────────
// The four origin/reason states
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Copy for a comp with NO typed reason. Three of the four states land here and
 * every one of them is CORRECT data — an em-dash or a blank cell would make
 * all three read as missing.
 *
 *   VOLUNTEER_REWARD                    → earned by volunteering; no reason
 *                                         exists and none ever will.
 *   HAND_ISSUED, issuer known           → a modern comp whose issuer simply
 *                                         didn't type a reason. NOT legacy.
 *   HAND_ISSUED, no issuer              → predates the provenance columns;
 *                                         the audit log is its record.
 *
 * Keyed off `origin` + `issuedByHumanId`, never off `reason`.
 */
function compReasonFallbackKey(row: CompRow): string {
  if (row.origin === "VOLUNTEER_REWARD") {
    return "admin.compReasonEarnedByVolunteering";
  }
  if (row.issuedByHumanId) return "admin.compReasonNoneGiven";
  return "admin.compReasonPredatesTracking";
}

/**
 * Copy for the "issued by" cell, or `null` to render `issuedByName` verbatim.
 *
 * `issuedByName: null` COLLAPSES two cases — the id resolves to no human, and
 * the human exists with a null name — so the copy says only what is true of
 * both ("Name unavailable"). It never asserts the account was deleted.
 */
function compIssuerFallbackKey(row: CompRow): string | null {
  if (row.origin === "VOLUNTEER_REWARD") return "admin.compIssuerAutomatic";
  if (!row.issuedByHumanId) return "admin.compIssuerNotRecorded";
  if (!row.issuedByName) return "admin.compIssuerNameUnavailable";
  return null;
}

/** Mirrors AttendeesTab so one order reads the same tone on both surfaces. */
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

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Cell fragments — shared by the table columns and the mobile card so the two
// modes can never drift into telling different stories about the same row.
// ─────────────────────────────────────────────────────────────────────────────

function CompOriginBadge({ origin }: { origin: CompOrigin }) {
  const t = useTranslations();
  return (
    <Badge tone={origin === "VOLUNTEER_REWARD" ? "info" : "neutral"} size="sm">
      {String(
        t(
          origin === "VOLUNTEER_REWARD"
            ? "admin.compOriginVolunteerReward"
            : "admin.compOriginHandIssued",
        ),
      )}
    </Badge>
  );
}

function CompReasonText({ row }: { row: CompRow }) {
  const t = useTranslations();
  if (row.reason) {
    return <Text variant="bodySmall">{row.reason}</Text>;
  }
  return (
    <Text variant="bodySmall" tone="muted">
      {String(t(compReasonFallbackKey(row)))}
    </Text>
  );
}

function CompIssuerText({ row }: { row: CompRow }) {
  const t = useTranslations();
  const fallbackKey = compIssuerFallbackKey(row);
  if (!fallbackKey) {
    return <Text variant="bodySmall">{row.issuedByName}</Text>;
  }
  return (
    <Text variant="bodySmall" tone="muted">
      {String(t(fallbackKey))}
    </Text>
  );
}

function CompRecipientName({ row }: { row: CompRow }) {
  const t = useTranslations();
  const primary =
    row.recipientName ??
    row.recipientEmail ??
    String(t("admin.compUnknownRecipient"));
  return (
    <OverflowTooltip
      variant="body"
      style={{ fontWeight: 700 }}
      text={primary}
    />
  );
}

function CompTicketTypeLines({ row }: { row: CompRow }) {
  const t = useTranslations();
  if (row.ticketTypes.length === 0) {
    return (
      <Text variant="bodySmall" tone="muted">
        {String(t("admin.compTicketTypeUnnamed"))}
      </Text>
    );
  }
  return (
    <YStack gap={2} minWidth={0}>
      {row.ticketTypes.map((tt) => (
        <Text
          key={tt.ticketTypeId}
          variant="bodySmall"
          tone={tt.name ? "default" : "muted"}
          style={ELLIPSIS_STYLE}
        >
          {tt.name ?? String(t("admin.compTicketTypeUnnamed"))}
          {row.ticketTypes.length > 1 ? ` ×${tt.quantity}` : ""}
        </Text>
      ))}
    </YStack>
  );
}

/**
 * Card rendering below 600px. The ledger is six fields wide; squeezed into a
 * phone the table drives `td` widths to single digits with no horizontal
 * scroller anywhere, so the data becomes literally unreachable. Card mode is
 * the fix, and it keeps every field — including all three null-reason
 * fallbacks, which are the whole point of the surface.
 */
function CompMobileCard({ row }: { row: CompRow }) {
  const t = useTranslations();
  const fmt = useFormatters();

  return (
    <YStack gap="$2" minWidth={0}>
      <XStack gap="$2" alignItems="center" minWidth={0}>
        <YStack flex={1} minWidth={0} gap={2}>
          <CompRecipientName row={row} />
          {row.recipientName && row.recipientEmail ? (
            <Text variant="caption" tone="muted" style={ELLIPSIS_STYLE}>
              {row.recipientEmail}
            </Text>
          ) : null}
        </YStack>
        <XStack flexShrink={0}>
          <Badge tone={getStatusBadgeTone(row.status)} size="sm">
            {row.status.replaceAll("_", " ")}
          </Badge>
        </XStack>
      </XStack>

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <CompOriginBadge origin={row.origin} />
        <Text
          variant="caption"
          tone="muted"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {String(t("admin.compQuantityColumn"))} {row.quantity}
        </Text>
      </XStack>

      <CompTicketTypeLines row={row} />
      <CompReasonText row={row} />

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <CompIssuerText row={row} />
        <Text variant="caption" tone="muted" aria-hidden>
          ·
        </Text>
        <Text variant="caption" tone="muted">
          {fmtDate(fmt, row.occurredAt)}
        </Text>
      </XStack>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Surface
// ─────────────────────────────────────────────────────────────────────────────

export interface CompTicketsTabProps {
  slug: string;
  eventId: string;
}

/**
 * The comps LEDGER for one event: who was comped, on what ticket type, why,
 * by whom and when. Issuing lives in a dialog behind the header action — the
 * page used to BE the issue form, which meant an organizer could hand out
 * comps all week and never see what had already gone out.
 *
 * Reading is ORG_EDIT_OR_FINANCE_ROLES; ISSUING is ORG_ADMIN_ROLES. The two
 * differ on purpose (`listCompOrders`' docblock has the reasoning), so the
 * trigger is gated on `canManage` — the client mirror of ORG_ADMIN_ROLES — and
 * HIDDEN, not disabled, for everyone else. Same call AttendeesTab makes for
 * its finance-only export: a button that can only 403 is a worse answer than
 * no button.
 */
export function CompTicketsTab({ slug, eventId }: CompTicketsTabProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { currentOwner } = useCurrentAdminOwner(slug);
  const { canManage } = useAdminOwnerCapabilities(currentOwner);

  const [originFilter, setOriginFilter] = useState<CompOrigin | undefined>();
  const [issueOpen, setIssueOpen] = useState(false);

  // Focus target for the dialog's close. Deliberately the HEADER trigger and
  // not "whatever opened the dialog": the empty-state CTA unmounts the instant
  // the first comp lands, so an opener-based restore would drop focus onto
  // <body> at exactly the moment the action succeeded.
  const triggerRef = useRef<TamaguiElement | null>(null);

  const compsQuery = trpc.comp.list.useQuery(
    { eventId, limit: COMP_LEDGER_LIMIT, offset: 0 },
    {
      enabled: !!eventId,
      staleTime: 15_000,
      placeholderData: keepPreviousData,
    },
  );

  const allRows: CompRow[] = useMemo(() => {
    const items = compsQuery.data?.items;
    if (!items?.length) return [];
    return items.map((item) => ({
      ...item,
      occurredAt: new Date(item.occurredAt),
    }));
  }, [compsQuery.data?.items]);

  const rows = useMemo(
    () =>
      originFilter ? allRows.filter((row) => row.origin === originFilter) : allRows,
    [allRows, originFilter],
  );

  const handleOpenIssue = useCallback(() => {
    setIssueOpen(true);
  }, []);

  const handleCloseIssue = useCallback(() => {
    setIssueOpen(false);
    // After the modal unmounts, so this wins over any restore the overlay
    // performs itself.
    requestAnimationFrame(() => {
      (triggerRef.current as HTMLElement | null)?.focus?.();
    });
  }, []);

  const handleClearFilters = useCallback(() => {
    setOriginFilter(undefined);
  }, []);

  const columns: DataTableColumn<CompRow>[] = useMemo(
    () => [
      {
        id: "recipient",
        header: String(t("admin.compRecipientColumn")),
        width: 2.4,
        truncate: false,
        sortValue: (row) => row.recipientName ?? row.recipientEmail,
        tooltipValue: (row) => row.recipientEmail,
        cell: (row) => (
          <YStack gap={2} minWidth={0}>
            <CompRecipientName row={row} />
            {row.recipientName && row.recipientEmail ? (
              <Text variant="caption" tone="muted" style={ELLIPSIS_STYLE}>
                {row.recipientEmail}
              </Text>
            ) : null}
          </YStack>
        ),
      },
      {
        id: "ticketTypes",
        header: String(t("admin.compTicketTypeColumn")),
        width: 1.7,
        truncate: false,
        cell: (row) => <CompTicketTypeLines row={row} />,
      },
      {
        // "Qty", NOT "Tickets": this is the sum over the order's ticket LINES,
        // which is not the live ticket count the attendee table shows for the
        // same order (a revoked reward keeps its line). A ledger records what
        // was ISSUED; the door list counts what can be scanned.
        id: "quantity",
        header: String(t("admin.compQuantityColumn")),
        width: 0.6,
        align: "center",
        noWrap: true,
        sortValue: (row) => row.quantity,
        cell: (row) => (
          <Text
            variant="body"
            textAlign="center"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {row.quantity}
          </Text>
        ),
      },
      {
        id: "origin",
        header: String(t("admin.compOriginColumn")),
        width: 1.3,
        noWrap: true,
        truncate: false,
        sortValue: (row) => row.origin,
        cell: (row) => <CompOriginBadge origin={row.origin} />,
      },
      {
        id: "reason",
        header: String(t("admin.compReasonColumn")),
        width: 2.2,
        truncate: false,
        tooltipValue: (row) => row.reason,
        cell: (row) => <CompReasonText row={row} />,
      },
      {
        id: "issuedBy",
        header: String(t("admin.compIssuedByColumn")),
        width: 1.5,
        truncate: false,
        sortValue: (row) => row.issuedByName,
        cell: (row) => <CompIssuerText row={row} />,
      },
      {
        // A revoked volunteer reward keeps its grant link, so it arrives here
        // as VOLUNTEER_REWARD + CANCELLED. It must not read like a live comp.
        id: "status",
        header: String(t("admin.statusColumn")),
        width: 1.2,
        noWrap: true,
        truncate: false,
        sortValue: (row) => row.status,
        cell: (row) => (
          <Badge tone={getStatusBadgeTone(row.status)} size="sm">
            {row.status.replaceAll("_", " ")}
          </Badge>
        ),
      },
      {
        id: "occurredAt",
        header: String(t("admin.dateColumn")),
        width: 1.6,
        noWrap: true,
        sortValue: (row) => row.occurredAt,
        cell: (row) => (
          // nowrap on the Text itself: `noWrap` styles the <td>, and Tamagui's
          // web Text base sets `white-space: pre-wrap` on the element.
          <Text variant="caption" tone="muted" style={{ whiteSpace: "nowrap" }}>
            {fmtDate(fmt, row.occurredAt)}
          </Text>
        ),
      },
    ],
    [t, fmt],
  );

  const isFiltered = originFilter !== undefined;
  const total = compsQuery.data?.pageInfo?.total ?? 0;
  const shownCount = compsQuery.data?.items?.length ?? 0;
  const hasMore = compsQuery.data?.pageInfo?.hasNextPage ?? false;

  const countLabel = compsQuery.isLoading
    ? String(t("common.loading"))
    : isFiltered
      ? String(t("admin.nResults", { count: rows.length }))
      : String(t("admin.nComps", { count: total }));

  return (
    <EventOpsShell
      title={String(t("admin.compTicketsTitle"))}
      purpose={String(t("admin.opsCompTicketsLedgerPurpose"))}
      actions={
        canManage ? (
          <Button
            ref={triggerRef}
            variant="primary"
            size="$3"
            onPress={handleOpenIssue}
            testID="comp-issue-open"
          >
            <Gift size={16} aria-hidden />
            {String(t("admin.compIssueAction"))}
          </Button>
        ) : null
      }
      filters={
        // No "All" chip — FilterChips' convention is that `undefined` IS the
        // default scope, and a permanently-selected default chip is noise.
        <FilterRow hasActiveFilters={isFiltered} onClearAll={handleClearFilters}>
          <FilterChips<CompOrigin>
            options={COMP_ORIGINS.map((value) => ({
              value,
              label: String(
                t(
                  value === "VOLUNTEER_REWARD"
                    ? "admin.compOriginVolunteerReward"
                    : "admin.compOriginHandIssued",
                ),
              ),
            }))}
            selected={originFilter}
            onSelect={setOriginFilter}
            ariaLabel={String(t("admin.compOriginColumn"))}
          />
        </FilterRow>
      }
    >
      {compsQuery.isError ? (
        <AdminTableErrorState
          message={`${String(t("admin.compLoadFailed"))} ${formatErrorMessage(
            compsQuery.error,
          )}`}
          onRetry={() => {
            void compsQuery.refetch();
          }}
          testId="comps-table-error"
        />
      ) : (
        <YStack flex={1} minHeight={0}>
          <ActionBar
            onRefresh={() => {
              void compsQuery.refetch();
            }}
            countLabel={countLabel}
          />

          {hasMore ? (
            <Text variant="caption" tone="muted" paddingVertical="$2">
              {String(
                t("admin.compLedgerCapped", { count: shownCount, total }),
              )}
            </Text>
          ) : null}

          <TableContainer>
            <DataTable
              columns={columns}
              rows={rows}
              getRowKey={(row) => row.orderId}
              isLoading={compsQuery.isLoading}
              clientSort
              renderMobileCard={(row) => <CompMobileCard row={row} />}
              emptyState={
                isFiltered ? (
                  <NoResults
                    title={String(t("admin.compNoMatchesTitle"))}
                    onClearFilters={handleClearFilters}
                  />
                ) : (
                  <YStack
                    padding="$8"
                    alignItems="center"
                    justifyContent="center"
                    gap="$3"
                  >
                    <Text variant="h4" weight="bold" textAlign="center">
                      {String(t("admin.compNoneYetTitle"))}
                    </Text>
                    <Text
                      variant="body"
                      tone="muted"
                      textAlign="center"
                      maxWidth={360}
                    >
                      {String(t("admin.compNoneYetDescription"))}
                    </Text>
                    {/* Only offered to someone the server would actually let
                        issue — and `secondary`, because the header trigger is
                        this viewport's one primary. Its label differs from the
                        header's on purpose: two buttons sharing one accessible
                        name is ambiguous for screen-reader and voice users. */}
                    {canManage ? (
                      <Button
                        variant="secondary"
                        size="$3"
                        onPress={handleOpenIssue}
                        testID="comp-issue-empty"
                      >
                        <Gift size={16} aria-hidden />
                        {String(t("admin.compIssueFirstAction"))}
                      </Button>
                    ) : null}
                  </YStack>
                )
              }
              testIdBase="comps-table"
            />
          </TableContainer>
        </YStack>
      )}

      {canManage ? (
        <IssueCompDialog
          eventId={eventId}
          open={issueOpen}
          onClose={handleCloseIssue}
        />
      ) : null}
    </EventOpsShell>
  );
}

CompTicketsTab.displayName = "CompTicketsTab";
