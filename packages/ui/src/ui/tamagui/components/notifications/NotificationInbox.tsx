"use client";

import { memo, useCallback, useId, useMemo, type ReactNode } from "react";
import { Platform, ScrollView } from "react-native";
import { CheckCheck, Inbox } from "lucide-react";
import { Separator, Stack, XStack, YStack, styled } from "tamagui";

import { Button } from "../forms/Button";
import { Text } from "../typography/Text";
import { mergeDefinedLabels } from "./merge-labels";
import {
  NotificationItem,
  type NotificationItemData,
  type NotificationItemLabels,
} from "./NotificationItem";
import { tabPanelProps, tabProps } from "./tablist-a11y";

const TAB_ORDER: readonly InboxTab[] = ["unread", "all"] as const;

// The tab wiring in `tablist-a11y` is DOM-only, so it has to be told whether
// it is on web. Unlike AlertsSidebar — which renders one markup branch per
// platform and lets a caller force it — the inbox renders a SINGLE markup for
// both, so the honest question here is "am I running on a DOM", and
// `Platform.OS` answers exactly that.
const IS_WEB = Platform.OS === "web";

// lucide-react writes `color` straight into the SVG's `stroke`, so a Tamagui
// token string ("$colorMuted") is an invalid paint and the glyph never draws.
// v2: CSS var with the Stub value as the first-paint fallback.
const ICON_COLOR_MUTED = "var(--colorMuted, #5C544A)";

// ─── Types ──────────────────────────────────────────────────────────────────

export type InboxTab = "unread" | "all";

export interface NotificationInboxProps {
  /** List of notifications to display. */
  notifications: NotificationItemData[];
  /** Currently selected tab. */
  activeTab: InboxTab;
  /** Fired when the user switches tabs. */
  onTabChange: (tab: InboxTab) => void;
  /** Total unread count (for the tab badge). */
  unreadCount: number;
  /** Mark a single notification as read. */
  onMarkRead: (id: string) => void;
  /** Mark all notifications as read. */
  onMarkAllRead: () => void;
  /** Navigate to an action href. */
  onAction?: (href: string) => void;
  /** Dismiss (hide) a single notification. */
  onDismiss?: (id: string) => void;
  /** Whether more pages are available. */
  hasMore?: boolean;
  /** Load the next page. */
  onLoadMore?: () => void;
  /** Show a loading skeleton when fetching. */
  isLoading?: boolean;
  /** Whether the "load more" action is in flight. */
  isLoadingMore?: boolean;
  /** Optional override for the empty state. */
  renderEmptyState?: () => ReactNode;
  /** Translated inbox labels; see `NotificationInboxLabels`. Pass a stable
   * (memoised) object — the inbox is `memo`ised. */
  labels?: Partial<NotificationInboxLabels>;
  /** Translated row labels, handed to every `NotificationItem`. Stable, too. */
  itemLabels?: Partial<NotificationItemLabels>;
  /** Locale for each row's relative timestamp; see `NotificationItem`. */
  locale?: string;
}

/**
 * The inbox's own words, for a host with a catalog. Any entry left out (or
 * passed `undefined`) keeps its English default.
 */
export interface NotificationInboxLabels {
  /** Accessible name of the Unread / All tablist. */
  tabs: string;
  unread: string;
  all: string;
  /** Visible text AND accessible name of the mark-all button. */
  markAllRead: string;
  emptyUnreadTitle: string;
  emptyUnreadBody: string;
  emptyAllTitle: string;
  emptyAllBody: string;
  loadMore: string;
  loadingMore: string;
}

export const DEFAULT_NOTIFICATION_INBOX_LABELS: NotificationInboxLabels = {
  tabs: "Filter notifications",
  unread: "Unread",
  all: "All",
  markAllRead: "Mark all read",
  emptyUnreadTitle: "All caught up",
  emptyUnreadBody: "You have no unread notifications.",
  emptyAllTitle: "No notifications yet",
  emptyAllBody: "Notifications will appear here as things happen.",
  loadMore: "Load more",
  loadingMore: "Loading...",
};

// ─── Styled ─────────────────────────────────────────────────────────────────

const TabBar = styled(XStack, {
  name: "NotificationInboxTabBar",
  gap: "$1",
  paddingBottom: "$2",
});

// The `active` tab paints the solid `$surfaceStrong` fill, which resolves to
// the INK itself on Stub (#211C16 === `$color`). `Text` always sets its own
// color and never inherits, so the label MUST be handed `$onStructure`
// explicitly at the call site whenever `active` is true — otherwise it renders
// ink-on-ink at 1.00:1 and the tab is a solid black rectangle with no label.
// `$onStructure` is the only foreground that clears AA against `$surfaceStrong`
// in all three themes: stub 16.2:1, ember 9.1:1, swiss 6.9:1.
//
// A real <button> on web (`tag`) carrying the WAI-ARIA tab wiring from
// `tablist-a11y.ts`; the reset keeps it pixel-identical to the old <div>. On a
// coarse pointer it grows to the 44px touch floor.
const TabButton = styled(Stack, {
  name: "NotificationInboxTab",
  tag: "button",
  borderWidth: 0,
  margin: 0,
  justifyContent: "center",
  paddingVertical: "$1",
  paddingHorizontal: "$3",
  borderRadius: 0,
  cursor: "pointer",
  focusVisibleStyle: {
    outlineColor: "$outlineColor",
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineOffset: 2,
  },
  $pointerCoarse: {
    minHeight: 44,
  },
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

// The count label is 11px — small text, so the 4.5:1 floor applies. White on the
// `$brandSecondary` fill (#E2481D on Stub) is only 4.06:1, so the badge rides the
// deeper `$brandSecondaryHover` (#B93312) fill, where `$onBrandSecondary` reaches
// 5.92 / 4.61 / 4.61 across stub / swiss / ember. This is the same trade
// design-system-v2.md §3 prescribes and that PriceBlock + the primary CTA
// already make.
const TabBadge = styled(Stack, {
  name: "NotificationInboxTabBadge",
  minWidth: 20,
  height: 20,
  paddingHorizontal: 4,
  borderRadius: 0,
  borderColor: "$borderColorStrong",
  borderWidth: 1,
  backgroundColor: "$brandSecondaryHover",
  alignItems: "center",
  justifyContent: "center",
  marginLeft: 4,
});

const EmptyStateContainer = styled(YStack, {
  name: "NotificationInboxEmptyState",
  alignItems: "center",
  gap: "$2",
  paddingVertical: "$8",
  paddingHorizontal: "$2",
});

const SkeletonRow = styled(XStack, {
  name: "NotificationInboxSkeleton",
  gap: "$3",
  paddingVertical: "$3",
  paddingHorizontal: "$3",
  alignItems: "center",
});

const SkeletonBlock = styled(Stack, {
  name: "NotificationInboxSkeletonBlock",
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
});

// ─── Sub-components ─────────────────────────────────────────────────────────

const LoadingSkeleton = () => (
  <YStack gap="$1">
    {[1, 2, 3].map((i) => (
      <SkeletonRow key={i}>
        <SkeletonBlock width={8} height={8} borderRadius={0} />
        <SkeletonBlock width={32} height={32} />
        <YStack flex={1} gap="$2">
          <SkeletonBlock width="60%" height={12} />
          <SkeletonBlock width="90%" height={10} />
          <SkeletonBlock width="30%" height={8} />
        </YStack>
      </SkeletonRow>
    ))}
  </YStack>
);

const DefaultEmptyState = ({
  tab,
  labels,
}: {
  tab: InboxTab;
  labels: NotificationInboxLabels;
}) => (
  <EmptyStateContainer>
    <Inbox size={32} color={ICON_COLOR_MUTED} aria-hidden="true" />
    <Text variant="body" weight="bold" textAlign="center">
      {tab === "unread" ? labels.emptyUnreadTitle : labels.emptyAllTitle}
    </Text>
    <Text variant="bodySmall" tone="muted" textAlign="center">
      {tab === "unread" ? labels.emptyUnreadBody : labels.emptyAllBody}
    </Text>
  </EmptyStateContainer>
);

// ─── Component ──────────────────────────────────────────────────────────────

export const NotificationInbox = memo(
  ({
    notifications,
    activeTab,
    onTabChange,
    unreadCount,
    onMarkRead,
    onMarkAllRead,
    onAction,
    onDismiss,
    hasMore = false,
    onLoadMore,
    isLoading = false,
    isLoadingMore = false,
    renderEmptyState,
    labels: labelsProp,
    itemLabels,
    locale,
  }: NotificationInboxProps) => {
    const labels = useMemo(
      () => mergeDefinedLabels(DEFAULT_NOTIFICATION_INBOX_LABELS, labelsProp),
      [labelsProp],
    );
    const handleUnreadTab = useCallback(
      () => onTabChange("unread"),
      [onTabChange],
    );
    const handleAllTab = useCallback(() => onTabChange("all"), [onTabChange]);

    const scrollContentStyle = useMemo(() => ({ paddingBottom: 24 }), []);

    const tabsBaseId = useId();
    const tabIdFor = useCallback(
      (tab: InboxTab) => `${tabsBaseId}-tab-${tab}`,
      [tabsBaseId],
    );
    const panelId = `${tabsBaseId}-panel`;
    const tabA11y = (tab: InboxTab) =>
      tabProps({
        isWeb: IS_WEB,
        tab,
        selected: activeTab,
        order: TAB_ORDER,
        idFor: tabIdFor,
        panelId,
        onSelect: onTabChange,
      });

    const showMarkAll = activeTab === "unread" && unreadCount > 0;
    const isEmpty = notifications.length === 0 && !isLoading;

    return (
      <YStack flex={1} gap="$2">
        {/* Tab bar + Mark all read. Wraps: at 320px the tabs (~150px) and
            "MARK ALL READ" (~144px) overran the ~248px panel, so the button
            drops to its own line there instead of running past the edge. */}
        <XStack
          alignItems="center"
          justifyContent="space-between"
          flexWrap="wrap"
          rowGap="$2"
        >
          <TabBar role="tablist" aria-label={labels.tabs}>
            <TabButton
              active={activeTab === "unread"}
              onPress={handleUnreadTab}
              role="tab"
              aria-selected={activeTab === "unread"}
              {...tabA11y("unread")}
            >
              <XStack alignItems="center">
                <Text
                  variant="bodySmall"
                  weight={activeTab === "unread" ? "bold" : "regular"}
                  color={activeTab === "unread" ? "$onStructure" : "$color"}
                >
                  {labels.unread}
                </Text>
                {unreadCount > 0 ? (
                  <TabBadge>
                    <Text
                      variant="span"
                      weight="bold"
                      color="$onBrandSecondary"
                      fontSize={11}
                    >
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </Text>
                  </TabBadge>
                ) : null}
              </XStack>
            </TabButton>

            <TabButton
              active={activeTab === "all"}
              onPress={handleAllTab}
              role="tab"
              aria-selected={activeTab === "all"}
              {...tabA11y("all")}
            >
              <Text
                variant="bodySmall"
                weight={activeTab === "all" ? "bold" : "regular"}
                color={activeTab === "all" ? "$onStructure" : "$color"}
              >
                {labels.all}
              </Text>
            </TabButton>
          </TabBar>

          {showMarkAll ? (
            <Button
              size="$2"
              variant="ghost"
              onPress={onMarkAllRead}
              // No aria-label: the visible text "Mark all read" is already a
              // correct accessible name. WCAG 2.5.3 requires the name to
              // *contain* the visible label string — "Mark all as read" does
              // not (the "as" breaks the substring match), so a voice-control
              // "click Mark all read" command would silently fail.
              $pointerCoarse={{ minHeight: 44 }}
            >
              <XStack alignItems="center" gap="$1">
                <CheckCheck size={14} />
                <Text variant="span" fontSize={12}>
                  {labels.markAllRead}
                </Text>
              </XStack>
            </Button>
          ) : null}
        </XStack>

        <Separator />

        {/* Content — the tabpanel both tabs control. `minHeight={0}` lets the
            ScrollView inside shrink and scroll as it did as a direct child. */}
        <YStack
          flex={1}
          minHeight={0}
          {...tabPanelProps({
            isWeb: IS_WEB,
            panelId,
            labelledBy: tabIdFor(activeTab),
          })}
        >
          {isLoading ? (
            <LoadingSkeleton />
          ) : isEmpty ? (
            (renderEmptyState?.() ?? (
              <DefaultEmptyState tab={activeTab} labels={labels} />
            ))
          ) : (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={scrollContentStyle}
              showsVerticalScrollIndicator={false}
            >
              <YStack role="list">
                {notifications.map((n) => (
                  <NotificationItem
                    key={n.id}
                    notification={n}
                    onMarkRead={onMarkRead}
                    onAction={onAction}
                    onDismiss={onDismiss}
                    labels={itemLabels}
                    locale={locale}
                  />
                ))}
              </YStack>

              {hasMore ? (
                <XStack justifyContent="center" paddingVertical="$3">
                  <Button
                    size="$3"
                    variant="outlined"
                    onPress={onLoadMore}
                    disabled={isLoadingMore}
                  >
                    <Text tone="inherit" variant="bodySmall" weight="bold">
                      {isLoadingMore ? labels.loadingMore : labels.loadMore}
                    </Text>
                  </Button>
                </XStack>
              ) : null}
            </ScrollView>
          )}
        </YStack>
      </YStack>
    );
  },
);

NotificationInbox.displayName = "NotificationInbox";
