"use client";

import { useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, styled } from "tamagui";
import { BadgeCheck, ChevronLeft, User } from "lucide-react";

import { Text, Button, Spinner, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { useSessionVerdict } from "@/hooks/useSessionVerdict";

import { MembershipStatusCard } from "./_components/MembershipStatusCard";
import { isGrantingStatus, statusKey } from "./membership-status";

// ─────────────────────────────────────────────────────────────────────────────
// /account/memberships — the member's self-service surface. LOAD-BEARING: the
// renewal email's one-click cancel link points here. Lists every membership
// (canceled history included) and hands billing/cancel management to the
// Stripe customer portal via `memberships.portalSession` — deliberately NO
// custom cancel/card UI (spec hard rule: the portal owns self-management).
// ─────────────────────────────────────────────────────────────────────────────

const PageContainer = styled(YStack, {
  name: "MembershipsPage",
  gap: "$5",
  padding: "$4",
  width: "100%",
  maxWidth: 600,
  marginHorizontal: "auto",
  $gtMd: { padding: "$6" },
});

/** Strict-Swiss content card: square corners, structural top/bottom rules. */
const Card = styled(YStack, {
  name: "MembershipsCard",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
  overflow: "hidden",
  position: "relative",
});

const Row = styled(YStack, {
  name: "MembershipsRow",
  padding: "$4",
  gap: "$2",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
});

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export default function AccountMembershipsPage() {
  const router = useRouter();
  const t = useTranslations();
  // Three-way session read, not raw `isPending` + `data`: Better Auth cannot
  // tell "nobody is signed in" apart from "the lookup beat the freshly-set
  // cookie", and rendering the second as the first greets someone who just
  // signed in with a sign-in prompt. See `useSessionVerdict`.
  const { verdict: sessionVerdict, user } = useSessionVerdict();

  const membershipsQuery = trpc.memberships.mine.list.useQuery(undefined, {
    enabled: Boolean(user),
  });
  const portalMutation = trpc.memberships.portalSession.useMutation();
  const [portalMembershipId, setPortalMembershipId] = useState<string | null>(
    null,
  );
  const [portalError, setPortalError] = useState(false);

  const openPortal = (membershipId: string) => {
    setPortalError(false);
    setPortalMembershipId(membershipId);
    portalMutation.mutate(
      { membershipId, returnPath: "/account/memberships" },
      {
        onSuccess: ({ url }) => {
          window.location.assign(url);
        },
        onError: () => {
          setPortalMembershipId(null);
          setPortalError(true);
        },
      },
    );
  };

  if (sessionVerdict === "unknown") {
    return (
      <PageContainer
        alignItems="center"
        justifyContent="center"
        minHeight={300}
      >
        <Spinner size="lg" />
      </PageContainer>
    );
  }

  if (!user) {
    return (
      <PageContainer
        alignItems="center"
        justifyContent="center"
        minHeight={300}
        gap="$4"
      >
        <User size={48} color="var(--colorMuted)" />
        <Text variant="h3">{String(t("account.notSignedIn"))}</Text>
        <Button
          variant="primary"
          size="$3"
          onPress={() => router.push("/sign-in")}
        >
          {String(t("auth.signIn"))}
        </Button>
      </PageContainer>
    );
  }

  const items = membershipsQuery.data?.items ?? [];
  const activeItems = items.filter((m) => isGrantingStatus(m.status));
  const otherItems = items.filter((m) => !isGrantingStatus(m.status));
  const showBothSections = activeItems.length > 0 && otherItems.length > 0;

  return (
    <PageContainer>
      {/* Header */}
      <XStack alignItems="center" gap="$2">
        <Button
          variant="ghost"
          size="$2"
          onPress={() => router.push("/account")}
        >
          <ChevronLeft size={18} aria-hidden />
          {String(t("account.settingsBack"))}
        </Button>
      </XStack>

      <YStack gap="$1">
        <XStack gap="$2" alignItems="center">
          <BadgeCheck size={24} color="var(--accent)" />
          <Text
            variant="h3"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={-0.5}
          >
            {String(t("accountMemberships.title"))}
          </Text>
        </XStack>
        <Text variant="body" tone="muted">
          {String(t("accountMemberships.subtitle"))}
        </Text>
      </YStack>

      {portalError && (
        <Text variant="bodySmall" tone="error" role="alert">
          {String(t("accountMemberships.portalError"))}
        </Text>
      )}

      {membershipsQuery.isPending ? (
        <YStack alignItems="center" paddingVertical="$6">
          <Spinner size="lg" />
        </YStack>
      ) : membershipsQuery.isError ? (
        <Card>
          <Row borderBottomWidth={0}>
            <Text variant="body" tone="muted">
              {String(t("accountMemberships.loadError"))}
            </Text>
          </Row>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <Row borderBottomWidth={0}>
            <Text variant="body" tone="muted">
              {String(t("accountMemberships.empty"))}
            </Text>
          </Row>
        </Card>
      ) : (
        <YStack gap="$5">
          {activeItems.length > 0 && (
            <YStack gap="$3">
              {showBothSections && (
                <Text
                  variant="overline"
                  tone="muted"
                  letterSpacing={1.5}
                >
                  {String(t("accountMemberships.activeSectionLabel"))}
                </Text>
              )}
              <YStack gap="$4">
                {activeItems.map((membership) => (
                  <MembershipStatusCard
                    key={membership.id}
                    membership={membership}
                    onManageBilling={openPortal}
                    isManagingBilling={
                      portalMutation.isPending &&
                      portalMembershipId === membership.id
                    }
                  />
                ))}
              </YStack>
            </YStack>
          )}

          {otherItems.length > 0 && (
            <YStack gap="$3">
              {showBothSections && (
                <Text
                  variant="overline"
                  tone="muted"
                  letterSpacing={1.5}
                >
                  {String(t("accountMemberships.otherSectionLabel"))}
                </Text>
              )}
              <Card>
                {otherItems.map((membership, idx) => {
                  const isLast = idx === otherItems.length - 1;
                  const periodEnd = toDate(membership.currentPeriodEnd);
                  const priceLine = `${formatCurrency(
                    membership.tier.priceCents,
                    membership.tier.currency,
                  )} ${String(
                    t(
                      membership.tier.interval === "YEAR"
                        ? "accountMemberships.perYear"
                        : "accountMemberships.perMonth",
                    ),
                  )}`;
                  return (
                    <Row
                      key={membership.id}
                      borderBottomWidth={isLast ? 0 : 1}
                    >
                      <XStack
                        justifyContent="space-between"
                        alignItems="flex-start"
                        gap="$3"
                        flexWrap="wrap"
                      >
                        <YStack gap="$1" flex={1} minWidth={180}>
                          <Text variant="body" weight="bold">
                            {membership.tier.name}
                          </Text>
                          {membership.owner.name && (
                            <Text variant="bodySmall" tone="muted">
                              {membership.owner.name}
                            </Text>
                          )}
                          <Text variant="bodySmall" tone="muted">
                            {priceLine}
                          </Text>
                        </YStack>
                        <YStack gap="$1" alignItems="flex-end">
                          <Text
                            variant="bodySmall"
                            weight="bold"
                            tone="muted"
                            textTransform="uppercase"
                            letterSpacing={0.8}
                          >
                            {String(t(statusKey(membership.status)))}
                          </Text>
                          {membership.cancelAtPeriodEnd && (
                            <Text variant="bodySmall" tone="muted">
                              {String(
                                t("accountMemberships.endsOn", {
                                  date: formatDateShort(periodEnd),
                                }),
                              )}
                            </Text>
                          )}
                        </YStack>
                      </XStack>
                      <XStack>
                        <Button
                          variant="outlined"
                          size="$2"
                          onPress={() => openPortal(membership.id)}
                          disabled={
                            portalMutation.isPending &&
                            portalMembershipId === membership.id
                          }
                          aria-busy={
                            portalMutation.isPending &&
                            portalMembershipId === membership.id
                          }
                        >
                          {String(t("accountMemberships.manageBilling"))}
                        </Button>
                      </XStack>
                    </Row>
                  );
                })}
              </Card>
            </YStack>
          )}
        </YStack>
      )}
    </PageContainer>
  );
}
