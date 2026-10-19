"use client";

import { YStack } from "tamagui";
import { Text, Button, Spinner, useTranslations } from "@th/ui";
import { User } from "lucide-react";
import Link from "next/link";

import { useSessionVerdict } from "@/hooks/useSessionVerdict";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import { PageEditorView } from "@/components/entity-pages";

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function AccountPageEditor() {
  // Three-way session read, not raw `isPending` + `data`: Better Auth cannot
  // tell "nobody is signed in" apart from "the lookup beat the freshly-set
  // cookie", and rendering the second as the first greets someone who just
  // signed in with a sign-in prompt. See `useSessionVerdict`.
  const { verdict: sessionVerdict, user } = useSessionVerdict();
  const { ownersWithSlugs, isLoading: ownersLoading } = useEventOwnerEntities();
  const t = useTranslations();

  const isLoading = sessionVerdict === "unknown" || ownersLoading;

  // Resolve humanId from the owner entities
  const humanOwner = ownersWithSlugs?.find((o) => o.kind === "human");
  const humanId = humanOwner?.kind === "human" ? humanOwner.humanId : undefined;

  // ── Not signed in ───────────────────────────────────────────
  if (!isLoading && !user) {
    return (
      <YStack
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={300}
        gap="$4"
      >
        <User size={48} color="var(--colorMuted)" />
        <Text variant="h3">{String(t("admin.peSignInRequired"))}</Text>
        <Text variant="body" tone="muted" textAlign="center">
          {String(t("admin.peSignInRequiredDescription"))}
        </Text>
        <Link href="/sign-in">
          <Button tag="span" variant="primary" size="$3">
            {String(t("admin.peSignIn"))}
          </Button>
        </Link>
      </YStack>
    );
  }

  // ── Loading ─────────────────────────────────────────────────
  if (isLoading || !humanId) {
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

  return (
    <PageEditorView
      ownerType="HUMAN"
      ownerId={humanId}
      title={String(t("account.myPage"))}
      backHref="/account"
    />
  );
}
