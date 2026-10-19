"use client";

import { useEffect, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  DataTable,
  Spinner,
  Text,
  useFormatters,
  type DataTableColumn,
} from "@th/ui";
import { MoneyText } from "../../_components/MoneyText";
import { ShieldAlert } from "lucide-react";

import { fmtDateShort } from "@/lib/format";
import type { DeskFilter, DisputeRow } from "./DisputeDesk";
import {
  disputeReasonLabel,
  disputeStatusLabel,
  disputeStatusTone,
  dueTreatment,
  evidenceStatusLabel,
  evidenceStatusTone,
  ownerDisplay,
  type DueTreatment,
} from "./dispute-desk.helpers";

export interface DisputeQueueProps {
  rows: DisputeRow[];
  filter: DeskFilter;
  now: Date;
  isMobile: boolean;
  /** Detail panel is open beside the table — trim to the essential columns. */
  compact: boolean;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  onRetry: () => void;
  onSelect: (id: string) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
}

const ELLIPSIS = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

// Small text never sits on `accent`; overdue and due-soon use the legible
// soft rungs (the same pair OrderStatusBadge uses for its ink).
function dueColor(intent: DueTreatment["intent"]): string {
  switch (intent) {
    case "danger":
      return "$dangerSoft";
    case "warning":
      return "$warningSoft";
    default:
      return "$color";
  }
}

const EMPTY_COPY: Record<DeskFilter, { title: string; body: string }> = {
  // i18n: key pending
  open: {
    title: "No open disputes",
    body: "Nothing is waiting on evidence. New disputes appear here as soon as Stripe reports them.",
  },
  closed: {
    title: "No closed disputes",
    body: "Won, lost and closed inquiries will be listed here.",
  },
  all: {
    title: "No disputes yet",
    body: "The platform has not received a chargeback. New disputes appear here as soon as Stripe reports them.",
  },
};

export function DisputeQueue({
  rows,
  filter,
  now,
  isMobile,
  compact,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  onSelect,
  hasMore,
  isLoadingMore,
  loadMoreError,
  onLoadMore,
}: DisputeQueueProps) {
  const fmt = useFormatters();

  // `useIsMobile` is false until `matchMedia` syncs after mount, so the
  // desktop table floor must not apply on the first paint of a phone.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const tableFloor = !mounted || isMobile ? 0 : compact ? 640 : 1200;
  const actionSize = isMobile ? "$4" : "$2";

  const columns = useMemo<DataTableColumn<DisputeRow>[]>(() => {
    const all: Array<DataTableColumn<DisputeRow> & { essential?: boolean }> = [
      {
        id: "due",
        // i18n: key pending
        header: "Due",
        width: 1.1,
        noWrap: true,
        essential: true,
        cell: (row) => {
          const due = dueTreatment(row.evidenceDueBy, now, row.evidencePastDue);
          return (
            <YStack gap="$1">
              <Text
                variant="bodySmall"
                weight="bold"
                color={dueColor(due.intent)}
                fontFamily="$mono"
                style={{ letterSpacing: 0.4 }}
              >
                {due.label}
              </Text>
              {row.evidenceDueBy && (
                <Text variant="caption" tone="muted" style={ELLIPSIS}>
                  {fmtDateShort(fmt, row.evidenceDueBy)}
                </Text>
              )}
            </YStack>
          );
        },
      },
      {
        id: "amount",
        header: "Amount",
        width: 1,
        noWrap: true,
        align: "right",
        essential: true,
        cell: (row) => (
          <YStack gap="$1" alignItems="flex-end">
            <MoneyText
              cents={row.amountCents}
              currency={row.currency}
              variant="bodySmall"
              weight="bold"
              fontFamily="$mono"
              style={{ letterSpacing: 0.4 }}
            />
            {row.feeCents > 0 && (
              <Text
                variant="caption"
                tone="muted"
                fontFamily="$mono"
                style={{ whiteSpace: "nowrap" }}
              >
                +{MoneyText.format(row.feeCents, { currency: row.currency })} fee
              </Text>
            )}
          </YStack>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 1.9,
        noWrap: true,
        essential: true,
        cell: (row) => (
          <Badge tone={disputeStatusTone(row.status)} size="sm">
            {disputeStatusLabel(row.status)}
          </Badge>
        ),
      },
      {
        id: "evidence",
        header: "Evidence",
        width: 1.7,
        noWrap: true,
        essential: true,
        cell: (row) => (
          <Badge tone={evidenceStatusTone(row.evidenceStatus)} size="sm">
            {evidenceStatusLabel(row.evidenceStatus)}
          </Badge>
        ),
      },
      {
        id: "event",
        header: "Event",
        width: 2,
        essential: true,
        cell: (row) => (
          <YStack gap="$1" minWidth={0}>
            <Text
              variant="bodySmall"
              weight="semibold"
              tone={row.eventTitle ? "default" : "muted"}
              style={ELLIPSIS}
            >
              {row.eventTitle ??
                (row.orderKind === "MEMBERSHIP" ? "Membership" : "—")}
            </Text>
            {row.orderShortId && (
              <Text variant="caption" tone="muted" fontFamily="$mono">
                {row.orderShortId}
              </Text>
            )}
          </YStack>
        ),
      },
      {
        id: "buyer",
        header: "Buyer",
        width: 1.6,
        cell: (row) => (
          <Text
            variant="bodySmall"
            tone={row.buyerName ? "default" : "muted"}
            style={ELLIPSIS}
          >
            {row.buyerName ?? "Unknown buyer"}
          </Text>
        ),
      },
      {
        id: "owner",
        header: "Owner",
        width: 1.5,
        cell: (row) => {
          const owner = ownerDisplay(row);
          return (
            <YStack gap="$1" minWidth={0}>
              <Text
                variant="bodySmall"
                tone={owner.kind ? "default" : "muted"}
                style={ELLIPSIS}
              >
                {owner.name}
              </Text>
              {owner.kind && (
                <Text variant="caption" tone="muted">
                  {owner.kind === "org" ? "Group" : "Human"}
                </Text>
              )}
            </YStack>
          );
        },
      },
      {
        id: "reason",
        header: "Reason",
        width: 1.3,
        cell: (row) => (
          <Text variant="bodySmall" style={ELLIPSIS}>
            {disputeReasonLabel(row.reason)}
          </Text>
        ),
      },
      {
        id: "opened",
        header: "Opened",
        width: 1.1,
        noWrap: true,
        cell: (row) => (
          <Text variant="bodySmall" tone="muted">
            {fmtDateShort(fmt, row.createdAt)}
          </Text>
        ),
      },
    ];
    return (compact ? all.filter((c) => c.essential) : all).map(
      ({ essential: _essential, ...col }) => col,
    );
  }, [now, fmt, compact]);

  const empty = EMPTY_COPY[filter];

  return (
    <YStack gap="$3" minWidth={0}>
      {isError ? (
        <YStack
          padding="$5"
          alignItems="center"
          gap="$3"
          borderWidth={2}
          borderColor="$borderColor"
          backgroundColor="$surface"
        >
          <Text variant="bodySmall" tone="error" style={{ textAlign: "center" }}>
            {errorMessage ?? "The dispute queue could not be loaded."}
          </Text>
          <Button variant="secondary" size={actionSize} onPress={onRetry}>
            Retry loading disputes
          </Button>
        </YStack>
      ) : (
        // The table scrolls inside its own container on narrow desktop
        // windows; below 600px DataTable switches to card mode, so the page
        // itself never pans horizontally.
        <div style={{ overflowX: "auto", minWidth: 0 }}>
          <div style={{ minWidth: tableFloor }}>
            <DataTable<DisputeRow>
              columns={columns}
              rows={rows}
              getRowKey={(row) => row.id}
              caption="Disputes, sorted by evidence due date"
              isLoading={isLoading}
              onRowPress={(row) => onSelect(row.id)}
              renderMobileCard={(row) => (
                <DisputeMobileCard row={row} now={now} />
              )}
              testIdBase="dispute-desk-table"
              density="compact"
              emptyState={
                <YStack
                  padding="$8"
                  alignItems="center"
                  justifyContent="center"
                  gap="$3"
                >
                  <ShieldAlert
                    size={32}
                    color="var(--colorMuted, #5C544A)"
                    aria-hidden
                  />
                  <Text variant="h4" weight="bold">
                    {empty.title}
                  </Text>
                  <Text
                    variant="body"
                    tone="muted"
                    style={{ textAlign: "center" }}
                    maxWidth={360}
                  >
                    {empty.body}
                  </Text>
                </YStack>
              }
            />
          </div>
        </div>
      )}

      {!isError && (hasMore || loadMoreError) && (
        <YStack alignItems="center" gap="$2" paddingVertical="$2">
          {loadMoreError && (
            <Text variant="bodySmall" tone="error" style={{ textAlign: "center" }}>
              {loadMoreError}
            </Text>
          )}
          {hasMore && (
            <Button
              variant="secondary"
              size={isMobile ? "$4" : "$3"}
              onPress={onLoadMore}
              disabled={isLoadingMore}
              aria-label="Load more disputes"
            >
              {isLoadingMore ? <Spinner size="small" /> : null}
              Load more
            </Button>
          )}
        </YStack>
      )}
    </YStack>
  );
}

DisputeQueue.displayName = "DisputeQueue";

/**
 * Card-mode row (<600px). Whole card is the tap target via DataTable (which
 * owns the `role="button"` wrapper). No selected state: on mobile the detail
 * replaces the queue, so a card is never on screen while it is selected.
 */
function DisputeMobileCard({ row, now }: { row: DisputeRow; now: Date }) {
  const fmt = useFormatters();
  const due = dueTreatment(row.evidenceDueBy, now, row.evidencePastDue);
  const owner = ownerDisplay(row);
  return (
    <YStack gap="$2" padding="$3">
      <XStack justifyContent="space-between" alignItems="center" gap="$2">
        <XStack gap="$2" flexWrap="wrap" flexShrink={1}>
          <Badge tone={disputeStatusTone(row.status)} size="xs">
            {disputeStatusLabel(row.status)}
          </Badge>
          <Badge tone={evidenceStatusTone(row.evidenceStatus)} size="xs">
            {evidenceStatusLabel(row.evidenceStatus)}
          </Badge>
        </XStack>
        <Text
          variant="bodySmall"
          weight="bold"
          color={dueColor(due.intent)}
          fontFamily="$mono"
        >
          {due.label}
        </Text>
      </XStack>
      <Text variant="body" weight="semibold" style={ELLIPSIS}>
        {row.eventTitle ?? (row.orderKind === "MEMBERSHIP" ? "Membership" : "—")}
      </Text>
      <XStack justifyContent="space-between" alignItems="center" gap="$2">
        <Text variant="caption" tone="muted" style={ELLIPSIS}>
          {row.buyerName ?? "Unknown buyer"} · {owner.name}
        </Text>
        <MoneyText
          cents={row.amountCents}
          currency={row.currency}
          variant="bodySmall"
          weight="bold"
          fontFamily="$mono"
        />
      </XStack>
      <Text variant="caption" tone="muted">
        {disputeReasonLabel(row.reason)} · opened {fmtDateShort(fmt, row.createdAt)}
      </Text>
    </YStack>
  );
}
