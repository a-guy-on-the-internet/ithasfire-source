import type { Meta, StoryObj } from "@storybook/react";
import { Stack } from "tamagui";
import { Link, Text, Button } from "@th/ui";

const meta = {
  title: "Navigation/Link",
  component: Link,
  parameters: { layout: "padded" },
  args: {},
} satisfies Meta<typeof Link>;

type Story = StoryObj<typeof Link>;

export const Playground: Story = {
  render: () => (
    <Stack gap={12}>
      <Text>
        Internal link: <Link href="/privacy">Privacy policy</Link>
      </Text>

      <Text>
        External link:{" "}
        <Link href="https://example.com" target="_blank">
          External site
        </Link>
      </Text>

      <Link href="/events/abc">
        <Button variant="primary">CTA as anchor</Button>
      </Link>
    </Stack>
  ),
};

export default meta;
