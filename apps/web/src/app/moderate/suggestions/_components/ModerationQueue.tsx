"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { XStack, YStack, type TamaguiElement } from "tamagui";
import {
  Badge,
  Button,
  CharCountTextarea,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Check, ClipboardList, ExternalLink, X } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import {
  listingClosedKind,
  listingClosedKindFromAppCode,
} from "@/lib/listing-closed";
import {
  getInvalidFieldsMeta,
  suggestionReasonMessageKey,
} from "@/lib/suggestion-error";
import { SuggestionDiffCard } from "@/components/community/SuggestionDiffCard";
import { useSecondFactorRequiredToast } from "@/components/community/use-second-factor-required-toast";
import {
  MATERIAL_SUGGESTION_FIELDS,
  SUGGESTION_FIELD_LABEL_KEYS,
  orderedSuggestionFieldKeys,
} from "@/components/community/suggestion-fields-display";

const PAGE_LIMIT = 20;

/**
 * Community moderator queue (/moderate/suggestions — spec FR-008/FR-009):
 * PENDING edit suggestions on COMMUNITY listings with per-field diff review.
 * Mirrors the PlatformVerificationQueue list + review-panel pattern.
 */
export function ModerationQueue() {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const handleSecondFactorRequired = useSecondFactorRequiredToast();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const rejectRef = useRef<TamaguiElement>(null);
  /** Set when Approve is refused on a closed listing; see the CONFLICT branch. */
  const [focusReject, setFocusReject] = useState(false);

  const listQuery = trpc.eventSuggestions.listForModeration.useInfiniteQuery(
    { limit: PAGE_LIMIT },
    {
      staleTime: 15_000,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  const items = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [listQuery.data],
  );
  const selected =
    items.find((item) => item.suggestion.id === selectedId) ?? null;

  const selectedClosed = listingClosedKind(selected?.event?.status);

  const closePanel = () => {
    setSelectedId(null);
    setNote("");
  };

  const invalidate = () =>
    void utils.eventSuggestions.listForModeration.invalidate();

  const reviewMut = trpc.eventSuggestions.review.useMutation({
    // Every failure branch below shows its own toast, so opt out of
    // GlobalMutationErrorNotifier's generic danger toast — it would
    // double-toast AND run the error through formatErrorMessage, which
    // console-warns on internal-tier codes like SECOND_FACTOR_REQUIRED
    // (deliberately absent from the errors.* catalog).
    meta: { silent: true },
    onSuccess: (data, vars) => {
      if (vars.decision === "APPROVE") {
        if (data.conflictedFields.length > 0) {
          toast.warning({
            title: String(t("moderation.approvedToast")),
            message: String(
              t("moderation.approvedPartialToast", {
                applied: data.appliedFields.length,
                conflicted: data.conflictedFields.length,
              }),
            ),
          });
        } else {
          toast.success({ title: String(t("moderation.approvedToast")) });
        }
      } else {
        toast.success({ title: String(t("moderation.rejectedToast")) });
      }
      closePanel();
      invalidate();
    },
    onError: (err) => {
      // The /moderate route gate normally redirects unenrolled staff, but the
      // enrollment state can change mid-session — surface the enrollment
      // prompt instead of a generic failure toast.
      if (handleSecondFactorRequired(err)) return;
      const appCode = getAppErrorCode(err);
      if (appCode === "EDIT_SUGGESTION_ALREADY_REVIEWED") {
        toast.info({ title: String(t("moderation.alreadyReviewedToast")) });
        closePanel();
        invalidate();
        return;
      }
      // The listing was taken down or ended after this list loaded. Refresh so
      // the row picks up its label and loses Approve; focus goes to Reject,
      // since the Approve button the moderator pressed is about to unmount.
      if (listingClosedKindFromAppCode(appCode)) {
        toast.warning({
          title: String(t("moderation.decisionFailedToast")),
          message: String(
            t(
              appCode === "EVENT_ALREADY_COMPLETED"
                ? "moderation.suggestionToastEnded"
                : "moderation.suggestionToastTakenDown",
            ),
          ),
        });
        setFocusReject(true);
        invalidate();
        return;
      }
      // A re-validation failure at approve (stored Json no longer passes) or a
      // reject-path rejection carries a discriminating `meta.reason`. Use the
      // SHARED reason → message map so the moderator sees WHY (blocked_content,
      // invalid_body, stored_fields_revalidation_failed, …) instead of a
      // generic "could not record decision" toast.
      if (appCode === "EDIT_SUGGESTION_INVALID_FIELDS") {
        const meta = getInvalidFieldsMeta(err);
        toast.danger({
          title: String(t("moderation.decisionFailedToast")),
          message: String(t(suggestionReasonMessageKey(meta?.reason))),
        });
        return;
      }
      toast.danger({
        title: String(t("moderation.decisionFailedToast")),
        message: formatErrorMessage(err, (key) => String(t(key))),
      });
    },
  });

  // Waits for the write to settle: Reject is disabled while it is in flight,
  // and a disabled button does not take focus.
  useEffect(() => {
    if (!focusReject || reviewMut.isPending) return;
    setFocusReject(false);
    (rejectRef.current as HTMLElement | null)?.focus();
  }, [focusReject, reviewMut.isPending]);

  const review = (decision: "APPROVE" | "REJECT") => {
    if (!selected) return;
    reviewMut.mutate({
      suggestionId: selected.suggestion.id,
      decision,
      reviewNote: note.trim() || undefined,
    });
  };

  // ── Loading ────────────────────────────────────────────────────────────
  if (listQuery.isLoading) {
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
  if (listQuery.isError) {
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
          <Button
            variant="secondary"
            size="$3"
            onPress={() => void listQuery.refetch()}
          >
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
          {String(t("moderation.suggestionsTitle"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("moderation.suggestionsSubtitle"))}
        </Text>
      </YStack>

      {/* ── Empty band ──────────────────────────────────────────────────── */}
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
          <ClipboardList size={28} style={{ opacity: 0.4 }} aria-hidden />
          <Text variant="h4">{String(t("moderation.suggestionsEmpty"))}</Text>
          <Text variant="body" tone="muted" textAlign="center">
            {String(t("moderation.suggestionsEmptyHint"))}
          </Text>
        </YStack>
      ) : (
        <XStack gap="$4" alignItems="flex-start" flexWrap="wrap">
          {/* ── Queue list ─────────────────────────────────────────────── */}
          <YStack gap="$2" flex={1} minWidth={300}>
            {items.map(({ suggestion, event, submitterName }) => {
              const isSelected = suggestion.id === selectedId;
              const closedKind = listingClosedKind(event?.status);
              const submitter = submitterName
                ? submitterName
                : suggestion.submitterHumanId
                  ? suggestion.submitterHumanId.slice(0, 8)
                  : String(t("moderation.anonymous"));
              const toggleRow = () => {
                setSelectedId(isSelected ? null : suggestion.id);
                setNote("");
              };
              return (
                // Native interactive wrapper: keyboard activation + focus
                // outline (Tamagui onPress only maps to click on web).
                <div
                  key={suggestion.id}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isSelected}
                  style={{ cursor: "pointer" }}
                  onClick={toggleRow}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleRow();
                    }
                  }}
                >
                  <YStack
                    gap="$2"
                    padding="$3"
                    minHeight={44}
                    borderWidth={2}
                    borderColor={isSelected ? "$accent" : "$borderColor"}
                    backgroundColor="$surface"
                    hoverStyle={{ borderColor: "$accent" }}
                  >
                    <XStack
                      justifyContent="space-between"
                      alignItems="center"
                      gap="$2"
                      flexWrap="wrap"
                    >
                      <XStack
                        gap="$2"
                        alignItems="center"
                        flex={1}
                        minWidth={0}
                      >
                        <Badge tone="warning" size="sm">
                          {String(t("moderation.pendingBadge")).toUpperCase()}
                        </Badge>
                        {closedKind ? (
                          <Badge tone="neutral" size="sm">
                            {String(
                              t(
                                closedKind === "ended"
                                  ? "moderation.listingEndedBadge"
                                  : "moderation.listingTakenDownBadge",
                              ),
                            ).toUpperCase()}
                          </Badge>
                        ) : null}
                        <Text
                          variant="body"
                          weight="bold"
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {event?.title ?? String(t("moderation.unknownEvent"))}
                        </Text>
                      </XStack>
                      <Text variant="caption" tone="muted">
                        {fmt.dateTime(new Date(suggestion.createdAt), {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </Text>
                    </XStack>

                    <Text variant="caption" tone="muted">
                      {String(t("moderation.submittedBy", { name: submitter }))}
                    </Text>

                    {/* Proposed-field chips */}
                    <XStack gap="$2" flexWrap="wrap">
                      {orderedSuggestionFieldKeys(suggestion.fields).map(
                        (key) => (
                          <XStack
                            key={key}
                            borderWidth={1}
                            borderColor="$borderColor"
                            paddingHorizontal="$2"
                            paddingVertical={2}
                          >
                            <Text
                              variant="caption"
                              tone="muted"
                              textTransform="uppercase"
                              letterSpacing={0.5}
                            >
                              {SUGGESTION_FIELD_LABEL_KEYS[key]
                                ? String(t(SUGGESTION_FIELD_LABEL_KEYS[key]))
                                : key}
                            </Text>
                          </XStack>
                        ),
                      )}
                    </XStack>
                  </YStack>
                </div>
              );
            })}

            {listQuery.hasNextPage ? (
              <XStack justifyContent="center" paddingVertical="$2">
                <Button
                  variant="secondary"
                  size="$3"
                  onPress={() => void listQuery.fetchNextPage()}
                  disabled={listQuery.isFetchingNextPage}
                >
                  {listQuery.isFetchingNextPage ? (
                    <Spinner size="small" />
                  ) : null}
                  {String(t("moderation.loadMore"))}
                </Button>
              </XStack>
            ) : null}
          </YStack>

          {/* ── Review panel ───────────────────────────────────────────── */}
          {selected ? (
            <YStack
              gap="$3"
              padding="$4"
              flexBasis={440}
              flexGrow={1}
              minWidth={300}
              borderWidth={2}
              borderColor="$borderColor"
              backgroundColor="$surface"
            >
              <XStack justifyContent="space-between" alignItems="center">
                <Text
                  variant="h4"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={0.5}
                >
                  {String(t("moderation.reviewTitle"))}
                </Text>
                <Button
                  variant="ghost"
                  size="$2"
                  icon
                  aria-label={String(t("moderation.close"))}
                  onPress={closePanel}
                >
                  <X size={14} />
                </Button>
              </XStack>

              <YStack gap="$1">
                <Text variant="bodySmall" weight="bold">
                  {selected.event?.title ??
                    String(t("moderation.unknownEvent"))}
                </Text>
                {selected.event?.slug ? (
                  <NextLinkAnchor
                    href={`/events/${selected.event.slug}`}
                    target="_blank"
                    textDecorationLine="none"
                  >
                    <XStack gap="$2" alignItems="center" minHeight={24}>
                      <ExternalLink size={12} aria-hidden />
                      <Text variant="caption" tone="accent">
                        {String(t("moderation.viewEvent"))}
                      </Text>
                    </XStack>
                  </NextLinkAnchor>
                ) : null}
                <Text variant="caption" tone="muted">
                  {String(
                    t("moderation.submittedBy", {
                      name: selected.submitterName
                        ? selected.submitterName
                        : selected.suggestion.submitterHumanId
                          ? selected.suggestion.submitterHumanId.slice(0, 8)
                          : String(t("moderation.anonymous")),
                    }),
                  )}{" "}
                  ·{" "}
                  {fmt.dateTime(new Date(selected.suggestion.createdAt), {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </Text>
              </YStack>

              {selected.suggestion.note ? (
                <YStack gap="$1">
                  <Text
                    variant="caption"
                    weight="bold"
                    textTransform="uppercase"
                    letterSpacing={0.5}
                  >
                    {String(t("moderation.submitterNote"))}
                  </Text>
                  <Text variant="bodySmall">{selected.suggestion.note}</Text>
                </YStack>
              ) : null}

              {/* Per-field diffs. Conflicts are computed server-side at
                  APPROVE (FR-009) — pending rows carry none, so the cards
                  render unconflicted here; partial applies surface via the
                  post-review toast. */}
              <YStack gap="$2">
                {orderedSuggestionFieldKeys(selected.suggestion.fields).map(
                  (key) => (
                    <SuggestionDiffCard
                      key={key}
                      fieldKey={key}
                      label={
                        SUGGESTION_FIELD_LABEL_KEYS[key]
                          ? String(t(SUGGESTION_FIELD_LABEL_KEYS[key]))
                          : key
                      }
                      before={selected.suggestion.baseVersion[key] ?? null}
                      after={selected.suggestion.fields[key] ?? null}
                      material={MATERIAL_SUGGESTION_FIELDS.has(key)}
                    />
                  ),
                )}
              </YStack>

              <YStack gap="$1">
                <Text
                  variant="caption"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={0.5}
                >
                  {String(t("moderation.reviewNoteLabel"))}
                </Text>
                <CharCountTextarea
                  value={note}
                  onChange={setNote}
                  maxLength={1000}
                  minHeight={72}
                  placeholder={String(t("moderation.reviewNotePlaceholder"))}
                  disabled={reviewMut.isPending}
                  testIdBase="moderation-review-note"
                />
              </YStack>

              {selectedClosed ? (
                <Text variant="bodySmall" tone="muted" role="status">
                  {String(
                    t(
                      selectedClosed === "ended"
                        ? "moderation.suggestionHintEnded"
                        : "moderation.suggestionHintTakenDown",
                    ),
                  )}
                </Text>
              ) : null}

              <XStack gap="$2" flexWrap="wrap">
                {selectedClosed ? null : (
                  <Button
                    variant="primary"
                    size="$3"
                    onPress={() => review("APPROVE")}
                    disabled={reviewMut.isPending}
                  >
                    <Check size={14} aria-hidden />
                    {String(t("moderation.approve"))}
                  </Button>
                )}
                <Button
                  ref={rejectRef}
                  variant="destructive"
                  size="$3"
                  onPress={() => review("REJECT")}
                  disabled={reviewMut.isPending}
                >
                  <X size={14} />
                  {String(t("moderation.reject"))}
                </Button>
              </XStack>
            </YStack>
          ) : null}
        </XStack>
      )}
    </YStack>
  );
}
