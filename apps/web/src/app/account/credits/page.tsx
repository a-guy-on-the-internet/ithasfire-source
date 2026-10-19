"use client";

import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, styled } from "tamagui";
import { Wallet, ChevronLeft, Clock, User } from "lucide-react";

import { Text, Button, Spinner, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { EmailVerificationRequired } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { useSessionVerdict } from "@/hooks/useSessionVerdict";

// ─────────────────────────────────────────────────────────────────────────────

const PageContainer = styled(YStack, {
  name: "CreditsPage",
  gap: "$5",
  padding: "$4",
  width: "100%",
  maxWidth: 600,
  marginHorizontal: "auto",
  $gtMd: { padding: "$6" },
});

/** Strict-Swiss content card: square corners, structural top/bottom rules. */
const Card = styled(YStack, {
  name: "CreditsCard",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
  overflow: "hidden",
  position: "relative",
});

const Row = styled(XStack, {
  name: "CreditsRow",
  padding: "$4",
  gap: "$3",
  alignItems: "center",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
});

const SectionLabel = styled(Text, {
  name: "CreditsSectionLabel",
  variant: "bodySmall",
  weight: "bold",
  tone: "muted",
  textTransform: "uppercase",
  letterSpacing: 0.8,
});

// ─────────────────────────────────────────────────────────────────────────────

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

export default function AccountCreditsPage() {
  const router = useRouter();
  const t = useTranslations();
  // Three-way session read, not raw `isPending` + `data`: Better Auth cannot
  // tell "nobody is signed in" apart from "the lookup beat the freshly-set
  // cookie", and rendering the second as the first greets someone who just
  // signed in with a sign-in prompt. See `useSessionVerdict`.
  const { verdict: sessionVerdict, user } = useSessionVerdict();

  const creditsQuery = trpc.credits.listMine.useQuery(undefined, {
    enabled: Boolean(user),
  });

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

  const data = creditsQuery.data;
  const balances = data
    ? Object.entries(data.activeBalanceByCurrency)
    : [];
  const activeCredits = (data?.credits ?? []).filter((c) => {
    const expired = (() => {
      const exp = toDate(c.expiresAt);
      return exp != null && exp.getTime() <= Date.now();
    })();
    return c.status === "ACTIVE" && !expired && c.balanceCents > 0;
  });
  const redemptions = data?.redemptions ?? [];
  const currencyByCreditId = new Map(
    (data?.credits ?? []).map((c) => [c.id, c.currency]),
  );

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
          <Wallet size={24} color="var(--accent)" />
          <Text
            variant="h3"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={-0.5}
          >
            {String(t("account.credits"))}
          </Text>
        </XStack>
        <Text variant="body" tone="muted">
          {String(t("account.creditsSubtitle"))}
        </Text>
      </YStack>

      {creditsQuery.isPending ? (
        <YStack alignItems="center" paddingVertical="$6">
          <Spinner size="lg" />
        </YStack>
      ) : isEmailVerificationRequired(creditsQuery.error) ? (
        // B2: credits come from orders on this email, withheld until verified.
        <EmailVerificationRequired context="credits" />
      ) : creditsQuery.isError ? (
        <Card>
          <Row borderBottomWidth={0}>
            <Text variant="body" tone="muted">
              {String(t("account.creditsLoadError"))}
            </Text>
          </Row>
        </Card>
      ) : (
        <>
          {/* Available balance */}
          <YStack gap="$2">
            <SectionLabel>{String(t("account.creditsBalance"))}</SectionLabel>
            <Card>
              {balances.length === 0 ? (
                <Row borderBottomWidth={0}>
                  <Text variant="body" tone="muted">
                    {String(t("account.creditsNone"))}
                  </Text>
                </Row>
              ) : (
                balances.map(([currency, cents], idx) => (
                  <Row
                    key={currency}
                    borderBottomWidth={idx === balances.length - 1 ? 0 : 1}
                    justifyContent="space-between"
                  >
                    <Text
                      variant="body"
                      tone="muted"
                      textTransform="uppercase"
                    >
                      {currency}
                    </Text>
                    <Text variant="h3" weight="bold" tone="success">
                      {formatCurrency(cents, currency)}
                    </Text>
                  </Row>
                ))
              )}
            </Card>
          </YStack>

          {/* Active credits with expiry */}
          {activeCredits.length > 0 && (
            <YStack gap="$2">
              <SectionLabel>{String(t("account.credits"))}</SectionLabel>
              <Card>
                {activeCredits.map((credit, idx) => {
                  const exp = toDate(credit.expiresAt);
                  return (
                    <Row
                      key={credit.id}
                      borderBottomWidth={
                        idx === activeCredits.length - 1 ? 0 : 1
                      }
                      justifyContent="space-between"
                    >
                      <YStack gap="$1" flex={1}>
                        <Text variant="body">{credit.reason}</Text>
                        <XStack gap="$1" alignItems="center">
                          <Clock size={12} color="var(--colorMuted)" />
                          <Text variant="bodySmall" tone="muted">
                            {exp
                              ? String(
                                  t("account.creditsExpires", {
                                    date: formatDateShort(exp),
                                  }),
                                )
                              : String(t("account.creditsNoExpiry"))}
                          </Text>
                        </XStack>
                      </YStack>
                      <Text variant="body" weight="bold" tone="success">
                        {formatCurrency(
                          credit.balanceCents,
                          credit.currency,
                        )}
                      </Text>
                    </Row>
                  );
                })}
              </Card>
            </YStack>
          )}

          {/* Redemption history */}
          <YStack gap="$2">
            <SectionLabel>{String(t("account.creditsHistory"))}</SectionLabel>
            <Card>
              {redemptions.length === 0 ? (
                <Row borderBottomWidth={0}>
                  <Text variant="body" tone="muted">
                    {String(t("account.creditsHistoryNone"))}
                  </Text>
                </Row>
              ) : (
                redemptions.map((redemption, idx) => {
                  const redeemedAt = toDate(redemption.redeemedAt);
                  return (
                    <Row
                      key={redemption.id}
                      borderBottomWidth={
                        idx === redemptions.length - 1 ? 0 : 1
                      }
                      justifyContent="space-between"
                    >
                      <Text variant="bodySmall" tone="muted">
                        {redeemedAt
                          ? String(
                              t("account.creditsRedeemedOn", {
                                date: formatDateShort(redeemedAt),
                              }),
                            )
                          : ""}
                      </Text>
                      <Text variant="body" weight="bold">
                        {formatCurrency(
                          redemption.amountCents,
                          currencyByCreditId.get(redemption.creditId) ?? "usd",
                        )}
                      </Text>
                    </Row>
                  );
                })
              )}
            </Card>
          </YStack>
        </>
      )}
    </PageContainer>
  );
}
