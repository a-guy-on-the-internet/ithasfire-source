import type { Meta, StoryObj } from "@storybook/react";
import type { ReactElement } from "react";
import {
  ArrowRight,
  Bell,
  ChevronRight,
  ExternalLink,
  Star,
  Ticket,
} from "lucide-react";
import { Stack } from "tamagui";

import {
  ListItem,
  ListItemGroup,
  type ListItemProps,
} from "./navigation/ListItem";

type ListItemStoryArgs = ListItemProps & {
  groupBordered: boolean;
  showLeadingIcon: boolean;
  showTrailingIcon: boolean;
  includeSubtitle: boolean;
  leadingIcon: LeadingIconOption;
  trailingIcon: TrailingIconOption;
};

type LeadingIconOption = "star" | "ticket" | "bell";
type TrailingIconOption = "chevronRight" | "arrowRight" | "externalLink";

const leadingIconRenderers: Record<LeadingIconOption, () => ReactElement> = {
  star: () => <Star size={16} strokeWidth={1.5} />,
  ticket: () => <Ticket size={16} strokeWidth={1.5} />,
  bell: () => <Bell size={16} strokeWidth={1.5} />,
};

const trailingIconRenderers: Record<TrailingIconOption, () => ReactElement> = {
  chevronRight: () => <ChevronRight size={16} strokeWidth={1.5} />,
  arrowRight: () => <ArrowRight size={16} strokeWidth={1.5} />,
  externalLink: () => <ExternalLink size={16} strokeWidth={1.5} />,
};
const meta = {
  title: "List/ListItem",
  component: ListItem,
  parameters: {
    layout: "padded",
  },
  argTypes: {
    leadingAccessory: {
      control: false,
    },
    trailingAccessory: {
      control: false,
    },
    groupBordered: {
      control: "boolean",
      name: "Grouped border",
    },
    showLeadingIcon: {
      control: "boolean",
      name: "Leading icon",
    },
    showTrailingIcon: {
      control: "boolean",
      name: "Trailing icon",
    },
    leadingIcon: {
      control: {
        type: "select",
      },
      options: ["star", "ticket", "bell"] satisfies LeadingIconOption[],
      name: "Leading icon style",
    },
    trailingIcon: {
      control: {
        type: "select",
      },
      options: [
        "chevronRight",
        "arrowRight",
        "externalLink",
      ] satisfies TrailingIconOption[],
      name: "Trailing icon style",
    },
    includeSubtitle: {
      control: "boolean",
      name: "Subtitle",
    },
    standalone: {
      control: "boolean",
      table: {
        category: "Advanced",
      },
    },
  },
  args: {
    title: "Star",
    subtitle: "Subtitle",
    testIdBase: "list-item",
    groupBordered: true,
    showLeadingIcon: true,
    showTrailingIcon: true,
    includeSubtitle: true,
    leadingIcon: "star",
    trailingIcon: "chevronRight",
  },
} satisfies Meta<ListItemStoryArgs>;

type Story = StoryObj<ListItemStoryArgs>;

export const Playground: Story = {
  render: ({
    groupBordered,
    showLeadingIcon,
    showTrailingIcon,
    includeSubtitle,
    leadingIcon,
    trailingIcon,
    title,
    subtitle,
    standalone,
    leadingAccessory,
    trailingAccessory,
    ...itemArgs
  }) => {
    const resolvedLeading = showLeadingIcon
      ? (leadingAccessory ??
        leadingIconRenderers[leadingIcon]?.() ??
        leadingIconRenderers.star())
      : undefined;

    const resolvedTrailing = showTrailingIcon
      ? (trailingAccessory ??
        trailingIconRenderers[trailingIcon]?.() ??
        trailingIconRenderers.chevronRight())
      : undefined;

    const subtitleValue = includeSubtitle
      ? (subtitle ?? "Subtitle")
      : undefined;

    if (standalone) {
      return (
        <ListItem
          {...itemArgs}
          standalone
          title={title ?? "Standalone item"}
          subtitle={subtitleValue}
          leadingAccessory={resolvedLeading}
          trailingAccessory={resolvedTrailing}
        />
      );
    }

    return (
      <ListItemGroup
        bordered={groupBordered}
        testIdBase={itemArgs.testIdBase ?? "list-item"}
      >
        <ListItem
          {...itemArgs}
          title={title ?? "Headline item"}
          subtitle={subtitleValue}
          leadingAccessory={resolvedLeading}
          trailingAccessory={resolvedTrailing}
        />
        <ListItem
          {...itemArgs}
          title="Secondary entry"
          subtitle={includeSubtitle ? "Secondary subtitle" : undefined}
          leadingAccessory={resolvedLeading}
          trailingAccessory={resolvedTrailing}
        />
        <ListItem
          {...itemArgs}
          title="Tertiary entry"
          subtitle={includeSubtitle ? "Supporting subtitle" : undefined}
          leadingAccessory={resolvedLeading}
          trailingAccessory={resolvedTrailing}
          showDivider={false}
        />
      </ListItemGroup>
    );
  },
};

export const CompactList: Story = {
  args: {
    groupBordered: false,
    showLeadingIcon: false,
    showTrailingIcon: true,
    includeSubtitle: false,
    title: "Compact",
    standalone: false,
    paddingVertical: "$2",
  },
  parameters: {
    controls: {
      exclude: ["showLeadingIcon", "leadingIcon"],
    },
  },
  render: ({
    groupBordered,
    showLeadingIcon: _showLeadingIcon,
    showTrailingIcon,
    includeSubtitle: _includeSubtitle,
    trailingIcon,
    leadingIcon: _leadingIcon,
    ...itemArgs
  }) => (
    <ListItemGroup bordered={groupBordered}>
      <ListItem
        {...itemArgs}
        title="No subtitle"
        subtitle={undefined}
        leadingAccessory={undefined}
        trailingAccessory={
          showTrailingIcon
            ? (trailingIconRenderers[trailingIcon]?.() ??
              trailingIconRenderers.chevronRight())
            : undefined
        }
      />
      <ListItem
        {...itemArgs}
        title="Second"
        subtitle={undefined}
        leadingAccessory={undefined}
        trailingAccessory={
          showTrailingIcon
            ? (trailingIconRenderers[trailingIcon]?.() ??
              trailingIconRenderers.chevronRight())
            : undefined
        }
        showDivider={false}
      />
    </ListItemGroup>
  ),
};

export default meta;
