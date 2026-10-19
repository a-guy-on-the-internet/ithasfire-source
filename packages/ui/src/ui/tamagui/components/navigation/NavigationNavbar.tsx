"use client";

import { Command, PanelLeftClose, PanelLeftOpen, UserPlus } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { Platform } from "react-native";
import { Stack, XStack, YStack, styled } from "tamagui";

import type {
  AccountContext,
  AlertSummary,
  NavigationShellLayout,
  QuickActionConfig,
} from "../../../types/navigation";
import type { IthasFireThemeName } from "../../../tamagui";
import { Badge } from "../feedback/Badge";
import { Button } from "../forms/Button";
import { Navbar } from "../navigation/Navbar";
import { NavbarMenuButton } from "../navigation/NavbarMenuButton";
import { NotificationButton } from "../feedback/NotificationButton";
import { Text } from "../typography/Text";
import { Tooltip } from "../feedback/Tooltip";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const isWeb = Platform.OS === "web";

const BrandStack = styled(XStack, {
  name: "NavigationTopBarBrand",
  alignItems: "center",
  gap: "$3",
  flexShrink: 0,
  // On phones the row runs out of width and Navbar's BrandSlot flex-shrinks;
  // this subtree must shrink WITH it. A rigid child centered in a shrunken
  // slot bleeds equally over both neighbours (overflow is visible), painting
  // over — and hit-blocking — the drawer hamburger on the left and the
  // notification bell on the right. `overflow: hidden` is the backstop: if a
  // caller passes un-shrinkable brand content, it clips inside the slot
  // instead of stealing its neighbours' taps.
  $sm: {
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
  },
});

const ControlsRow = styled(XStack, {
  name: "NavigationTopBarControls",
  alignItems: "center",
  gap: "$2",
  flexWrap: "nowrap",
  justifyContent: "flex-end",
  position: "relative",
});

const QuickActionBar = styled(XStack, {
  name: "NavigationQuickActionBar",
  alignItems: "center",
  gap: "$2",
  flexWrap: "wrap",
});

const SecondaryNavSlot = styled(Stack, {
  name: "NavigationSecondaryNavSlot",
});

const SkeletonFrame = styled(YStack, {
  name: "NavigationTopBarSkeletonFrame",
  backgroundColor: "$surface",
  paddingHorizontal: "$5",
  paddingVertical: "$4",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
  gap: "$3",
  flexShrink: 0,
  zIndex: 10,
});

const SkeletonBlock = styled(Stack, {
  name: "NavigationTopBarSkeleton",
  backgroundColor: "$surfaceMuted",
  height: 28,
  borderRadius: 0,
});

const ENVIRONMENT_BADGE_LABEL: Record<"development" | "staging", string> = {
  development: "Development",
  staging: "Staging",
};

const CollapseButton = ({
  railState,
  onToggle,
}: {
  railState: "expanded" | "collapsed";
  onToggle?: () => void;
}) => (
  <Button
    variant="ghost"
    size="$1"
    icon
    // Since the compact rail change this is the SOLE expand affordance at
    // compact (960–1199) — the glyph keeps its chrome weight, but the hit
    // box meets the ≥44×44 floor. NavbarRow's minHeight is 64, so this does
    // not change the row height.
    minWidth={44}
    minHeight={44}
    aria-label={
      railState === "expanded"
        ? "Collapse navigation rail"
        : "Expand navigation rail"
    }
    onPress={onToggle}
  >
    {railState === "expanded" ? (
      <PanelLeftClose size={18} />
    ) : (
      <PanelLeftOpen size={18} />
    )}
  </Button>
);

const EnvironmentBadge = ({
  badge,
}: {
  badge: NavigationNavbarProps["environmentBadge"];
}) => {
  if (!badge) {
    return null;
  }

  const label = ENVIRONMENT_BADGE_LABEL[badge];

  return (
    <Badge tone="warning" size="sm">
      {label}
    </Badge>
  );
};

const QuickActionButton = ({
  action,
  layout,
  onSelect,
}: {
  action: QuickActionConfig;
  layout: NavigationShellLayout;
  onSelect: (action: QuickActionConfig) => void;
}) => {
  const content = (
    <Button
      variant="secondary"
      size={layout === "desktop" ? "$2" : "$1"}
      icon={layout !== "desktop"}
      disabled={action.disabled}
      onPress={() => onSelect(action)}
      aria-label={layout !== "desktop" ? action.label : undefined}
    >
      {action.icon ?? null}
      {layout === "desktop" ? action.label : null}
    </Button>
  );

  if (layout === "desktop") {
    return content;
  }

  return (
    <Tooltip anchor={content} placement="bottom" showPointer={false}>
      <Text variant="bodySmall" weight="bold">
        {action.label}
      </Text>
    </Tooltip>
  );
};

const aggregateAlertCount = (alerts?: AlertSummary[]) =>
  alerts?.reduce((total, alert) => total + (alert.count ?? 0), 0) ?? 0;

export interface NavigationNavbarProps {
  layout: NavigationShellLayout;
  brand?: ReactNode;
  onBrandPress?: () => void;
  /**
   * Environment chip rendered inside the brand stack. The mobile navbar
   * (`layout === "mobile"`) drops the brand stack entirely, so the badge
   * renders only at compact/desktop.
   */
  environmentBadge?: "staging" | "development" | null;
  quickActions?: QuickActionConfig[];
  alerts?: AlertSummary[];
  onAlertSelect?: () => void;
  onQuickActionSelect?: (actionId: string) => void;
  onOpenCommandPalette?: () => void;
  onInviteTeammate?: () => void;
  onToggleDrawer?: () => void;
  onToggleRail?: () => void;
  railState: "expanded" | "collapsed";
  showRailToggle?: boolean;
  accountContext: AccountContext;
  availableContexts?: AccountContext[];
  onContextSelect?: (contextId: string) => Promise<void> | void;
  onCreateOrganization?: () => void;
  contextSwitchingId?: string | null;
  onReturnToConsumer?: () => void;
  returnToConsumerLabel?: string;
  returnToConsumerDescription?: string;
  drawerOpen?: boolean;
  secondaryNav?: ReactNode;
  loading?: boolean;
  testIdBase?: string;
  appearance: IthasFireThemeName;
  /** Extra ReactNode rendered inside the trailing controls. */
  trailingSlot?: ReactNode;
  /** Search accessory rendered in the center search slot of the Navbar. */
  searchAccessory?: ReactNode;
  /**
   * Build an href for a workspace context switch. When provided, each
   * workspace item in the switcher renders as a proper `<a>` link so
   * users can right-click → "Open in new tab".
   */
  contextHrefBuilder?: (contextId: string) => string;
  /** Max width for the navbar content row. When set, the row is centered within this width. */
  contentMaxWidth?: number;
}

export const NavigationNavbar = ({
  layout,
  brand,
  onBrandPress,
  environmentBadge,
  quickActions,
  alerts,
  onAlertSelect,
  onQuickActionSelect,
  onOpenCommandPalette,
  onInviteTeammate,
  onToggleDrawer,
  onToggleRail,
  railState,
  showRailToggle,
  accountContext,
  availableContexts,
  onContextSelect,
  onCreateOrganization,
  contextSwitchingId,
  onReturnToConsumer,
  returnToConsumerLabel = "Switch to attendee view",
  returnToConsumerDescription,
  drawerOpen = false,
  secondaryNav,
  loading = false,
  testIdBase = "navigation-top-bar",
  // `appearance` stays in the props type for consumers (NavigationShell
  // passes it) but the navbar itself no longer reads it.
  trailingSlot,
  searchAccessory,
  contextHrefBuilder,
  contentMaxWidth,
}: NavigationNavbarProps) => {
  const isMobile = layout === "mobile";
  const visibleQuickActions = quickActions ?? [];

  const handleQuickAction = useCallback(
    (action: QuickActionConfig) => {
      void action.onSelect?.();
      onQuickActionSelect?.(action.id);
    },
    [onQuickActionSelect],
  );

  const alertCount = aggregateAlertCount(alerts);

  const brandContent = brand ?? (
    <Text variant="h5" weight="bold">
      Ithas Fire
    </Text>
  );

  // "Development" / "Staging" chip. It used to live only inside `brandStack`,
  // which the mobile bar no longer renders — so dropping the brand silently
  // dropped the badge too, on exactly the device where telling dev from prod
  // by the URL bar is hardest. Rendered in the brand stack on desktop (its
  // original position, unchanged) and in the leading slot on mobile.
  const environmentBadgeNode = environmentBadge ? (
    <EnvironmentBadge badge={environmentBadge} />
  ) : null;

  const brandStack = (
    <BrandStack>
      {onBrandPress ? (
        <Button
          variant="ghost"
          size="$3"
          onPress={onBrandPress}
          aria-label="Go to home"
          maxWidth="100%"
          $sm={{ flexShrink: 1, minWidth: 0, paddingHorizontal: "$2" }}
        >
          {brandContent}
        </Button>
      ) : (
        brandContent
      )}
      {isMobile ? null : environmentBadgeNode}
    </BrandStack>
  );

  if (loading) {
    return (
      <SkeletonFrame data-testid={`${testIdBase}-loading`}>
        <SkeletonBlock width={200} />
        <SkeletonBlock width="100%" height={36} />
      </SkeletonFrame>
    );
  }

  // Guard-case only: the shell passes `onToggleDrawer` when the drawer has no
  // other entry point (no bottom bar, or one too small for a MORE tab).
  // `$4` = 44px — the mobile top bar's minimum touch target.
  const menuButton =
    isMobile && onToggleDrawer ? (
      <NavbarMenuButton
        open={drawerOpen}
        buttonSize="$4"
        onToggle={() => onToggleDrawer?.()}
        accessibilityLabel="Toggle navigation drawer"
      />
    ) : null;

  // Mobile carries the env badge here, since it has no brand slot to sit in.
  // `menuButton` is already mobile-only, so desktop resolves to `undefined`
  // exactly as before — and staying `undefined` when there is nothing to show
  // keeps `shouldRenderLeading` from adding an empty slot and its gap.
  const showEnvBadgeLeading = isMobile && environmentBadgeNode !== null;
  const leadingAccessory =
    menuButton || showEnvBadgeLeading ? (
      <>
        {menuButton}
        {showEnvBadgeLeading ? environmentBadgeNode : null}
      </>
    ) : undefined;

  const workspaceSwitcher = (
    <WorkspaceSwitcher
      layout={layout}
      accountContext={accountContext}
      availableContexts={availableContexts}
      onContextSelect={onContextSelect}
      onCreateOrganization={onCreateOrganization}
      contextSwitchingId={contextSwitchingId}
      onReturnToConsumer={onReturnToConsumer}
      returnToConsumerLabel={returnToConsumerLabel}
      returnToConsumerDescription={returnToConsumerDescription}
      contextHrefBuilder={contextHrefBuilder}
      testIdBase={testIdBase}
    />
  );

  return (
    <Navbar
      // The mobile top bar drops the brand lockup entirely: the workspace
      // switcher (full name + mark) is the identity anchor there, rendered
      // leading via the fluid title slot below.
      brand={isMobile ? undefined : brandStack}
      leadingAccessory={leadingAccessory}
      title={isMobile ? workspaceSwitcher : undefined}
      searchAccessory={!isMobile ? searchAccessory : undefined}
      contentMaxWidth={contentMaxWidth}
      // Tighten edge padding + inter-slot gap for the WHOLE mobile layout
      // (<960px). The styled `$sm` block only covers ≤640px; layouts between
      // 641–959 are still "mobile" and must match (x=8 leading inset).
      {...(isMobile ? { paddingHorizontal: "$2", gap: "$2" } : {})}
      trailingAccessory={
        <ControlsRow>
          {showRailToggle && (layout === "desktop" || layout === "compact") ? (
            <CollapseButton railState={railState} onToggle={onToggleRail} />
          ) : null}
          {visibleQuickActions.length ? (
            <QuickActionBar>
              {visibleQuickActions.map((action) => (
                <QuickActionButton
                  key={action.id}
                  action={action}
                  layout={layout}
                  onSelect={handleQuickAction}
                />
              ))}
            </QuickActionBar>
          ) : null}
          {onOpenCommandPalette ? (
            <Button
              variant="ghost"
              size="$1"
              icon
              aria-keyshortcuts={isWeb ? "Meta+K" : undefined}
              onPress={onOpenCommandPalette}
            >
              <Command size={18} />
            </Button>
          ) : null}
          {alerts?.length ? (
            <NotificationButton
              aria-label="View alerts"
              count={alertCount}
              onPress={onAlertSelect}
            />
          ) : null}
          {onInviteTeammate ? (
            <Button
              variant="secondary"
              size="$2"
              onPress={onInviteTeammate}
              icon={layout !== "desktop"}
            >
              <UserPlus size={18} />
              {layout === "desktop" ? "Invite" : null}
            </Button>
          ) : null}
          {trailingSlot}
          {/* On mobile the switcher leads (title slot above) instead. */}
          {isMobile ? null : workspaceSwitcher}
        </ControlsRow>
      }
      testIdBase={testIdBase}
    >
      {secondaryNav ? (
        <SecondaryNavSlot>{secondaryNav}</SecondaryNavSlot>
      ) : null}
    </Navbar>
  );
};

NavigationNavbar.displayName = "NavigationNavbar";
