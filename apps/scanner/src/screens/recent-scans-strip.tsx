import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Undo2, WifiOff } from "lucide-react-native";

import { Text, useColors } from "@th/ui-native";

import { useNetworkState } from "../features/network/use-network-state";
import { listQueuedScans, listRecentScans, type RecentScan } from "../lib/local-db";
import { triggerFeedback } from "../lib/feedback";
import { useScanUndo } from "../lib/use-scan-undo";

const UNDO_WINDOW_MS = 30_000;
const REFRESH_INTERVAL_MS = 1_000;
/** Read a few extra so per-event filtering can't starve the visible list. */
const RECENT_FETCH_LIMIT = 20;

const queueKey = (eventId: string, code: string) =>
  `${eventId} ${code.trim().toUpperCase()}`;

/**
 * Last-5 scans with a 30-second undo (FR-006).
 *
 * ## Two undo paths, and the difference matters
 *
 * The decision and the writes live in `lib/use-scan-undo.ts` — FR-004's express
 * rail needs the same undo, and two implementations of "which path applies?" is
 * how one of them ships wrong. In short: a queued scan the server never saw
 * undoes LOCALLY with no network; a server-acknowledged one needs a connection,
 * so offline the button goes DISABLED with a hint rather than failing with an
 * error haptic (the pre-FR-006 behaviour). See that module for the full
 * reasoning.
 *
 * This component keeps what is genuinely its own: the 30s window, the 1Hz
 * countdown, the live queue read, and the per-row refusal notice.
 *
 * ## "Queued?" is a LIVE read, never the cached column
 *
 * `recent_scans.queue_id` is a pointer written at admit time. It used to be
 * the first half of the `isQueued` test, and that disjunct never went false:
 * a successful flush deleted the queue row and left the column set. The strip
 * then rendered UNDO enabled (captioned "· queued") for a scan the server had
 * already accepted, the local cancel found nothing, and — offline — the whole
 * handler returned without a haptic, a message or a state change. The
 * operator believed an admission was reverted; the server still held it.
 *
 * So: `queuedKeys` is re-read from `scan_queue` on the same 1Hz tick the
 * countdown already runs. It covers current rows AND rows written before the
 * `queue_id` column existed, and it cannot go stale by more than a second.
 * `removeQueuedScan` also clears the column now, but the strip does not
 * depend on that.
 */
export const RecentScansStrip = ({
  eventId,
  maxRows = 5,
}: {
  eventId: string;
  /**
   * Rows shown. The scan screen passes 3: this strip shares a fixed-height
   * region with a `minHeight: 320` camera frame, and five rows of 44pt undo
   * buttons overflow an SE-class device — clipping the OLDEST rows, which are
   * the ones about to fall out of the 30s window.
   */
  maxRows?: number;
}) => {
  const colors = useColors();
  const network = useNetworkState();
  const [scans, setScans] = useState<RecentScan[]>([]);
  const [queuedKeys, setQueuedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [now, setNow] = useState(Date.now());
  /** Scan-scoped explanation for an undo that could NOT be performed. */
  const [notice, setNotice] = useState<{
    scanId: string;
    message: string;
  } | null>(null);
  const { undoScan, pending: undoPending } = useScanUndo();

  useEffect(() => {
    const update = () => {
      setScans(
        listRecentScans(RECENT_FETCH_LIMIT)
          .filter((s) => s.eventId === eventId && !s.undone)
          .slice(0, maxRows),
      );
      setQueuedKeys(
        new Set(
          listQueuedScans().map((q) => queueKey(q.eventId, q.ticketCode)),
        ),
      );
      setNow(Date.now());
    };
    update();
    const id = setInterval(update, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [eventId, maxRows]);

  const drop = useCallback((scanId: string) => {
    setScans((prev) => prev.filter((s) => s.scanId !== scanId));
    setNotice((prev) => (prev?.scanId === scanId ? null : prev));
  }, []);

  /**
   * An undo that cannot happen must SAY so. The branch below used to be a bare
   * `return` — no haptic, no message, no state change — which reads to an
   * operator as "it worked".
   */
  const refuse = useCallback((scanId: string, message: string) => {
    setNotice({ scanId, message });
    void triggerFeedback("rejected");
  }, []);

  const handleUndo = useCallback(
    (scan: RecentScan) => {
      setNotice(null);
      void undoScan({
        scanId: scan.scanId,
        eventId: scan.eventId,
        ticketCode: scan.ticketCode,
        ticketId: scan.ticketId,
        queueId: scan.queueId,
      }).then((outcome) => {
        if (outcome.kind === "undone") {
          drop(scan.scanId);
          void triggerFeedback("valid");
          return;
        }
        refuse(scan.scanId, outcome.message);
      });
    },
    [drop, refuse, undoScan],
  );

  if (scans.length === 0) return null;

  return (
    <View
      style={[
        styles.container,
        {
          borderColor: colors.borderColorSoft,
          backgroundColor: colors.surfaceRaised,
        },
      ]}
      testID="recent-scans-strip"
    >
      <Text
        variant="caption"
        weight="bold"
        style={[styles.label, { color: colors.colorMuted }]}
      >
        RECENT
      </Text>
      {/*
        `flexShrink: 1` on the container plus a scroll here is the second half
        of the SE fix: when the region is too short for the rows that DO fit
        under `maxRows`, they scroll instead of being clipped with no way to
        reach the oldest undo button.
      */}
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
      >
        {scans.map((scan) => {
          const elapsed = now - scan.scannedAt;
          const inWindow = elapsed < UNDO_WINDOW_MS;
          // LIVE queue read only — see the docblock.
          const isQueued = queuedKeys.has(
            queueKey(scan.eventId, scan.ticketCode),
          );
          // A queued scan is cancellable with no ticket id and no network at
          // all — the row never left the device. Requiring `ticketId` made
          // FR-006a unreachable for every bulk admit (which records none) and
          // for every admit driven from the search screen.
          const undoable =
            scan.kind === "ticket" && inWindow && (isQueued || !!scan.ticketId);
          // Queued scans undo with no network at all; acknowledged ones need one.
          const blockedOffline = !isQueued && network === "offline";
          const secondsLeft = Math.max(
            0,
            Math.ceil((UNDO_WINDOW_MS - elapsed) / 1000),
          );
          const rowNotice =
            notice?.scanId === scan.scanId ? notice.message : null;
          return (
            <View key={scan.scanId} style={styles.rowGroup}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text variant="bodySmall" weight="bold">
                    {scan.holderDisplay ?? scan.ticketCode}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {Math.floor(elapsed / 1000)}s ago
                    {isQueued ? " · queued" : ""}
                  </Text>
                </View>
                {undoable ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled: blockedOffline || undoPending,
                    }}
                    accessibilityLabel={`Undo scan for ${scan.holderDisplay ?? scan.ticketCode}`}
                    accessibilityHint={
                      blockedOffline
                        ? "Unavailable offline. This scan already reached the server, so undoing it needs a connection."
                        : "Reverts this admission."
                    }
                    onPress={() => handleUndo(scan)}
                    disabled={blockedOffline || undoPending}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={[
                      styles.undoBtn,
                      {
                        borderColor: blockedOffline
                          ? colors.borderColorSoft
                          : colors.accentText,
                      },
                    ]}
                    testID={`undo-scan-${scan.scanId}`}
                  >
                    {/*
                      `accentText`, not `accent` — this is an interactive control's
                      accessible label, and the accent hue as copy is only 3.57:1 on
                      Stub's cream. DS v2 §9. The disabled rung uses `colorMuted`
                      (7.16:1 Ember / 7.14:1 Stub), never an alpha.
                    */}
                    {blockedOffline ? (
                      <WifiOff size={14} color={colors.colorMuted} />
                    ) : (
                      <Undo2 size={14} color={colors.accentText} />
                    )}
                    <Text
                      variant="caption"
                      weight="bold"
                      style={[
                        styles.undoText,
                        {
                          color: blockedOffline
                            ? colors.colorMuted
                            : colors.accentText,
                        },
                      ]}
                    >
                      {blockedOffline ? "OFFLINE" : `UNDO ${secondsLeft}s`}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {rowNotice ? (
                <View
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  testID={`undo-notice-${scan.scanId}`}
                >
                  <Text variant="caption" tone="warning">
                    {rowNotice}
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
};

/** Geometry only — colours applied inline from `useColors()`. */
const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    padding: 12,
    gap: 8,
    // The camera frame is `minHeight: 320` and, like every RN node, defaults
    // to `flexShrink: 0`. Without this the strip and the frame both refuse to
    // shrink and the taller of the two is clipped by the region's
    // `overflow: hidden` — silently, with no scroll to recover it.
    flexShrink: 1,
  },
  label: {
    fontSize: 10,
    letterSpacing: 2,
  },
  list: {
    flexShrink: 1,
  },
  listContent: {
    gap: 8,
  },
  rowGroup: {
    gap: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  undoBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 44,
    minWidth: 88,
    borderWidth: 1,
  },
  undoText: {
    fontSize: 10,
    letterSpacing: 1,
  },
});
