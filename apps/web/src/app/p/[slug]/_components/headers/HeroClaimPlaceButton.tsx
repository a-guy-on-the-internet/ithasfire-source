"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { BadgeCheck } from "lucide-react";
import { useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { useSessionGate } from "@/hooks/useSessionGate";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { ClaimVenueWizard } from "@/components/places/claim";
import placeStyles from "../place-entity.module.css";

type Props = {
  /** The Place id: claim subject AND eligibility query key. */
  placeId: string;
  placeName: string;
  /**
   * Server-known claimability, used only until the eligibility query answers.
   * Callers pass the PLACE entity summary's `claimable`, which the page loader
   * computes with the same claim-state rule as `getPlaceClaimEligibility`
   * (`resolvePlaceClaimState`), so the two agree on first paint.
   */
  initiallyClaimable: boolean;
};

/**
 * The eligibility the wizard was (or will be) opened with. Captured from the
 * last `claimable` answer so the wizard outlives the refetch its own success
 * triggers.
 */
type WizardEligibility = {
  placeId: string;
  domainProofAvailable: boolean;
  fastTrackEligible: boolean;
};

/**
 * Place-hero "Claim this place" chip.
 *
 * Claiming used to be the third item inside the hero's `⋯` overflow, behind
 * Share and Copy link. Hundreds of places were imported without an owner, and
 * claiming is how their operators take them over; it is also the only way out
 * for an unclaimed page that cannot list its events. So while a place is
 * claimable the entry point sits in the action row itself, and it is NOT in
 * the overflow as well (one home, not two).
 *
 * Prominence follows ownership: the chip renders only while
 * `getPlaceClaimEligibility` says `claimable` (a viewer-independent state).
 * Claimed, pending and not-eligible pages show nothing here; "Request
 * transfer" stays in `PlaceHeroActions`.
 *
 * Secondary weight: the outlined `.rateButton` grammar, never an accent fill,
 * so Follow / booking keep the single primary.
 *
 * No layout shift. The eligibility query is client-fetched, so a chip that
 * popped in after load would reflow the row (the site has a CLS-at-320px
 * history). Until the query answers, the chip follows `initiallyClaimable`:
 * the entity summary's server-computed `claimable`, decided by the same helper
 * as the query, so the chip neither flashes in on a claimed place nor vanishes
 * on a claimable one. Once data arrives it follows `state === "claimable"`. If
 * the query fails the chip hides: the wizard needs eligibility data to run.
 *
 * Auth matches the sibling `HeroBookingRequestButton` (`useSessionGate`):
 * while the session resolves, and on the server render, the chip is disabled,
 * so a signed-in user's early press never lands on the sign-in card and the
 * server and first client render agree. Signed out, it opens the sign-in card
 * in place (redirect = this page, no navigation). Signed in, it opens
 * `ClaimVenueWizard`.
 *
 * A signed-in press made before eligibility has loaded is recorded as an
 * intent for THIS `placeId` and consumed exactly once, by the first answer:
 * `claimable` opens the wizard; any other answer, a failed query, or a
 * different `placeId` (client navigation reusing this instance) drops it. A
 * later flip to `claimable` (refetch on focus) therefore never opens the wizard
 * unprompted.
 *
 * The wizard stays mounted while it is open, whatever the chip shows. Its
 * success screen ("claim submitted", or the fast-track "you now own this
 * place" with the community-listing switch) calls `onClaimed`, which refetches
 * eligibility; the answer flips to `pending` / `already_claimed` and the chip
 * hides, but the wizard keeps running on the eligibility captured when it
 * opened until the person closes it. After that close the chip is gone, so the
 * Modal's return-focus target is a detached node: `focus()` on it is a no-op
 * and focus would fall to the document body (WCAG 2.4.3). So on that close we
 * move focus to the page's `<h1>` ourselves, from an effect: the Modal lifts
 * the background's `inert` in its own (child) effect cleanup, which runs before
 * ours, whereas `onClose` fires while the page is still inert. The `⋯` trigger
 * lives in a sibling component with no stable handle, so the heading it is.
 *
 * The query key and options match `PlaceHeroActions` / `ClaimVenueCta`, so
 * React Query dedupes them into one request.
 */
export function HeroClaimPlaceButton({
  placeId,
  placeName,
  initiallyClaimable,
}: Props) {
  const t = useTranslations();
  const pathname = usePathname();
  const { isSignedIn, isPending } = useSessionGate();
  const { showSignInOverlay } = useAppOverlay();

  // Keyed by placeId, so a client navigation that reuses this instance can
  // never carry an open wizard or a pending press to another place.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [pressedFor, setPressedFor] = useState<string | null>(null);
  const [captured, setCaptured] = useState<WizardEligibility | null>(null);

  const eligibilityQuery = trpc.places.getPlaceClaimEligibility.useQuery(
    { placeId },
    { staleTime: 30_000, retry: false, meta: { silent: true } },
  );
  const eligibility = eligibilityQuery.data;
  const isError = eligibilityQuery.isError;
  const claimableNow = eligibility?.state === "claimable" ? eligibility : null;
  const wizardOpen = openFor === placeId;

  const visible = eligibility
    ? claimableNow !== null
    : isError
      ? false
      : initiallyClaimable;

  const capture = useCallback(
    (from: { domainProofAvailable: boolean; fastTrackEligible: boolean }) => {
      setCaptured((prev) =>
        prev &&
        prev.placeId === placeId &&
        prev.domainProofAvailable === from.domainProofAvailable &&
        prev.fastTrackEligible === from.fastTrackEligible
          ? prev
          : {
              placeId,
              domainProofAvailable: from.domainProofAvailable,
              fastTrackEligible: from.fastTrackEligible,
            },
      );
    },
    [placeId],
  );

  // Track the latest claimable answer, but never while the wizard is open:
  // it resets its steps when `domainProofAvailable` changes, which would wipe
  // a half-finished claim or its success screen.
  useEffect(() => {
    if (claimableNow && !wizardOpen) capture(claimableNow);
  }, [claimableNow, wizardOpen, capture]);

  // The wizard just closed and the chip is gone (a successful claim hid it),
  // so the Modal's return-focus target is detached. Park focus on the heading.
  const wasOpen = useRef(false);
  useEffect(() => {
    const justClosed = wasOpen.current && !wizardOpen;
    wasOpen.current = wizardOpen;
    if (!justClosed || visible) return;
    const heading = document.querySelector<HTMLElement>("h1");
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
    heading.focus();
  }, [wizardOpen, visible]);

  // Consume a press made before eligibility answered, exactly once.
  useEffect(() => {
    if (pressedFor === null) return;
    if (pressedFor !== placeId) {
      setPressedFor(null);
      return;
    }
    if (!eligibility && !isError) return; // still waiting
    setPressedFor(null);
    if (claimableNow && isSignedIn) {
      capture(claimableNow);
      setOpenFor(placeId);
    }
  }, [
    pressedFor,
    placeId,
    eligibility,
    isError,
    claimableNow,
    isSignedIn,
    capture,
  ]);

  const onPress = useCallback(() => {
    if (isPending) return;
    if (!isSignedIn) {
      showSignInOverlay({ redirect: pathname ?? "/" });
      return;
    }
    if (claimableNow) {
      capture(claimableNow);
      setOpenFor(placeId);
      return;
    }
    if (!eligibility && !isError) setPressedFor(placeId);
  }, [
    isPending,
    isSignedIn,
    showSignInOverlay,
    pathname,
    claimableNow,
    capture,
    placeId,
    eligibility,
    isError,
  ]);

  const wizardEligibility =
    captured && captured.placeId === placeId ? captured : null;

  return (
    <>
      {visible ? (
        <button
          type="button"
          className={placeStyles.rateButton}
          aria-haspopup="dialog"
          data-testid="place-hero-claim"
          // Session still resolving (and always on the server render): see
          // `useSessionGate`. Disabled rather than guessing signed-out.
          disabled={isPending}
          onClick={onPress}
        >
          <BadgeCheck size={16} aria-hidden />
          {String(t("places.claimCta"))}
        </button>
      ) : null}

      {isSignedIn && wizardEligibility ? (
        <ClaimVenueWizard
          placeId={placeId}
          placeName={placeName}
          open={wizardOpen}
          domainProofAvailable={wizardEligibility.domainProofAvailable}
          fastTrackEligible={wizardEligibility.fastTrackEligible}
          onClose={() => setOpenFor(null)}
          onClaimed={() => {
            void eligibilityQuery.refetch();
          }}
        />
      ) : null}
    </>
  );
}

HeroClaimPlaceButton.displayName = "HeroClaimPlaceButton";
