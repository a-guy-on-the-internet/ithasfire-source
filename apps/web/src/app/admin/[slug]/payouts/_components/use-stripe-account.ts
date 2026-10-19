"use client";

import { useMemo } from "react";
import { useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { isChargebackTermsRequiredError } from "@/lib/chargeback-terms-errors";
import { useChargebackTermsAcceptance } from "./chargeback-terms-acceptance";
import {
  ownerInputOf,
  type StripeAccountOwner,
  type StripeAccountSelf,
} from "./stripe-account-owner";

// ─────────────────────────────────────────────────────────────────────────────
// Everything the page knows about the owner's Stripe Connect account, in one
// hook so the two places that render it — the setup card at the top of
// Balance (not connected) and the Stripe account section (connected,
// incomplete or complete) — read one status query and one terms acceptance.
// Moved out of the retired PaymentsView unchanged in behaviour.
// ─────────────────────────────────────────────────────────────────────────────

export {
  ownerInputOf,
  type StripeAccountOwner,
  type StripeAccountSelf,
} from "./stripe-account-owner";

export type StripeAccountCapabilities = {
  canEdit: boolean;
  canManage: boolean;
  canFinance: boolean;
};

export function useStripeAccount(
  owner: StripeAccountOwner | StripeAccountSelf | null,
  { canManage }: StripeAccountCapabilities,
) {
  const { toast } = useNotify();
  const t = useTranslations();

  const statusInput = useMemo(() => {
    if (!owner) return null;
    return ownerInputOf(owner);
  }, [owner]);

  const statusQuery = trpc.stripeConnect.getStatus.useQuery(statusInput!, {
    enabled: Boolean(statusInput),
    staleTime: 30_000,
  });

  const onboardingMutation = trpc.stripeConnect.initiateOnboarding.useMutation({
    meta: { silent: true },
  });

  const loginLinkMutation = trpc.stripeConnect.createLoginLink.useMutation({
    meta: { silent: true },
  });

  // Chargeback / payout-hold terms. `initiateOnboarding` refuses an owner
  // without a CURRENT-version acceptance, so the Connect button stays
  // disabled until one is recorded here — two explicit steps, never chained.
  const terms = useChargebackTermsAcceptance(owner);

  const status = statusQuery.data;
  // What the server's payout and publish gates read: the Payee row's charges
  // and payouts. On a test server the dev capability override can set these
  // for an account Stripe has not enabled, so this is NOT "set up"; use it
  // only where the UI mirrors a gate (e.g. the schedule picker, which the
  // server refuses with PAYEE_NOT_READY on the same row).
  const meetsPayoutGate = Boolean(
    status?.connected && status?.chargesEnabled && status?.payoutsEnabled,
  );
  // The server could not reach Stripe and answered with the last-known row:
  // `detailsSubmitted` is unknown (null). The page shows what it last knew
  // and says so; an unknown is never read as "not submitted".
  const stripeUnreachable = Boolean(
    status?.connected && status.detailsSubmitted === null,
  );
  // "Account fully set up" is a claim about the Stripe account, so it needs
  // Stripe's word: details submitted, and no dev override standing in for
  // charges or payouts Stripe has not enabled. A money screen states only
  // what Stripe reports. When Stripe was unreachable there is no word on
  // details, so the last-known charges and payouts decide.
  const isFullyConnected = Boolean(
    meetsPayoutGate &&
      (status?.detailsSubmitted === true || stripeUnreachable) &&
      status?.capabilityOverride == null,
  );
  // Org accept needs OWNER/ADMIN; the server also withholds the acceptance
  // fields from members outside ORG_FINANCE_ROLES (`forbidden`), and either
  // way the member is told who can accept instead of shown a dead control.
  const canAcceptTerms =
    (owner?.kind === "human" || canManage) &&
    terms.acceptance.status !== "forbidden";
  const termsAccepted = terms.acceptance.status === "current";

  const startOnboarding = async () => {
    if (!owner) return;
    // Root-relative: the API only accepts redirects onto our own origin and
    // resolves a path against PUBLIC_WEB_URL itself. This is the Payouts URL
    // now (fragment excluded), so Stripe sends the account holder back here.
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    try {
      const ownerInput = ownerInputOf(owner);
      const result = await onboardingMutation.mutateAsync({
        ...ownerInput,
        returnUrl: currentUrl,
        refreshUrl: currentUrl,
      });
      window.location.href = result.onboardingUrl;
    } catch (error) {
      // Backstop: the server still wants the terms (race, stale cache, a
      // version bump under us). Re-open the terms inline with the reason —
      // a toast alone would leave a disabled-looking button and no way on.
      if (isChargebackTermsRequiredError(error)) {
        terms.markRequired(String(t("admin.payoutsTermsStillNeeded")));
        return;
      }
      toast.danger({
        id: "onboarding-failed",
        title: t("admin.onboardingFailed") as string,
        message: formatErrorMessage(error, t),
      });
    }
  };

  // Open the connected account's Stripe Express dashboard via a single-use
  // login link. The tab is opened synchronously before the async round-trip
  // so it isn't blocked as a popup.
  const openStripeDashboard = async () => {
    if (!owner || !isFullyConnected) return;
    // Open the placeholder tab WITHOUT "noopener" in the feature string —
    // passing it makes window.open() return null, which previously dropped us
    // into the fallback that navigated the *current* tab while leaving the
    // blank tab orphaned. We get the same security by nulling `opener` on the
    // handle once we have it.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const ownerInput = ownerInputOf(owner);
      const { url } = await loginLinkMutation.mutateAsync(ownerInput);
      if (tab) {
        tab.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (error) {
      tab?.close();
      toast.danger({
        id: "payouts-link-failed",
        title: t("admin.stripeDashboard") as string,
        message: formatErrorMessage(error, t),
      });
    }
  };

  return {
    owner,
    status,
    statusQuery,
    meetsPayoutGate,
    stripeUnreachable,
    isFullyConnected,
    terms,
    canAcceptTerms,
    termsAccepted,
    isStartingOnboarding: onboardingMutation.isPending,
    isOpeningDashboard: loginLinkMutation.isPending,
    startOnboarding,
    openStripeDashboard,
  };
}

export type StripeAccount = ReturnType<typeof useStripeAccount>;
