import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  DollarSign,
  Home,
  ScanLine,
  Settings,
  ShieldAlert,
} from "lucide-react-native";

import { useReducedMotion } from "../lib/use-reduced-motion";
import { EventSelector, type SelectableEvent } from "./event-selector";
import { NetworkBanner } from "./network-banner";
import { Text, useColors, useStyles } from "@th/ui-native";

export type NavTab = "home" | "scan" | "sell" | "settings";

type NavItem = {
  key: NavTab;
  label: string;
  icon: typeof Home;
};

/**
 * Four tabs, not five.
 *
 * `Tickets` and `Volunteers` used to be separate tabs pointing at two separate
 * camera screens. That split asked the operator to declare what the person in
 * front of them was holding *before* scanning it — a thing they cannot know.
 * The resolver reads either kind of QR, so there is one `Scan` tab.
 */
const ALL_NAV_ITEMS: NavItem[] = [
  { key: "home", label: "Home", icon: Home },
  { key: "scan", label: "Scan", icon: ScanLine },
  { key: "sell", label: "Sell", icon: DollarSign },
  { key: "settings", label: "Settings", icon: Settings },
];

type AppShellProps = {
  children: ReactNode;
  activeTab: NavTab;
  onTabPress: (tab: NavTab) => void;
  /**
   * When omitted or empty, all tabs render. Pass a list to hide
   * specific tabs (e.g., hide "sell" when no TicketTypes are on sale
   * for the current event — FR-001).
   */
  hiddenTabs?: ReadonlyArray<NavTab>;
  /**
   * When true, render an "elevated mode" banner so a platform admin
   * scanning/selling against a tenant they don't belong to is always
   * aware their actions audit-log as a platform_admin override.
   */
  platformAdminOverride?: boolean;
  /**
   * Global event selector — rendered in the header strip when any
   * events are available. Lets the operator switch the shift target
   * from any tab (Tickets/Volunteers/Sell all key off the same event).
   * Omit `selectableEvents` to suppress the chip entirely.
   */
  selectableEvents?: ReadonlyArray<SelectableEvent>;
  selectedEventId?: string | null;
  onSelectEvent?: (eventId: string) => void;
  testID?: string;
};

export const AppShell = ({
  children,
  activeTab,
  onTabPress,
  hiddenTabs,
  platformAdminOverride,
  selectableEvents,
  selectedEventId,
  onSelectEvent,
  testID,
}: AppShellProps) => {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const colors = useColors();
  const themed = useStyles();
  const hidden = new Set<NavTab>(hiddenTabs ?? []);
  const navItems = ALL_NAV_ITEMS.filter((i) => !hidden.has(i.key));

  // Header event-chip slides DOWN into the header when the operator
  // leaves Home, and slides UP out of view when they come back. The
  // prominent in-content chip on HomeScreen and this compact header
  // chip share the same event state — the slide is the visual hand-off
  // between the two surfaces.
  const isHomeTab = activeTab === "home";
  const chipProgress = useRef(new Animated.Value(isHomeTab ? 0 : 1)).current;
  useEffect(() => {
    const targetValue = isHomeTab ? 0 : 1;
    if (reducedMotion) {
      chipProgress.setValue(targetValue);
      return;
    }
    Animated.timing(chipProgress, {
      toValue: targetValue,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [isHomeTab, chipProgress, reducedMotion]);
  const chipOpacity = chipProgress;
  const chipTranslateY = chipProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [-14, 0],
  });

  return (
    <View
      style={[styles.root, { backgroundColor: colors.background }]}
      testID={testID}
    >
      {/* Status-bar area — same structural fill as the header, no seam. */}
      <View style={[themed.statusBarArea, { height: insets.top }]} />

      {/* Header strip */}
      <View style={themed.header}>
        <Text
          variant="bodySmall"
          weight="bold"
          color={colors.onStructure}
          style={styles.headerText}
        >
          Ithas Fire Scanner
        </Text>
        <View style={themed.headerAccentRule} />
        {/* Event chip — single source of truth across tabs. Tickets,
            Volunteers and Sell all bind their queries to whichever
            event is selected here, so flipping it mid-shift switches
            every screen consistently. Slides into the header when
            leaving Home, out when returning; pointerEvents="none" at
            opacity 0 so the invisible chip on Home doesn't swallow
            taps in the brand area. */}
        {selectableEvents && selectableEvents.length > 0 && onSelectEvent ? (
          <Animated.View
            style={[
              styles.headerEventSlot,
              {
                opacity: chipOpacity,
                transform: [{ translateY: chipTranslateY }],
              },
            ]}
            pointerEvents={isHomeTab ? "none" : "auto"}
          >
            <EventSelector
              variant="compact"
              events={[...selectableEvents]}
              selectedEventId={selectedEventId ?? null}
              onSelect={onSelectEvent}
              testID="header-event-selector"
            />
          </Animated.View>
        ) : null}
      </View>

      {/*
        Platform-admin override banner. The label sits on the amber `support`
        fill and MUST use `onSupport` (ink): the previous white-on-#F59E0B
        measured 2.15:1 — comfortably the worst contrast defect in the app, and
        on the one banner whose entire job is to be impossible to miss. Ink is
        7.98:1 on Ember / 7.87:1 on Stub. Icon + text, never colour alone.
      */}
      {platformAdminOverride ? (
        <View
          style={[
            styles.platformAdminBanner,
            { backgroundColor: colors.support },
          ]}
          testID="platform-admin-banner"
        >
          <ShieldAlert size={16} color={colors.onSupport} aria-hidden />
          <Text variant="bodySmall" weight="bold" color={colors.onSupport}>
            PLATFORM ADMIN MODE — actions are audit-logged
          </Text>
        </View>
      ) : null}

      <NetworkBanner />

      {/* Screen content */}
      <View style={styles.content}>{children}</View>

      {/*
        Bottom nav — CHROME, so it takes the soft treatment (DS v2 §4): a
        hairline top rule rather than a 2px structural border, and the active
        tab reads as an `accentSoft` pill rather than a hard Swiss top-border
        tab.

        The active tone is `accentTextPress`, measured against the PILL and not
        the canvas — that distinction is the whole point. `accentText` on the
        composited pill (`accentSoft` over `background`) is 4.43:1 on Ember,
        which fails the 4.5 floor for this 9px label even though it is 5.42:1
        on the bare canvas. `accentTextPress` is 5.57:1 Ember / 6.29:1 Stub on
        the pill. (`accent` itself is a fill/graphic value — only 3.57:1 as
        copy on Stub — so it is not a candidate either way.)
      */}
      <View
        style={[themed.navBar, { paddingBottom: Math.max(insets.bottom, 8) }]}
      >
        <View style={themed.navBorder} />
        <View style={themed.navItems}>
          {navItems.map((item) => {
            const isActive = activeTab === item.key;
            const Icon = item.icon;
            const tone = isActive ? colors.accentTextPress : colors.colorMuted;
            return (
              <View key={item.key} style={themed.navItem}>
                <Pressable
                  onPress={() => onTabPress(item.key)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isActive }}
                  accessibilityLabel={item.label}
                  testID={`nav-tab-${item.key}`}
                  style={({ pressed }) => [
                    themed.navTouchable,
                    isActive && themed.navTouchableActive,
                    pressed && !isActive ? themed.navTouchablePressed : null,
                  ]}
                >
                  <Icon size={20} color={tone} />
                  <Text
                    variant="caption"
                    weight={isActive ? "bold" : "medium"}
                    style={[styles.navLabel, { color: tone }]}
                    // `@th/ui-native`'s Text declares these properly now; the
                    // `as Record<string, unknown>` cast that used to live here
                    // was working around `@th/ui`'s TextProps omitting them.
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {item.label}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
};

/**
 * Geometry only. Every colour-bearing style for this shell lives in the themed
 * sheet (`./styles.ts`) so both themes are covered from one place — see
 * `themed.header` / `themed.navBar` / `themed.statusBarArea` above.
 */
const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerText: {
    textTransform: "uppercase",
    letterSpacing: 2,
    fontSize: 11,
  },
  headerEventSlot: {
    marginLeft: "auto",
    flexShrink: 1,
  },
  content: {
    flex: 1,
  },
  platformAdminBanner: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  navLabel: {
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 2,
  },
});
