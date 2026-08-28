import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Keyboard as KeyboardIcon, ShieldAlert } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  ExpressDwellFooter,
  FIXED,
  Panel,
  SquarePrimaryButton,
  SquareSecondaryButton,
  StatsStrip,
  Text,
  ToneResultState,
  TopBar,
  useColors,
  useStyles,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import type { ScannerSessionContext } from "../features/auth/use-scanner-session";
import { useNetworkState } from "../features/network/use-network-state";
import { canCheckInVolunteers } from "../lib/role-gates";
import { useBrightnessBoost } from "../lib/use-brightness-boost";
import { feedbackKindForOutcome, triggerFeedback } from "../lib/feedback";
import {
  attachQueueToRecentScan,
  countDroppedScans,
  findSameOrderTickets,
  getEventCounts,
  countQueuedScans,
  lookupPersonName,
  lookupTicketByCode,
  markTicketScannedLocally,
  markTicketValidLocally,
  recordRecentScan,
  wasRecentlyAdmittedOnThisDevice,
  type EventCounts,
} from "../lib/local-db";
import {
  EXPRESS_REPEAT_GUARD_MS,
  planExpressMode,
  shouldShowConfirmManually,
  type ExpressPlan,
} from "../lib/express-mode";
import { useExpressDwell } from "../lib/use-express-dwell";
import { useReducedMotion } from "../lib/use-reduced-motion";
import { useScanUndo, type UndoTarget } from "../lib/use-scan-undo";
import { useScreenReaderEnabled } from "../lib/use-screen-reader";
import type { OfflineResolveResult } from "../lib/offline-resolve";
import {
  offlineFallbackTrigger,
  resolveScanOffline,
} from "../lib/offline-scan-fallback";
import { reportScanIssue } from "../lib/report";
import {
  planScanRail,
  railHoldable,
  railTapDismissable,
} from "../lib/scan-rail-plan";
import { presentScanResult } from "../lib/scan-result-presentation";
import { describeScanResult } from "../lib/scan-result-types";
import { safeTimeString } from "../lib/format";
import { viewfinderSize } from "../lib/viewfinder";
import { enqueueScan } from "../lib/use-scan-queue";
import { trpc } from "../trpc";

// ── Inline session context shape ────────────────────────────────────────────
// ScannerSessionContext (RouterOutputs["scanner"]["getSessionContext"]) resolves
// to `unknown` because the scanner tsconfig can't follow transitive type deps
// (NFR-007). Source of truth:
// packages/core/src/use-cases/scanner/get-scanner-session-context.ts
type TypedSessionContext = {
  operator: { humanId: string; displayName: string; email: string };
  orgs: Array<{ orgId: string; orgName: string; role: string }>;
  currentEvent?: {
    eventId: string;
    orgId: string;
    eventName: string;
    role: string;
    startAt: Date | null;
    endAt: Date | null;
    status: string;
  };
};

import { LoadingState } from "../ui/loading-state";
import { ScanFeedbackButton } from "../ui/scan-feedback-button";
import { TorchButton } from "../ui/torch-button";
import { RecentScansStrip } from "./recent-scans-strip";
import { UnifiedResultView, type AnyScanResult } from "./unified-result-view";
import type { SameOrderTicket } from "../lib/scan-result-types";
import { UnifiedSearchScreen } from "./unified-search-screen";

type Mode = "camera" | "search" | "code-entry";

/**
 * How an admit was invoked. All three defaults reproduce the pre-FR-004 manual
 * behaviour exactly, so only the express caller passes anything.
 */
type AdmitOptions = {
  /**
   * The result to record the admission AGAINST. Express admits in the same tick
   * the result is applied, before `result` state has flushed — without this the
   * recent-scans row is written with the PREVIOUS holder's name and ticket id,
   * which also makes its undo point at the wrong ticket.
   */
  forResult?: AnyScanResult;
  /** Manual mode re-resolves to show the now-SCANNED state. Express must not. */
  reResolve?: boolean;
  /** Suppress the success cue when the caller already fired one. */
  silentFeedback?: boolean;
};

/** Matches Home's counter cadence; NFR-003 forbids anything faster. */
const COUNTS_INTERVAL_MS = 5_000;
/** Matches the queue's own flush cadence. */
const QUEUE_INTERVAL_MS = 15_000;

/**
 * Unified scanner Home → Scan flow.
 *
 * ## Layout (design §1)
 *
 * Four regions, and the ordering is the whole point:
 *
 *   TopBar · STATS STRIP · SCAN REGION (camera + recent) · CONTROL RAIL
 *
 * The FR-003 result state is an absolutely-positioned layer over the SCAN
 * REGION — edge to edge, no gutter. It deliberately does NOT sit inside
 * `ScreenSurface`'s padded stack: a full-bleed verdict with a 16pt cream
 * gutter around it is not full-bleed, it is a big card, which is the thing
 * FR-003 replaces. The stats strip stays visible ABOVE it, because the count
 * is the one number an operator is asked for mid-shift and hiding it behind a
 * verdict means they cannot answer without dismissing.
 *
 * ## Offline (FR-001)
 *
 * Camera and manual-entry resolves route through the local manifest whenever
 * `offlineFallbackTrigger()` says so — device offline, or a
 * network-classified resolver failure — and render through the SAME result
 * view with a mandatory provenance badge. Online behaviour is unchanged.
 */
export const UnifiedScanScreen = ({
  eventId,
  eventName,
  sessionContext,
  expressModeEnabled = false,
  feedbackEnabled = true,
  onToggleFeedback,
  onBack,
  onOpenCounts,
}: {
  eventId: string;
  eventName?: string | null;
  sessionContext: ScannerSessionContext | null;
  /**
   * FR-004 — `ScannerPreferences.expressModeEnabled`. Default OFF; the toggle
   * lives in Settings, not here. Every decision it drives goes through
   * `planExpressMode` (pure, node-tested) rather than being re-derived inline.
   */
  expressModeEnabled?: boolean;
  /**
   * "Sound & haptics" — the ONE rail switch over both feedback channels
   * (`scanFeedbackEnabled` in `lib/scan-feedback-plan.ts`). Unlike express
   * mode this lives ON the scan surface: it changes what the operator hears,
   * not who gets through the door, so it is safe to flip mid-shift.
   */
  feedbackEnabled?: boolean;
  onToggleFeedback?: (next: boolean) => void;
  onBack: () => void;
  /** FR-005 — tapping the stats strip opens the Home counter detail. */
  onOpenCounts?: () => void;
}) => {
  const shared = useStyles();
  const colors = useColors();
  const localStyles = useThemedSheet(makeLocalStyles);
  useBrightnessBoost();
  const network = useNetworkState();
  const [mode, setMode] = useState<Mode>("camera");
  const [permission, requestPermission] = useCameraPermissions();
  const [result, setResult] = useState<AnyScanResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [codeEntry, setCodeEntry] = useState("");
  const [sameOrderTickets, setSameOrderTickets] = useState<SameOrderTicket[]>(
    [],
  );
  const [bulkAdmitPending, setBulkAdmitPending] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [frameWidth, setFrameWidth] = useState(0);
  const [counts, setCounts] = useState<EventCounts>({ total: 0, scanned: 0 });
  const [queueDepth, setQueueDepth] = useState(0);
  /** FR-010 — terminal drops. Someone got in and the server does not know. */
  const [failedCount, setFailedCount] = useState(0);
  /**
   * FR-004 — the express decision for the CURRENT result, taken once at
   * resolve time and stored.
   *
   * Deliberately state and not a `useMemo` over `result`: the decision reads
   * SQLite (the re-admit guard) and the screen-reader flag, and re-deriving it
   * on every render would let a mid-dwell change (a manifest sync, a screen
   * reader being switched on) silently re-decide an admission that has already
   * happened. One resolve, one verdict.
   */
  const [expressPlan, setExpressPlan] = useState<ExpressPlan | null>(null);
  /** FR-004 §3 — the visible half of the 10-minute freshness gate. */
  const [confirmManually, setConfirmManually] = useState(false);
  /**
   * FR-004's re-admit guard fired for the CURRENT result.
   *
   * The guard halted express but the result still said `VALID`, so the screen
   * painted the full-bleed green ADMIT state and the rail offered ADMIT. The
   * guard exists for exactly one scenario — a shared or screenshotted QR
   * presented twice inside the sync-overwrite window — and in exactly that
   * scenario an operator trained by express to read green as "walk on" saw
   * green. This is the visible half of it (see `presentScanResult`).
   */
  const [admittedHereRecently, setAdmittedHereRecently] = useState(false);
  /**
   * Post-check-in lock. `handleCheckIn` neither dismissed nor disabled after a
   * success, so CHECK IN — now the rail's PRIMARY action — was a double-tap
   * away from a second mutation for the same signup.
   */
  const [checkedInSignupIds, setCheckedInSignupIds] = useState<string[]>([]);
  /**
   * The recent-scan row the CURRENT admit wrote — the express rail's UNDO
   * target, selected by id. `null` whenever there is nothing to undo.
   */
  const [lastAdmit, setLastAdmit] = useState<UndoTarget | null>(null);
  /**
   * A refusal message from the rail's UNDO — or from a permanent admit
   * rejection that arrived too late to own the screen (see `handleAdmit`).
   *
   * RAIL-level state, rendered by the rail itself and NOT inside any one
   * branch. It used to live inside the express branch, which is the whole of
   * blocker 2: `handleExpressUndo` set the notice AND nulled the express plan,
   * React 18 batched both into one commit, and the message was mounted into a
   * branch that no longer rendered. The operator got a buzz, an announcement,
   * and no text — while the rail moved to `admit`.
   */
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  /**
   * The express admit for the CURRENT result could not be reverted. Keeps the
   * express plan intact (so the rail cannot fall back to ADMIT) and stops the
   * dwell (so a state saying "couldn't undo" cannot clear itself in 1.2s).
   */
  const [undoRefused, setUndoRefused] = useState(false);
  /**
   * An undo round trip is in flight. Suspends the dwell for its duration: a
   * dwell that expires mid-`revertTicketScan` calls `dismissResult`, which
   * clears `undoNotice` — and the `.then` then writes the refusal into a state
   * nobody is looking at.
   */
  const [undoInFlight, setUndoInFlight] = useState(false);
  /**
   * NFR-001 — the in-flight scrim, the viewfinder lock and the camera pause
   * all read this.
   *
   * It is deliberately BOTH a ref and a state. The ref is the re-entry latch
   * (it must flip synchronously, before any await, or a second barcode frame
   * slips through); the state is what re-renders the UI. Reading the ref
   * during render — which is what shipped — meant nothing scheduled a
   * re-render when it flipped: `resolvePayload` set the ref, called
   * `setErrorMessage(null)` (a no-op React bails out of on the common path),
   * then awaited the fetch, and by the time `setResult` flushed the `finally`
   * had already reset the ref. The scrim never appeared during the round trip
   * it exists to cover.
   */
  const [inFlight, setInFlight] = useState(false);
  const inFlightRef = useRef(false);

  const ctx = sessionContext as TypedSessionContext | null;
  const role = ctx?.currentEvent?.role ?? null;
  const canCheckIn = canCheckInVolunteers(role);
  const reducedMotion = useReducedMotion();
  // NFR-002. Coarse by design — RN cannot report screen-reader FOCUS entering
  // and leaving a subtree reliably, and a half-implementation that guesses
  // "focus left, resume" would dismiss a verdict mid-sentence. See the hook.
  const screenReaderEnabled = useScreenReaderEnabled();
  const { undoScan, pending: undoPending } = useScanUndo();

  const utils = trpc.useUtils();
  const scanTicketMutation = trpc.tickets.scanTicket.useMutation();
  const checkInMutation = trpc.volunteer.signups.checkIn.useMutation();

  // ── Stats strip data (FR-005) ─────────────────────────────────────────────
  // Same sources and same cadences as Home — `getEventCounts` on 5s and the
  // queue count on 15s. NFR-003: no new polling faster than what already runs.
  /**
   * Every one of these is a SQLite read on a `setInterval` — i.e. on a tick
   * with no `try` around it and no owner. A throwing store used to take the
   * tick down permanently (an uncaught throw inside a timer callback), which
   * meant the strip froze on its last values and kept displaying them as if
   * they were current. Degrading to "last known" is fine; degrading to "last
   * known, silently, forever" is not.
   */
  const readCounter = useCallback(
    <T,>(label: string, read: () => T, apply: (value: T) => void): void => {
      try {
        apply(read());
      } catch (err) {
        reportScanIssue(err, { branch: `counter_read_failed_${label}`, eventId });
      }
    },
    [eventId],
  );

  useEffect(() => {
    const update = () =>
      readCounter("event_counts", () => getEventCounts(eventId), setCounts);
    update();
    const id = setInterval(update, COUNTS_INTERVAL_MS);
    return () => clearInterval(id);
  }, [eventId, readCounter]);

  useEffect(() => {
    const update = () => {
      readCounter("queue_depth", () => countQueuedScans(), setQueueDepth);
      // FR-010. Same 15s cadence as the queue depth — a terminal drop happens
      // inside a flush, so there is nothing to learn between flushes.
      //
      // SCOPED TO THE EVENT: `countDroppedScans()` with no argument is global,
      // while `scanned / total` beside it is per-event, so after an event
      // switch the strip showed the PREVIOUS event's failures next to this
      // event's counts. `⚠ N FAILED` outranks every other chip in the collapse
      // ladder precisely because it is actionable at this door, tonight — and a
      // number from last night's show is not.
      readCounter(
        "dropped_scans",
        () => countDroppedScans(eventId),
        setFailedCount,
      );
    };
    update();
    const id = setInterval(update, QUEUE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [eventId, readCounter]);

  // FR-002: the outcome → signature decision lives in ONE pure, tested place
  // (`lib/feedback-signatures.ts`). Re-deriving it inline here is what let
  // already-scanned and wrong-event collapse onto the same "warning" cue.
  const triggerForResult = useCallback(
    (next: AnyScanResult, admittedHere: boolean) => {
      void triggerFeedback(
        feedbackKindForOutcome(
          next.kind === "ticket"
            ? {
                kind: "ticket",
                status: next.status,
                // Design §0: colour, glyph, word, haptic and audio say the SAME
                // one of four. The re-admit guard renders ALREADY IN, so the
                // signature has to be `already_scanned` — an operator who acts
                // on the buzz before reading would otherwise hear "admit" on
                // the one outcome the guard exists to interrupt.
                admittedHereRecently: admittedHere,
              }
            : { kind: next.kind },
        ),
      );
    },
    [],
  );

  /** Same-order bulk admit is a LOCAL manifest read — it works offline too. */
  const applySameOrder = useCallback((next: AnyScanResult) => {
    if (next.kind !== "ticket" || next.status !== "VALID") {
      setSameOrderTickets([]);
      return;
    }
    const local = lookupTicketByCode(next.ticketCode);
    if (!local?.orderId) {
      setSameOrderTickets([]);
      return;
    }
    setSameOrderTickets(
      findSameOrderTickets(local.orderId, next.ticketCode).map((t) => ({
        ticketCode: t.code,
        ticketTypeName: t.ticketTypeName,
        // FR-006a needs this downstream — a bulk-admitted row with no ticket
        // id cannot be undone once the server has acknowledged it.
        ticketId: t.ticketId,
      })),
    );
  }, []);

  const dismissResult = useCallback(() => {
    setResult(null);
    setErrorMessage(null);
    setSameOrderTickets([]);
    setExpressPlan(null);
    setConfirmManually(false);
    setLastAdmit(null);
    lastAdmitRef.current = null;
    setUndoNotice(null);
    setUndoRefused(false);
    setAdmittedHereRecently(false);
  }, []);

  /**
   * FR-004 — has THIS device already admitted this ticket recently?
   *
   * Wrapped because it is a SQLite read on the scan hot path: a throwing store
   * must not take the camera down, and the safe answer to "did we already admit
   * this?" when we cannot tell is **yes** — which halts express into manual
   * confirm rather than auto-admitting on an unknown.
   */
  const admittedRecentlyOnDevice = useCallback(
    (ticketCode: string): boolean => {
      try {
        return wasRecentlyAdmittedOnThisDevice({
          eventId,
          ticketCode,
          withinMs: EXPRESS_REPEAT_GUARD_MS,
        });
      } catch (err) {
        reportScanIssue(err, {
          branch: "express_repeat_guard_read_failed",
          eventId,
        });
        return true;
      }
    },
    [eventId],
  );

  /**
   * `handleAdmit` is defined below (it depends on state this callback sets), so
   * express reaches it through a ref rather than by hoisting a 90-line callback
   * above the thing that decides whether to call it.
   */
  const handleAdmitRef = useRef<
    ((code: string, opts: AdmitOptions) => void) | null
  >(null);

  /**
   * Identity of the admit currently ON SCREEN.
   *
   * `scanTicket` can outlive the 1.2s dwell and the camera re-arm — on venue
   * LTE that is normal, and NFR-001 only budgets p95 1.5s. A permanent
   * rejection for ticket A arriving after ticket B's state is up used to run
   * `setLastAdmit(null)` and `setErrorMessage(A's message)` against B: B's UNDO
   * went disabled, B's dwell stopped, and A's failure text was displayed over
   * B's verdict. Every async settler below checks this before touching
   * screen state.
   */
  const lastAdmitRef = useRef<{ scanId: string; ticketCode: string } | null>(
    null,
  );

  const applyResult = useCallback(
    (next: AnyScanResult) => {
      // ── FR-004 express mode ────────────────────────────────────────────
      // The verdict is taken ONCE, here, by the pure planner. Nothing
      // downstream re-derives "should this auto-admit?" — the rail, the
      // footer and the dwell all read this one object.
      //
      // It is computed BEFORE the feedback fires, not after: the re-admit
      // guard's halt changes which of the four signatures this outcome gets,
      // and a cue that has already played cannot be corrected.
      const plan = planExpressMode({
        enabled: expressModeEnabled,
        result: next,
        screenReaderEnabled,
        admittedRecentlyOnDevice:
          next.kind === "ticket"
            ? admittedRecentlyOnDevice(next.ticketCode)
            : false,
      });
      const readmitHalt =
        !plan.autoAdmit && plan.halt === "recently_admitted_here";

      setResult(next);
      setExpressPlan(plan);
      setUndoRefused(false);
      setUndoNotice(null);
      setAdmittedHereRecently(readmitHalt);
      triggerForResult(next, readmitHalt);
      // A re-admit halt is presented as ALREADY IN (`admittable: false`), so
      // the same-order bulk block would never render anyway — and offering
      // "admit all 4 from this order" under a state that just said "you already
      // admitted this one" is the opposite of the guard.
      if (readmitHalt) setSameOrderTickets([]);
      else applySameOrder(next);
      setConfirmManually(
        shouldShowConfirmManually({ enabled: expressModeEnabled, result: next }),
      );

      if (plan.autoAdmit && next.kind === "ticket") {
        handleAdmitRef.current?.(next.ticketCode, {
          // `result` state has NOT flushed yet — pass the outcome explicitly or
          // the recent-scans row is written with the PREVIOUS holder's name.
          forResult: next,
          // No re-resolve: the manual path re-resolves to show the operator the
          // now-SCANNED state, which for express would flip the green verdict to
          // amber mid-dwell, fire a second (wrong) audio cue, and spend a round
          // trip against NFR-001's 2s re-arm budget.
          reResolve: false,
          // The resolve already fired the ADMIT signature ~0ms ago.
          silentFeedback: true,
        });
      }
    },
    [
      admittedRecentlyOnDevice,
      applySameOrder,
      expressModeEnabled,
      screenReaderEnabled,
      triggerForResult,
    ],
  );

  /**
   * The manifest stores only `owner_human` (an id), so an offline ticket
   * result arrives with `holderDisplay: "Unknown"`. The name IS on the device
   * — the same sync writes the people table — so fill it in rather than
   * showing an operator a blank where a name belongs. Never fabricates: falls
   * back to whatever the resolver already decided.
   */
  const withHolderName = useCallback(
    (offline: OfflineResolveResult): OfflineResolveResult => {
      if (offline.kind !== "ticket" || !offline.holderHumanId) return offline;
      const name = lookupPersonName(eventId, offline.holderHumanId);
      return name ? { ...offline, holderDisplay: name } : offline;
    },
    [eventId],
  );

  const resolvePayload = useCallback(
    async (raw: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setInFlight(true);
      setErrorMessage(null);
      try {
        // FR-001, branch 1 — the device is offline. Not a failure; the
        // designed behaviour, so no server attempt is made at all.
        const preTrigger = offlineFallbackTrigger({ network });
        if (preTrigger) {
          applyResult(
            withHolderName(
              resolveScanOffline({ raw, eventId, trigger: preTrigger }),
            ),
          );
          return;
        }

        try {
          const next = (await utils.scan.resolvePayload.fetch({
            eventId,
            raw,
          })) as AnyScanResult;
          applyResult(next);
        } catch (err) {
          // FR-001, branch 2 — the resolver failed with a network-classified
          // error. `offline-scan-fallback` captures this to Sentry (NFR-006):
          // an API outage must not look like "the scanner is a bit slow
          // tonight" for four days.
          const postTrigger = offlineFallbackTrigger({ network, error: err });
          if (!postTrigger) throw err;
          applyResult(
            withHolderName(
              resolveScanOffline({
                raw,
                eventId,
                trigger: postTrigger,
                error: err,
              }),
            ),
          );
        }
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : "Scan resolve failed.",
        );
        AccessibilityInfo.announceForAccessibility("Scan resolve failed.");
        void triggerFeedback("rejected");
      } finally {
        inFlightRef.current = false;
        setInFlight(false);
      }
    },
    [applyResult, eventId, network, utils.scan.resolvePayload, withHolderName],
  );

  const handleBarcode = useCallback(
    (scan: { data: string }) => {
      const raw = scan.data?.trim();
      if (!raw) return;
      void resolvePayload(raw);
    },
    [resolvePayload],
  );

  const handleAdmit = useCallback(
    (ticketCode: string, opts: AdmitOptions = {}) => {
      const reResolve = opts.reResolve ?? true;
      const cue = () => {
        if (!opts.silentFeedback) void triggerFeedback("valid");
      };
      const clientKey = `unified-scan-${eventId}-${ctx?.operator.humanId ?? "anon"}`;
      // `opts.forResult` exists because express admits in the SAME tick the
      // result is applied, before `result` state has flushed.
      const active = opts.forResult ?? result;
      // Optimistic local mark — operator gets instant feedback, queue
      // reconciles with the server in the background.
      markTicketScannedLocally(ticketCode);
      const holderDisplay =
        active && active.kind === "ticket" ? active.holderDisplay : null;
      const ticketId =
        active && active.kind === "ticket" ? active.ticketId : null;
      const recent = recordRecentScan({
        eventId,
        ticketCode,
        ticketId,
        holderDisplay,
        kind: "ticket",
      });
      // FR-004 §5 — the express rail's UNDO acts on THIS row, selected by id.
      // Never "the most recent scan": an interleaved admit from another surface
      // would make that the wrong one, and this is an admission.
      setLastAdmit({
        scanId: recent.scanId,
        eventId,
        ticketCode,
        ticketId,
        queueId: null,
      });
      // Mirror for the async settlers below. `lastAdmit` is state and every
      // closure here captured the value at DISPATCH time; the question they
      // need to answer is "is my admit still the one on screen?", which only a
      // ref can answer.
      lastAdmitRef.current = { scanId: recent.scanId, ticketCode };
      /**
       * ⚠️ KNOWN GAP, pre-existing and deliberately NOT closed here.
       *
       * Between this dispatch and the settlement below there is NO queue row —
       * `enqueueAndLink` only runs in the offline/transient branches. If the
       * process dies in that window (OOM kill, force-quit, crash) the admission
       * is lost with no trace anywhere: the optimistic local mark is gone with
       * the in-memory state, and neither `scan_queue` nor `dropped_scans` ever
       * saw it. Closing it means enqueueing FIRST and removing on success,
       * which is a queue-semantics change with its own double-admit surface —
       * out of scope for this step. Do not widen this window further.
       */

      /**
       * ⚠️ DEPENDENCY — READ BEFORE CHANGING THIS BRANCH.
       *
       * A separate workstream is fixing a P0 in which the SERVER rejects real
       * ticket codes. Until that lands, an admit that enqueues here is an
       * admission the server may never accept: `use-scan-queue.ts` classifies
       * a hard server rejection as `permanent` and DROPS the row silently, so
       * a door-admitted attendee can end up unrecorded with nothing on any
       * surface saying so.
       *
       * This step deliberately does NOT add any new silent-drop path — the
       * enqueue below is the pre-existing behaviour, unchanged — and FR-010
       * (build step 4) is what makes terminal drops observable (Sentry +
       * a failed count on the strip + a retry affordance). Do not widen the
       * offline admit path further until FR-010 has landed.
       */
      const enqueueAndLink = () => {
        const queued = enqueueScan({ eventId, ticketCode, clientKey });
        // FR-006a: the undo path needs to know this admit never reached the
        // server, so it can cancel it locally with no network.
        attachQueueToRecentScan(recent.scanId, queued.queueId);
        setLastAdmit((prev) =>
          prev && prev.scanId === recent.scanId
            ? { ...prev, queueId: queued.queueId }
            : prev,
        );
      };

      if (network === "offline") {
        // No point burning a round trip we know will fail; the queue is the
        // designed path here and REPLAY semantics absorb any double-admit.
        enqueueAndLink();
        cue();
        if (reResolve) void resolvePayload(ticketCode);
        return;
      }

      void scanTicketMutation
        .mutateAsync({ eventId, ticketCode, clientKey })
        .then(() => {
          // Same identity guard as the rejection branch: a late SUCCESS must
          // not fire a chime over someone else's verdict, and its re-resolve
          // must not replace the result currently on screen with this ticket's.
          if (lastAdmitRef.current?.scanId !== recent.scanId) return;
          cue();
          if (reResolve) void resolvePayload(ticketCode);
        })
        .catch((err: unknown) => {
          // Network/transient failures get queued; operator already saw
          // the optimistic confirmation. Permanent errors (TRPC validation,
          // forbidden) surface immediately.
          const code =
            err && typeof err === "object" && "data" in err
              ? ((err as { data?: { code?: string } }).data?.code ?? "")
              : "";
          const isTransient =
            !code ||
            code === "INTERNAL_SERVER_ERROR" ||
            code === "TIMEOUT" ||
            (err instanceof TypeError && /network/i.test(err.message));

          if (isTransient) {
            enqueueAndLink();
            cue();
            if (reResolve) void resolvePayload(ticketCode);
          } else {
            // Permanent rejection — the server will never accept this admit.
            // Roll back the optimistic local mark NOW rather than letting the
            // counter over-report for up to a manifest-sync interval; the
            // operator is being told "not admitted" in the same frame.
            markTicketValidLocally(ticketCode);
            const message =
              err instanceof Error ? err.message : "Ticket admit failed.";
            const stale = lastAdmitRef.current?.scanId !== recent.scanId;
            reportScanIssue(err, {
              branch: "admit_permanent_rejection",
              eventId,
              tags: {
                express: opts.forResult ? "true" : "false",
                // A rejection that lost the race is a different investigation
                // from one the operator saw.
                late: stale ? "true" : "false",
              },
              extra: { errorCode: code || "unknown" },
            });

            /**
             * Only touch screen state if THIS admit is still the one on screen.
             *
             * Without the guard, ticket A's late rejection wrote A's error over
             * ticket B's live verdict, disabled B's UNDO (`setLastAdmit(null)`)
             * and stopped B's dwell — while A's operator had already walked
             * someone through the door two scans ago.
             */
            if (stale) {
              // The admission still has to be un-done and the operator still
              // has to find out. The local mark is already reverted above; the
              // recent-scans strip keeps its 30s row, and the Sentry event
              // above carries the `late` tag. Nothing is written to a state
              // that belongs to a different person.
              AccessibilityInfo.announceForAccessibility(
                "An earlier admission was rejected by the server. Check the recent scans list.",
              );
              return;
            }

            // The error state takes over the screen, and `expressDwellActive`
            // is gated on `!errorMessage` — so an express auto-admit that the
            // server rejects becomes STICKY. Auto-dismissing an admit failure
            // after 1.2s would clear the one message that says the person in
            // front of the operator was not let in.
            setLastAdmit(null);
            lastAdmitRef.current = null;
            setErrorMessage(message);
            AccessibilityInfo.announceForAccessibility(message);
            void triggerFeedback("rejected");
          }
        });
    },
    [
      eventId,
      network,
      resolvePayload,
      scanTicketMutation,
      ctx?.operator.humanId,
      result,
    ],
  );

  /**
   * Volunteer check-in.
   *
   * ## Why the lock exists
   *
   * FR-007 made CHECK IN the rail's PRIMARY action — a full-width button under
   * the operator's thumb — and this handler neither dismissed the state nor
   * disabled the control on success. A second tap (and at a door, a second tap
   * is the default gesture when nothing visibly changes) fired a second
   * mutation for the same signup. Unlike `scanTicket`, the check-in procedure
   * carries no client idempotency key, so the UI is where this has to be
   * closed.
   *
   * `checkedInSignupIds` survives dismissal deliberately: a volunteer who has
   * been checked in stays checked in for this screen's life, so re-scanning
   * their pass shows the action already done rather than offering it again.
   */
  const handleCheckIn = useCallback(
    (signupId: string) => {
      if (checkedInSignupIds.includes(signupId)) return;
      if (checkInMutation.isPending) return;
      void checkInMutation
        .mutateAsync({ signupId })
        .then(() => {
          setCheckedInSignupIds((prev) =>
            prev.includes(signupId) ? prev : [...prev, signupId],
          );
          void triggerFeedback("valid");
          AccessibilityInfo.announceForAccessibility("Volunteer checked in.");
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : "Volunteer check-in failed.";
          setErrorMessage(message);
          AccessibilityInfo.announceForAccessibility(message);
          void triggerFeedback("rejected");
        });
    },
    [checkInMutation, checkedInSignupIds],
  );

  /**
   * Same-order bulk admit.
   *
   * NFR-006: a permanent rejection inside this loop used to be dropped on the
   * floor — no message, no Sentry — while the outer `.then` still fired the
   * SUCCESS haptic. The operator was told "admitted" for tickets the server
   * had refused, and nothing anywhere recorded it. Failures are now counted,
   * reported (tags only — a ticket code is a bearer credential, NFR-005),
   * surfaced, and their optimistic local marks reverted.
   */
  const handleBulkAdmit = useCallback(
    (tickets: SameOrderTicket[]) => {
      if (tickets.length === 0) return;
      setBulkAdmitPending(true);
      const clientKeyBase = `bulk-${eventId}-${ctx?.operator.humanId ?? "anon"}`;
      const rejected: string[] = [];
      const promises = tickets.map((ticket) => {
        const code = ticket.ticketCode;
        markTicketScannedLocally(code);
        const recent = recordRecentScan({
          eventId,
          ticketCode: code,
          // FR-006a: carry the id so these rows are undoable like any other.
          ticketId: ticket.ticketId,
          holderDisplay: null,
          kind: "ticket",
        });
        const clientKey = `${clientKeyBase}-${code}`;
        const enqueueAndLink = () => {
          const queued = enqueueScan({ eventId, ticketCode: code, clientKey });
          attachQueueToRecentScan(recent.scanId, queued.queueId);
        };
        if (network === "offline") {
          enqueueAndLink();
          return Promise.resolve();
        }
        return scanTicketMutation
          .mutateAsync({ eventId, ticketCode: code, clientKey })
          .catch((err: unknown) => {
            const errCode =
              err && typeof err === "object" && "data" in err
                ? ((err as { data?: { code?: string } }).data?.code ?? "")
                : "";
            const isTransient =
              !errCode ||
              errCode === "INTERNAL_SERVER_ERROR" ||
              errCode === "TIMEOUT" ||
              (err instanceof TypeError && /network/i.test(err.message));
            if (isTransient) {
              enqueueAndLink();
              return;
            }
            rejected.push(code);
            markTicketValidLocally(code);
            reportScanIssue(err, {
              branch: "bulk_admit_permanent_rejection",
              eventId,
              extra: {
                errorCode: errCode || "unknown",
                batchSize: tickets.length,
              },
            });
          });
      });
      void Promise.all(promises)
        .then(() => {
          setSameOrderTickets([]);
          if (rejected.length > 0) {
            const message = `${rejected.length} of ${tickets.length} tickets were rejected and NOT admitted. Check them individually.`;
            setErrorMessage(message);
            AccessibilityInfo.announceForAccessibility(message);
            void triggerFeedback("rejected");
            return;
          }
          void triggerFeedback("valid");
          const first = tickets[0];
          if (first) void resolvePayload(first.ticketCode);
        })
        .finally(() => setBulkAdmitPending(false));
    },
    [
      eventId,
      network,
      ctx?.operator.humanId,
      scanTicketMutation,
      resolvePayload,
    ],
  );

  // `handleAdmit` is published to `applyResult` here rather than being hoisted
  // above it — the two are mutually recursive through `resolvePayload`.
  useEffect(() => {
    handleAdmitRef.current = handleAdmit;
  }, [handleAdmit]);

  // ── FR-004 express dwell ──────────────────────────────────────────────────
  /**
   * `!errorMessage` is load-bearing, not defensive noise: an express admit the
   * server rejects PERMANENTLY replaces the green verdict with an error state,
   * and a dwell still counting down behind it would clear that error after
   * 1.2s. The one message telling the operator this person was NOT admitted
   * must be the one message that never auto-dismisses.
   */
  const expressActive = !!expressPlan?.autoAdmit && !!result && !errorMessage;
  const dwell = useExpressDwell({
    active: expressActive,
    /**
     * Three things suspend the countdown, and each one is a state the operator
     * has to be able to READ:
     *
     *   - `expressPlan.autoDismiss` false — a screen reader is active (NFR-002).
     *   - `undoRefused` — the state says "couldn't undo"; clearing that after
     *     1.2s is the same as never having said it.
     *   - `undoInFlight` — a dwell expiring mid-`revertTicketScan` calls
     *     `dismissResult`, which clears `undoNotice`, and the settling `.then`
     *     then writes the refusal into a state nobody is looking at.
     */
    autoDismiss:
      !!expressPlan?.autoAdmit &&
      expressPlan.autoDismiss &&
      !undoRefused &&
      !undoInFlight,
    dwellMs: expressPlan?.autoAdmit ? expressPlan.dwellMs : 0,
    // Identity of the admission this countdown belongs to — a timer can never
    // be inherited by the next person's verdict.
    resultKey: lastAdmit?.scanId ?? null,
    onExpire: dismissResult,
  });

  /**
   * Express UNDO (design §5). The strip's 30s undo stays mounted underneath and
   * is the real safety net; at 1.2s an operator cannot read a strip, find a row
   * and hit it, so the rail carries the same action for the row THIS admit
   * wrote. Both go through `useScanUndo` — one implementation of "queued or
   * acknowledged?".
   */
  const handleExpressUndo = useCallback(() => {
    const target = lastAdmit;
    if (!target) return;
    setUndoNotice(null);
    // Set synchronously, before the await: this is what stops the dwell from
    // expiring underneath the round trip.
    setUndoInFlight(true);
    void undoScan(target)
      .then((outcome) => {
        // Is this still the admission on screen? If the operator dismissed and
        // scanned someone else while the revert was in flight, writing a notice
        // now would put it over a different person's verdict.
        const current = lastAdmitRef.current?.scanId === target.scanId;

        if (outcome.kind === "undone") {
          if (!current) return;
          void triggerFeedback("valid");
          AccessibilityInfo.announceForAccessibility("Admission undone.");
          dismissResult();
          return;
        }

        // A refusal must be VISIBLE and must stop the cycling: an express state
        // that dismissed itself 1.2s after telling the operator "couldn't undo"
        // is the same as not telling them.
        //
        // `setUndoRefused(true)` — NOT `setExpressPlan(null)`, which is what
        // shipped. Nulling the plan made `expressActive` false in the SAME
        // React 18 commit as the notice, so the notice (rendered inside the
        // express branch) never mounted, and the rail fell through to `admit`:
        // ADMIT under the operator's thumb one frame after they failed to
        // un-admit that ticket. Keeping the plan and raising a flag keeps the
        // rail in the express family, where `planScanRail` routes it to
        // `refused`.
        if (!current) {
          // The state is gone. Report it — an admission the operator asked to
          // revert, and could not, is exactly the thing that must not vanish.
          reportScanIssue(new Error(outcome.message), {
            branch: "express_undo_refused_after_dismiss",
            eventId,
          });
          AccessibilityInfo.announceForAccessibility(
            "An earlier admission could not be undone. Check the recent scans list.",
          );
          return;
        }
        setUndoRefused(true);
        setUndoNotice(outcome.message);
        void triggerFeedback("rejected");
        AccessibilityInfo.announceForAccessibility(outcome.message);
      })
      .finally(() => setUndoInFlight(false));
  }, [dismissResult, eventId, lastAdmit, undoScan]);

  const isLoading = scanTicketMutation.isPending || checkInMutation.isPending;
  // Hard-pause the camera whenever a result OR an error banner is on screen
  // (NFR-003). This covers wrong_event the same way it covers scan errors: the
  // operator must explicitly dismiss before the camera resumes, so a QR that
  // moves slightly out of frame and back cannot re-trigger the resolver.
  const cameraPaused = !!result || !!errorMessage || inFlight;

  /**
   * The verdict, decided ONCE. Both the state and the rail read this object,
   * so they cannot disagree about whether an outcome is admittable — which is
   * the difference between "ADMIT" under a red screen and a coherent surface.
   */
  const presentation = useMemo(() => {
    if (!result) return null;
    return presentScanResult(
      describeScanResult(result, {
        selectedEventName: eventName ?? null,
        scannedAtLabel:
          result.kind === "ticket" ? safeTimeString(result.scannedAt) : null,
        // FR-004's re-admit guard, made visible: without this the halt showed
        // the operator the full-bleed green ADMIT state it was halting.
        admittedHereRecently,
      }),
    );
  }, [result, eventName, admittedHereRecently]);

  /**
   * What the rail offers, decided by the same pure table the tests assert —
   * INCLUDING the express states.
   *
   * Design §5's swap table has rows for VALID-manual, VALID-express and "any
   * other". A volunteer is none of them, so it fell through to "DISMISS AND
   * SCAN NEXT" (`admittable` is false for volunteers BY DESIGN), stranding the
   * one thing an operator can do with a volunteer pass below the fold. And the
   * table's VALID-express row silently assumed auto-dismiss always runs —
   * NFR-002 suspends it for screen-reader users, and the rail rendered UNDO
   * alone with no dwell to clear it and no tap-to-dismiss either. Both of those
   * were JSX branch logic; both are now rows in a node-tested table.
   */
  const rail = useMemo(
    () =>
      result && presentation
        ? planScanRail({
            result,
            admittable: presentation.admittable,
            canCheckInVolunteer: canCheckIn,
            express: expressActive
              ? {
                  autoAdmit: true,
                  autoDismiss: !!expressPlan?.autoAdmit && expressPlan.autoDismiss,
                  undoRefused,
                }
              : null,
          })
        : null,
    [result, presentation, canCheckIn, expressActive, expressPlan, undoRefused],
  );

  /**
   * Has the volunteer on screen already been checked in from this screen? Drives
   * the post-success lock on BOTH controls that can fire the mutation (the rail
   * and, on the search screen's inline layout, the detail panel), so a
   * double-tap cannot produce a second check-in.
   */
  const volunteerCheckedIn =
    rail?.kind === "check-in" && checkedInSignupIds.includes(rail.signupId);

  /**
   * Design §2.4 / §6 — both derived from the SAME plan the rail renders, so
   * "what can this state do?" has one answer.
   *
   * The version keyed on `presentation.admittable` alone is half of blocker 1:
   * a screen-reader express state is VALID (⇒ admittable ⇒ no tap-to-dismiss)
   * while its rail offered only UNDO and its dwell never ran. Nothing on the
   * screen could clear it.
   */
  const tapDismissable = rail ? railTapDismissable(rail) : false;
  const holdable = rail ? railHoldable(rail) : false;

  const viewfinder = viewfinderSize(frameWidth);
  const onFrameLayout = useCallback((e: LayoutChangeEvent) => {
    setFrameWidth(e.nativeEvent.layout.width);
  }, []);

  if (mode === "search") {
    return (
      <UnifiedSearchScreen
        eventId={eventId}
        eventName={eventName}
        sessionContext={sessionContext}
        onBack={() => setMode("camera")}
        // Explicit arity: express never applies to a search-driven admit (it is
        // a camera-scan behaviour), and passing `handleAdmit` bare would let a
        // future prop signature start supplying `AdmitOptions` by accident.
        onAdmit={(code) => handleAdmit(code)}
        onCheckIn={handleCheckIn}
      />
    );
  }

  return (
    <View style={shared.screen} testID="unified-scan-screen">
      <View style={localStyles.topBar}>
        <TopBar
          title="Scan"
          subtitle={eventName ?? "Selected event"}
          onBack={onBack}
        />
      </View>

      <StatsStrip
        scanned={counts.scanned}
        total={counts.total}
        offline={network === "offline"}
        queueDepth={queueDepth}
        // FR-010 — "someone got in and the server does not know". Outranks
        // every other chip in the collapse ladder for exactly that reason.
        failedCount={failedCount}
        // FR-004 — a mode that admits people with zero taps must never be
        // invisible. The `Zap` glyph shows whenever express is ENABLED, not
        // only during a result.
        expressEnabled={expressModeEnabled}
        onPress={onOpenCounts ?? onBack}
        testID="unified-scan-stats-strip"
      />

      {/*
        SCAN REGION — the layer the result state covers, edge to edge. It has
        no horizontal padding, which is what makes "full-bleed" true rather
        than aspirational.
      */}
      <View style={localStyles.scanRegion}>
        {!permission ? (
          <View style={localStyles.gutter}>
            <Panel>
              <LoadingState label="Checking camera access…" />
            </Panel>
          </View>
        ) : !permission.granted ? (
          <View style={localStyles.gutter}>
            <PermissionGate
              canAskAgain={permission.canAskAgain}
              onRequest={() => {
                void requestPermission();
              }}
            />
          </View>
        ) : (
          <View
            style={shared.cameraFrame}
            onLayout={onFrameLayout}
            testID="unified-scan-camera-frame"
          >
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              active={!cameraPaused}
              enableTorch={torchOn}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={cameraPaused ? undefined : handleBarcode}
            />
            {/*
              Proportional viewfinder (design §1) — same optical framing on an
              SE and a Max instead of a fixed 220 box. Stroke colours stay
              FIXED: this one still paints on the camera feed.
            */}
            <View
              style={[
                shared.viewfinder,
                {
                  width: viewfinder,
                  height: viewfinder,
                  marginLeft: -viewfinder / 2,
                  marginTop: -viewfinder / 2,
                },
                cameraPaused ? shared.viewfinderLocked : null,
              ]}
              pointerEvents="none"
            />
            {inFlight ? (
              <View style={shared.cameraLoadingOverlay} pointerEvents="none">
                <ActivityIndicator color={FIXED.viewfinderStroke} />
              </View>
            ) : null}
          </View>
        )}

        {/*
          FR-006c — the strip is MOUNTED unconditionally, not rendered only
          when idle. Keeping it mounted is what preserves its 30s countdowns
          across a result (and, once FR-004 lands, across express cycling)
          instead of resetting them every time a verdict appears.
        */}
        {/*
          `maxRows={3}` is a fit constraint, not a preference. This region is
          `flex: 1, overflow: hidden` and its other child (`cameraFrame`) is
          `minHeight: 320` with RN's default `flexShrink: 0`, so five 44pt undo
          rows do not shrink — they get clipped, oldest-first, and the oldest
          rows are exactly the ones about to fall out of the 30s window. The
          strip itself also shrinks and scrolls; both are needed.
        */}
        <RecentScansStrip eventId={eventId} maxRows={3} />

        {/*
          ERROR takes precedence over a live result, deliberately. The
          dangerous case is a permanent admit failure while the VALID state is
          still up: the operator has been told "admitted", the server said no,
          and if the error rendered UNDER the verdict they would never see it.
          `dismissResult` clears both, so there is no half-state.
        */}
        {errorMessage ? (
          // A resolve/admit failure is not one of the eleven outcomes, but it
          // is still a STOP: render it through the same full-bleed state
          // rather than regressing to a card in a scroll region.
          <ToneResultState
            tone="stop"
            glyph={ShieldAlert}
            verdict="SCAN FAILED"
            badge="ERROR"
            guidance={errorMessage}
            onDismiss={dismissResult}
            testID="unified-scan-error"
          />
        ) : result && presentation ? (
          <UnifiedResultView
            result={result}
            presentation={presentation}
            canCheckInVolunteer={canCheckIn}
            onAdmitTicket={(code) => handleAdmit(code)}
            admitPending={scanTicketMutation.isPending}
            onCheckInVolunteer={handleCheckIn}
            checkInPending={checkInMutation.isPending || volunteerCheckedIn}
            onScanCrossTicket={(code) => {
              void resolvePayload(code);
            }}
            resolvePending={inFlight}
            sameOrderTickets={sameOrderTickets}
            onBulkAdmit={handleBulkAdmit}
            bulkAdmitPending={bulkAdmitPending}
            onDismiss={tapDismissable ? dismissResult : undefined}
            // FR-004 §3 — the VISIBLE half of the 10-minute freshness gate.
            // Without it an operator just notices express "randomly stopped".
            confirmManually={confirmManually}
            // Design §6 — press and hold pauses the dwell; release restarts it
            // from FULL. The per-scan answer to "let me look at this one
            // longer", which is why there is no 1s/2s preference.
            //
            // `holdable`, not `expressActive`: with auto-dismiss suspended
            // there is no countdown to pause, and wiring hold handlers anyway
            // gives the operator a gesture that does nothing plus (because
            // `ToneResultState` composes one accessibility target for an
            // interactive block) a hint about a countdown that is not running.
            onHoldStart={holdable ? dwell.hold : undefined}
            onHoldEnd={holdable ? dwell.release : undefined}
            footer={
              expressActive ? (
                <ExpressDwellFooter
                  tone={presentation.tone}
                  phase={dwell.phase}
                  durationMs={
                    expressPlan?.autoAdmit ? expressPlan.dwellMs : 0
                  }
                  reducedMotion={reducedMotion}
                  cycleKey={dwell.cycleKey}
                  testID="express-dwell-footer"
                />
              ) : undefined
            }
          />
        ) : null}
      </View>

      {/* ── CONTROL RAIL (FR-007) ──────────────────────────────────────────
          Everything interactive lives here, inside one-handed thumb reach.
          After this change the ONLY things over the camera are the
          pointerEvents="none" viewfinder and the pointerEvents="none"
          in-flight scrim — FR-007 satisfied literally. */}
      <SafeAreaView edges={["bottom"]} style={localStyles.rail}>
        {errorMessage ? (
          <SquarePrimaryButton
            label="Dismiss and scan next"
            onPress={dismissResult}
            disabled={isLoading}
            testID="unified-scan-dismiss-button"
            accessibilityHint="Clears the current result and re-enables the camera."
          />
        ) : rail?.kind === "express-undo" ? (
          /*
            FR-004 / design §6 — express admitted this ticket AND the dwell will
            clear the state on its own, so UNDO is the only control. The express
            kinds come before `admit` for one reason: express has already
            admitted this ticket, and offering ADMIT here would put a SECOND
            admission one thumb-width from where the operator is looking.

            The strip's 30s undo stays mounted underneath and is the real safety
            net; this is the one an operator can actually reach inside 1.2s.
          */
          <SquareSecondaryButton
            label="Undo"
            onPress={handleExpressUndo}
            disabled={!lastAdmit || undoPending}
            testID="express-undo-button"
            accessibilityLabel="Undo this admission"
            accessibilityHint="Reverts the ticket that was just auto-admitted."
          />
        ) : rail?.kind === "express-undo-with-dismiss" ||
          rail?.kind === "refused" ? (
          /*
            Two states, one layout, and both exist because there is NO dwell
            coming to clear them:

              - `express-undo-with-dismiss` — a screen reader is active, so
                NFR-002 suspended auto-dismiss. This is blocker 1: the shipped
                rail rendered UNDO alone here while tap-to-dismiss was withheld
                (VALID *is* admittable), so nothing on the screen could clear
                the state. The only exits were the TopBar back button and a tab
                round-trip that remounts the screen. Per scan. Every scan.
              - `refused` — an UNDO came back refused, so the admission stands
                and the notice below has to stay readable.

            Stacked, not a row: "DISMISS AND SCAN NEXT" beside a secondary does
            not fit an SE's 331pt of rail without wrapping, and this is the one
            rail state where throughput is not the constraint.
          */
          <>
            <SquarePrimaryButton
              label="Dismiss and scan next"
              onPress={dismissResult}
              disabled={isLoading}
              testID="unified-scan-dismiss-button"
              accessibilityHint="Clears the current result and re-enables the camera. The ticket stays admitted."
            />
            <SquareSecondaryButton
              label="Undo"
              onPress={handleExpressUndo}
              disabled={!lastAdmit || undoPending}
              testID="express-undo-button"
              accessibilityLabel="Undo this admission"
              accessibilityHint={
                rail.kind === "refused"
                  ? "Tries again to revert the ticket that was auto-admitted."
                  : "Reverts the ticket that was just auto-admitted."
              }
            />
          </>
        ) : rail?.kind === "admit" ? (
          <View style={localStyles.railRow}>
            <View style={{ flex: 1 }}>
              <SquarePrimaryButton
                label="Admit"
                onPress={() => handleAdmit(rail.ticketCode)}
                disabled={isLoading}
                testID="scan-result-admit-button"
                accessibilityHint="Records this ticket as admitted."
              />
            </View>
            <SquareSecondaryButton
              label="Skip"
              onPress={dismissResult}
              disabled={isLoading}
              testID="unified-scan-skip-button"
              accessibilityHint="Dismisses without admitting and re-arms the camera."
            />
          </View>
        ) : rail?.kind === "check-in" ? (
          <>
            <View style={localStyles.railRow}>
              <View style={{ flex: 1 }}>
                <SquarePrimaryButton
                  // The label changes on success, so "nothing happened" is
                  // never the operator's reading — which is what produced the
                  // second tap in the first place.
                  label={volunteerCheckedIn ? "Checked in" : "Check in"}
                  onPress={() => handleCheckIn(rail.signupId)}
                  // Disabled AFTER a success: this mutation has no client
                  // idempotency key, so a double-tap on a full-width primary
                  // action is a second check-in.
                  disabled={isLoading || volunteerCheckedIn}
                  // `locked` keeps the orange border (so the operator still
                  // reads "this is THE primary action, currently locked")
                  // while muting only fill and text. Distinct from `disabled`.
                  locked={rail.locked}
                  testID="scan-result-check-in-button"
                  accessibilityHint={
                    volunteerCheckedIn
                      ? "Already checked in on this device."
                      : rail.locked
                        ? "Volunteer check-in is disabled because your role does not include OWNER, ADMIN, or EDITOR. Ask an org admin to upgrade your role."
                        : "Marks this volunteer as checked in."
                  }
                />
              </View>
              <SquareSecondaryButton
                label="Dismiss"
                onPress={dismissResult}
                disabled={isLoading}
                testID="unified-scan-skip-button"
                accessibilityHint="Dismisses without checking in and re-arms the camera."
              />
            </View>
            {rail.locked ? (
              <Text variant="caption" tone="muted">
                Volunteer check-in needs OWNER, ADMIN, or EDITOR. Ask an org
                admin.
              </Text>
            ) : null}
          </>
        ) : result && presentation ? (
          <SquarePrimaryButton
            label="Dismiss and scan next"
            onPress={dismissResult}
            disabled={isLoading}
            testID="unified-scan-dismiss-button"
            accessibilityHint="Clears the current result and re-enables the camera."
          />
        ) : mode === "code-entry" ? (
          <View style={localStyles.codeEntryRow}>
            <TextInput
              value={codeEntry}
              onChangeText={setCodeEntry}
              placeholder="Ticket code"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
              style={[shared.input, localStyles.codeInput]}
              testID="unified-scan-code-input"
              onSubmitEditing={() => {
                const code = codeEntry.trim().toUpperCase();
                if (code.length > 0) {
                  setCodeEntry("");
                  setMode("camera");
                  void resolvePayload(code);
                }
              }}
            />
            <SquarePrimaryButton
              label="Go"
              onPress={() => {
                const code = codeEntry.trim().toUpperCase();
                if (code.length > 0) {
                  setCodeEntry("");
                  setMode("camera");
                  void resolvePayload(code);
                }
              }}
              disabled={codeEntry.trim().length === 0 || inFlight}
              testID="unified-scan-code-submit"
              accessibilityHint="Resolves the manually typed ticket code."
            />
            <SquareSecondaryButton
              label="Cancel"
              onPress={() => {
                setCodeEntry("");
                setMode("camera");
              }}
              testID="unified-scan-code-cancel"
            />
          </View>
        ) : (
          /*
            Order is a REACH decision, not an aesthetic one. For a right-handed
            one-handed grip the thumb arc covers bottom-right best and
            bottom-left worst — so the torch (most-toggled in a dark room) goes
            right and the keypad (rarest: damaged QR only) goes left. Sound &
            haptics sits beside the keypad: flipped a few times a night at
            most, and never in the tight loop where the torch is.
          */
          <View style={localStyles.railRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Type ticket code"
              accessibilityHint="Opens an input to type a ticket code manually for damaged QRs."
              onPress={() => setMode("code-entry")}
              style={localStyles.iconRailButton}
              testID="unified-scan-open-code-entry"
            >
              <KeyboardIcon size={20} color={colors.color} />
            </Pressable>
            {onToggleFeedback ? (
              <ScanFeedbackButton
                enabled={feedbackEnabled}
                onToggle={() => onToggleFeedback(!feedbackEnabled)}
                testID="unified-scan-feedback-toggle"
              />
            ) : null}
            <View style={{ flex: 1 }}>
              <SquareSecondaryButton
                label="Search"
                onPress={() => setMode("search")}
                testID="unified-scan-open-search-button"
                accessibilityLabel="Manual search"
                accessibilityHint="Opens a name, email, or ticket-code search."
              />
            </View>
            <TorchButton
              enabled={torchOn}
              onToggle={() => setTorchOn((v) => !v)}
              testID="unified-scan-torch-toggle"
            />
          </View>
        )}

        {/*
          RAIL-LEVEL, and outside every branch above — blocker 2.

          This used to live inside the express branch, and `handleExpressUndo`
          set the notice AND nulled the express plan. React 18 batched both into
          ONE commit, so the branch it was mounted in stopped rendering in the
          same frame the message appeared: the operator got a buzz, an
          announcement, and no on-screen text — which is exactly what the
          comment above the setter said it must prevent.

          A refusal is a fact about the RAIL ("the admission you tried to undo
          still stands"), not about any one of its layouts, so it renders where
          rail-level facts render.
        */}
        {undoNotice ? (
          <View
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            testID="unified-scan-undo-notice"
          >
            <Text variant="caption" tone="warning">
              {undoNotice}
            </Text>
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
};

const makeLocalStyles = (colors: NativePalette) =>
  StyleSheet.create({
    topBar: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 12,
    },
    /**
     * The layer the result state covers. `position: relative` is implicit in
     * RN, but the result state is `absoluteFill`, so this view MUST stay the
     * nearest positioned ancestor and MUST NOT gain horizontal padding.
     */
    scanRegion: {
      flex: 1,
      overflow: "hidden",
    },
    /** Padding for non-camera content INSIDE the unpadded scan region. */
    gutter: {
      flex: 1,
      padding: 16,
    },
    /** Rail padding drops from `stickyFooter`'s 20 to 16 — buys the SE 8pt. */
    rail: {
      borderTopWidth: 2,
      borderTopColor: colors.borderColor,
      backgroundColor: colors.surface,
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 16,
      gap: 12,
    },
    railRow: {
      flexDirection: "row",
      gap: 12,
      alignItems: "stretch",
    },
    /** Same 52×52 geometry as the torch so the rail has ONE button height. */
    iconRailButton: {
      width: 52,
      minHeight: 52,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: colors.borderColor,
      borderRadius: 0,
      backgroundColor: colors.surface,
    },
    codeEntryRow: {
      gap: 12,
    },
    codeInput: {
      minHeight: 52,
      letterSpacing: 2,
      fontWeight: "700",
      textTransform: "uppercase",
    },
  });

const PermissionGate = ({
  canAskAgain,
  onRequest,
}: {
  canAskAgain: boolean;
  onRequest: () => void;
}) => {
  const shared = useStyles();
  return (
    <View style={shared.card} testID="unified-scan-permission-gate">
      <Text accessibilityRole="header" variant="h5" weight="bold">
        Camera access required
      </Text>
      <Text variant="body">
        The scanner needs camera access to read Ithas Fire ticket and volunteer
        QR codes.
      </Text>
      {canAskAgain ? (
        <SquarePrimaryButton
          label="Grant camera access"
          onPress={onRequest}
          testID="unified-scan-grant-permission-button"
        />
      ) : (
        <>
          {/*
          Once iOS/Android marks camera permission as "don't ask again",
          the in-app prompt is a no-op. Pivot the operator to system
          Settings with explicit copy so they understand why the in-app
          button isn't here anymore.
        */}
          <Text variant="bodySmall" tone="muted">
            You've previously denied camera access for this app. Re-enable it in
            system Settings to scan.
          </Text>
          <SquareSecondaryButton
            label="Open Settings"
            onPress={() => {
              void Linking.openSettings();
            }}
            testID="unified-scan-open-settings-button"
            accessibilityHint="Opens system Settings to enable camera access for the scanner."
          />
        </>
      )}
    </View>
  );
};
