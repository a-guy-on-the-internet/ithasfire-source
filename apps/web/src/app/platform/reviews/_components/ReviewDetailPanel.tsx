"use client";

import { useState } from "react";
import { styled, useTheme, YStack, XStack, Stack } from "tamagui";
import { Button, Text, Badge, TextInput, useNotify } from "@th/ui";
import {
  Flag,
  EyeOff,
  AlertTriangle,
  X,
  DollarSign,
  Megaphone,
  Volume2,
  Monitor,
  Users,
  Star,
  ParkingCircle,
  Music,
  MessageCircle,
  MapPin,
  ArrowRight,
} from "lucide-react";
import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { formatDateShort } from "@/lib/format";
import { formatMoneyCents } from "@/lib/format";
import { useTranslations } from "@th/ui";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewRow {
  id: string;
  placeId: string;
  placeName: string;
  anonymousName: string | null;
  anonymousEmail: string | null;
  payoutCents: number | null;
  paymentMethod: string;
  paymentDetail: string | null;
  venuePromoted: string;
  promotionDetail: string | null;
  soundQuality: string;
  soundDetail: string | null;
  stageEquipment: string | null;
  stageEquipmentDetail: string | null;
  audienceFit: string;
  audienceDetail: string | null;
  wouldPlayAgain: string;
  bookerRating: string;
  bookerDetail: string | null;
  parkingLoadIn: string | null;
  parkingDetail: string | null;
  estimatedDraw: number | null;
  comment: string | null;
  genre: string | null;
  source: string;
  flagged: boolean;
  flagReason: string | null;
  hidden: boolean;
  responseText: string | null;
  respondedAt: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styled
// ─────────────────────────────────────────────────────────────────────────────

export const FlagReasonBox = styled(XStack, {
  gap: 6,
  paddingVertical: 4,
  paddingHorizontal: 8,
  backgroundColor: "$surfaceMuted",
  borderWidth: 1,
  borderColor: "$borderColor",
  alignItems: "center",
});

const PanelOverlay = styled(Stack, {
  position: "fixed" as never,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0,0,0,0.45)",
  zIndex: 999,
});

const PanelContainer = styled(YStack, {
  position: "fixed" as never,
  top: 0,
  right: 0,
  bottom: 0,
  width: 520,
  maxWidth: "100vw",
  backgroundColor: "$background",
  borderLeftWidth: 1,
  borderColor: "$borderColor",
  zIndex: 1000,
  overflow: "auto" as never,
});

const PanelHeader = styled(XStack, {
  paddingHorizontal: 20,
  paddingVertical: 16,
  borderBottomWidth: 1,
  borderColor: "$borderColor",
  alignItems: "center",
  justifyContent: "space-between",
});

const SectionCard = styled(YStack, {
  gap: 8,
  padding: 16,
  borderWidth: 1,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
});

const FieldRow = styled(XStack, {
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ReviewDetailPanel({
  review,
  onClose,
  onReviewUpdated,
}: {
  review: ReviewRow;
  onClose: () => void;
  onReviewUpdated: () => void;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const { toast } = useNotify();

  const [reassignQuery, setReassignQuery] = useState("");
  const [showReassign, setShowReassign] = useState(false);

  const placeSearch = trpc.platform.listPlaces.useQuery(
    { limit: 10, query: reassignQuery.trim() },
    {
      enabled: showReassign && reassignQuery.trim().length >= 2,
      staleTime: 10_000,
    },
  );

  const reassignMut = trpc.placeReviews.reassignPlace.useMutation({
    onSuccess: (result) => {
      toast.success({ title: String(t("admin.rmReassignSuccess")) });
      setShowReassign(false);
      setReassignQuery("");
      onReviewUpdated();
      // Update the review object locally so the panel reflects the change
      review.placeId = result.newPlaceId;
      review.placeName = result.newPlaceName;
    },
    onError: (err) => {
      toast.danger({
        title: String(t("admin.rmReassignFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const none = String(t("admin.rmDetailNone"));

  function field(label: string, value: string | number | null | undefined) {
    return (
      <FieldRow>
        <Text
          variant="caption"
          tone="muted"
          style={{ minWidth: 140, flexShrink: 0 }}
        >
          {label}
        </Text>
        <Text
          variant="body"
          style={{
            textAlign: "right",
            flex: 1,
            wordBreak: "break-word" as never,
          }}
        >
          {value != null && value !== "" ? String(value) : none}
        </Text>
      </FieldRow>
    );
  }

  function fmtCents(cents: number | null): string {
    if (cents == null) return none;
    return formatMoneyCents(cents);
  }

  return (
    <>
      <PanelOverlay onPress={onClose} />
      <PanelContainer>
        {/* Header */}
        <PanelHeader>
          <YStack gap={2} flex={1}>
            <Text variant="h3" weight="bold">
              {String(t("admin.rmDetailTitle"))}
            </Text>
            <Text variant="caption" tone="muted">
              {review.placeName}
            </Text>
          </YStack>
          <Button variant="ghost" size="$2" icon onPress={onClose}>
            <X size={18} />
          </Button>
        </PanelHeader>

        <YStack padding={20} gap={16}>
          {/* Status badges row */}
          <XStack gap={8} flexWrap="wrap">
            {review.hidden && (
              <Badge tone="danger" size="sm">
                <EyeOff size={12} /> {String(t("admin.rmHidden"))}
              </Badge>
            )}
            {review.flagged && (
              <Badge tone="warning" size="sm">
                <Flag size={12} /> {String(t("admin.rmFlagged"))}
              </Badge>
            )}
            {!review.hidden && !review.flagged && (
              <Badge tone="success" size="sm">
                {String(t("admin.rmVisible"))}
              </Badge>
            )}
            <Badge tone="neutral" size="sm">
              {review.source}
            </Badge>
          </XStack>

          {review.flagged && review.flagReason && (
            <FlagReasonBox>
              <AlertTriangle size={11} color={theme.warning?.val} />
              <Text variant="caption" tone="warning">
                {String(t("admin.rmFlagReason", { reason: review.flagReason }))}
              </Text>
            </FlagReasonBox>
          )}

          {/* Reassign venue */}
          <SectionCard>
            <XStack gap={6} alignItems="center" justifyContent="space-between">
              <XStack gap={6} alignItems="center">
                <MapPin size={14} color={theme.color?.val} />
                <Text variant="bodySmall" weight="bold">
                  {String(t("admin.rmReassignPlace"))}
                </Text>
              </XStack>
              {!showReassign && (
                <Button
                  variant="ghost"
                  size="$2"
                  onPress={() => setShowReassign(true)}
                >
                  {String(t("admin.rmReassignPlace"))}
                </Button>
              )}
            </XStack>
            <FieldRow>
              <Text
                variant="caption"
                tone="muted"
                style={{ minWidth: 140, flexShrink: 0 }}
              >
                {String(t("admin.rmReassignCurrentVenue"))}
              </Text>
              <Text variant="body" style={{ textAlign: "right", flex: 1 }}>
                {review.placeName}
              </Text>
            </FieldRow>
            {showReassign && (
              <YStack gap={8} paddingTop={4}>
                <TextInput
                  value={reassignQuery}
                  onChangeText={setReassignQuery}
                  placeholder={String(t("admin.rmReassignPlaceholder"))}
                />
                {reassignQuery.trim().length >= 2 &&
                  placeSearch.data?.places && (
                    <YStack gap={4} maxHeight={200} overflow="scroll">
                      {placeSearch.data.places
                        .filter((p) => p.placeId !== review.placeId)
                        .map((place) => (
                          <XStack
                            key={place.placeId}
                            paddingHorizontal={10}
                            paddingVertical={8}
                            gap={8}
                            alignItems="center"
                            borderWidth={1}
                            borderColor="$borderColor"
                            backgroundColor="$surfaceMuted"
                            cursor="pointer"
                            hoverStyle={{ backgroundColor: "$surface" }}
                            onPress={() => {
                              reassignMut.mutate({
                                reviewId: review.id,
                                newPlaceId: place.placeId,
                              });
                            }}
                          >
                            <ArrowRight
                              size={12}
                              color={theme.accent?.val}
                              style={{ flexShrink: 0 }}
                            />
                            <YStack flex={1} gap={2}>
                              <Text variant="body" style={{ fontWeight: 600 }}>
                                {place.name}
                              </Text>
                              {place.city && (
                                <Text variant="caption" tone="muted">
                                  {[place.city, place.region, place.countryCode]
                                    .filter(Boolean)
                                    .join(", ")}
                                </Text>
                              )}
                            </YStack>
                          </XStack>
                        ))}
                      {placeSearch.data.places.filter(
                        (p) => p.placeId !== review.placeId,
                      ).length === 0 && (
                        <Text
                          variant="caption"
                          tone="muted"
                          paddingVertical={4}
                        >
                          {none}
                        </Text>
                      )}
                    </YStack>
                  )}
                {reassignMut.isPending && (
                  <Text variant="caption" tone="muted">
                    ...
                  </Text>
                )}
                <Button
                  variant="ghost"
                  size="$2"
                  onPress={() => {
                    setShowReassign(false);
                    setReassignQuery("");
                  }}
                >
                  <X size={12} />
                  {String(t("common.cancel"))}
                </Button>
              </YStack>
            )}
          </SectionCard>

          {/* Reviewer */}
          <SectionCard>
            <XStack gap={6} alignItems="center">
              <Users size={14} color={theme.color?.val} />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.rmReviewer"))}
              </Text>
            </XStack>
            {field(
              String(t("admin.rmReviewer")),
              review.anonymousName ?? String(t("admin.rmAnonymous")),
            )}
            {review.anonymousEmail && field("Email", review.anonymousEmail)}
            {field(
              String(t("admin.rmDetailSubmitted")),
              formatDateShort(review.createdAt),
            )}
          </SectionCard>

          {/* Payment */}
          <SectionCard>
            <XStack gap={6} alignItems="center">
              <DollarSign size={14} color={theme.color?.val} />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.rmDetailPayment"))}
              </Text>
            </XStack>
            {field(
              String(t("admin.rmDetailPaymentMethod")),
              review.paymentMethod,
            )}
            {field(
              String(t("admin.rmDetailPayout")),
              fmtCents(review.payoutCents),
            )}
            {review.paymentDetail &&
              field(
                String(t("admin.rmDetailPaymentDetail")),
                review.paymentDetail,
              )}
          </SectionCard>

          {/* Promotion */}
          <SectionCard>
            <XStack gap={6} alignItems="center">
              <Megaphone size={14} color={theme.color?.val} />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.rmDetailPromotion"))}
              </Text>
            </XStack>
            {field(
              String(t("admin.rmDetailPromotionLevel")),
              review.venuePromoted,
            )}
            {review.promotionDetail &&
              field(
                String(t("admin.rmDetailPromotionDetail")),
                review.promotionDetail,
              )}
          </SectionCard>

          {/* Sound */}
          <SectionCard>
            <XStack gap={6} alignItems="center">
              <Volume2 size={14} color={theme.color?.val} />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.rmDetailSound"))}
              </Text>
            </XStack>
            {field(
              String(t("admin.rmDetailSoundQuality")),
              review.soundQuality,
            )}
            {review.soundDetail &&
              field(String(t("admin.rmDetailSoundDetail")), review.soundDetail)}
          </SectionCard>

          {/* Stage & Equipment */}
          <SectionCard>
            <XStack gap={6} alignItems="center">
              <Monitor size={14} color={theme.color?.val} />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.rmDetailStageEquipment"))}
              </Text>
            </XStack>
            {field(
              String(t("admin.rmDetailStageEquipmentRating")),
              review.stageEquipment,
            )}
            {review.stageEquipmentDetail &&
              field(
                String(t("admin.rmDetailStageEquipmentDetail")),
                review.stageEquipmentDetail,
              )}
          </SectionCard>

          {/* Audience */}
          <SectionCard>
            <XStack gap={6} alignItems="center">
              <Users size={14} color={theme.color?.val} />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.rmDetailAudience"))}
              </Text>
            </XStack>
            {field(String(t("admin.rmDetailAudienceFit")), review.audienceFit)}
            {review.audienceDetail &&
              field(
                String(t("admin.rmDetailAudienceDetail")),
                review.audienceDetail,
              )}
          </SectionCard>

          {/* Booker */}
          <SectionCard>
            <XStack gap={6} alignItems="center">
              <Star size={14} color={theme.color?.val} />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.rmDetailBooker"))}
              </Text>
            </XStack>
            {field(
              String(t("admin.rmDetailBookerRating")),
              review.bookerRating,
            )}
            {review.bookerDetail &&
              field(
                String(t("admin.rmDetailBookerDetail")),
                review.bookerDetail,
              )}
          </SectionCard>

          {/* Parking & Load-in */}
          <SectionCard>
            <XStack gap={6} alignItems="center">
              <ParkingCircle size={14} color={theme.color?.val} />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.rmDetailParking"))}
              </Text>
            </XStack>
            {field(
              String(t("admin.rmDetailParkingRating")),
              review.parkingLoadIn,
            )}
            {review.parkingDetail &&
              field(
                String(t("admin.rmDetailParkingDetail")),
                review.parkingDetail,
              )}
          </SectionCard>

          {/* General */}
          <SectionCard>
            <XStack gap={6} alignItems="center">
              <Music size={14} color={theme.color?.val} />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.rmDetailGeneral"))}
              </Text>
            </XStack>
            {field(
              String(t("admin.rmDetailWouldPlayAgain")),
              review.wouldPlayAgain,
            )}
            {field(
              String(t("admin.rmDetailEstimatedDraw")),
              review.estimatedDraw,
            )}
            {field(String(t("admin.rmDetailGenre")), review.genre)}
            {field(String(t("admin.rmDetailSource")), review.source)}
          </SectionCard>

          {/* Comment */}
          {review.comment && (
            <SectionCard>
              <XStack gap={6} alignItems="center">
                <MessageCircle size={14} color={theme.color?.val} />
                <Text variant="bodySmall" weight="bold">
                  {String(t("admin.rmDetailComment"))}
                </Text>
              </XStack>
              <Text variant="body" style={{ whiteSpace: "pre-wrap" as never }}>
                {review.comment}
              </Text>
            </SectionCard>
          )}

          {/* Venue Response */}
          <SectionCard>
            <XStack gap={6} alignItems="center">
              <MessageCircle size={14} color={theme.color?.val} />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.rmDetailResponse"))}
              </Text>
            </XStack>
            {review.responseText ? (
              <>
                <Text
                  variant="body"
                  style={{ whiteSpace: "pre-wrap" as never }}
                >
                  {review.responseText}
                </Text>
                {review.respondedAt && (
                  <Text variant="caption" tone="muted">
                    {String(t("admin.rmDetailRespondedAt"))}:{" "}
                    {formatDateShort(review.respondedAt)}
                  </Text>
                )}
              </>
            ) : (
              <Text variant="caption" tone="muted">
                {String(t("admin.rmDetailNoResponse"))}
              </Text>
            )}
          </SectionCard>
        </YStack>
      </PanelContainer>
    </>
  );
}
