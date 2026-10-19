"use client";

import { useEffect } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack } from "tamagui";

import { Spinner, Text, useTranslations } from "@th/ui";

import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import { resolveAgreementsListRedirect } from "@/lib/agreement-routes";
import { authClient } from "@/lib/auth/auth-client";
import { getSignInUrl } from "@/lib/auth/urls";
import { appendRedirectParam } from "@/lib/redirect";

const LIST_PATH = "/agreements";

/**
 * Client redirector for the retired `/agreements` list.
 *
 * The middleware only checks that a session COOKIE exists — it is not an auth
 * boundary (`private-route-gate.ts`). A stale cookie resolves to no user,
 * and the owners query then never fires (`enabled: false` stays "pending"
 * forever), so the session is read here too: no user → the sign-in page
 * with the gate's own redirect-back convention, exactly like `AdminRoot`.
 *
 * With a user, wait for the owner entities, then `router.replace` per
 * `resolveAgreementsListRedirect`. A failed owners read still leaves: no org
 * can be known, so the performer surface is the safe landing. Any query
 * string is deliberately ignored.
 */
export function AgreementsRedirect() {
  const router = useRouter();
  const t = useTranslations();
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const { ownersWithSlugs, isPending, isError } = useEventOwnerEntities();

  useEffect(() => {
    if (isSessionPending) return;
    if (!session?.user) {
      router.replace(appendRedirectParam(getSignInUrl(), LIST_PATH));
      return;
    }
    if (isPending && !isError) return;
    router.replace(resolveAgreementsListRedirect(ownersWithSlugs));
  }, [isSessionPending, session, isPending, isError, ownersWithSlugs, router]);

  return (
    <YStack
      flex={1}
      minHeight="60vh"
      alignItems="center"
      justifyContent="center"
      gap="$4"
      padding="$6"
      role="status"
    >
      <Spinner size="lg" />
      <Text variant="body" tone="muted">
        {String(t("admin.arLoading"))}
      </Text>
    </YStack>
  );
}
