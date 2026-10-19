import type { Meta, StoryObj } from "@storybook/react";
import { XStack, YStack } from "tamagui";

import { IthasFireProvider, themes } from "../..";
import { Spinner, type SpinnerProps } from "./Spinner";
import { Text } from "../typography/Text";

type SpinnerStoryProps = SpinnerProps & {
  theme?: "swiss" | "ember";
};

const meta: Meta<SpinnerStoryProps> = {
  title: "Ui/Tamagui/Components/Feedback/Spinner",
  component: Spinner,
  args: {
    theme: "swiss",
    size: "md",
    reducedMotion: false,
    durationMs: 900,
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
    reducedMotion: {
      control: { type: "boolean" },
    },
    durationMs: {
      control: { type: "number" },
      table: {
        category: "Animation",
      },
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

type Story = StoryObj<SpinnerStoryProps>;

const omitTheme = <T extends { theme?: string }>(args: T) => {
  const { theme: _theme, ...rest } = args;
  return rest;
};

const SpinnerShowcase = ({
  themeName,
  baseArgs,
}: {
  themeName: "swiss" | "ember";
  baseArgs: Partial<SpinnerProps>;
}) => {
  const { size: _size, ...spinnerArgs } = baseArgs;

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
        Preview the Ithas Fire spinner across theme contexts, size variants, and
        token-driven color accents.
      </Text>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Default
        </Text>
        <Spinner
          {...spinnerArgs}
          size={(baseArgs.size as SpinnerProps["size"]) ?? "md"}
        />
      </YStack>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Sizes
        </Text>
        <XStack gap="$4" alignItems="center">
          <Spinner {...spinnerArgs} size="sm" />
          <Spinner {...spinnerArgs} size="md" />
          <Spinner {...spinnerArgs} size="lg" />
        </XStack>
      </YStack>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Color accents
        </Text>
        <XStack gap="$4" alignItems="center">
          <Spinner
            {...spinnerArgs}
            indicatorColor="$accent"
            trackColor="$surfaceMuted"
          />
          <Spinner
            {...spinnerArgs}
            indicatorColor="$success"
            trackColor="$surfaceMuted"
          />
          <Spinner
            {...spinnerArgs}
            indicatorColor="$warning"
            trackColor="$surfaceMuted"
          />
          <Spinner
            {...spinnerArgs}
            indicatorColor="$danger"
            trackColor="$surfaceMuted"
          />
        </XStack>
      </YStack>
    </YStack>
  );
};

export const Interactive: Story = {
  name: "Interactive Showcase",
  render: (args) => {
    const themeName = (args.theme ?? "swiss") as "swiss" | "ember";
    const baseArgs = omitTheme(args) as Partial<SpinnerProps>;
    return <SpinnerShowcase themeName={themeName} baseArgs={baseArgs} />;
  },
};

export const DarkTheme: Story = {
  args: {
    theme: "ember",
  },
  render: (args) => {
    const themeName = (args.theme ?? "ember") as "swiss" | "ember";
    const baseArgs = omitTheme(args) as Partial<SpinnerProps>;
    return <SpinnerShowcase themeName={themeName} baseArgs={baseArgs} />;
  },
};

export default meta;
