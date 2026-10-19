"use client";

import type { ReactNode } from "react";
import { YStack, XStack, styled } from "tamagui";
import {
  Button,
  Text,
  Spinner,
  Separator,
  useTranslations,
} from "@th/ui";
import {
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from "lucide-react";

import { WARNING } from "@/lib/design-tokens";

import { isForbiddenError } from "../_lib/is-forbidden-error";
import { ChargebackTermsSection } from "./ChargebackTermsSection";
import {
  DisclosureButton,
  PayoutsRoleNotice,
  StripeSetupInBalancePointer,
} from "./PayoutsSections";
import type { StripeAccount } from "./use-stripe-account";

// ─────────────────────────────────────────────────────────────────────────────
// The Stripe Connect surfaces of the Payouts page (moved from the retired
// PaymentsView). Two renderers, one hook, and the CTA on the page EXACTLY ONCE:
//
//   - `StripeSetupCard` — NOT connected. Sits at the top of Balance, because
//     nothing else on the page can happen until it does.
//   - `StripeIncompleteBanner` — connected but INCOMPLETE, on the Payouts
//     page (board B, 2026-10-14): a warning banner at the top of Balance with
//     what Stripe reports, what is still needed and the continue CTA.
//   - `StripeSettingsRow` — the Payouts page's Settings row (board B): the
//     status in one line plus a "Details" disclosure; it points up at the
//     setup card or the banner, never a second CTA.
//   - `StripeAccountSection` — the account-settings Payouts block. Connected
//     (incomplete or complete) it is the Connect card with its status rows
//     and the continue-onboarding CTA; not connected it only points up at the
//     setup card.
//
// RBAC:
//  - initiateOnboarding     → ORG_FINANCE_ROLES                → canFinance
//  - createLoginLink        → ORG_FINANCE_ROLES                → canFinance
//    (the "Stripe Dashboard" button in PayoutsView's header; an EDITOR reads
//    the status here but is not offered the link)
//  - orgs.acceptChargebackTerms → ORG_ADMIN_ROLES → canManage (narrower than
//    canFinance: a FINANCE member may start onboarding but cannot accept the
//    terms onboarding requires, so they see who can — `canAcceptTerms`).
//  - stripeConnect.getStatus → ORG_EDIT_OR_FINANCE_ROLES: a VIEWER who opens
//    the page by URL gets a role notice (FORBIDDEN), not the error card.
// ─────────────────────────────────────────────────────────────────────────────

export const StripeCard = styled(YStack, {
  name: "StripeAccountCard",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColor",
  padding: "$5",
  gap: "$4",
});

const InfoRow = styled(XStack, {
  name: "InfoRow",
  justifyContent: "space-between",
  alignItems: "center",
  paddingVertical: "$2",
});

/**
 * Not connected → Stripe setup is the stripe section's only state where the
 * CTA moves to the top of the page. Callers branch on this ONE predicate so
 * the setup card and the section's pointer can never both be missing or both
 * carry the button.
 *
 * Keyed on DATA, not on `error`: a first-load failure has no `status`, so it
 * is false here and no setup button renders anywhere; a failed REFETCH keeps
 * React Query's last `status`, so the page keeps rendering what it knew.
 */
export function stripeSetupAtTop(stripe: StripeAccount): boolean {
  return Boolean(stripe.status) && !stripe.status!.connected;
}

/**
 * Connected but not fully set up: on the Payouts page the continue-onboarding
 * CTA moves into the banner at the top (`StripeIncompleteBanner`), and the
 * Stripe account section points up at it. Same rule as `stripeSetupAtTop`:
 * keyed on data, so a first-load failure offers nothing anywhere. The two
 * predicates never hold together (connected vs not).
 */
export function stripeIncompleteAtTop(stripe: StripeAccount): boolean {
  return Boolean(stripe.status?.connected) && !stripe.isFullyConnected;
}

/** First load failed: nothing is known, so nothing may be offered. */
export function stripeStatusUnknown(stripe: StripeAccount): boolean {
  return Boolean(stripe.statusQuery.error) && !stripe.status;
}

/**
 * The section heading's right-hand badge (Connected / Incomplete / Not
 * connected), once the status is known. Nothing while loading, after a failed
 * first read or for a role that cannot read it: no badge rather than a guess.
 */
export function StripeConnectionBadge({ stripe }: { stripe: StripeAccount }) {
  const t = useTranslations();
  const { status } = stripe;
  if (stripe.statusQuery.isLoading || !status) return null;
  // Connected is not set up: an unfinished account says Incomplete, never a
  // green "Connected" beside a notice asking for more details.
  if (status.connected && !stripe.isFullyConnected) {
    return (
      <StatusLabel tone="warning">
        {String(t("admin.stripeIncomplete"))}
      </StatusLabel>
    );
  }
  return status.connected ? (
    <StatusLabel tone="success">{String(t("admin.connected"))}</StatusLabel>
  ) : (
    <StatusLabel tone="neutral">
      {String(t("admin.stripeNotConnected"))}
    </StatusLabel>
  );
}

const STATUS_LABEL_COLOR = {
  success: "$success",
  warning: "$warning",
  neutral: "$colorMuted",
} as const;

/**
 * A strict-Swiss status label: a 1px rule and an overline in the theme's own
 * status colour, no fill. Not the `@th/ui` Badge: its soft tones read a
 * module-scope palette (#22C55E, the yellow family) whatever the theme, which
 * on Stub's cream is under AA. The theme tokens track the theme: Stub's
 * `$success` #166534 and `$warning` #92400E on cream, Ember's brighter pair
 * on navy.
 */
function StatusLabel({
  tone,
  children,
}: {
  tone: keyof typeof STATUS_LABEL_COLOR;
  children: ReactNode;
}) {
  const color = STATUS_LABEL_COLOR[tone];
  return (
    <XStack
      data-testid="stripe-connection-badge"
      data-tone={tone}
      borderWidth={1}
      borderColor={tone === "neutral" ? "$borderColor" : color}
      borderRadius={0}
      paddingHorizontal="$2"
      paddingVertical={2}
      alignItems="center"
      flexShrink={0}
    >
      <Text variant="overline" weight="bold" color={color}>
        {children}
      </Text>
    </XStack>
  );
}

/** A small placeholder while the Stripe status read is in flight. */
export function StripeStatusSkeleton({ height = 48 }: { height?: number }) {
  return (
    <YStack
      height={height}
      backgroundColor="$borderColorSoft"
      opacity={0.35}
      aria-busy
      data-testid="stripe-status-skeleton"
    />
  );
}

/**
 * Inline, beside data we still show: the last refetch failed, or the server
 * could not reach Stripe and answered with the last-known record. Either way
 * what is on screen is what we last knew.
 */
function RefreshFailedLine({ stripe }: { stripe: StripeAccount }) {
  const t = useTranslations();
  const refetchFailed = Boolean(stripe.statusQuery.error && stripe.status);
  if (!refetchFailed && !stripe.stripeUnreachable) return null;
  return (
    <Text
      variant="caption"
      tone="muted"
      data-testid="stripe-status-refresh-failed"
    >
      {String(t("admin.payoutsStripeRefreshFailed"))}
    </Text>
  );
}

/**
 * Strings a caller may swap for its audience. Omitted keys keep the Payouts
 * page's wording (organizers selling tickets); the account-settings Payouts
 * block passes a person's resale wording. Already-translated strings, so the
 * keys stay greppable at the call site.
 */
export type StripeSectionCopy = {
  setupTitle?: string;
  setupBody?: string;
  incompleteBody?: string;
  activeBody?: string;
  /** The first-time Connect button ("Set up Stripe Connect" by default). */
  connectCta?: string;
};

/**
 * The renderers' outer box. `framed` (the default, the Payouts page) is the
 * bordered StripeCard; unframed is a bare stack for a caller that already sits
 * in a card of its own (account settings), so content never nests a card in a
 * card. A danger frame stays a 2px notice border either way: it is the error
 * signal, not chrome.
 */
function Frame({
  framed,
  danger = false,
  testId,
  children,
}: {
  framed: boolean;
  danger?: boolean;
  testId: string;
  children: ReactNode;
}) {
  if (framed) {
    return (
      <StripeCard
        data-testid={testId}
        {...(danger ? { borderColor: "$danger" } : {})}
      >
        {children}
      </StripeCard>
    );
  }
  return (
    <YStack
      gap="$4"
      data-testid={testId}
      {...(danger
        ? {
            borderWidth: 2,
            borderColor: "$danger",
            borderRadius: 0,
            padding: "$3",
          }
        : {})}
    >
      {children}
    </YStack>
  );
}

type GateProps = {
  stripe: StripeAccount;
  canFinance: boolean;
  variant: "start" | "continue";
  connectCta?: string;
};

/** Terms gate + the one onboarding button, shared by both renderers. */
function OnboardingGate({
  stripe,
  canFinance,
  variant,
  connectCta,
}: GateProps) {
  const t = useTranslations();
  const { owner, terms } = stripe;
  if (!canFinance || !owner) return null;
  return (
    <>
      <ChargebackTermsSection
        ownerKind={owner.kind}
        acceptance={terms.acceptance}
        canAccept={stripe.canAcceptTerms}
        isAccepting={terms.isAccepting}
        error={terms.error}
        loadError={terms.loadError}
        onRetryLoad={terms.retryLoad}
        onAccept={() => {
          void terms.accept();
        }}
      />
      <Button
        variant="primary"
        onPress={() => {
          void stripe.startOnboarding();
        }}
        disabled={stripe.isStartingOnboarding || !stripe.termsAccepted}
        data-testid={
          variant === "start" ? "stripe-connect-start" : "stripe-connect-continue"
        }
      >
        {stripe.isStartingOnboarding ? (
          <Spinner size="sm" />
        ) : (
          <ExternalLink size={16} />
        )}
        {stripe.isStartingOnboarding
          ? String(t("admin.startingOnboarding"))
          : variant === "start"
            ? (connectCta ?? String(t("admin.setupStripeConnect")))
            : String(t("admin.continueOnboarding"))}
      </Button>
    </>
  );
}

function NoticeBox({
  tone,
  title,
  body,
}: {
  tone: "warning" | "success";
  title: string;
  body: string;
}) {
  return (
    <YStack
      gap="$2"
      padding="$3"
      borderRadius={0}
      borderWidth={2}
      borderColor={tone === "warning" ? "$warning" : "$success"}
      backgroundColor="$backgroundHover"
    >
      <XStack gap="$2" alignItems="center">
        {tone === "warning" ? (
          <AlertTriangle size={16} color="var(--warning, #92400E)" />
        ) : (
          <CheckCircle2 size={16} color="var(--success, #166534)" />
        )}
        <Text variant="body" weight="medium">
          {title}
        </Text>
      </XStack>
      <Text variant={tone === "warning" ? "bodySmall" : "caption"} tone="muted">
        {body}
      </Text>
    </YStack>
  );
}

/** Board B: the setup card at the top of Balance. */
export function StripeSetupCard({
  stripe,
  canFinance,
  copy,
  framed = true,
}: {
  stripe: StripeAccount;
  canFinance: boolean;
  copy?: StripeSectionCopy;
  framed?: boolean;
}) {
  const t = useTranslations();
  return (
    <Frame framed={framed} testId="stripe-setup-card">
      <NoticeBox
        tone="warning"
        title={copy?.setupTitle ?? String(t("admin.payoutsStripeSetupTitle"))}
        body={copy?.setupBody ?? String(t("admin.payoutsStripeSetupBody"))}
      />
      <OnboardingGate
        stripe={stripe}
        canFinance={canFinance}
        variant="start"
        connectCta={copy?.connectCta}
      />
    </Frame>
  );
}

export function StripeAccountSection({
  stripe,
  canFinance,
  copy,
  framed = true,
}: {
  stripe: StripeAccount;
  canFinance: boolean;
  copy?: StripeSectionCopy;
  framed?: boolean;
}) {
  const t = useTranslations();
  const { status, isFullyConnected } = stripe;
  // On a test server the dev capability override can switch charges and
  // payouts on for an account Stripe has not enabled. The rows state what
  // Stripe reports, never the override; a `null` Stripe value (Stripe was
  // unreachable) renders as unknown, so no `??` fallback to the row here.
  const override = status?.capabilityOverride ?? null;

  if (stripe.statusQuery.isLoading) {
    return <StripeStatusSkeleton height={120} />;
  }

  // A role that cannot read the status (VIEWER, by URL): a plain notice. It
  // is not an outage, so no error styling and no Retry.
  if (isForbiddenError(stripe.statusQuery.error) && !status) {
    return (
      <PayoutsRoleNotice kind="account" testId="stripe-status-role-notice" />
    );
  }

  // A FIRST-LOAD failure must not invite anyone to "set up" an account that
  // may well exist: no CTA anywhere, just the failure and a retry. (A failed
  // refetch keeps `status` and falls through to the card it describes.)
  if (stripeStatusUnknown(stripe)) {
    return <StripeStatusError stripe={stripe} framed={framed} />;
  }

  if (!status) return null;

  if (stripeSetupAtTop(stripe)) {
    return (
      <YStack gap="$2">
        <StripeSetupInBalancePointer />
        <RefreshFailedLine stripe={stripe} />
      </YStack>
    );
  }

  return (
    <Frame framed={framed} testId="stripe-account-card">
      {/* No heading of its own: the section's "Stripe account" h2 names
          it, and the Connected badge sits on that heading's row
          (StripeConnectionBadge). */}
      <RefreshFailedLine stripe={stripe} />

      {/* ── Connected but incomplete ─────────────────────────── */}
      {!isFullyConnected && (
        <YStack gap="$4">
          <NoticeBox
            tone="warning"
            title={String(t("admin.onboardingIncomplete"))}
            body={
              copy?.incompleteBody ??
              String(t("admin.onboardingIncompleteDescription"))
            }
          />

          <YStack gap="$1">
            <StatusRow
              label={String(t("admin.chargesEnabled"))}
              value={
                override ? override.stripeChargesEnabled : status.chargesEnabled
              }
            />
            <StatusRow
              label={String(t("admin.payoutsEnabled"))}
              value={
                override ? override.stripePayoutsEnabled : status.payoutsEnabled
              }
            />
            {/* Our `payoutsEnabled` is stricter than Stripe's: it also
                requires the transfers capability, and it reflects our own
                record when a sync was refused. Without this line the
                organizer sees "No" next to an empty requirements list while
                Stripe's dashboard says yes, and has nothing to act on. */}
            <PayoutsBlockedReasonLine stripe={stripe} />
            <StatusRow
              label={String(t("admin.detailsSubmitted"))}
              value={status.detailsSubmitted}
            />
            {/* After ALL the status rows: it says "the rows above". */}
            <CapabilityOverrideNote stripe={stripe} />
          </YStack>

          <RequirementsList
            stripe={stripe}
            label={String(t("admin.remainingRequirements"))}
          />

          {/* Re-entering onboarding (expired link, incomplete account) is
              gated the same way — a stale-version acceptance is refused
              until the owner re-accepts the current text. */}
          <OnboardingGate
            stripe={stripe}
            canFinance={canFinance}
            variant="continue"
          />
        </YStack>
      )}

      {/* ── Fully connected ──────────────────────────────────── */}
      {isFullyConnected && (
        <YStack gap="$4">
          <NoticeBox
            tone="success"
            title={String(t("admin.accountFullySetUp"))}
            body={
              copy?.activeBody ?? String(t("admin.accountActiveDescription"))
            }
          />

          <Separator />

          <YStack gap="$1">
            <StatusRow
              label={String(t("admin.chargesEnabled"))}
              value={status.chargesEnabled}
            />
            <StatusRow
              label={String(t("admin.payoutsEnabled"))}
              value={status.payoutsEnabled}
            />
            <StatusRow
              label={String(t("admin.detailsSubmitted"))}
              value={status.detailsSubmitted}
            />
          </YStack>
        </YStack>
      )}
    </Frame>
  );
}

/**
 * Our `payoutsEnabled` is stricter than Stripe's: it also requires the
 * transfers capability, and it reflects our own record when a sync was
 * refused. Without this line the organizer sees "No" next to an empty
 * requirements list while Stripe's dashboard says yes, and has nothing to
 * act on.
 */
function PayoutsBlockedReasonLine({ stripe }: { stripe: StripeAccount }) {
  const t = useTranslations();
  const reason = stripe.status?.payoutsBlockedReason;
  if (!reason) return null;
  return (
    <Text variant="caption" tone="muted">
      {String(
        t(
          reason === "account_restricted"
            ? "admin.payoutsBlockedRestricted"
            : "admin.payoutsBlockedTransfers",
        ),
      )}
    </Text>
  );
}

/** A test server's capability override is standing in: say so. */
function CapabilityOverrideNote({ stripe }: { stripe: StripeAccount }) {
  const t = useTranslations();
  if (!stripe.status?.capabilityOverride) return null;
  return (
    <Text
      variant="caption"
      tone="muted"
      data-testid="stripe-capability-override-note"
    >
      {String(t("admin.payoutsStripeOverrideNote"))}
    </Text>
  );
}

/** What Stripe still wants, each key once (a past-due key is also due). */
function RequirementsList({
  stripe,
  label,
}: {
  stripe: StripeAccount;
  label: string;
}) {
  const requirements = stripe.status?.requirements;
  if (!requirements) return null;
  const keys = Array.from(
    new Set([...requirements.pastDue, ...requirements.currentlyDue]),
  );
  if (keys.length === 0) return null;
  return (
    <YStack gap="$1" data-testid="stripe-requirements">
      <Text variant="caption" weight="bold" tone="muted">
        {label}
      </Text>
      {keys.map((req) => (
        <Text key={req} variant="caption" tone="muted">
          {"•"} {formatRequirement(req)}
        </Text>
      ))}
    </YStack>
  );
}

/** One "Charges ✓ on" fact for the banner's state line. */
function StateFact({
  label,
  value,
  onKey = "admin.payoutsStripeStateOn",
  offKey = "admin.payoutsStripeStateOff",
}: {
  label: string;
  value: boolean | null;
  onKey?: string;
  offKey?: string;
}) {
  const t = useTranslations();
  return (
    <XStack gap="$1" alignItems="center" data-testid="stripe-state-fact">
      <Text variant="caption">{label}</Text>
      {value === null ? null : value ? (
        <CheckCircle2 size={12} color="var(--success, #166534)" aria-hidden />
      ) : (
        <XCircle size={12} color="var(--danger, #B91C1C)" aria-hidden />
      )}
      <Text variant="caption" weight="bold" tone={value ? "default" : "muted"}>
        {String(
          t(
            value === null ? "admin.payoutsStatusUnknown" : value ? onKey : offKey,
          ),
        )}
      </Text>
    </XStack>
  );
}

/**
 * Board B, 2026-10-14: an incomplete Stripe account takes the top of the
 * Payouts page. What Stripe reports (charges · payouts · details, on one
 * line), what is still needed, and the ONE continue-onboarding CTA; the
 * Stripe account section below only points up here. It never says "set up".
 *
 * The lead line is chosen from the same status the batch reads
 * (`payoutsEnabled`): "paused" only when the batch really will skip this
 * payee. A test server's override can keep payouts flowing while Stripe
 * still wants details, and then the line says only that.
 */
export function StripeIncompleteBanner({
  stripe,
  canFinance,
}: {
  stripe: StripeAccount;
  canFinance: boolean;
}) {
  const t = useTranslations();
  const { status } = stripe;
  if (!status || !stripeIncompleteAtTop(stripe)) return null;
  // The rows state what Stripe reports, never the dev override.
  const override = status.capabilityOverride ?? null;
  const charges = override ? override.stripeChargesEnabled : status.chargesEnabled;
  const payouts = override ? override.stripePayoutsEnabled : status.payoutsEnabled;
  const paused = !status.payoutsEnabled;
  return (
    <YStack
      gap="$2"
      paddingVertical="$3"
      paddingHorizontal="$4"
      borderWidth={2}
      borderLeftWidth={6}
      borderColor="$warning"
      borderRadius={0}
      backgroundColor="$surface"
      data-testid="stripe-incomplete-banner"
    >
      <XStack gap="$2" alignItems="center">
        <AlertTriangle size={16} color={WARNING} aria-hidden />
        <Text variant="overline" tone="warning" tag="h3">
          {String(t("admin.payoutsStripeIncompleteTitle"))}
        </Text>
      </XStack>
      <Text variant="body" weight="bold">
        {String(
          t(
            !paused
              ? "admin.payoutsStripeIncompleteNeedsDetails"
              : status.payoutsBlockedReason
                ? // The reason line below names the cause; "until Stripe has
                  // more details" might not be it.
                  "admin.payoutsStripeIncompletePausedShort"
                : "admin.payoutsStripeIncompletePaused",
          ),
        )}
      </Text>
      <RefreshFailedLine stripe={stripe} />
      <XStack gap="$3" flexWrap="wrap" rowGap="$1">
        <StateFact label={String(t("admin.payoutsStripeStateCharges"))} value={charges} />
        <StateFact label={String(t("admin.payoutsStripeStatePayouts"))} value={payouts} />
        <StateFact
          label={String(t("admin.payoutsStripeStateDetails"))}
          value={status.detailsSubmitted}
          onKey="admin.payoutsStripeStateSubmitted"
          offKey="admin.payoutsStripeStateNotSubmitted"
        />
      </XStack>
      <PayoutsBlockedReasonLine stripe={stripe} />
      <CapabilityOverrideNote stripe={stripe} />
      <RequirementsList
        stripe={stripe}
        label={String(t("admin.payoutsStripeStillNeeded"))}
      />
      {/* Re-entering onboarding is gated like the first start: a
          stale-version acceptance is refused until the current text is
          accepted again. */}
      <OnboardingGate stripe={stripe} canFinance={canFinance} variant="continue" />
    </YStack>
  );
}

/** A first-load failure: the error and a retry, and nothing offered. */
function StripeStatusError({
  stripe,
  framed,
}: {
  stripe: StripeAccount;
  framed: boolean;
}) {
  const t = useTranslations();
  return (
    <Frame framed={framed} danger testId="stripe-status-error">
      <XStack gap="$2" alignItems="center">
        <XCircle size={18} color="var(--danger, #B91C1C)" />
        <Text variant="body" tone="error">
          {String(t("admin.payoutsStripeLoadFailed"))}
        </Text>
      </XStack>
      <XStack>
        <Button
          variant="secondary"
          size="$3"
          onPress={() => {
            void stripe.statusQuery.refetch();
          }}
          disabled={stripe.statusQuery.isFetching}
          data-testid="stripe-status-retry"
        >
          {String(t("admin.retry"))}
        </Button>
      </XStack>
    </Frame>
  );
}

/** DOM id of the Stripe row's disclosed details (`aria-controls`). */
export const STRIPE_DETAILS_ID = "payouts-stripe-details";

/**
 * Board B, 2026-10-14: the Stripe account row of the Payouts page's Settings
 * band. One line for the state, and "Details" disclosing what Stripe reports
 * (charges, payouts, details submitted) with the account ID.
 *
 *   loading         a slim placeholder
 *   VIEWER          the role notice (FORBIDDEN is not an outage)
 *   first-load fail the error and its retry, here, and no CTA anywhere
 *   not connected   points up at the setup card
 *   incomplete      points up at the banner; Details still has the rows
 *   complete        "Payments and payouts on · acct_…"
 *
 * Never a CTA: the one onboarding button lives at the top of the page. And
 * no state that needs fixing is left to the folded details — not connected
 * and incomplete each have their card at the top, and a failed read is shown
 * in the row — so the details never need to open themselves.
 */
export function StripeSettingsRow({
  stripe,
  detailsOpen,
  onDetailsOpenChange,
}: {
  stripe: StripeAccount;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  const { status, isFullyConnected } = stripe;

  if (stripe.statusQuery.isLoading) return <StripeStatusSkeleton />;
  if (isForbiddenError(stripe.statusQuery.error) && !status) {
    return (
      <PayoutsRoleNotice kind="account" testId="stripe-status-role-notice" />
    );
  }
  if (stripeStatusUnknown(stripe)) {
    return <StripeStatusError stripe={stripe} framed={false} />;
  }
  if (!status) return null;
  if (!status.connected) {
    return (
      <YStack gap="$2">
        <StripeSetupInBalancePointer />
        <RefreshFailedLine stripe={stripe} />
      </YStack>
    );
  }

  // The rows state what Stripe reports, never the dev override.
  const override = status.capabilityOverride ?? null;

  return (
    <YStack gap="$3" data-testid="stripe-settings-row">
      {isFullyConnected ? (
        <Text variant="body" data-testid="stripe-settings-line">
          {String(t("admin.payoutsStripeLineOn"))}
          {status.stripeAccountId ? (
            <>
              {" \u00b7 "}
              <Text variant="caption" fontFamily="$mono">
                {status.stripeAccountId}
              </Text>
            </>
          ) : null}
        </Text>
      ) : (
        <StripeSetupInBalancePointer />
      )}
      <RefreshFailedLine stripe={stripe} />
      <DisclosureButton
        open={detailsOpen}
        onToggle={() => onDetailsOpenChange(!detailsOpen)}
        controlsId={STRIPE_DETAILS_ID}
        label={String(t("admin.payoutsStripeDetails"))}
        // Visible "Details", named in full: the page may hold other
        // disclosures, and each needs its own name.
        accessibleName={String(t("admin.payoutsStripeDetailsName"))}
        testId="stripe-details-toggle"
      />
      <YStack
        id={STRIPE_DETAILS_ID}
        gap="$1"
        display={detailsOpen ? "flex" : "none"}
        data-testid="stripe-details"
        data-open={detailsOpen ? "true" : "false"}
      >
        {detailsOpen && (
          <>
            <StatusRow
              label={String(t("admin.chargesEnabled"))}
              value={
                override ? override.stripeChargesEnabled : status.chargesEnabled
              }
            />
            <StatusRow
              label={String(t("admin.payoutsEnabled"))}
              value={
                override ? override.stripePayoutsEnabled : status.payoutsEnabled
              }
            />
            <PayoutsBlockedReasonLine stripe={stripe} />
            <StatusRow
              label={String(t("admin.detailsSubmitted"))}
              value={status.detailsSubmitted}
            />
            <CapabilityOverrideNote stripe={stripe} />
            <AccountIdRow stripe={stripe} />
          </>
        )}
      </YStack>
    </YStack>
  );
}

/** The connected account's ID; nothing before an account exists. */
function AccountIdRow({ stripe }: { stripe: StripeAccount }) {
  const t = useTranslations();
  const id = stripe.status?.connected ? stripe.status.stripeAccountId : null;
  if (!id) return null;
  return (
    <InfoRow gap="$3" flexWrap="wrap" data-testid="stripe-account-id">
      <Text variant="caption" tone="muted">
        {String(t("admin.accountId"))}
      </Text>
      <Text variant="caption" fontFamily="$mono">
        {id}
      </Text>
    </InfoRow>
  );
}

/** `null` = Stripe gave no answer (unreachable): say so, never a guess. */
function StatusRow({ label, value }: { label: string; value: boolean | null }) {
  const t = useTranslations();
  if (value === null) {
    return (
      <InfoRow>
        <Text variant="caption" tone="muted">
          {label}
        </Text>
        <Text variant="caption" color="$colorMuted">
          {String(t("admin.payoutsStatusUnknown"))}
        </Text>
      </InfoRow>
    );
  }
  return (
    <InfoRow>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <XStack gap="$2" alignItems="center">
        {value ? (
          <CheckCircle2 size={14} color="var(--success, #166534)" />
        ) : (
          <XCircle size={14} color="var(--danger, #B91C1C)" />
        )}
        <Text variant="caption" color={value ? "$color" : "$colorMuted"}>
          {String(
            t(
              value
                ? "admin.payoutsStatusEnabled"
                : "admin.payoutsStatusDisabled",
            ),
          )}
        </Text>
      </XStack>
    </InfoRow>
  );
}

/** Turn Stripe requirement keys like `individual.verification.document` into readable labels. */
function formatRequirement(req: string): string {
  return req
    .replace(/\./g, " › ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
