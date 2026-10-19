import type { Meta, StoryObj } from "@storybook/react";
import { YStack } from "tamagui";

// @ts-ignore - storybook direct import path
import { IthasFireProvider, themes } from "../../tamagui";
import { Stepper, type StepperProps } from "./navigation/Stepper";
import { Text } from "./typography/Text";

const demoSteps: StepperProps["steps"] = [
  {
    id: "place",
    title: "Place access",
    description: "Connect a saved place or drop coordinates",
  },
  {
    id: "details",
    title: "Event details",
    description: "Name, time, hosts, and visibility",
  },
  {
    id: "tickets",
    title: "Tickets",
    description: "Configure inventory and price tiers",
    optional: true,
  },
  {
    id: "review",
    title: "Review",
    description: "Verify everything before publishing",
  },
];

type StepperStoryArgs = StepperProps & { theme: "swiss" | "ember" };

const meta: Meta<StepperStoryArgs> = {
  title: "Navigation/Stepper",
  component: Stepper,
  args: {
    steps: demoSteps,
    currentStepId: "details",
    completedStepIds: ["place"],
    orientation: "horizontal",
    size: "md",
  },
  decorators: [
    (Story, context) => {
      const themeName = context.args.theme === "ember" ? "ember" : "swiss";
      const surfaceColor =
        themeName === "ember" ? themes.ember.background : themes.swiss.background;

      return (
        <IthasFireProvider theme={themeName}>
          <YStack
            padding="$6"
            backgroundColor={surfaceColor}
            minHeight="100vh"
            gap="$4"
          >
            <Text variant="h4" weight="bold">
              Stepper preview
            </Text>
            <Story />
          </YStack>
        </IthasFireProvider>
      );
    },
  ],
  argTypes: {
    orientation: {
      control: { type: "inline-radio" },
      options: ["horizontal", "vertical"],
    },
    size: {
      control: { type: "inline-radio" },
      options: ["sm", "md"],
    },
    currentStepId: {
      control: { type: "select" },
      options: demoSteps.map((step) => step.id),
    },
    completedStepIds: {
      control: { type: "object" },
    },
    theme: {
      control: { type: "inline-radio" },
      options: ["swiss", "ember"],
    },
  },
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  args: {
    theme: "swiss",
  },
};

export const Vertical: Story = {
  args: {
    orientation: "vertical",
    theme: "ember",
    currentStepId: "tickets",
    completedStepIds: ["place", "details"],
  },
};
