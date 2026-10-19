"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "@bprogress/next/app";
import { useQuery } from "@tanstack/react-query";
import { YStack, Spinner } from "tamagui";
import { CheckCircle, AlertTriangle, LogIn, UserPlus } from "lucide-react";

import { Text, Button, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { getAppErrorCode } from "@/lib/app-error";
import { extractQuotaExceededMeta } from "@/lib/quota-error";
import { QuotaExceededDialog } from "@/components/errors/QuotaExceededDialog";
import {
  clearStashedInviteToken,
  signInHrefForInvite,
  useInviteToken,
} from "@/lib/pending-invite-token";

// ── Layout helpers (module scope: never re-created per render) ─────────────

const Shell = ({ children }: { children: ReactNode }) => (
  <YStack alignItems="center" justifyContent="center" padding="$8" gap="$4">
    {children}
  </YStack>
);

const Title = ({ children }: { children: ReactNode }) => (
  <Text
    variant="h3"
    textAlign="center"
    textTransform="uppercase"
    letterSpacing={-0.5}
  >
    {children}
  </Text>
);

const Body = ({ children }: { children: ReactNode }) => (
  <Text variant="body" tone="muted" textAlign="center" maxWidth={520}>
    {children}
  </Text>
);

const HomeButton = ({ label }: { label: string }) => (
  <Link href="/">
    <Button tag="span" variant="outlined">
      {label}
    </Button>
  </Link>
);

const ROLE_LABEL_KEYS: Record<string, string> = {
  OWNER: "admin.roleOwner",
  ADMIN: "admin.roleAdmin",
  EDITOR: "admin.roleEditor",
  FINANCE: "admin.roleFinance",
  SCANNER: "admin.roleScanner",
  VIEWER: "admin.roleViewer",
};

function invitationMetaStatus(error: unknown): string | null {
  const meta = (error as { data?: { meta?: { status?: unknown } } } | null)
    ?.data?.meta;
  return typeof meta?.status === "string" ? meta.status : null;
}

// ── Component ──────────────────────────────────────────────────────────────

type AcceptInvitationProps = {
  token: string | null;
};

/**
 * Org invitation accept screen.
 *
 * Deliberately does NOT accept on load (security review, 2026-09-29): an
 * attacker could invite their OWN address, take the token, and lure a
 * signed-in victim here, so page load must never be consent. The page first
 * runs `orgs.previewInvitation` (read-only; answers only the account the
 * invitation was sent to) to name the org and role, then waits for Accept.
 * The server enforces the same email binding on accept.
 */
export const AcceptInvitation = ({ token: urlToken }: AcceptInvitationProps) => {
  const router = useRouter();
  // URL token, or the one stashed before a sign-in round trip (never in the
  // sign-in URL — see lib/pending-invite-token).
  const { token, resolved: tokenResolved } = useInviteToken("org", urlToken);
  const t = useTranslations();
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();

  // The preview is a POST procedure (a GET query would put the bearer token
  // in the URL), fetched through react-query's useQuery rather than a
  // mutation fired from an effect: useQuery survives StrictMode's
  // mount/unmount/remount and dedupes, a mutation-in-an-effect lost its
  // result on the remount and the page hung on "Checking…".
  const utils = trpc.useUtils();
  const previewQuery = useQuery({
    queryKey: ["orgs.previewInvitation", token],
    queryFn: () => utils.client.orgs.previewInvitation.mutate({ token: token ?? "" }),
    enabled: Boolean(token) && !isSessionPending && Boolean(session),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const acceptMutation = trpc.orgs.acceptInvitation.useMutation({
    meta: { silent: true },
    onSuccess: () => clearStashedInviteToken("org"),
  });

  // A stashed token that can never succeed must not linger for the rest of
  // the tab's life (it would resurface on the next visit to this page).
  // Terminal = wrong account / unknown token, expired, already used or
  // revoked. EMAIL_NOT_VERIFIED is NOT terminal: the invitee verifies and
  // comes back, so the stash is kept for them.
  const terminalCode = getAppErrorCode(
    acceptMutation.error ?? previewQuery.error,
  );
  useEffect(() => {
    if (
      terminalCode === "INVITATION_NOT_FOUND" ||
      terminalCode === "INVITATION_EXPIRED" ||
      terminalCode === "INVITATION_NOT_PENDING"
    ) {
      clearStashedInviteToken("org");
    }
  }, [terminalCode]);

  const roleLabel = (role: string | undefined) =>
    role && ROLE_LABEL_KEYS[role]
      ? String(t(ROLE_LABEL_KEYS[role]))
      : (role ?? "").toLowerCase();

  // ── Resolving the token (URL or stash) ─────────────────────────────────

  if (!tokenResolved) {
    return (
      <Shell>
        <Spinner size="large" color="$color" />
        <Body>{String(t("auth.invChecking"))}</Body>
      </Shell>
    );
  }

  // ── No token ─────────────────────────────────────────────────────────────

  if (!token) {
    return (
      <Shell>
        <AlertTriangle size={48} color="var(--danger)" />
        <Title>{String(t("auth.invInvalidLink"))}</Title>
        <Body>{String(t("auth.invNoTokenDesc"))}</Body>
        <HomeButton label={String(t("auth.goHome"))} />
      </Shell>
    );
  }

  // ── Loading session ──────────────────────────────────────────────────────

  if (isSessionPending) {
    return (
      <Shell>
        <Spinner size="large" color="$color" />
        <Body>{String(t("auth.checkingSession"))}</Body>
      </Shell>
    );
  }

  // ── Not signed in ────────────────────────────────────────────────────────

  if (!session) {
    return (
      <Shell>
        <LogIn size={48} color="var(--accent)" />
        <Title>{String(t("auth.invSignInTitle"))}</Title>
        <Body>{String(t("auth.invSignInDesc"))}</Body>
        {/* A button, not a link: the token is stashed at click time and the
            sign-in redirect carries only the bare accept path. */}
        <Button
          variant="primary"
          onPress={() => router.push(signInHrefForInvite("org", token))}
        >
          {String(t("auth.signIn"))}
        </Button>
      </Shell>
    );
  }

  // ── Success ──────────────────────────────────────────────────────────────

  if (acceptMutation.isSuccess) {
    const result = acceptMutation.data;
    return (
      <Shell>
        <CheckCircle size={48} color="var(--success)" />
        <Title>{String(t("auth.invYoureIn"))}</Title>
        <Body>
          {String(
            t("auth.invYoureInDesc", {
              orgName: result?.orgName,
              role: roleLabel(result?.role),
            }),
          )}
        </Body>
        <Button variant="primary" onPress={() => router.push("/admin")}>
          {String(t("auth.invGoToDashboard"))}
        </Button>
      </Shell>
    );
  }

  // ── Error (preview or accept) ────────────────────────────────────────────

  const error = acceptMutation.error ?? previewQuery.error;
  if (error) {
    const quotaExceededMeta = extractQuotaExceededMeta(error);
    if (quotaExceededMeta) {
      return (
        <Shell>
          <AlertTriangle size={48} color="var(--danger)" />
          <Title>{String(t("auth.invError"))}</Title>
          <Body>{String(t("admin.quotaExceededBody"))}</Body>
          <QuotaExceededDialog
            open
            onClose={() => router.push("/")}
            meta={quotaExceededMeta}
          />
        </Shell>
      );
    }

    const code = getAppErrorCode(error);
    let title = String(t("auth.invError"));
    let description = String(t("auth.invErrorDesc"));
    if (code === "INVITATION_EXPIRED") {
      title = String(t("auth.invExpired"));
      description = String(t("auth.invExpiredDesc"));
    } else if (code === "INVITATION_NOT_PENDING") {
      const status = invitationMetaStatus(error);
      if (status === "REVOKED") {
        title = String(t("auth.invRevoked"));
        description = String(t("auth.invRevokedDesc"));
      } else if (status === "EXPIRED") {
        title = String(t("auth.invExpired"));
        description = String(t("auth.invExpiredDesc"));
      } else {
        title = String(t("auth.invAlreadyAccepted"));
        description = String(t("auth.invAlreadyAcceptedDesc"));
      }
    } else if (code === "INVITATION_NOT_FOUND") {
      // Covers BOTH causes: signed in with another email, or a link replaced
      // by a newer invitation (a re-invite rotates the token).
      description = String(t("auth.invNotValidForAccountDesc"));
    } else if (code === "EMAIL_NOT_VERIFIED") {
      description = String(t("auth.delInvVerifyEmailDesc"));
    }

    return (
      <Shell>
        <AlertTriangle size={48} color="var(--danger)" />
        <Title>{title}</Title>
        <Body>{description}</Body>
        <HomeButton label={String(t("auth.goHome"))} />
      </Shell>
    );
  }

  // ── Checking the invitation ──────────────────────────────────────────────

  const preview = previewQuery.data;
  if (!preview) {
    return (
      <Shell>
        <Spinner size="large" color="$color" />
        <Body>{String(t("auth.invChecking"))}</Body>
      </Shell>
    );
  }

  // ── Confirm (explicit consent) ───────────────────────────────────────────

  return (
    <Shell>
      <UserPlus size={48} color="var(--accent)" />
      <Title>
        {String(t("auth.invConfirmTitle", { orgName: preview.orgName }))}
      </Title>
      <Body>
        {String(
          t("auth.invConfirmDesc", {
            orgName: preview.orgName,
            role: roleLabel(preview.role),
          }),
        )}
      </Body>
      <Button
        variant="primary"
        disabled={acceptMutation.isPending}
        onPress={() => acceptMutation.mutate({ token })}
      >
        {acceptMutation.isPending
          ? String(t("auth.invAccepting"))
          : String(t("auth.invAccept"))}
      </Button>
    </Shell>
  );
};
