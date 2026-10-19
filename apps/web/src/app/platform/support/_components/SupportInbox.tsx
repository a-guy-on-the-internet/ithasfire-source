"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { YStack, XStack, useTheme } from "tamagui";
import {
  Text,
  Button,
  Badge,
  Spinner,
  useTranslations,
  useLocale,
} from "@th/ui";
import { MessageCircle, RefreshCw } from "lucide-react";

import { Ticket } from "lucide-react";

import { trpc } from "@/trpc";
import { PlatformContainer } from "../../_components/PlatformPageParts";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SupportThreadStatus } from "@/components/support/types";
import { useTabVisible } from "@/components/support/useTabVisible";
import type { SupportThreadStaffDto } from "@th/core/use-cases/support";
import { SupportThreadDetail } from "./SupportThreadDetail";
import { resolveThreadIdentity } from "./identity";

type StatusFilter = "ALL" | SupportThreadStatus;

const PAGE_SIZE = 50;

function statusTone(status: SupportThreadStatus) {
  switch (status) {
    case "AWAITING_HUMAN":
      return "warning" as const;
    case "RESOLVED":
      return "success" as const;
    case "OPEN":
    default:
      return "info" as const;
  }
}

function statusLabelKey(status: SupportThreadStatus): string {
  switch (status) {
    case "AWAITING_HUMAN":
      return "supportInbox.statusAwaiting";
    case "RESOLVED":
      return "supportInbox.statusResolved";
    case "OPEN":
    default:
      return "supportInbox.statusOpen";
  }
}

export function SupportInbox() {
  const t = useTranslations();
  const locale = useLocale();
  const theme = useTheme();
  const isMobile = useIsMobile();

  // Deep-link: a Discord alert links to `/platform/support?thread=<id>`. We
  // auto-select that thread once it loads. Read the param up front so the
  // initial filter can default to ALL (a RESOLVED thread linked from an alert
  // must still be findable, regardless of the operator's default filter).
  const searchParams = useSearchParams();
  const threadParam = searchParams.get("thread");

  // Pause polling while the operator backgrounds the tab — this is the heaviest
  // support query (full staff enrichment + count), so we don't keep hammering it
  // (and holding an instance warm) for a tab nobody is looking at. Mirrors the
  // widget's visibility discipline.
  const tabVisible = useTabVisible();

  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // One-shot guard: the deep-link auto-select must fire at most once, the first
  // time the linked thread appears in the loaded list. After that it stays
  // consumed so it never fights the operator's manual selection (or re-selects
  // the thread if they navigate away from it).
  const deepLinkConsumed = useRef(false);

  const threadsQuery = trpc.support.listThreads.useQuery(
    {
      ...(filter === "ALL" ? {} : { status: filter }),
      limit: PAGE_SIZE,
      offset: 0,
    },
    {
      // Keep the operator list fresh without a manual refresh; the inbox is a
      // working surface, not a passive page. Gated on tab visibility so a
      // backgrounded tab stops polling entirely (the manual Refresh button still
      // works on demand).
      refetchInterval: tabVisible ? 20_000 : false,
      refetchIntervalInBackground: false,
      staleTime: 10_000,
    },
  );

  const threads = useMemo<SupportThreadStaffDto[]>(
    () => threadsQuery.data?.items ?? [],
    [threadsQuery.data?.items],
  );

  // "Needs reply" = ball is in the operator's court (latest non-SYSTEM message
  // is from the attendee). A RESOLVED thread never needs a reply, even if the
  // backend flag is still set. Count reflects the currently-loaded page
  // (PAGE_SIZE), which is acceptable for v1 — no extra query.
  const needsReplyCount = useMemo(
    () =>
      threads.filter(
        (thread) => thread.needsReply && thread.status !== "RESOLVED",
      ).length,
    [threads],
  );

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedId) ?? null,
    [threads, selectedId],
  );

  // Auto-select the deep-linked thread exactly once, when it first appears in
  // the loaded list. If `threadParam` is unset or doesn't match a loaded thread
  // (e.g. it's outside the current page), this no-ops — no crash, no toast.
  useEffect(() => {
    if (deepLinkConsumed.current || !threadParam) return;
    const match = threads.find((thread) => thread.id === threadParam);
    if (!match) return;
    setSelectedId(threadParam);
    deepLinkConsumed.current = true;
  }, [threadParam, threads]);

  const handleResolved = useCallback(() => {
    void threadsQuery.refetch();
  }, [threadsQuery]);

  const filters: { value: StatusFilter; labelKey: string }[] = [
    { value: "ALL", labelKey: "supportInbox.filterAll" },
    { value: "AWAITING_HUMAN", labelKey: "supportInbox.filterAwaiting" },
    { value: "OPEN", labelKey: "supportInbox.filterOpen" },
    { value: "RESOLVED", labelKey: "supportInbox.filterResolved" },
  ];

  const formatTime = useCallback(
    (date: Date) =>
      new Date(date).toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    [locale],
  );

  const listColumn = (
    <YStack
      width={isMobile ? "100%" : 360}
      minWidth={isMobile ? 0 : 360}
      borderRightWidth={isMobile ? 0 : 2}
      borderRightColor="$borderColor"
      minHeight={0}
    >
      {/* Filters */}
      <XStack
        gap="$2"
        flexWrap="wrap"
        padding="$3"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
        alignItems="center"
      >
        {filters.map((f) => (
          <Button
            key={f.value}
            variant={filter === f.value ? "primary" : "ghost"}
            size="$1"
            onPress={() => setFilter(f.value)}
          >
            {String(t(f.labelKey))}
          </Button>
        ))}
        <XStack flex={1} />
        <Button
          variant="ghost"
          size="$1"
          icon
          onPress={() => void threadsQuery.refetch()}
          aria-label={String(t("supportInbox.refresh"))}
        >
          <RefreshCw size={14} aria-hidden />
        </Button>
      </XStack>

      {/* Thread list */}
      <YStack flex={1} minHeight={0} style={{ overflowY: "auto" }}>
        {threadsQuery.isLoading ? (
          <YStack padding="$5" alignItems="center" gap="$2">
            <Spinner size="small" />
            <Text variant="bodySmall" tone="muted">
              {String(t("supportInbox.threadsLoading"))}
            </Text>
          </YStack>
        ) : threadsQuery.isError ? (
          <YStack padding="$5" alignItems="center" gap="$3">
            <Text variant="bodySmall" tone="error" textAlign="center">
              {String(t("supportInbox.threadsError"))}
            </Text>
            <Button
              variant="secondary"
              size="$2"
              onPress={() => void threadsQuery.refetch()}
            >
              {String(t("supportInbox.refresh"))}
            </Button>
          </YStack>
        ) : threads.length === 0 ? (
          <YStack padding="$5" alignItems="center" gap="$2">
            <MessageCircle size={28} color="var(--colorMuted)" />
            <Text variant="bodySmall" tone="muted" textAlign="center">
              {String(
                t(
                  filter === "ALL"
                    ? "supportInbox.noThreads"
                    : "supportInbox.noThreadsFiltered",
                ),
              )}
            </Text>
          </YStack>
        ) : (
          threads.map((thread) => {
            const active = thread.id === selectedId;
            const identity = resolveThreadIdentity(thread, {
              unknown: String(t("supportInbox.unknownAttendee")),
              fallback: (id) =>
                String(t("supportInbox.attendeeFallback", { id })),
            });
            return (
              <YStack
                key={thread.id}
                tag="button"
                onPress={() => setSelectedId(thread.id)}
                accessibilityRole="button"
                aria-pressed={active}
                cursor="pointer"
                padding="$3"
                gap="$2"
                borderBottomWidth={1}
                borderBottomColor="$borderColor"
                backgroundColor={active ? "$surfaceMuted" : "transparent"}
                hoverStyle={{ backgroundColor: "$surfaceMuted" }}
                borderLeftWidth={4}
                borderLeftColor={active ? "$brandSecondary" : "transparent"}
              >
                <XStack
                  alignItems="center"
                  justifyContent="space-between"
                  gap="$2"
                >
                  <XStack alignItems="center" gap="$2" flexShrink={1}>
                    <Badge tone={statusTone(thread.status)} size="xs">
                      {String(t(statusLabelKey(thread.status)))}
                    </Badge>
                    {thread.needsReply && thread.status !== "RESOLVED" && (
                      <Badge tone="warning" size="xs">
                        {String(t("supportInbox.needsReply"))}
                      </Badge>
                    )}
                  </XStack>
                  <Text variant="caption" tone="muted">
                    {formatTime(thread.lastMessageAt)}
                  </Text>
                </XStack>
                <YStack gap="$1">
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    tone={identity.isFallback ? "muted" : "default"}
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {identity.primary}
                  </Text>
                  {identity.secondary && (
                    <Text
                      variant="caption"
                      tone="muted"
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {identity.secondary}
                    </Text>
                  )}
                </YStack>
                {(thread.eventId || thread.orderId) && (
                  <XStack gap="$2" flexWrap="wrap">
                    {/* No maxWidth: `orderRef` is `formatOrderCode` — always 8
                        characters — and the fallback is one word. The 200px
                        clamp was sized for a full-UUID fallback that can no
                        longer occur. The event badge keeps its clamp; event
                        titles really are unbounded. */}
                    {thread.orderId && (
                      <Badge
                        tone="neutral"
                        size="xs"
                        leadingIcon={<Ticket aria-hidden />}
                      >
                        {/* `#`-prefixed: the badge carries only an aria-hidden
                            icon, so the code stands alone with no label. Bare,
                            an 8-char hex run reads like a promo code — and a
                            screen reader announces it with no context at all. */}
                        {thread.orderRef
                          ? `#${thread.orderRef}`
                          : String(t("supportInbox.orderContext"))}
                      </Badge>
                    )}
                    {thread.eventId && (
                      <Badge tone="neutral" size="xs" maxWidth={200}>
                        {thread.eventTitle ??
                          String(t("supportInbox.eventContext"))}
                      </Badge>
                    )}
                  </XStack>
                )}
              </YStack>
            );
          })
        )}
      </YStack>
    </YStack>
  );

  const detailColumn = (
    <YStack flex={1} minWidth={0} minHeight={0}>
      {selectedThread ? (
        <SupportThreadDetail
          thread={selectedThread}
          onResolved={handleResolved}
        />
      ) : (
        <YStack
          flex={1}
          alignItems="center"
          justifyContent="center"
          gap="$2"
          padding="$6"
        >
          <MessageCircle size={32} color="var(--colorMuted)" />
          <Text variant="label" weight="bold">
            {String(t("supportInbox.selectThreadTitle"))}
          </Text>
          <Text
            variant="bodySmall"
            tone="muted"
            textAlign="center"
            maxWidth={320}
          >
            {String(t("supportInbox.selectThreadBody"))}
          </Text>
        </YStack>
      )}
    </YStack>
  );

  return (
    <PlatformContainer size="lg">
      <YStack gap={8}>
        <XStack gap={8} alignItems="center">
          <MessageCircle size={20} color={theme.color?.val} />
          <Text variant="h2" tag="h1" weight="bold">
            {String(t("supportInbox.title"))}
          </Text>
          {needsReplyCount > 0 && (
            <Badge
              tone="warning"
              size="sm"
              aria-label={String(
                t("supportInbox.needsReplyCount", { count: needsReplyCount }),
              )}
            >
              {needsReplyCount}
            </Badge>
          )}
        </XStack>
        <Text variant="body" tone="muted">
          {String(t("supportInbox.subtitle"))}
        </Text>
      </YStack>

      {/* Master-detail. On mobile, show the detail in place of the list once a
          thread is selected so neither column overflows the narrow viewport. */}
      <XStack
        flex={1}
        minHeight={isMobile ? undefined : 560}
        height={isMobile ? undefined : "calc(100dvh - 220px)"}
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surface"
        flexDirection={isMobile ? "column" : "row"}
      >
        {isMobile ? (
          selectedThread ? (
            <YStack flex={1} minHeight={420}>
              <XStack
                padding="$2"
                borderBottomWidth={2}
                borderBottomColor="$borderColor"
              >
                <Button
                  variant="ghost"
                  size="$2"
                  onPress={() => setSelectedId(null)}
                >
                  {String(t("common.back"))}
                </Button>
              </XStack>
              {detailColumn}
            </YStack>
          ) : (
            <YStack flex={1} minHeight={420}>
              {listColumn}
            </YStack>
          )
        ) : (
          <>
            {listColumn}
            {detailColumn}
          </>
        )}
      </XStack>
    </PlatformContainer>
  );
}

SupportInbox.displayName = "SupportInbox";
