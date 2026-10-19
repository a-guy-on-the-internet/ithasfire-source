import type { Meta, StoryObj } from "@storybook/react";
import { YStack, styled } from "tamagui";

import { Text } from "../typography/Text";
import { OverflowTooltip, type OverflowTooltipProps } from "./OverflowTooltip";

const LONG_TEXT =
  "0f3c9a1e-8b2d-4c7a-9e51-7d6f2b4a1c88 — a very long value that will not fit";
const SHORT_TEXT = "Doe";

const StoryColumn = styled(YStack, {
  name: "OverflowTooltipStoryColumn",
  gap: "$2",
});

const StoryCaption = styled(Text, {
  name: "OverflowTooltipStoryCaption",
  variant: "caption",
  tone: "muted",
  margin: 0,
});

// A deliberately narrow flex column so the long value clips and the short one
// does not — the exact NON-table surface this primitive targets.
const NarrowBox = styled(YStack, {
  name: "OverflowTooltipNarrowBox",
  width: 220,
  minWidth: 0,
  padding: "$3",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
});

const meta = {
  title: "Ui/Tamagui/Components/Feedback/OverflowTooltip",
  component: OverflowTooltip,
  args: {
    text: LONG_TEXT,
    placement: "top",
    tooltipTone: "neutral",
  },
  argTypes: {
    text: { control: { type: "text" } },
    tooltipText: { control: { type: "text" } },
    placement: {
      control: { type: "select" },
      options: ["top", "right", "bottom", "left"],
    },
  },
  parameters: {
    layout: "centered",
  },
  render: (args: OverflowTooltipProps) => (
    <NarrowBox>
      <OverflowTooltip {...args} />
    </NarrowBox>
  ),
} satisfies Meta<OverflowTooltipProps>;

type Story = StoryObj<OverflowTooltipProps>;

/** Clipped: long value truncates and reveals the full string on hover. */
export const Clipped: Story = {
  args: {
    text: LONG_TEXT,
  },
};

/** Not clipped: short value fits, so no tooltip is offered. */
export const NotClipped: Story = {
  args: {
    text: SHORT_TEXT,
  },
};

/** Monospace ID value (e.g. an order id) — full id revealed on hover. */
export const MonospaceId: Story = {
  render: (args) => (
    <StoryColumn>
      <StoryCaption>Hover the id to read the full value.</StoryCaption>
      <NarrowBox>
        <OverflowTooltip
          {...args}
          variant="code"
          style={{ fontSize: 13 }}
          text="0f3c9a1e-8b2d-4c7a-9e51-7d6f2b4a1c88"
        />
      </NarrowBox>
    </StoryColumn>
  ),
};

export default meta;
