"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, Card, Spinner } from "tamagui";
import { CheckCircle, AlertTriangle, LogIn } from "lucide-react";

import { Text, Button, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";

// ── Component ──────────────────────────────────────────────────────────────

type ClaimTransferProps = {
  token: string | null;
};

export const ClaimTransfer = ({ token }: ClaimTransferProps) => {
  const router = useRouter();
  const t = useTranslations();
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const [hasAttempted, setHasAttempted] = useState(false);

  const claimMutation = trpc.tickets.claimPendingTransfer.useMutation();

  // ── Auto-claim on mount when authenticated ──────────────────────────────

  const doClaim = useCallback(() => {
    if (!token || hasAttempted || claimMutation.isPending) return;
    setHasAttempted(true);
    const clientKey = `web-claim-${token.slice(0, 16)}-${Date.now()}`;
    claimMutation.mutate({ token, clientKey });
  }, [token, hasAttempted, claimMutation]);

  useEffect(() => {
    if (!isSessionPending && session && token && !hasAttempted) {
      doClaim();
    }
  }, [isSessionPending, session, token, hasAttempted, doClaim]);

  // ── No token ─────────────────────────────────────────────────────────────

  if (!token) {
    return (
      <YStack alignItems="center" justifyContent="center" padding="$8" gap="$4">
        <AlertTriangle size={48} color="var(--danger)" />
        <Text variant="h3" textAlign="center">
          {String(t("auth.ctInvalidLink"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          {String(t("auth.ctInvalidLinkDesc"))}
        </Text>
        <Link href="/">
          <Button tag="span" variant="outlined">
            {String(t("auth.goHome"))}
          </Button>
        </Link>
      </YStack>
    );
  }

  // ── Loading session ──────────────────────────────────────────────────────

  if (isSessionPending) {
    return (
      <YStack alignItems="center" justifyContent="center" padding="$8" gap="$4">
        <Spinner size="large" color="$color" />
        <Text variant="body" tone="muted">
          {String(t("auth.checkingSession"))}
        </Text>
      </YStack>
    );
  }

  // ── Not signed in ────────────────────────────────────────────────────────

  if (!session) {
    const signInUrl = `/sign-in?redirect=${encodeURIComponent(`/claim-transfer?token=${token}`)}`;

    return (
      <YStack alignItems="center" justifyContent="center" padding="$8" gap="$6">
        <Card
          padding="$8"
          gap="$5"
          borderRadius={0}
          alignItems="center"
          maxWidth={480}
          width="100%"
        >
          <XStack
            width={64}
            height={64}
            borderRadius={0}
            backgroundColor="$blue4"
            alignItems="center"
            justifyContent="center"
          >
            <LogIn size={32} color="var(--accent)" />
          </XStack>

          <YStack gap="$2" alignItems="center">
            <Text
              variant="h2"
              weight="bold"
              textAlign="center"
              textTransform="uppercase"
              letterSpacing={-0.5}
            >
              {String(t("auth.ctClaimYourTicket"))}
            </Text>
            <Text variant="body" tone="muted" textAlign="center">
              {String(t("auth.ctClaimDesc"))}
            </Text>
          </YStack>

          <Link href={signInUrl}>
            <Button tag="span" variant="primary" size="$4" width="100%">
              <XStack gap="$2" alignItems="center" justifyContent="center">
                <LogIn size={18} />
                <Text variant="body" tone="inherit" tag="span">
                  {String(t("auth.ctSignInToClaim"))}
                </Text>
              </XStack>
            </Button>
          </Link>

          <Text variant="bodySmall" tone="muted" textAlign="center">
            {String(t("auth.ctUseSameEmail"))}
          </Text>
        </Card>
      </YStack>
    );
  }

  // ── Claiming in progress ─────────────────────────────────────────────────

  if (claimMutation.isPending) {
    return (
      <YStack alignItems="center" justifyContent="center" padding="$8" gap="$4">
        <Spinner size="large" color="$color" />
        <Text variant="body" tone="muted">
          {String(t("auth.ctClaiming"))}
        </Text>
      </YStack>
    );
  }

  // ── Claim succeeded ──────────────────────────────────────────────────────

  if (claimMutation.isSuccess) {
    return (
      <YStack alignItems="center" justifyContent="center" padding="$8" gap="$6">
        <Card
          padding="$8"
          gap="$5"
          borderRadius={0}
          alignItems="center"
          maxWidth={480}
          width="100%"
        >
          <XStack
            width={64}
            height={64}
            borderRadius={0}
            backgroundColor="$green4"
            alignItems="center"
            justifyContent="center"
          >
            <CheckCircle size={32} color="var(--success)" />
          </XStack>

          <YStack gap="$2" alignItems="center">
            <Text
              variant="h2"
              weight="bold"
              textAlign="center"
              textTransform="uppercase"
              letterSpacing={-0.5}
            >
              {String(t("auth.ctTicketClaimed"))}
            </Text>
            <Text variant="body" tone="muted" textAlign="center">
              {String(t("auth.ctTicketClaimedDesc"))}
            </Text>
          </YStack>

          <Button
            variant="primary"
            size="$3"
            onPress={() => router.push("/my-tickets")}
          >
            {String(t("auth.ctViewMyTickets"))}
          </Button>
        </Card>
      </YStack>
    );
  }

  // ── Claim failed ─────────────────────────────────────────────────────────

  if (claimMutation.isError) {
    const errorMessage = claimMutation.error?.message ?? "Unknown error";
    const code = getAppErrorCode(claimMutation.error);
    const isEmailMismatch = code === "EMAIL_MISMATCH";
    const isExpired = code === "PENDING_TRANSFER_EXPIRED";
    // The show is over: no new invite can help, so this must not read as
    // "expired, ask for another one".
    const isEventOver = code === "TICKET_TRANSFER_EVENT_PAST";
    // The sender's ticket has an open resale claim. The catalog copy for
    // this code is written for the owner and names the claim, so the
    // recipient gets their own message that does neither. A refund in flight
    // on the sender's order freezes the ticket the same way and gets the
    // same neutral copy: the sender's refund is not the recipient's business.
    const isOnHold =
      code === "TICKET_UNDER_CLAIM" || code === "TICKET_REFUND_IN_PROGRESS";
    // The "already claimed / cancelled" path is still raised as a legacy
    // `{ code: "conflict", message: "pending_transfer_<status>" }` throw (not a
    // canonical AppErrorCode), so the code is unresolved and we fall back to a
    // substring match on the surfaced message.
    const isAlreadyClaimed =
      errorMessage.toLowerCase().includes("claimed") ||
      errorMessage.toLowerCase().includes("cancelled");

    return (
      <YStack alignItems="center" justifyContent="center" padding="$8" gap="$6">
        <Card
          padding="$8"
          gap="$5"
          borderRadius={0}
          alignItems="center"
          maxWidth={480}
          width="100%"
        >
          <XStack
            width={64}
            height={64}
            borderRadius={0}
            backgroundColor="$red4"
            alignItems="center"
            justifyContent="center"
          >
            <AlertTriangle size={32} color="var(--danger)" />
          </XStack>

          <YStack gap="$2" alignItems="center">
            <Text
              variant="h2"
              weight="bold"
              textAlign="center"
              textTransform="uppercase"
              letterSpacing={-0.5}
            >
              {isAlreadyClaimed
                ? String(t("auth.ctAlreadyClaimed"))
                : isEventOver
                  ? String(t("transfer.eventEndedTitle"))
                  : isExpired
                    ? String(t("auth.ctTransferExpired"))
                    : String(t("auth.ctTransferFailed"))}
            </Text>
            <Text variant="body" tone="muted" textAlign="center">
              {isEmailMismatch
                ? String(t("auth.ctEmailMismatch"))
                : isEventOver
                  ? String(t("errors.ticketTransferEventPast"))
                  : isExpired
                    ? String(t("auth.ctExpiredDesc"))
                    : isAlreadyClaimed
                      ? String(t("auth.ctAlreadyClaimedDesc"))
                      : isOnHold
                        ? String(t("auth.ctTicketOnHoldDesc"))
                        : // Catalog copy for any other code.
                          formatErrorMessage(claimMutation.error, t)}
            </Text>
          </YStack>

          <XStack gap="$3">
            {isEmailMismatch && (
              <Link
                href={`/sign-in?redirect=${encodeURIComponent(`/claim-transfer?token=${token}`)}`}
              >
                <Button tag="span" variant="primary" size="$3">
                  {String(t("auth.ctSwitchAccount"))}
                </Button>
              </Link>
            )}
            <Link href="/">
              <Button tag="span" variant="outlined" size="$3">
                {String(t("auth.goHome"))}
              </Button>
            </Link>
          </XStack>
        </Card>
      </YStack>
    );
  }

  // ── Fallback (shouldn't happen) ──────────────────────────────────────────

  return (
    <YStack alignItems="center" justifyContent="center" padding="$8" gap="$4">
      <Spinner size="large" color="$color" />
      <Text variant="body" tone="muted">
        {String(t("auth.ctProcessing"))}
      </Text>
    </YStack>
  );
};
