"use client";

import { useState } from "react";
import { XStack, YStack, styled } from "tamagui";
import { Ticket, CalendarPlus } from "lucide-react";

import { Button, LabeledTextInput, Text } from "@th/ui";

import { AuthCardShell } from "../AuthCardShell";
import { OAuthProviderButtons } from "../OAuthProviderButtons";

type Audience = "buyer" | "organizer";

const TabButton = styled(YStack, {
  name: "AudienceTab",
  flex: 1,
  padding: "$3",
  gap: "$2",
  cursor: "pointer",
  borderWidth: 2,
  borderColor: "$borderColor",
  alignItems: "center",
  hoverStyle: {
    borderColor: "$borderColorStrong",
  },
  variants: {
    active: {
      true: {
        borderColor: "$brandSecondary",
        // Was a raw rgba(255,87,33,.06) — that is Ember's #FF5721, not Stub's
        // #E2481D, so the tint was off-hue on the shipped theme. `$accentSoft`
        // is the per-theme token for exactly this wash.
        backgroundColor: "$accentSoft",
      },
    },
  } as const,
});

const Hint = styled(Text, {
  name: "AudienceHint",
  fontSize: 11,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "$colorMuted",
});

/**
 * Two-audience sign-in: buyers get a guest-checkout fast path; organizers get
 * the full credentialed flow. Copy + primary CTA reflect the chosen lane.
 */
export const AudienceSplitMock = () => {
  const [audience, setAudience] = useState<Audience>("buyer");
  const [email, setEmail] = useState("");

  return (
    <AuthCardShell testId="mock-audience-split">
      <XStack gap="$3">
        <TabButton
          active={audience === "buyer"}
          onPress={() => setAudience("buyer")}
        >
          <Ticket
            size={20}
            color={
              audience === "buyer"
                ? "var(--brandSecondary, #E2481D)"
                : "var(--colorMuted, #5C544A)"
            }
          />
          <Text
            variant="bodySmall"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={0.8}
          >
            I'm buying tickets
          </Text>
        </TabButton>
        <TabButton
          active={audience === "organizer"}
          onPress={() => setAudience("organizer")}
        >
          <CalendarPlus
            size={20}
            color={
              audience === "organizer"
                ? "var(--brandSecondary, #E2481D)"
                : "var(--colorMuted, #5C544A)"
            }
          />
          <Text
            variant="bodySmall"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={0.8}
          >
            I'm running events
          </Text>
        </TabButton>
      </XStack>

      <YStack gap="$2">
        <Hint>
          {audience === "buyer" ? "fast checkout" : "manage your events"}
        </Hint>
        <Text
          variant="h4"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          {audience === "buyer" ? "Get your ticket" : "Sign in to dashboard"}
        </Text>
        <Text variant="bodySmall" color="$colorMuted">
          {audience === "buyer"
            ? "Drop your email — we'll send a one-time link. No password to remember."
            : "Use the credentials you set up when you created your group."}
        </Text>
      </YStack>

      <LabeledTextInput
        label="EMAIL"
        id={`mock-audience-${audience}-email`}
        name="email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoComplete="email"
        autoCapitalize="none"
        height={52}
        paddingHorizontal={16}
        fontSize={16}
        borderWidth={2}
      />

      <Button size="$4" disabled={!email.includes("@")}>
        <Text
          weight="bold"
          color="$onBrandSecondary"
          textTransform="uppercase"
          letterSpacing={1}
        >
          {audience === "buyer" ? "Email me a link" : "Continue"}
        </Text>
      </Button>

      {audience === "buyer" ? (
        <XStack
          justifyContent="center"
          paddingTop="$3"
          borderTopWidth={2}
          borderTopColor="$borderColor"
        >
          <Text
            variant="bodySmall"
            color="$colorMuted"
            textTransform="uppercase"
            letterSpacing={1}
            fontSize={11}
          >
            Just buying? You don't need an account.
          </Text>
        </XStack>
      ) : (
        <>
          <OAuthProviderButtons
            disabled={false}
            loading={null}
            onPress={() => {}}
            testIdPrefix="mock-audience"
          />
          <XStack
            justifyContent="center"
            paddingTop="$3"
            borderTopWidth={2}
            borderTopColor="$borderColor"
          >
            <Text
              variant="bodySmall"
              color="$colorMuted"
              textTransform="uppercase"
              letterSpacing={1}
              fontSize={11}
            >
              Need an organiser account?
            </Text>
          </XStack>
        </>
      )}
    </AuthCardShell>
  );
};

AudienceSplitMock.displayName = "AudienceSplitMock";
