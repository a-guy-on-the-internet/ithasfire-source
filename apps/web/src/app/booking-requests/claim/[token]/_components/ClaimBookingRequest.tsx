"use client";

import { useMemo, useState } from "react";
import { YStack, XStack } from "tamagui";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  LogIn,
  Music,
} from "lucide-react";

import {
  Button,
  NextLinkAnchor,
  Radio,
  RadioGroupField,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";

/**
 * Invite-to-claim flow (booking-request-embed-button FR-007).
 *
 * A signed-in performer redeems the emailed claim link: pick who they're
 * performing as (self, or a group they hold edit roles in — from
 * `bookingRequests.listMySenders`), then `bookingRequests.claim` backfills
 * their identity onto the accepted request and mints the draft Agreement.
 *
 * Mirrors the closest precedents:
 * - sign-in redirect + state layout: `AcceptInvitation` (/invite/accept)
 * - performer-mode one-click enable gate: `RequestToPlayPanel`
 *
 * Same-sender replays are idempotent server-side (a second click is a
 * friendly success), so double-submits need no special casing here. The raw
 * token goes straight into the mutation — never logged, never in analytics.
 *
 * NOTE: copy is literal English, matching the token-claim precedents'
 * standalone surfaces; folding it into the i18n messages files is deferred
 * while those files carry unrelated in-flight work.
 */

type TerminalError = "expired" | "invalid" | "status" | null;

type SenderChoice = {
  ownerType: "human" | "org";
  ownerId: string;
  displayName: string;
  isDefault: boolean;
};

function senderKey(sender: Pick<SenderChoice, "ownerType" | "ownerId">) {
  return `${sender.ownerType}:${sender.ownerId}`;
}

/** Shared centered shell so every state renders in the same column. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <YStack
      alignItems="center"
      justifyContent="center"
      padding="$8"
      gap="$4"
      maxWidth={560}
      width="100%"
      marginHorizontal="auto"
    >
      {children}
    </YStack>
  );
}

export function ClaimBookingRequest({ token }: { token: string | null }) {
  const t = useTranslations();
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const utils = trpc.useUtils();

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<TerminalError>(null);
  const [enableError, setEnableError] = useState<string | null>(null);

  const signedIn = Boolean(session);

  const statusQuery = trpc.performers.getMyStatus.useQuery(undefined, {
    enabled: signedIn,
    staleTime: 30_000,
    retry: false,
    meta: { silent: true },
  });

  const sendersQuery = trpc.bookingRequests.listMySenders.useQuery(undefined, {
    enabled: signedIn,
    staleTime: 30_000,
    retry: 1,
    meta: { silent: true },
  });

  // One-click performer-mode enable (RequestToPlayPanel pattern): optimistic
  // flip of the human status so the claim form appears immediately.
  const setModeMutation = trpc.performers.setMode.useMutation({
    retry: false,
    meta: { silent: true },
    onMutate: () => {
      setEnableError(null);
      const previous = utils.performers.getMyStatus.getData();
      if (previous) {
        utils.performers.getMyStatus.setData(undefined, {
          ...previous,
          human: { ...previous.human, enabled: true },
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        utils.performers.getMyStatus.setData(undefined, context.previous);
      }
      setEnableError(String(t("admin.bkEnablePerformerModeFailed")));
    },
    onSettled: () => {
      void utils.performers.getMyStatus.invalidate();
    },
  });

  const claimMutation = trpc.bookingRequests.claim.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const senders = useMemo<SenderChoice[]>(
    () => sendersQuery.data?.senders ?? [],
    [sendersQuery.data],
  );

  const selectedSender = useMemo(() => {
    const key =
      selectedKey ??
      senderKey(senders.find((s) => s.isDefault) ?? senders[0] ?? { ownerType: "human", ownerId: "" });
    return senders.find((s) => senderKey(s) === key) ?? null;
  }, [selectedKey, senders]);

  const handleClaim = () => {
    if (!token || !selectedSender || claimMutation.isPending) return;
    setInlineError(null);
    claimMutation.mutate(
      {
        rawToken: token,
        performerOwnerType: selectedSender.ownerType,
        performerOwnerId: selectedSender.ownerId,
      },
      {
        onError: (err) => {
          const code = getAppErrorCode(err);
          if (code === "TOKEN_EXPIRED") {
            setTerminalError("expired");
          } else if (code === "TOKEN_INVALID") {
            setTerminalError("invalid");
          } else if (code === "INVALID_STATUS") {
            setTerminalError("status");
          } else if (code === "PERFORMER_MODE_REQUIRED") {
            setInlineError(
              "That identity doesn't have performer mode turned on. Enable it in account settings, or claim as yourself.",
            );
          } else {
            setInlineError(formatErrorMessage(err, t));
          }
        },
      },
    );
  };

  // ── No / malformed token ──────────────────────────────────────────────────
  if (!token) {
    return (
      <Shell>
        <AlertTriangle size={48} color="var(--danger)" />
        <Text
          variant="h3"
          textAlign="center"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          Invalid link
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          This claim link is incomplete. Open the link from your invite email
          again.
        </Text>
        <NextLinkAnchor href="/">
          <Button tag="span" variant="outlined">
            {String(t("auth.goHome"))}
          </Button>
        </NextLinkAnchor>
      </Shell>
    );
  }

  // ── Loading session ───────────────────────────────────────────────────────
  if (isSessionPending) {
    return (
      <Shell>
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("auth.checkingSession"))}
        </Text>
      </Shell>
    );
  }

  // ── Signed out → first-party sign-in, then back here ─────────────────────
  if (!session) {
    const signInUrl = `/sign-in?redirect=${encodeURIComponent(
      `/booking-requests/claim/${token}`,
    )}`;
    return (
      <Shell>
        <LogIn size={48} color="var(--accent)" />
        <Text
          variant="h3"
          textAlign="center"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          Sign in to claim your booking
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          The place accepted your booking request. Sign in — or create an
          account — to finalize it.
        </Text>
        <NextLinkAnchor href={signInUrl}>
          <Button tag="span" variant="primary">
            {String(t("auth.signIn"))}
          </Button>
        </NextLinkAnchor>
      </Shell>
    );
  }

  // ── Terminal claim errors ─────────────────────────────────────────────────
  if (terminalError === "expired") {
    return (
      <Shell>
        <Clock size={48} color="var(--danger)" />
        <Text
          variant="h3"
          textAlign="center"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          This link has expired
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          Ask the place to resend the invite — they can do that from their
          booking inbox, and you&rsquo;ll get a fresh link by email.
        </Text>
        <NextLinkAnchor href="/">
          <Button tag="span" variant="outlined">
            {String(t("auth.goHome"))}
          </Button>
        </NextLinkAnchor>
      </Shell>
    );
  }

  if (terminalError === "invalid") {
    return (
      <Shell>
        <AlertTriangle size={48} color="var(--danger)" />
        <Text
          variant="h3"
          textAlign="center"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          This link is no longer active
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          It was already used, or a newer invite email replaced it. Check your
          inbox for the latest link.
        </Text>
        <NextLinkAnchor href="/">
          <Button tag="span" variant="outlined">
            {String(t("auth.goHome"))}
          </Button>
        </NextLinkAnchor>
      </Shell>
    );
  }

  if (terminalError === "status") {
    return (
      <Shell>
        <AlertTriangle size={48} color="var(--danger)" />
        <Text
          variant="h3"
          textAlign="center"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          This booking can&rsquo;t be claimed
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          The request is no longer in an accepted state. Reach out to the place
          for details.
        </Text>
        <NextLinkAnchor href="/">
          <Button tag="span" variant="outlined">
            {String(t("auth.goHome"))}
          </Button>
        </NextLinkAnchor>
      </Shell>
    );
  }

  // ── Success ───────────────────────────────────────────────────────────────
  if (claimMutation.isSuccess) {
    const agreementId = claimMutation.data.agreementId;
    return (
      <Shell>
        <CheckCircle size={48} color="var(--success)" />
        <Text
          variant="h3"
          textAlign="center"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          Booking claimed
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          A draft agreement is ready for you and the place to finalize. You can
          also find this request under your sent booking requests.
        </Text>
        <XStack gap="$3" flexWrap="wrap" justifyContent="center">
          <NextLinkAnchor href={`/agreements/${agreementId}`}>
            <Button tag="span" variant="primary">
              Open the agreement
            </Button>
          </NextLinkAnchor>
          <NextLinkAnchor href="/account/settings">
            <Button tag="span" variant="outlined">
              View sent requests
            </Button>
          </NextLinkAnchor>
        </XStack>
      </Shell>
    );
  }

  // ── Loading performer status / senders ────────────────────────────────────
  if (statusQuery.isLoading || sendersQuery.isLoading) {
    return (
      <Shell>
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("common.loading"))}
        </Text>
      </Shell>
    );
  }

  if (statusQuery.isError || sendersQuery.isError) {
    return (
      <Shell>
        <AlertTriangle size={48} color="var(--danger)" />
        <Text variant="body" tone="muted" textAlign="center">
          Something went wrong loading your account. Try again.
        </Text>
        <Button
          variant="outlined"
          onPress={() => {
            void statusQuery.refetch();
            void sendersQuery.refetch();
          }}
        >
          Retry
        </Button>
      </Shell>
    );
  }

  const status = statusQuery.data;

  // ── Performer-mode gate (one-click enable, RequestToPlayPanel pattern) ────
  const anyPerformerEnabled =
    status !== undefined &&
    (status.human.enabled || status.orgs.some((org) => org.enabled));

  if (status && !anyPerformerEnabled) {
    return (
      <Shell>
        <Music size={48} color="var(--accent)" />
        <Text
          variant="h3"
          textAlign="center"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          {String(t("admin.bkPerformerModeRequiredTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          {String(t("admin.bkPerformerModeRequiredBody"))}
        </Text>
        {enableError && (
          <Text variant="bodySmall" tone="error" role="alert">
            {enableError}
          </Text>
        )}
        <Button
          variant="primary"
          disabled={setModeMutation.isPending}
          onPress={() =>
            setModeMutation.mutate({
              ownerType: "human",
              ownerId: status.human.ownerId,
              enabled: true,
            })
          }
        >
          {setModeMutation.isPending
            ? String(t("common.loading"))
            : String(t("admin.bkEnablePerformerMode"))}
        </Button>
      </Shell>
    );
  }

  // ── Claim form ────────────────────────────────────────────────────────────
  const effectiveSelectedKey = selectedSender ? senderKey(selectedSender) : "";

  return (
    <Shell>
      <YStack gap="$4" width="100%" maxWidth={480}>
        <YStack gap="$2">
          <Text
            variant="h3"
            textTransform="uppercase"
            letterSpacing={-0.5}
            weight="bold"
          >
            You&rsquo;ve been invited to finalize a booking
          </Text>
          <Text variant="body" tone="muted">
            The place accepted your booking request. Choose who you&rsquo;re
            performing as — the draft agreement is created under that name.
          </Text>
        </YStack>

        {senders.length > 0 ? (
          <YStack gap="$2">
            <Text
              variant="caption"
              weight="bold"
              tone="muted"
              textTransform="uppercase"
              letterSpacing={0.6}
            >
              Claim as
            </Text>
            <RadioGroupField
              value={effectiveSelectedKey}
              onValueChange={(value: string) => {
                setSelectedKey(value);
                setInlineError(null);
              }}
              aria-label="Claim as"
            >
              {senders.map((sender) => (
                <Radio
                  key={senderKey(sender)}
                  value={senderKey(sender)}
                  label={sender.displayName}
                  description={
                    sender.ownerType === "org"
                      ? String(t("admin.bkInboxSenderOrg"))
                      : String(t("admin.bkInboxSenderHuman"))
                  }
                  testIdBase={`claim-sender-${senderKey(sender)}`}
                />
              ))}
            </RadioGroupField>
          </YStack>
        ) : (
          <Text variant="bodySmall" tone="muted">
            No performer identities available on your account yet.
          </Text>
        )}

        {inlineError && (
          <Text variant="bodySmall" tone="error" role="alert">
            {inlineError}
          </Text>
        )}

        <XStack>
          <Button
            variant="primary"
            size="$4"
            disabled={!selectedSender || claimMutation.isPending}
            onPress={handleClaim}
            testID="claim-booking-submit"
          >
            {claimMutation.isPending ? (
              <Spinner size="sm" />
            ) : (
              "Claim booking"
            )}
          </Button>
        </XStack>
      </YStack>
    </Shell>
  );
}
