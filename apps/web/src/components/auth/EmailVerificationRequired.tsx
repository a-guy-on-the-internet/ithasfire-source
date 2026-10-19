"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import Link from "next/link";
import { XStack, YStack } from "tamagui";
import { ShieldCheck } from "lucide-react";

import { Button, Spinner, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { useEmailVerificationPrompt } from "./useEmailVerificationPrompt";

/**
 * "Verify your email to see this": what a page shows in place of its content
 * when the server refused a gated read with `email_verification_required`
 * (B2, owner ruling 2026-10-16; detect it with `isEmailVerificationRequired`
 * from `@/lib/email-verification-required`). A retry can never fix that
 * refusal, so this replaces the page's "Try again" error state.
 *
 * The look is the account-settings "verify your current email" block
 * (`EmailSection`): muted surface, accent left rule, shield, one action. The
 * flow is `AdminEmailVerificationGate`'s, through the shared
 * `useEmailVerificationPrompt`: the button sends a code and opens
 * `VerifyEmailCard`. Once the code is accepted every tRPC query is
 * invalidated, so the gated content (past orders included) appears without a
 * reload, and so do the ambient reads that answered empty while unverified.
 */

export type EmailVerificationRequiredContext =
  | "tickets"
  | "order"
  /** The print sheet: an order's tickets, count unknown while withheld. */
  | "printTickets"
  | "resale"
  | "credits"
  | "review"
  | "coordinator"
  | "lineups"
  | "generic";

const COPY: Record<
  EmailVerificationRequiredContext,
  { title: string; body: string }
> = {
  tickets: { title: "emailGate.ticketsTitle", body: "emailGate.ticketsBody" },
  order: { title: "emailGate.orderTitle", body: "emailGate.orderBody" },
  printTickets: {
    title: "emailGate.printTicketsTitle",
    body: "emailGate.printTicketsBody",
  },
  resale: { title: "emailGate.resaleTitle", body: "emailGate.resaleBody" },
  credits: { title: "emailGate.creditsTitle", body: "emailGate.creditsBody" },
  review: { title: "emailGate.reviewTitle", body: "emailGate.reviewBody" },
  coordinator: {
    title: "emailGate.coordinatorTitle",
    body: "emailGate.coordinatorBody",
  },
  lineups: { title: "emailGate.lineupsTitle", body: "emailGate.lineupsBody" },
  generic: { title: "emailGate.genericTitle", body: "emailGate.genericBody" },
};

export type EmailVerificationRequiredProps = {
  context?: EmailVerificationRequiredContext;
  /** Heading level for the title; pick the one the surrounding page needs. */
  headingTag?: "h1" | "h2" | "h3";
  /**
   * Move focus to the heading on mount. For a prompt that replaces the
   * control the user just pressed (resale checkout's Pay), so focus does not
   * fall to <body>.
   */
  autoFocusHeading?: boolean;
  /** Runs after the code is accepted, beside the query invalidation. */
  onVerified?: () => void;
  testId?: string;
};

export const EmailVerificationRequired = ({
  context = "generic",
  headingTag = "h2",
  autoFocusHeading = false,
  onVerified,
  testId = "email-verification-required",
}: EmailVerificationRequiredProps) => {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const headingId = useId();
  const headingRef = useRef<{ focus: () => void } | null>(null);
  // The prompt replaced what had focus a moment ago.
  useEffect(() => {
    if (!autoFocusHeading) return;
    const id = requestAnimationFrame(() => headingRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocusHeading]);

  const handleVerified = useCallback(() => {
    void utils.invalidate();
    onVerified?.();
  }, [utils, onVerified]);

  const { email, isSending, canSend, codeIsFresh, openVerify, verifyModal } =
    useEmailVerificationPrompt({ onVerified: handleVerified });

  const copy = COPY[context];
  const shownEmail = email ?? String(t("emailGate.yourEmail"));

  return (
    <YStack
      role="region"
      aria-labelledby={headingId}
      data-testid={testId}
      gap="$3"
      padding="$4"
      width="100%"
      maxWidth={560}
      backgroundColor="$surfaceMuted"
      borderRadius={0}
      borderLeftWidth={3}
      borderLeftColor="$accent"
    >
      <YStack gap="$2">
        <XStack gap="$2" alignItems="center">
          <ShieldCheck
            size={16}
            color="var(--accent, #E2481D)"
            aria-hidden
            style={{ flexShrink: 0 }}
          />
          <Text
            id={headingId}
            ref={headingRef as never}
            tabIndex={autoFocusHeading ? -1 : undefined}
            variant="body"
            weight="bold"
            tag={headingTag}
          >
            {String(t(copy.title))}
          </Text>
        </XStack>
        {/* An address has no break opportunities: let it break anywhere or a
            long one runs out of the block at 320. */}
        <Text
          variant="bodySmall"
          tone="muted"
          style={{ overflowWrap: "anywhere" }}
        >
          {String(t(copy.body, { email: shownEmail }))}
        </Text>
      </YStack>

      <XStack>
        <Button
          data-testid={`${testId}-send`}
          variant="primary"
          size="$3"
          minHeight={44}
          onPress={() => void openVerify()}
          disabled={!canSend}
          aria-busy={isSending || undefined}
        >
          {isSending ? <Spinner size="sm" /> : null}
          {/* A code sent in the last minute is still the one to type: the
              button reopens the card instead of mailing another. */}
          {isSending
            ? String(t("emailGate.sending"))
            : codeIsFresh
              ? String(t("emailGate.enterCode"))
              : String(t("emailGate.send"))}
        </Button>
      </XStack>

      {verifyModal}
    </YStack>
  );
};

EmailVerificationRequired.displayName = "EmailVerificationRequired";

/**
 * The whole-page form: the prompt in place of a page that has nothing else to
 * show (an order, its refund / resell / transfer / claim / print subpages, a
 * seller list), with the page's own way back beneath it.
 */
export const EmailVerificationRequiredPage = ({
  backHref,
  backLabel,
  testId = "email-verification-required-page",
  ...props
}: Omit<EmailVerificationRequiredProps, "testId"> & {
  backHref?: string;
  backLabel?: string;
  testId?: string;
}) => (
  <YStack
    paddingVertical="$8"
    gap="$4"
    maxWidth={640}
    marginHorizontal="auto"
    width="100%"
    data-testid={testId}
  >
    <EmailVerificationRequired headingTag="h1" {...props} />
    {backHref && backLabel ? (
      <XStack>
        {/* The anchor is the control; `tabIndex={-1}` keeps Tamagui's
            focusable span inside it from being a second tab stop with the
            same name (the print layer's measured fix). */}
        <Link href={backHref} style={{ textDecoration: "none" }}>
          <Button tag="span" variant="secondary" minHeight={44} tabIndex={-1}>
            {backLabel}
          </Button>
        </Link>
      </XStack>
    ) : null}
  </YStack>
);
