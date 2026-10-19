import type { Meta, StoryObj } from "@storybook/react";
import { XStack, YStack } from "tamagui";

import { IthasFireProvider, themes } from "../..";
import { TextInput, type TextInputProps } from "./TextInput";
import { Text } from "../typography/Text";

type TextInputStoryProps = TextInputProps & {
  theme?: "swiss" | "ember";
};

const meta: Meta<TextInputStoryProps> = {
  title: "Ui/Tamagui/Components/Forms/Text Input",
  component: TextInput,
  args: {
    theme: "swiss",
    placeholder: "Search events",
    status: undefined,
    containerWidth: 240,
    disabled: false,
  },
  argTypes: {
    theme: {
      control: { type: "inline-radio" },
      options: ["swiss", "ember"],
      table: {
        category: "Environment",
      },
    },
    status: {
      control: { type: "select" },
      options: [undefined, "success", "warning", "error"],
    },
    containerWidth: {
      control: { type: "text" },
    },
    disabled: {
      control: { type: "boolean" },
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
  render: (args) => {
    const { theme: _theme, ...inputArgs } = args;
    return <TextInput {...inputArgs} />;
  },
};

type Story = StoryObj<TextInputStoryProps>;

const omitTheme = <T extends { theme?: string }>(args: T) => {
  const { theme: _theme, ...rest } = args;
  return rest;
};

const TextInputShowcase = ({
  themeName,
  baseArgs,
}: {
  themeName: "swiss" | "ember";
  baseArgs: Partial<TextInputProps>;
}) => {
  const { status: _status, ...inputProps } = baseArgs;

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
        Explore how the Ithas Fire text input behaves across themes, validation
        states, and layout options.
      </Text>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Default
        </Text>
        <TextInput {...inputProps} placeholder="Search events" />
        <TextInput {...inputProps} placeholder="Disabled state" disabled />
      </YStack>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Validation
        </Text>
        <YStack gap="$2">
          <TextInput {...inputProps} status="error" placeholder="Error state" />
          <TextInput
            {...inputProps}
            status="warning"
            placeholder="Warning state"
          />
          <TextInput
            {...inputProps}
            status="success"
            placeholder="Success state"
          />
        </YStack>
      </YStack>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Full width
        </Text>
        <XStack width={360}>
          <TextInput
            {...inputProps}
            containerWidth="100%"
            placeholder="Email address"
          />
        </XStack>
      </YStack>
    </YStack>
  );
};

export const StatesAndVariants: Story = {
  name: "States & Variants",
  render: (args) => {
    const themeName = (args.theme ?? "swiss") as "swiss" | "ember";
    const baseArgs = omitTheme(args) as Partial<TextInputProps>;

    return <TextInputShowcase themeName={themeName} baseArgs={baseArgs} />;
  },
};

export const DarkTheme: Story = {
  args: {
    theme: "ember",
  },
  render: (args) => {
    const themeName = (args.theme ?? "ember") as "swiss" | "ember";
    const baseArgs = omitTheme(args) as Partial<TextInputProps>;

    return <TextInputShowcase themeName={themeName} baseArgs={baseArgs} />;
  },
};

export default meta;
