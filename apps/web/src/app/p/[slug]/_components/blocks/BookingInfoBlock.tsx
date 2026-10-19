"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { DoorOpen, Music } from "lucide-react";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import { useTranslations } from "@th/ui";

import { useSessionGate } from "@/hooks/useSessionGate";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";

import { BlockSection, BlockHeading } from "./block-primitives";
import { useBlockPageOwner } from "./block-page-owner-context";
import { BookingRequestDialog } from "../BookingRequestDialog";
import type { BookingCta, BookingIntent } from "./request-to-play-form.helpers";
import { useBookingCtas } from "./use-place-booking-options";
import {
  getSafeExternalHref,
  getSafeMailtoHref,
  getSafeTelHref,
} from "./safe-block-url";
import styles from "./block-primitives.module.css";

type BookingInfoData = {
  heading?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
  bookingUrl?: string;
};

type Props = {
  block: PageBlockRecord;
};

/**
 * In-app booking-request buttons for the `booking_info` block.
 *
 * Only rendered on a VENUE page that is verified AND accepting requests, so
 * they open the SAME shared `BookingRequestDialog` the venue hero uses. Two
 * at most (venue-confirmation-and-booking-intents spec): "Play here" when
 * some calendar takes pitches, "Rent or use a space" when some calendar
 * rents or lends a room — each opens the one dialog with its intent
 * preselected. The first is the filled `.ctaButton`, the second outlined
 * (`.ctaButtonSecondary`) so the block keeps one primary. Leading icons mark
 * the object per the icon grammar.
 *
 * Auth handling mirrors `HeroBookingRequestButton`: signed-out opens the
 * in-place sign-in overlay (redirect = current page, so no navigation — the
 * reactive session flips the buttons once the overlay completes); signed-in
 * opens the dialog.
 */
function BlockBookingRequestButtons({
  placeId,
  placeName,
}: {
  placeId: string;
  placeName: string;
}) {
  const t = useTranslations();
  const pathname = usePathname();
  const { isSignedIn, isPending } = useSessionGate();
  const { showSignInOverlay } = useAppOverlay();
  const ctas = useBookingCtas(placeId);
  const [openIntent, setOpenIntent] = useState<BookingIntent | null>(null);

  // The dialog's title stays the neutral "Request to book" — it hosts both
  // intents — while each trigger names its own.
  const title = String(t("places.heroRequestToBookCta"));
  const labelFor = (cta: BookingCta) =>
    String(
      t(cta.kind === "play" ? "places.heroPlayHereCta" : "places.heroRentOrUseCta"),
    );

  if (ctas.length === 0) return null;

  const signedOut = !isSignedIn && !isPending;

  return (
    <div className={styles.hStack} style={{ gap: "0.5rem", flexWrap: "wrap" }}>
      {ctas.map((cta, index) => {
        const Icon = cta.kind === "play" ? Music : DoorOpen;
        const className =
          index === 0
            ? styles.ctaButton
            : `${styles.ctaButton} ${styles.ctaButtonSecondary}`;
        if (signedOut) {
          return (
            <button
              key={cta.kind}
              type="button"
              className={className}
              onClick={() => showSignInOverlay({ redirect: pathname ?? "/" })}
            >
              <Icon size={16} aria-hidden />
              {labelFor(cta)}
            </button>
          );
        }
        return (
          <button
            key={cta.kind}
            type="button"
            className={className}
            disabled={isPending}
            aria-haspopup="dialog"
            onClick={() => setOpenIntent(cta.intent)}
          >
            <Icon size={16} aria-hidden />
            {labelFor(cta)}
          </button>
        );
      })}

      {!signedOut && (
        <BookingRequestDialog
          open={openIntent !== null}
          onClose={() => setOpenIntent(null)}
          placeId={placeId}
          placeName={placeName}
          title={title}
          intent={openIntent}
        />
      )}
    </div>
  );
}

/**
 * Renders booking information for the page owner.
 *
 * On a VENUE (PLACE) page that is accepting booking requests this pairs an
 * in-app "Request to book" button (opening the shared `BookingRequestDialog`,
 * the same dialog the hero uses) with the owner's email/phone shown as a
 * direct-contact fallback beneath it.
 *
 * On HUMAN / ORG pages — and on venues that aren't accepting requests — it
 * renders booking CONTACT only (email/phone/notes + any external `bookingUrl`).
 * There is deliberately NO in-app button for HUMAN/ORG owners: booking requests
 * only target VENUES today (a performer requests to play AT a venue), so there
 * is no "book this act" target. An in-app "book this act" flow for performer/org
 * targets is a separate future flow.
 */
export function BookingInfoBlock({ block }: Props) {
  const t = useTranslations();
  const owner = useBlockPageOwner();
  const place = owner?.place ?? null;
  const isVenue = Boolean(place);

  const data = block.data as BookingInfoData | undefined;
  if (!data) return null;
  const heading = data.heading ?? String(t("bookingInfo.heading"));
  const emailHref = getSafeMailtoHref(data.contactEmail);
  const phoneHref = getSafeTelHref(data.contactPhone);
  const bookingHref = getSafeExternalHref(data.bookingUrl);
  const bookingCtaLabel = isVenue
    ? t("bookingInfo.bookVenueCta")
    : t("bookingInfo.bookArtistCta");

  // In-app booking requests only target verified, opted-in VENUES.
  const canRequestInApp = Boolean(place?.acceptsRequests);
  const hasContact = Boolean(
    emailHref || phoneHref || data.notes || bookingHref,
  );

  // Nothing to show: no contact details AND (for venues) no request capability.
  if (!hasContact && !canRequestInApp) {
    return null;
  }

  const contactRows = (emailHref || phoneHref) && (
    <div className={styles.vStack} style={{ gap: "0.5rem" }}>
      {emailHref && data.contactEmail && (
        <div>
          <span className={styles.muted} style={{ marginRight: "0.5rem" }}>
            {t("bookingInfo.emailLabel")}:
          </span>
          <a
            href={emailHref}
            style={{
              color: "var(--th-color-primary, inherit)",
              textDecoration: "none",
              // An address is one unbreakable token — long ones ran off a
              // 320px screen and took the page's horizontal scroll with them.
              overflowWrap: "anywhere",
            }}
          >
            {data.contactEmail}
          </a>
        </div>
      )}
      {phoneHref && data.contactPhone && (
        <div>
          <span className={styles.muted} style={{ marginRight: "0.5rem" }}>
            {t("bookingInfo.phoneLabel")}:
          </span>
          <a
            href={phoneHref}
            style={{
              color: "var(--th-color-primary, inherit)",
              textDecoration: "none",
              // An address is one unbreakable token — long ones ran off a
              // 320px screen and took the page's horizontal scroll with them.
              overflowWrap: "anywhere",
            }}
          >
            {data.contactPhone}
          </a>
        </div>
      )}
    </div>
  );

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div
        className={styles.vStack}
        style={{ gap: "0.75rem", fontSize: "0.9375rem" }}
      >
        {/* Primary CTA(s) first (venue, accepting requests). */}
        {canRequestInApp && place && (
          <BlockBookingRequestButtons
            placeId={place.id}
            placeName={place.name}
          />
        )}

        {/* Direct-contact fallback. When the request button leads, label the
            group so it reads as "or reach us directly". */}
        {contactRows && (
          <div className={styles.vStack} style={{ gap: "0.375rem" }}>
            {canRequestInApp && (
              <span className={styles.muted} style={{ fontSize: "0.8125rem" }}>
                {t("places.contact")}
              </span>
            )}
            {contactRows}
          </div>
        )}

        {data.notes && (
          <p style={{ opacity: 0.8, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
            {data.notes}
          </p>
        )}

        {/* External booking page. When the in-app button is the primary CTA the
            external link demotes to a plain accent text link so two filled
            primaries never compete; otherwise it keeps the .ctaButton treatment
            as the block's sole action. */}
        {bookingHref &&
          (canRequestInApp ? (
            <a
              href={bookingHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: "var(--th-color-primary, inherit)",
                fontWeight: 600,
                fontSize: "0.875rem",
                textDecoration: "none",
                width: "fit-content",
              }}
            >
              {bookingCtaLabel} &#8599;
            </a>
          ) : (
            <a
              href={bookingHref}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.ctaButton}
            >
              {bookingCtaLabel} &#8599;
            </a>
          ))}
      </div>
    </BlockSection>
  );
}
