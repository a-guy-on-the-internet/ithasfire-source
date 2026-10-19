"use client";

import { useMemo, type MouseEvent, type ReactNode } from "react";
import { Platform } from "react-native";
import { XStack, YStack, styled } from "tamagui";

import {
  Avatar,
  Button,
  ListItem,
  ListItemGroup,
  NavigationDrawer as BaseDrawer,
  Text,
} from "../../tamagui/components";

import { NavigationRail } from "./NavigationRail";
import type {
  AccountContext,
  AlertSummary,
  NavigationRailBack,
  NavigationSection,
  NavigationShellLayout,
  QuickActionConfig,
  RouteMeta,
} from "../NavigationShell.types";

const DrawerContent = styled(YStack, {
  name: "NavigationShellDrawerContent",
  gap: "$4",
});

const QuickActionList = styled(YStack, {
  name: "NavigationShellDrawerQuickActions",
  gap: "$2",
});

const AlertsStack = styled(YStack, {
  name: "NavigationShellDrawerAlerts",
  gap: "$2",
});

const isWeb = Platform.OS === "web";

/**
 * Interactive form of the drawer's account header, mirroring the rail's
 * identity block. The dashboard is no longer a nav item, so on mobile — where
 * the rail is never mounted and the drawer renders this header instead — this
 * is the ONLY way home. Inert (exactly as before) when no href/onPress is
 * supplied, so other consumers are untouched.
 */
const AccountSummaryRow = styled(XStack, {
  name: "NavigationShellDrawerAccountSummary",
  alignItems: "center",
  gap: "$3",
  width: "100%",
  // ≥44px tap target (design-system floor); the avatar alone is 32px.
  minHeight: 44,
  cursor: "pointer",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },
});

const AccountSummary = ({
  context,
  href,
  onPress,
  actionLabel,
}: {
  context: AccountContext;
  href?: string;
  onPress?: () => void;
  actionLabel?: string;
}) => {
  const initials = context.label
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const content = (
    <>
      <Avatar
        size="sm"
        src={context.avatarUrl}
        initials={initials}
        alt={context.label}
      />
      <YStack flexShrink={1} minWidth={0}>
        <Text variant="body" weight="bold">
          {context.label}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {/* See NavigationShell's rail identity block — `roleLabel` first so
              a staff console isn't labelled with an org role. */}
          {context.roleLabel ?? context.role ?? context.type}
        </Text>
      </YStack>
    </>
  );

  // `href` is web-only (native has no anchors) — gate it so a native consumer
  // passing only an href doesn't get an inert, unlabelled row.
  const resolvedHref = isWeb ? href : undefined;
  if (!resolvedHref && !onPress) {
    return (
      <XStack alignItems="center" gap="$3">
        {content}
      </XStack>
    );
  }

  return (
    <AccountSummaryRow
      data-testid={isWeb ? "nav-shell-drawer-identity" : undefined}
      testID={isWeb ? undefined : "nav-shell-drawer-identity"}
      {...(isWeb
        ? { "aria-label": actionLabel }
        : {
            accessibilityRole: "button" as const,
            accessibilityLabel: actionLabel ?? context.label,
          })}
      {...(resolvedHref
        ? {
            // Anchor path carries ONLY onClick — wiring onPress too would
            // double-fire (XStack attaches both). Mirrors NavigationRail.
            tag: "a" as const,
            href: resolvedHref,
            role: "link" as const,
            style: { textDecoration: "none" } as const,
            onClick: (e: MouseEvent<HTMLAnchorElement>) => {
              // Modifier-clicks open in a new tab natively.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              if (!onPress) return;
              e.preventDefault();
              onPress();
            },
          }
        : {
            onPress,
            ...(isWeb ? { tag: "button" as const, type: "button" as const } : {}),
          })}
    >
      {content}
    </AccountSummaryRow>
  );
};

export interface NavigationShellDrawerProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  sections: NavigationSection[];
  currentRoute: string;
  onSelect: (route: string, meta: RouteMeta) => void;
  accountContext: AccountContext;
  quickActions?: QuickActionConfig[];
  onQuickActionSelect?: (actionId: string) => void;
  quickActionFooter?: ReactNode;
  alerts?: AlertSummary[];
  onAlertSelect?: () => void;
  emptyState?: ReactNode;
  testIdBase?: string;
  /** See NavigationShellProps — threaded through to the embedded rail. */
  collapsibleSections?: boolean;
  sectionCollapsePersistKey?: string;
  back?: NavigationRailBack;
  /** Workspace-home link for the account header (see AccountSummary). */
  identityHref?: string;
  onIdentityPress?: () => void;
  identityLabel?: string;
  contextHeader?: ReactNode;
}

export const NavigationShellDrawer = ({
  open,
  onOpenChange,
  sections,
  currentRoute,
  onSelect,
  accountContext,
  quickActions,
  onQuickActionSelect,
  quickActionFooter,
  alerts,
  onAlertSelect,
  emptyState,
  testIdBase = "navigation-shell-drawer",
  collapsibleSections = false,
  sectionCollapsePersistKey,
  back,
  identityHref,
  onIdentityPress,
  identityLabel,
  contextHeader,
}: NavigationShellDrawerProps) => {
  const visibleQuickActions = quickActions ?? [];
  const drawerAlerts = alerts ?? [];

  const quickActionButtons = useMemo(
    () =>
      visibleQuickActions.map((action) => (
        <Button
          key={action.id}
          variant="secondary"
          onPress={() => {
            void action.onSelect?.();
            onQuickActionSelect?.(action.id);
          }}
          disabled={action.disabled}
        >
          <XStack gap="$2" alignItems="center" justifyContent="center">
            {action.icon ?? null}
            <Text tone="inherit" variant="body" weight="bold">
              {action.label}
            </Text>
          </XStack>
        </Button>
      )),
    [onQuickActionSelect, visibleQuickActions],
  );

  return (
    <BaseDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Navigation"
      description={accountContext.label}
      testIdBase={testIdBase}
      // Pinned at the drawer's bottom edge, OUTSIDE the scrollable nav body —
      // the footer (e.g. AdminShell's Preferences block: theme + language)
      // must stay visible and operable regardless of how far the nav
      // overflows.
      footer={quickActionFooter ? <YStack>{quickActionFooter}</YStack> : undefined}
    >
      <DrawerContent>
        <AccountSummary
          context={accountContext}
          href={identityHref}
          onPress={onIdentityPress}
          actionLabel={identityLabel}
        />
        {quickActionButtons.length ? (
          <QuickActionList>{quickActionButtons}</QuickActionList>
        ) : null}
        {drawerAlerts.length ? (
          <AlertsStack>
            <Text variant="bodySmall" tone="muted">
              Alerts
            </Text>
            <ListItemGroup>
              {drawerAlerts.map((alert) => (
                <ListItem
                  key={alert.id}
                  title={alert.label}
                  subtitle={alert.count ? `${alert.count} unread` : undefined}
                  onPress={alert.onSelect ?? onAlertSelect}
                />
              ))}
            </ListItemGroup>
          </AlertsStack>
        ) : null}
        <NavigationRail
          sections={sections}
          currentRoute={currentRoute}
          collapsed={false}
          layout={"mobile" as NavigationShellLayout}
          variant="drawer"
          onSelect={onSelect}
          emptyState={emptyState}
          collapsibleSections={collapsibleSections}
          sectionCollapsePersistKey={sectionCollapsePersistKey}
          back={back}
          contextHeader={contextHeader}
        />
      </DrawerContent>
    </BaseDrawer>
  );
};

NavigationShellDrawer.displayName = "NavigationShellDrawer";
