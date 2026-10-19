"use client";

import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { XStack, YStack } from "tamagui";
import { Button, NextLinkAnchor, Text, useNotify } from "@th/ui";
import {
  AlertTriangle,
  ArrowRight,
  Lock,
  RefreshCw,
  ScanEye,
} from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  PlatformContainer,
  PlatformPageTitle,
  PlatformSectionTitle,
  PlatformSubtitle,
} from "../_components/PlatformPageParts";

import {
  DRAIN_JOB,
  MODERATION_JOBS,
  REQUEUE_JOB,
  QUEUE_SIGNALS,
  describeRescanOutcome,
  describeResolveOutcome,
  resolveOpsWriteAccess,
  severityWindow,
  type ActionOutcomeCopy,
  type ModerationJobName,
  type QueueSignal,
} from "./_components/image-moderation-ops.helpers";
import { AlertStateLine } from "./_components/AlertStateLine";
import { DeletionOutboxRow } from "./_components/DeletionOutboxRow";
import { KeyLookup } from "./_components/KeyLookup";
import { KindBreakdown } from "./_components/KindBreakdown";
import { ProviderBand } from "./_components/ProviderBand";
import { SeverityHistogram } from "./_components/SeverityHistogram";
import { SignalTiles } from "./_components/SignalTiles";
import {
  SignalDrillDown,
  type QueueSignalRow,
} from "./_components/SignalDrillDown";
import {
  ModerationJobsStrip,
  type JobLastRun,
} from "./_components/ModerationJobsStrip";

/**
 * `/platform/image-moderation` — the OPERATOR's view of the image-moderation
 * pipeline. Not a review queue: reviewing happens at `/moderate/images`, behind
 * the moderator gate, and this page links there from the header.
 *
 * Everything here was previously invisible in every UI. The five queue-health
 * counts were read by exactly one thing — the hourly job that decides whether
 * to post to Discord — so a dead drain job, a scanner failing right now,
 * records whose objects vanished, and (worst) "the provider is unconfigured,
 * so we are auto-approving every image" were all states nobody could see
 * without reading Sentry or tailing logs.
 *
 * THIS PAGE RENDERS NO IMAGE, EVER. See `SignalDrillDown`.
 *
 * WHAT SITS WHERE, AND WHY. The spine is "is scanning working → what is stuck
 * → what can I do", and everything added since keeps that order rather than
 * spreading into a dashboard. The provider band and the five tiles stay the
 * loudest things here. The severity histogram lives INSIDE the band because it
 * is evidence for the threshold the band prints. The per-kind breakdown is
 * collapsed and gates its own query — it is the second question, never the
 * first. The deletion-outbox line is a row and not a sixth tile: the five are
 * the hourly alert's signal set, predicate for predicate, and a sixth tile
 * would read as a sixth thing Discord pages on.
 *
 * NO AUTO-REFRESH, DELIBERATELY. `/platform/jobs` polls every 30s and that is
 * right for it; here a refetch re-derives `cutoffs`, which is the drill-down's
 * query key — so a background poll would silently re-window and reset the
 * pagination of a list an operator is in the middle of reading. The refresh is
 * a button, and `observedAt` is on screen so staleness is visible rather than
 * assumed.
 */

const PAGE_SIZE = 30;

/**
 * Placeholder window for the drill-down input while no snapshot is in hand.
 * The query is `enabled: false` in that state, so these values are never sent;
 * they exist so the input typechecks without a non-null assertion.
 */
const NO_WINDOW = new Date(0);

const ICON: CSSProperties = { flexShrink: 0 };

export default function PlatformImageModerationPage() {
  const utils = trpc.useUtils();
  const { toast } = useNotify();

  const [selected, setSelected] = useState<QueueSignal | null>(null);
  const [runningJobs, setRunningJobs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** The per-kind breakdown is collapsed by default AND gates its own query. */
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  /** The storage key the lookup currently has a query out for. */
  const [lookupKey, setLookupKey] = useState<string | null>(null);
  /**
   * The records with a resolve/rescan IN FLIGHT — a set, not one id.
   *
   * A single `string | null` was a lie the moment two rows were acted on at
   * once: the second `onMutate` erased the first row's spinner, and whichever
   * request settled first re-enabled the other row's buttons while its own
   * call was still open — so a third press double-fired the mutation and wrote
   * a second audit row. The server's compare-and-set means no corruption, but
   * a console that misreports in-flight state is the exact failure the ADMIN
   * gate above exists to avoid. Same shape as `runningJobs`.
   */
  const [pendingRecords, setPendingRecords] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // ── Snapshot (the tiles + the window everything else is pinned to) ──────

  const snapshotQuery = trpc.moderation.queueSnapshot.useQuery(
    // `{}`, never `undefined`: every field is defaulted but the schema is
    // `.strict()`.
    {},
    { staleTime: 15_000 },
  );
  const snapshot = snapshotQuery.data;

  // ── Scanner configuration ───────────────────────────────────────────────
  // Throws PRECONDITION_FAILED when the jobs-service URL is unset. The band
  // renders "unknown" for that; no retry, so it never becomes a spinner loop.

  const configQuery = trpc.platformJobs.getModerationConfig.useQuery(
    undefined,
    { retry: false, staleTime: 300_000 },
  );

  // ── Can this viewer actually USE the review queue? ──────────────────────
  // `/moderate/images` gates on `checkModeratorAccess` (COMMUNITY_MODERATOR or
  // ADMIN) and its layout hard-`redirect()`s a failure to /access-denied. This
  // page is gated on ADMIN *or DEVELOPER*, so the header CTA would bounce a
  // DEVELOPER — the exact persona this page exists for — clean out of the
  // platform shell. Same procedure the moderate shell itself uses, so the two
  // can never disagree.
  const moderatorAccessQuery = trpc.community.checkModeratorAccess.useQuery(
    undefined,
    { retry: false, staleTime: 5 * 60_000 },
  );
  /**
   * Three states, not two.
   *
   * PENDING errs OPEN — a locked CTA flashing at a real moderator on every
   * cold load is worse than a half-second of an unlocked one, and the answer
   * is cached for five minutes.
   *
   * A SETTLED ERROR errs CLOSED, matching `ModerateShell`'s own
   * `isError || !allowed` posture. Leaving it open there would reinstate
   * exactly the bounce this fixes: the link would be live, and the route it
   * points at would deny on the same signal that just failed here.
   */
  const reviewAccess: "pending" | "allowed" | "denied" | "unknown" =
    moderatorAccessQuery.isError
      ? "unknown"
      : moderatorAccessQuery.data === undefined
        ? "pending"
        : moderatorAccessQuery.data.allowed
          ? "allowed"
          : "denied";
  const canReview = reviewAccess === "allowed" || reviewAccess === "pending";

  // ── Can this viewer WRITE? ──────────────────────────────────────────────
  // The page's read gate is ADMIN *or DEVELOPER*; both row actions are ADMIN
  // ONLY. So the fact that this page rendered says nothing about whether a
  // press will succeed, and the client has to ask.
  //
  // ERRS CLOSED, INCLUDING WHILE PENDING — the opposite of `reviewAccess`
  // above, deliberately. That one gates a LINK, where erring open costs a real
  // moderator half a second of a locked CTA. This gates a MUTATION, and an
  // enabled button that 403s on press teaches an operator that the console
  // lies. A button that unlocks a moment later is the harmless direction.
  const staffAccessQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60_000,
  });
  const writeAccess = resolveOpsWriteAccess({
    roles: staffAccessQuery.data?.roles,
    isError: staffAccessQuery.isError,
  });

  // ── Has Discord already paged? ──────────────────────────────────────────
  // READ-ONLY server-side, and that is load-bearing: the procedure that
  // reports queue health WRITES the fingerprint as part of its gate, so
  // polling that from here would reset the suppression window on every page
  // load and re-arm an alert that had already fired.
  const alertQuery = trpc.moderation.alertState.useQuery(
    {},
    { retry: false, staleTime: 15_000 },
  );

  // ── Severity distribution (evidence for the review threshold) ───────────
  // Anchored to `snapshot.observedAt`, never to a fresh `new Date()`: the
  // window IS the query key, so a window that moved every render would refetch
  // every render.
  const histogramWindow = useMemo(
    () => severityWindow(snapshot?.observedAt ?? NO_WINDOW),
    [snapshot?.observedAt],
  );
  const histogramQuery = trpc.moderation.severityHistogram.useQuery(
    histogramWindow,
    { enabled: Boolean(snapshot), retry: false, staleTime: 60_000 },
  );

  // ── Job status ──────────────────────────────────────────────────────────

  const jobsQuery = trpc.platformJobs.listStatus.useQuery(undefined, {
    retry: false,
    staleTime: 15_000,
  });

  const lastRunByName = useMemo(() => {
    const out: Partial<Record<ModerationJobName, JobLastRun | null>> = {};
    for (const job of jobsQuery.data?.jobs ?? []) {
      if (job.name === DRAIN_JOB || job.name === REQUEUE_JOB) {
        out[job.name] = job.lastRun ?? null;
      }
    }
    return out;
  }, [jobsQuery.data]);

  // ── Drill-down ──────────────────────────────────────────────────────────
  // The four window fields are passed back VERBATIM from the snapshot, which
  // is what makes the list exactly the set the clicked tile counted. It
  // therefore cannot run before the snapshot has loaded.

  const drillEnabled = Boolean(snapshot) && selected !== null;

  const signalQuery = trpc.moderation.queueSignal.useInfiniteQuery(
    {
      pendingDueBefore: snapshot?.cutoffs.pendingDueBefore ?? NO_WINDOW,
      moderatedBefore: snapshot?.cutoffs.moderatedBefore ?? NO_WINDOW,
      degradedSince: snapshot?.cutoffs.degradedSince ?? NO_WINDOW,
      maxRequeues: snapshot?.thresholds.maxRequeues ?? 1,
      signal: selected ?? QUEUE_SIGNALS[0],
      limit: PAGE_SIZE,
    },
    {
      enabled: drillEnabled,
      // `nextCursor` is `string | null`; null ends the pagination.
      getNextPageParam: (last) => last.nextCursor,
      staleTime: 15_000,
    },
  );

  const drillRows = useMemo<QueueSignalRow[]>(
    () => signalQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [signalQuery.data],
  );

  // ── Per-kind breakdown ──────────────────────────────────────────────────
  // Same ABSOLUTE cutoffs as the drill-down, passed back verbatim, so the
  // columns provably sum to the tiles above them rather than to a window
  // re-derived forty seconds later. Gated on the disclosure: it is supporting
  // evidence, and expanding it is the operator saying they have a hypothesis.

  const breakdownEnabled = Boolean(snapshot) && breakdownOpen;

  const breakdownQuery = trpc.moderation.queueBreakdown.useQuery(
    {
      pendingDueBefore: snapshot?.cutoffs.pendingDueBefore ?? NO_WINDOW,
      moderatedBefore: snapshot?.cutoffs.moderatedBefore ?? NO_WINDOW,
      degradedSince: snapshot?.cutoffs.degradedSince ?? NO_WINDOW,
      maxRequeues: snapshot?.thresholds.maxRequeues ?? 1,
    },
    { enabled: breakdownEnabled, retry: false, staleTime: 15_000 },
  );

  // ── Key lookup ──────────────────────────────────────────────────────────
  // A MISS IS NOT AN ERROR (`found: false` is a normal, informative answer), so
  // nothing here treats an empty result as a failure. `retry: false` because
  // the one real error mode is a malformed key, which retrying cannot fix.

  const lookupQuery = trpc.moderation.lookupByKey.useQuery(
    { storageKey: lookupKey ?? "" },
    { enabled: lookupKey !== null, retry: false, staleTime: 30_000 },
  );

  // ── Run a job ───────────────────────────────────────────────────────────

  const runJobMutation = trpc.platformJobs.runJob.useMutation({
    onMutate: ({ name }) => {
      setRunningJobs((prev) => new Set(prev).add(name));
    },
    onSuccess: (_data, { name }) => {
      const spec = MODERATION_JOBS.find((job) => job.name === name);
      toast.success({ title: `${spec?.label ?? name} started` });
    },
    // Errors ride `GlobalMutationErrorNotifier` (no `meta.silent` here).
    onSettled: (_data, _err, { name }) => {
      setRunningJobs((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
      void utils.platformJobs.listStatus.invalidate();
      // Re-reads the counts. This also re-derives `cutoffs`, so an open
      // drill-down re-pages from the top against the new window — correct:
      // the operator just changed the thing the list describes.
      void utils.moderation.queueSnapshot.invalidate();
    },
  });

  const runJob = useCallback(
    (name: ModerationJobName) => runJobMutation.mutate({ name }),
    [runJobMutation],
  );

  const isRunning = useCallback(
    (name: ModerationJobName) => runningJobs.has(name),
    [runningJobs],
  );

  // ── Row actions (ADMIN only) ────────────────────────────────────────────
  /**
   * Both outcomes of both mutations are NORMAL, and neither non-happy path is
   * an error.
   *
   * `not_eligible` means somebody else resolved the row first, or it no longer
   * matches. `human_decided` means a person already approved or rejected the
   * image and the re-scan was REFUSED — that is the guard working, since
   * re-scanning would discard a moderator's decision and could put the image
   * back into circulation. Both ride an `info` toast, never a danger one.
   */
  const announce = useCallback(
    (copy: ActionOutcomeCopy) => {
      const options = { title: copy.title, message: copy.message };
      if (copy.tone === "success") toast.success(options);
      else toast.info(options);
    },
    [toast],
  );

  /**
   * After either action, re-read the counts AND the list.
   *
   * Invalidating the snapshot re-derives `cutoffs`, which is the drill-down's
   * query key, so an open drill-down re-pages from the top against the new
   * window. That is the same trade the job buttons make and it is the right
   * one here for the same reason: the operator just changed the thing the list
   * describes, and a list that still shows the row they retired is worse than
   * a list that jumped.
   */
  const invalidateQueue = useCallback(() => {
    void utils.moderation.queueSnapshot.invalidate();
    void utils.moderation.queueSignal.invalidate();
    void utils.moderation.queueBreakdown.invalidate();
    void utils.moderation.lookupByKey.invalidate();
  }, [utils]);

  const markPending = useCallback((recordId: string) => {
    setPendingRecords((prev) => new Set(prev).add(recordId));
  }, []);

  const clearPending = useCallback((recordId: string) => {
    setPendingRecords((prev) => {
      const next = new Set(prev);
      next.delete(recordId);
      return next;
    });
  }, []);

  const resolveMutation = trpc.moderation.resolveUnscannable.useMutation({
    onMutate: ({ recordId }) => markPending(recordId),
    onSuccess: (data) => announce(describeResolveOutcome(data)),
    // Errors ride `GlobalMutationErrorNotifier` (no `meta.silent` here).
    // `onSettled` clears only the record THIS call was for — see the docblock
    // on `pendingRecords`.
    onSettled: (_data, _err, { recordId }) => {
      clearPending(recordId);
      invalidateQueue();
    },
  });

  const rescanMutation = trpc.moderation.rescanImage.useMutation({
    onMutate: ({ recordId }) => markPending(recordId),
    onSuccess: (data) => announce(describeRescanOutcome(data)),
    onSettled: (_data, _err, { recordId }) => {
      clearPending(recordId);
      invalidateQueue();
    },
  });

  const handleResolve = useCallback(
    (recordId: string) => {
      // `maxRequeues` is ECHOED from the snapshot, never defaulted: the
      // eligibility the button promised has to be the eligibility the UPDATE
      // enforces, or the action silently refuses rows the operator can see.
      // The server floors it at the automation's own cap and the drill-down
      // locks the button when the snapshot's cap is below that, so this cannot
      // send a value the server will reject.
      const cap = snapshot?.thresholds.maxRequeues;
      if (cap === undefined) {
        // Only reachable if the snapshot vanished between rendering the row
        // and confirming the dialog. Silently returning here would leave the
        // operator having confirmed a TERMINAL action that never happened, so
        // it says so.
        toast.warning({
          title: "Nothing was resolved",
          message:
            "The queue snapshot is no longer loaded, so the requeue cap this action has to echo is unknown. Refresh and try again.",
        });
        return;
      }
      resolveMutation.mutate({ recordId, maxRequeues: cap });
    },
    [resolveMutation, snapshot?.thresholds.maxRequeues, toast],
  );

  const handleRescan = useCallback(
    (recordId: string) => rescanMutation.mutate({ recordId }),
    [rescanMutation],
  );

  /**
   * One instant for every age on the page, anchored to the FRESHEST successful
   * fetch rather than to render time.
   *
   * Two reasons it is not a bare `new Date()`. It would change on every render,
   * so "3m ago" could tick while the row behind it is untouched — and it would
   * re-mint the drill-down's column memo each time. Anchoring to
   * `dataUpdatedAt` makes every age mean "as of the data you are looking at",
   * which is the honest reading on a page whose refresh is manual.
   */
  const now = useMemo(() => {
    const freshest = Math.max(
      snapshotQuery.dataUpdatedAt,
      signalQuery.dataUpdatedAt,
      jobsQuery.dataUpdatedAt,
      // The alert query renders its OWN age ("Discord was paged 2h ago"). Left
      // out, a `lastPagedAt` fresher than every other query on the page
      // rendered as "in <1m" — an age in the future, from the one line whose
      // whole job is saying when somebody was told.
      alertQuery.dataUpdatedAt,
    );
    return new Date(freshest > 0 ? freshest : Date.now());
  }, [
    snapshotQuery.dataUpdatedAt,
    signalQuery.dataUpdatedAt,
    jobsQuery.dataUpdatedAt,
    alertQuery.dataUpdatedAt,
  ]);

  /**
   * A failed REFETCH must not throw away good counts.
   *
   * Deriving the error band from `snapshotQuery.error` alone replaced five
   * valid twenty-second-old tiles with an error box — and left the drill-down
   * mounted below it, so the page carried two buttons both named "Retry"
   * doing different things. Split the two cases: no data at all replaces the
   * tiles; data plus an error is a banner ABOVE tiles the page already
   * timestamps via `observedAt`.
   */
  const snapshotError = snapshotQuery.error
    ? formatErrorMessage(snapshotQuery.error)
    : null;
  const snapshotErrorIsFatal = snapshotError !== null && !snapshot;
  const snapshotErrorIsStale = snapshotError !== null && Boolean(snapshot);

  const jobsUnavailable = jobsQuery.error
    ? `Job status is unavailable — ${formatErrorMessage(jobsQuery.error)}`
    : undefined;

  return (
    <PlatformContainer>
      {/* ── Header ───────────────────────────────────────────────────── */}
      <XStack
        gap="$4"
        alignItems="flex-start"
        flexWrap="wrap"
        flexShrink={1}
        minWidth={0}
      >
        {/* minWidth 0, NOT a pixel floor. A `minWidth={240}` child in a
            ~240px content box has no slack at all, and any floor wider than
            the box IS the overflow. Tamagui's web Stack also defaults to
            `flex-shrink: 0`, so `flexShrink={1}` is what actually lets this
            column give way. */}
        <YStack gap="$2" flex={1} flexShrink={1} minWidth={0}>
          <XStack gap="$2" alignItems="center" flexShrink={1} minWidth={0}>
            <ScanEye size={20} color="var(--color, #211C16)" style={ICON} />
            <PlatformPageTitle>Image moderation</PlatformPageTitle>
          </XStack>
          <PlatformSubtitle>
            Operational health of the upload-scanning pipeline. Decisions on
            held images are made in the review queue.
          </PlatformSubtitle>
        </YStack>

        <YStack gap="$1" flexShrink={1} minWidth={0}>
          {canReview ? (
            /* `NextLinkAnchor` + `Button tag="span"`, not a Button with an
               href: `Button` declares no `href`, and a button nested inside a
               link is two tab stops on one rectangle. The anchor is the
               control; the button is decoration, hidden from assistive tech
               and out of the tab order. */
            <NextLinkAnchor
              href="/moderate/images"
              aria-label="Open the image review queue"
            >
              <Button
                tag="span"
                variant="primary"
                size="$3"
                aria-hidden
                tabIndex={-1}
              >
                Open review queue
                <ArrowRight size={14} strokeWidth={2.5} aria-hidden />
              </Button>
            </NextLinkAnchor>
          ) : (
            /* `locked` exists for precisely this: the operator can see the
               action and cannot invoke it. Rendering the live link instead
               would send a DEVELOPER to /access-denied and out of the
               platform shell — from the loudest control on the page. */
            <Button
              variant="primary"
              size="$3"
              locked
              aria-label={
                reviewAccess === "denied"
                  ? "Open review queue — requires the moderator role"
                  : "Open review queue — your moderator role could not be confirmed"
              }
            >
              Open review queue
              <Lock size={14} aria-hidden />
            </Button>
          )}
          {canReview ? null : (
            <Text variant="caption" tone="muted" maxWidth={260}>
              {reviewAccess === "denied"
                ? "Reviewing held images needs the moderator role."
                : "Your moderator role could not be confirmed."}
            </Text>
          )}
        </YStack>
      </XStack>

      {/* ── Find a record by storage key ─────────────────────────────── */}
      {/* Every other entry point here starts from a queue-health signal. An
          operator holding a key off a Sentry event starts from the other end,
          and had no way in at all. */}
      <KeyLookup
        submittedKey={lookupKey}
        onLookup={setLookupKey}
        onClear={() => setLookupKey(null)}
        result={lookupQuery.data}
        isLoading={lookupQuery.isLoading}
        errorMessage={
          lookupQuery.error
            ? formatErrorMessage(lookupQuery.error)
            : undefined
        }
        now={now}
      />

      {/* ── Scanner configuration ────────────────────────────────────── */}
      <ProviderBand
        config={configQuery.data}
        isLoading={configQuery.isLoading}
        onRetry={() => void configQuery.refetch()}
        isRetrying={configQuery.isFetching}
        /* The histogram is EVIDENCE FOR THE THRESHOLD this band prints, so it
           rides inside the band rather than becoming a sixth section
           competing with the tiles. */
        histogram={
          <SeverityHistogram
            data={histogramQuery.data}
            threshold={configQuery.data?.reviewThreshold ?? null}
            /* React Query v5 reports a DISABLED query as `isLoading: false`,
               so waiting on the snapshot has to be said explicitly or the
               chart announces "not read" during a perfectly normal cold load.
               A fatally failed snapshot is excluded — that is not waiting, and
               the page is already showing a banner about it. */
            isLoading={
              histogramQuery.isLoading || (!snapshot && !snapshotErrorIsFatal)
            }
            errorMessage={
              histogramQuery.error
                ? formatErrorMessage(histogramQuery.error)
                : undefined
            }
          />
        }
      />

      {/* ── Counts ───────────────────────────────────────────────────── */}
      <YStack gap="$3" flexShrink={1} minWidth={0}>
        <XStack
          gap="$3"
          alignItems="baseline"
          justifyContent="space-between"
          flexWrap="wrap"
          flexShrink={1}
          minWidth={0}
        >
          <PlatformSectionTitle>Queue health</PlatformSectionTitle>
          {/* `flexShrink={1}` + `minWidth={0}` are load-bearing, not tidiness:
              Tamagui's web Stack defaults to `flex-shrink: 0`, so this group
              took its max-content width (~247px) inside a ~240px box and its
              own `flex-wrap` never had a narrower line box to break into —
              the exact failure `PlatformFilterBar` documents. */}
          <XStack
            gap="$3"
            alignItems="center"
            flexWrap="wrap"
            flexShrink={1}
            minWidth={0}
          >
            {snapshot ? (
              <Text variant="caption" tone="muted">
                Observed {snapshot.observedAt.toLocaleTimeString()}
              </Text>
            ) : null}
            <Button
              size="$2"
              variant="secondary"
              aria-label="Refresh queue health, alert state, jobs and scanner configuration"
              disabled={snapshotQuery.isFetching}
              onPress={() => {
                void snapshotQuery.refetch();
                void jobsQuery.refetch();
                // The alert state answers "is this news", which is the first
                // thing read after the counts; leaving it out of the page's
                // primary control would let it go stale beside fresh tiles.
                void alertQuery.refetch();
                // The provider band is the thing this page exists to show. It
                // has `retry: false` + a 5-minute staleTime and the global
                // client disables refetch-on-focus, so leaving it out made the
                // page's primary control silently exclude its headline.
                void configQuery.refetch();
                // The histogram and the breakdown are NOT refetched here on
                // purpose: both are keyed on the snapshot's own instants, so a
                // successful snapshot refetch re-windows them automatically.
                // Refetching them by hand would fire them twice — once against
                // the window being replaced.
              }}
            >
              <RefreshCw size={13} aria-hidden />
              Refresh
            </Button>
          </XStack>
        </XStack>

        {/* ── Is this news, or a known backlog? ───────────────────────── */}
        {/* The hourly alert is EDGE-TRIGGERED, so a non-zero tile looks
            identical whether somebody has already been told or nobody has. */}
        <AlertStateLine
          state={alertQuery.data?.state}
          firingSignals={alertQuery.data?.firingSignals}
          lastPagedAt={alertQuery.data?.lastPagedAt}
          isLoading={alertQuery.isLoading}
          errorMessage={
            alertQuery.error ? formatErrorMessage(alertQuery.error) : undefined
          }
          now={now}
        />

        {/* Stale-but-present counts keep their tiles; the banner sits above
            them. Only a first load with no data at all replaces the tiles. */}
        {snapshotError ? (
          <XStack
            gap="$3"
            padding="$4"
            alignItems="flex-start"
            borderWidth={2}
            borderRadius={0}
            borderColor="$danger"
            backgroundColor="$surfaceMuted"
            flexWrap="wrap"
            flexShrink={1}
            minWidth={0}
            role="alert"
          >
            <AlertTriangle
              size={18}
              color="var(--danger, #B91C1C)"
              style={ICON}
              aria-hidden
            />
            <YStack gap="$2" flex={1} flexShrink={1} minWidth={0}>
              <Text variant="bodySmall" weight="bold" color="$danger">
                {snapshotErrorIsStale
                  ? "Queue health could not be refreshed"
                  : "Queue health could not be read"}
              </Text>
              <Text variant="caption" tone="muted">
                {snapshotError}
                {snapshotErrorIsStale
                  ? " The counts below are the last good read."
                  : ""}
              </Text>
              <XStack>
                <Button
                  variant="secondary"
                  size="$2"
                  // Scoped: the drill-down renders its own Retry, and two
                  // buttons with one accessible name doing different things is
                  // a defect this repo has shipped before.
                  aria-label="Retry reading queue health"
                  onPress={() => void snapshotQuery.refetch()}
                >
                  Retry
                </Button>
              </XStack>
            </YStack>
          </XStack>
        ) : null}

        {snapshotErrorIsFatal ? null : (
          <SignalTiles
            counts={snapshot?.counts}
            thresholds={snapshot?.thresholds}
            totals={snapshot?.totals}
            selected={selected}
            onSelect={(signal) =>
              setSelected((prev) => (prev === signal ? null : signal))
            }
          />
        )}

        {/* ── The bytes behind a REJECT ────────────────────────────────── */}
        {/* Rejecting an image enqueues its object for deletion in the same
            transaction as the decision — which makes the ENQUEUE reliable and
            says nothing about the DRAIN. Not a sixth tile: the five above are
            the alert's signal set and this is not one of them. */}
        {snapshot ? (
          <DeletionOutboxRow outbox={snapshot.deletionOutbox} />
        ) : null}

        {/* ── Drill-down ───────────────────────────────────────────────── */}
        {selected && snapshot ? (
          <SignalDrillDown
            signal={selected}
            thresholds={snapshot.thresholds}
            writeAccess={writeAccess}
            maxRequeues={snapshot.thresholds.maxRequeues}
            onResolve={handleResolve}
            onRescan={handleRescan}
            pendingRecords={pendingRecords}
            rows={drillRows}
            isLoading={signalQuery.isLoading}
            isError={signalQuery.isError}
            errorMessage={
              signalQuery.error
                ? formatErrorMessage(signalQuery.error)
                : undefined
            }
            hasNextPage={signalQuery.hasNextPage ?? false}
            isFetchingNextPage={signalQuery.isFetchingNextPage}
            onLoadMore={() => void signalQuery.fetchNextPage()}
            onRetry={() => void signalQuery.refetch()}
            onClose={() => setSelected(null)}
            now={now}
          />
        ) : null}

        {/* ── Per-kind breakdown ──────────────────────────────────────── */}
        {/* `EVENT_HERO` failing while `AVATAR` is fine points straight at a
            code path. Secondary evidence: collapsed, and its query is gated on
            the disclosure rather than running on every page load. */}
        {snapshot ? (
          <KindBreakdown
            expanded={breakdownOpen}
            onToggle={() => setBreakdownOpen((prev) => !prev)}
            data={breakdownQuery.data}
            isLoading={breakdownQuery.isLoading && breakdownEnabled}
            errorMessage={
              breakdownQuery.error
                ? formatErrorMessage(breakdownQuery.error)
                : undefined
            }
            onRetry={() => void breakdownQuery.refetch()}
          />
        ) : null}
      </YStack>

      {/* ── Jobs ─────────────────────────────────────────────────────── */}
      <ModerationJobsStrip
        lastRunByName={lastRunByName}
        isLoading={jobsQuery.isLoading}
        isRunning={isRunning}
        onRun={runJob}
        now={now}
        unavailableReason={jobsUnavailable}
      />
    </PlatformContainer>
  );
}
