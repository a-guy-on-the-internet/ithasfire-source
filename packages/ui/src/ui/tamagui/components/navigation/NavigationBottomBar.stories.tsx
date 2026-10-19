import type { Meta, StoryObj } from "@storybook/react";
import { useCallback, useState, type ComponentProps } from "react";
import { YStack, Text } from "tamagui";
import {
  Bell,
  Calendar,
  Compass,
  LayoutGrid,
  MoreHorizontal,
  Receipt,
  ScanLine,
  Ticket,
  Users,
} from "lucide-react";

import type { NavigationSection } from "../../../shell/NavigationShell.types";
import { NavigationBottomBar } from "./NavigationBottomBar";

const ICON_SIZE = 24;
const ICON_STROKE = 2;

const sections: NavigationSection[] = [
  {
    id: "core",
    label: "Core",
    items: [
      {
        id: "home",
        label: "Explore",
        route: "/home",
        icon: <Compass size={ICON_SIZE} strokeWidth={ICON_STROKE} />,
      },
      {
        id: "events",
        label: "Events",
        route: "/events",
        icon: <Calendar size={ICON_SIZE} strokeWidth={ICON_STROKE} />,
      },
      {
        id: "tickets",
        label: "Tickets",
        route: "/tickets",
        icon: <Ticket size={ICON_SIZE} strokeWidth={ICON_STROKE} />,
      },
      {
        id: "alerts",
        label: "Alerts",
        route: "/alerts",
        badgeCount: 3,
        icon: <Bell size={ICON_SIZE} strokeWidth={ICON_STROKE} />,
      },
    ],
  },
];

const extendedSections: NavigationSection[] = [
  sections[0]!,
  {
    id: "secondary",
    label: "More",
    items: [
      {
        id: "customers",
        label: "Customers",
        route: "/customers",
        icon: <Users size={ICON_SIZE} strokeWidth={ICON_STROKE} />,
      },
      {
        id: "orders",
        label: "Orders",
        route: "/orders",
        icon: <Receipt size={ICON_SIZE} strokeWidth={ICON_STROKE} />,
      },
      {
        id: "manage",
        label: "Manage",
        route: "/manage",
        icon: <LayoutGrid size={ICON_SIZE} strokeWidth={ICON_STROKE} />,
      },
    ],
  },
];

const meta = {
  title: "Ui/Tamagui/Components/Navigation/Navigation Bottom Bar",
  component: NavigationBottomBar,
  args: {
    onSelect: () => undefined,
    onOpenDrawer: () => undefined,
  },
  parameters: {
    layout: "fullscreen",
    viewport: {
      defaultViewport: "mobile2",
    },
  },
  render: (props) => <BottomBarStory {...props} />,
} satisfies Meta<typeof NavigationBottomBar>;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    sections,
    currentRoute: "/home",
  },
};

export const WithMoreMenu: Story = {
  args: {
    sections: extendedSections,
    currentRoute: "/events",
    maxItems: 4,
  },
};

/**
 * One-bottom-bar redesign: a raised accent action square splits the tabs
 * (2-and-2 with the More tab). It is an action, not a tab — no active rule,
 * no swipe slot — but it darkens to the press rung while its route is
 * current.
 */
export const WithCenterAction: Story = {
  args: {
    sections: extendedSections,
    currentRoute: "/events",
    maxItems: 4,
    centerAction: {
      id: "scan",
      label: "Scan",
      icon: <ScanLine />,
      onPress: () => {
        // eslint-disable-next-line no-console
        console.log("Center action pressed");
      },
    },
  },
};

export default meta;

const BottomBarStory = (props: ComponentProps<typeof NavigationBottomBar>) => {
  const [route, setRoute] = useState(props.currentRoute ?? "/home");

  const handleSelect = useCallback<
    NonNullable<ComponentProps<typeof NavigationBottomBar>["onSelect"]>
  >(
    (nextRoute, meta) => {
      setRoute(nextRoute);
      props.onSelect?.(nextRoute, meta);
    },
    [props],
  );

  const handleOpenDrawer = useCallback(() => {
    props.onOpenDrawer?.();
    // eslint-disable-next-line no-console
    console.log("Open mobile navigation drawer");
  }, [props]);

  return (
    <YStack minHeight="100vh" backgroundColor="$surfaceMuted">
      <YStack
        flex={1}
        padding="$5"
        paddingBottom="$14"
        gap="$3"
        justifyContent="center"
      >
        <Text fontSize="$7" fontWeight="700">
          Bottom navigation demo
        </Text>
        <Text fontSize="$4" color="$textSubdued">
          Scroll or resize to confirm the navigation bar remains anchored to the
          bottom of the viewport.
        </Text>
      </YStack>
      <NavigationBottomBar
        {...props}
        currentRoute={route}
        onSelect={handleSelect}
        onOpenDrawer={handleOpenDrawer}
      />
    </YStack>
  );
};
