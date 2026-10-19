import type { Meta, StoryObj } from "@storybook/react";
import { Bell } from "lucide-react";
import { XStack, YStack } from "tamagui";

// @ts-ignore -- Storybook story relies on direct source import; bundler resolution flags this within isolated lint checks.
import { IthasFireProvider, themes } from "../../tamagui";
import { Button, type ButtonProps } from "./forms/Button";
import { Text } from "./typography/Text";

type ControlledVariant = NonNullable<ButtonProps["variant"]>;
type ControlledSize = NonNullable<ButtonProps["size"]>;

/** Stub is the shipped default theme, so it leads and is the story default. */
type PlaygroundTheme = "stub" | "swiss" | "ember";

type PlaygroundArgs = {
  theme: PlaygroundTheme;
  variant: ControlledVariant;
  size: ControlledSize;
  disabled: boolean;
  withIcon: boolean;
  iconOnly: boolean;
  label: string;
};

/**
 * Design System v2 core grammar: primary (accent fill), secondary
 * (structure outline, fills with structure on hover), ghost (transparent,
 * surface-raised hover). Sizes: $3 = sm (h36), $4 = md (h44), $5 = lg (h54).
 */
const coreVariants: ControlledVariant[] = ["primary", "secondary", "ghost"];

const v2Sizes: Array<{ size: ControlledSize; label: string }> = [
  { size: "$3", label: "$3 · sm · h36" },
  { size: "$4", label: "$4 · md · h44" },
  { size: "$5", label: "$5 · lg · h54" },
];

/** Legacy variants kept for existing call sites — not part of the v2 grammar. */
const legacyDefinitions: Array<{
  label: string;
  props: ButtonProps;
}> = [
  { label: "Subtle", props: { variant: "subtle", children: "Subtle" } },
  {
    label: "Destructive",
    props: { variant: "destructive", children: "Destructive" },
  },
  {
    label: "Destructive-ghost",
    props: { variant: "destructiveGhost", children: "Remove" },
  },
  {
    label: "Outlined (deprecated)",
    props: { variant: "outlined", children: "Outlined" },
  },
  {
    label: "Locked (primary)",
    props: { locked: true, children: "Locked" },
  },
];

const meta = {
  title: "Primitives/Button",
  component: Button,
  parameters: {
    layout: "fullscreen",
    docs: {
      disable: true,
    },
  },
  tags: [],
  args: {
    theme: "stub",
    variant: "primary",
    size: "$3",
    disabled: false,
    withIcon: false,
    iconOnly: false,
    label: "Click me",
  },
  argTypes: {
    theme: {
      control: { type: "inline-radio" },
      options: ["stub", "swiss", "ember"],
      description:
        "Background theme used for previewing the button (stub = shipped default)",
    },
    variant: {
      control: { type: "select" },
      options: [
        "primary",
        "secondary",
        "subtle",
        "ghost",
        "ghostInverted",
        "destructive",
        "destructiveGhost",
        "outlined",
      ],
      description:
        "Visual treatment — v2 core: primary/secondary/ghost; legacy: subtle/destructive/outlined",
    },
    size: {
      control: { type: "inline-radio" },
      options: ["$2", "$3", "$4", "$5"],
      description: "Height and padding preset ($3=sm, $4=md, $5=lg)",
    },
    disabled: {
      control: { type: "boolean" },
      description: "Disable interactions",
    },
    withIcon: {
      control: { type: "boolean" },
      name: "Show leading icon",
      description: "Prepend a Bell icon before the label",
    },
    iconOnly: {
      control: { type: "boolean" },
      description: "Render as icon-only button",
    },
    label: {
      control: { type: "text" },
      description: "Button label",
    },
  },
} satisfies Meta<PlaygroundArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

const PlaygroundWrapper = ({
  children,
  theme,
}: {
  children: React.ReactNode;
  theme: PlaygroundTheme;
}) => {
  const surfaceColor = themes[theme].background;
  return (
    <IthasFireProvider theme={theme}>
      <YStack
        padding="$6"
        gap="$5"
        backgroundColor={surfaceColor}
        minHeight="100vh"
        justifyContent="center"
        alignItems="flex-start"
      >
        {children}
      </YStack>
    </IthasFireProvider>
  );
};

export const Playground: Story = {
  render: (rawArgs) => {
    const { theme, withIcon, iconOnly, label, variant, size, disabled } =
      rawArgs as PlaygroundArgs;
    // Raw string children — the button's own v2 label typography
    // (700 / 11-13px / +1.5 tracking) must not be masked by a Text variant.
    const content = iconOnly ? (
      <Bell size={18} />
    ) : withIcon ? (
      <>
        <Bell size={16} />
        {label}
      </>
    ) : (
      label
    );

    return (
      <PlaygroundWrapper theme={theme}>
        <Button
          variant={variant}
          size={size}
          disabled={disabled}
          icon={iconOnly}
          aria-label={iconOnly ? label : undefined}
        >
          {content}
        </Button>
      </PlaygroundWrapper>
    );
  },
};

const SectionHeading = ({
  children,
  color,
}: {
  children: React.ReactNode;
  color: string;
}) => (
  <Text variant="h4" weight="bold" color={color} margin={0}>
    {children}
  </Text>
);

const Showcase = ({ theme }: { theme: "swiss" | "ember" }) => {
  const surfaceColor =
    theme === "ember" ? themes.ember.background : themes.swiss.background;
  const textColor = theme === "ember" ? "$brandSecondary" : "$brandPrimary";

  return (
    <IthasFireProvider theme={theme}>
      <YStack
        padding="$6"
        gap="$6"
        backgroundColor={surfaceColor}
        minHeight="100vh"
        justifyContent="center"
      >
        {/* v2 core grammar: variants × sizes */}
        <YStack gap="$4">
          <SectionHeading color={textColor}>
            v2 core — variants × sizes
          </SectionHeading>
          {coreVariants.map((variant) => (
            <YStack key={variant} gap="$2">
              <Text variant="bodySmall" tone="muted" margin={0}>
                {variant}
              </Text>
              <XStack gap="$4" flexWrap="wrap" alignItems="flex-end">
                {v2Sizes.map(({ size, label }) => (
                  <YStack key={size} gap="$2" alignItems="flex-start">
                    <Text variant="caption" tone="muted" margin={0}>
                      {label}
                    </Text>
                    <Button variant={variant} size={size}>
                      {variant}
                    </Button>
                  </YStack>
                ))}
              </XStack>
            </YStack>
          ))}
        </YStack>

        {/* Ghost-inverted — only reads on a filled surface, so it gets one.
            Mirrors its real call site: the $accent paint-mode pill. */}
        <YStack gap="$4">
          <SectionHeading color={textColor}>
            Ghost-inverted — on an $accent fill
          </SectionHeading>
          <XStack gap="$4" flexWrap="wrap">
            <YStack gap="$2" alignItems="flex-start">
              <Text variant="bodySmall" tone="muted" margin={0}>
                ghostInverted
              </Text>
              <XStack
                backgroundColor="$accent"
                padding="$3"
                gap="$2"
                alignItems="center"
              >
                <Text variant="bodySmall" color="$colorInverted" margin={0}>
                  Painting: General admission
                </Text>
                <Button variant="ghostInverted" size="$1">
                  Exit
                </Button>
              </XStack>
            </YStack>
          </XStack>
        </YStack>

        {/* Disabled state */}
        <YStack gap="$4">
          <SectionHeading color={textColor}>
            Disabled (opacity 0.45)
          </SectionHeading>
          <XStack gap="$4" flexWrap="wrap">
            {coreVariants.map((variant) => (
              <Button key={variant} variant={variant} size="$4" disabled>
                {variant}
              </Button>
            ))}
          </XStack>
        </YStack>

        {/* Icon treatments */}
        <YStack gap="$4">
          <SectionHeading color={textColor}>
            Icons — one max, stroke currentColor
          </SectionHeading>
          <XStack gap="$4" flexWrap="wrap" alignItems="flex-end">
            <YStack gap="$2" alignItems="flex-start">
              <Text variant="caption" tone="muted" margin={0}>
                Icon only · md square ≥44
              </Text>
              <Button
                variant="secondary"
                size="$4"
                icon
                aria-label="Notifications"
              >
                <Bell size={18} />
              </Button>
            </YStack>
            <YStack gap="$2" alignItems="flex-start">
              <Text variant="caption" tone="muted" margin={0}>
                Icon only · ghost sm
              </Text>
              <Button variant="ghost" size="$3" icon aria-label="Notifications">
                <Bell size={16} />
              </Button>
            </YStack>
            <YStack gap="$2" alignItems="flex-start">
              <Text variant="caption" tone="muted" margin={0}>
                Icon + label
              </Text>
              <Button variant="secondary" size="$4">
                <Bell size={16} />
                With icon
              </Button>
            </YStack>
          </XStack>
        </YStack>

        {/* Legacy variants — kept for existing call sites */}
        <YStack gap="$4">
          <SectionHeading color={textColor}>
            Legacy — not part of the v2 grammar
          </SectionHeading>
          <XStack gap="$4" flexWrap="wrap">
            {legacyDefinitions.map(({ label, props }) => (
              <YStack key={label} gap="$2" alignItems="flex-start">
                <Text variant="bodySmall" tone="muted" margin={0}>
                  {label}
                </Text>
                <Button {...props} />
              </YStack>
            ))}
          </XStack>
        </YStack>
      </YStack>
    </IthasFireProvider>
  );
};

export const LightMode: Story = {
  render: () => <Showcase theme="swiss" />,
  parameters: {
    controls: { disable: true },
  },
};

export const DarkMode: Story = {
  render: () => <Showcase theme="ember" />,
  parameters: {
    controls: { disable: true },
  },
};
