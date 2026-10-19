"use client";

import { ArrowLeft, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useId, useMemo, type MouseEvent } from "react";
import { Platform } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { Theme, YStack } from "tamagui";

import { Text } from "../tamagui/components";
import { NavigationShellDrawer } from "./components/NavigationDrawer";
import { NavigationRail } from "./components/NavigationRail";
import {
  Button,
  NavbarMenuButton,
  NavigationBottomBar,
  NotificationButton,
  WorkspaceSwitcher,
  bottomBarShowsMore,
} from "../tamagui/components";
import { NavigationShellProvider } from "./NavigationShellContext";
import type { AdminLedgerShellProps } from "./AdminLedgerShell.types";
import type { NavigationRailBack } from "./NavigationShell.types";

import {
  ShellFrame,
  EdgeSwipeZone,
  ShellLayoutRow,
  ContentArea,
  RegisterStack,
  SkipLink,
  RailSkeletonFrame,
  SkeletonBlock,
  CompactRailSkeletonFrame,
  TopbarBack,
  SwitcherClamp,
} from "./AdminLedgerShell.styles";

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

import { LedgerContextStrip, LedgerSectionTabs, LedgerTopbar } from "./ledger";
import { usePublishAdminBottomNavHeight } from "./utils/admin-bottom-nav-height";

const isWebPlatform = () => Platform.OS === "web";

const DEFAULT_DRAWER_BREAKPOINT = 960;
const EDGE_SWIPE_THRESHOLD = 40;
const DEFAULT_SECTION_TABS_LABEL = "Sections";

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

const RailSkeleton = ({ collapsed }: { collapsed: boolean }) => {
  const FrameComponent = collapsed
    ? CompactRailSkeletonFrame
    : RailSkeletonFrame;
  return (
    <FrameComponent aria-hidden>
      <SkeletonBlock width="100%" />
      <SkeletonBlock width="80%" />
      <SkeletonBlock width="60%" />
      <SkeletonBlock width="100%" />
      <SkeletonBlock width="70%" />
    </FrameComponent>
  );
};

/** Same glyph + hit box as NavigationNavbar's (unexported) CollapseButton. */
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

/**
 * Back affordance for the topbar `left` slot. Same contract as the rail's
 * BackRow: a real `<a>` when `href` is given (modifier-clicks fall through
 * to the browser), a `<button>` otherwise.
 */
const TopbarBackAffordance = ({
  back,
  iconOnly,
  testIdBase,
}: {
  back: NavigationRailBack;
  iconOnly: boolean;
  testIdBase: string;
}) => (
  <TopbarBack
    aria-label={iconOnly && isWebPlatform() ? back.label : undefined}
    data-testid={`${testIdBase}-back`}
    {...(isWebPlatform() && back.href
      ? {
          tag: "a" as const,
          href: back.href,
          role: "link" as const,
          style: { textDecoration: "none" } as const,
          onClick: (e: MouseEvent<HTMLAnchorElement>) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            back.onPress();
          },
        }
      : {
          onPress: back.onPress,
          ...(isWebPlatform()
            ? { tag: "button" as const, type: "button" as const }
            : {}),
        })}
  >
    <ArrowLeft size={14} strokeWidth={2} aria-hidden />
    {iconOnly ? null : (
      <Text variant="overline" tone="muted" whiteSpace="nowrap">
        {back.label}
      </Text>
    )}
  </TopbarBack>
);

export const AdminLedgerShell = ({
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
  onOpenCommandPalette,
  railBehavior = "auto",
  drawerBreakpoint = DEFAULT_DRAWER_BREAKPOINT,
  analytics,
  loading = false,
  testIdBase = "admin-ledger-shell",
  brand,
  children,
  emptyState,
  quickActionFooter,
  enabledFeatureFlags,
  forceLayout,
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
  bottomBarCenterAction,
  navbarTrailingSlot,
  navbarSearchSlot,
  navbarContentMaxWidth = 1400,
  contextHrefBuilder,
  surfaceRole,
  sectionTabs,
  sectionTabsLabel = DEFAULT_SECTION_TABS_LABEL,
  sectionTabsCurrent,
  onSectionTabSelect,
  sectionTabsOverflow,
  contextItems,
  contextRight,
}: AdminLedgerShellProps) => {
  const contentId = useId();

  const resolvedLayout = useShellLayout(drawerBreakpoint, forceLayout);

  const { drawerOpen, setDrawerOpen, toggleDrawer, openDrawer, closeDrawer } =
    useDrawerState();

  const { railState, setRailState, toggleRail } = useRailState({
    behavior: railBehavior,
    layout: resolvedLayout,
    analytics,
  });

  const { appearance } = useAppearance();

  const { contextSwitchingId, handleContextSwitch } = useContextSwitch({
    accountContext,
    onContextSwitch,
    analytics,
  });

  const effectiveRoles = useMemo(
    () =>
      accountContext.roles ??
      (accountContext.role ? [accountContext.role] : []),
    [accountContext.roles, accountContext.role],
  );

  const filteredSections = useFilteredNavigation(
    navSections,
    effectiveRoles,
    enabledFeatureFlags,
  );

  const permittedQuickActions = useFilteredQuickActions(
    quickActions,
    effectiveRoles,
  );

  const handleRouteSelect = useRouteSelection({
    onRouteSelect,
    layout: resolvedLayout,
    closeDrawer,
    analytics,
  });

  useCommandPaletteShortcut(onOpenCommandPalette);

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

  const handleRailIdentityPress = useCallback(() => {
    if (!onRailIdentityPress) return;
    onRailIdentityPress();
    if (resolvedLayout === "mobile") {
      closeDrawer();
    }
  }, [closeDrawer, onRailIdentityPress, resolvedLayout]);

  // `BackRow` calls `back.onPress()` DIRECTLY rather than through `onSelect`,
  // and `onSelect` (handleRouteSelect) is the only path that closes the drawer
  // on mobile — so tapping "← All events" inside the drawer navigated and left
  // the drawer open over the new route. The rail is never mounted on mobile,
  // so only the drawer's copy needs wrapping.
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

  // "collapsed" is a MODE of the rail (72px icon rail), not its absence —
  // only the mobile layout renders no rail (drawer + bottom bar instead).
  const railVisible = resolvedLayout !== "mobile";
  const showRailToggle =
    (resolvedLayout === "desktop" || resolvedLayout === "compact") &&
    railBehavior === "auto";
  const isMobile = resolvedLayout === "mobile";

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

  // The space scale ends at $7 (48px); 96px clears the fixed bottom bar
  // (~71px, up to ~93px with the iOS safe-area inset) plus breathing room.
  const shellPaddingBottom = isMobile ? 96 : "$5";
  const showBottomNav = isMobile && filteredSections.length > 0;
  // Pages that dock a bar at the bottom of the viewport sit above this nav
  // by reading its measured height (`--admin-bottom-nav-height`).
  usePublishAdminBottomNavHeight(showBottomNav, `${testIdBase}-bottom-nav`);
  // Same hamburger rule as NavigationShell: it survives ONLY while no other
  // drawer entry point exists (no bottom bar, or one too small for MORE).
  const drawerReachableFromBottomBar = useMemo(
    () =>
      showBottomNav &&
      bottomBarShowsMore(filteredSections, { hasDrawer: true }),
    [showBottomNav, filteredSections],
  );
  const gestureEnabled = !isWebPlatform();

  const drawerEdgeGesture = useMemo(() => {
    if (!gestureEnabled || drawerOpen || !isMobile) {
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
  }, [gestureEnabled, drawerOpen, isMobile, openDrawer]);

  const railContent = loading ? (
    <RailSkeleton collapsed={railState === "collapsed"} />
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
              // `roleLabel` first, matching NavigationShell's rail identity
              // and the drawer's account header — a console whose actor is
              // not an org member should not be labelled with an org role.
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
      // `railBack` MOVES to the topbar `left` slot (R9) — it is not copied.
      // Rendering it here too would put two links with one accessible name
      // on the page (strict-mode locators, double SR announcement). The
      // mobile drawer below still carries it: the topbar affordance is
      // icon-only there and the drawer owns the labelled one.
      back={undefined}
      contextHeader={railContextHeader}
    />
  );

  // ── Register 1 slots ────────────────────────────────────────────────
  // Hamburger: same rule as NavigationShell — one drawer entry point at a
  // time. When the bottom bar grows a MORE tab (>4 visible items) that tab
  // opens the drawer and the hamburger is withheld; otherwise the hamburger
  // is it. (A 2026-08-26 browser run briefly rendered both; reverted the
  // same day so the ledger shell does not silently reverse that decision.)
  const menuButton =
    isMobile && !drawerReachableFromBottomBar ? (
      <NavbarMenuButton
        open={drawerOpen}
        buttonSize="$4"
        onToggle={toggleDrawer}
        accessibilityLabel="Toggle navigation drawer"
      />
    ) : null;

  const topbarLeft =
    menuButton || railBack ? (
      <>
        {menuButton}
        {railBack ? (
          <TopbarBackAffordance
            back={railBack}
            iconOnly={isMobile}
            testIdBase={`${testIdBase}-top-bar`}
          />
        ) : null}
      </>
    ) : undefined;

  const alertCount =
    alerts?.reduce((total, alert) => total + (alert.count ?? 0), 0) ?? 0;

  const trailingSlot =
    typeof navbarTrailingSlot === "function"
      ? navbarTrailingSlot(resolvedLayout)
      : navbarTrailingSlot;

  // Search gets the topbar's own flexible slot rather than riding at the head
  // of the right cluster: that cluster is shrink-to-fit, so the trigger's
  // `flex: 1` had no free space to claim and it rendered at ~195px with a
  // ~440px hole beside it at 1440.
  // The mobile top bar stays sparse: no search, the switcher is the identity
  // anchor and the consumer's `navbarTrailingSlot("mobile")` is expected to
  // be a single control.
  const topbarSearch = !isMobile ? navbarSearchSlot : null;

  // Same order NavigationNavbar composes its trailing controls: rail toggle,
  // alerts, consumer trailing slot, then the workspace switcher last.
  const topbarRight = (
    <>
      {showRailToggle ? (
        <CollapseButton railState={railState} onToggle={toggleRail} />
      ) : null}
      {alerts?.length ? (
        <NotificationButton
          aria-label="View alerts"
          count={alertCount}
          onPress={() => emitAlertSelection("secondary")}
        />
      ) : null}
      {trailingSlot}
      {/* The switcher is the widest thing in this right-pinned cluster, so it
          needs a box that yields when the row tightens. The clamp is that
          box, and its bound is `minWidth: 0` + `flexShrink: 1` — a SHRINK
          pair, never a clip.

          It used to carry `overflow: hidden` as well. Do not put that back:
          the switcher's popover is `position: absolute` inside this subtree,
          so the clip cropped the whole dropdown to the height of the top bar
          and shipped a one-row sliver to production. Full mechanism, and the
          Chrome measurements behind every number, on `SwitcherClamp` in
          ./AdminLedgerShell.styles.ts. */}
      <SwitcherClamp data-testid={`${testIdBase}-top-bar-switcher`}>
        <WorkspaceSwitcher
          layout={resolvedLayout}
          accountContext={accountContext}
          availableContexts={availableContexts}
          onContextSelect={handleContextSwitch}
          onCreateOrganization={onCreateOrganization}
          contextSwitchingId={contextSwitchingId}
          onReturnToConsumer={onReturnToConsumer}
          returnToConsumerLabel={returnToConsumerLabel}
          returnToConsumerDescription={returnToConsumerDescription}
          contextHrefBuilder={contextHrefBuilder}
          testIdBase={`${testIdBase}-top-bar`}
        />
      </SwitcherClamp>
    </>
  );

  const hasSectionTabs = Boolean(sectionTabs?.length);
  const hasContext = Boolean(contextItems?.length) || Boolean(contextRight);

  const shellBody = (
    <>
      <ShellFrame data-testid={testIdBase}>
        {isWebPlatform() ? (
          <SkipLink asChild>
            <a href={`#${contentId}`}>{skipToContentLabel}</a>
          </SkipLink>
        ) : null}
        <RegisterStack>
          <LedgerTopbar
            // Mirrors NavigationNavbar: the MOBILE top bar drops the brand
            // lockup and the role chip — the workspace switcher (full name +
            // mark) is the identity anchor there. `null` (not `undefined`)
            // so the topbar does not fall back to its default wordmark.
            brand={isMobile ? null : brand}
            surfaceRole={isMobile ? undefined : surfaceRole}
            compact={isMobile}
            left={topbarLeft}
            search={topbarSearch}
            right={topbarRight}
            contentMaxWidth={navbarContentMaxWidth}
            testIdBase={`${testIdBase}-top-bar`}
          />
          {hasSectionTabs ? (
            <LedgerSectionTabs
              items={sectionTabs ?? []}
              current={sectionTabsCurrent}
              label={sectionTabsLabel}
              onSelect={onSectionTabSelect}
              overflow={sectionTabsOverflow}
              contentMaxWidth={navbarContentMaxWidth}
              testIdBase={`${testIdBase}-sections`}
            />
          ) : null}
          {hasContext ? (
            <LedgerContextStrip
              items={contextItems}
              right={contextRight}
              contentMaxWidth={navbarContentMaxWidth}
              testIdBase={`${testIdBase}-context`}
            />
          ) : null}
        </RegisterStack>
        <ShellLayoutRow paddingBottom={shellPaddingBottom}>
          {railVisible ? railContent : null}
          {/* Never pass `overflow` here — ContentArea must stay `visible`
              (R1); see the comment on the styled component. */}
          <ContentArea
            id={contentId}
            role={isWebPlatform() ? "main" : undefined}
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
        {gestureEnabled && isMobile ? (
          <GestureDetector gesture={drawerEdgeGesture}>
            <EdgeSwipeZone
              pointerEvents="auto"
              testID={`${testIdBase}-edge-swipe`}
              data-testid={`${testIdBase}-edge-swipe`}
            />
          </GestureDetector>
        ) : null}
      </ShellFrame>
      {isMobile ? (
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
          // The dashboard is no longer a nav item, and the rail is not mounted
          // on mobile — so the drawer's account header is the ONLY way home.
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

AdminLedgerShell.displayName = "AdminLedgerShell";

export type { AdminLedgerShellProps };
