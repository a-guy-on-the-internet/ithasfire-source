"use client";

import { useState } from "react";
import { XStack, YStack } from "tamagui";
import { AlertTriangle, Send } from "lucide-react";

import { Button, Text, TextInput, useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

import { Card, CardLabel } from "./scanner-setup-shared";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Admin form to send a scanner-app onboarding email. Recipient is identified
 * by email (matched to an existing platform human if one exists, otherwise
 * sent to the raw address). The email contains app-store / TestFlight links
 * and instructions to sign in via the standard scanner magic-link flow.
 *
 * Replaces the previous JWT-bearing "setup link" card whose URL had no
 * consumer in the codebase.
 */
export function SendOnboardingEmailCard({
  orgId,
  canManage,
}: {
  orgId: string;
  canManage: boolean;
}) {
  const t = useTranslations();
  const { toast } = useNotify();
  const [email, setEmail] = useState("");

  const send = trpc.scanner.sendOnboardingEmail.useMutation({
    onSuccess: () => {
      toast.success({ title: "Onboarding email sent" });
      setEmail("");
    },
    onError: (err) => {
      toast.danger({
        title: "Could not send onboarding email",
        message: formatErrorMessage(err, t),
      });
    },
  });

  const trimmed = email.trim().toLowerCase();
  const isEmailValid = EMAIL_RE.test(trimmed);
  const submitDisabled = !isEmailValid || !canManage || send.isPending;

  const handleSubmit = () => {
    if (!isEmailValid) return;
    send.mutate({ orgId, targetEmail: trimmed });
  };

  const inputId = "scanner-onboarding-email";

  return (
    <Card>
      <YStack gap="$1">
        <CardLabel>03. Send onboarding email</CardLabel>
        <Text variant="h4" textTransform="uppercase">
          Invite an operator
        </Text>
        <Text tone="muted" fontSize="$2">
          Sends the scanner-app download links plus sign-in instructions to the
          recipient. Access still comes from their org role on the Team page —
          this email only tells them how to install and sign in.
        </Text>
      </YStack>

      {!canManage && (
        <XStack
          gap="$2"
          alignItems="center"
          padding="$3"
          backgroundColor="$surfaceMuted"
          borderWidth={2}
          borderColor="$borderColor"
        >
          <AlertTriangle size={16} color="var(--brandSecondary)" aria-hidden />
          <Text fontSize="$2" tone="muted">
            Only org Owners and Admins can send onboarding emails.
          </Text>
        </XStack>
      )}

      <YStack gap="$2">
        <TextInput
          id={inputId}
          value={email}
          onChangeText={setEmail}
          placeholder="operator@example.com"
          aria-label="Recipient email"
          spellCheck={false}
          autoComplete="email"
          fullWidth
        />
        <Text fontSize={11} tone="muted">
          Make sure they already have the SCANNER role on this org (set on the
          Team page).
        </Text>
      </YStack>

      <XStack gap="$2" flexWrap="wrap">
        <Button
          onPress={handleSubmit}
          disabled={submitDisabled}
          variant="primary"
          size="$3"
        >
          <Send size={14} aria-hidden />
          {send.isPending ? "Sending…" : "Send onboarding email"}
        </Button>
      </XStack>
    </Card>
  );
}
