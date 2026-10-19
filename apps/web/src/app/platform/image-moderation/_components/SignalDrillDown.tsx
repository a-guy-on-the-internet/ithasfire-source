"use client";

import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  DataTable,
  Spinner,
  Text,
  type DataTableColumn,
} from "@th/ui";
import { Lock, RotateCcw, ShieldOff, X } from "lucide-react";

import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { useMinViewportWidth } from "@/hooks/useMinViewportWidth";
import { truncateId } from "@/lib/format";
import { PlatformSectionTitle } from "../../_components/PlatformPageParts";

import {
  NO_VALUE,
  ageBasis,
  ageInstant,
  canRescanRow,
  canResolveSignal,
  canResolveWithThreshold,
  canWriteOps,
  formatAgo,
  kindLabel,
  opsWriteLockReason,
  signalEmptyLabel,
  signalShowsLastError,
  signalShowsRowActions,
  signalShowsStorageKey,
  signalTitle,
  signalWindowLabel,
  statusTone,
  storageKeyCell,
  subjectCell,
  type ModerationRecordKind,
  type ModerationRecordStatus,
  type ModerationSubjectType,
  type OpsWriteAccess,
  type QueueSignal,
  type QueueThresholds,
} from "./image-moderation-ops.helpers";

/**
 * The rows behind ONE tile.
 *
 * NO IMAGE PREVIEW, IN ANY BUCKET, EVER. Not an `<img>`, not a
 * `background-image`, not a link that resolves to bytes. The procedure
 * deliberately returns no image URL because this page admits DEVELOPERs who
 * are not moderators and one of these buckets is un-reviewed flagged content.
 * The `awaitingReview` bucket additionally drops both the STORAGE KEY column
 * (a key plus the non-secret public base URL IS the image) and the LAST ERROR
 * column (unfiltered third-party provider text on the one bucket whose detail
 * we withhold) — see `signalShowsStorageKey` / `signalShowsLastError`. If a
 * thumbnail ever feels necessary here, the answer is the "Open review queue"
 * link in the header.
 *
 * TWO OPERATOR ACTIONS RIDE HERE, BOTH ADMIN-ONLY. The page's read gate is
 * ADMIN *or DEVELOPER*; `resolveUnscannable` and `rescanImage` are ADMIN alone,
 * because reading provider telemetry at 3am and mutating moderation state are
 * not the same privilege. The client gate ERRS CLOSED (locked while pending,
 * locked on an unreadable role) so a DEVELOPER never sees an enabled button
 * that will 403, and both actions confirm before they fire — one is terminal
 * and the other discards provenance.
 *
 * WIDTH DISCIPLINE. Tamagui's web Stack defaults to `flex-shrink: 0`, so a
 * container without an explicit `flexShrink={1}` + `minWidth={0}` takes its
 * content width and can never be compressed — which ALSO strands every
 * shrinkable descendant, because their containing block is already as wide as
 * the content and their own `flex-wrap` has no narrower line box to break
 * into. That chain is what squeezed this panel's heading to 108px and split
 * "OVERDUE FOR SCAN" mid-word at 320px. Every container here is explicitly
 * shrinkable; do not remove those props.
 */

const TABULAR: CSSProperties = { fontVariantNumeric: "tabular-nums" };
const NOWRAP: CSSProperties = { whiteSpace: "nowrap" };
/** A storage key is one long unbroken token; never let it widen the page. */
const BREAK_ANYWHERE: CSSProperties = { overflowWrap: "anywhere" };

type PendingAction = { kind: "resolve" | "rescan"; recordId: string };

/**
 * The two operator actions, per row.
 *
 * BOTH ARE ADMIN-ONLY while the page itself is ADMIN **or DEVELOPER** — so the
 * only thing that could tell an operator whether a press will work is this
 * gate, and it errs CLOSED: a DEVELOPER (the exact persona this page exists
 * for) must never see an enabled button that 403s. `locked` is the established
 * way to say "this exists and isn't yours" — the action stays visible, which is
 * the point, and its reason rides the accessible name.
 *
 * WHICH ROWS GET WHICH. `Resolve` only appears in `degradedExhausted`, the
 * bucket whose rows are past the requeue cap and which no automation will ever
 * touch again. `Rescan` appears on any row in a MACHINE state — never on one a
 * person decided, because re-scanning would discard that decision.
 *
 * The accessible name carries the FULL record id rather than the truncated one
 * on screen. Thirty rows of "Rescan" is thirty identical accessible names, and
 * eight hex characters is a collision waiting for the day it matters.
 */
function RowActions({
  row,
  showsResolve,
  canWrite,
  thresholdOk,
  isPending,
  size,
  onRequest,
}: {
  row: QueueSignalRow;
  showsResolve: boolean;
  canWrite: boolean;
  thresholdOk: boolean;
  isPending: boolean;
  size: "$2" | "$3";
  onRequest: (action: PendingAction) => void;
}) {
  const rescannable = canRescanRow(row);
  const resolveLocked = !canWrite || !thresholdOk;

  if (!rescannable && !showsResolve) {
    return (
      <Text variant="caption" tone="muted">
        {NO_VALUE}
      </Text>
    );
  }

  return (
    <XStack gap="$1" flexWrap="wrap" flexShrink={1} minWidth={0}>
      {showsResolve ? (
        <Button
          size={size}
          variant="secondary"
          locked={resolveLocked}
          // `aria-busy` + `aria-disabled` rather than `disabled`: `disabled`
          // applies `disabledStyle` (opacity .45), which dims the very spinner
          // that IS the progress feedback. The press is guarded below.
          aria-busy={isPending || undefined}
          aria-disabled={isPending || undefined}
          // ROLE FIRST. Reporting the requeue cap to someone who would be
          // blocked by the role regardless sends them to fix the wrong thing.
          aria-label={
            !canWrite
              ? `Resolve record ${row.recordId} — needs the platform admin role`
              : !thresholdOk
                ? `Resolve record ${row.recordId} — the requeue cap in view is below the automation's cap`
                : `Resolve record ${row.recordId} as unscannable`
          }
          onPress={() => {
            if (isPending || resolveLocked) return;
            onRequest({ kind: "resolve", recordId: row.recordId });
          }}
        >
          {isPending ? (
            <Spinner size="small" />
          ) : resolveLocked ? (
            <Lock size={13} aria-hidden />
          ) : (
            <ShieldOff size={13} aria-hidden />
          )}
          Resolve
        </Button>
      ) : null}

      {rescannable ? (
        <Button
          size={size}
          variant="secondary"
          locked={!canWrite}
          aria-busy={isPending || undefined}
          aria-disabled={isPending || undefined}
          aria-label={
            canWrite
              ? `Re-scan record ${row.recordId}`
              : `Re-scan record ${row.recordId} — needs the platform admin role`
          }
          onPress={() => {
            if (isPending || !canWrite) return;
            onRequest({ kind: "rescan", recordId: row.recordId });
          }}
        >
          {isPending ? (
            <Spinner size="small" />
          ) : canWrite ? (
            <RotateCcw size={13} aria-hidden />
          ) : (
            <Lock size={13} aria-hidden />
          )}
          Rescan
        </Button>
      ) : null}
    </XStack>
  );
}

export type QueueSignalRow = {
  recordId: string;
  storageKey?: string;
  kind: ModerationRecordKind;
  status: ModerationRecordStatus;
  subjectType: ModerationSubjectType | null;
  subjectId: string | null;
  degraded: boolean;
  requeues: number;
  attempts: number;
  /**
   * ABSENT for `awaitingReview` (the server withholds it for that bucket) and
   * legitimately NULL on any row that never failed. Optional AND nullable, so
   * the two cases stay distinguishable and `String(undefined)` is unreachable.
   */
  lastError?: string | null;
  moderatedAt: Date | null;
  nextAttemptAt: Date;
};

export type SignalDrillDownProps = {
  signal: QueueSignal;
  thresholds: QueueThresholds;
  rows: QueueSignalRow[];
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  onClose: () => void;
  /** Rendered as "now" for every age cell — one instant for the whole table. */
  now: Date;
  /**
   * Whether this viewer may run the two write actions. ADMIN only — narrower
   * than the ADMIN/DEVELOPER gate that let them read the page — and it ERRS
   * CLOSED, including while the role check is still in flight.
   */
  writeAccess: OpsWriteAccess;
  /** `snapshot.thresholds.maxRequeues`, echoed into `resolveUnscannable`. */
  maxRequeues: number;
  onResolve: (recordId: string) => void;
  onRescan: (recordId: string) => void;
  /**
   * Records with a mutation in flight. A SET, because two rows can be acted on
   * at once and a single id silently erased the first one's spinner.
   */
  pendingRecords: ReadonlySet<string>;
};

export function SignalDrillDown({
  signal,
  thresholds,
  rows,
  isLoading,
  isError,
  errorMessage,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRetry,
  onClose,
  now,
  writeAccess,
  maxRequeues,
  onResolve,
  onRescan,
  pendingRecords,
}: SignalDrillDownProps) {
  const basis = ageBasis(signal);
  const showsStorageKey = signalShowsStorageKey(signal);
  const showsLastError = signalShowsLastError(signal);
  const title = signalTitle(signal);

  const canWrite = canWriteOps(writeAccess);
  const lockReason = opsWriteLockReason(writeAccess);
  const showsActions = signalShowsRowActions(signal);
  const showsResolve = canResolveSignal(signal);
  /**
   * `resolveUnscannable` REJECTS a `maxRequeues` below the automation's own cap
   * at the boundary — a client that could pass 1 would terminally resolve rows
   * the requeue job had not finished trying, which is what "exhausted" exists
   * to rule out. The page echoes the snapshot's cap, so this can only be false
   * if someone loads the snapshot with a lower knob; the button locks with a
   * reason rather than throwing on press.
   */
  const thresholdOk = canResolveWithThreshold(maxRequeues);

  /**
   * WHERE THE ACTIONS COLUMN SITS IS A REACHABILITY QUESTION, NOT A STYLE ONE.
   *
   * `DataTable` only switches to cards below 600px, so between roughly 600 and
   * 900 this renders as a full table inside a horizontal scroll container:
   * measured at a 700px viewport the table was 623.5px in a 534px wrapper and
   * `ACTIONS` sat at left 620 → right 707.5 — entirely inside the hidden
   * region. The scroll works, but the two actions this panel exists to offer
   * were invisible until you discovered a scrollbar inside a table.
   *
   * Below the threshold the column moves to SECOND, right after Kind, so it is
   * always in the first ~200px. Nothing is dropped and no data is hidden; only
   * the order changes. Above it everything fits and the conventional trailing
   * position is kept.
   */
  const hasRoomForTrailingActions = useMinViewportWidth(900);

  const [confirming, setConfirming] = useState<PendingAction | null>(null);

  const requestAction = useCallback((action: PendingAction) => {
    setConfirming(action);
  }, []);

  /**
   * Client-side sorting is only offered once EVERY row is in hand.
   *
   * Sorting a partially-loaded infinite list answers the triage question
   * wrongly and silently: with 80 holds loaded 30 at a time, "oldest
   * moderated first" returns the oldest of the newest 30 and presents it as
   * the oldest hold. Until `hasNextPage` is false the server's per-bucket
   * order is the only honest one, so the sort affordance simply is not there.
   */
  const canSort = !hasNextPage;

  const columns = useMemo<DataTableColumn<QueueSignalRow>[]>(() => {
    const base: DataTableColumn<QueueSignalRow>[] = [
      {
        id: "kind",
        header: "Kind",
        width: 14,
        noWrap: true,
        cell: (row) => (
          <Badge tone="neutral" size="sm">
            {kindLabel(row.kind)}
          </Badge>
        ),
      },
      {
        id: "subject",
        header: "Subject",
        width: 20,
        truncate: false,
        tooltipValue: (row) => row.subjectId ?? undefined,
        cell: (row) => {
          const subject = subjectCell(row);
          if (!subject.type && !subject.id) {
            return (
              <Text variant="caption" tone="muted">
                {NO_VALUE}
              </Text>
            );
          }
          return (
            <YStack gap={2} minWidth={0}>
              <Text variant="overline" tone="muted">
                {subject.type ?? NO_VALUE}
              </Text>
              <Text variant="code" fontSize={11} tone="muted" style={NOWRAP}>
                {subject.id ? truncateId(subject.id) : NO_VALUE}
              </Text>
            </YStack>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        width: 14,
        truncate: false,
        cell: (row) => (
          <XStack gap="$1" alignItems="center" flexWrap="wrap" minWidth={0}>
            <Badge tone={statusTone(row.status)} size="sm">
              {row.status}
            </Badge>
            {row.degraded ? (
              <Badge tone="warning" size="sm" variant="outline">
                DEGRADED
              </Badge>
            ) : null}
          </XStack>
        ),
      },
      {
        id: "age",
        header: basis.header,
        width: 13,
        noWrap: true,
        sortValue: (row) => ageInstant(signal, row),
        tooltipValue: (row) => ageInstant(signal, row)?.toLocaleString(),
        cell: (row) => {
          const at = ageInstant(signal, row);
          return (
            <Text variant="caption" tone="muted" style={TABULAR}>
              {at ? formatAgo(at, now) : NO_VALUE}
            </Text>
          );
        },
      },
      {
        id: "retries",
        header: "Requeues / attempts",
        width: 12,
        noWrap: true,
        sortValue: (row) => row.requeues * 1000 + row.attempts,
        cell: (row) => (
          <Text variant="caption" style={TABULAR}>
            {row.requeues} / {row.attempts}
          </Text>
        ),
      },
    ];

    if (showsLastError) {
      base.push({
        id: "lastError",
        header: "Last error",
        width: 22,
        tooltipValue: (row) => row.lastError ?? undefined,
        cell: (row) =>
          row.lastError ? (
            <Text variant="caption" color="$danger" truncate>
              {row.lastError}
            </Text>
          ) : (
            <Text variant="caption" tone="muted">
              {NO_VALUE}
            </Text>
          ),
      });
    }

    if (showsStorageKey) {
      base.push({
        id: "storageKey",
        header: "Storage key",
        width: 22,
        tooltipValue: (row) =>
          storageKeyCell(signal, row.storageKey) ?? undefined,
        cell: (row) => {
          // NEVER `String(row.storageKey)` — the field is genuinely absent for
          // `awaitingReview` and may be absent on a degraded row here too.
          const key = storageKeyCell(signal, row.storageKey);
          return (
            <Text
              variant="code"
              fontSize={11}
              tone="muted"
              truncate
              style={BREAK_ANYWHERE}
            >
              {key ?? NO_VALUE}
            </Text>
          );
        },
      });
    }

    if (showsActions) {
      const actionsColumn: DataTableColumn<QueueSignalRow> = {
        id: "actions",
        header: "Actions",
        width: 16,
        truncate: false,
        // The column is not sortable and must not offer a sort affordance:
        // there is nothing to order buttons by.
        sortable: false,
        cell: (row) => (
          <RowActions
            row={row}
            showsResolve={showsResolve}
            canWrite={canWrite}
            thresholdOk={thresholdOk}
            isPending={pendingRecords.has(row.recordId)}
            size="$2"
            onRequest={requestAction}
          />
        ),
      };
      // `base[0]` is Kind, so index 1 puts Actions directly after it.
      if (hasRoomForTrailingActions) base.push(actionsColumn);
      else base.splice(1, 0, actionsColumn);
    }

    return base;
  }, [
    basis.header,
    canWrite,
    hasRoomForTrailingActions,
    now,
    pendingRecords,
    requestAction,
    showsActions,
    showsLastError,
    showsResolve,
    showsStorageKey,
    signal,
    thresholdOk,
  ]);

  const renderMobileCard = useMemo(
    () => (row: QueueSignalRow) => {
      const subject = subjectCell(row);
      const at = ageInstant(signal, row);
      const key = storageKeyCell(signal, row.storageKey);
      return (
        <YStack gap="$2" flexShrink={1} minWidth={0}>
          <XStack gap="$2" alignItems="center" flexWrap="wrap" minWidth={0}>
            <Badge tone="neutral" size="sm">
              {kindLabel(row.kind)}
            </Badge>
            <Badge tone={statusTone(row.status)} size="sm">
              {row.status}
            </Badge>
            {row.degraded ? (
              <Badge tone="warning" size="sm" variant="outline">
                DEGRADED
              </Badge>
            ) : null}
          </XStack>
          <Text variant="caption" tone="muted">
            {subject.type ?? NO_VALUE} ·{" "}
            {subject.id ? truncateId(subject.id) : NO_VALUE}
          </Text>
          <Text variant="caption" tone="muted" style={TABULAR}>
            {basis.header}: {at ? formatAgo(at, now) : NO_VALUE} ·{" "}
            {row.requeues} / {row.attempts}
          </Text>
          {showsLastError && row.lastError ? (
            <Text variant="caption" color="$danger">
              {row.lastError}
            </Text>
          ) : null}
          {key ? (
            <Text
              variant="code"
              fontSize={11}
              tone="muted"
              style={BREAK_ANYWHERE}
            >
              {key}
            </Text>
          ) : null}
          {showsActions ? (
            <RowActions
              row={row}
              showsResolve={showsResolve}
              canWrite={canWrite}
              thresholdOk={thresholdOk}
              isPending={pendingRecords.has(row.recordId)}
              size="$3"
              onRequest={requestAction}
            />
          ) : null}
        </YStack>
      );
    },
    [
      basis.header,
      canWrite,
      now,
      pendingRecords,
      requestAction,
      showsActions,
      showsLastError,
      showsResolve,
      signal,
      thresholdOk,
    ],
  );

  return (
    <YStack
      gap="$3"
      padding="$4"
      borderWidth={2}
      borderRadius={0}
      borderColor="$borderColor"
      backgroundColor="$surface"
      role="region"
      aria-label={`${title} rows`}
      flexShrink={1}
      minWidth={0}
    >
      <XStack
        gap="$3"
        alignItems="flex-start"
        justifyContent="space-between"
        flexShrink={1}
        minWidth={0}
      >
        <YStack gap="$1" flex={1} flexShrink={1} minWidth={0}>
          <PlatformSectionTitle>{title}</PlatformSectionTitle>
          <Text variant="caption" tone="muted">
            {signalWindowLabel(signal, thresholds)} · the exact window the tile
            counted
            {showsStorageKey
              ? ""
              : " · keys and errors withheld for this bucket"}
          </Text>
          {/* Said ONCE, here, rather than only inside thirty accessible names:
              a locked button explains itself to a screen reader and to nobody
              else. */}
          {showsActions && lockReason ? (
            <Text variant="caption" tone="muted">
              {lockReason}
            </Text>
          ) : null}
          {showsActions && showsResolve && canWrite && !thresholdOk ? (
            <Text variant="caption" tone="muted">
              Resolving is locked: the requeue cap in view ({maxRequeues}) is
              below the automation&apos;s own cap, and resolving under it would
              retire rows the requeue job has not finished trying.
            </Text>
          ) : null}
        </YStack>
        <Button
          variant="ghost"
          size="$2"
          icon
          aria-label={`Close ${title} rows`}
          onPress={onClose}
        >
          <X size={14} aria-hidden />
        </Button>
      </XStack>

      {isError ? (
        <YStack gap="$3" flexShrink={1} minWidth={0}>
          <Text variant="bodySmall" color="$danger">
            {errorMessage ?? "Could not load these rows."}
          </Text>
          <XStack>
            <Button
              variant="secondary"
              size="$3"
              // Scoped: the page can render its own "Retry" for the counts at
              // the same time, and two buttons with one accessible name doing
              // different things is a defect this repo has shipped before.
              aria-label={`Retry loading ${title} rows`}
              onPress={onRetry}
            >
              Retry
            </Button>
          </XStack>
        </YStack>
      ) : (
        <>
          <DataTable<QueueSignalRow>
            columns={columns}
            rows={rows}
            isLoading={isLoading}
            getRowKey={(row) => row.recordId}
            renderMobileCard={renderMobileCard}
            scrollContainer
            clientSort={canSort}
            emptyState={
              <YStack
                alignItems="center"
                justifyContent="center"
                padding="$5"
                minWidth={0}
              >
                {/* ONE empty line, not two. The bucket-specific sentence is
                    the informative one; "Nothing matched this window" said
                    the same thing again, less well. */}
                <Text
                  variant="bodySmall"
                  weight="bold"
                  tone="muted"
                  textAlign="center"
                >
                  {signalEmptyLabel(signal)}
                </Text>
              </YStack>
            }
          />

          {hasNextPage ? (
            <YStack gap="$2" alignItems="center" flexShrink={1} minWidth={0}>
              <Button
                variant="secondary"
                size="$3"
                aria-label={`Load more ${title} rows`}
                onPress={onLoadMore}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? <Spinner size="small" /> : null}
                Load more
              </Button>
              <Text variant="caption" tone="muted" textAlign="center">
                Sorting unlocks once every row is loaded.
              </Text>
            </YStack>
          ) : null}
        </>
      )}

      {/* One dialog for both actions. Each is a decision with a blast radius —
          one is terminal, the other discards provenance — and the page's
          established shape for that is `/platform/jobs`'s confirm. */}
      <ConfirmDialog
        open={confirming !== null}
        tone={confirming?.kind === "resolve" ? "danger" : "default"}
        title={
          confirming?.kind === "resolve"
            ? "Resolve this row as unscannable?"
            : "Send this image back for a re-scan?"
        }
        description={
          confirming?.kind === "resolve"
            ? `This marks the record ORPHANED, and that is terminal — no automation will touch it again and the image stays hidden. It is for objects the scanner has permanently failed on, never for a content decision. Record ${confirming.recordId}.`
            : confirming
              ? `This discards the machine verdict and its provenance — attempts, last error and the recorded severity — and queues the object for the drain job to score again. Anything a person decided is refused. Record ${confirming.recordId}.`
              : ""
        }
        confirmLabel={confirming?.kind === "resolve" ? "Resolve" : "Rescan"}
        // No `loading` prop: the dialog closes in the same tick it confirms,
        // so a loading flag here could never render. The in-flight state lives
        // on the row button, which stays on screen.
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (!confirming) return;
          if (confirming.kind === "resolve") onResolve(confirming.recordId);
          else onRescan(confirming.recordId);
          setConfirming(null);
        }}
      />
    </YStack>
  );
}
