"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Mic, Users, X } from "lucide-react";
import { BottomSheet, Modal, Text, useTranslations } from "@th/ui";
import { styled, XStack, YStack, useMedia } from "tamagui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { PlaceReviewForm } from "@/app/_components/place-review";
import { CommunityVenueReviewForm } from "@/app/_components/community-venue-review";

// ─────────────────────────────────────────────────────────────────────────────
// RateVenueModal (venue-rating-block-and-owner-optin FR-002/FR-003)
//
// The on-page "Rate this place" experience. Opens a role fork — performer vs
// attendee — and hosts the matching conversational form INLINE (no page nav).
//   Performer → the existing PlaceReviewForm (embedded, seeded with this place).
//   Attendee  → the always-available community review (FR-009), plus a verified
//               event-review upsell when a signed-in viewer has an eligible show
//               here (getPlaceReviewOptions).
//
// Desktop → centered Modal; mobile → full-height BottomSheet. Both DS primitives
// handle focus trap, Esc, scroll-lock and focus restore. The hosted forms run
// "chromeless" so the panel owns the single card frame (no nested cards).
// ─────────────────────────────────────────────────────────────────────────────

type View = "choose" | "performer" | "attendee";

export interface RateVenueModalProps {
  open: boolean;
  onClose: () => void;
  placeId: string;
  placeName: string;
}

// A large, strict-Swiss role choice: bordered, radius 0, decisive hover.
const ChoiceButton = styled(XStack, {
  name: "RateVenueChoice",
  tag: "button",
  cursor: "pointer",
  alignItems: "center",
  gap: "$3",
  padding: "$4",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
  hoverStyle: { backgroundColor: "$surfaceOverlay", borderColor: "$color" },
  pressStyle: { opacity: 0.9 },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },
});

export function RateVenueModal({
  open,
  onClose,
  placeId,
  placeName,
}: RateVenueModalProps) {
  const t = useTranslations();
  const media = useMedia();
  const isMobile = media.sm;

  const [view, setView] = useState<View>("choose");

  // Reset to the fork each time the modal (re)opens.
  useEffect(() => {
    if (open) setView("choose");
  }, [open]);

  const session = authClient.useSession();
  const isSignedIn = Boolean(session.data?.user);

  // Verified-review upsell — only meaningful for a signed-in attendee.
  const optionsQuery = trpc.attendeeReviews.getPlaceReviewOptions.useQuery(
    { placeId },
    {
      enabled: open && view === "attendee" && isSignedIn,
      staleTime: 60_000,
      retry: false,
    },
  );
  const eligibleEvents = optionsQuery.data?.eligibleEvents ?? [];

  const isForm = view !== "choose";
  const title =
    view === "choose"
      ? String(t("rateVenue.modalTitle"))
      : view === "performer"
        ? String(t("rateVenue.performerChoice"))
        : String(t("rateVenue.attendeeChoice"));

  const header = (
    <XStack
      alignItems="center"
      gap="$2"
      paddingHorizontal="$4"
      paddingVertical="$3"
      borderBottomWidth={2}
      borderBottomColor="$borderColor"
    >
      {isForm ? (
        <XStack
          tag="button"
          aria-label={String(t("rateVenue.back"))}
          cursor="pointer"
          alignItems="center"
          gap="$1"
          paddingVertical="$1"
          paddingHorizontal="$2"
          marginLeft="$-2"
          borderRadius={0}
          backgroundColor="transparent"
          borderWidth={0}
          hoverStyle={{ backgroundColor: "$surfaceOverlay" }}
          onPress={() => setView("choose")}
        >
          <ArrowLeft size={18} color="var(--color)" />
          <Text variant="bodySmall" weight="bold">
            {String(t("rateVenue.back"))}
          </Text>
        </XStack>
      ) : null}
      <Text
        variant="subtitle"
        weight="bold"
        flex={1}
        style={{
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {title}
      </Text>
      <XStack
        tag="button"
        aria-label="Close"
        cursor="pointer"
        padding="$1.5"
        borderRadius={0}
        backgroundColor="transparent"
        borderWidth={0}
        hoverStyle={{ backgroundColor: "$surfaceOverlay" }}
        onPress={onClose}
      >
        <X size={20} color="var(--color)" />
      </XStack>
    </XStack>
  );

  let body: ReactNode;
  if (view === "choose") {
    body = (
      <YStack padding="$5" gap="$4">
        <Text variant="body" tone="muted">
          {String(t("rateVenue.choosePrompt"))}
        </Text>
        <ChoiceButton onPress={() => setView("performer")}>
          <Mic size={22} color="var(--accent, #E2481D)" />
          <YStack flex={1} gap="$1">
            <Text variant="body" weight="bold">
              {String(t("rateVenue.performerChoice"))}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(t("rateVenue.performerChoiceHint"))}
            </Text>
          </YStack>
          <ArrowRight size={18} color="var(--colorMuted, #5C544A)" />
        </ChoiceButton>
        <ChoiceButton onPress={() => setView("attendee")}>
          <Users size={22} color="var(--accent, #E2481D)" />
          <YStack flex={1} gap="$1">
            <Text variant="body" weight="bold">
              {String(t("rateVenue.attendeeChoice"))}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(t("rateVenue.attendeeChoiceHint"))}
            </Text>
          </YStack>
          <ArrowRight size={18} color="var(--colorMuted, #5C544A)" />
        </ChoiceButton>
      </YStack>
    );
  } else if (view === "performer") {
    body = (
      <YStack flex={1} minHeight={0}>
        <PlaceReviewForm
          variant="embedded"
          chromeless
          prefill={{ placeId, placeName }}
        />
      </YStack>
    );
  } else {
    body = (
      <YStack flex={1} minHeight={0} overflow="hidden">
        {eligibleEvents.length > 0 ? (
          <VerifiedUpsell events={eligibleEvents} />
        ) : null}
        <YStack flex={1} minHeight={0}>
          <CommunityVenueReviewForm placeId={placeId} chromeless />
        </YStack>
      </YStack>
    );
  }

  const inner = (
    <YStack flex={1} minHeight={0} width="100%">
      {header}
      {body}
    </YStack>
  );

  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={onClose}>
        <BottomSheet.Panel maxHeightVh={isForm ? 94 : 70} padding={0}>
          {inner}
        </BottomSheet.Panel>
      </BottomSheet>
    );
  }

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel
        width={isForm ? 640 : 460}
        padding={0}
        {...(isForm
          ? {
              // Size to content like the role fork and the standalone card:
              // a stable compact card (min) that caps and scrolls internally
              // for the long performer flow (max), instead of a fixed
              // full-viewport height that leaves a void under short screens.
              minHeight: "min(480px, 70vh)",
              maxHeight: "min(680px, 85vh)",
            }
          : {})}
      >
        {inner}
      </Modal.Panel>
    </Modal>
  );
}

// ── Verified-review upsell (FR-003) ─────────────────────────────────────────

function VerifiedUpsell({
  events,
}: {
  events: ReadonlyArray<{ eventId: string; title: string; date: Date }>;
}) {
  const t = useTranslations();
  const single = events.length === 1;

  return (
    <YStack
      gap="$3"
      padding="$4"
      margin="$4"
      marginBottom={0}
      borderWidth={2}
      borderColor="$accent"
      backgroundColor="$surface"
    >
      <Text
        variant="bodySmall"
        weight="bold"
        style={{ textTransform: "uppercase" }}
      >
        {String(t("rateVenue.verifiedUpsellTitle"))}
      </Text>
      <Text variant="bodySmall" tone="muted">
        {single
          ? String(
              t("rateVenue.verifiedUpsellBodyOne", { title: events[0]!.title }),
            )
          : String(t("rateVenue.verifiedUpsellBodyMany"))}
      </Text>
      <YStack gap="$2">
        {events.map((ev) => (
          <a
            key={ev.eventId}
            href={`/review-event/${ev.eventId}`}
            style={{ textDecoration: "none" }}
          >
            <XStack
              alignItems="center"
              gap="$2"
              paddingVertical="$2"
              paddingHorizontal="$3"
              borderWidth={2}
              borderColor="$borderColor"
              backgroundColor="$surface"
              hoverStyle={{ backgroundColor: "$surfaceOverlay" }}
            >
              <Text
                variant="bodySmall"
                weight="bold"
                flex={1}
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {single ? String(t("rateVenue.verifiedUpsellCta")) : ev.title}
              </Text>
              <ArrowRight size={16} color="var(--accent, #E2481D)" />
            </XStack>
          </a>
        ))}
      </YStack>
      <Text variant="caption" tone="muted">
        {String(t("rateVenue.orCommunity"))}
      </Text>
    </YStack>
  );
}
