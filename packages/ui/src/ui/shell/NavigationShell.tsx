"use client";

import { useCallback, useId, useMemo } from "react";
import { Platform } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { Theme, YStack } from "tamagui";

import { Text } from "../tamagui/components";
import { NavigationShellDrawer } from "./components/NavigationDrawer";
import { NavigationRail } from "./components/NavigationRail";
import {
  NavigationBottomBar,
  NavigationNavbar,
  bottomBarShowsMore,
} from "../tamagui/components";
import { NavigationShellProvider } from "./NavigationShellContext";
import type {
  NavigationRailBack,
  NavigationShellProps,
} from "./NavigationShell.types";

import {
  ShellFrame,
  EdgeSwipeZone,
  ShellLayoutRow,
  ContentArea,
  TopBarContainer,
  TopBarInner,
  SkipLink,
  RailSkeletonFrame,
  SkeletonBlock,
  CompactRailSkeletonFrame,
} from "./NavigationShell.styles";

import {
  useShellLayout,
  useRailState,
  useDrawerState,
  useAppearance,
  useContextSwitch,
  useFilteredNavigation,
  useFilteredQuickActions,
  useRouteSelection,
  useCommandPaletteShortcut,
  useShellViewTracking,
} from "./NavigationShell.hooks";

const isWebPlatform = () => Platform.OS === "web";

const DEFAULT_DRAWER_BREAKPOINT = 960;
const EDGE_SWIPE_THRESHOLD = 40;

const DefaultEmptyState = () => (
  <YStack gap="$2" padding="$4">
    <Text variant="body" weight="bold">
      Navigation unavailable
    </Text>
    <Text variant="bodySmall" tone="muted">
      You do not have access to any navigation sections yet.
    </Text>
  </YStack>
);

const RailSkeleton = ({
  collapsed,
  showDivider,
}: {
  collapsed: boolean;
  showDivider: boolean;
}) => {
  // The real rail's width is driven by `collapsed` (72px icon rail vs the
  // labelled rail), not by layout — picking the frame by layout showed a
  // 256px skeleton on a desktop whose stored preference was "collapsed",
  // which then snapped to 72px when loading finished.
  const FrameComponent = collapsed
    ? CompactRailSkeletonFrame
    : RailSkeletonFrame;

  return (
    <FrameComponent aria-hidden showDivider={showDivider}>
      <SkeletonBlock width="100%" />
      <SkeletonBlock width="80%" />
      <SkeletonBlock width="60%" />
      <SkeletonBlock width="100%" />
      <SkeletonBlock width="70%" />
    </FrameComponent>
  );
};

export const NavigationShell = ({
  navSections,
  currentRoute,
  accountContext,
  onRouteSelect,
  availableContexts,
  onContextSwitch,
  onCreateOrganization,
  quickActions,
  alerts,
  onAlertSelect,
  secondaryNav,
  onOpenCommandPalette,
  onInviteTeammate,
  railBehavior = "auto",
  drawerBreakpoint = DEFAULT_DRAWER_BREAKPOINT,
  environmentBadge,
  analytics,
  loading = false,
  testIdBase = "navigation-shell",
  brand,
  children,
  emptyState,
  quickActionFooter,
  enabledFeatureFlags,
  forceLayout,
  onBrandPress,
  onReturnToConsumer,
  returnToConsumerLabel,
  returnToConsumerDescription,
  skipToContentLabel = "Skip to content",
  configControls: externalConfigControls = [],
  collapsibleSections = false,
  sectionCollapsePersistKey,
  showRailIdentity = false,
  railIdentityHref,
  onRailIdentityPress,
  railIdentityLabel,
  railBack,
  railContextHeader,
  contentVariant = "plain",
  bottomBarCenterAction,
  navbarTrailingSlot,
  navbarSearchSlot,
  navbarContentMaxWidth,
  contextHrefBuilder,
}: NavigationShellProps) => {
  const contentId = useId();

  // Layout resolution
  const resolvedLayout = useShellLayout(drawerBreakpoint, forceLayout);

  // Drawer state management
  const { drawerOpen, setDrawerOpen, toggleDrawer, openDrawer, closeDrawer } =
    useDrawerState();

  // Rail state management
  const { railState, setRailState, toggleRail } = useRailState({
    behavior: railBehavior,
    layout: resolvedLayout,
    analytics,
  });

  // Appearance/theme management
  const { appearance } = useAppearance();

  // Context switching
  const { contextSwitchingId, handleContextSwitch } = useContextSwitch({
    accountContext,
    onContextSwitch,
    analytics,
  });

  // Effective role set for filtering. Prefer the explicit `roles` array;
  // fall back to the display `role` so single-role contexts keep working.
  // Empty → filtering errs open (see NavigationShell.hooks.isRolePermitted).
  const effectiveRoles = useMemo(
    () =>
      accountContext.roles ??
      (accountContext.role ? [accountContext.role] : []),
    [accountContext.roles, accountContext.role],
  );

  // Filtered navigation based on RBAC and feature flags
  const filteredSections = useFilteredNavigation(
    navSections,
    effectiveRoles,
    enabledFeatureFlags,
  );

  // Filtered quick actions based on RBAC
  const permittedQuickActions = useFilteredQuickActions(
    quickActions,
    effectiveRoles,
  );

  // Route selection handler
  const handleRouteSelect = useRouteSelection({
    onRouteSelect,
    layout: resolvedLayout,
    closeDrawer,
    analytics,
  });

  // Keyboard shortcut for command palette
  useCommandPaletteShortcut(onOpenCommandPalette);

  // Analytics view tracking
  useShellViewTracking(
    resolvedLayout,
    accountContext,
    filteredSections.length,
    loading,
    analytics,
  );

  const handleQuickAction = useCallback(
    (actionId: string) => {
      analytics?.onQuickAction?.({ actionId });
    },
    [analytics],
  );

  // The identity block navigates, so it owes the drawer the same contract a
  // rail item does (see useRouteSelection): navigating from inside the mobile
  // drawer must close it, or the user lands on the new route behind an open
  // drawer. This is LIVE, not belt-and-braces: the drawer's AccountSummary
  // header takes the same href/press, and since the dashboard left the nav it
  // is mobile's only way home.
  const handleRailIdentityPress = useCallback(() => {
    if (!onRailIdentityPress) return;
    onRailIdentityPress();
    if (resolvedLayout === "mobile") {
      closeDrawer();
    }
  }, [closeDrawer, onRailIdentityPress, resolvedLayout]);

  // `BackRow` calls `back.onPress()` DIRECTLY rather than going through
  // `onSelect` — and `onSelect` (handleRouteSelect) is the only path that
  // closes the drawer on mobile. So tapping "← All events" inside the drawer
  // navigated and left the drawer sitting open over the new route. The rail
  // proper is never mounted on mobile, so this wrapper is only needed for the
  // drawer's copy; the rail keeps the raw `railBack`.
  const drawerBack = useMemo<NavigationRailBack | undefined>(() => {
    if (!railBack) return undefined;
    return {
      ...railBack,
      onPress: () => {
        railBack.onPress();
        closeDrawer();
      },
    };
  }, [railBack, closeDrawer]);

  const emitAlertSelection = useCallback(
    (source: "secondary" | "drawer") => {
      analytics?.onRouteSelect?.({
        routeId: "alerts",
        meta: { source },
      });
      onAlertSelect?.();
    },
    [analytics, onAlertSelect],
  );

  // PART 2 (compact rail): "collapsed" is a MODE of the rail (72px icon
  // rail), not its absence — `railContent` already passes
  // `collapsed={railState === "collapsed"}` down to NavigationRail. Only the
  // mobile layout renders no rail (it has the drawer + bottom bar instead),
  // so there is no viewport ≥960 where admin navigation is invisible.
  const railVisible = resolvedLayout !== "mobile";
  const showRailToggle =
    (resolvedLayout === "desktop" || resolvedLayout === "compact") &&
    railBehavior === "auto";

  const contextValue = useMemo(
    () => ({
      layout: resolvedLayout,
      railState,
      setRailState,
      drawerOpen,
      setDrawerOpen,
      accountContext,
      appearance,
    }),
    [
      accountContext,
      appearance,
      drawerOpen,
      railState,
      resolvedLayout,
      setDrawerOpen,
      setRailState,
    ],
  );

  const removeContentPadding = contentVariant === "edge";
  // NOTE: the space scale ends at $7 (48px) — "$10" was an unregistered
  // token that resolved to 0, hiding end-of-page content behind the fixed
  // bottom bar. 96px clears the bar (~71px, up to ~93px with the iOS web
  // safe-area inset) plus breathing room.
  const shellPaddingBottom = resolvedLayout === "mobile" ? 96 : "$5";
  const showBottomNav =
    resolvedLayout === "mobile" && filteredSections.length > 0;
  // The mobile top bar carries only the workspace switcher + notifications;
  // the drawer is normally reached through the bottom bar's MORE tab. The
  // hamburger survives ONLY while no other entry point exists: no bottom bar
  // at all, or a bottom bar too small to grow a MORE tab (≤ maxItems visible
  // items). Web has no edge-swipe, so without this the drawer — and
  // everything that lives only there — would be unreachable.
  //
  // COUPLING: both sides omit `maxItems`, so both use
  // BOTTOM_BAR_DEFAULT_MAX_ITEMS. If a `maxItems` passthrough is ever added
  // to this shell it MUST be forwarded to BOTH, or the hamburger/MORE
  // handoff desyncs and the drawer goes unreachable. `hasDrawer` mirrors the
  // `onOpenDrawer={openDrawer}` we hand <NavigationBottomBar> below — it is
  // unconditional today, and if it ever stops being so this must follow it.
  const drawerReachableFromBottomBar = useMemo(
    () =>
      showBottomNav && bottomBarShowsMore(filteredSections, { hasDrawer: true }),
    [showBottomNav, filteredSections],
  );
  const gestureEnabled = !isWebPlatform();

  const drawerEdgeGesture = useMemo(() => {
    if (!gestureEnabled || drawerOpen || resolvedLayout !== "mobile") {
      return Gesture.Pan().enabled(false);
    }

    return Gesture.Pan()
      .maxPointers(1)
      .activeOffsetX([-5, 5])
      .onUpdate((event) => {
        if (event.translationX > EDGE_SWIPE_THRESHOLD) {
          runOnJS(openDrawer)();
        }
      });
  }, [gestureEnabled, drawerOpen, resolvedLayout, openDrawer]);

  const railContent = loading ? (
    <RailSkeleton collapsed={railState === "collapsed"} showDivider />
  ) : (
    <NavigationRail
      sections={filteredSections}
      currentRoute={currentRoute}
      collapsed={railState === "collapsed"}
      layout={resolvedLayout}
      onSelect={handleRouteSelect}
      variant="rail"
      testIdBase={`${testIdBase}-rail`}
      emptyState={emptyState ?? <DefaultEmptyState />}
      configControls={externalConfigControls}
      showDivider
      collapsibleSections={collapsibleSections}
      sectionCollapsePersistKey={sectionCollapsePersistKey}
      identity={
        showRailIdentity
          ? {
              label: accountContext.label,
              // `roleLabel` first — the rail identity block is newly enabled
              // on the platform console, whose actor is staff rather than an
              // org member (see `AccountContext.roleLabel`); without it this
              // renders the raw org role "ADMIN".
              sublabel:
                accountContext.roleLabel ??
                accountContext.role ??
                accountContext.type,
              ...(railIdentityHref ? { href: railIdentityHref } : {}),
              ...(onRailIdentityPress
                ? { onPress: handleRailIdentityPress }
                : {}),
              ...(railIdentityLabel ? { actionLabel: railIdentityLabel } : {}),
            }
          : undefined
      }
      back={railBack}
      contextHeader={railContextHeader}
    />
  );

  const shellBody = (
    <>
      <ShellFrame data-testid={testIdBase}>
        {isWebPlatform() ? (
          <SkipLink asChild>
            <a href={`#${contentId}`}>{skipToContentLabel}</a>
          </SkipLink>
        ) : null}
        <TopBarContainer>
          <TopBarInner>
            <NavigationNavbar
              layout={resolvedLayout}
              brand={brand}
              onBrandPress={onBrandPress}
              environmentBadge={environmentBadge}
              quickActions={permittedQuickActions}
              alerts={alerts}
              onAlertSelect={
                alerts?.length
                  ? () => emitAlertSelection("secondary")
                  : undefined
              }
              onQuickActionSelect={handleQuickAction}
              onOpenCommandPalette={onOpenCommandPalette}
              onInviteTeammate={onInviteTeammate}
              onToggleDrawer={
                resolvedLayout === "mobile" && !drawerReachableFromBottomBar
                  ? toggleDrawer
                  : undefined
              }
              drawerOpen={drawerOpen}
              onToggleRail={showRailToggle ? toggleRail : undefined}
              railState={railState}
              showRailToggle={showRailToggle}
              accountContext={accountContext}
              availableContexts={availableContexts}
              onContextSelect={handleContextSwitch}
              onCreateOrganization={onCreateOrganization}
              contextSwitchingId={contextSwitchingId}
              onReturnToConsumer={onReturnToConsumer}
              returnToConsumerLabel={returnToConsumerLabel}
              returnToConsumerDescription={returnToConsumerDescription}
              secondaryNav={secondaryNav}
              loading={loading}
              testIdBase={`${testIdBase}-top-bar`}
              appearance={appearance}
              trailingSlot={
                typeof navbarTrailingSlot === "function"
                  ? navbarTrailingSlot(resolvedLayout)
                  : navbarTrailingSlot
              }
              searchAccessory={navbarSearchSlot}
              contextHrefBuilder={contextHrefBuilder}
              contentMaxWidth={navbarContentMaxWidth}
            />
          </TopBarInner>
        </TopBarContainer>
        <ShellLayoutRow
          paddingBottom={shellPaddingBottom}
          {...(removeContentPadding ? { paddingHorizontal: 0, gap: 0 } : {})}
        >
          {railVisible ? railContent : null}
          <ContentArea
            id={contentId}
            role={isWebPlatform() ? "main" : undefined}
            paddingVertical={removeContentPadding ? 0 : "$5"}
            paddingHorizontal={removeContentPadding ? 0 : "$5"}
            gap={removeContentPadding ? 0 : "$4"}
            {...(removeContentPadding ? { marginTop: 0, borderRadius: 0 } : {})}
          >
            {children}
          </ContentArea>
        </ShellLayoutRow>
        {showBottomNav ? (
          <NavigationBottomBar
            sections={filteredSections}
            currentRoute={currentRoute}
            onSelect={handleRouteSelect}
            onOpenDrawer={openDrawer}
            testIdBase={`${testIdBase}-bottom-nav`}
            centerAction={bottomBarCenterAction}
          />
        ) : null}
        {gestureEnabled && resolvedLayout === "mobile" ? (
          <GestureDetector gesture={drawerEdgeGesture}>
            <EdgeSwipeZone
              pointerEvents="auto"
              testID={`${testIdBase}-edge-swipe`}
              data-testid={`${testIdBase}-edge-swipe`}
            />
          </GestureDetector>
        ) : null}
      </ShellFrame>
      {resolvedLayout === "mobile" ? (
        <NavigationShellDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          sections={filteredSections}
          currentRoute={currentRoute}
          onSelect={handleRouteSelect}
          accountContext={accountContext}
          quickActions={permittedQuickActions}
          onQuickActionSelect={handleQuickAction}
          quickActionFooter={quickActionFooter}
          alerts={alerts}
          onAlertSelect={
            alerts?.length ? () => emitAlertSelection("drawer") : undefined
          }
          emptyState={emptyState ?? <DefaultEmptyState />}
          testIdBase={`${testIdBase}-drawer`}
          collapsibleSections={collapsibleSections}
          sectionCollapsePersistKey={sectionCollapsePersistKey}
          back={drawerBack}
          identityHref={railIdentityHref}
          onIdentityPress={
            onRailIdentityPress ? handleRailIdentityPress : undefined
          }
          identityLabel={railIdentityLabel}
          contextHeader={railContextHeader}
        />
      ) : null}
    </>
  );

  return (
    <NavigationShellProvider value={contextValue}>
      {/*
       * Web: do NOT re-pin the theme. Render the shell body directly so the
       * root AppThemeProvider's `<Theme name={stub|ember}>` (driven by the
       * navbar light/dark toggle) flows through unchanged — otherwise the
       * toggle would be dead on every admin/dashboard/builder surface.
       *
       * Native (mobile / scanner): keep the exact prior behaviour — wrap in
       * `<Theme name={appearance}>` where `appearance` is always "ember".
       */}
      {isWebPlatform() ? (
        shellBody
      ) : (
        <Theme name={appearance}>{shellBody}</Theme>
      )}
    </NavigationShellProvider>
  );
};

NavigationShell.displayName = "NavigationShell";

export type { NavigationShellProps };
