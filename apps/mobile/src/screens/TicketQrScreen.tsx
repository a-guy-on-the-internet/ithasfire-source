import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useFocusEffect } from "@react-navigation/native";
import QRCode from "react-native-qrcode-svg";
import * as Brightness from "expo-brightness";
import { useKeepAwake } from "expo-keep-awake";
import { ChevronLeft, ChevronRight, CloudOff } from "lucide-react-native";

import {
  FIXED,
  SquareCard,
  SquareSecondaryButton,
  StatusBadge,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import { useOrderTickets } from "@/features/tickets/use-order-tickets";
import {
  formatTicketCode,
  formatTicketOrderDateTime,
  getTicketStatusDisplay,
} from "@/features/tickets/ticket-format";
import { ScreenSurface } from "@/ui/primitives";
import type { TicketsStackParamList } from "@/navigation/types";

type Props = NativeStackScreenProps<TicketsStackParamList, "TicketQr">;

/**
 * Error-correction level.
 *
 * "H" (~30% recovery) matches the web QR endpoint
 * (`apps/web/src/app/tickets/qr/[code]/route.ts`). It costs module density but
 * buys tolerance for a cracked screen, a smudged panel, or a glare band across
 * the phone — all routine at a door.
 */
const QR_ECL = "H";

/** Cap so the code stays scannable on a tablet without ballooning. */
const MAX_QR_SIZE = 320;

/**
 * Module count for the codes we actually issue.
 *
 * Ticket codes are `tk_` + 24 hex = 27 bytes, which at ECL "H" lands on QR
 * version 4 → 33×33 modules. Used only to size the quiet zone; an unexpected
 * code length degrades the margin gracefully rather than breaking the render.
 */
const QR_MODULE_COUNT = 33;

/**
 * The spec's quiet zone is 4 modules on every side. Cheap door scanners read
 * at an angle under glare, which is exactly the case that margin exists for,
 * so we hand it to the library (making the white margin part of the QR bitmap)
 * rather than relying on the panel's padding.
 */
const QUIET_ZONE_MODULES = 4;

// ── Screen brightness ───────────────────────────────────────────────────────
//
// Venue lighting is hostile and buyers keep their phones dimmed. The scanner
// reads reflected light off the panel, so a dim screen is the most common cause
// of a slow scan.
//
// This is module-level and REF-COUNTED on purpose. Two pass screens can overlap
// (pop ticket 1, immediately open ticket 2), and per-component capture would
// let screen 2 read the already-boosted 1.0 as "the original" and restore to
// it — stranding the device at full brightness. On iOS `setBrightnessAsync`
// writes the SYSTEM brightness, so that leak survives leaving the app.
//
// Every mutation is queued on one promise chain so a capture can never
// interleave with a restore.

let brightnessHolders = 0;
let originalBrightness: number | null = null;
let brightnessQueue: Promise<void> = Promise.resolve();

const enqueueBrightness = (op: () => Promise<void>): Promise<void> => {
  brightnessQueue = brightnessQueue.then(op, op);
  return brightnessQueue;
};

const acquireFullBrightness = (): Promise<void> =>
  enqueueBrightness(async () => {
    brightnessHolders += 1;
    if (brightnessHolders !== 1) return;
    try {
      originalBrightness = await Brightness.getBrightnessAsync();
      await Brightness.setBrightnessAsync(1);
    } catch {
      // Permission denied or unsupported — the pass still renders, just
      // dimmer. Never block a ticket on a brightness call.
      originalBrightness = null;
    }
  });

const releaseFullBrightness = (): Promise<void> =>
  enqueueBrightness(async () => {
    brightnessHolders = Math.max(0, brightnessHolders - 1);
    if (brightnessHolders !== 0) return;
    const restore = originalBrightness;
    originalBrightness = null;
    if (restore === null) return;
    try {
      await Brightness.setBrightnessAsync(restore);
    } catch {
      // Nothing useful to do — the user can still adjust it themselves.
    }
  });

/**
 * Hold full brightness while a pass is FOCUSED and the app is foregrounded.
 *
 * Focus, not mount, is the right scope: the bottom tabs don't set
 * `unmountOnBlur`, so a buyer who opens their pass and then taps over to
 * Discover would otherwise leave this screen mounted — pinning system
 * brightness (and, via `useKeepAwake`, defeating auto-lock) for as long as
 * they browse, with no pass on screen.
 *
 * Backgrounding releases for the same reason: a pass sitting in the app
 * switcher must not hold the device at maximum.
 */
const useFullBrightness = (): void => {
  useFocusEffect(
    useCallback(() => {
      let held = AppState.currentState === "active";
      if (held) void acquireFullBrightness();

      const sub = AppState.addEventListener("change", (next) => {
        const shouldHold = next === "active";
        if (shouldHold === held) return;
        held = shouldHold;
        void (shouldHold ? acquireFullBrightness() : releaseFullBrightness());
      });

      return () => {
        sub.remove();
        if (held) void releaseFullBrightness();
      };
    }, []),
  );
};

const OfflineNotice = ({ cachedAt }: { cachedAt: string | null }) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <View style={styles.offlineRow} testID="qr-offline-notice">
      <CloudOff size={14} color={colors.colorMuted} />
      <Text style={styles.offlineText}>
        Offline copy
        {cachedAt ? ` · saved ${formatTicketOrderDateTime(cachedAt)}` : ""}
      </Text>
    </View>
  );
};

export const TicketQrScreen = ({ route, navigation }: Props) => {
  const { orderId, ticketId, eventName } = route.params;
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const { width } = useWindowDimensions();

  useKeepAwake();
  useFullBrightness();

  const { tickets, source, cachedAt, isLoading, errorMessage, refetch } =
    useOrderTickets(orderId);

  /**
   * Selection is by ticket ID, never by array position.
   *
   * The server list can reorder or shrink between fetches (a transfer or
   * refund removes a ticket), and a positional index would then quietly show
   * a DIFFERENT ticket's code than the one the buyer opened — or fall off the
   * end and claim the ticket no longer exists. The id survives both.
   */
  const [selectedId, setSelectedId] = useState<string>(ticketId);

  // Follow the route when an already-mounted screen is re-targeted — React
  // Navigation updates params rather than pushing for a deep link into the
  // pass, so without this the previous ticket would stay on screen.
  useEffect(() => {
    setSelectedId(ticketId);
  }, [ticketId]);

  const foundIndex = tickets.findIndex((t) => t.id === selectedId);
  const activeIndex = foundIndex >= 0 ? foundIndex : 0;
  const ticket = tickets[activeIndex];

  // The selected ticket genuinely left the order (transferred/refunded), as
  // opposed to simply not having loaded yet.
  const selectionMissing = tickets.length > 0 && foundIndex < 0;

  const qrSize = useMemo(
    () => Math.min(MAX_QR_SIZE, Math.max(180, Math.floor(width - 96))),
    [width],
  );

  const quietZone = useMemo(
    () => Math.ceil((qrSize / QR_MODULE_COUNT) * QUIET_ZONE_MODULES),
    [qrSize],
  );

  const goPrev = useCallback(() => {
    const prev = tickets[activeIndex - 1];
    if (prev) setSelectedId(prev.id);
  }, [activeIndex, tickets]);

  const goNext = useCallback(() => {
    const next = tickets[activeIndex + 1];
    if (next) setSelectedId(next.id);
  }, [activeIndex, tickets]);

  useEffect(() => {
    if (eventName) navigation.setOptions({ title: eventName });
  }, [eventName, navigation]);

  if (isLoading) {
    return (
      <ScreenSurface testID="ticket-qr-screen">
        <SafeAreaView style={styles.safe} edges={["bottom"]}>
          <View style={styles.centered} testID="ticket-qr-loading">
            <ActivityIndicator color={colors.color} />
            <Text style={styles.stateText}>Loading your pass</Text>
          </View>
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  if (errorMessage || !ticket || selectionMissing) {
    return (
      <ScreenSurface testID="ticket-qr-screen">
        <SafeAreaView style={styles.safe} edges={["bottom"]}>
          <View style={styles.centered} testID="ticket-qr-error">
            <SquareCard tone="danger" accessibilityRole="alert">
              <StatusBadge label="Pass unavailable" tone="danger" />
              <Text style={styles.stateTitle}>
                {selectionMissing
                  ? "This ticket has moved."
                  : errorMessage
                    ? "Couldn't load your pass."
                    : "Ticket not found."}
              </Text>
              <Text style={styles.stateText}>
                {selectionMissing
                  ? "It's no longer on this order — it may have been transferred or refunded. Your other tickets are still on the order."
                  : (errorMessage ??
                    "This ticket isn't on the order any more. It may have been transferred or refunded.")}
              </Text>
              <SquareSecondaryButton
                label={selectionMissing ? "Back to order" : "Try again"}
                onPress={selectionMissing ? navigation.goBack : refetch}
                accessibilityHint={
                  selectionMissing
                    ? "Returns to the order and its remaining tickets."
                    : "Reloads the ticket codes for this order."
                }
              />
            </SquareCard>
          </View>
        </SafeAreaView>
      </ScreenSurface>
    );
  }

  const status = getTicketStatusDisplay(ticket.status);
  const isSpent = ticket.status === "SCANNED" || ticket.status === "REFUNDED";

  return (
    <ScreenSurface testID="ticket-qr-screen">
      <SafeAreaView style={styles.safe} edges={["bottom"]}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.headerRow}>
            <StatusBadge label={status.label} tone={status.tone} />
            {source === "cache" ? <OfflineNotice cachedAt={cachedAt} /> : null}
          </View>

          {/*
            Deliberately NOT themed — fixed white panel, fixed black modules,
            in both Ember and Stub. See `FIXED.qrModule`. And deliberately NOT
            dimmed when spent: opacity would composite the modules toward the
            canvas and destroy the decode margin the fixed tokens exist to
            protect. "Spent" is expressed in the surrounding chrome instead.
          */}
          <View
            style={[styles.qrPanel, isSpent ? styles.qrPanelSpent : null]}
            accessible
            accessibilityRole="image"
            accessibilityLabel="Entry QR code"
            testID="ticket-qr-code"
          >
            <QRCode
              value={ticket.code}
              size={qrSize}
              ecl={QR_ECL}
              quietZone={quietZone}
              color={FIXED.qrModule}
              backgroundColor={FIXED.qrQuietZone}
            />
          </View>

          {isSpent ? (
            <Text style={styles.spentNotice} testID="ticket-qr-spent">
              {ticket.status === "SCANNED"
                ? `Already scanned${
                    ticket.scannedAt
                      ? ` ${formatTicketOrderDateTime(ticket.scannedAt)}`
                      : ""
                  }.`
                : "This ticket was refunded and won't scan."}
            </Text>
          ) : null}

          {/*
            The code in text is not decoration — it is the manual fallback when
            a camera won't cooperate, so it stays selectable and legible. The
            QR panel above deliberately does NOT repeat it in its a11y label,
            or a screen reader would read the code out twice.
          */}
          <View style={styles.codeBlock}>
            <Text style={styles.codeLabel}>Ticket code</Text>
            <Text
              style={styles.codeValue}
              selectable
              accessibilityLabel={`Ticket code ${formatTicketCode(ticket.code)}`}
            >
              {formatTicketCode(ticket.code)}
            </Text>
          </View>

          {tickets.length > 1 ? (
            <View style={styles.pager} testID="ticket-qr-pager">
              <Pressable
                onPress={goPrev}
                disabled={activeIndex === 0}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Previous ticket"
                accessibilityState={{ disabled: activeIndex === 0 }}
                style={styles.pagerButton}
                testID="ticket-qr-prev"
              >
                <ChevronLeft
                  size={22}
                  color={
                    activeIndex === 0 ? colors.colorMuted : colors.accentText
                  }
                />
              </Pressable>
              <Text style={styles.pagerLabel}>
                Ticket {activeIndex + 1} of {tickets.length}
              </Text>
              <Pressable
                onPress={goNext}
                disabled={activeIndex === tickets.length - 1}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Next ticket"
                accessibilityState={{
                  disabled: activeIndex === tickets.length - 1,
                }}
                style={styles.pagerButton}
                testID="ticket-qr-next"
              >
                <ChevronRight
                  size={22}
                  color={
                    activeIndex === tickets.length - 1
                      ? colors.colorMuted
                      : colors.accentText
                  }
                />
              </Pressable>
            </View>
          ) : null}

          <Text style={styles.hint}>
            Hold this up to the scanner at the door. Your screen brightness is
            turned up automatically.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </ScreenSurface>
  );
};

const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    safe: { flex: 1 },
    content: {
      flexGrow: 1,
      alignItems: "center",
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 32,
      gap: 20,
    },
    centered: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 20,
      gap: 12,
    },
    headerRow: {
      width: "100%",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      flexWrap: "wrap",
    },
    offlineRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    offlineText: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 11,
      letterSpacing: 0.8,
      textTransform: "uppercase",
    },
    // Fixed white regardless of theme — this panel is read by a camera. The
    // border is the SOFT token, not `borderColorStrong`: on Stub the strong
    // token is near-black, and a hard dark rule sitting just outside the quiet
    // zone is exactly what confuses a scanner hunting for finder patterns.
    qrPanel: {
      backgroundColor: FIXED.qrQuietZone,
      padding: 12,
      borderWidth: 2,
      borderColor: c.borderColorSoft,
      alignItems: "center",
      justifyContent: "center",
    },
    // A spent ticket still renders at FULL contrast — the door may need to
    // scan or read it. Only the frame changes.
    qrPanelSpent: {
      borderColor: c.warning,
    },
    spentNotice: {
      color: c.warning,
      fontFamily: "Montserrat-Medium",
      fontSize: 13,
      lineHeight: 18,
      textAlign: "center",
    },
    codeBlock: {
      width: "100%",
      alignItems: "center",
      gap: 6,
      borderTopWidth: 1,
      borderTopColor: c.borderColorSoft,
      paddingTop: 16,
    },
    codeLabel: {
      color: c.colorMuted,
      fontFamily: "Montserrat-Medium",
      fontSize: 11,
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    codeValue: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 18,
      fontWeight: "700",
      letterSpacing: 1.5,
      textAlign: "center",
    },
    pager: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
      width: "100%",
      borderTopWidth: 1,
      borderTopColor: c.borderColorSoft,
      paddingTop: 16,
    },
    pagerButton: {
      minWidth: 44,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: c.borderColor,
    },
    pagerLabel: {
      flex: 1,
      textAlign: "center",
      color: c.color,
      fontFamily: "Montserrat-Medium",
      fontSize: 13,
      letterSpacing: 0.8,
      textTransform: "uppercase",
    },
    hint: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 12,
      lineHeight: 17,
      textAlign: "center",
      maxWidth: 300,
    },
    stateTitle: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    stateText: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 20,
      textAlign: "center",
    },
  });
