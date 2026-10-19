import { XStack, YStack, styled } from "tamagui";
import { BadgeCheck } from "lucide-react";

import { Badge, Button, Text, useTranslations } from "@th/ui";

import { formatCurrency, formatDateShort } from "@/lib/format";

import { statusKey, type MyMembership } from "../membership-status";

// ─────────────────────────────────────────────────────────────────────────────
// MembershipStatusCard — the "show this to the door" presentable treatment
// for an ACTIVE/TRIALING membership. Strict-Swiss content: radius 0, thick
// structural border, an accent top rule (graphic use of $accent, not text —
// clears the 3:1 non-text floor), no shadow. Tier name is the dominant
// element via a real <h4> so it nests correctly under the page's <h3>.
//
// Deliberately NOT a QR/barcode or a wallet-pass export — this is a status
// display only. Deliberately NOT skeuomorphic (no plastic-card gradients);
// follows the same bordered-block language as TicketStub/Badge elsewhere in
// the v2 system.
// ─────────────────────────────────────────────────────────────────────────────

const CardFrame = styled(YStack, {
  name: "MembershipStatusCard",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  borderTopWidth: 4,
  borderTopColor: "$accent",
  padding: "$5",
  gap: "$3",
});

const MetaRow = styled(XStack, {
  name: "MembershipStatusCardMetaRow",
  gap: "$6",
  flexWrap: "wrap",
});

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <YStack gap={2} minWidth={120}>
      <Text variant="kicker" tone="muted">
        {label}
      </Text>
      <Text variant="body" weight="bold">
        {value}
      </Text>
    </YStack>
  );
}

export interface MembershipStatusCardProps {
  membership: MyMembership;
  onManageBilling: (membershipId: string) => void;
  isManagingBilling: boolean;
}

export function MembershipStatusCard({
  membership,
  onManageBilling,
  isManagingBilling,
}: MembershipStatusCardProps) {
  const t = useTranslations();
  const periodEnd =
    membership.currentPeriodEnd instanceof Date
      ? membership.currentPeriodEnd
      : new Date(membership.currentPeriodEnd);
  const startedAt =
    membership.startedAt instanceof Date
      ? membership.startedAt
      : new Date(membership.startedAt);

  const priceLine = `${formatCurrency(
    membership.tier.priceCents,
    membership.tier.currency,
  )} ${String(
    t(
      membership.tier.interval === "YEAR"
        ? "accountMemberships.perYear"
        : "accountMemberships.perMonth",
    ),
  )}`;

  const renewalLabel = membership.cancelAtPeriodEnd
    ? String(
        t("accountMemberships.endsOn", { date: formatDateShort(periodEnd) }),
      )
    : String(
        t("accountMemberships.renewsOn", {
          date: formatDateShort(periodEnd),
        }),
      );

  const headingId = `membership-${membership.id}-name`;

  return (
    <CardFrame
      tag="article"
      aria-labelledby={headingId}
      data-testid="membership-status-card"
    >
      <XStack justifyContent="space-between" alignItems="flex-start" gap="$2">
        <Badge
          tone="success"
          variant="solid"
          size="sm"
          leadingIcon={<BadgeCheck aria-hidden />}
        >
          {String(t(statusKey(membership.status)))}
        </Badge>
      </XStack>

      <Text
        id={headingId}
        variant="h4"
        letterSpacing={-0.1}
      >
        {membership.tier.name}
      </Text>

      {membership.owner.name && (
        <Text variant="body" tone="muted">
          {membership.owner.name}
        </Text>
      )}

      <MetaRow>
        <MetaItem
          label={String(t("accountMemberships.memberSinceLabel"))}
          value={formatDateShort(startedAt)}
        />
        <MetaItem
          label={String(t("accountMemberships.renewalLabel"))}
          value={renewalLabel}
        />
        <MetaItem
          label={String(t("accountMemberships.priceLabel"))}
          value={priceLine}
        />
      </MetaRow>

      <XStack>
        <Button
          variant="outlined"
          size="$2"
          onPress={() => onManageBilling(membership.id)}
          disabled={isManagingBilling}
          aria-busy={isManagingBilling}
        >
          {String(t("accountMemberships.manageBilling"))}
        </Button>
      </XStack>
    </CardFrame>
  );
}
