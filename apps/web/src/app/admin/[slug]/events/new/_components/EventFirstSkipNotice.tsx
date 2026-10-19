"use client";

import { ArrowRight } from "lucide-react";
import { styled, XStack, YStack } from "tamagui";

import { NextLinkAnchor, Text, useTranslations } from "@th/ui";

import { settingsSectionHref } from "@/app/account/settings/_lib/settings-routes";
import { orgSettingsSectionHref } from "@/app/admin/[slug]/settings/_lib/org-settings-routes";

import {
  eventFirstSkipVariant,
  type EventFirstSkipVariant,
  type SaveEventBookingSkip,
} from "./event-first-skip.helpers";

/**
 * "Your request wasn't sent" — the builder's account of a save whose ask the
 * venue refused (`bookingRequest.outcome === "skipped"`). The event itself
 * saved, address-only; this says so, names the venue, and says what to do.
 *
 * WHERE IT SITS. Under the cascade, in the Location field — not in the tie
 * band's slot at the top of the column. The band (`EventProvenanceNote`) is
 * PROVENANCE: where the venue's confirmation of this event stands, read back
 * from the request row on every load. A refusal leaves no row — reload the
 * page and there is nothing to report — and it is about the ask the cascade
 * just made, so it lives with the cascade and clears when the cascade's
 * inputs change (`eventFirstSkipIsCurrent`). Same aside idiom as the band
 * and `EventTimezoneNote` so it reads as the same family, not a second
 * notice system.
 *
 * A WARNING, NOT AN ERROR. The save succeeded. The leading rule is the
 * `warning` hue (a graphic — legal at the 3:1 non-text floor) on the muted
 * fill; the text stays ink. Colour is never the only signal — every variant
 * has its own sentence.
 *
 * The live region is the STATEMENT only (headline + note). The performer
 * link is a sibling outside it: a control inside a live region is
 * re-announced with every change.
 */
const SkipAside = styled(YStack, {
  gap: 8,
  paddingVertical: 12,
  paddingHorizontal: 14,
  borderRadius: 0,
  borderLeftWidth: 2,
  borderLeftColor: "$warning",
  backgroundColor: "$surfaceMuted",
});

/** Wrapper carries the 44px touch target; the anchor itself stays text-sized. */
const LinkTarget = styled(XStack, {
  alignItems: "center",
  gap: 6,
  minHeight: 44,
});

/** lucide takes a CSS colour; `accentText` because this is a control's label. */
const ARROW_COLOR = "var(--accentText, #A8300F)";

const HEADLINE_KEY: Record<EventFirstSkipVariant, string> = {
  performer: "admin.ebReqSkipPerformer",
  noHours: "admin.ebReqSkipNoHours",
  date: "admin.ebReqSkipDate",
  notTaking: "admin.ebReqSkipNotTaking",
};

const NOTE_KEY: Record<EventFirstSkipVariant, string> = {
  performer: "admin.ebReqSkipPerformerNote",
  noHours: "admin.ebReqSkipNoHoursNote",
  date: "admin.ebReqSkipDateNote",
  notTaking: "admin.ebReqSkipNotTakingNote",
};

export type EventFirstSkipNoticeProps = {
  skip: SaveEventBookingSkip;
  /** Whose performer mode the `performer` variant links to. */
  ownerType: "human" | "org";
  /** The org admin slug; without it the org link is withheld, not guessed. */
  slug?: string;
  testId?: string;
};

export function EventFirstSkipNotice({
  skip,
  ownerType,
  slug,
  testId = "event-first-skip-notice",
}: EventFirstSkipNoticeProps) {
  const t = useTranslations();
  const variant = eventFirstSkipVariant(skip);
  const place = skip.placeName ?? String(t("admin.ebReqSkipVenueFallback"));

  // Performer mode is per identity: a human's lives in account settings, an
  // org's in the org's own settings (help: "performer-mode-and-booking-requests").
  const performerHref =
    variant !== "performer"
      ? null
      : ownerType === "human"
        ? settingsSectionHref("performer")
        : slug
          ? orgSettingsSectionHref(slug, "performer")
          : null;

  return (
    <SkipAside
      data-testid={testId}
      data-code={skip.code}
      data-variant={variant}
    >
      <Text variant="overline" tone="muted">
        {String(t("admin.ebReqSkipKicker"))}
      </Text>

      <YStack
        gap={8}
        role="status"
        aria-live="polite"
        data-testid={`${testId}-status`}
      >
        {/* The venue reads first, as in the band — except when the fix is
            on the sender's side and the venue is not the subject. */}
        <Text
          variant="bodySmall"
          weight="bold"
          data-testid={`${testId}-headline`}
        >
          {String(t(HEADLINE_KEY[variant], { place }))}
        </Text>
        <Text variant="bodySmall" data-testid={`${testId}-note`}>
          {String(t(NOTE_KEY[variant]))}
        </Text>
      </YStack>

      {performerHref ? (
        <XStack flexWrap="wrap">
          <NextLinkAnchor
            href={performerHref}
            data-testid={`${testId}-performer-link`}
          >
            <LinkTarget>
              <Text
                variant="caption"
                weight="bold"
                color="$accentText"
                textTransform="uppercase"
                letterSpacing={1.2}
              >
                {String(t("admin.ebReqSkipPerformerLink"))}
              </Text>
              <ArrowRight
                size={13}
                strokeWidth={2.5}
                color={ARROW_COLOR}
                aria-hidden
              />
            </LinkTarget>
          </NextLinkAnchor>
        </XStack>
      ) : null}
    </SkipAside>
  );
}

export default EventFirstSkipNotice;
