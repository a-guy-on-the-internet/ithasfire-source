import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";

import { IthasFireProvider, themes } from "../..";
import { ProgressBar, type ProgressBarProps } from "./ProgressBar";
import { Text } from "../typography/Text";

type ProgressBarStoryProps = ProgressBarProps & {
  theme?: "swiss" | "ember";
};

const meta: Meta<ProgressBarStoryProps> = {
  title: "Ui/Tamagui/Components/Feedback/Progress Bar",
  component: ProgressBar,
  args: {
    theme: "swiss",
    size: "md",
    variant: "determinate",
    min: 0,
    max: 100,
  },
  argTypes: {
    theme: {
      control: { type: "inline-radio" },
      options: ["swiss", "ember"],
      table: {
        category: "Environment",
      },
    },
    size: {
      control: { type: "inline-radio" },
      options: ["sm", "md", "lg"],
    },
    variant: {
      control: { type: "inline-radio" },
      options: ["determinate", "indeterminate"],
    },
    min: {
      control: { type: "number" },
    },
    max: {
      control: { type: "number" },
    },
    value: {
      control: { type: "number" },
    },
  },
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story, { args }) => (
      <IthasFireProvider
        theme={(args as { theme?: "swiss" | "ember" }).theme ?? "swiss"}
      >
        <Story />
      </IthasFireProvider>
    ),
  ],
};

type Story = StoryObj<ProgressBarStoryProps>;

const omitTheme = <T extends { theme?: string }>(args: T) => {
  const { theme: _theme, ...rest } = args;
  return rest;
};

const ProgressBarShowcase = ({
  themeName,
  baseArgs,
}: {
  themeName: "swiss" | "ember";
  baseArgs: Partial<ProgressBarProps>;
}) => {
  const { variant: _variant, value: _value, ...progressArgs } = baseArgs;

  const min = progressArgs.min ?? 0;
  const max = progressArgs.max ?? 100;

  const [progress, setProgress] = useState(min);
  const directionRef = useRef(1);

  useEffect(() => {
    directionRef.current = 1;
    setProgress(min);
  }, [min, max]);

  useEffect(() => {
    const id = setInterval(() => {
      setProgress((prev) => {
        const next = prev + directionRef.current * (max - min) * 0.05;
        if (next >= max) {
          directionRef.current = -1;
          return max;
        }
        if (next <= min) {
          directionRef.current = 1;
          return min;
        }
        return next;
      });
    }, 160);

    return () => {
      clearInterval(id);
    };
  }, [max, min]);

  const containerBackground =
    themeName === "ember"
      ? themes.ember.backgroundStrong
      : themes.swiss.backgroundStrong;

  return (
    <YStack
      backgroundColor={containerBackground}
      padding="$5"
      borderRadius="$lg"
      gap="$5"
      width="100%"
    >
      <Text variant="body" tone="muted" margin={0}>
        Observe how the Ithas Fire progress bar communicates load states across
        sizes and animation modes.
      </Text>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Determinate
        </Text>
        <ProgressBar
          {...progressArgs}
          variant="determinate"
          value={Math.round(progress)}
          min={min}
          max={max}
        />
      </YStack>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Indeterminate
        </Text>
        <ProgressBar {...progressArgs} variant="indeterminate" />
      </YStack>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Sizes
        </Text>
        <YStack gap="$2">
          <ProgressBar
            {...progressArgs}
            size="sm"
            variant="determinate"
            value={Math.round(progress)}
            min={min}
            max={max}
          />
          <ProgressBar
            {...progressArgs}
            size="md"
            variant="determinate"
            value={Math.round(progress)}
            min={min}
            max={max}
          />
          <ProgressBar
            {...progressArgs}
            size="lg"
            variant="determinate"
            value={Math.round(progress)}
            min={min}
            max={max}
          />
        </YStack>
      </YStack>
    </YStack>
  );
};

export const Interactive: Story = {
  name: "Interactive Showcase",
  render: (args) => {
    const themeName = (args.theme ?? "swiss") as "swiss" | "ember";
    const baseArgs = omitTheme(args) as Partial<ProgressBarProps>;
    return <ProgressBarShowcase themeName={themeName} baseArgs={baseArgs} />;
  },
};

export const DarkTheme: Story = {
  args: {
    theme: "ember",
  },
  render: (args) => {
    const themeName = (args.theme ?? "ember") as "swiss" | "ember";
    const baseArgs = omitTheme(args) as Partial<ProgressBarProps>;
    return <ProgressBarShowcase themeName={themeName} baseArgs={baseArgs} />;
  },
};

export default meta;
