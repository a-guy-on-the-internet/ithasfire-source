"use client";

import { useState } from "react";
import { useTranslations } from "@th/ui";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading } from "./block-primitives";
import { useBlockRenderMode } from "./block-render-context";
import { useBlockPageOwner } from "./block-page-owner-context";
import { RateVenueModal } from "./RateVenueModal";
import styles from "./block-primitives.module.css";

type RateVenueData = {
  heading?: string;
  intro?: string;
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Role-forked "Rate this place" entry point (venue-rating-block-and-owner-optin
 * FR-001/FR-002). Public render: a Swiss CTA that opens a modal forking the
 * performer (PlaceReview) and attendee (community + verified upsell) review
 * paths. Editor render: an owner-facing labelled placeholder — mirrors
 * RequestToPlayBlock.
 */
export function RateVenueBlock({ block }: Props) {
  const t = useTranslations();
  const mode = useBlockRenderMode();
  const data = (block.data ?? {}) as RateVenueData;

  if (mode === "editor") {
    return (
      <div className={styles.editorPlaceholder}>
        <span className={styles.editorPlaceholderLabel}>
          {String(t("admin.peBlockKindRateVenue"))}
        </span>
        <p className={styles.editorPlaceholderHint}>
          {String(t("admin.peBlockRateVenueEditorHint"))}
        </p>
      </div>
    );
  }

  const heading = data.heading?.trim() || String(t("rateVenue.blockHeading"));
  const intro = data.intro?.trim() || String(t("rateVenue.blockIntro"));

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.vStack} style={{ gap: "0.75rem" }}>
        {intro && (
          <p style={{ opacity: 0.8, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
            {intro}
          </p>
        )}
        <RateVenueCta />
      </div>
    </BlockSection>
  );
}

function RateVenueCta() {
  const t = useTranslations();
  const owner = useBlockPageOwner();
  const place = owner?.place ?? null;
  const [open, setOpen] = useState(false);

  // The block can only act when it knows which place owns the page.
  if (!place) {
    return (
      <button
        type="button"
        className={`${styles.ctaButton} ${styles.ctaButtonDisabled}`}
        disabled
        aria-disabled="true"
      >
        {String(t("rateVenue.blockCta"))}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className={styles.ctaButton}
        onClick={() => setOpen(true)}
      >
        {String(t("rateVenue.blockCta"))}
      </button>
      <RateVenueModal
        open={open}
        onClose={() => setOpen(false)}
        placeId={place.id}
        placeName={place.name}
      />
    </>
  );
}
