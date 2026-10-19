import type { Meta, StoryObj } from "@storybook/react";
import { action } from "@storybook/addon-actions";
import { CalendarPlus } from "lucide-react";
import { YStack } from "tamagui";

import { Button, Text } from "../tamagui/components";
import type {
  AccountContext,
  NavigationSection,
} from "./NavigationShell.types";
import { AdminLedgerShell } from "./AdminLedgerShell";

const meta: Meta<typeof AdminLedgerShell> = {
  title: "Ui/Shell/Admin Ledger Shell",
  component: AdminLedgerShell,
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
        id: "dashboard",
        label: "Dashboard",
        route: "/admin/acme/dashboard",
        icon: <CalendarPlus size={16} />,
      },
      { id: "search", label: "Search", route: "/admin/acme/search" },
    ],
  },
  {
    id: "programming",
    label: "Programming",
    items: [
      {
        id: "events",
        label: "Events",
        route: "/admin/acme/events",
        badgeCount: 4,
      },
      { id: "places", label: "Places", route: "/admin/acme/places" },
      { id: "bookings", label: "Bookings", route: "/admin/acme/bookings" },
    ],
  },
  {
    id: "sales",
    label: "Sales",
    items: [
      { id: "orders", label: "Orders", route: "/admin/acme/orders" },
      { id: "payouts", label: "Payouts", route: "/admin/acme/payouts" },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { id: "team", label: "Team", route: "/admin/acme/team" },
      { id: "settings", label: "Settings", route: "/admin/acme/settings" },
    ],
  },
];

const accountContexts: AccountContext[] = [
  { id: "acme", label: "Acme Organizers", type: "org", role: "ADMIN" },
  {
    id: "city-lights",
    label: "City Lights Presents",
    type: "org",
    role: "EDITOR",
  },
  { id: "personal", label: "Danielle Rivers", type: "personal" },
];

const sectionTabs = [
  { href: "/admin/acme/dashboard", label: "Overview" },
  { href: "/admin/acme/events", label: "Programming", count: 4 },
  { href: "/admin/acme/orders", label: "Sales" },
  { href: "/admin/acme/team", label: "Workspace" },
];

const sampleContent = (
  <YStack gap="$4">
    <Text variant="h4" weight="bold">
      Events
    </Text>
    <Text variant="body" tone="muted">
      Content renders below the three registers, beside the rail.
    </Text>
    <Button variant="primary" onPress={action("create-event")}>
      Create event
    </Button>
  </YStack>
);

const baseArgs = {
  navSections,
  currentRoute: "/admin/acme/events",
  accountContext: accountContexts[0]!,
  availableContexts: accountContexts,
  onRouteSelect: action("route-select"),
  onContextSwitch: async (contextId: string) => {
    action("context-switch")(contextId);
  },
  collapsibleSections: true,
  showRailIdentity: true,
  surfaceRole: "Admin",
  sectionTabs,
  sectionTabsLabel: "Admin sections",
  sectionTabsCurrent: "/admin/acme/events",
  onSectionTabSelect: action("section-select"),
  contextItems: ["Acme Organizers", "3 events this week"],
  contextRight: "Stripe connected",
  navbarContentMaxWidth: 1400,
  children: sampleContent,
};

export const Desktop: Story = {
  args: { ...baseArgs, forceLayout: "desktop" },
};

export const Compact: Story = {
  args: { ...baseArgs, forceLayout: "compact" },
};

/**
 * Mobile drops the brand lockup and the role chip: the workspace switcher is
 * the identity anchor, exactly as NavigationNavbar does it.
 */
export const Mobile: Story = {
  args: { ...baseArgs, forceLayout: "mobile" },
};

/** Nested context: back affordance in the topbar, event facts in register 3. */
export const EventContext: Story = {
  args: {
    ...baseArgs,
    forceLayout: "desktop",
    railBack: {
      label: "All events",
      href: "/admin/acme/events",
      onPress: action("back"),
    },
    railContextHeader: (
      <Text variant="bodySmall" weight="bold">
        Riverfront Sessions
      </Text>
    ),
    sectionTabs: [
      { href: "/admin/acme/events/evt-1/edit", label: "Build" },
      {
        href: "/admin/acme/events/evt-1/attendees",
        label: "Attendees",
        count: 1284,
      },
      { href: "/admin/acme/events/evt-1/orders", label: "Orders" },
    ],
    sectionTabsCurrent: "/admin/acme/events/evt-1/attendees",
    contextItems: ["Aug 15 · Riverfront Park", "Published"],
    contextRight: "1,284 / 1,500 sold",
  },
};

/** No section tabs and no context: the shell degrades to topbar + rail. */
export const TopbarOnly: Story = {
  args: {
    ...baseArgs,
    forceLayout: "desktop",
    sectionTabs: [],
    contextItems: undefined,
    contextRight: undefined,
  },
};

export const Loading: Story = {
  args: { ...baseArgs, forceLayout: "desktop", loading: true },
};
