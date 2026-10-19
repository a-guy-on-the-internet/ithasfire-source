"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@bprogress/next/app";
import { YStack, Spinner } from "tamagui";
import { AlertTriangle, CheckCircle, LogIn, UserPlus } from "lucide-react";

import { Text, Button, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { getAppErrorCode } from "@/lib/app-error";
import {
  clearStashedInviteToken,
  signInHrefForInvite,
  useInviteToken,
} from "@/lib/pending-invite-token";

type AcceptDelegateInviteProps = {
  token: string | null;
};

const Shell = ({ children }: { children: ReactNode }) => (
  <YStack alignItems="center" justifyContent="center" padding="$8" gap="$4">
    {children}
  </YStack>
);

const Title = ({ children }: { children: ReactNode }) => (
  <Text variant="h3" textAlign="center" letterSpacing={-0.5}>
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
  ADMIN: "admin.roleAdmin",
  EDITOR: "admin.roleEditor",
  FINANCE: "admin.roleFinance",
  SCANNER: "admin.roleScanner",
  VIEWER: "admin.roleViewer",
};

/**
 * Explicit-consent accept screen for a delegate invitation. Never accepts on
 * load: it first runs `delegates.previewInvite` (read-only; answers only the
 * account the link was made for) to say WHO is inviting and for WHICH role,
 * then waits for Accept.
 *
 * States mirror `/invite/accept` (no token → signed out → checking → confirm
 * → accepting → error / success) and share its copy where the words fit.
 */
export const AcceptDelegateInvite = ({
  token: urlToken,
}: AcceptDelegateInviteProps) => {
  const router = useRouter();
  const { token, resolved: tokenResolved } = useInviteToken(
    "delegate",
    urlToken,
  );
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
    queryKey: ["delegates.previewInvite", token],
    queryFn: () => utils.client.delegates.previewInvite.mutate({ token: token ?? "" }),
    enabled: Boolean(token) && !isSessionPending && Boolean(session),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const acceptMutation = trpc.delegates.acceptInvite.useMutation({
    meta: { silent: true },
    onSuccess: () => clearStashedInviteToken("delegate"),
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
      clearStashedInviteToken("delegate");
    }
  }, [terminalCode]);

  const roleLabel = (role: string) =>
    ROLE_LABEL_KEYS[role] ? String(t(ROLE_LABEL_KEYS[role])) : role.toLowerCase();

  if (!tokenResolved) {
    return (
      <Shell>
        <Spinner size="large" color="$color" />
        <Body>{String(t("auth.invChecking"))}</Body>
      </Shell>
    );
  }

  if (!token) {
    return (
      <Shell>
        <AlertTriangle size={48} color="var(--danger)" />
        <Title>{String(t("auth.invInvalidLink"))}</Title>
        <Body>{String(t("auth.delInvNoTokenDesc"))}</Body>
        <HomeButton label={String(t("auth.goHome"))} />
      </Shell>
    );
  }

  if (isSessionPending) {
    return (
      <Shell>
        <Spinner size="large" color="$color" />
        <Body>{String(t("auth.checkingSession"))}</Body>
      </Shell>
    );
  }

  if (!session) {
    return (
      <Shell>
        <LogIn size={48} color="var(--accent)" />
        <Title>{String(t("auth.invSignInTitle"))}</Title>
        <Body>{String(t("auth.delInvSignInDesc"))}</Body>
        {/* A button, not a link: the token is stashed at click time and the
            sign-in redirect carries only the bare accept path. */}
        <Button
          variant="primary"
          onPress={() => router.push(signInHrefForInvite("delegate", token))}
        >
          {String(t("auth.signIn"))}
        </Button>
      </Shell>
    );
  }

  if (acceptMutation.isSuccess) {
    const result = acceptMutation.data;
    return (
      <Shell>
        <CheckCircle size={48} color="var(--success)" />
        <Title>{String(t("auth.invYoureIn"))}</Title>
        <Body>
          {String(
            result.principalName
              ? t("auth.delInvYoureInDesc", {
                  name: result.principalName,
                  role: roleLabel(result.role),
                })
              : t("auth.delInvYoureInDescUnnamed", {
                  role: roleLabel(result.role),
                }),
          )}
        </Body>
        <Link href="/admin">
          <Button tag="span" variant="primary">
            {String(t("auth.invGoToDashboard"))}
          </Button>
        </Link>
      </Shell>
    );
  }

  const error = acceptMutation.error ?? previewQuery.error;
  if (error) {
    const code = getAppErrorCode(error);
    let title = String(t("auth.invError"));
    let description = String(t("auth.delInvErrorDesc"));
    if (code === "INVITATION_EXPIRED") {
      title = String(t("auth.invExpired"));
      description = String(t("auth.delInvExpiredDesc"));
    } else if (code === "INVITATION_NOT_PENDING") {
      title = String(t("auth.invAlreadyAccepted"));
      description = String(t("auth.delInvAlreadyUsedDesc"));
    } else if (code === "INVITATION_NOT_FOUND") {
      description = String(t("auth.delInvWrongAccountDesc"));
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

  const preview = previewQuery.data;
  if (!preview) {
    return (
      <Shell>
        <Spinner size="large" color="$color" />
        <Body>{String(t("auth.invChecking"))}</Body>
      </Shell>
    );
  }

  return (
    <Shell>
      <UserPlus size={48} color="var(--accent)" />
      <Title>{String(t("auth.delInvConfirmTitle"))}</Title>
      <Body>
        {String(
          preview.principalName
            ? t("auth.delInvConfirmDesc", {
                name: preview.principalName,
                role: roleLabel(preview.role),
              })
            : t("auth.delInvConfirmDescUnnamed", {
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
          : String(t("auth.delInvAccept"))}
      </Button>
    </Shell>
  );
};
