"use client";

import { useCallback, useState } from "react";
import { usePathname } from "next/navigation";
import { DoorOpen, Music } from "lucide-react";
import { useTranslations } from "@th/ui";

import { useSessionGate } from "@/hooks/useSessionGate";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { usePagePrimaryAction } from "@/components/navigation/page-primary-action";

import { BookingRequestDialog } from "../BookingRequestDialog";
import type {
  BookingCta,
  BookingIntent,
} from "../blocks/request-to-play-form.helpers";
import { useBookingCtas } from "../blocks/use-place-booking-options";
import placeStyles from "../place-entity.module.css";

type Props = {
  placeId: string;
  placeName: string;
};

/**
 * Venue-hero booking CTAs (standard PLACE template).
 *
 * Only rendered by `PlaceHero` when the venue is verified AND accepting booking
 * requests — the same gate `EntityPageShell` uses to admit the in-column
 * `request_to_play` block, kept in sync so the two surfaces never diverge. On
 * the standard template the in-column block is suppressed, so this is the sole
 * booking surface.
 *
 * Two buttons at most (venue-confirmation-and-booking-intents spec): "Play
 * here" when some calendar takes pitches, "Rent or use a space" when some
 * calendar rents or lends a room. The first is the filled primary, the second
 * outlined — one primary per viewport. Both open the ONE `BookingRequestDialog`
 * with their intent preselected.
 *
 * Viewer states mirror the block CTA:
 *  - signed out → the button opens the in-place sign-in overlay
 *    (`showSignInOverlay`, same pattern as checkout / saved / my-rsvps) with
 *    the CURRENT page as the redirect target, so no navigation happens — the
 *    reactive `authClient.useSession()` flips this button to its signed-in
 *    state as soon as the overlay completes (on narrow viewports the overlay
 *    provider itself falls back to the standalone /sign-in page);
 *  - signed in → the button opens the shared dialog.
 */
export function HeroBookingRequestButton({ placeId, placeName }: Props) {
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
  // `BookingInfoBlock` renders the SAME two CTAs further down the page with
  // the same visible text, so a screen reader listing the page's controls
  // heard "Play here" twice with nothing to tell them apart. The hero names
  // the venue; the block's sit under a visible Booking heading that already
  // supplies that context. Each string begins with the visible label verbatim
  // (WCAG 2.5.3 Label in Name), so speech input still matches what is on
  // screen.
  const ariaLabelFor = (cta: BookingCta) =>
    String(
      t(
        cta.kind === "play"
          ? "places.heroPlayHereCtaAria"
          : "places.heroRentOrUseCtaAria",
        { name: placeName },
      ),
    );

  // ── Mobile bottom-nav primary ────────────────────────────────────────────
  // Below 960px the shell's bottom bar carries ONE page action. Registered
  // from HERE, not from PlaceHero, so it inherits this component's own gate
  // exactly. With two CTAs the bar keeps the neutral title and the dialog
  // opens on its default intent; with one, the bar names that one.
  const first = ctas[0];
  const openBooking = useCallback(() => {
    if (!isSignedIn) {
      showSignInOverlay({ redirect: pathname ?? "/" });
      return;
    }
    setOpenIntent(ctas.length === 1 && first ? first.intent : "PERFORM");
  }, [isSignedIn, pathname, showSignInOverlay, ctas.length, first]);

  usePagePrimaryAction({
    label: ctas.length === 1 && first ? labelFor(first) : title,
    // The bar is a MIRROR of the chip above, so it takes the chip's qualified
    // name — otherwise the page carries "Play here" twice, once here and once
    // on `BookingInfoBlock`'s copy, with nothing to tell them apart.
    //
    // Only in the single-CTA case. With two, the bar falls back to the neutral
    // "Request to book", which nothing else on the page is called, so there is
    // no collision to resolve and qualifying it would just be noise.
    ariaLabel:
      ctas.length === 1 && first ? ariaLabelFor(first) : undefined,
    onPress: openBooking,
    // While the session is still resolving the inline button is disabled, so
    // the bar's copy stays absent rather than shipping a dead square. No CTA
    // at all (claimed venue opted out) → nothing to register.
    enabled: !isPending && ctas.length > 0,
  });

  if (ctas.length === 0) return null;

  const signedOut = !isSignedIn && !isPending;

  return (
    <>
      {ctas.map((cta, index) => {
        const Icon = cta.kind === "play" ? Music : DoorOpen;
        const className =
          index === 0
            ? placeStyles.bookingButton
            : `${placeStyles.bookingButton} ${placeStyles.bookingButtonSecondary}`;
        // Signed out: match the block — open the sign-in card in place.
        // Redirect targets the CURRENT page so a successful sign-in closes the
        // overlay without navigating; the session updates reactively and the
        // (now signed-in) user presses the button again to open the dialog.
        if (signedOut) {
          return (
            <button
              key={cta.kind}
              type="button"
              className={className}
              aria-label={ariaLabelFor(cta)}
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
            aria-label={ariaLabelFor(cta)}
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
    </>
  );
}
