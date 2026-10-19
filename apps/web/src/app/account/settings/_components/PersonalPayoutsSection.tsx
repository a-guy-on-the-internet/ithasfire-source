"use client";

import { useId } from "react";
import { XStack } from "tamagui";
import { ExternalLink, Landmark } from "lucide-react";
import { Button, Text, useTranslations } from "@th/ui";

import {
  StripeAccountSection,
  StripeConnectionBadge,
  StripeSetupCard,
  stripeSetupAtTop,
  type StripeSectionCopy,
} from "@/app/admin/[slug]/payouts/_components/StripeAccountSection";
import {
  useStripeAccount,
  type StripeAccountCapabilities,
  type StripeAccountSelf,
} from "@/app/admin/[slug]/payouts/_components/use-stripe-account";
import { SectionCard } from "./settings-primitives";

// ─────────────────────────────────────────────────────────────────────────────
// A person's own Stripe Connect account, on the Billing settings page.
//
// Reselling a ticket needs a personal Stripe account with payouts enabled, and
// the resale listing form sends people here to set one up. This is the same
// hook and the same renderers as the Payouts page (`admin/[slug]/payouts`),
// pointed at the signed-in human:
//   - owner `{ kind: "human" }` with no id: the router fills `humanId` from the
//     session, and core refuses any other human, so there is nothing to fetch
//     and nothing to spoof;
//   - the viewer IS the owner, so every capability is true (the org roles
//     these flags stand for do not apply to a person's own account);
//   - onboarding's return/refresh URLs are the current path, so Stripe sends
//     the person back to this page.
// ─────────────────────────────────────────────────────────────────────────────

/** Module-level so the hook's memoised inputs keep a stable identity. */
const SELF: StripeAccountSelf = { kind: "human" };
const SELF_CAPS: StripeAccountCapabilities = {
  canEdit: true,
  canManage: true,
  canFinance: true,
};

export function PersonalPayoutsSection() {
  const t = useTranslations();
  const headingId = useId();
  const stripe = useStripeAccount(SELF, SELF_CAPS);

  const copy: StripeSectionCopy = {
    setupBody: String(t("account.sPayoutsSetupBody")),
    incompleteBody: String(t("account.sPayoutsIncompleteBody")),
    activeBody: String(t("account.sPayoutsActiveBody")),
    connectCta: String(t("account.sPayoutsConnectCta")),
  };

  return (
    <SectionCard
      id="payouts"
      role="region"
      aria-labelledby={headingId}
      data-testid="settings-payouts-section"
    >
      <XStack
        gap="$2"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
      >
        <XStack gap="$2" alignItems="center" flexShrink={1} minWidth={0}>
          <Landmark size={18} color="var(--colorMuted, #5C544A)" aria-hidden />
          <Text variant="h4" weight="bold" id={headingId}>
            {String(t("account.sPayoutsTitle"))}
          </Text>
        </XStack>
        <StripeConnectionBadge stripe={stripe} />
      </XStack>

      <Text variant="caption" tone="muted">
        {String(t("account.sPayoutsDesc"))}
      </Text>

      {/* Not connected → the setup card carries the terms gate and the one
          Connect button. Every other state (loading, first-load error,
          incomplete, ready) is the account section's to render. Unframed:
          this card is already the frame, and content never nests a card in
          a card. */}
      {stripeSetupAtTop(stripe) ? (
        <StripeSetupCard
          stripe={stripe}
          canFinance
          copy={copy}
          framed={false}
        />
      ) : (
        <StripeAccountSection
          stripe={stripe}
          canFinance
          copy={copy}
          framed={false}
        />
      )}

      {stripe.isFullyConnected && (
        <XStack>
          <Button
            variant="secondary"
            size="$3"
            onPress={() => {
              void stripe.openStripeDashboard();
            }}
            disabled={stripe.isOpeningDashboard}
            data-testid="settings-payouts-dashboard"
          >
            {String(t("admin.stripeDashboard"))}
            <ExternalLink size={14} aria-hidden />
          </Button>
        </XStack>
      )}
    </SectionCard>
  );
}
