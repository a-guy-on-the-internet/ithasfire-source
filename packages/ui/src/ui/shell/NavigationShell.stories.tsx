import type { Meta, StoryObj } from "@storybook/react";
import { action } from "@storybook/addon-actions";
import { useState } from "react";
import { CalendarPlus, MessageCircle, Plus } from "lucide-react";
import { XStack, YStack } from "tamagui";

import { Button, NavigationNavbar, Text } from "../tamagui/components";
import type {
  AccountContext,
  AlertSummary,
  NavigationSection,
  QuickActionConfig,
} from "./NavigationShell.types";
import { NavigationShell } from "./NavigationShell";

const meta: Meta<typeof NavigationShell> = {
  title: "Ui/Shell/Navigation Shell",
  component: NavigationShell,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

const navSections: NavigationSection[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      {
        id: "home",
        label: "Home",
        route: "/overview",
        icon: <CalendarPlus size={16} />,
      },
      { id: "activity", label: "Activity", route: "/overview/activity" },
    ],
  },
  {
    id: "ops",
    label: "Operations",
    featureFlag: "ops",
    items: [
      { id: "events", label: "Events", route: "/events", badgeCount: 4 },
      { id: "orders", label: "Orders", route: "/orders" },
      {
        id: "financials",
        label: "Financials",
        route: "/financials",
        children: [
          { id: "payouts", label: "Payouts", route: "/financials/payouts" },
          { id: "fees", label: "Fees", route: "/financials/fees" },
        ],
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      { id: "team", label: "Team", route: "/settings/team" },
      {
        id: "billing",
        label: "Billing",
        route: "/settings/billing",
        tone: "danger",
      },
    ],
  },
];

// Deliberately mixed: two types (the switcher groups them into PERSONAL /
// GROUPS) plus one pathologically long name to exercise row truncation.
const accountContexts: AccountContext[] = [
  {
    id: "org",
    label: "Acme Organizers",
    type: "org",
    role: "ADMIN",
    avatarUrl: "https://i.pravatar.cc/64?img=15",
  },
  {
    id: "city-lights",
    label: "City Lights Presents",
    type: "org",
    role: "EDITOR",
    avatarUrl: "https://i.pravatar.cc/64?img=32",
  },
  {
    id: "chicago-underground",
    label: "Chicago Underground Collective",
    type: "org",
    role: "VIEWER",
  },
  { id: "personal", label: "Danielle Rivers", type: "personal" },
];

/**
 * Above the six-workspace threshold the switcher grows a filter field and the
 * list region starts scrolling at its maxHeight.
 */
const manyAccountContexts: AccountContext[] = [
  ...accountContexts,
  {
    id: "north-hall",
    label: "North Hall Bookings",
    type: "org",
    role: "EDITOR",
  },
  {
    id: "riverside",
    label: "Riverside Sessions",
    type: "org",
    role: "FINANCE",
  },
  { id: "the-annex", label: "The Annex", type: "org", role: "SCANNER" },
  {
    id: "westside",
    label: "Westside Music Co-op",
    type: "org",
    role: "VIEWER",
  },
];

const quickActions: QuickActionConfig[] = [
  {
    id: "create-event",
    label: "Create event",
    icon: <Plus size={16} />,
    onSelect: () => action("quick-action")("create-event"),
  },
  {
    id: "open-support",
    label: "Support",
    icon: <MessageCircle size={16} />,
    onSelect: () => action("quick-action")("open-support"),
  },
];

const alerts: AlertSummary[] = [
  { id: "compliance", label: "Compliance review", count: 1 },
  { id: "payout", label: "Payout pending", count: 2 },
];

const secondaryNav = (
  <XStack gap="$2">
    <Button
      size="$2"
      variant="ghost"
      onPress={action("secondary-nav-overview")}
    >
      Overview
    </Button>
    <Button size="$2" variant="ghost" onPress={action("secondary-nav-sales")}>
      Sales
    </Button>
    <Button
      size="$2"
      variant="ghost"
      onPress={action("secondary-nav-performance")}
    >
      Performance
    </Button>
  </XStack>
);

const sampleContent = (
  <YStack gap="$5">
    <YStack gap="$2">
      <Text variant="h4" weight="bold">
        Events overview
      </Text>
      <Text variant="body" tone="muted">
        Track the pulse of upcoming shows, payouts, and on-sale performance.
      </Text>
    </YStack>
    <XStack gap="$3" flexWrap="wrap">
      <Button variant="primary" onPress={action("content-create-event")}>
        Create event
      </Button>
      <Button variant="secondary" onPress={action("content-invite-team")}>
        Invite teammate
      </Button>
    </XStack>
    <XStack gap="$3" flexWrap="wrap">
      {[
        { label: "Tickets sold", value: "3,842", delta: "+12% vs last week" },
        { label: "Net payout", value: "$184K", delta: "Deposits in 2 days" },
        {
          label: "Open support",
          value: "6",
          delta: "Most urgent: payout hold",
        },
      ].map((card) => (
        <YStack
          key={card.label}
          flex={1}
          minWidth={220}
          gap="$2"
          borderWidth={1}
          borderColor="$borderColor"
          borderRadius={0}
          padding="$4"
          backgroundColor="$surface"
        >
          <Text variant="bodySmall" tone="muted" weight="bold">
            {card.label}
          </Text>
          <Text variant="h4" weight="bold">
            {card.value}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {card.delta}
          </Text>
        </YStack>
      ))}
    </XStack>
  </YStack>
);

const NavbarStoryPreview = ({
  contexts = accountContexts,
}: {
  contexts?: AccountContext[];
}) => {
  const [railState, setRailState] = useState<"expanded" | "collapsed">(
    "expanded",
  );
  const [contextSwitchingId, setContextSwitchingId] = useState<string | null>(
    null,
  );

  const handleRailToggle = () => {
    const nextState = railState === "expanded" ? "collapsed" : "expanded";
    setRailState(nextState);
    action("navbar-rail-toggle")(nextState);
  };

  const handleContextSelect = async (contextId: string) => {
    setContextSwitchingId(contextId);
    action("navbar-context-select")(contextId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    setContextSwitchingId(null);
  };

  return (
    <YStack
      padding="$4"
      backgroundColor="$surfaceMuted"
      gap="$4"
      minHeight="100vh"
    >
      <Text variant="h5" weight="bold">
        NavigationNavbar preview
      </Text>
      <NavigationNavbar
        layout="desktop"
        brand={
          <Text variant="h5" weight="bold">
            Ithas Fire Portal
          </Text>
        }
        environmentBadge="staging"
        quickActions={quickActions}
        alerts={alerts}
        onAlertSelect={() => action("navbar-alert-select")()}
        onQuickActionSelect={(actionId) =>
          action("navbar-quick-action")(actionId)
        }
        onOpenCommandPalette={() => action("navbar-command-palette")()}
        onInviteTeammate={() => action("navbar-invite-teammate")()}
        onToggleRail={handleRailToggle}
        railState={railState}
        showRailToggle
        accountContext={contexts[0]!}
        availableContexts={contexts}
        onContextSelect={handleContextSelect}
        contextSwitchingId={contextSwitchingId}
        onCreateOrganization={() => action("navbar-create-organization")()}
        onReturnToConsumer={() => action("navbar-return-to-consumer")()}
        returnToConsumerDescription="Browse and buy tickets as yourself"
        contextHrefBuilder={(contextId) => `/admin/${contextId}/dashboard`}
        secondaryNav={secondaryNav}
        appearance="ember"
      />
    </YStack>
  );
};

export const NavbarPreview: Story = {
  render: () => <NavbarStoryPreview />,
  parameters: {
    layout: "fullscreen",
  },
};

/** Workspace switcher above the filter threshold (> 6 selectable contexts). */
export const NavbarWorkspaceSwitcherFiltered: Story = {
  render: () => <NavbarStoryPreview contexts={manyAccountContexts} />,
  parameters: {
    layout: "fullscreen",
  },
};

const baseArgs = {
  navSections,
  currentRoute: "/events",
  accountContext: accountContexts[0],
  availableContexts: accountContexts,
  quickActions,
  alerts,
  secondaryNav,
  onRouteSelect: action("route-select"),
  onContextSwitch: async (contextId: string) => {
    action("context-switch")(contextId);
    await new Promise((resolve) => setTimeout(resolve, 250));
  },
  onOpenCommandPalette: action("command-palette"),
  onInviteTeammate: action("invite-teammate"),
  enabledFeatureFlags: ["ops"],
  brand: (
    <Text variant="h5" weight="bold">
      Ithas Fire Portal
    </Text>
  ),
  quickActionFooter: (
    <Button variant="secondary" onPress={action("drawer-footer-action")}>
      Need help?
    </Button>
  ),
  children: sampleContent,
};

export const Desktop: Story = {
  args: {
    ...baseArgs,
    forceLayout: "desktop",
  },
};

export const Compact: Story = {
  args: {
    ...baseArgs,
    forceLayout: "compact",
  },
};

export const Mobile: Story = {
  args: {
    ...baseArgs,
    forceLayout: "mobile",
  },
};

export const Loading: Story = {
  args: {
    ...baseArgs,
    loading: true,
  },
};

export const PlainContent: Story = {
  args: {
    ...baseArgs,
    forceLayout: "desktop",
    contentVariant: "plain",
  },
};

// ── Event-context rail (back slot + anchor items) ───────────────────────────
// Mirrors the admin event rail: a Build group of externally-controlled
// anchor items (scroll-spy drives `active`) and a Manage group of routes,
// with "← All events" above and the event title + status chip slotted in.

const eventContextSections: NavigationSection[] = [
  {
    id: "event-build",
    label: "Build",
    items: [
      {
        id: "essentials",
        label: "Essentials",
        route: "/admin/acme/events/evt-1/edit?section=essentials",
        active: true,
        hideInBottomBar: true,
      },
      {
        id: "tickets",
        label: "Tickets",
        route: "/admin/acme/events/evt-1/edit?section=tickets",
        active: false,
        hideInBottomBar: true,
      },
      {
        id: "lineup",
        label: "Lineup",
        route: "/admin/acme/events/evt-1/edit?section=lineup",
        active: false,
        hideInBottomBar: true,
      },
    ],
  },
  {
    id: "event-manage",
    label: "Manage",
    items: [
      {
        id: "attendees",
        label: "Attendees",
        route: "/admin/acme/events/evt-1/attendees",
      },
      {
        id: "comp-tickets",
        label: "Comp",
        route: "/admin/acme/events/evt-1/comp-tickets",
        disabled: true,
        note: "post-pub",
      },
    ],
  },
];

export const EventContext: Story = {
  args: {
    ...baseArgs,
    forceLayout: "desktop",
    navSections: eventContextSections,
    currentRoute: "events/evt-1/edit",
    showRailIdentity: true,
    railIdentityHref: "/admin/acme/dashboard",
    railIdentityLabel: "Go to Acme Presents dashboard",
    onRailIdentityPress: () => action("rail-identity")(),
    railBack: {
      label: "All events",
      href: "/admin/acme/events",
      onPress: () => action("rail-back")(),
    },
    railContextHeader: (
      <YStack paddingHorizontal="$4" paddingBottom="$3" gap="$2">
        <Text fontSize={13} weight="bold">
          Warehouse Show
        </Text>
        <Text variant="bodySmall" tone="muted">
          DRAFT
        </Text>
      </YStack>
    ),
  },
};
