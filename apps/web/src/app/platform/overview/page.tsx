"use client";

import { styled, useTheme, YStack, XStack, Spinner } from "tamagui";
import { PlatformContainer } from "../_components/PlatformPageParts";
import { Text, useTranslations } from "@th/ui";
import {
  Shield,
  MapPin,
  ShoppingCart,
  Ticket,
  DollarSign,
  CalendarDays,
  Users,
  Building2,
  CheckCircle,
} from "lucide-react";
import { useRouter } from "@bprogress/next/app";
import { trpc } from "@/trpc";
import { formatCurrency } from "@/lib/format";

/* ── Styled primitives ─────────────────────────────────────────────── */

const PageTitle = styled(Text, {
  tag: "h1",
  fontSize: 24,
  weight: "bold",
  color: "$color",
});

const Subtitle = styled(Text, {
  fontSize: 14,
  color: "$colorMuted",
});

const SectionTitle = styled(Text, {
  fontSize: 18,
  weight: "semibold",
  color: "$color",
});

const StatsGrid = styled(XStack, {
  gap: 16,
  flexWrap: "wrap",
});

const StatCard = styled(YStack, {
  padding: 20,
  borderWidth: 1,
  borderColor: "$borderColor",
  gap: 8,
  flex: 1,
  minWidth: 200,
  backgroundColor: "$surface",
});

const StatValue = styled(Text, {
  fontSize: 28,
  weight: "bold",
  color: "$color",
});

const StatLabel = styled(Text, {
  fontSize: 13,
  color: "$colorMuted",
});

const CardGrid = styled(XStack, {
  gap: 16,
  flexWrap: "wrap",
});

const Card = styled(YStack, {
  padding: 24,
  borderWidth: 1,
  borderColor: "$borderColor",
  gap: 12,
  flex: 1,
  minWidth: 240,
  cursor: "pointer",
  backgroundColor: "$surface",
  hoverStyle: {
    borderColor: "$borderColorHover",
  },
});

const CardTitle = styled(Text, {
  fontSize: 16,
  weight: "semibold",
  color: "$color",
});

const CardDescription = styled(Text, {
  fontSize: 13,
  color: "$colorMuted",
  lineHeight: 20,
});

/* ── Helpers ───────────────────────────────────────────────────────── */

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/* ── Component ─────────────────────────────────────────────────────── */

export default function PlatformOverviewPage() {
  const router = useRouter();
  const theme = useTheme();
  const t = useTranslations();
  const { data: stats, isLoading } = trpc.platform.getStats.useQuery({});

  return (
    <PlatformContainer size="sm">
      {/* Header */}
      <YStack gap={8}>
        <XStack gap={8} alignItems="center">
          <Shield size={20} color={theme.color?.val} />
          <PageTitle>{String(t("admin.poPlatform"))}</PageTitle>
        </XStack>
        <Subtitle>{String(t("admin.poSubtitle"))}</Subtitle>
      </YStack>

      {/* Stats section */}
      <YStack gap={16}>
        <SectionTitle>{String(t("admin.poStatsTitle"))}</SectionTitle>

        {isLoading ? (
          <XStack gap={8} alignItems="center" paddingVertical={24}>
            <Spinner size="small" />
            <Text tone="muted" fontSize={13}>
              {String(t("admin.poStatsLoading"))}
            </Text>
          </XStack>
        ) : stats ? (
          <StatsGrid testID="platform-stats-grid">
            <StatCard>
              <XStack gap={6} alignItems="center">
                <DollarSign size={16} color={theme.color?.val} />
                <StatLabel>{String(t("admin.poStatGrossRevenue"))}</StatLabel>
              </XStack>
              <StatValue>
                {formatCurrency(stats.totalGrossRevenueCents)}
              </StatValue>
            </StatCard>

            <StatCard>
              <XStack gap={6} alignItems="center">
                <DollarSign size={16} color={theme.color?.val} />
                <StatLabel>{String(t("admin.poStatPlatformFees"))}</StatLabel>
              </XStack>
              <StatValue>
                {formatCurrency(stats.totalPlatformFeesCents)}
              </StatValue>
            </StatCard>

            <StatCard>
              <XStack gap={6} alignItems="center">
                <ShoppingCart size={16} color={theme.color?.val} />
                <StatLabel>{String(t("admin.poStatTotalOrders"))}</StatLabel>
              </XStack>
              <StatValue>{formatNumber(stats.totalOrders)}</StatValue>
            </StatCard>

            <StatCard>
              <XStack gap={6} alignItems="center">
                <CheckCircle size={16} color={theme.color?.val} />
                <StatLabel>
                  {String(t("admin.poStatCapturedOrders"))}
                </StatLabel>
              </XStack>
              <StatValue>{formatNumber(stats.totalSucceededOrders)}</StatValue>
            </StatCard>

            <StatCard>
              <XStack gap={6} alignItems="center">
                <CalendarDays size={16} color={theme.color?.val} />
                <StatLabel>{String(t("admin.poStatTotalEvents"))}</StatLabel>
              </XStack>
              <StatValue>{formatNumber(stats.totalEvents)}</StatValue>
            </StatCard>

            <StatCard>
              <XStack gap={6} alignItems="center">
                <Ticket size={16} color={theme.color?.val} />
                <StatLabel>{String(t("admin.poStatTicketsSold"))}</StatLabel>
              </XStack>
              <StatValue>{formatNumber(stats.totalTicketsSold)}</StatValue>
            </StatCard>

            <StatCard>
              <XStack gap={6} alignItems="center">
                <Users size={16} color={theme.color?.val} />
                <StatLabel>{String(t("admin.poStatTotalHumans"))}</StatLabel>
              </XStack>
              <StatValue>{formatNumber(stats.totalHumans)}</StatValue>
            </StatCard>

            <StatCard>
              <XStack gap={6} alignItems="center">
                <Building2 size={16} color={theme.color?.val} />
                <StatLabel>{String(t("admin.poStatTotalOrgs"))}</StatLabel>
              </XStack>
              <StatValue>{formatNumber(stats.totalOrganizations)}</StatValue>
            </StatCard>
          </StatsGrid>
        ) : null}
      </YStack>

      {/* Quick links section */}
      <YStack gap={16}>
        <SectionTitle>{String(t("admin.poQuickLinksTitle"))}</SectionTitle>

        <CardGrid>
          <Card onPress={() => router.push("/platform/orders")}>
            <XStack gap={8} alignItems="center">
              <ShoppingCart size={18} color={theme.color?.val} />
              <CardTitle>{String(t("admin.poOrders"))}</CardTitle>
            </XStack>
            <CardDescription>{String(t("admin.poOrdersDesc"))}</CardDescription>
          </Card>

          <Card onPress={() => router.push("/platform/tickets")}>
            <XStack gap={8} alignItems="center">
              <Ticket size={18} color={theme.color?.val} />
              <CardTitle>{String(t("admin.poTickets"))}</CardTitle>
            </XStack>
            <CardDescription>
              {String(t("admin.poTicketsDesc"))}
            </CardDescription>
          </Card>

          <Card onPress={() => router.push("/platform/places")}>
            <XStack gap={8} alignItems="center">
              <MapPin size={18} color={theme.color?.val} />
              <CardTitle>{String(t("admin.poPlaceVerification"))}</CardTitle>
            </XStack>
            <CardDescription>
              {String(t("admin.poPlaceVerificationDesc"))}
            </CardDescription>
          </Card>
        </CardGrid>
      </YStack>
    </PlatformContainer>
  );
}
