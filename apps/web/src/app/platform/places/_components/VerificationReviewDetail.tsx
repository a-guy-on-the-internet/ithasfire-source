"use client";

import { useCallback, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  Spinner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import {
  CheckSquare,
  ExternalLink,
  Eye,
  FileText,
  Globe,
  Image as ImageIcon,
  Lock,
  MapPin,
  Phone,
  ShieldCheck,
  ShieldX,
  Square,
  Undo2,
  Users,
} from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { formatBytes } from "@/lib/format";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { getSafeExternalHref } from "@/app/p/[slug]/_components/blocks/safe-block-url";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RequestStatus =
  | "PENDING"
  | "IN_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN";

type QueueItem =
  inferRouterOutputs<AppRouter>["places"]["getPlatformVerificationQueue"]["items"][number];

/**
 * Normalized place context shown in the review header. Built from a queue item
 * (workbench) or from a platform-places table row (table review). Fields the
 * source can't supply (website / phone / submitter on the table path) are null.
 */
export type ReviewContext = {
  placeName: string;
  address: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  capacity: number | null;
  ownerCount: number;
  website: string | null;
  phone: string | null;
  submitterName: string | null;
  submittedAt: Date | null;
  status: RequestStatus | null;
  acknowledgerHumanId: string | null;
  acknowledgerName: string | null;
  reviewerName: string | null;
  reviewedAt: Date | null;
};

interface VerificationReviewDetailProps {
  /** Preferred lookup key. When absent, the request is resolved by placeId. */
  requestId?: string;
  /** Fallback lookup key (table path); the resolved request.id drives writes. */
  placeId?: string;
  actorHumanId: string | undefined;
  context: ReviewContext;
  /** Optional close affordance (rendered in read-only terminal footer). */
  onClose?: () => void;
  /** Fired after a successful terminal decision (approve / reject). */
  onDecided?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status pill (shared with the queue list)
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_STATUS_META: Record<
  RequestStatus,
  {
    labelKey: string;
    tone: "warning" | "info" | "success" | "danger" | "neutral";
  }
> = {
  PENDING: { labelKey: "admin.vqStatusPending", tone: "warning" },
  IN_REVIEW: { labelKey: "admin.vqStatusInReview", tone: "info" },
  APPROVED: { labelKey: "admin.vqStatusApproved", tone: "success" },
  REJECTED: { labelKey: "admin.vqStatusRejected", tone: "danger" },
  WITHDRAWN: { labelKey: "admin.vqStatusWithdrawn", tone: "neutral" },
};

export function RequestStatusPill({ status }: { status: RequestStatus }) {
  const t = useTranslations();
  const meta = REQUEST_STATUS_META[status];
  return (
    <Badge tone={meta.tone} size="sm">
      {String(t(meta.labelKey))}
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function relativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const min = Math.round(ms / 60000);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (Math.abs(min) < 1) return "just now";
  if (Math.abs(min) < 60) return `${min}m ago`;
  if (Math.abs(hr) < 24) return `${hr}h ago`;
  return `${day}d ago`;
}

/** Build the normalized review context from a workbench queue item. */
export function contextFromQueueItem(item: QueueItem): ReviewContext {
  return {
    placeName: item.placeName,
    address: item.placeAddress,
    city: item.placeCity,
    region: item.placeRegion,
    countryCode: item.placeCountryCode,
    capacity: item.placeCapacity,
    ownerCount: item.ownerCount,
    website: item.placeWebsite,
    phone: item.placePhone,
    submitterName: item.submitter?.name ?? null,
    submittedAt: item.submittedAt ? new Date(item.submittedAt) : null,
    status: item.status,
    acknowledgerHumanId: item.acknowledger?.humanId ?? null,
    acknowledgerName: item.acknowledger?.name ?? null,
    reviewerName: item.reviewer?.name ?? null,
    reviewedAt: item.reviewedAt ? new Date(item.reviewedAt) : null,
  };
}

function isImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

const CHECKLIST_ITEMS = [
  "admin.vrCheckBusinessName",
  "admin.vrCheckAddress",
  "admin.vrCheckAuthentic",
] as const;

const SECTION_LABEL = {
  textTransform: "uppercase",
  letterSpacing: 1,
  fontSize: 11,
  fontWeight: 700,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function VerificationReviewDetail({
  requestId,
  placeId,
  actorHumanId,
  context,
  onClose,
  onDecided,
}: VerificationReviewDetailProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const [checklist, setChecklist] = useState<boolean[]>(() =>
    CHECKLIST_ITEMS.map(() => false),
  );
  const [notes, setNotes] = useState("");
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);

  // Documents + authoritative request status. Resolved by requestId when known,
  // otherwise by placeId (table path); the resolved request.id drives writes.
  const requestQuery = trpc.platform.getVerificationRequest.useQuery(
    requestId ? { requestId } : { placeId: placeId! },
    { enabled: !!(requestId || placeId), staleTime: 0 },
  );
  const request = requestQuery.data;
  const resolvedRequestId = request?.id ?? requestId ?? null;

  const invalidate = useCallback(() => {
    void utils.places.getPlatformVerificationQueue.invalidate();
    void utils.platform.getVerificationRequest.invalidate();
  }, [utils]);

  const acknowledgeMut = trpc.places.acknowledgePlaceVerification.useMutation({
    onSuccess: () => {
      toast.success({ title: String(t("admin.vrAcknowledgedToast")) });
      invalidate();
    },
    onError: (err) =>
      toast.danger({
        title: String(t("admin.vrAcknowledgeFailed")),
        message: formatErrorMessage(err, t),
      }),
  });
  const releaseMut = trpc.places.releasePlaceVerification.useMutation({
    onSuccess: () => {
      toast.success({ title: String(t("admin.vrReleasedToast")) });
      invalidate();
    },
    onError: (err) =>
      toast.danger({
        title: String(t("admin.vrReleaseFailed")),
        message: formatErrorMessage(err, t),
      }),
  });
  const reviewMut = trpc.places.reviewPlaceVerification.useMutation({
    onSuccess: (_data, vars) => {
      toast.success({
        title: String(
          vars.decision === "APPROVED"
            ? t("admin.vrApprovedTitle")
            : t("admin.vrRejectedTitle"),
        ),
        message: String(
          vars.decision === "APPROVED"
            ? t("admin.vrApprovedMessage", { name: context.placeName })
            : t("admin.vrRejectedMessage", { name: context.placeName }),
        ),
      });
      invalidate();
      onDecided?.();
    },
    onError: (err) =>
      toast.danger({
        title: String(t("admin.vrDecisionFailed")),
        message: formatErrorMessage(err, t),
      }),
  });

  const anyPending =
    acknowledgeMut.isPending || releaseMut.isPending || reviewMut.isPending;

  // ── Derived lock / status state ──────────────────────────────────────
  const status: RequestStatus | null = request?.status ?? context.status;
  const lockHolderId = request?.acknowledgedBy ?? context.acknowledgerHumanId;
  const isTerminal =
    status === "APPROVED" || status === "REJECTED" || status === "WITHDRAWN";
  const isPending = status === "PENDING";
  const isInReview = status === "IN_REVIEW";
  const lockedToMe = isInReview && lockHolderId === actorHumanId;
  const lockedToOther =
    isInReview && !!lockHolderId && lockHolderId !== actorHumanId;

  const notesTrimmed = notes.trim();
  const canReject = lockedToMe && notesTrimmed.length >= 10;

  const toggleCheck = useCallback((i: number) => {
    setChecklist((prev) => {
      const next = [...prev];
      next[i] = !next[i];
      return next;
    });
  }, []);

  const submitDecision = useCallback(
    (decision: "APPROVED" | "REJECTED") => {
      if (!resolvedRequestId) return;
      reviewMut.mutate({
        requestId: resolvedRequestId,
        decision,
        reviewerNotes: notesTrimmed || null,
      });
    },
    [resolvedRequestId, notesTrimmed, reviewMut],
  );

  const locationString = useMemo(() => {
    const parts = [context.city, context.region, context.countryCode].filter(
      Boolean,
    );
    if (parts.length > 0) return parts.join(", ");
    return context.address ?? String(t("admin.vrNoAddress"));
  }, [context.city, context.region, context.countryCode, context.address, t]);

  // ── Loading / error ──────────────────────────────────────────────────
  if (requestQuery.isLoading) {
    return (
      <YStack alignItems="center" justifyContent="center" padding="$6" gap="$3">
        <Spinner size="lg" />
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.vrLoading"))}
        </Text>
      </YStack>
    );
  }

  if (requestQuery.error) {
    return (
      <YStack gap="$3" padding="$3">
        <Text variant="body" tone="error">
          {requestQuery.error.data?.code === "NOT_FOUND"
            ? String(t("admin.vrNoRequest"))
            : formatErrorMessage(requestQuery.error)}
        </Text>
        <Button
          variant="secondary"
          size="$2"
          onPress={() => void requestQuery.refetch()}
        >
          {String(t("admin.ppRetry"))}
        </Button>
      </YStack>
    );
  }

  const documents = request?.documents ?? [];

  return (
    <YStack gap="$5">
      {/* ── Place context card ───────────────────────────────── */}
      <YStack
        gap="$2"
        padding="$3"
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surfaceMuted"
      >
        <XStack justifyContent="space-between" alignItems="flex-start" gap="$2">
          <Text variant="body" weight="bold" flex={1} minWidth={0}>
            {context.placeName}
          </Text>
          {status ? <RequestStatusPill status={status} /> : null}
        </XStack>

        <XStack gap="$2" alignItems="center">
          <MapPin size={12} style={{ opacity: 0.6, flexShrink: 0 }} />
          <Text variant="bodySmall" tone="muted">
            {locationString}
          </Text>
        </XStack>

        <XStack gap="$4" flexWrap="wrap" alignItems="center">
          <XStack gap="$2" alignItems="center">
            <Users size={12} style={{ opacity: 0.6 }} />
            <Text variant="caption" tone="muted">
              {String(t("admin.vrOwnersOnFile", { count: context.ownerCount }))}
            </Text>
          </XStack>
          {context.capacity != null ? (
            <Text variant="caption" tone="muted">
              {String(
                t("admin.vrCapacity", {
                  capacity: context.capacity.toLocaleString(),
                }),
              )}
            </Text>
          ) : null}
          {context.website && getSafeExternalHref(context.website) ? (
            <XStack gap="$2" alignItems="center">
              <Globe size={12} style={{ opacity: 0.6 }} />
              <a
                href={getSafeExternalHref(context.website)}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)", fontSize: 12 }}
              >
                {String(t("admin.vrWebsite"))}
              </a>
            </XStack>
          ) : null}
          {context.phone ? (
            <XStack gap="$2" alignItems="center">
              <Phone size={12} style={{ opacity: 0.6 }} />
              <Text variant="caption" tone="muted">
                {context.phone}
              </Text>
            </XStack>
          ) : null}
        </XStack>

        {context.submitterName || context.submittedAt ? (
          <Text variant="caption" tone="muted">
            {String(
              t("admin.vrSubmittedBy", {
                name: context.submitterName ?? "—",
              }),
            )}
            {context.submittedAt
              ? ` · ${relativeTime(new Date(context.submittedAt))}`
              : ""}
          </Text>
        ) : null}
      </YStack>

      {/* ── Documents ────────────────────────────────────────── */}
      <YStack gap="$2">
        <Text style={SECTION_LABEL} tone="muted">
          {String(t("admin.vrDocuments", { count: documents.length }))}
        </Text>
        {documents.length === 0 ? (
          <Text variant="bodySmall" tone="muted">
            {String(t("admin.vrNoDocuments"))}
          </Text>
        ) : (
          <XStack gap="$2" flexWrap="wrap">
            {documents.map((doc) => {
              const image = isImageType(doc.contentType) && !!doc.viewUrl;
              if (image) {
                return (
                  <YStack key={doc.id} gap="$1" width={120}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={doc.viewUrl!}
                      alt={doc.fileName}
                      width={120}
                      height={120}
                      role="button"
                      tabIndex={0}
                      aria-label={String(t("admin.vrView"))}
                      onClick={() =>
                        window.open(
                          doc.viewUrl!,
                          "_blank",
                          "noopener,noreferrer",
                        )
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          window.open(
                            doc.viewUrl!,
                            "_blank",
                            "noopener,noreferrer",
                          );
                        }
                      }}
                      style={{
                        width: 120,
                        height: 120,
                        objectFit: "cover",
                        border: "2px solid var(--borderColor)",
                        cursor: "pointer",
                        display: "block",
                      }}
                    />
                    <Text
                      variant="caption"
                      tone="muted"
                      truncate
                      style={{ maxWidth: 120 }}
                    >
                      {doc.fileName}
                    </Text>
                  </YStack>
                );
              }
              return (
                <XStack
                  key={doc.id}
                  gap="$3"
                  padding="$3"
                  alignItems="center"
                  borderWidth={2}
                  borderColor="$borderColor"
                  backgroundColor="$surface"
                  flexBasis={280}
                  flexGrow={1}
                  minWidth={0}
                >
                  {isImageType(doc.contentType) ? (
                    <ImageIcon
                      size={18}
                      style={{ opacity: 0.6, flexShrink: 0 }}
                    />
                  ) : (
                    <FileText
                      size={18}
                      style={{ opacity: 0.6, flexShrink: 0 }}
                    />
                  )}
                  <YStack flex={1} gap="$1" minWidth={0}>
                    <Text variant="bodySmall" weight="bold" truncate>
                      {doc.fileName}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {doc.contentType} · {formatBytes(doc.sizeBytes)}
                    </Text>
                  </YStack>
                  {doc.viewUrl ? (
                    <Button
                      variant="secondary"
                      size="$2"
                      onPress={() =>
                        window.open(
                          doc.viewUrl!,
                          "_blank",
                          "noopener,noreferrer",
                        )
                      }
                    >
                      <ExternalLink size={13} />
                      {String(t("admin.vrView"))}
                    </Button>
                  ) : doc.deletedAt ? (
                    <Badge tone="neutral" size="sm">
                      {String(t("admin.vrDeleted"))}
                    </Badge>
                  ) : (
                    <Badge tone="warning" size="sm">
                      {String(t("admin.vrPreviewUnavailable"))}
                    </Badge>
                  )}
                </XStack>
              );
            })}
          </XStack>
        )}
      </YStack>

      {/* ── Advisory checklist ───────────────────────────────── */}
      {!isTerminal ? (
        <YStack gap="$2">
          <Text style={SECTION_LABEL} tone="muted">
            {String(t("admin.vrChecklist"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("admin.vrChecklistHint"))}
          </Text>
          <YStack gap="$1">
            {CHECKLIST_ITEMS.map((item, i) => (
              <XStack
                key={item}
                gap="$2"
                alignItems="center"
                paddingVertical="$1"
                cursor="pointer"
                onPress={() => toggleCheck(i)}
                {...({
                  role: "checkbox",
                  "aria-checked": checklist[i],
                  tabIndex: 0,
                  onKeyDown: (e: {
                    key: string;
                    preventDefault: () => void;
                  }) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleCheck(i);
                    }
                  },
                } as object)}
              >
                {checklist[i] ? (
                  <CheckSquare size={16} color="var(--accent)" />
                ) : (
                  <Square size={16} color="var(--colorMuted)" />
                )}
                <Text variant="bodySmall">{String(t(item))}</Text>
              </XStack>
            ))}
          </YStack>
        </YStack>
      ) : null}

      {/* ── Reviewer notes ───────────────────────────────────── */}
      {isTerminal ? (
        request?.reviewerNotes ? (
          <YStack gap="$2">
            <Text style={SECTION_LABEL} tone="muted">
              {String(t("admin.vrNotes"))}
            </Text>
            <Text
              variant="bodySmall"
              padding="$3"
              borderWidth={2}
              borderColor="$borderColor"
              backgroundColor="$surface"
            >
              {request.reviewerNotes}
            </Text>
          </YStack>
        ) : null
      ) : (
        <YStack gap="$2">
          <Text style={SECTION_LABEL} tone="muted">
            {String(t("admin.vrNotes"))}
          </Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder={String(t("admin.vrNotesPlaceholder"))}
            multiline
            numberOfLines={4}
            maxLength={2000}
            fullWidth
            disabled={anyPending}
          />
          <XStack justifyContent="space-between" alignItems="center">
            {lockedToMe &&
            notesTrimmed.length > 0 &&
            notesTrimmed.length < 10 ? (
              <Text variant="caption" tone="warning">
                {String(t("admin.vrRejectNotesRequired"))}
              </Text>
            ) : (
              <YStack />
            )}
            <Text variant="caption" tone="muted">
              {notes.length}/2000
            </Text>
          </XStack>
        </YStack>
      )}

      {/* ── Action bar ───────────────────────────────────────── */}
      {isTerminal ? (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderColor="$borderColor"
          backgroundColor="$surfaceMuted"
        >
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            {status ? <RequestStatusPill status={status} /> : null}
            {context.reviewerName ? (
              <Text variant="caption" tone="muted">
                {String(
                  t("admin.vrDecisionBy", { name: context.reviewerName }),
                )}
              </Text>
            ) : null}
            {context.reviewedAt ? (
              <Text variant="caption" tone="muted">
                {relativeTime(new Date(context.reviewedAt))}
              </Text>
            ) : null}
          </XStack>
          {onClose ? (
            <XStack justifyContent="flex-end">
              <Button variant="secondary" size="$2" onPress={onClose}>
                {String(t("common.close"))}
              </Button>
            </XStack>
          ) : null}
        </YStack>
      ) : lockedToOther ? (
        <XStack
          gap="$2"
          alignItems="center"
          padding="$3"
          borderWidth={2}
          borderColor="$warning"
          backgroundColor="$surfaceMuted"
        >
          <Lock size={16} color="var(--warning)" />
          <Text variant="bodySmall" tone="warning">
            {context.acknowledgerName
              ? String(
                  t("admin.vrLockedBy", { name: context.acknowledgerName }),
                )
              : String(t("admin.vrLockedGeneric"))}
          </Text>
        </XStack>
      ) : (
        <XStack gap="$2" flexWrap="wrap">
          {isPending ? (
            <Button
              variant="primary"
              size="$3"
              onPress={() =>
                resolvedRequestId &&
                acknowledgeMut.mutate({ requestId: resolvedRequestId })
              }
              disabled={anyPending || !resolvedRequestId}
            >
              <Eye size={15} />
              {String(t("admin.vrAcknowledgeToReview"))}
            </Button>
          ) : null}

          <Button
            variant="primary"
            size="$3"
            onPress={() => setShowApproveConfirm(true)}
            disabled={!lockedToMe || anyPending}
          >
            <ShieldCheck size={15} />
            {String(t("admin.vrApprove"))}
          </Button>

          <Button
            variant="destructive"
            size="$3"
            onPress={() => submitDecision("REJECTED")}
            disabled={!canReject || anyPending}
          >
            <ShieldX size={15} />
            {String(t("admin.vrReject"))}
          </Button>

          {lockedToMe ? (
            <Button
              variant="secondary"
              size="$3"
              onPress={() =>
                resolvedRequestId &&
                releaseMut.mutate({ requestId: resolvedRequestId })
              }
              disabled={anyPending}
            >
              <Undo2 size={15} />
              {String(t("admin.vrRelease"))}
            </Button>
          ) : null}
        </XStack>
      )}

      <ConfirmDialog
        open={showApproveConfirm}
        onConfirm={() => {
          setShowApproveConfirm(false);
          submitDecision("APPROVED");
        }}
        onCancel={() => setShowApproveConfirm(false)}
        title={String(t("admin.vrApproveConfirmTitle"))}
        description={String(
          t("admin.vrApproveConfirmBody", { name: context.placeName }),
        )}
        confirmLabel={String(t("admin.vrApprove"))}
        tone="default"
        loading={reviewMut.isPending}
      />
    </YStack>
  );
}
