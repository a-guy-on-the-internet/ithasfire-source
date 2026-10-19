"use client";

import { useParams } from "next/navigation";
import { YStack } from "tamagui";
import { Text, Spinner, useTranslations } from "@th/ui";

import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";
import { PageEditorView } from "@/components/entity-pages";

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

function OrgPageEditorInner() {
  const { slug } = useParams<{ slug: string }>();
  const { currentOwner, isLoading } = useCurrentAdminOwner(slug);
  const t = useTranslations();

  if (isLoading) {
    return (
      <YStack
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={300}
      >
        <Spinner size="lg" />
      </YStack>
    );
  }

  if (currentOwner?.kind !== "org") {
    return (
      <YStack
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={300}
        gap="$3"
      >
        <Text variant="h3" tone="muted">
          {String(t("admin.peOrgNotFound"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("admin.peOrgNotFoundDescription"))}
        </Text>
      </YStack>
    );
  }

  return (
    <PageEditorView
      ownerType="ORGANIZATION"
      ownerId={currentOwner.orgId}
      title={`${currentOwner.orgName} — Page`}
      showLiveHeader={false}
    />
  );
}

export default function AdminOrgPageEditor() {
  return (
    <AdminEmailVerificationGate mode="block">
      <OrgPageEditorInner />
    </AdminEmailVerificationGate>
  );
}
