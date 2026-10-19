"use client";

import { useCallback, useState } from "react";
import { Music, Music2 } from "lucide-react";
import type {
  EntityPageRecord,
  EntitySummary,
} from "@th/types/repos/entity-pages";
import { performerAcceptsBookingRequests } from "@th/types/repos/entity-pages";
import { isHumanJob } from "@th/core/lib/human-jobs";
import { useTranslations } from "@th/ui";
import { JOB_LABEL_KEYS } from "@/lib/human-job-i18n";

import { FollowButton } from "../FollowButton";
import { getInitials } from "./EntityMedia";
import { HeroPerformerBookingButton } from "./HeroPerformerBookingButton";
import { ProfileShareButton } from "../ProfileShareButton";
import { EntityHeroActions } from "../EntityHeroActions";
import placeStyles from "../place-entity.module.css";

type HumanEntity = Extract<EntitySummary, { type: "HUMAN" }>;

type Props = {
  page: EntityPageRecord;
  entity: HumanEntity;
  /** Genre chips resolved by the layout (block tags, else settings fallback). */
  genres: string[];
  /** DOM id of the footer "Connect & booking" section the Booking CTA scrolls to. */
  bookingAnchorId: string;
  /**
   * Whether the footer booking section will render an actionable contact means
   * (email / phone / booking URL). The Booking CTA only shows when true, so it
   * never scrolls to a section that cannot help the visitor.
   */
  hasBooking: boolean;
};

/** A resolved role chip: either a localized job label key or literal text. */
type RoleChip = { key: string; labelKey?: string; text?: string };

/** Free-text OTHER descriptions get clamped so a chip never eats the rail. */
const OTHER_CHIP_MAX_CHARS = 32;

function truncateChipText(text: string): string {
  const chars = [...text];
  if (chars.length <= OTHER_CHIP_MAX_CHARS) return text;
  return `${chars
    .slice(0, OTHER_CHIP_MAX_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * Derive up to two role chips from the human's self-declared jobs (settings).
 * Enum jobs map to the shared localized label keys; `OTHER` renders the
 * owner's free-text description (truncated) and is skipped when that text is
 * absent, letting the next declared job take the slot. Unknown values are
 * ignored. An empty result means the caller should fall back to the generic
 * "Artist" chip so pre-existing pages render exactly as before.
 */
export function deriveRoleChips(
  jobs: readonly string[] | undefined,
  otherJobDescription: string | null | undefined,
): RoleChip[] {
  const chips: RoleChip[] = [];
  for (const job of jobs ?? []) {
    if (chips.length >= 2) break;
    if (!isHumanJob(job)) continue;
    if (job === "OTHER") {
      const description = otherJobDescription?.trim();
      if (!description) continue;
      chips.push({ key: job, text: truncateChipText(description) });
    } else {
      chips.push({ key: job, labelKey: JOB_LABEL_KEYS[job] });
    }
  }
  return chips;
}

/** Only treat a banner/avatar URL as usable when it is a real http(s)/data URL. */
function usableImageUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("data:")
  ) {
    return trimmed;
  }
  return undefined;
}

/**
 * Musician / artist hero for the HUMAN standard template. Mirrors PlaceHero's
 * structure (full-bleed banner, bottom-up scrim, straddling avatar, identity
 * overlay) but leads its action row with the primary Follow CTA — the dominant
 * action on a performer page — followed by Share.
 *
 * The at-a-glance rail leads with role chips derived from the human's declared
 * jobs (falling back to the generic "Artist" label when none are set), followed
 * by genre chips resolved by the layout (block tags win; settings fall back).
 */
export function HumanHero({
  page,
  entity,
  genres,
  bookingAnchorId,
  hasBooking,
}: Props) {
  const t = useTranslations();
  const displayName = page.displayName ?? entity.name ?? page.slug ?? "";
  const initials = displayName ? getInitials(displayName) : "";

  const bannerUrl = usableImageUrl(page.bannerUrl);
  const avatarUrl = usableImageUrl(page.avatarUrl);
  const [bannerLoaded, setBannerLoaded] = useState(false);
  const [avatarLoaded, setAvatarLoaded] = useState(false);

  const roleChips = deriveRoleChips(entity.jobs, entity.otherJobDescription);

  // "Request to book" gate (organizer-booking-requests FR-009): the server
  // sets `acceptsBookingRequests` only when the human is performer-enabled
  // AND opted in. When the CTA renders it REPLACES the scroll-to-contact
  // Booking button below — one primary booking affordance per page.
  const canRequestToBook = performerAcceptsBookingRequests(entity);

  // Smooth-scroll to the footer booking section, honouring reduced motion, and
  // move focus there (the section carries tabIndex={-1}) so keyboard / SR
  // context follows the jump instead of staying stranded in the hero.
  const onBookingClick = useCallback(() => {
    const target = document.getElementById(bookingAnchorId);
    if (!target) return;
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    target.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
    target.focus({ preventScroll: true });
  }, [bookingAnchorId]);

  return (
    <>
      <div className={placeStyles.heroFrame}>
        <div className={placeStyles.hero}>
          <div className={placeStyles.heroFallback} aria-hidden />
          {bannerUrl && (
            <img
              src={bannerUrl}
              alt=""
              className={placeStyles.heroImg}
              data-loaded={bannerLoaded ? "true" : "false"}
              ref={(node) => {
                if (node?.complete && node.naturalWidth > 0)
                  setBannerLoaded(true);
              }}
              onLoad={(e) => {
                if (e.currentTarget.naturalWidth > 0) setBannerLoaded(true);
              }}
              onError={() => setBannerLoaded(false)}
            />
          )}
          <div className={placeStyles.heroScrim} aria-hidden />
        </div>

        <div className={placeStyles.heroOverlay}>
          <div className={placeStyles.avatarWrap}>
            <span className={placeStyles.avatarInitials} aria-hidden>
              {initials || "•"}
            </span>
            {avatarUrl && (
              <img
                src={avatarUrl}
                alt=""
                className={placeStyles.avatarImg}
                data-loaded={avatarLoaded ? "true" : "false"}
                ref={(node) => {
                  if (node?.complete && node.naturalWidth > 0)
                    setAvatarLoaded(true);
                }}
                onLoad={(e) => {
                  if (e.currentTarget.naturalWidth > 0) setAvatarLoaded(true);
                }}
                onError={() => setAvatarLoaded(false)}
              />
            )}
          </div>

          <div className={placeStyles.heroIdentity}>
            <h1 className={placeStyles.displayName}>{displayName}</h1>

            <div className={placeStyles.chipStrip}>
              {roleChips.length === 0 ? (
                // No declared jobs — keep the pre-existing generic chip.
                <span className={placeStyles.chip}>
                  <Music2
                    size={15}
                    className={placeStyles.chipIcon}
                    aria-hidden
                  />
                  {t("profileStd.artistLabel")}
                </span>
              ) : (
                roleChips.map((chip, index) => (
                  <span key={chip.key} className={placeStyles.chip}>
                    {index === 0 && (
                      <Music2
                        size={15}
                        className={placeStyles.chipIcon}
                        aria-hidden
                      />
                    )}
                    {chip.labelKey ? t(chip.labelKey) : chip.text}
                  </span>
                ))
              )}
              {genres.map((genre) => (
                <span key={genre} className={placeStyles.chip}>
                  {genre}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className={placeStyles.heroBelow}>
        {page.bio && <p className={placeStyles.bio}>{page.bio}</p>}

        <div className={placeStyles.heroActions}>
          {/* Primary booking CTA leads the row (same placement grammar as
              PlaceHero) — the shared `.bookingButton ~ .followWrap` rule
              demotes Follow to the secondary outline automatically. */}
          {canRequestToBook && (
            <HeroPerformerBookingButton
              performerOwnerType="human"
              performerOwnerId={entity.id}
              performerName={displayName}
            />
          )}
          <FollowButton entityPageId={page.id} variant="primary" />
          {/* Secondary (outlined) booking jump — mirrors OrgHero's Contact CTA
              so Follow stays the row's single accent-filled primary. Suppressed
              whenever the Request-to-book CTA renders (FR-009: one primary
              booking affordance); it remains for contact-info-only pages. */}
          {!canRequestToBook && hasBooking && (
            <button
              type="button"
              className={placeStyles.directionsButton}
              onClick={onBookingClick}
              aria-label={String(t("profileStd.bookingCtaAria"))}
            >
              <Music size={16} aria-hidden />
              {t("profileStd.bookingCta")}
            </button>
          )}
          <ProfileShareButton
            title={displayName || String(t("profileStd.artistLabel"))}
          />
          {/* Copy link + Report — the actions with no other home on the page.
              Last in the row so the booking / follow primaries lead. */}
          <EntityHeroActions
            subjectType="HUMAN"
            subjectId={entity.id}
            subjectName={displayName}
          />
        </div>
      </div>
    </>
  );
}
