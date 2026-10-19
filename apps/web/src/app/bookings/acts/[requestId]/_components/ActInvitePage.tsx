"use client";

import { useEffect, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { Button, Text, useTranslations } from "@th/ui";

import { authClient } from "@/lib/auth/auth-client";
import { formatErrorMessage } from "@/lib/format-error-message";
import { trpc } from "@/trpc";

import {
  deriveInviteState,
  identityKey,
  isNotFoundLike,
  type ActInvite,
} from "../_lib/invite-view";
import { InviteAnswer } from "./InviteAnswer";
import { InviteBill, InviteFacts } from "./InviteLetter";
import styles from "./act-invite.module.css";
import { InlineLink } from "./InlineLink";

// ─────────────────────────────────────────────────────────────────────────────
// `/bookings/acts/[requestId]` — the lineup invite page (lineup v3 FR-013,
// owner-approved board I1 "Letter"). The `booking.lineup-invited` email and
// in-app note link here. Viewer states:
//   session pending / redirecting → skeleton
//   signed out                    → /sign-in?redirect=… (AppAuthGate does the
//                                   same; this is the page's own backstop)
//   loading                       → skeleton
//   not found / not on the bill   → plain not-found (the read answers both the
//                                   same, so nothing leaks)
//   other error                   → message + retry
//   loaded                        → letter + the ONE current answer state
// ─────────────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Skeleton() {
  const t = useTranslations();
  return (
    <div
      className={styles.page}
      aria-busy="true"
      aria-label={String(t("bookingActInvite.loading"))}
      data-testid="act-invite-loading"
    >
      <div className={styles.head}>
        <div className={styles.pulse} style={{ height: 12, width: 140 }} />
        <div className={styles.pulse} style={{ height: 40, width: "90%" }} />
        <div className={styles.pulse} style={{ height: 16, width: "70%" }} />
      </div>
      <div className={styles.pulse} style={{ height: 160, width: "100%" }} />
      <div className={styles.pulse} style={{ height: 120, width: "100%" }} />
      <div className={styles.pulse} style={{ height: 52, width: 220 }} />
    </div>
  );
}

function NotFound() {
  const t = useTranslations();
  return (
    <div className={styles.page}>
      <div className={styles.panel} data-testid="act-invite-not-found">
        <Text variant="h3" tag="h1" weight="bold">
          {String(t("bookingActInvite.notFoundTitle"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("bookingActInvite.notFoundBody"))}
        </Text>
        <InlineLink href="/" variant="bodySmall">
          {String(t("bookingActInvite.goHome"))}
        </InlineLink>
      </div>
    </div>
  );
}

function LoadError({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  const t = useTranslations();
  return (
    <div className={styles.page}>
      <div className={styles.panel} role="alert" data-testid="act-invite-error">
        <Text variant="h3" tag="h1" weight="bold">
          {String(t("bookingActInvite.errorTitle"))}
        </Text>
        <Text variant="body" tone="muted">
          {message}
        </Text>
        <Button
          variant="secondary"
          size="$4"
          disabled={retrying}
          onPress={onRetry}
          data-testid="act-invite-retry"
        >
          {String(t("bookingActInvite.retry"))}
        </Button>
      </div>
    </div>
  );
}

function Invite({ invite }: { invite: ActInvite }) {
  const t = useTranslations();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // The chosen identity, or the primary one (also when a refetch no longer
  // carries the chosen key).
  const identity =
    invite.identities.find((option) => identityKey(option) === selectedKey) ??
    invite.identities[0];
  if (!identity) return <NotFound />;

  const state = deriveInviteState(invite, identity);
  const senderName =
    invite.sender.displayName ?? String(t("bookingActInvite.senderFallback"));
  const placeName =
    invite.venue.name ?? String(t("bookingActInvite.placeFallback"));
  // "Nothing is booked yet" is only true before any event exists and while
  // the request is still alive.
  const showLede =
    !invite.eventMinted && state !== "booked" && state !== "closed";

  return (
    <article className={styles.page} data-testid="act-invite">
      <header className={styles.head}>
        <Text variant="kicker" tone="accent">
          {String(t("bookingActInvite.kicker"))}
        </Text>
        <Text
          variant="h1"
          weight="black"
          className={styles.wrap}
          fontSize="$8"
          lineHeight="$8"
          $gtSm={{ fontSize: "$9", lineHeight: "$9" }}
        >
          {String(
            t("bookingActInvite.title", {
              sender: senderName,
              place: placeName,
            }),
          )}
        </Text>
        {showLede && (
          <Text variant="body" className={styles.wrap}>
            {String(
              t("bookingActInvite.lede", {
                sender: senderName,
                place: placeName,
              }),
            )}
          </Text>
        )}
      </header>

      <InviteFacts invite={invite} identity={identity} />
      <InviteBill invite={invite} />
      <InviteAnswer
        invite={invite}
        identity={identity}
        state={state}
        placeName={placeName}
        senderName={senderName}
        onSelectIdentity={setSelectedKey}
      />
    </article>
  );
}

export function ActInvitePage({ requestId }: { requestId: string }) {
  const t = useTranslations();
  const router = useRouter();

  const session = authClient.useSession();
  const isSignedIn = Boolean(session.data?.user);
  const isSessionPending = session.isPending;
  const validId = UUID.test(requestId);

  useEffect(() => {
    if (!isSessionPending && !isSignedIn) {
      router.replace(
        `/sign-in?redirect=${encodeURIComponent(`/bookings/acts/${requestId}`)}`,
      );
    }
  }, [isSessionPending, isSignedIn, requestId, router]);

  const inviteQuery = trpc.bookingRequests.getActInvite.useQuery(
    { bookingRequestId: requestId },
    {
      enabled: isSignedIn && validId,
      retry: false,
      staleTime: 15_000,
      // Not-found is a handled outcome here (the page renders it), so the
      // global query-error logger stays quiet about it — console, Sentry and
      // toast (GlobalQueryErrorLogger `silentWhen`).
      meta: { silentWhen: isNotFoundLike },
    },
  );

  if (isSessionPending || !isSignedIn) return <Skeleton />;
  if (!validId) return <NotFound />;
  if (inviteQuery.isLoading) return <Skeleton />;

  if (inviteQuery.error || !inviteQuery.data) {
    const error = inviteQuery.error;
    // Missing, not yours, or a malformed id: all read the same.
    if (isNotFoundLike(error)) return <NotFound />;
    return (
      <LoadError
        message={
          error
            ? formatErrorMessage(error, (key) => String(t(key)))
            : String(t("bookingActInvite.errorBody"))
        }
        retrying={inviteQuery.isFetching}
        onRetry={() => void inviteQuery.refetch()}
      />
    );
  }

  return <Invite invite={inviteQuery.data} />;
}
