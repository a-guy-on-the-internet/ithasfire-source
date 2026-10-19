"use client";

import { useState, type ReactElement } from "react";
import { XStack, YStack, styled } from "tamagui";

import { Button, NextLinkAnchor, Text } from "@th/ui";

import { UniverseDust } from "@/app/_components/home/UniverseDust";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { PasskeyFirstMock } from "@/components/auth/mocks/PasskeyFirstMock";
import { ProgressiveDiscloseMock } from "@/components/auth/mocks/ProgressiveDiscloseMock";
import { AudienceSplitMock } from "@/components/auth/mocks/AudienceSplitMock";

type MockId = "passkey" | "progressive" | "audience";

const TabBtn = styled(Button, {
  name: "MockTab",
  size: "$2",
  variant: "ghost",
  borderRadius: 0,
  paddingHorizontal: "$3",
  paddingVertical: "$2",
  variants: {
    active: {
      true: {
        backgroundColor: "$surface",
        borderBottomWidth: 2,
        borderBottomColor: "$brandSecondary",
      },
    },
  } as const,
});

const MOCKS: Array<{
  id: MockId;
  label: string;
  description: string;
  render: () => ReactElement;
}> = [
  {
    id: "passkey",
    label: "Passkey-first",
    description:
      "WebAuthn promoted as the primary CTA, password collapsed to a fallback.",
    render: () => <PasskeyFirstMock />,
  },
  {
    id: "progressive",
    label: "Progressive disclosure",
    description:
      "Email first, then route to passkey / magic link / password based on what the account has.",
    render: () => <ProgressiveDiscloseMock />,
  },
  {
    id: "audience",
    label: "Audience split",
    description:
      "Buyers get magic-link guest checkout; organisers get the full credentialed flow.",
    render: () => <AudienceSplitMock />,
  },
];

export default function SignInPreviewPage() {
  const [active, setActive] = useState<MockId>("passkey");
  const current = MOCKS.find((m) => m.id === active) ?? MOCKS[0];

  useDocumentTitle(`Sign-in preview · ${current.label}`);

  return (
    <YStack
      minHeight="100vh"
      alignItems="center"
      justifyContent="flex-start"
      padding="$6"
      gap="$6"
      backgroundColor="$background"
      position="relative"
      overflow="hidden"
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
          backgroundImage:
            "linear-gradient(rgba(231, 206, 150, 0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(231, 206, 150, 0.04) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
        }}
      >
        <UniverseDust />
      </div>

      <YStack
        width="100%"
        maxWidth={960}
        gap="$4"
        position="relative"
        zIndex={1}
      >
        <XStack justifyContent="space-between" alignItems="center">
          <YStack gap="$1">
            <Text
              fontFamily="$mono"
              fontSize={11}
              color="$brandSecondary"
              letterSpacing={1.8}
              textTransform="uppercase"
            >
              00. mocks
            </Text>
            <Text
              variant="h3"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={-0.5}
            >
              Sign-in patterns
            </Text>
          </YStack>
          <Button variant="ghost" asChild size="$2">
            <NextLinkAnchor href="/sign-in">
              ← Back to live sign-in
            </NextLinkAnchor>
          </Button>
        </XStack>

        <XStack
          gap={0}
          borderWidth={2}
          borderColor="$borderColor"
          backgroundColor="$surface"
        >
          {MOCKS.map((m, i) => (
            <TabBtn
              key={m.id}
              active={active === m.id}
              onPress={() => setActive(m.id)}
              borderRightWidth={i < MOCKS.length - 1 ? 2 : 0}
              borderRightColor="$borderColor"
              flex={1}
            >
              <Text
                variant="bodySmall"
                weight="bold"
                textTransform="uppercase"
                letterSpacing={1}
              >
                {m.label}
              </Text>
            </TabBtn>
          ))}
        </XStack>

        <Text variant="bodySmall" color="$colorMuted" maxWidth={640}>
          {current.description}
        </Text>

        <YStack alignItems="center" paddingTop="$4">
          {current.render()}
        </YStack>
      </YStack>
    </YStack>
  );
}
