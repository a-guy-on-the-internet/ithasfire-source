import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import {
  AlertTriangle,
  LogOut,
  ScanLine,
  Search,
  WifiOff,
} from "lucide-react-native";
import { getEventCounts, type EventCounts } from "../lib/local-db";
import { getAppVersion } from "../lib/app-info";
import { useReducedMotion } from "../lib/use-reduced-motion";
import {
  Column,
  ScreenSurface,
  Text,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";
import { EventSelector, type SelectableEvent } from "../ui/event-selector";

export const HomeScreen = ({
  eventId,
  eventName,
  userEmail,
  queueDepth,
  failedCount = 0,
  selectableEvents,
  selectedEventId,
  onSelectEvent,
  onOpenUnifiedScan,
  onOpenLookup,
  onOpenSettings,
  onSignOut,
}: {
  eventId: string | null;
  eventName: string | null;
  userEmail: string;
  queueDepth: number;
  /** FR-010 — queued admits that will never reach the server unaided. */
  failedCount?: number;
  selectableEvents: SelectableEvent[];
  selectedEventId: string | null;
  onSelectEvent: (eventId: string) => void;
  onOpenUnifiedScan: () => void;
  onOpenLookup: () => void;
  /** FR-010 — the failed-sync banner's destination (the retry lives there). */
  onOpenSettings?: () => void;
  onSignOut: () => Promise<void>;
}) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const [counts, setCounts] = useState<EventCounts>({ total: 0, scanned: 0 });

  useEffect(() => {
    if (!eventId) return;
    const update = () => setCounts(getEventCounts(eventId));
    update();
    const id = setInterval(update, 5_000);
    return () => clearInterval(id);
  }, [eventId]);

  const pct = counts.total > 0 ? counts.scanned / counts.total : 0;
  const isNearCapacity = pct >= 0.9 && pct < 1;
  const isAtCapacity = pct >= 1;
  const capacityAlert = isAtCapacity || isNearCapacity;

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (!capacityAlert || reducedMotion) {
      pulseAnim.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.6,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [capacityAlert, reducedMotion, pulseAnim]);

  return (
    <ScreenSurface testID="scanner-home-screen">
      {/* Section label + queue badge */}
      <View style={styles.headerRow}>
        <View style={styles.sectionLabel}>
          <Text variant="caption" weight="bold" style={styles.sectionNumber}>
            01.
          </Text>
          <Text variant="caption" weight="bold" style={styles.sectionText}>
            {eventName ? eventName.toUpperCase() : "NO EVENT"}
          </Text>
        </View>
        {queueDepth > 0 ? (
          <View style={styles.queueBadge} testID="home-queue-badge">
            <WifiOff size={12} color={colors.accent} />
            <Text variant="caption" weight="bold" style={styles.queueText}>
              {queueDepth} QUEUED
            </Text>
          </View>
        ) : null}
      </View>

      {/*
        FR-010 — "N scans failed to sync".

        NON-BLOCKING by design: it sits above the fold and routes to the retry,
        but it does not gate the scan CTA. An operator mid-rush must be able to
        keep working; the point is that this can no longer be invisible, not
        that it should stop the door.
      */}
      {failedCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${failedCount} scan${failedCount === 1 ? "" : "s"} failed to sync. Opens Settings to retry.`}
          accessibilityHint="These admissions were recorded on this device but never reached the server."
          onPress={onOpenSettings}
          disabled={!onOpenSettings}
          style={styles.failedBanner}
          testID="home-failed-sync-banner"
        >
          {/*
            `warningSoft`, not `support` — a GLYPH on a themed surface. See the
            AlertTriangle note further down.
          */}
          <AlertTriangle size={16} color={colors.warningSoft} />
          <Column flex gap={2}>
            <Text variant="bodySmall" weight="bold" color={colors.color}>
              {failedCount} scan{failedCount === 1 ? "" : "s"} failed to sync
            </Text>
            <Text variant="caption" color={colors.colorMuted}>
              Admitted here, never recorded on the server. Retry in Settings.
            </Text>
          </Column>
        </Pressable>
      ) : null}

      {/* Event selector — prominent on home; collapses into the
            AppShell header chip on every other tab (see AppShell). */}
      {selectableEvents.length > 0 ? (
        <EventSelector
          events={selectableEvents}
          selectedEventId={selectedEventId}
          onSelect={onSelectEvent}
          testID="home-event-selector"
        />
      ) : null}

      {/* Big headline — just "SCANNER" */}
      <Column gap={4}>
        <Text
          variant="h1"
          weight="bold"
          color={colors.color}
          style={styles.headline}
        >
          SCANNER
        </Text>
        <Text variant="h2" weight="bold" style={styles.headlineAccent}>
          {eventName ? "READY" : "STANDBY"}
        </Text>
      </Column>

      {/* Admit counter — tapping opens the scan surface so the operator can
            jump straight from the live count to scanning the next attendee
            without going through the tab bar. */}
      {eventName && counts.total > 0 ? (
        <Pressable
          onPress={onOpenUnifiedScan}
          accessibilityRole="button"
          accessibilityHint="Opens the scan screen."
          style={[
            styles.counterCard,
            isNearCapacity && styles.counterCardWarning,
            isAtCapacity && styles.counterCardDanger,
          ]}
          accessibilityLiveRegion="polite"
          accessibilityLabel={
            isAtCapacity
              ? `At capacity. ${counts.scanned} of ${counts.total} admitted. Tap to scan.`
              : isNearCapacity
                ? `Near capacity. ${counts.scanned} of ${counts.total} admitted, ${Math.round(pct * 100)} percent. Tap to scan.`
                : `Admitted ${counts.scanned} of ${counts.total}, ${Math.round(pct * 100)} percent. Tap to scan.`
          }
          testID="home-admit-counter"
        >
          <View style={styles.counterRow}>
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              {capacityAlert ? (
                <Animated.View style={{ opacity: pulseAnim }}>
                  {/*
                      `warningSoft`, NOT `support`. This was a shipped defect:
                      #F59E0B on Stub's `surfaceRaised` measures 1.75:1 against
                      a 3:1 graphic floor. It shipped because it was measured on
                      Ember (amber on navy is 6.80:1) and Stub became the
                      default afterwards. The rule: `support` is a FILL (it
                      carries `onSupport` — the ALREADY IN verdict depends on
                      that); `warningSoft` is a rule/glyph/label.
                    */}
                  <AlertTriangle
                    size={14}
                    color={isAtCapacity ? colors.danger : colors.warningSoft}
                  />
                </Animated.View>
              ) : null}
              <Text variant="caption" style={styles.counterLabel}>
                {isAtCapacity
                  ? "AT CAPACITY"
                  : isNearCapacity
                    ? "NEAR CAPACITY"
                    : "ADMITTED"}
              </Text>
            </View>
            <Text
              variant="bodySmall"
              weight="bold"
              style={[
                styles.counterPct,
                isAtCapacity && { color: colors.dangerSoft },
                isNearCapacity &&
                  !isAtCapacity && { color: colors.warningSoft },
              ]}
            >
              {Math.round(pct * 100)}%
            </Text>
          </View>
          <Text variant="h3" weight="bold" color={colors.color}>
            {counts.scanned.toLocaleString()} / {counts.total.toLocaleString()}
          </Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${Math.min(Math.round(pct * 100), 100)}%` },
                isNearCapacity && styles.progressFillWarning,
                isAtCapacity && styles.progressFillDanger,
              ]}
            />
          </View>
        </Pressable>
      ) : null}

      {/*
          Scan actions — ONE scan entry point.
          The operator no longer picks "ticket" vs "volunteer" up front: the
          resolver reads whichever QR is presented and routes it. That choice
          was never really the operator's to make — they can't know what the
          person in front of them is holding until they scan it.
        */}
      {eventName ? (
        <Column gap={12}>
          <Pressable
            accessibilityRole="button"
            onPress={onOpenUnifiedScan}
            style={styles.scanCard}
            testID="open-scan-button"
          >
            <View style={styles.scanIcon}>
              <ScanLine size={24} color={colors.accent} />
            </View>
            <Column flex gap={2}>
              <Text variant="h4" weight="bold" color={colors.color}>
                Scan
              </Text>
              <Text variant="bodySmall" color={colors.colorMuted}>
                Tickets and volunteer passes routed automatically.
              </Text>
            </Column>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onOpenLookup}
            style={styles.lookupCard}
            testID="open-lookup-button"
          >
            <Search size={18} color={colors.accent} />
            <Text variant="body" weight="bold" color={colors.color}>
              Look up attendee
            </Text>
          </Pressable>
        </Column>
      ) : (
        <Text
          variant="body"
          color={colors.colorMuted}
          style={{ maxWidth: 320, lineHeight: 22 }}
        >
          No active events assigned to you right now.
        </Text>
      )}

      {/* Footer — `marginTop: auto` pins it to the bottom of the YStack
            even when content above doesn't fill the screen, AND keeps it
            from getting pushed off-screen when content overflows (the
            ScrollView-less layout used to clip sign-out behind the nav). */}
      <Column pin="bottom" gap={12}>
        <View style={styles.footerRow}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void onSignOut();
            }}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={styles.footerLink}
            testID="home-sign-out-button"
          >
            <LogOut size={14} color={colors.colorMuted} />
            <Text variant="caption" style={styles.footerLinkText}>
              Sign out · {userEmail}
            </Text>
          </Pressable>
        </View>

        <Text variant="caption" style={styles.version}>
          v{getAppVersion()}
        </Text>
      </Column>
    </ScreenSurface>
  );
};

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    // `root` is gone: `ScreenSurface` already IS
    // `View(screen) + GeometricBackground + padded flex stack`, which is what
    // this screen hand-rolled. FR-009.
    headerRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: 8,
    },
    sectionLabel: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flex: 1,
    },
    sectionNumber: {
      color: colors.accent,
      fontSize: 10,
      letterSpacing: 2,
    },
    sectionText: {
      color: colors.colorMuted,
      fontSize: 10,
      letterSpacing: 3,
    },
    queueBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: colors.accent,
      backgroundColor: colors.accentTint,
    },
    queueText: {
      color: colors.accentText,
      fontSize: 10,
      letterSpacing: 1.5,
    },
    failedBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderWidth: 2,
      // Rule colour must clear the 3:1 graphic floor on BOTH palettes;
      // `supportTint` is the fill that carries it (same pairing as the
      // near-capacity counter card).
      borderColor: colors.warningSoft,
      backgroundColor: colors.supportTint,
      paddingHorizontal: 12,
      paddingVertical: 10,
      minHeight: 44,
    },
    headline: {
      fontSize: 56,
      lineHeight: 56,
      letterSpacing: -2,
    },
    headlineAccent: {
      fontSize: 36,
      lineHeight: 36,
      letterSpacing: -1,
      color: colors.accent,
    },
    counterCard: {
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surfaceRaised,
      padding: 16,
      gap: 8,
    },
    /**
     * `warningSoft` border, `supportTint` fill — see the AlertTriangle comment
     * above. The tint is a FILL and stays; only the 2px border (a graphic that
     * must clear 3:1) moves off `support`. Measured after the fix:
     * 8.75:1 Ember / 4.96:1 Stub against the composited tint.
     */
    counterCardWarning: {
      borderColor: colors.warningSoft,
      backgroundColor: colors.supportTint,
    },
    counterCardDanger: {
      borderColor: colors.danger,
      backgroundColor: colors.dangerTint,
    },
    counterRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    counterLabel: {
      color: colors.colorMuted,
      fontSize: 10,
      letterSpacing: 2,
    },
    counterPct: {
      color: colors.accentText,
    },
    progressTrack: {
      height: 4,
      backgroundColor: colors.progressTrack,
      overflow: "hidden",
    },
    progressFill: {
      height: 4,
      backgroundColor: colors.accent,
    },
    /** `support` on `progressTrack` measured 1.50:1 on Stub. Same fix. */
    progressFillWarning: {
      backgroundColor: colors.warningSoft,
    },
    progressFillDanger: {
      backgroundColor: colors.danger,
    },
    scanCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 16,
      borderWidth: 2,
      borderColor: colors.borderColor,
      borderRadius: 0,
      padding: 20,
      backgroundColor: colors.surfaceRaised,
    },
    scanIcon: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accentTint,
    },
    lookupCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderWidth: 2,
      borderColor: colors.borderColor,
      borderRadius: 0,
      paddingVertical: 12,
      paddingHorizontal: 16,
      backgroundColor: colors.surfaceRaised,
    },
    footerRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
    },
    footerLink: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 8,
      minHeight: 44,
    },
    footerLinkText: {
      color: colors.colorMuted,
      fontSize: 11,
      letterSpacing: 1,
    },
    version: {
      color: colors.colorMuted,
      textAlign: "center",
      fontSize: 10,
    },
  });
