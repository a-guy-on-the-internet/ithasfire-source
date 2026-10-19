"use client";

import { useCallback, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { styled, useTheme, YStack, XStack } from "tamagui";
import { PlatformContainer } from "../_components/PlatformPageParts";
import {
  DataTable,
  type DataTableColumn,
  Button,
  Text,
  Badge,
  Tooltip,
} from "@th/ui";
import {
  Timer,
  RefreshCw,
  Play,
  ToggleLeft,
  ToggleRight,
  Trash2,
  AlertTriangle,
  History,
  Clock,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { useTranslations } from "@th/ui";
import { trpc } from "@/trpc";
import {
  JobMobileCard,
  formatDuration,
  timeAgo,
} from "./_components/JobMobileCard";
import { DlqRerunButton } from "./_components/DlqRerunButton";
import { DlqRerunStatus } from "./_components/DlqRerunStatus";
import { dlqRerunNotice } from "./_components/dlq-rerun-outcome";
import { useDlqReruns } from "./_components/useDlqReruns";

// ─────────────────────────────────────────────────────────────────────────────
// Types (inferred from tRPC router output)
// ─────────────────────────────────────────────────────────────────────────────

type JobStatus = {
  name: string;
  description: string | null;
  scheduled: boolean;
  schedule: {
    cron: string;
    timezone: string;
    enabled: boolean;
    cronDescription: string;
    nextRun: string | null;
  } | null;
  enabled: boolean;
  lastRun: RunEntry | null;
};

type RunEntry = {
  id: string;
  jobName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "success" | "error";
  resultSummary?: string;
  errorMessage?: string;
  errorCode?: string;
};

type DlqItem = {
  ref: { queue: string; id: string };
  failedAt: string;
  payload: unknown;
  attempt: number;
  error: { message: string; code?: string };
};

// ─────────────────────────────────────────────────────────────────────────────
// Styled components
// ─────────────────────────────────────────────────────────────────────────────

const PageTitle = styled(Text, {
  tag: "h1",
  fontSize: 24,
  weight: "bold",
  color: "$color",
});

const Subtitle = styled(Text, {
  fontSize: 14,
  color: "$colorMuted",
});

const SectionTitle = styled(Text, {
  fontSize: 18,
  weight: "semibold",
  color: "$color",
});

const MonoText = styled(Text, {
  fontFamily: "$mono",
  fontSize: 12,
  color: "$colorMuted",
});

const Muted = styled(Text, {
  fontSize: 13,
  color: "$colorMuted",
});

const ErrorBanner = styled(XStack, {
  padding: 12,
  gap: 8,
  alignItems: "center",
  backgroundColor: "$dangerBackground",
  borderWidth: 1,
  borderColor: "$dangerBorder",
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformJobsPage() {
  const t = useTranslations();
  const theme = useTheme();
  const utils = trpc.useUtils();

  // Expanded row for inline run history
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  // DLQ sub-panel within the expanded row
  const [dlqQueue, setDlqQueue] = useState<string | null>(null);

  // Confirm dialog state — purge DLQ
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);

  // Running jobs feedback
  const [runningJobs, setRunningJobs] = useState<Set<string>>(new Set());

  // DLQ rerun bookkeeping: one rerun per queue at a time, the outcome line
  // per queue, and the entries that ran but could not be removed. The rules
  // and their reasons are in `useDlqReruns`.
  const {
    start: startRerun,
    finish: finishRerun,
    dismiss: dismissRerunOutcome,
    settledFor: rerunSettledFor,
    rowState: rerunRowState,
  } = useDlqReruns();

  // ── Queries ─────────────────────────────────────────────────────────

  const {
    data: jobsData,
    isLoading: loading,
    error: jobsError,
    refetch: fetchJobs,
  } = trpc.platformJobs.listStatus.useQuery(undefined, {
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const jobs: JobStatus[] = jobsData?.jobs ?? [];
  const error = jobsError?.message ?? null;

  const { data: runsData, isLoading: runsLoading } =
    trpc.platformJobs.getRuns.useQuery(
      { name: expandedJob!, limit: 25 },
      { enabled: !!expandedJob, staleTime: 10_000 },
    );
  const runs: RunEntry[] = runsData?.runs ?? [];

  const { data: dlqData, isLoading: dlqLoading } =
    trpc.platformJobs.peekDlq.useQuery(
      { queue: dlqQueue!, max: 50 },
      { enabled: !!dlqQueue, staleTime: 10_000 },
    );
  const dlqItems: DlqItem[] = dlqData?.items ?? [];

  // ── Mutations ───────────────────────────────────────────────────────

  const runJobMutation = trpc.platformJobs.runJob.useMutation({
    onMutate: ({ name }) => {
      setRunningJobs((prev) => new Set(prev).add(name));
    },
    onSettled: (_data, _err, { name }) => {
      setRunningJobs((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
      void utils.platformJobs.listStatus.invalidate();
      if (expandedJob === name) {
        void utils.platformJobs.getRuns.invalidate({ name });
      }
    },
  });

  const toggleEnabledMutation = trpc.platformJobs.toggleEnabled.useMutation({
    onSettled: () => {
      void utils.platformJobs.listStatus.invalidate();
    },
  });

  // `not_run` and `failed` RESOLVE: only `outcome: "ran"` means the job ran,
  // and its `entryDeleted` says whether the entry is gone. A missing entry, an
  // auth failure or an unreachable jobs service throws. Either way the panel
  // says what happened (`dlqRerunNotice`).
  const rerunDlqItemMutation = trpc.platformJobs.rerunDlqItem.useMutation({
    onSuccess: (result, { queue, jobId }) => {
      finishRerun(queue, jobId, { kind: "result", result });
    },
    onError: (error, { queue, jobId }) => {
      finishRerun(queue, jobId, { kind: "error", error });
    },
    onSettled: (_data, _err, { queue }) => {
      void utils.platformJobs.peekDlq.invalidate({ queue });
      void utils.platformJobs.listStatus.invalidate();
      // The queue is the job name; a rerun that started adds a run to its
      // history, which the kept-entry messages send the operator to read.
      void utils.platformJobs.getRuns.invalidate({ name: queue });
    },
  });

  const deleteDlqItemMutation = trpc.platformJobs.deleteDlqItem.useMutation({
    onSettled: (_data, _err, { queue }) => {
      void utils.platformJobs.peekDlq.invalidate({ queue });
    },
  });

  const purgeDlqMutation = trpc.platformJobs.purgeDlq.useMutation({
    onSettled: (_data, _err, { queue }) => {
      void utils.platformJobs.peekDlq.invalidate({ queue });
    },
  });

  // ── Action callbacks ────────────────────────────────────────────────

  const runJob = useCallback(
    (name: string) => {
      runJobMutation.mutate({ name });
    },
    [runJobMutation],
  );

  const toggleEnabled = useCallback(
    (name: string, enabled: boolean) => {
      toggleEnabledMutation.mutate({ name, enabled });
    },
    [toggleEnabledMutation],
  );

  const toggleExpanded = useCallback(
    (name: string) => {
      // Collapsing or switching jobs closes the DLQ panel, and the rerun
      // message it was showing goes with it.
      if (dlqQueue) dismissRerunOutcome(dlqQueue);
      setDlqQueue(null);
      setExpandedJob(expandedJob === name ? null : name);
    },
    [expandedJob, dlqQueue, dismissRerunOutcome],
  );

  const toggleDlq = useCallback(
    (queue: string) => {
      if (dlqQueue === queue) {
        dismissRerunOutcome(queue);
        setDlqQueue(null);
        return;
      }
      setDlqQueue(queue);
    },
    [dlqQueue, dismissRerunOutcome],
  );

  const rerunDlqItem = useCallback(
    (queue: string, jobId: string) => {
      // `startRerun` refuses a second press while a rerun in this queue is
      // still running, and any press on an entry that already ran.
      if (!startRerun(queue, jobId)) return;
      rerunDlqItemMutation.mutate({ queue, jobId });
    },
    [rerunDlqItemMutation, startRerun],
  );

  const deleteDlqItem = useCallback(
    (queue: string, jobId: string) => {
      // "The entry is still here" stops being true once an entry is deleted.
      dismissRerunOutcome(queue);
      deleteDlqItemMutation.mutate({ queue, jobId });
    },
    [deleteDlqItemMutation, dismissRerunOutcome],
  );

  const purgeDlq = useCallback((queue: string) => {
    setPurgeTarget(queue);
  }, []);

  const confirmPurgeDlq = useCallback(() => {
    if (!purgeTarget) return;
    dismissRerunOutcome(purgeTarget);
    purgeDlqMutation.mutate(
      { queue: purgeTarget },
      { onSettled: () => setPurgeTarget(null) },
    );
  }, [purgeTarget, purgeDlqMutation, dismissRerunOutcome]);

  // ── Table columns ──────────────────────────────────────────────────

  const columns = useMemo<DataTableColumn<JobStatus>[]>(
    () => [
      {
        id: "name",
        header: String(t("admin.jobsName")),
        width: 22,
        searchValue: (row) =>
          [row.name, row.description].filter(Boolean).join(" "),
        sortValue: (row) => row.name,
        cell: (row) => (
          <YStack gap={2}>
            <Text
              variant="bodySmall"
              weight="bold"
              color="$color"
              style={{ whiteSpace: "nowrap" }}
            >
              {row.name}
            </Text>
            {row.description && (
              <Text variant="caption" tone="muted" truncate>
                {row.description}
              </Text>
            )}
          </YStack>
        ),
      },
      {
        id: "schedule",
        header: String(t("admin.jobsSchedule")),
        width: 22,
        sortValue: (row) => row.schedule?.cronDescription ?? "",
        cell: (row) =>
          row.schedule ? (
            <YStack gap={2}>
              <MonoText style={{ whiteSpace: "nowrap" }}>
                {row.schedule.cron}
              </MonoText>
              {/* NOT nowrap, unlike the cron line above it. The description
                  now carries its timezone ("Daily at 00:00 America/Chicago"),
                  which roughly doubled its length — held on one line it widens
                  this fixed-hint column instead of wrapping inside it. */}
              <Text variant="caption" tone="muted">
                {row.schedule.cronDescription}
              </Text>
            </YStack>
          ) : (
            <Muted>{String(t("admin.jobsOnDemand"))}</Muted>
          ),
      },
      {
        id: "enabled",
        header: String(t("admin.jobsStatus")),
        width: 8,
        sortValue: (row) => (row.enabled ? 0 : 1),
        cell: (row) => (
          <Badge tone={row.enabled ? "success" : "neutral"}>
            {row.enabled
              ? String(t("admin.jobsEnabled"))
              : String(t("admin.jobsDisabled"))}
          </Badge>
        ),
      },
      {
        id: "lastRun",
        header: String(t("admin.jobsLastRun")),
        width: 18,
        sortValue: (row) =>
          row.lastRun ? new Date(row.lastRun.finishedAt) : null,
        cell: (row) => {
          if (!row.lastRun)
            return <Muted>{String(t("admin.jobsNever"))}</Muted>;
          const run = row.lastRun;
          const absolute = new Date(run.finishedAt).toLocaleString();
          return (
            <Tooltip
              anchor={
                <XStack
                  gap={6}
                  alignItems="center"
                  style={{ whiteSpace: "nowrap", cursor: "default" }}
                >
                  {run.status === "success" ? (
                    <CheckCircle2 size={14} color={theme.success?.val} />
                  ) : (
                    <XCircle size={14} color={theme.dangerText?.val} />
                  )}
                  <YStack gap={1}>
                    <Text variant="caption" color="$color">
                      {timeAgo(run.finishedAt)}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {formatDuration(run.durationMs)}
                    </Text>
                  </YStack>
                </XStack>
              }
            >
              {absolute}
            </Tooltip>
          );
        },
      },
      {
        id: "actions",
        header: "",
        width: 30,
        cell: (row) => (
          <XStack
            gap={6}
            alignItems="center"
            justifyContent="flex-end"
            flexWrap="nowrap"
          >
            <Button
              size="$2"
              onPress={() => runJob(row.name)}
              disabled={runningJobs.has(row.name)}
            >
              <Play size={14} />
              {String(t("admin.jobsRunNow"))}
            </Button>
            <Button
              size="$2"
              variant="secondary"
              onPress={() => toggleEnabled(row.name, !row.enabled)}
            >
              {row.enabled ? (
                <ToggleRight size={14} />
              ) : (
                <ToggleLeft size={14} />
              )}
              {row.enabled
                ? String(t("admin.jobsDisable"))
                : String(t("admin.jobsEnable"))}
            </Button>
            <Button
              size="$2"
              variant={expandedJob === row.name ? "primary" : "secondary"}
              onPress={() => toggleExpanded(row.name)}
            >
              <History size={14} />
              {String(t("admin.jobsHistory"))}
            </Button>
          </XStack>
        ),
      },
    ],
    [t, theme, runningJobs, expandedJob, runJob, toggleEnabled, toggleExpanded],
  );

  // ── DLQ columns ────────────────────────────────────────────────────

  const dlqColumns = useMemo<DataTableColumn<DlqItem>[]>(
    () => [
      {
        id: "failedAt",
        header: String(t("admin.jobsDlqFailedAt")),
        width: 1.5,
        cell: (row) => (
          <Text variant="caption" color="$color">
            {new Date(row.failedAt).toLocaleString()}
          </Text>
        ),
      },
      {
        id: "error",
        header: String(t("admin.jobsDlqError")),
        width: 3,
        cell: (row) => (
          <YStack gap={2}>
            {/* One mono line: the code gives way (ellipsis) so the attempt
                label always shows. A failed rerun keeps the entry and bumps
                its attempt, which is how an operator sees it was updated. */}
            {(row.error.code || row.attempt > 1) && (
              <XStack gap={8} alignItems="center">
                {row.error.code && (
                  <MonoText truncate flexShrink={1} minWidth={0}>
                    {row.error.code}
                  </MonoText>
                )}
                {row.attempt > 1 && (
                  <MonoText flexShrink={0}>
                    {String(t("admin.jobsDlqAttempt", { count: row.attempt }))}
                  </MonoText>
                )}
              </XStack>
            )}
            <Text variant="caption" tone="muted" truncate>
              {row.error.message}
            </Text>
            {/* Outlives the status line: this entry's job already ran, and
                its Rerun is off for the same reason. */}
            {rerunRowState(row.ref.queue, row.ref.id).ranEntryKept && (
              <Text variant="caption" color="$warningSoft" truncate>
                {String(t("admin.jobsDlqRanDeleteThis"))}
              </Text>
            )}
          </YStack>
        ),
      },
      {
        id: "payload",
        header: String(t("admin.jobsDlqPayload")),
        width: 2,
        cell: (row) => (
          <MonoText truncate>{JSON.stringify(row.payload)}</MonoText>
        ),
      },
      {
        id: "actions",
        header: "",
        width: 1.5,
        // The column must be as wide as its two buttons, whatever its width
        // hint says. Three things make that true, and each was measured in
        // Chrome because the first attempt guessed and rendered Rerun as a
        // blank 38.9px square:
        //   1. `truncate: false`: a truncating cell is `max-width: 0`, which
        //      takes the cell out of column sizing altogether.
        //   2. `min-width: max-content` on the row of buttons: a Button's
        //      min-content width is only its padding and icon, so without
        //      this the cell still reports ~40px per button.
        //   3. `resizable={false}` on this table (below): resizable tables
        //      are `table-layout: fixed`, which sizes columns from the hint
        //      alone and ignores content.
        truncate: false,
        noWrap: true,
        cell: (row) => (
          <XStack
            gap={6}
            justifyContent="flex-end"
            style={{ minWidth: "max-content" }}
          >
            <DlqRerunButton
              pending={rerunRowState(row.ref.queue, row.ref.id).pending}
              blocked={rerunRowState(row.ref.queue, row.ref.id).blocked}
              onRerun={() => rerunDlqItem(row.ref.queue, row.ref.id)}
            />
            <Button
              size="$2"
              variant="secondary"
              onPress={() => deleteDlqItem(row.ref.queue, row.ref.id)}
            >
              <Trash2 size={14} />
              {String(t("admin.jobsDlqDelete"))}
            </Button>
          </XStack>
        ),
      },
    ],
    [t, rerunRowState, rerunDlqItem, deleteDlqItem],
  );

  // ── Inline expanded row: run history + DLQ ─────────────────────────

  const renderExpandedRow = useCallback(
    (row: JobStatus) => {
      if (row.name !== expandedJob) return null;

      const job = row;
      const showDlq = dlqQueue === job.name;
      const rerunOutcome = rerunSettledFor(job.name);

      return (
        <YStack gap="$3" padding="$3">
          {/* ── Summary bar ─────────────────────────────────────────── */}
          <XStack
            gap="$4"
            alignItems="center"
            paddingVertical="$2"
            paddingHorizontal="$3"
            backgroundColor="$surfaceMuted"
            borderRadius="$0"
            flexWrap="wrap"
          >
            {job.schedule && (
              <XStack gap="$2" alignItems="center">
                <Clock size={13} color={theme.colorMuted?.val} />
                <Text variant="caption" tone="muted">
                  {String(t("admin.jobsNextRun"))}:{" "}
                  {job.schedule.nextRun
                    ? new Date(job.schedule.nextRun).toLocaleString()
                    : "—"}
                </Text>
              </XStack>
            )}
            {job.lastRun && (
              <XStack gap="$2" alignItems="center">
                {job.lastRun.status === "success" ? (
                  <CheckCircle2 size={13} color={theme.success?.val} />
                ) : (
                  <XCircle size={13} color={theme.dangerText?.val} />
                )}
                <Text variant="caption" tone="muted">
                  {String(t("admin.jobsLastRun"))}:{" "}
                  {new Date(job.lastRun.finishedAt).toLocaleString()} (
                  {formatDuration(job.lastRun.durationMs)})
                </Text>
              </XStack>
            )}
            {job.lastRun?.status === "error" && job.lastRun.errorMessage && (
              <Text variant="caption" color="$dangerText" truncate>
                {job.lastRun.errorMessage}
              </Text>
            )}
          </XStack>

          {/* ── Run history heading ─────────────────────────────────── */}
          <XStack gap="$2" alignItems="center" justifyContent="space-between">
            <XStack gap="$2" alignItems="center">
              <History size={15} color={theme.colorMuted?.val} />
              <SectionTitle>{String(t("admin.jobsRunHistory"))}</SectionTitle>
            </XStack>
            <Button
              size="$2"
              variant={showDlq ? "primary" : "secondary"}
              onPress={() => toggleDlq(job.name)}
            >
              <AlertTriangle size={14} />
              {showDlq
                ? String(t("admin.jobsHideDlq"))
                : String(t("admin.jobsShowDlq"))}
            </Button>
          </XStack>

          {/* ── Run history list ────────────────────────────────────── */}
          {runsLoading ? (
            <Muted>Loading...</Muted>
          ) : runs.length === 0 ? (
            <Muted>{String(t("admin.jobsNoRuns"))}</Muted>
          ) : (
            <YStack gap="$2">
              {runs.map((run) => (
                <XStack
                  key={run.id}
                  gap="$3"
                  alignItems="center"
                  paddingVertical="$2"
                  paddingHorizontal="$3"
                  borderBottomWidth={1}
                  borderColor="$borderColor"
                >
                  {/* Status icon */}
                  {run.status === "success" ? (
                    <CheckCircle2
                      size={14}
                      color={theme.success?.val}
                      style={{ flexShrink: 0 }}
                    />
                  ) : (
                    <XCircle
                      size={14}
                      color={theme.dangerText?.val}
                      style={{ flexShrink: 0 }}
                    />
                  )}

                  {/* Timestamp */}
                  <Text
                    variant="caption"
                    color="$color"
                    style={{ minWidth: 150, flexShrink: 0 }}
                  >
                    {new Date(run.startedAt).toLocaleString()}
                  </Text>

                  {/* Duration */}
                  <MonoText style={{ minWidth: 60, flexShrink: 0 }}>
                    {formatDuration(run.durationMs)}
                  </MonoText>

                  {/* Detail / error */}
                  <Text
                    variant="caption"
                    color={
                      run.status === "error" ? "$dangerText" : "$colorMuted"
                    }
                    truncate
                    flex={1}
                  >
                    {run.status === "error"
                      ? (run.errorMessage ?? "")
                      : (run.resultSummary ?? "")}
                  </Text>
                </XStack>
              ))}
            </YStack>
          )}

          {/* ── DLQ sub-panel ──────────────────────────────────────── */}
          {showDlq && (
            <YStack
              gap="$3"
              marginTop="$2"
              padding="$3"
              borderWidth={2}
              borderColor="$borderColor"
              borderRadius="$0"
              backgroundColor="$surface"
            >
              {/* Header and rerun outcome share one ungapped stack: the
                  status region is always mounted (see DlqRerunStatus) and
                  must take no room while it is empty. */}
              <YStack>
                {/* Wraps: at 320px the panel is 138px wide and, on one line,
                    Purge All sat 70px outside it (measured). */}
                <XStack
                  gap="$2"
                  alignItems="center"
                  justifyContent="space-between"
                  flexWrap="wrap"
                >
                  <XStack gap="$2" alignItems="center">
                    <AlertTriangle size={15} color={theme.dangerText?.val} />
                    <SectionTitle>{String(t("admin.jobsDlq"))}</SectionTitle>
                  </XStack>
                  <Button
                    size="$2"
                    variant="destructive"
                    onPress={() => purgeDlq(job.name)}
                  >
                    <Trash2 size={14} />
                    {String(t("admin.jobsDlqPurge"))}
                  </Button>
                </XStack>
                <DlqRerunStatus
                  notice={
                    rerunOutcome ? dlqRerunNotice(rerunOutcome, t) : null
                  }
                />
              </YStack>

              {dlqLoading ? (
                <Muted>Loading...</Muted>
              ) : dlqItems.length === 0 ? (
                <Muted>{String(t("admin.jobsDlqEmpty"))}</Muted>
              ) : (
                // Scoped scroll: the nested DLQ table stays in table mode
                // (its rerun/delete actions live in regular columns), so on
                // phones it pans inside this panel instead of stretching the
                // whole page when the expanded row renders under a card.
                // 720, up from 520: the actions column now always fits its
                // two buttons (it no longer clips them), so the floor grew by
                // what that column takes and the three data columns keep the
                // room they had.
                <XStack overflow="scroll">
                  <YStack flex={1} minWidth={720}>
                    <DataTable<DlqItem>
                      columns={dlqColumns}
                      rows={dlqItems}
                      getRowKey={(row) => row.ref.id}
                      // Auto table layout, so the actions column takes the
                      // width of its buttons (see the column's note). The
                      // cost is the drag-to-resize handles on this nested
                      // table.
                      resizable={false}
                    />
                  </YStack>
                </XStack>
              )}
            </YStack>
          )}
        </YStack>
      );
    },
    [
      expandedJob,
      dlqQueue,
      runs,
      runsLoading,
      dlqItems,
      dlqLoading,
      dlqColumns,
      rerunSettledFor,
      theme,
      t,
      toggleDlq,
      purgeDlq,
    ],
  );

  // ── Mobile card (DataTable card mode, <600px) ──────────────────────
  // Card mode does not render the table's "actions" column, so the card
  // carries the same Run / Enable / History controls. History toggles the
  // same expanded row (run history + DLQ) used in table mode.
  const renderMobileCard = useCallback(
    (row: JobStatus) => (
      <JobMobileCard
        row={row}
        isRunning={runningJobs.has(row.name)}
        historyOpen={expandedJob === row.name}
        onRun={() => runJob(row.name)}
        onToggleEnabled={() => toggleEnabled(row.name, !row.enabled)}
        onToggleHistory={() => toggleExpanded(row.name)}
      />
    ),
    [runningJobs, expandedJob, runJob, toggleEnabled, toggleExpanded],
  );

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <PlatformContainer>
      {/* Header */}
      <YStack gap={8}>
        <XStack gap={8} alignItems="center">
          <Timer size={20} color={theme.color?.val} />
          <PageTitle>{String(t("admin.jobsTitle"))}</PageTitle>
        </XStack>
        <Subtitle>{String(t("admin.jobsSubtitle"))}</Subtitle>
      </YStack>

      {/* Toolbar — wraps so nothing overflows on narrow phones */}
      <XStack gap={12} alignItems="center" flexWrap="wrap">
        <Button size="$3" onPress={() => fetchJobs()} disabled={loading}>
          <RefreshCw size={16} />
          {String(t("admin.jobsRefresh"))}
        </Button>
        {!loading && jobs.length > 0 && (
          <Muted>{String(t("admin.jobsCount", { count: jobs.length }))}</Muted>
        )}
      </XStack>

      {/* Error */}
      {error && (
        <ErrorBanner>
          <AlertTriangle size={16} color={theme.dangerText?.val} />
          <Text variant="bodySmall" color="$dangerText">
            {String(t("admin.jobsLoadError"))} {error}
          </Text>
        </ErrorBanner>
      )}

      {/* Jobs table with inline expandable history */}
      <DataTable<JobStatus>
        columns={columns}
        rows={jobs}
        isLoading={loading}
        getRowKey={(row) => row.name}
        renderExpandedRow={renderExpandedRow}
        renderMobileCard={renderMobileCard}
        // Borderless page-flow table with no scrolling ancestor — restore
        // DataTable's own overflow wrapper for scoped horizontal panning.
        // (The nested DLQ table below has its own overflow XStack.)
        scrollContainer
        clientSearch
        clientSearchPlaceholder={String(t("admin.jobsSearchPlaceholder"))}
        clientSearchClearLabel={String(t("admin.clearSearch"))}
        clientSort
      />

      {/* Purge DLQ confirmation */}
      <ConfirmDialog
        open={!!purgeTarget}
        onConfirm={confirmPurgeDlq}
        onCancel={() => setPurgeTarget(null)}
        title={String(t("admin.jobsDlqPurge"))}
        description={String(t("admin.jobsDlqConfirmPurge"))}
        confirmLabel={String(t("admin.jobsDlqPurge"))}
        tone="danger"
        loading={purgeDlqMutation.isPending}
      />
    </PlatformContainer>
  );
}
