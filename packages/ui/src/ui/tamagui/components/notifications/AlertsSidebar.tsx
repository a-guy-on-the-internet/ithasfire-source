"use client";

import { Bell, BellRing, X } from "lucide-react";
import React, {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  Dimensions,
  Platform,
  ScrollView,
  useWindowDimensions,
} from "react-native";
import { createPortal } from "react-dom";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import {
  Separator,
  Stack,
  XStack,
  YStack,
  styled,
  type TamaguiElement,
} from "tamagui";

import { Button } from "../forms/Button";
import { OVERLAY_EXEMPT_SELECTOR, getTabbables } from "../overlay/Modal";
import { Text } from "../typography/Text";
import {
  DEFAULT_NOTIFICATION_ALERT_LABELS,
  NotificationAlert,
} from "./NotificationAlert";
import { mergeDefinedLabels } from "./merge-labels";
import { useNotificationContext } from "./NotificationProvider";
import { tabPanelProps, tabProps } from "./tablist-a11y";

export type SidebarView = "alerts" | "inbox";

const VIEW_ORDER: readonly SidebarView[] = ["inbox", "alerts"] as const;

/**
 * The panel's own z-index; a layer stacked above it is not "the page".
 *
 * This is a ROOT-level z-index because the web panel portals to `<body>`
 * (`SidebarPortal`). Keep it that way: the numeric comparisons in
 * `isInLiveLayerAbovePanel` are only meaningful while the panel is a body
 * child, and before the portal the panel rendered inside apps/web's
 * `ScrollAwareNavbar` wrapper (`position: sticky; z-index: 50` plus a non-none
 * `transform`), which made it paint at level 50 and resolved its
 * `position: fixed` offsets against the navbar instead of the viewport.
 *
 * 1600 is a MID-BAND value and that is deliberate (measured 2026-10-02; do
 * not renumber it from here). `tokens/z-index.ts` names drawer 1350, modal
 * 1400, popover 1500, toast 1550, tooltip 1600 — but those names are nearly
 * unused: every real <body>-portalled overlay hard-codes 10000 instead
 * (`Modal.tsx:50`, `BottomSheet.tsx:41`, `SlidePanel.tsx:41`), and apps/web's
 * page chrome already sprawls above this panel (PlaceAutocomplete and
 * CountryCombobox 4000, AudioPlayer 9000, DirectionsDropdown 9998/9999,
 * AuthOverlayShell 9999, spotlight 9999, CsvImportDialog 9999). So 1600 does
 * not mean "above everything". It means: below the 10000 overlay class, which
 * is the CORRECT side of it — a Modal opened on top of this panel has to paint
 * above it — and tied with Toast's own literal 1600 (`Toast.tsx:893`), which
 * is why `isInLiveLayerAbovePanel` counts a tie as above. Lowering it is wrong
 * in the other direction: 1350 would tie with the checkout
 * `MobileCTABar.tsx:293`, and anything under that loses to more page chrome.
 * Renumbering the design system's stacking scale is a separate task, and is
 * deliberately not folded into this component.
 */
const SIDEBAR_Z_INDEX = 1600;

/**
 * The backdrop sits exactly one level under the panel. Derived, not written
 * twice: the pair was two bare literals (1600 / 1599) in three places and
 * could drift the moment either was touched.
 */
const SIDEBAR_BACKDROP_Z_INDEX = SIDEBAR_Z_INDEX - 1;

/**
 * The open sidebar's `close`, for content rendered through `renderInbox`.
 * Lets the inbox shut the panel when one of its rows navigates away, without
 * every host having to thread a callback through its render prop. `null`
 * outside a sidebar (e.g. the inbox rendered as a full page).
 */
const AlertsSidebarCloseContext = createContext<(() => void) | null>(null);

export function useAlertsSidebarClose(): (() => void) | null {
  return useContext(AlertsSidebarCloseContext);
}

const SidebarOverlay = styled(Stack, {
  name: "NotificationSidebarOverlay",
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "$overlay",
  zIndex: SIDEBAR_BACKDROP_Z_INDEX,
  opacity: 1,
});

const SidebarContainer = styled(YStack, {
  name: "NotificationSidebarContainer",
  position: "absolute",
  gap: "$4",
  zIndex: SIDEBAR_Z_INDEX,
  backgroundColor: "$surfaceRaised",
  borderColor: "$borderColor",

  variants: {
    presentation: {
      sidebar: {
        borderRadius: 0,
        borderWidth: 2,
      },
      sheet: {
        borderTopWidth: 2,
        borderTopLeftRadius: 0,
        borderTopRightRadius: 0,
      },
    },
  } as const,
});

const SidebarHeader = styled(XStack, {
  name: "NotificationSidebarHeader",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "$3",
  paddingBottom: "$3",
});

// The count label is 11px — small text, so the 4.5:1 floor applies. White on the
// `$brandSecondary` fill (#E2481D on Stub) is only 4.06:1, so the badge rides the
// deeper `$brandSecondaryHover` (#B93312) fill, where `$onBrandSecondary` reaches
// 5.92 / 4.61 / 4.61 across stub / swiss / ember. This is the same trade
// design-system-v2.md §3 prescribes and that PriceBlock + the primary CTA
// already make.
const CountBadge = styled(Stack, {
  name: "NotificationSidebarCountBadge",
  minWidth: 20,
  height: 20,
  paddingHorizontal: 4,
  borderRadius: 0,
  borderColor: "$borderColorStrong",
  borderWidth: 1,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "$brandSecondaryHover",
});

const ButtonIconWrapper = styled(Stack, {
  name: "NotificationSidebarButtonIcon",
  alignItems: "center",
  justifyContent: "center",
  position: "relative",
});

const SheetHandle = styled(Stack, {
  name: "NotificationSidebarSheetHandle",
  width: 36,
  height: 4,
  borderRadius: 0,
  backgroundColor: "$surfaceStrong",
  alignSelf: "center",
});

const EmptyStateContainer = styled(YStack, {
  name: "NotificationSidebarEmptyState",
  alignItems: "center",
  gap: "$2",
  paddingVertical: "$6",
  paddingHorizontal: "$2",
});

// Animation constants
const ANIMATION_DURATION_MS = 250;
const SWIPE_THRESHOLD_FRACTION = 0.25;
const VELOCITY_THRESHOLD = 500;

// Create animated components for native gesture support
// DIAG: defer createAnimatedComponent for module-init safety on RN.
const _sidebarAnimCreate = (
  Animated as unknown as {
    createAnimatedComponent?: (c: unknown) => React.ComponentType<unknown>;
  }
)?.createAnimatedComponent;
const AnimatedSidebarOverlay = (_sidebarAnimCreate?.(SidebarOverlay) ??
  SidebarOverlay) as typeof SidebarOverlay;
const AnimatedSidebarContainer = (_sidebarAnimCreate?.(SidebarContainer) ??
  SidebarContainer) as typeof SidebarContainer;

/**
 * The panel's own words, for a host with a catalog. Any label left out keeps
 * its English default, so a host can translate some and not others.
 */
export interface AlertsSidebarLabels {
  /** The panel heading, which also names the dialog. */
  heading: string;
  /** The Close button's visible text (hidden on phone widths). */
  close: string;
  /** The Close button's accessible name, which must contain `close`. */
  closeAriaLabel: string;
  /** Accessible name of the Inbox / Activity tablist. */
  viewTabs: string;
  inboxTab: string;
  activityTab: string;
  /** The Activity view's default empty state. */
  emptyTitle: string;
  emptyBody: string;
  clearAll: string;
  /** Handed to the Activity list; see `NotificationAlertLabels`. */
  alertDismiss: string;
  alertDraggable: string;
  alertDropToBottom: string;
}

const DEFAULT_LABELS: AlertsSidebarLabels = {
  heading: "Notifications",
  close: "Close",
  closeAriaLabel: "Close notifications",
  viewTabs: "Notification views",
  inboxTab: "Inbox",
  activityTab: "Activity",
  emptyTitle: "You're all caught up",
  emptyBody:
    "Alerts you clear here stay out of your way elsewhere. Any new alert will pop right back in.",
  clearAll: "Clear all",
  alertDismiss: DEFAULT_NOTIFICATION_ALERT_LABELS.dismiss,
  alertDraggable: DEFAULT_NOTIFICATION_ALERT_LABELS.draggable,
  alertDropToBottom: DEFAULT_NOTIFICATION_ALERT_LABELS.dropToBottom,
};

export interface AlertsSidebarProps {
  /** Accessible label for the bell button. */
  buttonLabel?: string;
  /**
   * The bell's whole accessible name for a given unread count, translated by
   * the host. `aria-label` replaces the button's content in the accessibility
   * tree, so the badge's number has to be folded into the name — and the
   * words around it ("3 unread") have to be in the user's language too, which
   * this package cannot do on its own. Called with the badge count (0 when
   * there is nothing unread). Without it, the name is `buttonLabel` plus an
   * English ", N unread" suffix.
   */
  formatButtonLabel?: (count: number) => string;
  /** Translated panel labels; see `AlertsSidebarLabels`. Pass a stable
   * (memoised) object — the sidebar is `memo`ised. */
  labels?: Partial<AlertsSidebarLabels>;
  /** Optional custom content to render when there are no alerts. */
  renderEmptyState?: () => ReactNode;
  /** Whether to reveal a clear-all control when alerts are present. */
  showClearAll?: boolean;
  /** Whether the sidebar should start in an open state. */
  defaultOpen?: boolean;
  /** Force a specific platform for responsive presentation (useful in Storybook). */
  platformOverride?: Platform["OS"];
  /**
   * Optional server-side unread count to display on the bell badge.
   * When provided this takes precedence over the local alerts array length.
   */
  unreadCount?: number;
  /**
   * Render prop for the notification inbox panel. When provided the sidebar
   * shows "Alerts" / "Inbox" tabs so users can switch between ephemeral
   * alerts and the persistent notification history.
   */
  renderInbox?: () => ReactNode;
  /**
   * Which view to show when the sidebar opens.
   * Defaults to "inbox" when `renderInbox` is provided, otherwise "alerts".
   */
  defaultView?: SidebarView;
  /**
   * Explicit square size (px) for the bell button. The default `size="$3"`
   * atom is 36px; mobile top bars pass 48 to meet the ≥44px touch-target
   * floor.
   */
  buttonDimension?: number;
  /** Notified whenever the panel opens or closes. */
  onOpenChange?: (open: boolean) => void;
}
type WindowMetrics = {
  width: number;
  height: number;
  scale: number;
  fontScale: number;
};

const readWindowMetrics = (): WindowMetrics => {
  const metrics =
    typeof Dimensions?.get === "function"
      ? Dimensions.get("window")
      : undefined;
  return {
    width: metrics?.width ?? 360,
    height: metrics?.height ?? 640,
    scale: metrics?.scale ?? 1,
    fontScale: metrics?.fontScale ?? 1,
  };
};

const useViewportDimensions = (): WindowMetrics => {
  const canUseWindowDimensions =
    typeof useWindowDimensions === "function" &&
    typeof Dimensions.addEventListener === "function";
  if (canUseWindowDimensions) {
    return useWindowDimensions();
  }
  return readWindowMetrics();
};

const DefaultEmptyState = ({
  title,
  body,
}: {
  title: string;
  body: string;
}) => (
  <EmptyStateContainer>
    <Text variant="body" weight="bold" textAlign="center">
      {title}
    </Text>
    <Text variant="bodySmall" tone="muted" textAlign="center">
      {body}
    </Text>
  </EmptyStateContainer>
);

// The `active` tab paints the solid `$surfaceStrong` fill, which resolves to
// the INK itself on Stub (#211C16 === `$color`). `Text` always sets its own
// color and never inherits, so the label MUST be handed `$onStructure`
// explicitly at the call site whenever `active` is true — otherwise it renders
// ink-on-ink at 1.00:1 and the tab is a solid black rectangle with no label.
// (That exact bug shipped here; see the `color={... ? "$onStructure" : ...}`
// props below.) `$onStructure` is the only foreground that clears AA against
// `$surfaceStrong` in all three themes: stub 16.2:1, ember 9.1:1, swiss 6.9:1.
//
// On web a real <button> with the WAI-ARIA tab wiring from `tablist-a11y.ts`;
// the reset keeps it pixel-identical to the old <div>. On a coarse pointer it
// grows to the 44px touch floor.
const ViewTab = styled(Stack, {
  name: "AlertsSidebarViewTab",
  tag: "button",
  borderWidth: 0,
  margin: 0,
  justifyContent: "center",
  focusVisibleStyle: {
    outlineColor: "$outlineColor",
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineOffset: 2,
  },
  $pointerCoarse: {
    minHeight: 44,
  },
  paddingVertical: "$1",
  paddingHorizontal: "$3",
  borderRadius: 0,
  cursor: "pointer",
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
  },
  pressStyle: {
    opacity: 0.8,
  },
  variants: {
    active: {
      true: {
        backgroundColor: "$surfaceStrong",
      },
      false: {
        backgroundColor: "transparent",
      },
    },
  } as const,
});

// AlertCountBubble removed — unified into CountBadge

/**
 * The web panel's own `<body>` child. Mirrors Modal and SlidePanel: one
 * wrapper element carrying the z-index, everything else unchanged inside it.
 *
 * WHY, specifically: the panel used to render where the bell renders, which in
 * apps/web is inside `ScrollAwareNavbar`'s wrapper. That wrapper sets
 * `position: sticky; z-index: 50`, a non-none `transform`, and — once the page
 * is scrolled far enough to auto-hide the navbar — `pointer-events: none`. A
 * descendant panel inherited all three: it painted at root level 50 instead of
 * 1600, its `position: fixed` offsets resolved against the wrapper rather than
 * the viewport (the transform makes the wrapper their containing block), and
 * with the navbar hidden the open panel became untappable — measured at 390px,
 * `document.elementFromPoint()` over the Close button returned `null`. A
 * <body> child inherits none of it.
 *
 * Theming survives the move: Tamagui's `ThemeProvider` puts the root theme
 * class on `<body>` (or `<html>`), and in apps/web `ActiveThemeInjector`
 * additionally mirrors the active theme as inline `--<key>` vars on `<body>`,
 * so a direct body child resolves `$surfaceRaised` and friends the same way it
 * did inside the app tree.
 *
 * The wrapper is deliberately 0×0 rather than inset-0: its children are
 * `position: fixed` and size themselves against the viewport anyway (a plain
 * fixed ancestor is not a containing block for fixed descendants), and a
 * zero-size box cannot intercept a pointer event, so the backdrop keeps sole
 * ownership of click-outside and of going `pointer-events: none` while the
 * exit transition plays.
 */
const SidebarPortal = ({ children }: { children: ReactNode }) => {
  // The server renderer cannot render a portal at all, and a portal
  // contributes NO DOM where it is written — so "nothing on the server, portal
  // on the client" leaves the hydrated host tree byte-identical either way.
  // Same guard, for the same reason, as Modal and SlidePanel.
  if (typeof document === "undefined" || !document.body) return null;
  return createPortal(
    <div
      data-th-alerts-sidebar-portal=""
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        zIndex: SIDEBAR_Z_INDEX,
      }}
    >
      {children}
    </div>,
    document.body,
  );
};

/**
 * Is `el` inside a layer that stays live above the panel? Mirrors Modal's
 * exemption: anything marked as an overlay layer (sonner's toaster,
 * `data-th-overlay-exempt`), focus retargeted into a shadow root, or a
 * top-level portal (a <body> child that does not hold the panel) stacked
 * higher than the panel.
 *
 * The panel portals to <body> (`SidebarPortal`), so — as for Modal — whole
 * <body> children are the unit of comparison and SIDEBAR_Z_INDEX is a real
 * root-level z-index. That makes the z-index test EXACT rather than the
 * approximation it was while the panel rendered inside apps/web's navbar
 * wrapper and actually painted at level 50.
 */
function isInLiveLayerAbovePanel(el: HTMLElement, panel: HTMLElement): boolean {
  // Environment guard FIRST: everything below reads the DOM or `window`.
  if (typeof document === "undefined" || typeof window === "undefined") {
    return false;
  }
  if (el.closest(OVERLAY_EXEMPT_SELECTOR)) return true;
  // Focus inside a shadow root retargets: `document.activeElement` reports the
  // HOST, so a host is the one reliable signal that the really-focused element
  // sits somewhere this function cannot measure. Next's dev error overlay is
  // exactly that — a `nextjs-portal` host that is `display: inline;
  // z-index: auto` and creates no stacking context, while the content that
  // paints above everything lives in its shadow root at a very high
  // root-level z-index. Treat a shadow host as its own live layer; reclaiming
  // its focus made the overlay's controls unreachable without closing the
  // panel first.
  if (el.shadowRoot) return true;
  let layer: HTMLElement | null = el;
  while (layer && layer.parentElement !== document.body) {
    layer = layer.parentElement;
  }
  if (!layer || layer.contains(panel)) return false;
  // `z-index: auto` parses to NaN and means the layer creates no stacking
  // context and paints at level 0 — which is below the panel's 1600 whatever
  // the DOM order says. (The one case where that is the wrong read, a
  // shadow-hosting overlay, is handled above, where it can be detected for
  // what it is instead of guessed at from sibling order.)
  //
  // A TIE counts as above. `Toast` paints at the same 1600 (`Toast.tsx:893`),
  // and between equal z-indices paint order falls to DOM order — so a tying
  // layer may well be sitting on top of us and we cannot tell from here.
  // Leaving its focus alone is the safe direction to be wrong in; reclaiming
  // focus from a layer the user can see is not.
  const z = Number.parseInt(window.getComputedStyle(layer).zIndex, 10);
  return Number.isFinite(z) && z >= SIDEBAR_Z_INDEX;
}

// The bell keeps `focusStyle` at outline 0 so a mouse click paints no ring.
// Tamagui emits `:focus` and `:focus-visible` at the same priority and, in the
// order it inserts them, the `:focus` outline-width wins — so an OUTLINE on
// `focusVisibleStyle` never shows (measured from the injected rules). The
// keyboard ring therefore rides `boxShadow`, which `:focus` does not touch.
// Stub fallback per v2 (`outlineColor` = #E2481D, a 3:1+ non-text ring).
const BELL_FOCUS_VISIBLE = {
  boxShadow: "0 0 0 2px var(--outlineColor, #E2481D)",
} as const;

/**
 * The header's Close control. At 320px the panel's content box is ~248px and
 * "Notifications" + badge + the labelled 36px "CLOSE" button (~114px) did not
 * fit: the button ran past the panel and the viewport. On a phone-width
 * viewport it drops to the icon-only square the design system sanctions
 * (v2 §6: square, `aria-label`, ≥44×44); on a coarse pointer it is at least
 * 44px tall. The name is the same at every width, so "Close" is always in it.
 */
const SidebarCloseButton = ({
  onPress,
  label,
  ariaLabel,
}: {
  onPress: () => void;
  label: string;
  ariaLabel: string;
}) => (
  <Button
    size="$3"
    variant="ghost"
    icon={false}
    onPress={onPress}
    aria-label={ariaLabel}
    // Stable marker so the inbox container can find this button by DOM
    // query (not text, which would break under i18n) when a dismissed row's
    // list empties and there is no next/previous row to hand focus to.
    data-th-sidebar-close=""
    flexShrink={0}
    $sm={{
      width: 44,
      height: 44,
      minWidth: 44,
      paddingHorizontal: 0,
      justifyContent: "center",
    }}
    $pointerCoarse={{ minHeight: 44 }}
  >
    <XStack gap="$2" alignItems="center">
      <X size={18} strokeWidth={1.75} aria-hidden="true" />
      {/*
       * The hide rides this Stack, not the `Text`. `Text`'s block variants
       * (body among them) ship `display: block` as an INLINE style, which beats
       * the atomic class a `$sm={{ display: "none" }}` prop compiles to — so the
       * label stayed painted at 320px and ran past the button's own 44px box.
       * A hidden box is not a flex item, so the `gap` above collapses with it
       * and the icon sits centred in the square on its own.
       */}
      <XStack alignItems="center" $sm={{ display: "none" }}>
        <Text variant="body" weight="bold">
          {label}
        </Text>
      </XStack>
    </XStack>
  </Button>
);

/**
 * The web panel's content area. With view tabs it is their `tabpanel`;
 * without, it adds nothing but the same flex column the content sat in.
 */
const PanelBody = ({
  tabbed,
  panelId,
  labelledBy,
  children,
}: {
  tabbed: boolean;
  panelId: string;
  labelledBy: string;
  children: ReactNode;
}) =>
  tabbed ? (
    <YStack
      flex={1}
      minHeight={0}
      gap="$4"
      // Only the web branch renders a PanelBody, so the tabpanel wiring is
      // unconditionally web here — see `tablist-a11y` on why that decision is
      // the caller's to make.
      {...tabPanelProps({ isWeb: true, panelId, labelledBy })}
    >
      {children}
    </YStack>
  ) : (
    <>{children}</>
  );

export const AlertsSidebar = memo(
  ({
    buttonLabel = "Open alerts",
    formatButtonLabel,
    labels: labelsProp,
    renderEmptyState,
    showClearAll = true,
    defaultOpen = false,
    platformOverride,
    unreadCount,
    renderInbox,
    defaultView,
    buttonDimension,
    onOpenChange,
  }: AlertsSidebarProps) => {
    const { state, removeAlert } = useNotificationContext();
    const [isOpen, setIsOpen] = useState(defaultOpen);
    // Only DEFINED entries override a default: a host passing
    // `{ close: undefined }` (e.g. a missing catalog value) keeps "Close".
    const labels = useMemo(
      () => mergeDefinedLabels(DEFAULT_LABELS, labelsProp),
      [labelsProp],
    );
    const alertLabels = useMemo(
      () => ({
        dismiss: labels.alertDismiss,
        draggable: labels.alertDraggable,
        dropToBottom: labels.alertDropToBottom,
      }),
      [labels],
    );
    const resolvedDefaultView =
      defaultView ?? (renderInbox ? "inbox" : "alerts");
    const [activeView, setActiveView] =
      useState<SidebarView>(resolvedDefaultView);
    const { width: windowWidth, height: windowHeight } =
      useViewportDimensions();
    const runtimePlatform = platformOverride ?? Platform.OS;
    const isWeb = runtimePlatform === "web";

    // Native only. The sole consumer is the `!isWeb` overlay at the bottom of
    // this component; the web overlay carries its own inline `position: fixed`
    // style inside `SidebarPortal`, so the web branch this memo used to have
    // was unreachable.
    const overlayStyle = useMemo(
      () =>
        ({
          width: windowWidth,
          height: windowHeight,
        }) as const,
      [windowHeight, windowWidth],
    );

    const sidebarStyle = useMemo(() => {
      if (isWeb) {
        const width = Math.min(380, windowWidth * 0.9);
        return {
          top: 16,
          right: 16,
          bottom: 16,
          left: undefined,
          height: windowHeight - 32,
          width,
          maxWidth: width,
          maxHeight: undefined,
          minHeight: undefined,
          overflow: undefined,
          padding: 20,
        } as const;
      }

      const sheetMaxHeight = Math.min(windowHeight * 0.9, 560);
      const sheetMinHeight = Math.min(
        sheetMaxHeight,
        Math.max(windowHeight * 0.4, 320),
      );
      return {
        top: undefined,
        right: 0,
        bottom: 0,
        left: 0,
        height: undefined,
        width: windowWidth,
        maxWidth: undefined,
        maxHeight: sheetMaxHeight,
        minHeight: sheetMinHeight,
        overflow: "hidden" as const,
        padding: 20,
      } as const;
    }, [isWeb, windowHeight, windowWidth]);

    const sidebarShadowStyle = useMemo(() => {
      if (isWeb) {
        return {
          boxShadow: "none",
        } as const;
      }
      return {} as const;
    }, [isWeb]);

    const scrollContentStyle = useMemo(
      () => ({ paddingBottom: 24, paddingHorizontal: 16 }),
      [],
    );

    const alertIds = useMemo(
      () => state.alerts.map((alert) => alert.id),
      [state.alerts],
    );
    const alertCount = unreadCount != null ? unreadCount : alertIds.length;
    const localAlertCount = alertIds.length;

    // Animation progress: 0 = closed, 1 = open
    const animationProgress = useSharedValue(isOpen ? 1 : 0);
    // Track visibility separately so we can unmount after exit animation
    const [nativeVisible, setNativeVisible] = useState(isOpen);
    // Web: keep DOM mounted while the CSS exit transition plays out
    const [webVisible, setWebVisible] = useState(isOpen);
    // Web: deferred open flag — lags one animation frame behind `webVisible`
    // so the DOM mounts at the offscreen position before transitioning in.
    const [webMountedOpen, setWebMountedOpen] = useState(isOpen);
    const webExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const webRafRef = useRef<number | null>(null);

    // Sheet height for gesture calculations
    const sheetMaxHeight = useMemo(
      () => Math.min(windowHeight * 0.9, 560),
      [windowHeight],
    );

    // Gesture handler for swipe-to-dismiss on native
    const swipeGesture = useMemo(() => {
      if (isWeb) {
        return Gesture.Pan().enabled(false);
      }

      const threshold = sheetMaxHeight * SWIPE_THRESHOLD_FRACTION;
      return Gesture.Pan()
        .maxPointers(1)
        .activeOffsetY([0, 10]) // Only activate on downward swipes
        .onUpdate((event) => {
          // Only allow dragging down (positive Y)
          if (event.translationY > 0) {
            // Map translation to animation progress (1 = open, 0 = closed)
            const dragProgress =
              1 - Math.min(event.translationY / sheetMaxHeight, 1);
            animationProgress.value = dragProgress;
          }
        })
        .onEnd((event) => {
          const shouldClose =
            event.translationY > threshold ||
            event.velocityY > VELOCITY_THRESHOLD;

          if (shouldClose) {
            animationProgress.value = withTiming(
              0,
              {
                duration: ANIMATION_DURATION_MS,
                easing: Easing.out(Easing.cubic),
              },
              (finished) => {
                if (finished) {
                  runOnJS(setIsOpen)(false);
                }
              },
            );
          } else {
            // Snap back to open
            animationProgress.value = withTiming(1, {
              duration: ANIMATION_DURATION_MS,
              easing: Easing.out(Easing.cubic),
            });
          }
        });
    }, [isWeb, sheetMaxHeight, animationProgress]);

    // Animated styles for native overlay
    const nativeOverlayStyle = useAnimatedStyle(() => ({
      opacity: animationProgress.value,
    }));

    // Animated styles for native sheet
    const nativeSheetStyle = useAnimatedStyle(() => ({
      transform: [
        {
          translateY: interpolate(
            animationProgress.value,
            [0, 1],
            [sheetMaxHeight, 0],
          ),
        },
      ],
      opacity: interpolate(animationProgress.value, [0, 0.5, 1], [0, 1, 1]),
    }));

    // Sync animation state with isOpen
    useEffect(() => {
      if (isWeb) return;

      if (isOpen) {
        setNativeVisible(true);
        animationProgress.value = withTiming(1, {
          duration: ANIMATION_DURATION_MS,
          easing: Easing.out(Easing.cubic),
        });
      } else {
        animationProgress.value = withTiming(
          0,
          {
            duration: ANIMATION_DURATION_MS,
            easing: Easing.out(Easing.cubic),
          },
          (finished) => {
            if (finished) {
              runOnJS(setNativeVisible)(false);
            }
          },
        );
      }
    }, [isOpen, isWeb, animationProgress]);

    // Web: two-phase mount/unmount for CSS transition slide animation.
    //
    // Opening:  webVisible → true (mounts at offscreen position)
    //           next frame: webMountedOpen → true (triggers CSS transition to final position)
    //
    // Closing:  webMountedOpen → false (CSS transition plays out)
    //           after ANIMATION_DURATION_MS: webVisible → false (unmounts)
    useEffect(() => {
      if (!isWeb) return;
      if (isOpen) {
        // Opening: mount immediately, clear any pending unmount timer
        if (webExitTimerRef.current) {
          clearTimeout(webExitTimerRef.current);
          webExitTimerRef.current = null;
        }
        if (webRafRef.current) {
          cancelAnimationFrame(webRafRef.current);
          webRafRef.current = null;
        }
        setWebVisible(true);
        // Defer the open flag by one frame so the DOM renders at the
        // offscreen position first, allowing the CSS transition to fire.
        webRafRef.current = requestAnimationFrame(() => {
          webRafRef.current = requestAnimationFrame(() => {
            webRafRef.current = null;
            setWebMountedOpen(true);
          });
        });
      } else if (webVisible) {
        // Closing: immediately flip the open flag (CSS transition out starts)
        if (webRafRef.current) {
          cancelAnimationFrame(webRafRef.current);
          webRafRef.current = null;
        }
        setWebMountedOpen(false);
        // Delay unmount so the CSS transition can play
        webExitTimerRef.current = setTimeout(() => {
          setWebVisible(false);
          webExitTimerRef.current = null;
        }, ANIMATION_DURATION_MS + 20);
      }
      return () => {
        if (webExitTimerRef.current) {
          clearTimeout(webExitTimerRef.current);
          webExitTimerRef.current = null;
        }
        if (webRafRef.current) {
          cancelAnimationFrame(webRafRef.current);
          webRafRef.current = null;
        }
      };
    }, [isOpen, isWeb, webVisible]);

    useEffect(() => {
      if (!isOpen || typeof window === "undefined") {
        return undefined;
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        // A layer above the panel that already consumed this Escape (Spotlight
        // closes on a `document` listener, which runs before this `window` one,
        // and marks it handled) gets that one Escape to itself — otherwise one
        // keypress closes both layers and focus-restore yanks the user to the
        // bell. Nothing inside the panel prevents Escape, so a plain Escape
        // still closes it.
        if (event.defaultPrevented) return;
        if (event.key === "Escape") {
          setIsOpen(false);
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => {
        window.removeEventListener("keydown", handleKeyDown);
      };
    }, [isOpen]);

    // Prevent body scroll when open — the same four lines Modal and SlidePanel
    // use, deliberately not a variation on them.
    //
    // The panel paints a backdrop and traps focus, so a page that still
    // scrolled underneath it was incoherent: it also scrolled the panel's own
    // trigger away (apps/web's navbar auto-hides), which left focus-restore on
    // close landing on an invisible bell. Locking the scroll means the navbar
    // cannot auto-hide while the panel is open, so the `pointer-events: none`
    // it takes on there can never reach the panel in the first place.
    //
    // `isWeb` can be forced by `platformOverride`, so the DOM still has to be
    // checked for, exactly as the focus effects below do.
    useEffect(() => {
      if (!isWeb || !isOpen || typeof document === "undefined") {
        return undefined;
      }
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }, [isOpen, isWeb]);

    useEffect(() => {
      if (defaultOpen) {
        setIsOpen(true);
      }
    }, [defaultOpen]);

    // `onOpenChange` fires from ONE effect keyed on `isOpen` rather than from
    // each setter: `isOpen` is written from five places (the bell toggle, the
    // shared close handler behind both the Close button and the backdrop,
    // Escape, the native swipe-dismiss callback, and the `defaultOpen` sync)
    // and a sixth would silently miss.
    //
    // The callback rides a ref, and the ref is synced in its own effect
    // declared FIRST so it is already fresh when the fire effect runs in the
    // same commit. A host passing an inline closure therefore does not
    // re-notify on every render; only a real open/close transition does.
    const onOpenChangeRef = useRef(onOpenChange);
    useEffect(() => {
      onOpenChangeRef.current = onOpenChange;
    }, [onOpenChange]);
    // Starts at `false` rather than `isOpen`: the host's own state starts
    // closed, so a panel that mounts open (`defaultOpen`) must say so on its
    // first effect. Starting closed still makes no call at all.
    const reportedOpenRef = useRef(false);
    useEffect(() => {
      if (reportedOpenRef.current === isOpen) return;
      reportedOpenRef.current = isOpen;
      onOpenChangeRef.current?.(isOpen);
    }, [isOpen]);
    // Unmounting while open never runs the effect above with `false`, so a
    // host holding something for the open panel (the web navbar's shown-hold)
    // would keep it forever. The host can lose this instance mid-open: the
    // navbar renders it at a different tree position per breakpoint, and
    // sign-out drops it. Report the close on the way down, only if the last
    // thing reported was "open", so a closed unmount stays silent.
    //
    // Deferred one microtask: StrictMode's dev-only effect replay runs this
    // cleanup and then re-runs the effect synchronously in the same commit,
    // so by the time the microtask fires a replay has set `mountedRef` back
    // and nothing is reported — the host sees no spurious false/true pair.
    // A real unmount leaves it false.
    const mountedRef = useRef(false);
    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        queueMicrotask(() => {
          if (mountedRef.current || !reportedOpenRef.current) return;
          reportedOpenRef.current = false;
          onOpenChangeRef.current?.(false);
        });
      };
    }, []);

    const handleToggle = useCallback(() => {
      setIsOpen((previous) => !previous);
    }, []);

    const handleClose = useCallback(() => {
      setIsOpen(false);
    }, []);

    // ── Web focus management ────────────────────────────────────────────
    // The panel is `role="dialog"` + `aria-modal`, so it behaves like one:
    // focus moves in on open, Tab/Shift+Tab stay inside, Escape closes (the
    // listener above), and focus returns to the bell on close.
    const bellRef = useRef<TamaguiElement | null>(null);
    const panelRef = useRef<HTMLElement | null>(null);
    const headingId = useId();
    const wasOpenRef = useRef(isOpen);

    useEffect(() => {
      // `isWeb` can be forced by `platformOverride`, so the DOM still has to
      // be checked for — the trap effect below guards the same way.
      if (!isWeb || typeof document === "undefined") return;
      const wasOpen = wasOpenRef.current;
      wasOpenRef.current = isOpen;
      if (isOpen && webVisible) {
        // Seat focus on the panel itself (tabIndex -1) so a screen reader
        // announces the dialog by its heading — unless something inside
        // already has it.
        const panel = panelRef.current;
        const active = document.activeElement;
        if (panel && !(active && panel.contains(active))) {
          panel.focus({ preventScroll: true });
        }
      } else if (!isOpen && wasOpen) {
        const bell = bellRef.current as HTMLElement | null;
        if (bell && typeof bell.focus === "function") {
          bell.focus({ preventScroll: true });
        }
      }
    }, [isOpen, isWeb, webVisible]);

    // Boundary-only trap, mirroring Modal: intermediate Tab steps stay native
    // and only a Tab that would LEAVE the panel is wrapped to the other edge.
    // The panel IS a <body> portal (`SidebarPortal`) but, unlike Modal, it
    // deliberately does not mark the rest of the page inert — it has no shared
    // layer-stack owner to do it with. Modal keeps module-level
    // `dialogLayers` / `pushLayer` / `syncInert` state (`Modal.tsx`) and this
    // panel does not participate in it, so the boundary trap is the whole of
    // what keeps focus from walking out.
    useEffect(() => {
      if (!isWeb || !isOpen || typeof document === "undefined") {
        return undefined;
      }
      const handleTab = (event: KeyboardEvent) => {
        if (event.key !== "Tab") return;
        const panel = panelRef.current;
        if (!panel) return;
        const active = document.activeElement as HTMLElement | null;
        const inside = !!active && panel.contains(active);
        // Focus sits in a live layer ABOVE the panel (a toast, a portalled
        // tooltip, a Modal opened on top) — not ours to reclaim, the same rule
        // Modal applies. Everything else outside the panel is the page behind
        // the overlay, and Tab pulls back in from there.
        if (!inside && active && isInLiveLayerAbovePanel(active, panel)) {
          return;
        }
        const items = getTabbables(panel);
        if (items.length === 0) {
          event.preventDefault();
          panel.focus({ preventScroll: true });
          return;
        }
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const index = active ? items.indexOf(active) : -1;
        if (!inside || index === -1) {
          // Outside the panel, or on the panel container itself.
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
          return;
        }
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      };
      document.addEventListener("keydown", handleTab, true);
      return () => document.removeEventListener("keydown", handleTab, true);
    }, [isOpen, isWeb]);

    const handleClearAll = useCallback(() => {
      alertIds.forEach((id) => removeAlert(id));
    }, [alertIds, removeAlert]);

    const handleSwitchToInbox = useCallback(() => setActiveView("inbox"), []);
    const handleSwitchToAlerts = useCallback(() => setActiveView("alerts"), []);

    const viewTabsBaseId = useId();
    const viewTabIdFor = useCallback(
      (view: SidebarView) => `${viewTabsBaseId}-tab-${view}`,
      [viewTabsBaseId],
    );
    const viewPanelId = `${viewTabsBaseId}-panel`;
    const viewTabA11y = (view: SidebarView) =>
      tabProps({
        isWeb,
        tab: view,
        selected: activeView,
        order: VIEW_ORDER,
        idFor: viewTabIdFor,
        panelId: viewPanelId,
        onSelect: setActiveView,
      });

    const emptyState = renderEmptyState?.() ?? (
      <DefaultEmptyState title={labels.emptyTitle} body={labels.emptyBody} />
    );

    return (
      <>
        <Button
          ref={bellRef}
          size="$3"
          variant="ghost"
          icon
          onPress={handleToggle}
          // `aria-label` overrides the button's content for the accessibility
          // tree, so the CountBadge's visible number never reached it. Fold
          // the count into the label itself so a screen reader hears it too.
          aria-label={
            formatButtonLabel
              ? formatButtonLabel(alertCount)
              : `${buttonLabel}${alertCount ? `, ${alertCount} unread` : ""}`
          }
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          // No ring on a mouse click, a real one from the keyboard — focus
          // comes back here when the panel closes. See BELL_FOCUS_VISIBLE.
          focusStyle={{ outlineWidth: 0 }}
          focusVisibleStyle={BELL_FOCUS_VISIBLE}
          borderRadius={0}
          alignSelf="flex-start"
          {...(buttonDimension
            ? {
                width: buttonDimension,
                height: buttonDimension,
                minWidth: buttonDimension,
                minHeight: buttonDimension,
              }
            : {})}
        >
          <ButtonIconWrapper>
            {isOpen ? <BellRing size={24} /> : <Bell size={24} />}
            {alertCount ? (
              <CountBadge
                position="absolute"
                top={-8}
                right={-6}
                pointerEvents="none"
              >
                <Text
                  variant="span"
                  weight="bold"
                  color="$onBrandSecondary"
                  fontSize={11}
                >
                  {alertCount > 99 ? "99+" : alertCount}
                </Text>
              </CountBadge>
            ) : null}
          </ButtonIconWrapper>
        </Button>

        {/* Web overlay + panel. Both sit in the portal's own <body> child, so
            neither the navbar's stacking context nor the `pointer-events: none`
            it takes on when it auto-hides can reach them — see SidebarPortal.
            The overlay stays first: it is the click-outside target and paints
            one level under the panel. */}
        {isWeb && webVisible ? (
          <SidebarPortal>
            <Stack
              key="alerts-web-overlay"
              zIndex={SIDEBAR_BACKDROP_Z_INDEX}
              backgroundColor="$overlay"
              cursor="pointer"
              onPress={handleClose}
              {...{
                style: {
                  position: "fixed",
                  top: 0,
                  left: 0,
                  width: "100vw",
                  height: "100vh",
                  opacity: webMountedOpen ? 1 : 0,
                  transition: `opacity ${ANIMATION_DURATION_MS}ms ease`,
                  pointerEvents: webMountedOpen ? "auto" : "none",
                } as React.CSSProperties,
              }}
            />
            <SidebarContainer
              key="alerts-sidebar-web"
              ref={panelRef as React.Ref<TamaguiElement>}
              role="dialog"
              aria-modal
              aria-labelledby={headingId}
              tabIndex={-1}
              outlineWidth={0}
              outlineStyle="none"
              presentation="sidebar"
              {...{
                style: {
                  position: "fixed",
                  top: sidebarStyle.top,
                  right: sidebarStyle.right,
                  bottom: sidebarStyle.bottom,
                  left: sidebarStyle.left,
                  height: sidebarStyle.height,
                  width: sidebarStyle.width,
                  maxWidth: sidebarStyle.maxWidth,
                  maxHeight: sidebarStyle.maxHeight,
                  minHeight: sidebarStyle.minHeight,
                  padding: sidebarStyle.padding,
                  overflow: sidebarStyle.overflow,
                  ...sidebarShadowStyle,
                  transform: webMountedOpen
                    ? "translateX(0)"
                    : `translateX(${Math.min(400, windowWidth * 0.9)}px)`,
                  opacity: webMountedOpen ? 1 : 0,
                  transition: `transform ${ANIMATION_DURATION_MS}ms cubic-bezier(0.4,0,0.2,1), opacity ${ANIMATION_DURATION_MS}ms ease`,
                  willChange: "transform, opacity",
                } as React.CSSProperties,
              }}
            >
              <SidebarHeader>
                <XStack
                  gap="$2"
                  alignItems="center"
                  flexShrink={1}
                  minWidth={0}
                >
                  <BellRing size={20} aria-hidden="true" />
                  <Text variant="body" weight="bold" id={headingId}>
                    {labels.heading}
                  </Text>
                  {alertCount ? (
                    <CountBadge>
                      <Text
                        variant="span"
                        weight="bold"
                        color="$onBrandSecondary"
                        fontSize={11}
                      >
                        {alertCount > 99 ? "99+" : alertCount}
                      </Text>
                    </CountBadge>
                  ) : null}
                </XStack>
                <SidebarCloseButton
                  onPress={handleClose}
                  label={labels.close}
                  ariaLabel={labels.closeAriaLabel}
                />
              </SidebarHeader>

              {/* View tabs — only shown when inbox is available */}
              {renderInbox ? (
                <XStack
                  gap="$1"
                  paddingBottom="$1"
                  role="tablist"
                  aria-label={labels.viewTabs}
                >
                  <ViewTab
                    active={activeView === "inbox"}
                    onPress={handleSwitchToInbox}
                    role="tab"
                    aria-selected={activeView === "inbox"}
                    {...viewTabA11y("inbox")}
                  >
                    <Text
                      variant="bodySmall"
                      weight={activeView === "inbox" ? "bold" : "regular"}
                      color={activeView === "inbox" ? "$onStructure" : "$color"}
                    >
                      {labels.inboxTab}
                    </Text>
                  </ViewTab>
                  <ViewTab
                    active={activeView === "alerts"}
                    onPress={handleSwitchToAlerts}
                    role="tab"
                    aria-selected={activeView === "alerts"}
                    {...viewTabA11y("alerts")}
                  >
                    <XStack alignItems="center">
                      <Text
                        variant="bodySmall"
                        weight={activeView === "alerts" ? "bold" : "regular"}
                        color={
                          activeView === "alerts" ? "$onStructure" : "$color"
                        }
                      >
                        {labels.activityTab}
                      </Text>
                      {localAlertCount > 0 ? (
                        <CountBadge marginLeft={4}>
                          <Text
                            variant="span"
                            weight="bold"
                            color="$onBrandSecondary"
                            fontSize={11}
                          >
                            {localAlertCount > 99 ? "99+" : localAlertCount}
                          </Text>
                        </CountBadge>
                      ) : null}
                    </XStack>
                  </ViewTab>
                </XStack>
              ) : null}

              <Separator />

              {/* Content area — the tabpanel the view tabs control (when there
                  are tabs). Same flex/gap as the panel, so the layout does not
                  move: `minHeight={0}` keeps the inbox's ScrollView scrolling. */}
              <PanelBody
                tabbed={Boolean(renderInbox)}
                panelId={viewPanelId}
                labelledBy={viewTabIdFor(activeView)}
              >
                {activeView === "inbox" && renderInbox ? (
                  <AlertsSidebarCloseContext.Provider value={handleClose}>
                    {renderInbox()}
                  </AlertsSidebarCloseContext.Provider>
                ) : (
                  <>
                    {localAlertCount ? (
                      <NotificationAlert
                        labels={alertLabels}
                        renderContainer={(children) => (
                          <YStack gap="$3" flex={1} overflow="scroll">
                            {children}
                          </YStack>
                        )}
                      />
                    ) : (
                      emptyState
                    )}

                    {localAlertCount && showClearAll ? (
                      <XStack gap="$2" justifyContent="flex-end">
                        <Button
                          size="$3"
                          variant="ghost"
                          onPress={handleClearAll}
                        >
                          {labels.clearAll}
                        </Button>
                      </XStack>
                    ) : null}
                  </>
                )}
              </PanelBody>
            </SidebarContainer>
          </SidebarPortal>
        ) : null}

        {isWeb ? null : nativeVisible ? (
          <AnimatedSidebarOverlay
            key="alerts-overlay-native"
            style={[overlayStyle, nativeOverlayStyle]}
            onPress={handleClose}
            pressStyle={{ opacity: 0.9 }}
            cursor="pointer"
          />
        ) : null}

        {/* Native: use react-native-reanimated with gesture handler */}
        {!isWeb && nativeVisible ? (
          <GestureDetector gesture={swipeGesture}>
            <AnimatedSidebarContainer
              key={`alerts-sidebar-native`}
              role="dialog"
              aria-modal
              aria-label={labels.heading}
              presentation="sheet"
              style={[
                {
                  position: "absolute",
                  left: sidebarStyle.left,
                  right: sidebarStyle.right,
                  bottom: sidebarStyle.bottom,
                  width: sidebarStyle.width,
                  maxHeight: sidebarStyle.maxHeight,
                  minHeight: sidebarStyle.minHeight,
                  padding: sidebarStyle.padding,
                  overflow: sidebarStyle.overflow,
                },
                nativeSheetStyle,
              ]}
            >
              <SheetHandle
                marginTop="$2"
                marginBottom="$3"
                testID="alerts-bottom-sheet-handle"
              />

              <SidebarHeader>
                <XStack
                  gap="$2"
                  alignItems="center"
                  flexShrink={1}
                  minWidth={0}
                >
                  <BellRing size={20} />
                  <Text variant="body" weight="bold">
                    {labels.heading}
                  </Text>
                  {alertCount ? (
                    <CountBadge>
                      <Text
                        variant="span"
                        weight="bold"
                        color="$onBrandSecondary"
                        fontSize={11}
                      >
                        {alertCount > 99 ? "99+" : alertCount}
                      </Text>
                    </CountBadge>
                  ) : null}
                </XStack>
                <SidebarCloseButton
                  onPress={handleClose}
                  label={labels.close}
                  ariaLabel={labels.closeAriaLabel}
                />
              </SidebarHeader>

              {/* View tabs (native). These were two `role="tab"`s with no
                  tablist around them, which reads worse to a screen reader
                  than no role at all.
                  `role` and `aria-selected` are both real React Native props:
                  `tablist` and `tab` are in RN 0.81's Role/AccessibilityRole
                  unions (Libraries/Components/View/ViewAccessibility.js) and
                  View folds `aria-selected` into
                  `accessibilityState.selected` (View.js), so the row now
                  exposes a named tablist, two tabs, and which one is selected.
                  The tabpanel RELATION is deliberately absent: `aria-controls`
                  has no RN equivalent and neither VoiceOver nor TalkBack has a
                  tabpanel concept to relate to, so the roles here are the
                  whole native contract. The web branch gets the DOM-only
                  wiring from `tablist-a11y` instead. */}
              {renderInbox ? (
                <XStack
                  gap="$1"
                  paddingBottom="$1"
                  role="tablist"
                  aria-label={labels.viewTabs}
                >
                  <ViewTab
                    active={activeView === "inbox"}
                    onPress={handleSwitchToInbox}
                    role="tab"
                    aria-selected={activeView === "inbox"}
                  >
                    <Text
                      variant="bodySmall"
                      weight={activeView === "inbox" ? "bold" : "regular"}
                      color={activeView === "inbox" ? "$onStructure" : "$color"}
                    >
                      {labels.inboxTab}
                    </Text>
                  </ViewTab>
                  <ViewTab
                    active={activeView === "alerts"}
                    onPress={handleSwitchToAlerts}
                    role="tab"
                    aria-selected={activeView === "alerts"}
                  >
                    <XStack alignItems="center">
                      <Text
                        variant="bodySmall"
                        weight={activeView === "alerts" ? "bold" : "regular"}
                        color={
                          activeView === "alerts" ? "$onStructure" : "$color"
                        }
                      >
                        {labels.activityTab}
                      </Text>
                      {localAlertCount > 0 ? (
                        <CountBadge marginLeft={4}>
                          <Text
                            variant="span"
                            weight="bold"
                            color="$onBrandSecondary"
                            fontSize={10}
                          >
                            {localAlertCount > 99 ? "99+" : localAlertCount}
                          </Text>
                        </CountBadge>
                      ) : null}
                    </XStack>
                  </ViewTab>
                </XStack>
              ) : null}

              <Separator />

              {/* Content area (native) */}
              {activeView === "inbox" && renderInbox ? (
                <AlertsSidebarCloseContext.Provider value={handleClose}>
                  {renderInbox()}
                </AlertsSidebarCloseContext.Provider>
              ) : (
                <>
                  {localAlertCount ? (
                    <NotificationAlert
                      labels={alertLabels}
                      renderContainer={(children) => (
                        <ScrollView
                          style={{ flex: 1 }}
                          contentContainerStyle={scrollContentStyle}
                          keyboardShouldPersistTaps="handled"
                          showsVerticalScrollIndicator={false}
                          testID="alerts-bottom-sheet-scroll"
                          data-testid="alerts-bottom-sheet-scroll"
                        >
                          <YStack gap="$3">{children}</YStack>
                        </ScrollView>
                      )}
                    />
                  ) : (
                    emptyState
                  )}

                  {localAlertCount && showClearAll ? (
                    <XStack gap="$2" justifyContent="flex-end">
                      <Button
                        size="$3"
                        variant="ghost"
                        onPress={handleClearAll}
                      >
                        {labels.clearAll}
                      </Button>
                    </XStack>
                  ) : null}
                </>
              )}
            </AnimatedSidebarContainer>
          </GestureDetector>
        ) : null}
      </>
    );
  },
);

AlertsSidebar.displayName = "AlertsSidebar";
