"use client";

import { useState, useCallback } from "react";
import { styled, YStack, XStack } from "tamagui";
import {
  PlatformContainer,
  PlatformTab,
  PlatformTabBar,
  scrollTabIntoView,
} from "../_components/PlatformPageParts";
import { FilterChips } from "@/components/AdminTableParts";
import { Text, TextInput, Button, useTranslations } from "@th/ui";
import {
  Gauge,
  Check,
  X,
  ChevronLeft,
  ChevronRight,
  Pencil,
} from "lucide-react";

import { trpc } from "@/trpc";
import { formatQuotaValue } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Styled components
// ─────────────────────────────────────────────────────────────────────────────

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

const Card = styled(YStack, {
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  padding: 16,
  gap: 12,
  backgroundColor: "$background",
});

const Badge = styled(XStack, {
  paddingHorizontal: 8,
  paddingVertical: 2,
  borderRadius: 0,
  variants: {
    variant: {
      PENDING: { backgroundColor: "$yellow3" },
      APPROVED: { backgroundColor: "$green3" },
      REJECTED: { backgroundColor: "$red3" },
    },
  } as const,
});

const BadgeText = styled(Text, {
  fontSize: 11,
  weight: "semibold",
  variants: {
    variant: {
      PENDING: { color: "$yellow11" },
      APPROVED: { color: "$green11" },
      REJECTED: { color: "$red11" },
    },
  } as const,
});

const TableRow = styled(XStack, {
  gap: 16,
  paddingVertical: 8,
  paddingHorizontal: 12,
  alignItems: "center",
  borderBottomWidth: 1,
  borderColor: "$borderColor",
});

const TableHeader = styled(XStack, {
  gap: 16,
  paddingVertical: 8,
  paddingHorizontal: 12,
  alignItems: "center",
  borderBottomWidth: 2,
  borderColor: "$borderColor",
});

const HeaderCell = styled(Text, {
  fontSize: 12,
  weight: "semibold",
  color: "$colorMuted",
  textTransform: "uppercase",
});

const Cell = styled(Text, {
  fontSize: 13,
  color: "$color",
});

const PagerRow = styled(XStack, {
  justifyContent: "space-between",
  alignItems: "center",
  paddingTop: 8,
});

const PagerButton = styled(XStack, {
  tag: "button",
  alignItems: "center",
  justifyContent: "center",
  padding: 6,
  borderRadius: 0,
  cursor: "pointer",
  hoverStyle: { backgroundColor: "$backgroundHover" },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },
  variants: {
    disabled: {
      true: { opacity: 0.3, cursor: "default" },
    },
  } as const,
});

// ─────────────────────────────────────────────────────────────────────────────
// Kind label helper
// ─────────────────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  ORGS_OWNED: "pqKindOrgsOwned",
  ORGS_JOINED: "pqKindOrgsJoined",
  STORAGE_BYTES_ORG: "pqKindStorageBytesOrg",
  STORAGE_BYTES_HUMAN: "pqKindStorageBytesHuman",
  STORAGE_BYTES_PLACE: "pqKindStorageBytesPlace",
  EVENTS_PER_ORG: "pqKindEventsPerOrg",
  MEMBERS_PER_ORG: "pqKindMembersPerOrg",
  ANNOUNCEMENTS_PER_DAY: "pqKindAnnouncementsPerDay",
};

// ─────────────────────────────────────────────────────────────────────────────
// Default limits tab
// ─────────────────────────────────────────────────────────────────────────────

function DefaultLimitsTab() {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.quotas.listDefaultLimits.useQuery({});
  const updateMutation = trpc.quotas.updateDefaultLimit.useMutation({
    onSuccess: () => {
      void utils.quotas.listDefaultLimits.invalidate();
    },
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  if (isLoading) return <Text tone="muted">Loading...</Text>;
  if (error) return <Text tone="error">Error: {error.message}</Text>;

  const items = data?.items ?? [];

  return (
    <Card>
      <TableHeader>
        <HeaderCell flex={2}>{t("admin.pqKind")}</HeaderCell>
        <HeaderCell flex={1}>{t("admin.pqLimit")}</HeaderCell>
        <HeaderCell flex={0.5}>{t("admin.pqStatus")}</HeaderCell>
        <HeaderCell flex={1}>{t("admin.pqActions")}</HeaderCell>
      </TableHeader>

      {items.map((item) => (
        <TableRow key={item.kind}>
          <Cell flex={2}>
            {t(`admin.${KIND_LABELS[item.kind] ?? item.kind}`)}
          </Cell>
          <Cell flex={1}>
            {editing === item.kind ? (
              <TextInput
                value={editValue}
                onChangeText={setEditValue}
                size="$3"
                width={120}
                autoFocus
                onSubmitEditing={() => {
                  void updateMutation
                    .mutateAsync({
                      kind: item.kind as any,
                      limitValue: editValue,
                    })
                    .then(() => setEditing(null));
                }}
              />
            ) : (
              formatQuotaValue(item.kind, item.limitValue)
            )}
          </Cell>
          <XStack flex={0.5}>
            {item.isConfigured ? (
              <Badge variant="APPROVED">
                <BadgeText variant="APPROVED">
                  {t("admin.pqConfigured")}
                </BadgeText>
              </Badge>
            ) : (
              <Badge variant="PENDING">
                <BadgeText variant="PENDING">{t("admin.pqFallback")}</BadgeText>
              </Badge>
            )}
          </XStack>
          <XStack flex={1} gap={8}>
            {editing === item.kind ? (
              <>
                <Button
                  variant="primary"
                  size="$2"
                  disabled={updateMutation.isPending}
                  onPress={() => {
                    void updateMutation
                      .mutateAsync({
                        kind: item.kind as any,
                        limitValue: editValue,
                      })
                      .then(() => setEditing(null));
                  }}
                >
                  <Check size={12} aria-hidden />
                  {String(t("admin.pqSaveLimit"))}
                </Button>
                <Button
                  variant="ghost"
                  size="$2"
                  aria-label={String(t("common.cancel"))}
                  onPress={() => setEditing(null)}
                >
                  <X size={12} />
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="$2"
                onPress={() => {
                  setEditing(item.kind);
                  setEditValue(item.limitValue);
                }}
              >
                <Pencil size={12} aria-hidden />
                {String(t("admin.pqEditLimit"))}
              </Button>
            )}
          </XStack>
        </TableRow>
      ))}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Expansion requests tab
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

function ExpansionRequestsTab() {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const [statusFilter, setStatusFilter] = useState<
    "PENDING" | "APPROVED" | "REJECTED" | undefined
  >("PENDING");
  const [page, setPage] = useState(0);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");

  const { data, isLoading, error } = trpc.quotas.listExpansionRequests.useQuery(
    {
      status: statusFilter,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    },
  );

  const reviewMutation = trpc.quotas.reviewExpansionRequest.useMutation({
    onSuccess: () => {
      void utils.quotas.listExpansionRequests.invalidate();
      setReviewingId(null);
      setReviewNote("");
    },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleReview = useCallback(
    (id: string, decision: "APPROVED" | "REJECTED") => {
      void reviewMutation.mutateAsync({
        expansionRequestId: id,
        decision,
        reviewNote: reviewNote.trim() || undefined,
      });
    },
    [reviewMutation, reviewNote],
  );

  return (
    <YStack gap={16}>
      {/* Status filter tabs */}
      <FilterChips<"PENDING" | "APPROVED" | "REJECTED">
        options={(["PENDING", "APPROVED", "REJECTED"] as const).map((s) => ({
          value: s,
          label: String(t(`admin.pq${s.charAt(0) + s.slice(1).toLowerCase()}`)),
        }))}
        selected={statusFilter}
        onSelect={(v) => {
          setStatusFilter(v);
          setPage(0);
        }}
      />

      {isLoading && <Text tone="muted">Loading...</Text>}
      {error && <Text tone="error">Error: {error.message}</Text>}

      {!isLoading && items.length === 0 && (
        <Card>
          <YStack alignItems="center" gap={8} padding={24}>
            <Gauge size={32} color="var(--colorMuted)" />
            <Text weight="bold" tone="muted">
              {t("admin.pqNoRequests")}
            </Text>
            <Text fontSize={13} tone="muted">
              {t("admin.pqNoRequestsDesc")}
            </Text>
          </YStack>
        </Card>
      )}

      {items.map((item) => (
        <Card key={item.id}>
          <XStack justifyContent="space-between" alignItems="flex-start">
            <YStack gap={4} flex={1}>
              <XStack gap={8} alignItems="center">
                <Text weight="bold" fontSize={14}>
                  {t(`admin.${KIND_LABELS[item.kind] ?? item.kind}`)}
                </Text>
                <Badge variant={item.status as any}>
                  <BadgeText variant={item.status as any}>
                    {t(
                      `admin.pq${item.status.charAt(0) + item.status.slice(1).toLowerCase()}`,
                    )}
                  </BadgeText>
                </Badge>
              </XStack>
              <Text fontSize={12} tone="muted">
                {item.subjectType} &middot; {item.subjectId.slice(0, 8)}&hellip;
              </Text>
            </YStack>
            <XStack gap={16}>
              <YStack alignItems="center">
                <Text fontSize={11} tone="muted">
                  {t("admin.pqCurrentLimit")}
                </Text>
                <Text weight="bold" fontSize={14}>
                  {formatQuotaValue(item.kind, item.currentLimitValue)}
                </Text>
              </YStack>
              <YStack alignItems="center">
                <Text fontSize={11} tone="muted">
                  {t("admin.pqRequestedLimit")}
                </Text>
                <Text weight="bold" fontSize={14} tone="accent">
                  {formatQuotaValue(item.kind, item.requestedLimitValue)}
                </Text>
              </YStack>
            </XStack>
          </XStack>

          <YStack gap={4}>
            <Text fontSize={12} tone="muted">
              {t("admin.pqReason")}
            </Text>
            <Text fontSize={13}>{item.reason}</Text>
          </YStack>

          <XStack gap={8} alignItems="center">
            <Text fontSize={12} tone="muted">
              {t("admin.pqRequestedBy")}: {item.requestedByHumanId.slice(0, 8)}
              &hellip;
            </Text>
            <Text fontSize={12} tone="muted">
              {t("admin.pqCreatedAt")}:{" "}
              {new Date(item.createdAt).toLocaleDateString()}
            </Text>
          </XStack>

          {item.reviewedByHumanId && (
            <XStack gap={8}>
              <Text fontSize={12} tone="muted">
                {t("admin.pqReviewedBy")}: {item.reviewedByHumanId.slice(0, 8)}
                &hellip;
              </Text>
              {item.reviewNote && (
                <Text fontSize={12} tone="muted">
                  {t("admin.pqReviewNote")}: {item.reviewNote}
                </Text>
              )}
            </XStack>
          )}

          {item.status === "PENDING" && (
            <YStack
              gap={12}
              paddingTop={12}
              borderTopWidth={1}
              borderColor="$borderColor"
            >
              {reviewingId === item.id ? (
                <>
                  <TextInput
                    placeholder={t("admin.pqReviewNotePlaceholder") as string}
                    value={reviewNote}
                    onChangeText={setReviewNote}
                    multiline
                    numberOfLines={2}
                    size="$3"
                  />
                  <XStack gap={8}>
                    <Button
                      variant="primary"
                      size="$3"
                      disabled={reviewMutation.isPending}
                      onPress={() => handleReview(item.id, "APPROVED")}
                    >
                      <Check size={14} aria-hidden />
                      {String(t("admin.pqApprove"))}
                    </Button>
                    <Button
                      variant="secondary"
                      size="$3"
                      disabled={reviewMutation.isPending}
                      onPress={() => handleReview(item.id, "REJECTED")}
                    >
                      <X size={14} aria-hidden />
                      {String(t("admin.pqReject"))}
                    </Button>
                    <XStack flex={1} />
                    <Button
                      variant="ghost"
                      size="$3"
                      onPress={() => {
                        setReviewingId(null);
                        setReviewNote("");
                      }}
                    >
                      Cancel
                    </Button>
                  </XStack>
                </>
              ) : (
                <XStack>
                  <Button
                    variant="secondary"
                    size="$3"
                    onPress={() => setReviewingId(item.id)}
                  >
                    Review
                  </Button>
                </XStack>
              )}
            </YStack>
          )}
        </Card>
      ))}

      {totalPages > 1 && (
        <PagerRow>
          <PagerButton
            disabled={page === 0}
            aria-label={String(t("admin.plPrevious"))}
            onPress={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft size={16} />
          </PagerButton>
          <Text fontSize={12} tone="muted">
            Page {page + 1} of {totalPages}
          </Text>
          <PagerButton
            disabled={page >= totalPages - 1}
            aria-label={String(t("admin.plNext"))}
            onPress={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={16} />
          </PagerButton>
        </PagerRow>
      )}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

// Requests first: it is the tab that needs acting on.
const QUOTA_TABS = [
  { key: "requests", labelKey: "admin.pqTabRequests" },
  { key: "defaults", labelKey: "admin.pqTabDefaults" },
] as const;

export default function PlatformQuotasPage() {
  const t = useTranslations();
  const [tab, setTab] = useState<"defaults" | "requests">("requests");

  return (
    <PlatformContainer size="sm">
      <YStack gap={4}>
        <XStack gap={8} alignItems="center">
          <Gauge size={24} />
          <PageTitle>{t("admin.pqTitle")}</PageTitle>
        </XStack>
        <Subtitle>{t("admin.pqSubtitle")}</Subtitle>
      </YStack>

      {/* `overflowX` via style: Tamagui's `overflow` type has no "auto". At
          320 the two tabs outrun the column and scroll inside the bar. */}
      <PlatformTabBar style={{ overflowX: "auto" }}>
        {QUOTA_TABS.map((item) => (
          <PlatformTab
            key={item.key}
            active={tab === item.key}
            aria-pressed={tab === item.key}
            onPress={() => setTab(item.key)}
            onFocus={scrollTabIntoView}
          >
            <Text
              variant="bodySmall"
              weight={tab === item.key ? "semibold" : "regular"}
              color={tab === item.key ? "$color" : "$colorMuted"}
            >
              {t(item.labelKey)}
            </Text>
          </PlatformTab>
        ))}
      </PlatformTabBar>

      {tab === "defaults" && <DefaultLimitsTab />}
      {tab === "requests" && <ExpansionRequestsTab />}
    </PlatformContainer>
  );
}
