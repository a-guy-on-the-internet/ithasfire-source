import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { useState } from "react";
import { YStack } from "tamagui";

import {
  PhoneNumberInput,
  type PhoneNumberInputProps,
  type PhoneNumberInputValue,
  type PhoneNumberValidationResult,
} from "./PhoneNumberInput";
import { Text } from "../typography/Text";

const meta: Meta<typeof PhoneNumberInput> = {
  title: "Ui/Tamagui/Components/Forms/Phone Number Input",
  component: PhoneNumberInput,
  args: {
    defaultCallingCode: "+1",
    disabled: false,
    maxOptionsToShow: 8,
    onValidationChange: fn(),
  } satisfies Partial<PhoneNumberInputProps>,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Two-part phone input (dial code + national number). The dial code picker shows only numeric calling codes (e.g. +1, +44), and the number field formats as-you-type via libphonenumber-js.",
      },
    },
  },
  argTypes: {
    value: { control: false },
    onChange: { control: false },
    onValidationChange: { control: false },
    callingCodeOptions: { control: false },
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

const StoryHarness = (
  props: Omit<PhoneNumberInputProps, "value" | "onChange">,
) => {
  const [value, setValue] = useState<PhoneNumberInputValue>({
    callingCode: props.defaultCallingCode ?? "+1",
    nationalNumber: "",
    callingCodeQuery: "",
  });

  const [validation, setValidation] = useState<PhoneNumberValidationResult>({
    isValid: false,
  });

  return (
    <YStack gap="$4" maxWidth={420}>
      <PhoneNumberInput
        {...props}
        value={value}
        onChange={setValue}
        onValidationChange={(next) => {
          setValidation(next);
          props.onValidationChange?.(next);
        }}
      />

      <YStack
        gap="$2"
        padding="$3"
        borderWidth={2}
        borderColor="$borderColor"
        borderRadius="$4"
      >
        <Text variant="bodySmall" color="$colorMuted">
          Debug
        </Text>
        <Text variant="bodySmall">callingCode: {value.callingCode}</Text>
        <Text variant="bodySmall">
          nationalNumber: {value.nationalNumber || "(empty)"}
        </Text>
        <Text variant="bodySmall">e164: {validation.e164 ?? "(none)"}</Text>
        <Text variant="bodySmall">isValid: {String(validation.isValid)}</Text>
        {validation.error ? (
          <Text variant="bodySmall">error: {validation.error}</Text>
        ) : null}
      </YStack>
    </YStack>
  );
};

export const Default: Story = {
  render: (args) => <StoryHarness {...args} />,
};

export const PrefilledValid: Story = {
  render: (args) => {
    const [value, setValue] = useState<PhoneNumberInputValue>({
      callingCode: "+1",
      nationalNumber: "213 373 4253",
      callingCodeQuery: "",
    });

    const [validation, setValidation] = useState<PhoneNumberValidationResult>(
      () => ({ isValid: false }),
    );

    return (
      <YStack gap="$4" maxWidth={420}>
        <PhoneNumberInput
          {...args}
          value={value}
          onChange={setValue}
          onValidationChange={setValidation}
        />
        <Text variant="bodySmall" color="$colorMuted">
          Parsed E.164: {validation.e164 ?? "(none)"}
        </Text>
      </YStack>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "Starts with a commonly valid-looking US phone number to show the success state.",
      },
    },
  },
};

export const Disabled: Story = {
  render: (args) => <StoryHarness {...args} disabled />,
};
