"use client";

import { useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  CharCountTextarea,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  ImageOff,
  ShieldAlert,
  X,
} from "lucide-react";

import {
  buildSubjectHref,
  categoryLabelKey,
  severityLabelKey,
  severityTone,
  type FlaggedCategory,
  type FlaggedSubjectType,
} from "./image-moderation.helpers";

const PREVIEW_SIZE = 200;

/** Image kind as emitted by the flagged-queue DTO (transport `moderation.ts`). */
export type FlaggedImageKind =
  | "EVENT_HERO"
  | "AVATAR"
  | "BANNER"
  | "PAGE_MEDIA";

/** A single flagged-image row. Mirrors the transport `flaggedImageDtoSchema`
 *  DTO, except `moderatedAt` is a plain ISO string here so the view stays free
 *  of `Date`/serializer concerns (the container maps `Date -> ISOString`). */
export type FlaggedImageItem = {
  recordId: string;
  publicUrl: string | null;
  kind: FlaggedImageKind;
  subjectType: FlaggedSubjectType | null;
  subjectId: string | null;
  maxSeverity: number | null;
  categories: { category: FlaggedCategory; severity: number }[] | null;
  degraded: boolean;
  moderatedAt: string | null;
  reviewNote: string | null;
};

export type ImageModerationQueueViewProps = {
  items: FlaggedImageItem[];
  /** Initial page still loading — renders the spinner band. */
  isLoading: boolean;
  /** List query failed — renders the retry band. */
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** A review mutation is in flight — disables the inline review controls. */
  isReviewPending: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  /**
   * Submit a decision for a record. May return a promise; when it resolves the
   * view closes the inline panel and clears the note. If it rejects (or the
   * container surfaces an error), the panel stays open so the note is preserved.
   */
  onReview: (
    recordId: string,
    decision: "APPROVE" | "REJECT",
    note?: string,
  ) => void | Promise<unknown>;
};

/** Order categories by severity desc so the strongest signal reads first. */
type Category = { category: FlaggedCategory; severity: number };
function sortCategories(categories: Category[] | null): Category[] {
  if (!categories) return [];
  return [...categories].sort((a, b) => b.severity - a.severity);
}

/**
 * PURE presentational view for /moderate/images (image-moderation spec FR-008):
 * the FLAGGED-image review queue. Owns only local UI state (which row's inline
 * panel is open, the reject note, and which previews are revealed) — all data
 * fetching, mutation, and toasting live in the `ImageModerationQueue` container.
 *
 * Two moderator-safety affordances are specific to this surface:
 *   • a CLICK-TO-REVEAL blur so a moderator isn't ambushed by explicit content;
 *   • per-category severity chips so most items can be triaged WITHOUT viewing.
 */
export function ImageModerationQueueView({
  items,
  isLoading,
  isError,
  hasNextPage,
  isFetchingNextPage,
  isReviewPending,
  onRetry,
  onLoadMore,
  onReview,
}: ImageModerationQueueViewProps) {
  const t = useTranslations();
  const fmt = useFormatters();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const closePanel = () => {
    setSelectedId(null);
    setNote("");
  };

  const toggleReveal = (recordId: string) =>
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(recordId)) {
        next.delete(recordId);
      } else {
        next.add(recordId);
      }
      return next;
    });

  const review = (recordId: string, decision: "APPROVE" | "REJECT") => {
    const trimmed = note.trim() || undefined;
    // Only close/clear once the container reports success; on failure the
    // panel stays open so the moderator's note isn't lost.
    void Promise.resolve()
      .then(() => onReview(recordId, decision, trimmed))
      .then(
        () => closePanel(),
        () => {
          /* keep the panel open on error */
        },
      );
  };

  // ── Loading ────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$6"
        aria-busy
      >
        <Spinner size="large" />
      </YStack>
    );
  }

  // ── Error + retry ──────────────────────────────────────────────────────
  if (isError) {
    return (
      <YStack
        gap="$3"
        padding="$4"
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surface"
      >
        <Text variant="body" tone="error">
          {String(t("moderation.loadError"))}
        </Text>
        <XStack>
          <Button variant="secondary" size="$3" onPress={onRetry}>
            {String(t("moderation.retry"))}
          </Button>
        </XStack>
      </YStack>
    );
  }

  return (
    <YStack gap="$4">
      <YStack gap="$1">
        <Text
          variant="h4"
          tag="h2"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={0.5}
        >
          {String(t("moderation.imagesTitle"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("moderation.imagesSubtitle"))}
        </Text>
      </YStack>

      {/* ── Empty band ─────────────────────────────────────────────────── */}
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
          <ShieldAlert size={28} style={{ opacity: 0.4 }} aria-hidden />
          <Text variant="h4">{String(t("moderation.imagesEmpty"))}</Text>
          <Text variant="body" tone="muted" textAlign="center">
            {String(t("moderation.imagesEmptyHint"))}
          </Text>
        </YStack>
      ) : (
        <YStack gap="$3">
          {items.map((item) => {
            const isSelected = item.recordId === selectedId;
            const isRevealed = revealedIds.has(item.recordId);
            const categories = sortCategories(item.categories);
            const href = buildSubjectHref(
              item.subjectType as FlaggedSubjectType | null,
              item.subjectId,
            );
            const busy = isReviewPending;

            return (
              <YStack
                key={item.recordId}
                borderWidth={2}
                borderColor={isSelected ? "$accent" : "$borderColor"}
                backgroundColor="$surface"
              >
                <XStack
                  gap="$4"
                  padding="$3"
                  flexWrap="wrap"
                  alignItems="flex-start"
                >
                  {/* ── Click-to-reveal preview ─────────────────────────── */}
                  <YStack
                    width={PREVIEW_SIZE}
                    height={PREVIEW_SIZE}
                    borderWidth={2}
                    borderColor="$borderColor"
                    backgroundColor="$surfaceMuted"
                    overflow="hidden"
                    position="relative"
                  >
                    {item.publicUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={item.publicUrl}
                          alt={String(t("moderation.imagesPreviewAlt"))}
                          width={PREVIEW_SIZE}
                          height={PREVIEW_SIZE}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                            display: "block",
                            filter: isRevealed ? "none" : "blur(24px)",
                            transform: isRevealed ? "none" : "scale(1.1)",
                          }}
                        />
                        {isRevealed ? (
                          <XStack
                            position="absolute"
                            top={0}
                            right={0}
                            padding="$2"
                          >
                            <Button
                              variant="secondary"
                              size="$2"
                              onPress={() => toggleReveal(item.recordId)}
                              aria-label={String(t("moderation.imagesHide"))}
                            >
                              <EyeOff size={14} />
                              {String(t("moderation.imagesHide"))}
                            </Button>
                          </XStack>
                        ) : (
                          // Full-cover reveal control — a real <button> so it is
                          // keyboard-focusable and Enter/Space activates it.
                          <button
                            type="button"
                            onClick={() => toggleReveal(item.recordId)}
                            aria-label={String(t("moderation.imagesReveal"))}
                            style={{
                              position: "absolute",
                              inset: 0,
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              justifyContent: "center",
                              gap: 8,
                              padding: 12,
                              border: "none",
                              cursor: "pointer",
                              background: "rgba(0,0,0,0.55)",
                              color: "#fff",
                              textAlign: "center",
                            }}
                          >
                            <Eye size={20} aria-hidden />
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 700,
                                lineHeight: 1.3,
                              }}
                            >
                              {String(t("moderation.imagesReveal"))}
                            </span>
                          </button>
                        )}
                      </>
                    ) : (
                      <YStack
                        flex={1}
                        alignItems="center"
                        justifyContent="center"
                        gap="$2"
                        padding="$3"
                      >
                        <ImageOff
                          size={24}
                          style={{ opacity: 0.4 }}
                          aria-hidden
                        />
                        <Text variant="caption" tone="muted" textAlign="center">
                          {String(t("moderation.imagesNoPreview"))}
                        </Text>
                      </YStack>
                    )}
                  </YStack>

                  {/* ── Details ─────────────────────────────────────────── */}
                  <YStack gap="$2" flex={1} minWidth={260}>
                    <XStack gap="$2" alignItems="center" flexWrap="wrap">
                      <Badge tone="warning" size="sm">
                        {String(t("moderation.pendingBadge")).toUpperCase()}
                      </Badge>
                      {item.degraded ? (
                        <Badge
                          tone="danger"
                          size="sm"
                          leadingIcon={<AlertTriangle />}
                        >
                          {String(
                            t("moderation.imagesDegradedBadge"),
                          ).toUpperCase()}
                        </Badge>
                      ) : null}
                      {item.moderatedAt ? (
                        <Text variant="caption" tone="muted">
                          {String(
                            t("moderation.imagesFlaggedAt", {
                              date: fmt.dateTime(new Date(item.moderatedAt), {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              }),
                            }),
                          )}
                        </Text>
                      ) : null}
                    </XStack>

                    {item.degraded ? (
                      <Text variant="caption" tone="error">
                        {String(t("moderation.imagesDegradedHint"))}
                      </Text>
                    ) : null}

                    {/* Per-category severity chips (text labels, not colour
                        only). Zero-severity categories are dimmed so the real
                        signals stand out; SEXUAL is the primary signal. */}
                    <XStack gap="$2" flexWrap="wrap" alignItems="center">
                      <Text
                        variant="caption"
                        weight="bold"
                        textTransform="uppercase"
                        letterSpacing={0.5}
                        tone="muted"
                      >
                        {String(t("moderation.imagesSeverityLabel"))}
                      </Text>
                      {categories.length === 0 ? (
                        <Text variant="caption" tone="muted">
                          {String(t("moderation.imagesNoCategories"))}
                        </Text>
                      ) : (
                        categories.map(({ category, severity }) => (
                          <YStack
                            key={category}
                            opacity={severity > 0 ? 1 : 0.5}
                          >
                            <Badge
                              tone={severityTone(severity)}
                              size="sm"
                              variant={severity > 0 ? "soft" : "outline"}
                            >
                              {`${String(
                                t(categoryLabelKey(category)),
                              )}: ${String(t(severityLabelKey(severity)))}`}
                            </Badge>
                          </YStack>
                        ))
                      )}
                    </XStack>

                    {/* Owning entity link */}
                    <YStack gap="$1">
                      <Text
                        variant="caption"
                        weight="bold"
                        textTransform="uppercase"
                        letterSpacing={0.5}
                        tone="muted"
                      >
                        {String(t("moderation.imagesOwningEntity"))}
                      </Text>
                      {href ? (
                        <NextLinkAnchor
                          href={href}
                          target="_blank"
                          textDecorationLine="none"
                        >
                          <XStack gap="$2" alignItems="center" minHeight={24}>
                            <ExternalLink size={12} aria-hidden />
                            <Text variant="bodySmall" tone="accent">
                              {String(t("moderation.imagesViewEvent"))}
                            </Text>
                          </XStack>
                        </NextLinkAnchor>
                      ) : (
                        <Text variant="bodySmall">
                          {item.subjectType
                            ? String(
                                t("moderation.imagesSubjectFallback", {
                                  type: item.subjectType,
                                  id: item.subjectId ?? "—",
                                }),
                              )
                            : String(t("moderation.imagesSubjectUnknown"))}
                        </Text>
                      )}
                    </YStack>

                    {/* Actions */}
                    {isSelected ? (
                      <YStack gap="$3" paddingTop="$1">
                        <YStack gap="$1">
                          <Text
                            variant="caption"
                            weight="bold"
                            textTransform="uppercase"
                            letterSpacing={0.5}
                          >
                            {String(t("moderation.imagesRejectNoteLabel"))}
                          </Text>
                          <CharCountTextarea
                            value={note}
                            onChange={setNote}
                            maxLength={1000}
                            minHeight={72}
                            placeholder={String(
                              t("moderation.imagesRejectNotePlaceholder"),
                            )}
                            disabled={busy}
                            testIdBase="moderation-image-note"
                          />
                        </YStack>
                        <XStack gap="$2" flexWrap="wrap">
                          <Button
                            variant="primary"
                            size="$3"
                            onPress={() => review(item.recordId, "APPROVE")}
                            disabled={busy}
                          >
                            <Check size={14} aria-hidden />
                            {String(t("moderation.approve"))}
                          </Button>
                          <Button
                            variant="destructive"
                            size="$3"
                            onPress={() => review(item.recordId, "REJECT")}
                            disabled={busy}
                          >
                            <X size={14} />
                            {String(t("moderation.reject"))}
                          </Button>
                          <Button
                            variant="ghost"
                            size="$3"
                            onPress={closePanel}
                            disabled={busy}
                          >
                            {String(t("moderation.close"))}
                          </Button>
                        </XStack>
                      </YStack>
                    ) : (
                      <XStack paddingTop="$1">
                        <Button
                          variant="secondary"
                          size="$3"
                          onPress={() => {
                            setSelectedId(item.recordId);
                            setNote("");
                          }}
                        >
                          {String(t("moderation.imagesReviewCta"))}
                        </Button>
                      </XStack>
                    )}
                  </YStack>
                </XStack>
              </YStack>
            );
          })}

          {hasNextPage ? (
            <XStack justifyContent="center" paddingVertical="$2">
              <Button
                variant="secondary"
                size="$3"
                onPress={onLoadMore}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? <Spinner size="small" /> : null}
                {String(t("moderation.loadMore"))}
              </Button>
            </XStack>
          ) : null}
        </YStack>
      )}
    </YStack>
  );
}
