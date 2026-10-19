import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { YStack } from "tamagui";

import { IthasFireProvider, themes } from "../..";
import { Checkbox, type CheckboxProps } from "./Checkbox";
import { Text } from "../typography/Text";

const meta: Meta<typeof Checkbox> = {
  title: "Ui/Tamagui/Components/Forms/Checkbox",
  component: Checkbox,
  args: {
    theme: "swiss",
    label: "I agree to the terms",
    description: undefined,
    disabled: false,
    required: false,
    size: "md",
    checked: undefined,
    defaultChecked: undefined,
    errorMessage: undefined,
    frameBackgroundColor: undefined,
    frameBorderColor: undefined,
    indicatorBackgroundColor: undefined,
    indicatorColor: undefined,
  },
  argTypes: {
    id: {
      control: false,
    },
    theme: {
      control: { type: "inline-radio" },
      options: ["swiss", "ember"],
      table: {
        category: "Environment",
      },
    },
    label: {
      control: { type: "text" },
    },
    description: {
      control: { type: "text" },
    },
    errorMessage: {
      control: { type: "text" },
    },
    disabled: {
      control: { type: "boolean" },
    },
    required: {
      control: { type: "boolean" },
    },
    size: {
      control: { type: "inline-radio" },
      options: ["sm", "md", "lg"],
    },
    frameBackgroundColor: {
      control: { type: "color" },
    },
    frameBorderColor: {
      control: { type: "color" },
    },
    indicatorBackgroundColor: {
      control: { type: "color" },
    },
    indicatorColor: {
      control: { type: "color" },
    },
    checked: {
      options: [undefined, true, false, "indeterminate"] as const,
      control: { type: "select" },
      table: {
        type: { summary: 'boolean | "indeterminate" | undefined' },
      },
    },
    defaultChecked: {
      options: [undefined, true, false, "indeterminate"] as const,
      control: { type: "select" },
      table: {
        type: { summary: 'boolean | "indeterminate" | undefined' },
      },
    },
    onCheckedChange: {
      control: false,
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
    const { theme: _theme, ...checkboxArgs } = args;
    return <Checkbox {...checkboxArgs} />;
  },
};

type Story = StoryObj<typeof meta>;

const omitTheme = <T extends { theme?: string }>(args: T) => {
  const { theme: _theme, ...rest } = args;
  return rest;
};

type CheckboxCheckedState = Parameters<
  NonNullable<CheckboxProps["onCheckedChange"]>
>[0];

const CheckboxShowcase = ({
  themeName,
  baseArgs,
}: {
  themeName: "swiss" | "ember";
  baseArgs: Partial<CheckboxProps>;
}) => {
  const {
    indicatorColor,
    indicatorBackgroundColor,
    frameBackgroundColor,
    frameBorderColor,
    label: _label,
    description: _description,
    checked: _checked,
    defaultChecked: _defaultChecked,
    errorMessage: _errorMessage,
    ...checkboxProps
  } = baseArgs;

  const [controlledChecked, setControlledChecked] =
    useState<CheckboxCheckedState>(false);

  const sharedProps: Partial<CheckboxProps> = {
    ...checkboxProps,
    indicatorColor,
    indicatorBackgroundColor,
    frameBackgroundColor,
    frameBorderColor,
  };

  const containerBackground =
    themeName === "ember"
      ? themes.ember.backgroundStrong
      : themes.swiss.backgroundStrong;

  const stateVariants: Array<{
    key: string;
    label: string;
    description?: string;
    props?: Partial<CheckboxProps>;
  }> = [
    {
      key: "unchecked",
      label: "Unselected",
      description: "Neutral state before a user makes a choice.",
    },
    {
      key: "checked",
      label: "Standard selection",
      description: "Used for most confirmations.",
      props: {
        checked: true,
      },
    },
    {
      key: "indeterminate",
      label: "Partially selected",
      description: "When nested options are mixed.",
      props: {
        checked: "indeterminate",
      },
    },
    {
      key: "disabled",
      label: "Disabled selection",
      description:
        "Disabled controls retain contrast but do not allow interaction.",
      props: {
        disabled: true,
      },
    },
  ];

  return (
    <YStack
      backgroundColor={containerBackground}
      padding="$5"
      borderRadius="$lg"
      gap="$5"
    >
      <Text variant="body" tone="muted" margin={0}>
        Explore how checkbox states, validation, sizing, and controlled behavior
        render within the Ithas Fire design system.
      </Text>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Core states
        </Text>
        <YStack gap="$3">
          {stateVariants.map(({ key, label, description, props }) => (
            <Checkbox
              key={key}
              {...sharedProps}
              {...props}
              label={label}
              description={description}
            />
          ))}
        </YStack>
      </YStack>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Validation
        </Text>
        <Checkbox
          {...sharedProps}
          label="I accept the ticketing policy"
          errorMessage="You must agree before continuing."
          required
        />
      </YStack>

      <YStack gap="$3">
        <Text variant="body" weight="bold" margin={0}>
          Size options
        </Text>
        <YStack gap="$2">
          {(["sm", "md", "lg"] as const).map((size) => (
            <Checkbox
              key={size}
              {...sharedProps}
              size={size}
              label={`${size.toUpperCase()} checkbox`}
            />
          ))}
        </YStack>
      </YStack>

      <YStack gap="$2">
        <Text variant="body" weight="bold" margin={0}>
          Controlled example
        </Text>
        <Checkbox
          {...sharedProps}
          label="Subscribe to event updates"
          checked={controlledChecked}
          onCheckedChange={setControlledChecked}
          description="Toggle to see controlled and indeterminate state transitions."
        />
        <Text variant="bodySmall" tone="muted" margin={0}>
          Checked state: {String(controlledChecked)}
        </Text>
      </YStack>
    </YStack>
  );
};

export const StatesAndVariants: Story = {
  name: "States & Variants",
  render: (args) => {
    const themeName = (args.theme ?? "swiss") as "swiss" | "ember";
    const baseArgs = omitTheme(args) as Partial<CheckboxProps>;

    return <CheckboxShowcase themeName={themeName} baseArgs={baseArgs} />;
  },
};

export const DarkTheme: Story = {
  args: {
    theme: "ember",
  },
  render: (args) => {
    const themeName = (args.theme ?? "ember") as "swiss" | "ember";
    const baseArgs = omitTheme(args) as Partial<CheckboxProps>;

    return <CheckboxShowcase themeName={themeName} baseArgs={baseArgs} />;
  },
};

export default meta;
