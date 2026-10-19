"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
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
import { Check, ExternalLink, Flag, X } from "lucide-react";

import {
  formatRelativeAge,
  reasonLabelKey,
  subjectHref,
  subjectTypeLabelKey,
  type ReportArrivalAreaKind,
  type ReportSubjectParentType,
  type ReportReason,
  type ReportSubjectType,
} from "./entity-report-queue.helpers";

/** Server cap on `reviewNote` (ENTITY_REPORT_REVIEW_NOTE_MAX in core). */
const REVIEW_NOTE_MAX = 2000;

/** Details longer than this render clamped with a Show more toggle. */
const DETAILS_CLAMP_CHARS = 280;
const DETAILS_CLAMP_LINES = 4;

/** User free text renders as TEXT ONLY; CSS preserves the line breaks. */
const DETAILS_TEXT_STYLE: CSSProperties = { whiteSpace: "pre-wrap" };

/** `@th/ui` Text has no multi-line `numberOfLines` (only single-line
 *  `truncate`), so long details clamp via the CSS line-clamp box. */
const DETAILS_CLAMPED_STYLE: CSSProperties = {
  ...DETAILS_TEXT_STYLE,
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: DETAILS_CLAMP_LINES,
  overflow: "hidden",
};

/** A single report row. Mirrors the `entityReports.listForModeration` item,
 *  except `createdAt` is a plain ISO string so the view stays free of
 *  `Date`/serializer concerns (the container maps `Date -> ISOString`). */
export type EntityReportItem = {
  id: string;
  subjectType: ReportSubjectType;
  subjectId: string;
  /** Hydrated display name; null = subject row gone or hydration degraded. */
  subjectName: string | null;
  /** Hydrated public-page slug; null = unresolvable (no link rendered). */
  subjectSlug: string | null;
  /** ARRIVAL_AREA only: which page `subjectSlug` is (place or event). */
  subjectParentType?: ReportSubjectParentType | null;
  /** ARRIVAL_AREA only: the reported area's kind (its label in the row). */
  subjectKind?: ReportArrivalAreaKind | null;
  reporterHumanId: string;
  /** Hydrated reporter name; null = human row gone or hydration degraded. */
  reporterName: string | null;
  reason: ReportReason;
  details: string | null;
  createdAt: string;
};

export type EntityReportQueueViewProps = {
  items: EntityReportItem[];
  /**
   * Exact server-computed PENDING total (freshest page's `pendingCount`) —
   * rendered as a chip beside the heading (the spec's "pending badge count"
   * criterion; the static platform nav carries no live badge). Undefined
   * while nothing has loaded.
   */
  pendingCount?: number;
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
   * Submit a verdict for a report. May return a promise; when it resolves the
   * view closes the inline panel and clears the note. If it rejects (the
   * container surfaces the error), the panel stays open so the note survives.
   */
  onReview: (
    reportId: string,
    verdict: "RESOLVED" | "DISMISSED",
    note?: string,
  ) => void | Promise<unknown>;
};

/**
 * PURE presentational view for /platform/reports (entity-report-intake spec
 * FR-007): PENDING reports filed against PLACE / HUMAN / ORGANIZATION
 * listings. Owns only local UI state (which row's inline panel is open, the
 * review note, and which long details are expanded) — data fetching, mutation,
 * and toasting live in the `EntityReportQueue` container. Mirrors the
 * `ImageModerationQueueView` list + inline-review shape (the small precedent).
 *
 * Subjects render as their hydrated NAME, linked (new tab, like the sibling
 * queues) to the typed public route via `subjectHref` + the house `safeHref`
 * sanitizer. When `subjectName` is null — the subject row no longer exists
 * (spec risk 3) or hydration degraded server-side — the row falls back to an
 * unlinked type + id chip and stays fully reviewable.
 *
 * `details` is user-submitted free text: rendered as TEXT ONLY with
 * whitespace preserved via CSS (`pre-wrap`) — never HTML/markdown.
 */
export function EntityReportQueueView({
  items,
  pendingCount,
  isLoading,
  isError,
  hasNextPage,
  isFetchingNextPage,
  isReviewPending,
  onRetry,
  onLoadMore,
  onReview,
}: EntityReportQueueViewProps) {
  const t = useTranslations();
  const fmt = useFormatters();

  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  // ── Focus management ───────────────────────────────────────────────────
  // Open → focus the note textarea. Close (Close button) → return focus to
  // that row's Review CTA. Successful verdict (the row leaves the list) →
  // move focus to the queue heading. The CTA button unmounts while its
  // panel is open, so "focus the CTA" must run AFTER the re-render restores
  // it — hence the pending-focus ref consumed by the selectedId effect.
  const selectedIdRef = useRef<string | null>(null);
  const headingRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const reviewCtaRefs = useRef<Map<string, HTMLElement>>(new Map());
  const pendingFocusRef = useRef<
    { target: "row"; id: string } | { target: "heading" } | null
  >(null);

  const setSelectedId = (id: string | null) => {
    selectedIdRef.current = id;
    setSelectedIdState(id);
  };

  useEffect(() => {
    if (selectedId) {
      // CharCountTextarea forwards no ref and has no autoFocus — reach the
      // real <textarea> through the panel wrapper.
      panelRef.current?.querySelector("textarea")?.focus();
      return;
    }
    const pending = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (!pending) return;
    if (pending.target === "row") {
      reviewCtaRefs.current.get(pending.id)?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [selectedId]);

  const closePanel = (focus: { target: "row"; id: string } | { target: "heading" } | null) => {
    pendingFocusRef.current = focus;
    setSelectedId(null);
    setNote("");
  };

  const toggleExpanded = (reportId: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(reportId)) {
        next.delete(reportId);
      } else {
        next.add(reportId);
      }
      return next;
    });

  const review = (reportId: string, verdict: "RESOLVED" | "DISMISSED") => {
    const trimmed = note.trim() || undefined;
    // Only close/clear once the container reports success; on failure the
    // panel stays open so the moderator's note isn't lost. The close is KEYED
    // to the submitting row: if the moderator has since opened another row's
    // panel, a late success on this one must not wipe the note being typed
    // there (the resolved row leaves the list via invalidation anyway).
    void Promise.resolve()
      .then(() => onReview(reportId, verdict, trimmed))
      .then(
        () => {
          if (selectedIdRef.current === reportId) {
            closePanel({ target: "heading" });
          }
        },
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
        <XStack gap="$2" alignItems="center" flexWrap="wrap">
          <Text
            variant="h4"
            tag="h2"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={0.5}
            // Programmatic focus target after a successful verdict removes the
            // focused row (tabIndex -1: focusable by script, not by Tab).
            tabIndex={-1}
            ref={(node) => {
              headingRef.current = node as unknown as HTMLElement | null;
            }}
          >
            {String(t("moderation.reportsTitle"))}
          </Text>
          {typeof pendingCount === "number" && pendingCount > 0 ? (
            <Badge tone="warning" size="sm">
              {String(
                t("moderation.reportsPendingCount", { count: pendingCount }),
              )}
            </Badge>
          ) : null}
        </XStack>
        <Text variant="bodySmall" tone="muted">
          {String(t("moderation.reportsSubtitle"))}
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
          <Flag size={28} style={{ opacity: 0.4 }} aria-hidden />
          <Text variant="h4">{String(t("moderation.reportsEmpty"))}</Text>
          <Text variant="body" tone="muted" textAlign="center">
            {String(t("moderation.reportsEmptyHint"))}
          </Text>
        </YStack>
      ) : (
        <YStack gap="$3">
          {items.map((item) => {
            const isSelected = item.id === selectedId;
            const isExpanded = expandedIds.has(item.id);
            const isLongDetails =
              (item.details?.length ?? 0) > DETAILS_CLAMP_CHARS;
            const href = subjectHref(
              item.subjectType,
              item.subjectSlug,
              item.subjectParentType,
            );
            const typeLabel = String(
              t(subjectTypeLabelKey(item.subjectType, item.subjectKind)),
            );
            const busy = isReviewPending;
            // Accessible-name uniqueness: every row's CTA reads "Review" —
            // per-row aria-label with the subject display text (the same
            // name-or-chip fallback the row shows) so AT users and drivers
            // can target the right row (the two-Save-buttons defect class).
            const subjectText =
              item.subjectName ??
              `${typeLabel} ${item.subjectId}`;

            return (
              <YStack
                key={item.id}
                borderWidth={2}
                borderColor={isSelected ? "$accent" : "$borderColor"}
                backgroundColor="$surface"
              >
                <YStack gap="$2" padding="$3">
                  {/* ── Status + reason + age ───────────────────────────── */}
                  <XStack gap="$2" alignItems="center" flexWrap="wrap">
                    <Badge tone="warning" size="sm">
                      {String(t("moderation.pendingBadge")).toUpperCase()}
                    </Badge>
                    <Text
                      variant="bodySmall"
                      weight="bold"
                      textTransform="uppercase"
                      letterSpacing={0.5}
                    >
                      {String(t(reasonLabelKey(item.reason)))}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {String(
                        t("moderation.reportsReportedAt", {
                          age: formatRelativeAge(
                            new Date(item.createdAt),
                            new Date(),
                            fmt.locale,
                          ),
                        }),
                      )}
                    </Text>
                  </XStack>

                  {/* ── Subject: hydrated name (linked to its public page,
                      new tab like the sibling queues) with the type label as
                      a suffix. Falls back to the unlinked type + id chip
                      when the name is null — the subject row is gone (spec
                      risk 3) or hydration degraded the page. ────────────── */}
                  <YStack gap="$1">
                    <Text
                      variant="caption"
                      weight="bold"
                      textTransform="uppercase"
                      letterSpacing={0.5}
                      tone="muted"
                    >
                      {String(t("moderation.reportsSubjectLabel"))}
                    </Text>
                    {item.subjectName && href ? (
                      <NextLinkAnchor
                        href={href}
                        target="_blank"
                        textDecorationLine="none"
                      >
                        <XStack
                          gap="$2"
                          alignItems="center"
                          minHeight={24}
                          flexWrap="wrap"
                        >
                          <ExternalLink size={12} aria-hidden />
                          {/* $accentText, not $accent: an interactive label
                              needs the AA text rung (DS v2 divergences). */}
                          <Text
                            variant="bodySmall"
                            weight="bold"
                            color="$accentText"
                          >
                            {item.subjectName}
                          </Text>
                          <Text variant="caption" tone="muted">
                            {typeLabel}
                          </Text>
                        </XStack>
                      </NextLinkAnchor>
                    ) : item.subjectName ? (
                      <XStack gap="$2" alignItems="baseline" flexWrap="wrap">
                        <Text variant="bodySmall" weight="bold">
                          {item.subjectName}
                        </Text>
                        <Text variant="caption" tone="muted">
                          {typeLabel}
                        </Text>
                      </XStack>
                    ) : (
                      <XStack gap="$2" alignItems="baseline" flexWrap="wrap">
                        <Text variant="bodySmall" weight="bold">
                          {typeLabel}
                        </Text>
                        <Text
                          variant="caption"
                          tone="muted"
                          style={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {item.subjectId}
                        </Text>
                      </XStack>
                    )}
                  </YStack>

                  {/* ── Reporter ────────────────────────────────────────── */}
                  <YStack gap="$1">
                    <Text
                      variant="caption"
                      weight="bold"
                      textTransform="uppercase"
                      letterSpacing={0.5}
                      tone="muted"
                    >
                      {String(t("moderation.reportsReporterLabel"))}
                    </Text>
                    {item.reporterName ? (
                      <Text variant="caption" tone="muted">
                        {item.reporterName}
                      </Text>
                    ) : (
                      // Deleted-reporter / degraded-hydration fallback: the
                      // raw id chip (same posture as the subject chip).
                      <Text
                        variant="caption"
                        tone="muted"
                        style={{ fontVariantNumeric: "tabular-nums" }}
                      >
                        {item.reporterHumanId}
                      </Text>
                    )}
                  </YStack>

                  {/* ── Details (user free text — text only, pre-wrap) ──── */}
                  <YStack gap="$1">
                    <Text
                      variant="caption"
                      weight="bold"
                      textTransform="uppercase"
                      letterSpacing={0.5}
                      tone="muted"
                    >
                      {String(t("moderation.reportsDetailsLabel"))}
                    </Text>
                    {item.details ? (
                      <>
                        <Text
                          variant="bodySmall"
                          style={
                            isLongDetails && !isExpanded
                              ? DETAILS_CLAMPED_STYLE
                              : DETAILS_TEXT_STYLE
                          }
                        >
                          {item.details}
                        </Text>
                        {isLongDetails ? (
                          <XStack>
                            <Button
                              variant="ghost"
                              size="$2"
                              onPress={() => toggleExpanded(item.id)}
                            >
                              {String(
                                t(
                                  isExpanded
                                    ? "moderation.reportsShowLess"
                                    : "moderation.reportsShowMore",
                                ),
                              )}
                            </Button>
                          </XStack>
                        ) : null}
                      </>
                    ) : (
                      <Text variant="bodySmall" tone="muted">
                        {String(t("moderation.reportsNoDetails"))}
                      </Text>
                    )}
                  </YStack>

                  {/* ── Actions ─────────────────────────────────────────── */}
                  {isSelected ? (
                    <YStack
                      gap="$3"
                      paddingTop="$1"
                      ref={(node) => {
                        panelRef.current =
                          node as unknown as HTMLElement | null;
                      }}
                    >
                      <YStack gap="$1">
                        <Text
                          variant="caption"
                          weight="bold"
                          textTransform="uppercase"
                          letterSpacing={0.5}
                        >
                          {String(t("moderation.reportsReviewNoteLabel"))}
                        </Text>
                        <CharCountTextarea
                          id="moderation-report-note"
                          value={note}
                          onChange={setNote}
                          maxLength={REVIEW_NOTE_MAX}
                          minHeight={72}
                          placeholder={String(
                            t("moderation.reportsReviewNotePlaceholder"),
                          )}
                          disabled={busy}
                          testIdBase="moderation-report-note"
                        />
                      </YStack>
                      <XStack gap="$2" flexWrap="wrap">
                        <Button
                          variant="primary"
                          size="$3"
                          onPress={() => review(item.id, "RESOLVED")}
                          disabled={busy}
                        >
                          <Check size={14} aria-hidden />
                          {String(t("moderation.reportsResolve"))}
                        </Button>
                        <Button
                          variant="destructive"
                          size="$3"
                          onPress={() => review(item.id, "DISMISSED")}
                          disabled={busy}
                        >
                          <X size={14} aria-hidden />
                          {String(t("moderation.reportsDismiss"))}
                        </Button>
                        <Button
                          variant="ghost"
                          size="$3"
                          onPress={() =>
                            closePanel({ target: "row", id: item.id })
                          }
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
                        ref={(node) => {
                          if (node) {
                            reviewCtaRefs.current.set(
                              item.id,
                              node as unknown as HTMLElement,
                            );
                          } else {
                            reviewCtaRefs.current.delete(item.id);
                          }
                        }}
                        aria-label={String(
                          t("moderation.reportsReviewAria", {
                            subject: subjectText,
                          }),
                        )}
                        onPress={() => {
                          setSelectedId(item.id);
                          setNote("");
                        }}
                      >
                        {String(t("moderation.reportsReviewCta"))}
                      </Button>
                    </XStack>
                  )}
                </YStack>
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
