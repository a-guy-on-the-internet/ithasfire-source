"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Music } from "lucide-react";
import { useTranslations } from "@th/ui";

import { useSessionGate } from "@/hooks/useSessionGate";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";

import { OrganizerBookingDialog } from "../OrganizerBookingDialog";
import placeStyles from "../place-entity.module.css";

type Props = {
  /** The act being requested — always the page's owning entity. */
  performerOwnerType: "human" | "org";
  performerOwnerId: string;
  performerName: string;
};

/**
 * Performer-hero "Request to book" CTA (organizer-booking-requests FR-009) —
 * the performer sibling of `HeroBookingRequestButton`.
 *
 * Only rendered by `HumanHero` / `OrgHero` when
 * `performerAcceptsBookingRequests(entity)` is true (server double-gates:
 * performer-enabled AND opted in). When it renders it is the page's single
 * primary booking affordance — HumanHero suppresses its scroll-to-contact
 * Booking button in its favour.
 *
 * Viewer states mirror the venue hero CTA exactly:
 *  - signed out → the button opens the in-place sign-in overlay
 *    (`showSignInOverlay`) with the CURRENT page as the redirect target, so no
 *    navigation happens — the reactive `authClient.useSession()` flips this
 *    button to its signed-in state as soon as the overlay completes;
 *  - signed in → the button opens `OrganizerBookingDialog` (sender-org gate →
 *    request form → success).
 */
export function HeroPerformerBookingButton({
  performerOwnerType,
  performerOwnerId,
  performerName,
}: Props) {
  const t = useTranslations();
  const pathname = usePathname();
  const { isSignedIn, isPending } = useSessionGate();
  const { showSignInOverlay } = useAppOverlay();

  const [open, setOpen] = useState(false);

  // One string drives the visible label, the accessible name, and the dialog
  // title so they always match.
  const label = String(t("profileStd.requestToBookCta"));

  if (!isSignedIn && !isPending) {
    return (
      <button
        type="button"
        className={placeStyles.bookingButton}
        onClick={() => showSignInOverlay({ redirect: pathname ?? "/" })}
      >
        <Music size={16} aria-hidden />
        {label}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className={placeStyles.bookingButton}
        disabled={isPending}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Music size={16} aria-hidden />
        {label}
      </button>

      <OrganizerBookingDialog
        open={open}
        onClose={() => setOpen(false)}
        performerOwnerType={performerOwnerType}
        performerOwnerId={performerOwnerId}
        performerName={performerName}
        title={label}
      />
    </>
  );
}
