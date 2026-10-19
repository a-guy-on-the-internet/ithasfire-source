"use client";

import { useMemo, useState, useCallback } from "react";
import { styled, YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Button,
  Text,
  Badge,
  useTranslations,
} from "@th/ui";
import {
  AlertTriangle,
  Trash2,
  RefreshCw,
  X,
  ExternalLink,
  Copy,
  ChevronDown,
  Play,
} from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { truncateProviderId } from "@/lib/format";
import { DlqMobileCard } from "./_components/DlqMobileCard";

const Container = styled(YStack, {
  padding: 24,
  gap: 20,
  maxWidth: 1400,
  width: "100%",
  marginHorizontal: "auto",
});

interface DlqRow {
  stripeEventId: string;
  eventType: string;
  payload: string;
  error: string;
  receivedAt: string;
}

export default function WebhookDlqPage() {
  const t = useTranslations();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const query = trpc.platform.listWebhookDlq.useQuery({ limit: 50 });
  const removeMutation = trpc.platform.removeWebhookDlqItem.useMutation({
    onSuccess: () => query.refetch(),
  });
  // Re-drives the stored event through the real webhook dispatch. On success
  // the server removes the row; on failure it stays put with the new error, so
  // a failing replay loop is visible rather than silently draining the queue.
  const [replayError, setReplayError] = useState<string | null>(null);
  const replayMutation = trpc.platform.replayWebhookDlqItem.useMutation({
    onSuccess: (res) => {
      setReplayError(res.ok ? null : (res.error ?? "Replay failed"));
      void query.refetch();
    },
    onError: (err) => setReplayError(formatErrorMessage(err, t)),
  });
  const replay = useCallback(
    (stripeEventId: string) => {
      setReplayError(null);
      replayMutation.mutate({ stripeEventId });
    },
    [replayMutation],
  );

  const rows: DlqRow[] = useMemo(() => query.data?.items ?? [], [query.data]);

  const columns: DataTableColumn<DlqRow>[] = useMemo(
    () => [
      {
        id: "stripeEventId",
        header: "Event ID",
        cell: (row) => (
          <Text
            variant="code"
            fontSize={12}
            color="$accent"
            cursor="pointer"
            textDecorationLine="underline"
            onPress={() =>
              window.open(
                `https://dashboard.stripe.com/events/${row.stripeEventId}`,
                "_blank",
              )
            }
          >
            {truncateProviderId(row.stripeEventId)}
          </Text>
        ),
        width: 170,
      },
      {
        id: "eventType",
        header: "Type",
        cell: (row) => (
          <Badge tone="neutral" size="sm">
            {row.eventType}
          </Badge>
        ),
        width: 250,
      },
      {
        id: "error",
        header: "Error",
        cell: (row) => (
          <Text variant="body" fontSize={12} color="$danger" truncate>
            {row.error.slice(0, 80)}
            {row.error.length > 80 ? "..." : ""}
          </Text>
        ),
        width: 300,
      },
      {
        id: "receivedAt",
        header: "Received",
        cell: (row) => (
          <Text variant="body" fontSize={13}>
            {new Date(row.receivedAt).toLocaleString()}
          </Text>
        ),
        width: 180,
      },
      {
        id: "actions",
        header: "",
        // Every accessible name here carries the FULL Stripe event id.
        //
        // These are icon-only buttons repeated once per row, so a static label
        // gave ~19 controls named "Replay event" and another ~19 named "Remove
        // from DLQ" on one page — one of them destructive, none distinguishable
        // by a screen reader. The full id (not the truncated display form) is
        // the only value guaranteed unique: it is the Redis hash key AND the
        // sorted-set member, so the queue physically cannot hold two rows that
        // share one. Nothing else on the row is safe — `eventType` repeats
        // constantly, `error` repeats whenever one cause fails several events,
        // and `receivedAt` is millisecond-resolution wall clock.
        //
        // Icon-only means there is no visible text to contradict, so WCAG 2.5.3
        // (Label in Name) does not constrain the wording here. It DOES constrain
        // the text buttons in `DlqDetail` — see the note there.
        cell: (row) => (
          <XStack gap={4}>
            <Button
              variant={expandedIds.has(row.stripeEventId) ? "primary" : "ghost"}
              size="$1"
              aria-label={`Toggle detail for event ${row.stripeEventId}`}
              aria-expanded={expandedIds.has(row.stripeEventId)}
              onPress={() => toggleExpand(row.stripeEventId)}
            >
              <ChevronDown
                size={14}
                style={{
                  transition: "transform 0.2s",
                  transform: expandedIds.has(row.stripeEventId)
                    ? "rotate(180deg)"
                    : undefined,
                }}
              />
            </Button>
            <Button
              variant="ghost"
              size="$1"
              aria-label={`Replay event ${row.stripeEventId}`}
              disabled={replayMutation.isPending}
              onPress={() => replay(row.stripeEventId)}
            >
              <Play size={14} />
            </Button>
            <Button
              variant="ghost"
              size="$1"
              aria-label={`Remove event ${row.stripeEventId} from DLQ`}
              disabled={removeMutation.isPending}
              onPress={() =>
                removeMutation.mutate({ stripeEventId: row.stripeEventId })
              }
            >
              <Trash2 size={14} />
            </Button>
          </XStack>
        ),
        width: 140,
      },
    ],
    [expandedIds, toggleExpand, removeMutation, replayMutation, replay],
  );

  return (
    <Container>
      {/* Header — wraps so the refresh control never overflows at 360px */}
      <XStack
        justifyContent="space-between"
        alignItems="center"
        flexWrap="wrap"
        gap={8}
      >
        <XStack gap={12} alignItems="center">
          <AlertTriangle size={24} />
          <Text variant="h2" tag="h1" fontSize={22}>
            Webhook DLQ
          </Text>
          {query.data?.count != null && (
            <Badge tone={query.data.count > 0 ? "danger" : "success"} size="sm">
              {query.data.count}
            </Badge>
          )}
        </XStack>
        <Button variant="ghost" size="$1" onPress={() => query.refetch()}>
          <RefreshCw size={14} aria-hidden />
          Refresh
        </Button>
      </XStack>

      <Text variant="body" fontSize={14} tone="muted">
        Failed Stripe webhook events captured for investigation and replay.
        Events are kept for 30 days. Replay re-runs the event through the real
        handlers: no double-charges or double-payouts — order, ledger and
        dispute writes are all keyed — but non-money side effects can duplicate
        (receipt emails after ~2 minutes, refund-anomaly audit rows).
      </Text>

      {replayError && (
        <Text color="$danger" variant="body">
          Replay failed: {replayError}
        </Text>
      )}

      {query.isError && (
        <Text color="$danger" variant="body">
          {formatErrorMessage(query.error)}
        </Text>
      )}

      {rows.length === 0 && !query.isLoading && (
        <YStack padding={40} alignItems="center">
          <Text variant="body" tone="muted">
            No failed webhook events
          </Text>
        </YStack>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.stripeEventId}
        isLoading={query.isLoading}
        onRowPress={(row) => toggleExpand(row.stripeEventId)}
        // Borderless page-flow table with no scrolling ancestor —
        // scoped horizontal panning via DataTable's own wrapper.
        scrollContainer
        // Card mode drops the columns (incl. the expand/replay/delete buttons
        // in the actions column). The card press still toggles DlqDetail, which
        // carries the Stripe link, full error/payload, and BOTH the replay and
        // remove actions below — so on-call staff keep every action on a phone.
        // Verified at 320px: tapping a card reveals both at 44px.
        renderMobileCard={(row) => <DlqMobileCard row={row} />}
        renderExpandedRow={(row) =>
          expandedIds.has(row.stripeEventId) ? (
            <DlqDetail
              row={row}
              onClose={() => toggleExpand(row.stripeEventId)}
              onRemove={() =>
                removeMutation.mutate({ stripeEventId: row.stripeEventId })
              }
              // Scoped to THIS row, not `mutation.isPending`. `expandedIds` is
              // a Set, so several panels render at once and a page-level flag
              // made every open panel swap its label to "Replaying..." —
              // visibly, and (once the accessible names carried the event id)
              // as an affirmative claim that evt_B was replaying when only
              // evt_A was. On a money-adjacent control, announced to exactly
              // the screen-reader operator these labels exist for.
              removePending={
                removeMutation.isPending &&
                removeMutation.variables?.stripeEventId === row.stripeEventId
              }
              onReplay={() => replay(row.stripeEventId)}
              replayPending={
                replayMutation.isPending &&
                replayMutation.variables?.stripeEventId === row.stripeEventId
              }
            />
          ) : null
        }
      />
    </Container>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DLQ Detail Panel
// ─────────────────────────────────────────────────────────────────────────────

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <XStack
      justifyContent="space-between"
      alignItems="flex-start"
      paddingVertical={4}
    >
      <Text variant="caption" tone="muted" fontSize={12} minWidth={120}>
        {label}
      </Text>
      {children}
    </XStack>
  );
}

function DlqDetail({
  row,
  onClose,
  onRemove,
  removePending,
  onReplay,
  replayPending,
}: {
  row: DlqRow;
  onClose: () => void;
  onRemove: () => void;
  removePending: boolean;
  onReplay: () => void;
  replayPending: boolean;
}) {
  let formattedPayload: string;
  try {
    formattedPayload = JSON.stringify(JSON.parse(row.payload), null, 2);
  } catch {
    formattedPayload = row.payload;
  }

  return (
    <YStack
      padding={20}
      gap={16}
      backgroundColor="$backgroundStrong"
      borderTopWidth={1}
      borderBottomWidth={1}
      borderColor="$borderColor"
    >
      <XStack justifyContent="space-between" alignItems="center">
        <XStack gap={8} alignItems="center">
          <Text variant="h4" fontSize={16} weight="bold">
            Event Detail
          </Text>
          <Badge tone="danger" size="sm">
            {row.eventType}
          </Badge>
        </XStack>
        {/* Also per-row: several panels can be open at once, so a static
            "Close" repeats once per panel. Same reason as the action buttons
            above — icon-only, so no visible text constrains the wording. */}
        <Button
          variant="ghost"
          size="$1"
          aria-label={`Close detail for event ${row.stripeEventId}`}
          onPress={onClose}
        >
          <X size={16} />
        </Button>
      </XStack>

      <YStack gap={2}>
        <Text
          variant="caption"
          tone="muted"
          fontSize={11}
          textTransform="uppercase"
        >
          Info
        </Text>
        <DetailRow label="Event ID">
          <XStack gap={6} alignItems="center">
            <Text variant="code" fontSize={12}>
              {row.stripeEventId}
            </Text>
            <Button
              variant="ghost"
              size="$1"
              icon
              aria-label={`Copy event ID ${row.stripeEventId}`}
              onPress={() =>
                void navigator.clipboard.writeText(row.stripeEventId)
              }
            >
              <Copy size={12} />
            </Button>
            <Text
              variant="code"
              fontSize={11}
              color="$accent"
              cursor="pointer"
              textDecorationLine="underline"
              onPress={() =>
                window.open(
                  `https://dashboard.stripe.com/events/${row.stripeEventId}`,
                  "_blank",
                )
              }
            >
              <ExternalLink size={12} />
            </Text>
          </XStack>
        </DetailRow>
        <DetailRow label="Received">
          <Text variant="body" fontSize={13}>
            {new Date(row.receivedAt).toLocaleString()}
          </Text>
        </DetailRow>
      </YStack>

      <YStack gap={4}>
        <Text
          variant="caption"
          tone="muted"
          fontSize={11}
          textTransform="uppercase"
        >
          Error
        </Text>
        <YStack
          backgroundColor="$background"
          borderRadius={0}
          padding={12}
          borderLeftWidth={3}
          borderLeftColor="$danger"
        >
          <Text
            variant="code"
            fontSize={12}
            color="$danger"
            whiteSpace="pre-wrap"
          >
            {row.error}
          </Text>
        </YStack>
      </YStack>

      <YStack gap={4}>
        <Text
          variant="caption"
          tone="muted"
          fontSize={11}
          textTransform="uppercase"
        >
          Raw Event Payload
        </Text>
        <YStack
          backgroundColor="$background"
          borderRadius={0}
          padding={12}
          maxHeight={400}
          overflow="scroll"
        >
          <Text variant="code" fontSize={11} whiteSpace="pre-wrap">
            {formattedPayload}
          </Text>
        </YStack>
      </YStack>

      {/* Replay + Remove — also live in the table's actions column, but that
          column is not rendered in card mode (<600px), so they must be
          reachable here for on-call staff working from a phone. 44px touch
          targets. (Verified: at 320px the card press expands this panel and
          both buttons render at 44px.)

          The accessible names carry the event id AND ", from event detail".
          The id alone is not enough: a row can be expanded while its own icon
          buttons are still on screen, so `Replay event <id>` here would be
          byte-identical to the row button's name (measured: 56 controls, 55
          distinct, 1 duplicate pair). Several rows can be expanded at once, so
          the panel suffix has to be combined with the id, not used instead.

          Unlike the icon buttons, these have VISIBLE text, so WCAG 2.5.3
          (Label in Name) requires the visible string to be contained in the
          accessible name: "Remove from DLQ" → "Remove from DLQ, event evt_1…",
          never "Remove event evt_1… from DLQ" (which is right for the icon
          button, and would be a 2.5.3 failure here). The pending states change
          the visible text, so their names change with it. */}
      <XStack gap={8} flexWrap="wrap">
        <Button
          variant="primary"
          size="$2"
          minHeight={44}
          aria-label={
            replayPending
              ? `Replaying... event ${row.stripeEventId}, from event detail`
              : `Replay event ${row.stripeEventId}, from event detail`
          }
          disabled={replayPending}
          onPress={onReplay}
        >
          <Play size={14} aria-hidden />
          {replayPending ? "Replaying..." : "Replay event"}
        </Button>
        <Button
          variant="secondary"
          size="$2"
          minHeight={44}
          aria-label={
            removePending
              ? `Removing... event ${row.stripeEventId}, from event detail`
              : `Remove from DLQ, event ${row.stripeEventId}, from event detail`
          }
          disabled={removePending}
          onPress={onRemove}
        >
          <Trash2 size={14} aria-hidden />
          {removePending ? "Removing..." : "Remove from DLQ"}
        </Button>
      </XStack>
    </YStack>
  );
}
