"use client";

import { useState } from "react";
import { XStack, YStack, styled } from "tamagui";
import { Fingerprint, KeyRound, ChevronDown, ChevronUp } from "lucide-react";

import { Button, LabeledPasswordInput, LabeledTextInput, Text } from "@th/ui";

import { AuthCardShell } from "../AuthCardShell";
import { OAuthProviderButtons } from "../OAuthProviderButtons";

const Hint = styled(Text, {
  name: "PasskeyHint",
  fontSize: 11,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "$colorMuted",
});

/** Passkey-first sign-in card. The big CTA pushes users toward WebAuthn. */
export const PasskeyFirstMock = () => {
  const [showFallback, setShowFallback] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  return (
    <AuthCardShell testId="mock-passkey-first">
      <YStack gap="$5">
        <YStack gap="$2">
          <Hint>01. recommended</Hint>
          <Text
            variant="h4"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={-0.5}
          >
            Sign in with passkey
          </Text>
          <Text variant="bodySmall" color="$colorMuted">
            Use Touch ID, Face ID, or your security key. No password needed.
          </Text>
        </YStack>

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

        <OAuthProviderButtons
          disabled={false}
          loading={null}
          onPress={() => {}}
          testIdPrefix="mock-passkey"
        />
      </YStack>

      <YStack gap="$3">
        <XStack
          justifyContent="space-between"
          alignItems="center"
          paddingTop="$3"
          borderTopWidth={2}
          borderTopColor="$borderColor"
          cursor="pointer"
          onPress={() => setShowFallback((v) => !v)}
        >
          <XStack gap="$2" alignItems="center">
            <KeyRound size={14} color="var(--colorMuted)" />
            <Text
              variant="bodySmall"
              weight="bold"
              color="$colorMuted"
              textTransform="uppercase"
              letterSpacing={1}
            >
              Use password instead
            </Text>
          </XStack>
          {showFallback ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </XStack>

        {showFallback ? (
          <YStack gap="$4">
            <LabeledTextInput
              label="EMAIL OR USERNAME"
              id="mock-pk-email"
              name="email"
              value={identifier}
              onChangeText={setIdentifier}
              placeholder="you@example.com"
              autoComplete="email"
              autoCapitalize="none"
              height={52}
              paddingHorizontal={16}
              fontSize={16}
              borderWidth={2}
            />
            <LabeledPasswordInput
              label="PASSWORD"
              id="mock-pk-password"
              name="password"
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              autoComplete="current-password"
              autoCapitalize="none"
              minHeight={52}
              paddingHorizontal={16}
              fontSize={16}
              borderWidth={2}
              toggleLabel="Toggle password visibility"
            />
            <Button
              size="$4"
              variant="outlined"
              borderWidth={2}
              borderColor="$borderColorStrong"
            >
              <Text
                tone="inherit"
                weight="bold"
                textTransform="uppercase"
                letterSpacing={1}
              >
                Sign in
              </Text>
            </Button>
          </YStack>
        ) : null}
      </YStack>
    </AuthCardShell>
  );
};

PasskeyFirstMock.displayName = "PasskeyFirstMock";
