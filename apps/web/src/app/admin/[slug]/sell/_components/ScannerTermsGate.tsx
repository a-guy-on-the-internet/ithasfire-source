"use client";

import { useState } from "react";
import { YStack, XStack } from "tamagui";
import { Button, Spinner, Text, useNotify, useTranslations } from "@th/ui";
import { SCANNER_TERMS_TEXT, SCANNER_TERMS_VERSION } from "@th/types";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

/**
 * The web till's seller-terms gate — the first blocker between this page and a
 * working sale.
 *
 * `startPosSale` and `recordCashSale` both refuse an operator whose
 * `scannerTermsAckVersion` isn't current, with SCANNER_TERMS_REQUIRED. The
 * `humans.acknowledgeScannerTerms` mutation has existed since the scanner app
 * shipped and NOTHING in apps/web called it, so the first web sale would have
 * hard-failed with an error the operator had no way to clear from a browser.
 *
 * The ack lives on the HUMAN record, not the device, so acknowledging here
 * clears the scanner app too and vice versa — which is why this reads the same
 * `scanner.getSessionContext` the app does rather than inventing a web-only
 * read.
 *
 * Copy is `SCANNER_TERMS_TEXT[SCANNER_TERMS_VERSION]` from `@th/types` — the
 * same constant the server-side gate validates against. Deliberately NOT
 * reworded for the web: the version string is what makes an ack valid, so two
 * surfaces showing different text under one version would mean people agreed
 * to different things and the record couldn't say which.
 *
 * BLOCKING by construction. It renders INSTEAD of the till, never over it, so
 * there is no dismiss path that leaves an operator staring at a Charge button
 * the server will refuse.
 */
export function ScannerTermsGate({ onAcknowledged }: { onAcknowledged: () => void }) {
  const { toast } = useNotify();
  const t = useTranslations();
  const terms = SCANNER_TERMS_TEXT[SCANNER_TERMS_VERSION];
  // Covers the mutation AND the session refetch: the button stays inert until
  // the refreshed ack state unmounts this gate, so a slow refetch can't take a
  // second submission.
  const [submitting, setSubmitting] = useState(false);

  const acknowledge = trpc.humans.acknowledgeScannerTerms.useMutation();

  const handleAcknowledge = async () => {
    setSubmitting(true);
    try {
      await acknowledge.mutateAsync({ version: SCANNER_TERMS_VERSION });
      onAcknowledged();
    } catch (err) {
      toast.danger({
        id: "scanner-terms-failed",
        title: "Could not save that",
        message: formatErrorMessage(err, t),
      });
      setSubmitting(false);
    }
  };

  // Defensive: a version bump without a matching SCANNER_TERMS_TEXT entry
  // would leave nothing to render. Stay blocking — never silently unlock the
  // till, because the server would refuse the sale anyway and the operator
  // would get a worse error at a worse moment.
  if (!terms) {
    return (
      <YStack
        gap="$2"
        padding="$4"
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surfaceMuted"
        maxWidth={520}
      >
        <Text variant="h5" weight="bold">
          Terms unavailable
        </Text>
        <Text variant="bodySmall" tone="muted">
          We couldn&rsquo;t load the seller terms for this version. Reload the
          page and try again.
        </Text>
      </YStack>
    );
  }

  return (
    <YStack
      gap="$4"
      padding="$5"
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$background"
      maxWidth={520}
      width="100%"
      data-testid="scanner-terms-gate"
    >
      <Text variant="h5" weight="bold" accessibilityRole="header">
        {terms.title}
      </Text>

      <YStack gap="$3" role="list">
        {terms.bullets.map((bullet) => (
          <XStack key={bullet} gap="$3" alignItems="flex-start" role="listitem">
            <Text variant="bodySmall" weight="bold" tone="accent">
              —
            </Text>
            <Text variant="bodySmall" flex={1}>
              {bullet}
            </Text>
          </XStack>
        ))}
      </YStack>

      <Button
        variant="primary"
        size="$4"
        disabled={submitting}
        onPress={() => void handleAcknowledge()}
        aria-label={terms.confirmLabel}
      >
        {submitting ? <Spinner size="small" /> : null}
        {submitting ? "Saving…" : terms.confirmLabel}
      </Button>
    </YStack>
  );
}
