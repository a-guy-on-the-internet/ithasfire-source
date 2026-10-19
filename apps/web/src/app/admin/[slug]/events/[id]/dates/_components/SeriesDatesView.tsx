"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack } from "tamagui";

import {
  Button,
  Spinner,
  Text,
  useLocale,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { normalizeError } from "@/lib/errors/normalize-error";
import { useIsMobile } from "@/hooks/useIsMobile";

import { toIsoInTimeZone } from "../../../new/_components/event-builder-helpers";
import { AddDateDialog } from "./AddDateDialog";
import { OccurrenceStatusPill } from "./OccurrenceStatusPill";
import { SkipDateDialog } from "./SkipDateDialog";
import {
  deriveManualNote,
  deriveRowKind,
  deriveRowMeta,
  describeSchedule,
  formatRowDate,
  formatRowTime,
  formatThroughDate,
  isPastRow,
  readyDraftRows,
  summarizeBulkPublish,
  weekdayNameInTimeZone,
  type SeriesDateRow,
} from "./series-dates-helpers";

// ── Layout constants ────────────────────────────────────────────────────────
// Table-like rows → GRID (columns must align across rows): fixed date + pill
// columns, fluid meta, content-sized actions (DS §5).
const ROW_GRID_COLUMNS = "180px 120px minmax(0, 1fr) auto";
const ROW_MIN_HEIGHT = 56;
const SKELETON_ROWS = 6;

/** Publish paths that can only be completed inside the event editor. */
const NEEDS_EDITOR_CODES = new Set([
  "CHARGEBACK_TERMS_REQUIRED",
  "ATTESTATION_INCOMPLETE",
]);

type RowAction = "publish" | "createDraft" | "restore";
type PendingRow = { occurrenceId: string; action: RowAction } | null;

export type SeriesDatesViewProps = {
  slug: string;
  /** The event whose route hosts this page — used for the Edit-schedule link. */
  eventId: string;
  seriesId: string;
};

export function SeriesDatesView({ slug, eventId, seriesId }: SeriesDatesViewProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { toast } = useNotify();
  const isMobile = useIsMobile();
  const utils = trpc.useUtils();

  const listQuery = trpc.series.listSeriesDatesForAdmin.useInfiniteQuery(
    { seriesId, limit: 50 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );

  const series = listQuery.data?.pages[0]?.series;
  const rows: SeriesDateRow[] = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [listQuery.data],
  );

  const timezone = series?.timezone ?? "UTC";

  const invalidate = useCallback(
    () => utils.series.listSeriesDatesForAdmin.invalidate(),
    [utils],
  );

  /**
   * Cross-surface cache invalidation after a successful publish. Mirrors
   * EventBuilder's publish onSuccess (getEventForEdit + getGateState) so the
   * builder never serves a stale DRAFT view with a live Publish CTA after
   * this page published the event (staleTime is 60s, no focus refetch), and
   * refreshes the events list that feeds EventsManager.
   */
  const invalidateAfterPublish = useCallback(
    (publishedEventId: string) => {
      void utils.events.getEventForEdit.invalidate({
        eventId: publishedEventId,
      });
      void utils.events.getGateState.invalidate({ eventId: publishedEventId });
      void utils.events.listMine.invalidate();
    },
    [utils],
  );

  // ── Mutations ────────────────────────────────────────────────────────────
  const publishMutation = trpc.events.publishEvent.useMutation();
  const generateMutation = trpc.series.generateEventsFromSeries.useMutation();
  const skipMutation = trpc.series.skipOccurrence.useMutation();
  const restoreMutation = trpc.series.restoreOccurrence.useMutation();
  const addMutation = trpc.series.addSeriesOccurrence.useMutation();

  const [pendingRow, setPendingRow] = useState<PendingRow>(null);
  const [bulkPublishing, setBulkPublishing] = useState(false);
  // Synchronous re-entrancy guard (mirrors EventBuilder's publishInFlightRef):
  // the state-driven `disabled` visuals only apply after a re-render, so a
  // fast double-activation could fire two mutations back-to-back. The ref
  // blocks the second call synchronously; cleared in each finally.
  const actionInFlightRef = useRef(false);
  const [skipTarget, setSkipTarget] = useState<SeriesDateRow | null>(null);
  const [skipError, setSkipError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const anyMutationBusy = pendingRow !== null || bulkPublishing;

  const resolveErrorMessage = useCallback(
    (error: unknown): { message: string; needsEditor: boolean } => {
      const normalized = normalizeError(error, t as (key: string) => string);
      const needsEditor =
        normalized.code != null && NEEDS_EDITOR_CODES.has(normalized.code);
      return {
        message: needsEditor
          ? String(t("admin.sdNeedsEditor"))
          : (normalized.formError ?? String(t("errors.generic"))),
        needsEditor,
      };
    },
    [t],
  );

  const rowDateLabel = useCallback(
    (row: SeriesDateRow) => formatRowDate(row.startsAt, timezone, locale),
    [timezone, locale],
  );

  // ── Row actions ──────────────────────────────────────────────────────────
  const openRowEvent = useCallback(
    (row: SeriesDateRow) => {
      if (!row.event) return;
      router.push(`/admin/${slug}/events/${row.event.eventId}/edit`);
    },
    [router, slug],
  );

  const publishRow = useCallback(
    async (row: SeriesDateRow) => {
      if (!row.event || anyMutationBusy) return;
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setPendingRow({ occurrenceId: row.occurrenceId, action: "publish" });
      try {
        await publishMutation.mutateAsync({
          eventId: row.event.eventId,
          clientKey: nanoid(12),
        });
        invalidateAfterPublish(row.event.eventId);
        toast.success({
          id: `sd-published-${row.occurrenceId}`,
          title: String(t("admin.sdPublishedTitle")),
          message: String(
            t("admin.sdPublishedMessage", { date: rowDateLabel(row) }),
          ),
        });
      } catch (error) {
        const { message } = resolveErrorMessage(error);
        toast.danger({
          id: `sd-publish-failed-${row.occurrenceId}`,
          title: String(t("admin.ebPublishFailedTitle")),
          message,
        });
      } finally {
        actionInFlightRef.current = false;
        setPendingRow(null);
        void invalidate();
      }
    },
    [
      anyMutationBusy,
      publishMutation,
      invalidateAfterPublish,
      toast,
      t,
      rowDateLabel,
      resolveErrorMessage,
      invalidate,
    ],
  );

  const createDraftForRow = useCallback(
    async (row: SeriesDateRow) => {
      if (anyMutationBusy) return;
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setPendingRow({ occurrenceId: row.occurrenceId, action: "createDraft" });
      try {
        const result = await generateMutation.mutateAsync({
          seriesId,
          occurrenceIds: [row.occurrenceId],
          clientKey: nanoid(12),
        });
        // The use case reports skipped occurrences (past-dated, already
        // linked to an event) as a success with an empty `generated` — an
        // unconditional success toast here would lie and leave the row
        // unchanged forever.
        if (result.generated.length === 0) {
          toast.warning({
            id: `sd-draft-skipped-${row.occurrenceId}`,
            title: String(t("admin.sdDraftFailedTitle")),
            message: String(t("admin.sdDraftNotCreated")),
          });
        } else {
          void utils.events.listMine.invalidate();
          toast.success({
            id: `sd-draft-${row.occurrenceId}`,
            title: String(t("admin.sdDraftCreatedTitle")),
            message: String(
              t("admin.sdDraftCreatedMessage", { date: rowDateLabel(row) }),
            ),
          });
        }
      } catch (error) {
        const { message } = resolveErrorMessage(error);
        toast.danger({
          id: `sd-draft-failed-${row.occurrenceId}`,
          title: String(t("admin.sdDraftFailedTitle")),
          message,
        });
      } finally {
        actionInFlightRef.current = false;
        setPendingRow(null);
        void invalidate();
      }
    },
    [
      anyMutationBusy,
      generateMutation,
      seriesId,
      utils,
      toast,
      t,
      rowDateLabel,
      resolveErrorMessage,
      invalidate,
    ],
  );

  const restoreRow = useCallback(
    async (row: SeriesDateRow) => {
      if (anyMutationBusy) return;
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setPendingRow({ occurrenceId: row.occurrenceId, action: "restore" });
      try {
        await restoreMutation.mutateAsync({
          seriesId,
          occurrenceId: row.occurrenceId,
          clientKey: nanoid(12),
        });
      } catch (error) {
        const { message } = resolveErrorMessage(error);
        toast.danger({
          id: `sd-restore-failed-${row.occurrenceId}`,
          title: String(t("admin.sdRestoreFailedTitle")),
          message,
        });
      } finally {
        actionInFlightRef.current = false;
        setPendingRow(null);
        void invalidate();
      }
    },
    [
      anyMutationBusy,
      restoreMutation,
      seriesId,
      toast,
      t,
      resolveErrorMessage,
      invalidate,
    ],
  );

  const confirmSkip = useCallback(
    async (note: string) => {
      if (!skipTarget) return;
      setSkipError(null);
      try {
        await skipMutation.mutateAsync({
          seriesId,
          occurrenceId: skipTarget.occurrenceId,
          ...(note ? { note } : {}),
          clientKey: nanoid(12),
        });
        setSkipTarget(null);
        void invalidate();
      } catch (error) {
        setSkipError(resolveErrorMessage(error).message);
      }
    },
    [skipTarget, skipMutation, seriesId, invalidate, resolveErrorMessage],
  );

  const submitAddDate = useCallback(
    async (startsAtLocal: string, note: string) => {
      setAddError(null);
      try {
        await addMutation.mutateAsync({
          seriesId,
          startsAt: toIsoInTimeZone(startsAtLocal, timezone),
          ...(note ? { note } : {}),
          clientKey: nanoid(12),
        });
        setAddOpen(false);
        toast.success({
          id: "sd-date-added",
          title: String(t("admin.sdDateAddedTitle")),
        });
        void invalidate();
      } catch (error) {
        setAddError(resolveErrorMessage(error).message);
      }
    },
    [addMutation, seriesId, timezone, toast, t, invalidate, resolveErrorMessage],
  );

  // ── Bulk publish (sequential, per-item error tolerance) ─────────────────
  const readyRows = useMemo(() => readyDraftRows(rows), [rows]);

  const publishAllReady = useCallback(async () => {
    if (anyMutationBusy || readyRows.length === 0) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBulkPublishing(true);
    try {
      const results: Array<{ ok: true } | { ok: false; reason: string }> = [];
      for (const row of readyRows) {
        try {
          await publishMutation.mutateAsync({
            eventId: row.event!.eventId,
            clientKey: nanoid(12),
          });
          // Same cross-surface invalidation as the single-row path — each
          // published event's builder caches must not keep a DRAFT view.
          invalidateAfterPublish(row.event!.eventId);
          results.push({ ok: true });
        } catch (error) {
          results.push({
            ok: false,
            reason: resolveErrorMessage(error).message,
          });
        }
      }
      const outcome = summarizeBulkPublish(results);
      if (outcome.failed === 0) {
        toast.success({
          id: "sd-bulk-published",
          title: String(t("admin.sdPublishedTitle")),
          message: String(
            t("admin.sdBulkAllPublished", { count: outcome.published }),
          ),
        });
      } else {
        toast.warning({
          id: "sd-bulk-partial",
          title: String(t("admin.ebPublishFailedTitle")),
          message: String(
            t("admin.sdBulkPartial", {
              published: outcome.published,
              failed: outcome.failed,
              reason: outcome.firstFailureReason ?? "",
            }),
          ),
        });
      }
    } finally {
      actionInFlightRef.current = false;
      setBulkPublishing(false);
      void invalidate();
    }
  }, [
    anyMutationBusy,
    readyRows,
    publishMutation,
    invalidateAfterPublish,
    toast,
    t,
    resolveErrorMessage,
    invalidate,
  ]);

  // ── Header summary line ─────────────────────────────────────────────────
  const summaryLine = useMemo(() => {
    if (!series) return "";
    const descriptor = describeSchedule(series.schedule);
    const sample = rows[0];
    const weekday = sample
      ? weekdayNameInTimeZone(sample.startsAt, timezone, locale)
      : null;
    const ruleText = (() => {
      switch (descriptor.kind) {
        case "weekly":
          if (!weekday) return String(t("admin.sdRuleCustom"));
          if (descriptor.interval === 1) {
            return String(t("admin.sdRuleWeekly", { weekday }));
          }
          if (descriptor.interval === 2) {
            return String(t("admin.sdRuleBiweekly", { weekday }));
          }
          return String(
            t("admin.sdRuleWeeklyInterval", {
              interval: descriptor.interval,
              weekday,
            }),
          );
        case "daily":
          return descriptor.interval === 1
            ? String(t("admin.sdRuleDaily"))
            : String(
                t("admin.sdRuleDailyInterval", {
                  interval: descriptor.interval,
                }),
              );
        case "monthly":
          return descriptor.interval === 1
            ? String(t("admin.sdRuleMonthly"))
            : String(
                t("admin.sdRuleMonthlyInterval", {
                  interval: descriptor.interval,
                }),
              );
        case "fixed":
          return String(t("admin.sdRuleFixed"));
        case "custom":
          return String(t("admin.sdRuleCustom"));
      }
    })();
    const through =
      series.schedule.until != null
        ? formatThroughDate(series.schedule.until, timezone, locale)
        : null;
    const parts = [
      ruleText,
      sample ? formatRowTime(sample.startsAt, timezone, locale) : null,
      through ? String(t("admin.sdThrough", { date: through })) : null,
      String(t("admin.sdDatesCount", { count: series.totalCount })),
    ].filter((part): part is string => Boolean(part));
    return parts.join(" · ");
  }, [series, rows, timezone, locale, t]);

  // ── States: loading / error / not-found ─────────────────────────────────
  if (listQuery.isPending) {
    return (
      <YStack gap="$4" padding="$5" maxWidth={960} width="100%">
        {/* Fixed-height skeleton — same row height as the loaded list so the
            layout doesn't shift when data lands. */}
        <YStack gap="$2" aria-hidden>
          <YStack height={28} width={280} backgroundColor="$surfaceMuted" />
          <YStack height={16} width={360} backgroundColor="$surfaceMuted" />
        </YStack>
        <YStack borderTopWidth={2} borderColor="$borderColor">
          {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
            <YStack
              key={i}
              height={ROW_MIN_HEIGHT}
              borderBottomWidth={1}
              borderColor="$borderColorSoft"
              justifyContent="center"
            >
              <YStack height={14} width="60%" backgroundColor="$surfaceMuted" />
            </YStack>
          ))}
        </YStack>
        <XStack gap="$2" alignItems="center">
          <Spinner size="sm" />
          <Text variant="bodySmall" tone="muted">
            {String(t("admin.sdLoading"))}
          </Text>
        </XStack>
      </YStack>
    );
  }

  if (listQuery.isError || !series) {
    return (
      <YStack
        gap="$3"
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={240}
      >
        <Text variant="h4" weight="bold">
          {String(t("admin.sdLoadErrorTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          {String(t("admin.sdLoadErrorBody"))}
        </Text>
        <Button
          variant="secondary"
          size="$3"
          onPress={() => void listQuery.refetch()}
          disabled={listQuery.isFetching}
        >
          {String(t(listQuery.isFetching ? "common.loading" : "admin.sdRetry"))}
        </Button>
      </YStack>
    );
  }

  const editScheduleHref = `/admin/${slug}/events/${eventId}/edit?section=scheduling`;

  return (
    <YStack gap="$5" padding="$5" maxWidth={960} width="100%">
      {/* ── Header: name + mono schedule summary + actions ─────────────── */}
      <YStack gap="$3">
        <YStack gap="$2">
          <Text variant="h3" weight="bold">
            {series.name}
          </Text>
          <Text
            fontFamily="$mono"
            fontSize={12}
            letterSpacing={1}
            color="$colorMuted"
            textTransform="uppercase"
            data-testid="sd-schedule-summary"
          >
            {summaryLine}
          </Text>
        </YStack>
        <XStack gap="$2" flexWrap="wrap">
          <Button
            variant="outlined"
            size="$2"
            minHeight={44}
            onPress={() => router.push(editScheduleHref)}
            data-testid="sd-edit-schedule"
          >
            {String(t("admin.sdEditSchedule"))}
          </Button>
          <Button
            variant="secondary"
            size="$2"
            minHeight={44}
            onPress={() => {
              setAddError(null);
              setAddOpen(true);
            }}
            data-testid="sd-add-date"
          >
            {String(t("admin.sdAddDate"))}
          </Button>
        </XStack>
      </YStack>

      {/* ── Date rows ──────────────────────────────────────────────────── */}
      {rows.length === 0 ? (
        <YStack
          gap="$2"
          padding="$5"
          borderWidth={2}
          borderColor="$borderColor"
          alignItems="center"
        >
          <Text variant="h4" weight="bold">
            {String(t("admin.sdEmpty"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center">
            {String(t("admin.sdEmptyHint"))}
          </Text>
        </YStack>
      ) : (
        <YStack borderTopWidth={2} borderColor="$borderColor">
          {rows.map((row) => (
            <DateRow
              key={row.occurrenceId}
              row={row}
              timezone={timezone}
              locale={locale}
              isMobile={isMobile}
              pendingAction={
                pendingRow?.occurrenceId === row.occurrenceId
                  ? pendingRow.action
                  : null
              }
              busy={anyMutationBusy}
              onOpen={() => openRowEvent(row)}
              onPublish={() => void publishRow(row)}
              onCreateDraft={() => void createDraftForRow(row)}
              onSkip={() => {
                setSkipError(null);
                setSkipTarget(row);
              }}
              onRestore={() => void restoreRow(row)}
            />
          ))}
        </YStack>
      )}

      {listQuery.hasNextPage ? (
        <XStack>
          <Button
            variant="secondary"
            size="$2"
            minHeight={44}
            disabled={listQuery.isFetchingNextPage}
            onPress={() => void listQuery.fetchNextPage()}
            data-testid="sd-load-more"
          >
            {String(
              t(
                listQuery.isFetchingNextPage
                  ? "common.loading"
                  : "admin.sdLoadMore",
              ),
            )}
          </Button>
        </XStack>
      ) : null}

      {/* ── Bulk bar: ink band, drafts ready to publish ────────────────── */}
      {readyRows.length > 0 ? (
        <XStack
          backgroundColor="$structure"
          paddingVertical="$3"
          paddingHorizontal="$4"
          alignItems="center"
          justifyContent="space-between"
          gap="$3"
          flexWrap="wrap"
          data-testid="sd-bulk-bar"
        >
          <Text
            fontFamily="$mono"
            fontSize={12}
            letterSpacing={1}
            textTransform="uppercase"
            color="$onStructure"
          >
            {String(t("admin.sdDraftsReady", { count: readyRows.length }))}
          </Text>
          <Button
            variant="primary"
            size="$2"
            minHeight={44}
            disabled={anyMutationBusy}
            onPress={() => void publishAllReady()}
            data-testid="sd-publish-all"
          >
            {bulkPublishing ? <Spinner size="sm" /> : null}
            {String(
              t(bulkPublishing ? "common.loading" : "admin.sdPublishAllReady"),
            )}
          </Button>
        </XStack>
      ) : null}

      {/* ── Dialogs ────────────────────────────────────────────────────── */}
      <SkipDateDialog
        open={skipTarget !== null}
        dateLabel={skipTarget ? rowDateLabel(skipTarget) : ""}
        submitting={skipMutation.isPending}
        error={skipError}
        onClose={() => setSkipTarget(null)}
        onConfirm={(note) => void confirmSkip(note)}
      />
      <AddDateDialog
        open={addOpen}
        timezone={timezone}
        submitting={addMutation.isPending}
        error={addError}
        onClose={() => setAddOpen(false)}
        onSubmit={(startsAtLocal, note) => void submitAddDate(startsAtLocal, note)}
      />
    </YStack>
  );
}

SeriesDatesView.displayName = "SeriesDatesView";

// ─────────────────────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────────────────────

type DateRowProps = {
  row: SeriesDateRow;
  timezone: string;
  locale: string;
  isMobile: boolean;
  pendingAction: RowAction | null;
  busy: boolean;
  onOpen: () => void;
  onPublish: () => void;
  onCreateDraft: () => void;
  onSkip: () => void;
  onRestore: () => void;
};

function DateRow({
  row,
  timezone,
  locale,
  isMobile,
  pendingAction,
  busy,
  onOpen,
  onPublish,
  onCreateDraft,
  onSkip,
  onRestore,
}: DateRowProps) {
  const t = useTranslations();
  const kind = deriveRowKind(row);
  const meta = deriveRowMeta(row);
  const dateLabel = formatRowDate(row.startsAt, timezone, locale);
  const timeLabel = formatRowTime(row.startsAt, timezone, locale);
  const struck = kind === "skipped";

  const metaText = (() => {
    switch (meta.kind) {
      case "sold":
        return String(t("admin.sdSoldCount", { count: meta.count }));
      case "ready":
        return String(t("admin.sdReadyMeta"));
      case "notSetUp":
        return String(t("admin.sdNotSetUpMeta"));
      case "noDraftYet":
        return String(t("admin.sdNoDraftMeta"));
      case "skipNote":
        return meta.note;
      case "draftMissing":
        return String(t("admin.sdDraftMissingMeta"));
      case "none":
        return null;
    }
  })();
  const manualNote = deriveManualNote(row);

  const dateBlock = (
    <XStack gap="$2" alignItems="baseline" flexWrap="wrap">
      <Text
        fontFamily="$mono"
        fontSize={13}
        fontWeight="700"
        letterSpacing={0.5}
        color={struck ? "$colorMuted" : "$color"}
        style={struck ? { textDecorationLine: "line-through" } : undefined}
      >
        {dateLabel}
      </Text>
      <Text fontFamily="$mono" fontSize={11} color="$colorMuted">
        {timeLabel}
      </Text>
      {row.manual ? (
        <Text
          fontFamily="$mono"
          fontSize={10}
          letterSpacing={0.8}
          textTransform="uppercase"
          color="$accentText"
        >
          {String(t("admin.sdManualMarker"))}
        </Text>
      ) : null}
    </XStack>
  );

  const metaBlock =
    metaText || manualNote ? (
      <YStack gap={2} minWidth={0}>
        {metaText ? (
          <Text variant="bodySmall" tone="muted">
            {metaText}
          </Text>
        ) : null}
        {manualNote ? (
          <Text variant="caption" tone="muted" fontFamily="$mono">
            {manualNote}
          </Text>
        ) : null}
      </YStack>
    ) : (
      // Keep the grid cell so columns stay aligned on rows without meta.
      <span aria-hidden />
    );

  const actionButton = (
    label: string,
    onPress: () => void,
    options: {
      variant?: "primary" | "secondary" | "outlined" | "ghost";
      pending?: boolean;
      testId?: string;
    } = {},
  ) => (
    <Button
      key={options.testId ?? label}
      variant={options.variant ?? "outlined"}
      size="$2"
      minHeight={isMobile ? 44 : 36}
      disabled={busy}
      onPress={onPress}
      data-testid={options.testId}
      aria-label={`${label} — ${dateLabel}`}
    >
      {options.pending ? <Spinner size="sm" /> : null}
      {options.pending ? String(t("common.loading")) : label}
    </Button>
  );

  const actions: React.ReactNode[] = [];
  const hasEvent = row.event != null;
  switch (kind) {
    case "published":
      if (hasEvent) {
        actions.push(
          actionButton(String(t("admin.sdOpen")), onOpen, {
            testId: `sd-open-${row.occurrenceId}`,
          }),
        );
      }
      break;
    case "draft-ready":
      actions.push(
        actionButton(String(t("admin.sdOpen")), onOpen, {
          testId: `sd-open-${row.occurrenceId}`,
        }),
        actionButton(String(t("admin.sdPublish")), onPublish, {
          variant: "primary",
          pending: pendingAction === "publish",
          testId: `sd-publish-${row.occurrenceId}`,
        }),
      );
      break;
    case "draft-unready":
      actions.push(
        actionButton(String(t("admin.sdOpen")), onOpen, {
          testId: `sd-open-${row.occurrenceId}`,
        }),
      );
      break;
    case "planned":
      // The generate use case refuses past dates — a [Create draft] on a
      // past row could only ever produce a "couldn't create" warning.
      if (!isPastRow(row)) {
        actions.push(
          actionButton(String(t("admin.sdCreateDraft")), onCreateDraft, {
            variant: "secondary",
            pending: pendingAction === "createDraft",
            testId: `sd-create-draft-${row.occurrenceId}`,
          }),
        );
      }
      actions.push(
        actionButton(String(t("admin.sdSkip")), onSkip, {
          variant: "ghost",
          testId: `sd-skip-${row.occurrenceId}`,
        }),
      );
      break;
    case "skipped":
      actions.push(
        actionButton(String(t("admin.sdRestore")), onRestore, {
          pending: pendingAction === "restore",
          testId: `sd-restore-${row.occurrenceId}`,
        }),
      );
      break;
    case "cancelled":
    case "completed":
    case "archived":
    case "detached":
      if (hasEvent) {
        actions.push(
          actionButton(String(t("admin.sdOpen")), onOpen, {
            testId: `sd-open-${row.occurrenceId}`,
          }),
        );
      }
      break;
  }

  if (isMobile) {
    return (
      <YStack
        gap="$2"
        paddingVertical="$3"
        borderBottomWidth={1}
        borderColor="$borderColorSoft"
        data-testid={`sd-row-${row.occurrenceId}`}
      >
        <XStack justifyContent="space-between" alignItems="center" gap="$2">
          {dateBlock}
          <OccurrenceStatusPill kind={kind} />
        </XStack>
        {metaText || manualNote ? metaBlock : null}
        {actions.length > 0 ? (
          <XStack gap="$2" flexWrap="wrap">
            {actions}
          </XStack>
        ) : null}
      </YStack>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: ROW_GRID_COLUMNS,
        gap: 12,
        alignItems: "center",
        minHeight: ROW_MIN_HEIGHT,
        borderBottom: "1px solid var(--borderColorSoft, rgba(33, 28, 22, 0.3))",
        paddingTop: 8,
        paddingBottom: 8,
      }}
      data-testid={`sd-row-${row.occurrenceId}`}
    >
      {dateBlock}
      <OccurrenceStatusPill kind={kind} />
      {metaBlock}
      <XStack gap="$2" justifyContent="flex-end">
        {actions}
      </XStack>
    </div>
  );
}

DateRow.displayName = "DateRow";
