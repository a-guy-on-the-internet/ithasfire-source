"use client";

import { XStack, YStack } from "tamagui";
import { HelpCircle } from "lucide-react";

import { Text } from "@th/ui";

import { Card, CardLabel } from "./scanner-setup-shared";

const RECOVERY_ITEMS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "No magic-link email",
    body: "Check spam. In the scanner app, tap Resend on the sign-in screen. If still missing, confirm the operator's email matches the one on their org membership.",
  },
  {
    title: "Camera permission denied",
    body: "Open device Settings → Ithas Fire Scanner → Camera and enable access. Restart the app afterwards.",
  },
  {
    title: "Wrong event listed",
    body: "Tap Switch event in scanner settings. If the correct event is missing, re-issue a setup link with the right event preselected.",
  },
  {
    title: "App says 'access denied'",
    body: "The operator does not have a SCANNER+ role on this org. Grant them the SCANNER role under Team, then ask them to sign out and back in.",
  },
  {
    title: "Network drops during a scan",
    body: "The app queues scans locally and syncs when reconnected. Use the web fallback only if the device cannot recover.",
  },
  {
    title: "Still stuck?",
    body: "Contact your event lead — they can re-issue a setup link or escalate to engineering.",
  },
];

export function RecoveryHelpCard() {
  return (
    <Card>
      <YStack gap="$1">
        <XStack gap="$2" alignItems="center">
          <HelpCircle size={18} aria-hidden />
          <CardLabel>05. Recovery & common failures</CardLabel>
        </XStack>
        <Text variant="h4" textTransform="uppercase">
          Mid-shift troubleshooting
        </Text>
      </YStack>
      <YStack gap="$3" tag="ul">
        {RECOVERY_ITEMS.map((item) => (
          <YStack
            key={item.title}
            gap="$1"
            paddingLeft="$3"
            borderLeftWidth={3}
            borderLeftColor="$brandSecondary"
            tag="li"
          >
            <Text variant="body" weight="bold">
              {item.title}
            </Text>
            <Text fontSize="$2" tone="muted">
              {item.body}
            </Text>
          </YStack>
        ))}
      </YStack>
    </Card>
  );
}
