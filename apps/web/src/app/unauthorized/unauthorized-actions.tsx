"use client";

// This is a client-side component, so we can use the overlay provider.
// However, the overlay provider needs to be in the tree.
// Assuming UnauthorizedActions is used inside AppShell, it should have access.
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { authClient } from "@/lib/auth/auth-client";
import { XStack } from "tamagui";
import { Button, NextLinkAnchor, useTranslations } from "@th/ui";

export function UnauthorizedActions() {
  const { showSignInOverlay } = useAppOverlay();
  const t = useTranslations();
  // Use the auth session directly rather than a tRPC profile query. The user
  // may be authenticated via Better Auth but lack a Human record (which would
  // make any authedProcedure call fail), so we rely on the session itself.
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const isSignedIn = !isSessionPending && Boolean(session?.user);

  return (
    <XStack gap="$3" flexWrap="wrap" alignItems="center">
      {!isSignedIn ? (
        <Button
          variant="secondary"
          onPress={() => showSignInOverlay({ redirect: "/admin" })}
        >
          {String(t("auth.signIn"))}
        </Button>
      ) : null}
      {isSignedIn ? (
        <NextLinkAnchor href="/admin">
          {String(t("auth.backToAdmin"))}
        </NextLinkAnchor>
      ) : null}
      <NextLinkAnchor href="/">{String(t("auth.goHome"))}</NextLinkAnchor>
    </XStack>
  );
}
