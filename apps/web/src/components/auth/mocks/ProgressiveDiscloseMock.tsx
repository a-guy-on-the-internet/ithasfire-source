"use client";

import { useState } from "react";
import { XStack, YStack, styled } from "tamagui";
import {
  ArrowRight,
  ArrowLeft,
  Fingerprint,
  Mail,
  KeyRound,
} from "lucide-react";

import { Button, LabeledPasswordInput, LabeledTextInput, Text } from "@th/ui";

import { AuthCardShell } from "../AuthCardShell";

type Step = "identify" | "method";
type DetectedMethod = "passkey" | "magic-link" | "password";

const Hint = styled(Text, {
  name: "ProgHint",
  fontSize: 11,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "$colorMuted",
});

/** Mock detection — would be a server roundtrip in real life. */
function detectMethod(email: string): DetectedMethod {
  const lower = email.trim().toLowerCase();
  if (lower.endsWith("@passkey.dev")) return "passkey";
  if (lower.endsWith("@ithasfire.local")) return "password";
  return "magic-link";
}

/**
 * Slack/Notion-style progressive sign-in: ask for email first, then route to
 * the right credential (passkey > magic link > password) based on what the
 * server reports the user has.
 */
export const ProgressiveDiscloseMock = () => {
  const [step, setStep] = useState<Step>("identify");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const method = detectMethod(email);

  if (step === "identify") {
    return (
      <AuthCardShell testId="mock-progressive-step1">
        <YStack gap="$2">
          <Hint>Step 1 of 2</Hint>
          <Text
            variant="h4"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={-0.5}
          >
            What's your email?
          </Text>
          <Text variant="bodySmall" color="$colorMuted">
            We'll figure out the fastest way to sign you in.
          </Text>
        </YStack>

        <LabeledTextInput
          label="EMAIL"
          id="mock-prog-email"
          name="email"
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          autoComplete="email"
          autoCapitalize="none"
          autoFocus
          height={52}
          paddingHorizontal={16}
          fontSize={16}
          borderWidth={2}
        />

        <Button
          size="$4"
          disabled={!email.includes("@")}
          onPress={() => setStep("method")}
        >
          <XStack gap="$2" alignItems="center" justifyContent="center">
            <Text
              weight="bold"
              color="$onBrandSecondary"
              textTransform="uppercase"
              letterSpacing={1}
            >
              Continue
            </Text>
            <ArrowRight size={16} color="var(--onBrandSecondary, #FFFFFF)" />
          </XStack>
        </Button>

        <XStack
          justifyContent="center"
          paddingTop="$3"
          borderTopWidth={2}
          borderTopColor="$borderColor"
        >
          <Text
            variant="bodySmall"
            color="$colorMuted"
            letterSpacing={1}
            textTransform="uppercase"
            fontSize={11}
          >
            Try @passkey.dev or @ithasfire.local to see the routing
          </Text>
        </XStack>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell testId="mock-progressive-step2">
      <YStack gap="$2">
        <XStack
          alignItems="center"
          gap="$2"
          cursor="pointer"
          onPress={() => setStep("identify")}
        >
          <ArrowLeft size={14} color="var(--colorMuted)" />
          <Hint>{email}</Hint>
        </XStack>
        <Text
          variant="h4"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          {method === "passkey" && "Use your passkey"}
          {method === "magic-link" && "Check your email"}
          {method === "password" && "Enter your password"}
        </Text>
        <Text variant="bodySmall" color="$colorMuted">
          {method === "passkey" && "We detected a passkey for this account."}
          {method === "magic-link" &&
            "We sent a one-time link. Open it on this device."}
          {method === "password" &&
            "Use the password you set when you signed up."}
        </Text>
      </YStack>

      {method === "passkey" ? (
        <Button size="$5">
          <XStack gap="$3" alignItems="center" justifyContent="center">
            <Fingerprint size={22} color="var(--onBrandSecondary, #FFFFFF)" />
            <Text
              weight="bold"
              color="$onBrandSecondary"
              textTransform="uppercase"
              letterSpacing={1}
            >
              Continue with Passkey
            </Text>
          </XStack>
        </Button>
      ) : null}

      {method === "magic-link" ? (
        <YStack
          gap="$3"
          alignItems="center"
          padding="$5"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <Mail size={36} color="var(--brandSecondary)" />
          <Text variant="bodySmall" color="$colorMuted" textAlign="center">
            Waiting for you to open the link…
          </Text>
        </YStack>
      ) : null}

      {method === "password" ? (
        <YStack gap="$4">
          <LabeledPasswordInput
            label="PASSWORD"
            id="mock-prog-password"
            name="password"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            autoComplete="current-password"
            autoCapitalize="none"
            autoFocus
            minHeight={52}
            paddingHorizontal={16}
            fontSize={16}
            borderWidth={2}
            toggleLabel="Toggle password visibility"
          />
          <Button size="$4">
            <Text
              weight="bold"
              color="$onBrandSecondary"
              textTransform="uppercase"
              letterSpacing={1}
            >
              Sign in
            </Text>
          </Button>
        </YStack>
      ) : null}

      <XStack
        justifyContent="center"
        gap="$2"
        paddingTop="$3"
        borderTopWidth={2}
        borderTopColor="$borderColor"
      >
        <KeyRound size={12} color="var(--colorMuted)" />
        <Text
          variant="bodySmall"
          color="$colorMuted"
          letterSpacing={1}
          textTransform="uppercase"
          fontSize={11}
        >
          Try a different sign-in method
        </Text>
      </XStack>
    </AuthCardShell>
  );
};

ProgressiveDiscloseMock.displayName = "ProgressiveDiscloseMock";
