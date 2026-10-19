"use client";

import { useState } from "react";
import { Flag } from "lucide-react";
import { styled, XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  Spinner,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

export interface OwnerAttendeeFeedbackPanelProps {
  placeId: string;
  /**
   * Drop the standalone bordered card and lead with a 1px rule instead, so the
   * panel reads as the last region of a host section that already drew the
   * frame (strict Swiss: no card inside a card). Same prop, same meaning as
   * the two review switches beside it.
   */
  embedded?: boolean;
}

type Aggregate = {
  reviewCount: number;
  overallMean: number | null;
};

const StandaloneCard = styled(YStack, {
  name: "OwnerFeedbackCard",
  padding: "$4",
  gap: "$4",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
});

/** The embedded frame: a rule off what precedes it, no box. */
const EmbeddedRegion = styled(YStack, {
  name: "OwnerFeedbackRegion",
  gap: "$4",
  borderTopWidth: 1,
  borderTopColor: "$borderColor",
  paddingTop: "$4",
});

function formatMean(mean: number | null): string {
  return mean == null ? "—" : mean.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function formatDate(d: Date): string {
  try {
    return new Date(d).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

/**
 * Owner-only private attendee feedback (venue-rating-block-and-owner-optin
 * FR-006/FR-011/FR-014). Shows the VERIFIED vs COMMUNITY aggregate split AND the
 * raw, UNATTRIBUTED text of every review, source-labelled, regardless of the
 * publish toggle. Each entry can be reported to moderators (FR-014). Never shows
 * reviewer identity — the read strips it server-side.
 */
export function OwnerAttendeeFeedbackPanel({
  placeId,
  embedded = false,
}: OwnerAttendeeFeedbackPanelProps) {
  const t = useTranslations();
  const Card = embedded ? EmbeddedRegion : StandaloneCard;
  const { toast } = useNotify();

  const query = trpc.attendeeReviews.getPlaceOwnerFeedback.useQuery(
    { placeId },
    { staleTime: 30_000, retry: 1 },
  );

  const [flagged, setFlagged] = useState<Record<string, boolean>>({});
  const flagMut = trpc.attendeeReviews.flagPlaceFeedback.useMutation({
    onSuccess: (result) => {
      setFlagged((prev) => ({ ...prev, [result.reviewId]: true }));
    },
    onError: (err) => {
      toast.danger({
        id: "attendee-feedback-flag-failed",
        title: String(t("admin.peAttendeeFeedbackFlagFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const heading = (
    <YStack gap="$1">
      <Text variant={embedded ? "body" : "h4"} weight="bold">
        {String(t("admin.peAttendeeFeedbackTitle"))}
      </Text>
      <Text variant="bodySmall" tone="muted">
        {String(t("admin.peAttendeeFeedbackSubtitle"))}
      </Text>
    </YStack>
  );

  if (query.isLoading) {
    return (
      <Card>
        {heading}
        <XStack alignItems="center" gap="$2" paddingVertical="$3">
          <Spinner size="sm" />
        </XStack>
      </Card>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Card>
        {heading}
        <Text variant="bodySmall" tone="error">
          {String(t("admin.peAttendeeFeedbackLoadError"))}
        </Text>
      </Card>
    );
  }

  const { verified, community, entries } = query.data;

  return (
    <Card>
      {heading}

      {/* Aggregate split — verified and community NEVER merged (FR-010). */}
      <XStack gap="$3" flexWrap="wrap">
        <AggregateTile
          label={String(t("admin.peAttendeeFeedbackVerifiedLabel"))}
          agg={verified}
          countLabel={String(
            t("admin.peAttendeeFeedbackReviewCount", {
              count: verified.reviewCount,
            }),
          )}
          avgLabel={String(t("admin.peAttendeeFeedbackAvgOverall"))}
        />
        <AggregateTile
          label={String(t("admin.peAttendeeFeedbackCommunityLabel"))}
          agg={community}
          countLabel={String(
            t("admin.peAttendeeFeedbackReviewCount", {
              count: community.reviewCount,
            }),
          )}
          avgLabel={String(t("admin.peAttendeeFeedbackAvgOverall"))}
        />
      </XStack>

      {/* Raw entries — unattributed, source-labelled. */}
      {entries.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.peAttendeeFeedbackEmpty"))}
        </Text>
      ) : (
        <YStack gap="$3">
          {entries.map((entry) => {
            const isFlagged = flagged[entry.reviewId] === true;
            const isVerified = entry.source === "VERIFIED_TICKET";
            return (
              <YStack
                key={entry.reviewId}
                gap="$2"
                padding="$3"
                borderWidth={1}
                borderColor="$borderColorSoft"
                borderRadius={0}
              >
                <XStack
                  alignItems="center"
                  justifyContent="space-between"
                  gap="$2"
                  flexWrap="wrap"
                >
                  <XStack alignItems="center" gap="$2" flexWrap="wrap">
                    <Badge tone={isVerified ? "success" : "neutral"} size="sm">
                      {String(
                        isVerified
                          ? t("admin.peAttendeeFeedbackSourceVerified")
                          : t("admin.peAttendeeFeedbackSourceCommunity"),
                      )}
                    </Badge>
                    <Text variant="bodySmall" weight="bold">
                      {String(
                        t("admin.peAttendeeFeedbackRating", {
                          score: entry.rating,
                        }),
                      )}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {formatDate(entry.createdAt)}
                    </Text>
                  </XStack>

                  <Button
                    variant="ghost"
                    size="$2"
                    disabled={isFlagged || flagMut.isPending}
                    onPress={() =>
                      flagMut.mutate({ placeId, reviewId: entry.reviewId })
                    }
                    aria-label={String(t("admin.peAttendeeFeedbackFlagAria"))}
                  >
                    <XStack alignItems="center" gap="$1">
                      <Flag size={14} />
                      <Text variant="caption" weight="bold" tone="muted" margin={0}>
                        {String(
                          isFlagged
                            ? t("admin.peAttendeeFeedbackFlagged")
                            : t("admin.peAttendeeFeedbackFlag"),
                        )}
                      </Text>
                    </XStack>
                  </Button>
                </XStack>

                {entry.text ? (
                  <Text variant="body" style={{ whiteSpace: "pre-wrap" }}>
                    {entry.text}
                  </Text>
                ) : (
                  <Text
                    variant="bodySmall"
                    tone="muted"
                    style={{ fontStyle: "italic" }}
                  >
                    {String(t("admin.peAttendeeFeedbackNoText"))}
                  </Text>
                )}
              </YStack>
            );
          })}
        </YStack>
      )}
    </Card>
  );
}

function AggregateTile({
  label,
  agg,
  countLabel,
  avgLabel,
}: {
  label: string;
  agg: Aggregate;
  countLabel: string;
  avgLabel: string;
}) {
  return (
    <YStack
      flex={1}
      minWidth={160}
      gap="$1"
      padding="$3"
      borderWidth={1}
      borderColor="$borderColorSoft"
      borderRadius={0}
    >
      <Text
        variant="caption"
        weight="bold"
        tone="muted"
        style={{ textTransform: "uppercase" }}
      >
        {label}
      </Text>
      <XStack alignItems="baseline" gap="$1">
        <Text variant="h3" weight="bold">
          {formatMean(agg.overallMean)}
        </Text>
        <Text variant="bodySmall" tone="muted">
          / 5
        </Text>
      </XStack>
      <Text variant="caption" tone="muted">
        {avgLabel} · {countLabel}
      </Text>
    </YStack>
  );
}
