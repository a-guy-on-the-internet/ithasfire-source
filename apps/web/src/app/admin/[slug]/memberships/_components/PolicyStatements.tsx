"use client";

import { XStack, YStack } from "tamagui";
import { Text, useTranslations } from "@th/ui";

// ─────────────────────────────────────────────────────────────────────────────
// The two payout policies the spec requires the owner to have ACTIVELY seen at
// membership setup (docs/specs/2026-08-05/completed/recurring-memberships.spec.md,
// "The $2 account fee" + "Dispute policy"):
//
//   1. The $2 Stripe active-account fee — free in ticket-selling months,
//      otherwise deducted from the payout.
//   2. Chargebacks — disputed amount + the card network's dispute fee are
//      debited from payouts.
//
// Rendered LARGE in the setup/empty state and kept visible as a compact note
// once tiers exist, so the statements are never a one-time flash.
// ─────────────────────────────────────────────────────────────────────────────

function PolicyItem({
  title,
  body,
  compact,
}: {
  title: string;
  body: string;
  compact: boolean;
}) {
  return (
    // minWidth is the two-column threshold, not a hard floor: at 320px the
    // admin card leaves this box ~177px of content, so anything above that
    // paints THROUGH the border (measured, not guessed). 150/170 keeps the
    // side-by-side layout on desktop and wraps cleanly on phones.
    <YStack gap="$1" flex={1} minWidth={compact ? 150 : 170}>
      <Text
        variant="label"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontWeight: 700,
          fontSize: compact ? 10 : 11,
        }}
      >
        {title}
      </Text>
      <Text variant={compact ? "bodySmall" : "body"} tone="muted">
        {body}
      </Text>
    </YStack>
  );
}

/**
 * @param compact Dense one-band variant shown above the tier table once tiers
 *   exist. The default (non-compact) variant is the setup-state block.
 */
export function PolicyStatements({ compact = false }: { compact?: boolean }) {
  const t = useTranslations();

  return (
    <YStack
      gap={compact ? "$2" : "$3"}
      padding={compact ? "$3" : "$4"}
      borderWidth={1}
      borderLeftWidth={4}
      borderColor="$borderColor"
      backgroundColor="$surface"
    >
      <Text
        variant="label"
        tone="muted"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          fontWeight: 700,
          fontSize: 10,
        }}
      >
        {String(t("adminMemberships.policyNoteHeading"))}
      </Text>
      <XStack gap={compact ? "$4" : "$5"} flexWrap="wrap">
        <PolicyItem
          title={String(t("adminMemberships.policyFeeTitle"))}
          body={String(t("adminMemberships.policyFeeBody"))}
          compact={compact}
        />
        <PolicyItem
          title={String(t("adminMemberships.policyDisputeTitle"))}
          body={String(t("adminMemberships.policyDisputeBody"))}
          compact={compact}
        />
      </XStack>
    </YStack>
  );
}
