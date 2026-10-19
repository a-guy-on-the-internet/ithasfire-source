"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import { useTranslations } from "@th/ui";

import { RateVenueModal } from "../blocks/RateVenueModal";
import placeStyles from "../place-entity.module.css";

type Props = {
  placeId: string;
  placeName: string;
};

/**
 * Venue-hero "Rate this place" CTA.
 *
 * The same entry point the optional `rate_venue` block carries, promoted into
 * the hero action row so a reader never has to scroll to find it. It is a
 * SECONDARY action — Follow and the booking CTAs keep the primary weight and
 * the reading order — so it wears the outlined grammar (`.rateButton`), never
 * an accent fill.
 *
 * The smallest possible client island: it owns nothing but the open flag, and
 * `RateVenueModal` (which pulls in tRPC + both review forms) hangs off this
 * component rather than off `PlaceHero`.
 *
 * No auth fork here on purpose. Unlike claim / report / booking, the modal
 * itself is useful signed-out — the community review path is open to guests
 * and the verified-review upsell is the only signed-in-only branch — so the
 * button is unconditionally live. `entity.id` and the display name are always
 * present in the hero, so there is no disabled path.
 */
export function HeroRateVenueButton({ placeId, placeName }: Props) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={placeStyles.rateButton}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Star size={16} aria-hidden />
        {String(t("rateVenue.cta"))}
      </button>

      <RateVenueModal
        open={open}
        onClose={() => setOpen(false)}
        placeId={placeId}
        placeName={placeName}
      />
    </>
  );
}
