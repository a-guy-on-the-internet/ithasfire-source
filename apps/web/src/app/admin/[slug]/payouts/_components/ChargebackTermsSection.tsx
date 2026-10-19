"use client";

import { useId, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Button, Spinner, Text, useFormatters, useTranslations } from "@th/ui";
import { CheckCircle2, XCircle } from "lucide-react";

import { fmtDateShort } from "@/lib/format";
import {
  CHARGEBACK_TERMS_VERSION,
  ChargebackTermsAcceptCheckbox,
  ChargebackTermsBody,
} from "@/components/payments/ChargebackTermsContent";
import type { ChargebackTermsAcceptance } from "./chargeback-terms-acceptance";

// Desktop bound for the terms body; phones get more room because the
// narrow column wraps each paragraph to many more lines.
const TERMS_MAX_HEIGHT = 240;
const TERMS_MAX_HEIGHT_MOBILE = 320;

export type ChargebackTermsSectionProps = {
  ownerKind: "org" | "human";
  acceptance: ChargebackTermsAcceptance;
  /**
   * Org accept needs OWNER/ADMIN (`ORG_ADMIN_ROLES`), which is narrower than
   * the FINANCE role that may start onboarding — a FINANCE member sees who
   * can accept instead of a dead control.
   */
  canAccept: boolean;
  isAccepting: boolean;
  /** Inline, retryable. Accept failures and the onboarding backstop both land here. */
  error: string | null;
  /** The owner-record read failed — nothing can be decided until it succeeds. */
  loadError?: string | null;
  onRetryLoad?: () => void;
  onAccept: () => void;
};

/**
 * Chargeback / payout-hold terms on the payments page.
 *
 * `unknown`: a compact loading line (no flash of the full terms while the
 * owner record loads). `required` / `forbidden`: the full text in a bounded
 * scroll region, plus the acceptance checkbox and one "Accept terms" action
 * when this member may accept, or a note saying who can. `current`: a
 * one-line mono meta acknowledgement with an expander to read the text
 * again — never the wall of text for someone who already accepted.
 */
export function ChargebackTermsSection({
  ownerKind,
  acceptance,
  canAccept,
  isAccepting,
  error,
  loadError,
  onRetryLoad,
  onAccept,
}: ChargebackTermsSectionProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const reactId = useId();
  const bodyId = `payments-chargeback-terms-${reactId}`;
  const [checked, setChecked] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // A fresh `required` (initial load or the onboarding backstop) always starts
  // unticked — acceptance is a deliberate act each time it is asked for — and
  // a fresh `current` starts collapsed. Reset during render on the transition
  // (React's state-adjustment pattern) so the very first paint of the new
  // state is already correct; an effect would flash the stale tick first.
  const [prevStatus, setPrevStatus] = useState(acceptance.status);
  if (prevStatus !== acceptance.status) {
    setPrevStatus(acceptance.status);
    setChecked(false);
    setExpanded(false);
  }

  const title = String(t("admin.ebChargebackTermsTitle"));
  // A member whose owner record omits the fields cannot accept either.
  const mayAccept = canAccept && acceptance.status !== "forbidden";

  if (acceptance.status === "unknown") {
    return (
      <YStack gap="$2" data-testid="chargeback-terms-loading">
        <Text variant="overline" tone="muted">
          {`${title} · ${CHARGEBACK_TERMS_VERSION}`}
        </Text>
        {loadError ? (
          <YStack
            role="alert"
            padding="$3"
            borderWidth={2}
            borderColor="$danger"
            borderRadius={0}
            backgroundColor="$surfaceMuted"
            gap="$2"
            data-testid="chargeback-terms-load-error"
          >
            <XStack gap="$2" alignItems="center">
              <XCircle
                size={14}
                color="var(--danger, #B91C1C)"
                style={{ flexShrink: 0 }}
                aria-hidden
              />
              <Text variant="bodySmall" tone="error" flexShrink={1} minWidth={0}>
                {loadError}
              </Text>
            </XStack>
            {onRetryLoad && (
              <Button
                variant="ghost"
                size="$3"
                $sm={{ height: 44 }}
                alignSelf="flex-start"
                onPress={onRetryLoad}
                data-testid="chargeback-terms-retry"
              >
                {String(t("admin.refresh"))}
              </Button>
            )}
          </YStack>
        ) : (
          <XStack gap="$2" alignItems="center" role="status">
            <Spinner size="sm" />
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.payoutsTermsChecking"))}
            </Text>
          </XStack>
        )}
      </YStack>
    );
  }

  if (acceptance.status === "current") {
    return (
      <YStack gap="$3" data-testid="chargeback-terms-acknowledged">
        {/* Wrap + shrink so the meta line and the disclosure button stack
            at 320px instead of forcing the card wider. */}
        <XStack gap="$2" alignItems="center" flexWrap="wrap">
          <CheckCircle2
            size={14}
            color="var(--success, #166534)"
            style={{ flexShrink: 0 }}
            aria-hidden
          />
          <Text variant="overline" tone="muted" flexShrink={1} minWidth={0}>
            {String(
              t("admin.payoutsTermsAcceptedLine", {
                title,
                version: acceptance.version,
                date: fmtDateShort(fmt, acceptance.acceptedAt),
              }),
            )}
          </Text>
          <Button
            variant="ghost"
            size="$3"
            $sm={{ height: 44 }}
            onPress={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            aria-controls={expanded ? bodyId : undefined}
            data-testid="chargeback-terms-toggle"
          >
            {String(
              t(expanded ? "admin.payoutsTermsHide" : "admin.payoutsTermsRead"),
            )}
          </Button>
        </XStack>
        {expanded && (
          <ChargebackTermsBody
            frame="box"
            id={bodyId}
            maxHeight={TERMS_MAX_HEIGHT}
            maxHeightMobile={TERMS_MAX_HEIGHT_MOBILE}
            aria-label={title}
            testId="chargeback-terms-body"
          />
        )}
      </YStack>
    );
  }

  return (
    <YStack gap="$3" data-testid="chargeback-terms-section">
      <Text variant="overline" tone="muted">
        {`${title} · ${CHARGEBACK_TERMS_VERSION}`}
      </Text>
      <Text variant="bodySmall" tone="muted">
        {mayAccept
          ? String(t("admin.payoutsTermsIntro"))
          : ownerKind === "org"
            ? String(t("admin.payoutsTermsOrgOnly"))
            : String(t("admin.ebChargebackTermsHumanPermissionNote"))}
      </Text>

      <ChargebackTermsBody
        frame="box"
        id={bodyId}
        maxHeight={TERMS_MAX_HEIGHT}
        maxHeightMobile={TERMS_MAX_HEIGHT_MOBILE}
        aria-label={title}
        testId="chargeback-terms-body"
      />

      {mayAccept && (
        <ChargebackTermsAcceptCheckbox
          id="payments-chargeback-terms-acceptance"
          checked={checked}
          onCheckedChange={setChecked}
          disabled={isAccepting}
          description={String(t("admin.payoutsTermsRequiredNote"))}
        />
      )}

      {error && (
        <YStack
          role="alert"
          padding="$3"
          borderWidth={2}
          borderColor="$danger"
          borderRadius={0}
          backgroundColor="$surfaceMuted"
          data-testid="chargeback-terms-error"
        >
          <Text variant="bodySmall" tone="error">
            {error}
          </Text>
        </YStack>
      )}

      {mayAccept && (
        <Button
          variant="secondary"
          size="$4"
          alignSelf="flex-start"
          onPress={onAccept}
          disabled={!checked || isAccepting}
          data-testid="chargeback-terms-accept"
        >
          {isAccepting
            ? String(t("admin.ebChargebackTermsAccepting"))
            : String(t("admin.ebChargebackTermsAcceptOnly"))}
        </Button>
      )}
    </YStack>
  );
}
