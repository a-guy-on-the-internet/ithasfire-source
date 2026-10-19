"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack, styled } from "tamagui";
import { Building2, User } from "lucide-react";

import { Avatar, CardSurface, Spinner, Text, useTranslations } from "@th/ui";

import { authClient } from "@/lib/auth/auth-client";
import {
  useEventOwnerEntities,
  type OwnerEntityWithSlug,
} from "@/hooks/useEventOwnerEntities";
import { useCreateDraftEvent } from "@/hooks/useCreateDraftEvent";

const PageContainer = styled(YStack, {
  name: "PageContainer",
  flex: 1,
  alignItems: "center",
  padding: "$6",
  paddingTop: "$10",
  minHeight: "100vh",
  backgroundColor: "$background",
});

const ContentContainer = styled(YStack, {
  name: "ContentContainer",
  width: "100%",
  maxWidth: 900,
  gap: "$6",
});

const EntityGrid = styled(XStack, {
  name: "EntityGrid",
  flexWrap: "wrap",
  gap: "$4",
});

const ROLE_KEY: Record<string, string> = {
  OWNER: "admin.arRoleOwner",
  ADMIN: "admin.arRoleAdmin",
  EDITOR: "admin.arRoleEditor",
  FINANCE: "admin.arRoleFinance",
  VIEWER: "admin.arRoleViewer",
  SCANNER: "admin.arRoleScanner",
};

const LoadingContainer = styled(YStack, {
  name: "LoadingContainer",
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100vh",
  padding: "$6",
  gap: "$4",
});

/**
 * Admin root page client component.
 *
 * - If user has no org memberships (only "self"), redirect to their personal dashboard.
 * - If user belongs to one or more organizations, show a grid of all entities they can manage.
 */
export function AdminRoot() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const intent = searchParams.get("intent"); // e.g. "create-event"
  // Use `isPending` rather than `isLoading` so we also wait while the
  // auth session is still resolving (query is `enabled: false` → `isLoading`
  // is false, but `isPending` is true because there's no data yet).
  const { ownersWithSlugs, isPending, isError } = useEventOwnerEntities();
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const isSignedIn = !isSessionPending && Boolean(session?.user);
  const t = useTranslations();

  // Determine if user has any org memberships
  const orgs = ownersWithSlugs?.filter((e) => e.kind === "org") ?? [];
  const human = ownersWithSlugs?.find((e) => e.kind === "human");
  const hasOrgs = orgs.length > 0;

  // Auto-redirect if user only has self (no org memberships)
  useEffect(() => {
    if (isPending || isSessionPending) return;

    // Only redirect to /unauthorized when the user is genuinely not signed in.
    // If they are signed in but the tRPC query errored (e.g. no Human record),
    // we show an inline error instead of a confusing redirect.
    if (!isSignedIn) {
      router.replace("/unauthorized");
      return;
    }

    // Query succeeded; no owners returned → shouldn't normally happen since
    // the use case always returns the human entry, but guard defensively.
    if (!isError && ownersWithSlugs?.length === 0) {
      router.replace("/unauthorized");
      return;
    }

    // If user has no org memberships, redirect to their personal dashboard
    // (or events page when intent is to create an event)
    if (!isError && !hasOrgs && human) {
      const slug = encodeURIComponent(human.adminSlug);
      router.replace(
        intent === "create-event"
          ? `/admin/${slug}/events`
          : `/admin/${slug}/dashboard`,
      );
    }
  }, [
    isPending,
    isSessionPending,
    isSignedIn,
    isError,
    ownersWithSlugs,
    hasOrgs,
    human,
    router,
    intent,
  ]);

  // Show loading state while fetching or auto-redirecting
  if (isPending || isSessionPending || (!isError && !hasOrgs && human)) {
    return (
      <LoadingContainer>
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.arLoading"))}
        </Text>
      </LoadingContainer>
    );
  }

  // Signed in but the owner-entities query failed (e.g. no linked Human record).
  // Show an actionable error instead of redirecting to /unauthorized.
  if (isError) {
    return (
      <LoadingContainer>
        <CardSurface
          width="100%"
          maxWidth={520}
          borderColor="$borderColor"
          borderRadius={0}
          padding="$5"
          gap="$3"
        >
          <Text variant="h3" weight="bold">
            {String(t("admin.arAccountSetupTitle"))}
          </Text>
          <Text variant="body" tone="muted">
            {String(t("admin.arAccountSetupMessage"))}
          </Text>
          <XStack gap="$3" flexWrap="wrap" alignItems="center" paddingTop="$2">
            <CardSurface
              padding="$3"
              paddingHorizontal="$4"
              borderColor="$borderColor"
              borderRadius={0}
              hoverStyle={{
                backgroundColor: "$backgroundHover",
                cursor: "pointer",
              }}
              pressStyle={{ opacity: 0.9, scale: 0.98 }}
              onPress={() => router.push("/")}
              role="button"
              tabIndex={0}
            >
              <Text variant="body">{String(t("auth.goHome"))}</Text>
            </CardSurface>
          </XStack>
        </CardSurface>
      </LoadingContainer>
    );
  }

  // If redirecting to unauthorized (not signed in)
  if (!ownersWithSlugs || ownersWithSlugs.length === 0) {
    return (
      <LoadingContainer>
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.arRedirecting"))}
        </Text>
      </LoadingContainer>
    );
  }

  // User has org memberships, show grid of all entities
  return (
    <PageContainer>
      <ContentContainer>
        <YStack gap="$2">
          <Text variant="h2" weight="bold">
            {intent === "create-event"
              ? String(t("admin.arSelectAccountToCreate"))
              : String(t("admin.arAdminDashboard"))}
          </Text>
          <Text variant="body" tone="muted">
            {intent === "create-event"
              ? String(t("admin.arSelectAccountToCreateDesc"))
              : String(t("admin.arSelectAccount"))}
          </Text>
        </YStack>

        <EntityGrid>
          {ownersWithSlugs.map((entity) => (
            <EntityCard
              key={entity.adminSlug}
              entity={entity}
              intent={intent}
            />
          ))}
        </EntityGrid>
      </ContentContainer>
    </PageContainer>
  );
}

function EntityCard({
  entity,
  intent,
}: {
  entity: OwnerEntityWithSlug;
  intent: string | null;
}) {
  const router = useRouter();
  const t = useTranslations();
  const isOrg = entity.kind === "org";

  const slug = encodeURIComponent(entity.adminSlug);
  // `createDraft` navigates (to quick create, or opens the moderator
  // mode-choice dialog) — it never mutates, so there is no pending state to
  // dim the card for.
  const { createDraft, modeChoiceDialog } = useCreateDraftEvent(
    entity.adminSlug,
  );

  const handlePress = () => {
    if (intent === "create-event") {
      // Directly trigger draft creation and navigate to the editor
      void createDraft();
    } else {
      router.push(`/admin/${slug}/dashboard`);
    }
  };

  return (
    <CardSurface
      width={260}
      padding="$5"
      gap="$3"
      borderColor="$borderColor"
      backgroundColor="$surface"
      hoverStyle={{
        backgroundColor: "$backgroundHover",
        borderColor: "$accent",
        cursor: "pointer",
      }}
      pressStyle={{
        opacity: 0.9,
        scale: 0.98,
      }}
      onPress={handlePress}
      role="button"
      tabIndex={0}
    >
      <XStack alignItems="center" gap="$3">
        <Avatar
          size="md"
          // Show the entity's real logo / avatar when it has one so the card
          // is instantly recognizable. The glyph below is the fallback, also
          // shown while the image loads.
          src={entity.avatarUrl ?? undefined}
          alt={isOrg ? entity.orgName : entity.humanName}
          backgroundColor={isOrg ? "$accent" : "$surfaceMuted"}
        >
          {isOrg ? (
            // Org fallback tile is the $accent fill — light glyph is correct.
            <Building2 size={26} color="var(--onBrandSecondary, #FFFFFF)" />
          ) : (
            // Human fallback tile is $surfaceMuted (#EFE7D6 paper on Stub) — a
            // white glyph was invisible on it. Ink, like content on paper.
            <User size={26} color="var(--color, #211C16)" />
          )}
        </Avatar>
        <YStack flex={1} gap="$1">
          <Text variant="body" weight="bold" truncate>
            {isOrg ? entity.orgName : entity.humanName}
          </Text>
          <Text variant="caption" tone="muted" truncate>
            {isOrg
              ? String(
                  t("admin.arRoleLabel", {
                    role: ROLE_KEY[entity.role]
                      ? String(t(ROLE_KEY[entity.role]))
                      : entity.role,
                  }),
                )
              : String(t("admin.arPersonalAccount"))}
          </Text>
        </YStack>
      </XStack>
      {/* Portals to document.body — clicks never bubble into the card. */}
      {modeChoiceDialog}
    </CardSurface>
  );
}
