"use client";

import { useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { XStack, YStack } from "tamagui";
import { Badge, Button, Modal, Spinner, Text, useTranslations } from "@th/ui";
import {
  AlarmClock,
  BadgeCheck,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  Lock,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  RequestStatusPill,
  VerificationReviewDetail,
  contextFromQueueItem,
  relativeTime,
} from "./VerificationReviewDetail";
import { PlaceLookup } from "./PlaceLookup";
import type { PlatformPlaceRow } from "./types";

type QueueItem =
  inferRouterOutputs<AppRouter>["places"]["getPlatformVerificationQueue"]["items"][number];

type QueueView = "active" | "reviewed";

const ACTIVE_STATUSES = ["PENDING", "IN_REVIEW"] as const;
const REVIEWED_STATUSES = ["APPROVED", "REJECTED"] as const;

/** Master–detail breakpoint: below this, the detail opens in a modal. */
const SPLIT_BREAKPOINT = 900;

function useBelow(width: number): boolean {
  const [below, setBelow] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${width - 1}px)`);
    const on = () => setBelow(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [width]);
  return below;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat tile
// ─────────────────────────────────────────────────────────────────────────────

function StatTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <XStack
      gap="$3"
      alignItems="center"
      padding="$3"
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$surface"
      flexBasis={180}
      flexGrow={1}
      minWidth={140}
    >
      <YStack
        width={32}
        height={32}
        alignItems="center"
        justifyContent="center"
        borderWidth={2}
        borderColor="$borderColor"
        flexShrink={0}
      >
        {icon}
      </YStack>
      <YStack gap="$1" minWidth={0}>
        <Text variant="h4" weight="bold">
          {value}
        </Text>
        <Text variant="caption" tone="muted" truncate>
          {label}
        </Text>
      </YStack>
    </XStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue row
// ─────────────────────────────────────────────────────────────────────────────

function QueueRow({
  item,
  selected,
  lockedToMe,
  lockedToOther,
  onPress,
}: {
  item: QueueItem;
  selected: boolean;
  lockedToMe: boolean;
  lockedToOther: boolean;
  onPress: () => void;
}) {
  const t = useTranslations();
  // Web-only a11y props Tamagui doesn't type on its Stack surface.
  const a11y: object = {
    role: "button",
    tabIndex: 0,
    "aria-pressed": selected,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onPress();
      }
    },
  };
  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={2}
      borderColor={selected ? "$accent" : "$borderColor"}
      backgroundColor="$surface"
      cursor="pointer"
      hoverStyle={{ borderColor: "$accent" }}
      onPress={onPress}
      {...a11y}
    >
      <XStack justifyContent="space-between" alignItems="center" gap="$2">
        <XStack gap="$2" alignItems="center" flex={1} minWidth={0}>
          <RequestStatusPill status={item.status} />
          <Text variant="body" weight="bold" truncate flex={1} minWidth={0}>
            {item.placeName}
          </Text>
        </XStack>
        <Text variant="caption" tone="muted" flexShrink={0}>
          {relativeTime(new Date(item.submittedAt))}
        </Text>
      </XStack>

      {/* Request-source tag (claim-venue-flow FR-006). Org verifications are
          untagged; ownership claims/disputes get a distinct badge + the
          claimant identity and target owner. */}
      {item.source === "OWNERSHIP_CLAIM" ||
      item.source === "OWNERSHIP_DISPUTE" ? (
        <XStack gap="$2" alignItems="center" flexWrap="wrap">
          {item.source === "OWNERSHIP_CLAIM" ? (
            <Badge tone="info" size="sm" leadingIcon={<BadgeCheck />}>
              {String(t("admin.vqSourceClaim"))}
            </Badge>
          ) : (
            <Badge tone="warning" size="sm" leadingIcon={<ShieldAlert />}>
              {String(t("admin.vqSourceDispute"))}
            </Badge>
          )}
          <Text variant="caption" tone="muted">
            {String(
              t("admin.vqSubmittedBy", { name: item.submitter?.name ?? "—" }),
            )}
            {item.claimOwnerType
              ? ` · ${String(
                  item.claimOwnerType === "ORGANIZATION"
                    ? t("admin.vqClaimForOrg")
                    : t("admin.vqClaimForSelf"),
                )}`
              : ""}
          </Text>
        </XStack>
      ) : null}

      {item.placeAddress ? (
        <Text variant="caption" tone="muted" truncate>
          {item.placeAddress}
        </Text>
      ) : null}

      <XStack gap="$3" alignItems="center" flexWrap="wrap">
        <XStack gap="$2" alignItems="center">
          <FileText size={11} style={{ opacity: 0.6 }} />
          <Text variant="caption" tone="muted">
            {String(t("admin.vqDocCount", { count: item.documentCount }))}
          </Text>
        </XStack>
        <Text variant="caption" tone="muted">
          {String(
            t("admin.vqSubmittedBy", {
              name: item.submitter?.name ?? "—",
            }),
          )}
        </Text>
        {lockedToMe ? (
          <Badge tone="info" size="sm" leadingIcon={<UserCheck />}>
            {String(t("admin.vqLockedToMe"))}
          </Badge>
        ) : null}
        {lockedToOther ? (
          <Badge tone="warning" size="sm" leadingIcon={<Lock />}>
            {item.acknowledger?.name ?? String(t("admin.vqLockedToOther"))}
          </Badge>
        ) : null}
      </XStack>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PlatformVerificationQueue({
  actorHumanId,
  onSelectPlace,
}: {
  actorHumanId: string | undefined;
  /**
   * Opens an arbitrary place (from the lookup box) in the shared
   * PlaceDetailPanel, which carries the Waive verification action. The queue
   * itself only ever lists places with an open request, so without this a
   * place that never submitted documents was unreachable from here.
   */
  onSelectPlace: (place: PlatformPlaceRow) => void;
}) {
  const t = useTranslations();
  const isNarrow = useBelow(SPLIT_BREAKPOINT);

  const [view, setView] = useState<QueueView>("active");
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(
    null,
  );

  const statuses = useMemo(
    () => (view === "active" ? [...ACTIVE_STATUSES] : [...REVIEWED_STATUSES]),
    [view],
  );

  const queueQuery = trpc.places.getPlatformVerificationQueue.useQuery(
    { statuses, limit: 50 },
    { staleTime: 15_000, placeholderData: keepPreviousData },
  );

  const items = (queueQuery.data?.items ?? []) as QueueItem[];
  const stats = queueQuery.data?.queueStats;

  const selectedItem = useMemo(
    () => items.find((i) => i.requestId === selectedRequestId) ?? null,
    [items, selectedRequestId],
  );

  const claimedByMe = useMemo(
    () =>
      items.filter(
        (i) =>
          i.status === "IN_REVIEW" && i.acknowledger?.humanId === actorHumanId,
      ).length,
    [items, actorHumanId],
  );

  const lockState = (item: QueueItem) => {
    const lockedToMe =
      item.status === "IN_REVIEW" &&
      item.acknowledger?.humanId === actorHumanId;
    const lockedToOther =
      item.status === "IN_REVIEW" &&
      !!item.acknowledger &&
      item.acknowledger.humanId !== actorHumanId;
    return { lockedToMe, lockedToOther };
  };

  // Clear selection when switching views.
  const switchView = (next: QueueView) => {
    setView(next);
    setSelectedRequestId(null);
  };

  // Rendered in every branch below — staff must be able to reach a place by
  // name/slug even when the queue itself is loading or has failed.
  const lookup = <PlaceLookup onSelectPlace={onSelectPlace} />;

  // ── Loading / error ──────────────────────────────────────────────────
  if (queueQuery.isLoading) {
    return (
      <YStack gap="$4" flex={1}>
        {lookup}
        <YStack alignItems="center" justifyContent="center" padding="$6">
          <Spinner size="large" />
        </YStack>
      </YStack>
    );
  }

  if (queueQuery.error) {
    return (
      <YStack gap="$4" flex={1}>
        {lookup}
        <YStack padding="$4" gap="$3">
          <Text variant="body" tone="error">
            {formatErrorMessage(queueQuery.error)}
          </Text>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => void queueQuery.refetch()}
          >
            {String(t("admin.ppRetry"))}
          </Button>
        </YStack>
      </YStack>
    );
  }

  const oldestPendingLabel =
    stats?.oldestPendingAgeMs != null
      ? `${Math.max(1, Math.round(stats.oldestPendingAgeMs / (60 * 60 * 1000)))}h`
      : "—";

  const detail = selectedItem ? (
    <VerificationReviewDetail
      key={selectedItem.requestId}
      requestId={selectedItem.requestId}
      actorHumanId={actorHumanId}
      context={contextFromQueueItem(selectedItem)}
      onClose={() => setSelectedRequestId(null)}
      onDecided={() => setSelectedRequestId(null)}
    />
  ) : null;

  return (
    <YStack gap="$4" flex={1}>
      {/* ── Find any place by name or slug (FR-015) ───────────── */}
      {lookup}

      {/* ── Stats header ──────────────────────────────────────── */}
      {stats ? (
        <XStack gap="$3" flexWrap="wrap">
          <StatTile
            icon={<Clock size={16} color="var(--warning)" />}
            label={String(t("admin.vqStatPending"))}
            value={String(stats.pending)}
          />
          <StatTile
            icon={<Eye size={16} color="var(--info)" />}
            label={String(t("admin.vqStatInReview"))}
            value={String(stats.inReview)}
          />
          <StatTile
            icon={<CheckCircle2 size={16} color="var(--success)" />}
            label={String(t("admin.vqStatReviewedMonth"))}
            value={String(stats.reviewedThisMonth)}
          />
          <StatTile
            icon={<AlarmClock size={16} color="var(--colorMuted)" />}
            label={String(t("admin.vqStatOldestPending"))}
            value={oldestPendingLabel}
          />
        </XStack>
      ) : null}

      {/* ── View switch + claimed affordance ──────────────────── */}
      <XStack
        justifyContent="space-between"
        alignItems="center"
        gap="$3"
        flexWrap="wrap"
      >
        <XStack borderWidth={2} borderColor="$borderColor">
          {(["active", "reviewed"] as QueueView[]).map((v) => (
            <Button
              key={v}
              size="$2"
              variant={view === v ? "primary" : "ghost"}
              onPress={() => switchView(v)}
            >
              {v === "active"
                ? String(t("admin.vqActive"))
                : String(t("admin.vqReviewed"))}
            </Button>
          ))}
        </XStack>
        {claimedByMe > 0 ? (
          <Badge tone="info" size="sm" leadingIcon={<UserCheck />}>
            {String(t("admin.vqClaimedByYou", { count: claimedByMe }))}
          </Badge>
        ) : null}
      </XStack>

      {/* ── Master / detail ──────────────────────────────────── */}
      <XStack gap="$3" flex={1} alignItems="flex-start">
        {/* List */}
        <YStack gap="$2" flex={1} minWidth={0}>
          {items.length === 0 ? (
            <YStack
              alignItems="center"
              justifyContent="center"
              padding="$6"
              gap="$3"
              borderWidth={2}
              borderColor="$borderColor"
              backgroundColor="$surface"
            >
              <ShieldCheck size={28} style={{ opacity: 0.4 }} />
              <Text variant="h4" weight="bold">
                {view === "active"
                  ? String(t("admin.vqEmptyActiveTitle"))
                  : String(t("admin.vqEmptyReviewedTitle"))}
              </Text>
              <Text variant="body" tone="muted" textAlign="center">
                {view === "active"
                  ? String(t("admin.vqEmptyActiveBody"))
                  : String(t("admin.vqEmptyReviewedBody"))}
              </Text>
            </YStack>
          ) : (
            items.map((item) => {
              const { lockedToMe, lockedToOther } = lockState(item);
              return (
                <QueueRow
                  key={item.requestId}
                  item={item}
                  selected={item.requestId === selectedRequestId}
                  lockedToMe={lockedToMe}
                  lockedToOther={lockedToOther}
                  onPress={() => setSelectedRequestId(item.requestId)}
                />
              );
            })
          )}
        </YStack>

        {/* Detail: sticky side pane on wide screens */}
        {!isNarrow ? (
          <YStack
            flexBasis={480}
            maxWidth={520}
            flexShrink={0}
            style={{ position: "sticky", top: 16 }}
          >
            {detail ? (
              <YStack
                padding="$4"
                borderWidth={2}
                borderColor="$borderColor"
                backgroundColor="$surface"
                style={{ maxHeight: "calc(100vh - 120px)", overflowY: "auto" }}
              >
                {detail}
              </YStack>
            ) : (
              <YStack
                alignItems="center"
                justifyContent="center"
                padding="$6"
                gap="$2"
                borderWidth={2}
                borderColor="$borderColor"
                backgroundColor="$surfaceMuted"
                minHeight={240}
              >
                <Eye size={24} style={{ opacity: 0.4 }} />
                <Text variant="bodySmall" tone="muted" textAlign="center">
                  {String(t("admin.vqSelectPrompt"))}
                </Text>
              </YStack>
            )}
          </YStack>
        ) : null}
      </XStack>

      {/* Detail: modal on narrow screens */}
      {isNarrow && selectedItem ? (
        <Modal open={!!selectedItem} onClose={() => setSelectedRequestId(null)}>
          <Modal.Panel width={640}>
            <Modal.Header
              title={String(t("admin.vqReviewTitle"))}
              subtitle={selectedItem.placeName}
              onClose={() => setSelectedRequestId(null)}
            />
            <Modal.Body>{detail}</Modal.Body>
          </Modal.Panel>
        </Modal>
      ) : null}
    </YStack>
  );
}
