import type { Meta, StoryObj } from "@storybook/react";
import { useArgs } from "@storybook/preview-api";
import { LayoutDashboard, Share2, Ticket, Users } from "lucide-react";
import { XStack, YStack, styled } from "tamagui";

import { Button } from "../forms/Button";
import { NavbarShell, type NavbarShellProps } from "./NavbarShell";
import { NotificationButton } from "../feedback/NotificationButton";
import { Text } from "../typography/Text";

import type { NavigationSection } from "../../../shell/NavigationShell.types";

const BrandMark = styled(XStack, {
  name: "NavbarShellBrandMark",
  alignItems: "center",
  justifyContent: "center",
  width: 44,
  height: 44,
  borderRadius: "$md",
  backgroundColor: "$brandPrimary",
  borderWidth: 2,
  borderColor: "$surface",
});

const DrawerLinks = () => (
  <YStack gap="$1">
    {["Dashboard", "Events", "Settlements", "Venues", "Customers"].map(
      (label) => (
        <Button
          key={label}
          size="$3"
          variant="ghost"
          justifyContent="flex-start"
        >
          {label}
        </Button>
      ),
    )}
  </YStack>
);

const railSections: NavigationSection[] = [
  {
    id: "primary",
    label: "",
    items: [
      {
        id: "dashboard",
        label: "Dashboard",
        route: "/admin",
        icon: <LayoutDashboard size={20} strokeWidth={1.5} />,
      },
      {
        id: "events",
        label: "Events",
        route: "/admin/events",
        icon: <Ticket size={20} strokeWidth={1.5} />,
      },
      {
        id: "account",
        label: "Account",
        route: "/account",
        icon: <Users size={20} strokeWidth={1.5} />,
      },
    ],
  },
];

const meta = {
  title: "Ui/Tamagui/Components/Navigation/Navbar Shell",
  component: NavbarShell,
  args: {
    title: "Ithas Fire",
    brand: (
      <BrandMark>
        <Text variant="body" weight="bold" tone="brandSecondary">
          TH
        </Text>
      </BrandMark>
    ),
    drawerTitle: "Navigation",
    drawerDescription: "Choose a destination",
    drawerContent: <DrawerLinks />,
    drawerFooter: <Button variant="destructive">Sign out</Button>,
    trailingAccessory: (
      <XStack gap="$2">
        <Button size="$3" variant="ghost" icon>
          <Share2 size={20} strokeWidth={1.5} />
        </Button>
        <NotificationButton aria-label="View notifications" count={3} />
        <Button size="$4">Publish</Button>
      </XStack>
    ),
    children: (
      <YStack gap="$2">
        <Text variant="body" tone="muted">
          The shell composes the Navbar with a responsive drawer.
        </Text>
        <Text variant="bodySmall" tone="muted">
          Resize the canvas or toggle the controls to explore the behavior.
        </Text>
      </YStack>
    ),
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<NavbarShellProps>;

type Story = StoryObj<NavbarShellProps>;

const Template = (props: NavbarShellProps) => <NavbarShell {...props} />;

export const Default: Story = {
  render: Template,
};

export const ControlledDrawer: Story = {
  args: {
    drawerOpen: false,
  },
  render: (props) => {
    const [{ drawerOpen }, updateArgs] = useArgs();
    return (
      <NavbarShell
        {...props}
        drawerOpen={drawerOpen}
        onDrawerOpenChange={(open) => updateArgs({ drawerOpen: open })}
      />
    );
  },
};

export const Mobile: Story = {
  args: {
    trailingAccessory: (
      <XStack gap="$2">
        <Button size="$2" variant="ghost" icon>
          <Share2 size={18} strokeWidth={1.5} />
        </Button>
        <NotificationButton
          aria-label="View notifications"
          count={1}
          size="$2"
        />
      </XStack>
    ),
  },
  parameters: {
    viewport: {
      defaultViewport: "mobile2",
    },
  },
  render: Template,
};

export const WithRailExpanded: Story = {
  args: {
    railSections,
    railCurrentRoute: "/admin",
  },
  render: (props) => {
    const [{ railCurrentRoute }, updateArgs] = useArgs();
    return (
      <NavbarShell
        {...props}
        railCurrentRoute={railCurrentRoute}
        onRailRouteSelect={(route) => updateArgs({ railCurrentRoute: route })}
        // Keep story deterministic
        persistRailState={false}
      >
        {props.children}
      </NavbarShell>
    );
  },
};

export const WithRailCollapsed: Story = {
  args: {
    railSections,
    railCurrentRoute: "/admin",
    railCollapsed: true,
  },
  render: (props) => {
    const [{ railCurrentRoute, railCollapsed }, updateArgs] = useArgs();
    return (
      <NavbarShell
        {...props}
        railCurrentRoute={railCurrentRoute}
        railCollapsed={railCollapsed}
        onRailCollapsedChange={(next) => updateArgs({ railCollapsed: next })}
        onRailRouteSelect={(route) => updateArgs({ railCurrentRoute: route })}
        // Keep story deterministic
        persistRailState={false}
      >
        {props.children}
      </NavbarShell>
    );
  },
};

export default meta;
