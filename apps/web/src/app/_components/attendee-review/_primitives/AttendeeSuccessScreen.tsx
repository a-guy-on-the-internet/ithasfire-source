"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { Check, ArrowRight } from "lucide-react";
import { Button, Text, useTranslations } from "@th/ui";
import { YStack } from "tamagui";
import { ACCENT } from "@/lib/design-tokens";
import { SPRING_EASE } from "../_shared/tokens";

// ─────────────────────────────────────────────────────────────────────────────
// AttendeeSuccessScreen — warm, specific completion. Matches the place-review
// SuccessScreen idiom (centered check pop + warm copy + a decisive next action)
// but WITHOUT the particle confetti system: this surface is reached from a
// verified post-event prompt, so the tone is a quiet thank-you, not a party.
// ─────────────────────────────────────────────────────────────────────────────

interface AttendeeSuccessScreenProps {
  /** Slug for the "view event" link, when known. */
  eventSlug?: string | null;
  reducedMotion?: boolean;
}

export function AttendeeSuccessScreen({
  eventSlug,
  reducedMotion = false,
}: AttendeeSuccessScreenProps) {
  const t = useTranslations();

  const anim = (delay: number): CSSProperties =>
    reducedMotion
      ? {}
      : { animation: `attendeeFadeUp 400ms ${delay}ms ${SPRING_EASE} both` };

  return (
    <YStack
      alignItems="center"
      justifyContent="center"
      padding={40}
      gap={20}
      minHeight={320}
      role="status"
      aria-live="polite"
    >
      <div
        style={{
          width: 56,
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: `3px solid ${ACCENT}`,
          color: ACCENT,
          ...(reducedMotion
            ? {}
            : { animation: `attendeeSuccessPop 500ms ${SPRING_EASE}` }),
        }}
        aria-hidden="true"
      >
        <Check size={28} />
      </div>

      <Text
        variant="h3"
        weight="bold"
        color="$color"
        margin={0}
        textAlign="center"
        style={anim(180)}
      >
        {String(t("attendeeReview.success.title"))}
      </Text>

      <Text
        variant="body"
        color="$colorMuted"
        margin={0}
        textAlign="center"
        maxWidth={360}
        style={anim(300)}
      >
        {String(t("attendeeReview.success.body"))}
      </Text>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "center",
          ...anim(420),
        }}
      >
        {eventSlug ? (
          <Link href={`/events/${eventSlug}`} passHref legacyBehavior>
            <Button
              variant="primary"
              size="$4"
              asChild
              aria-label={String(t("attendeeReview.success.viewEvent"))}
            >
              <a
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  textDecoration: "none",
                }}
              >
                <Text
                  variant="bodySmall"
                  weight="bold"
                  color="$colorInverted"
                  margin={0}
                >
                  {String(t("attendeeReview.success.viewEvent"))}
                </Text>
                <ArrowRight size={16} />
              </a>
            </Button>
          </Link>
        ) : null}
        <Link href="/my-tickets" passHref legacyBehavior>
          <Button variant="ghost" size="$3" asChild>
            <a style={{ textDecoration: "none" }}>
              {String(t("attendeeReview.success.backToTickets"))}
            </a>
          </Button>
        </Link>
      </div>

      {!reducedMotion && (
        <style>{`
          @keyframes attendeeSuccessPop {
            0% { transform: scale(0); opacity: 0; }
            60% { transform: scale(1.15); opacity: 1; }
            100% { transform: scale(1); opacity: 1; }
          }
          @keyframes attendeeFadeUp {
            from { opacity: 0; transform: translateY(16px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>
      )}
    </YStack>
  );
}
