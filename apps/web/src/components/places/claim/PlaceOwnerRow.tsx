"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { BadgeCheck, ShieldQuestion } from "lucide-react";
import { NextLinkAnchor, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";

import { OwnershipDisputeDialog } from "./OwnershipDisputeDialog";
import styles from "./place-owner-row.module.css";

type Props = {
  placeId: string;
  placeName: string;
};

/**
 * Ownership row for a CLAIMED venue (FR-008 / FR-009).
 *
 * Renders "Owned by {name} · Request transfer" on ONE line in the page body,
 * so the transfer request is no longer reachable only from the hero `…`
 * overflow. Self-hides for every non-`already_claimed` state, so an unclaimed
 * venue shows neither the owner nor the transfer action.
 *
 * This is the single source of truth for the owner display: the canonical
 * `/places/:slug` entity page mounts it directly, and the legacy
 * `/places/id/:placeId` route reaches it through `ClaimVenueCta`'s
 * already-claimed branch, so the two routes can no longer drift (FR-009).
 *
 * The owner name links to the owner's own entity page (`/orgs/{slug}` for an
 * ORGANIZATION, `/humans/{slug}` for a HUMAN), matching how organizer / artist
 * names link elsewhere. `owner` is null — and the row falls back to an unnamed
 * "Verified owner" — whenever the owner has no PUBLIC page, so a name is never
 * shown without a link, and no owner is named who isn't already named on their
 * own public profile (see `placeClaimOwnerSchema` / NFR-003).
 *
 * "Request transfer" opens the SAME `OwnershipDisputeDialog` the venue hero's
 * `⋯` menu opens — there is exactly one dispute flow. Signed-out visitors get
 * the in-place sign-in card and press again afterwards, mirroring
 * `PlaceHeroActions`.
 */
export function PlaceOwnerRow({ placeId, placeName }: Props) {
  const t = useTranslations();
  const pathname = usePathname();
  const session = authClient.useSession();
  const isSignedIn = Boolean(session.data?.user);
  const { showSignInOverlay } = useAppOverlay();

  const [disputeOpen, setDisputeOpen] = useState(false);

  // Same query key + staleTime as PlaceHeroActions / ClaimVenueCta, so mounting
  // this row alongside them costs no extra request (React Query dedupes).
  const eligibilityQuery = trpc.places.getPlaceClaimEligibility.useQuery(
    { placeId },
    { staleTime: 30_000, retry: false, meta: { silent: true } },
  );
  const eligibility = eligibilityQuery.data;

  if (eligibility?.state !== "already_claimed") return null;

  const owner = eligibility.owner;
  const ownerHref = owner
    ? owner.type === "ORGANIZATION"
      ? `/orgs/${owner.pageSlug}`
      : `/humans/${owner.pageSlug}`
    : null;

  const onTransferPress = () => {
    if (isSignedIn) {
      setDisputeOpen(true);
    } else {
      showSignInOverlay({ redirect: pathname ?? "/" });
    }
  };

  return (
    <>
      <div className={styles.ownerRow}>
        {/* The icon lives INSIDE the paragraph, not beside it: as a sibling
            flex item it wrapped onto a line of its own at 320px (verified in
            the browser), leaving an orphaned checkmark above the sentence. */}
        {owner && ownerHref ? (
          <p className={styles.ownedBy}>
            <BadgeCheck size={15} aria-hidden className={styles.icon} />
            <span className={styles.label}>{t("places.ownerRowLabel")}</span>{" "}
            {/* NextLinkAnchor hard-codes `display:flex` + `textDecoration:none`
                + `color:inherit` as INLINE styles, which would break the
                in-sentence flow and beat any class rule. Override the layout
                bit inline (inline styles are the only thing that can) and keep
                the visual treatment on the inner span, which carries no inline
                styles — so the hover/focus colour still comes from CSS. */}
            <NextLinkAnchor
              href={ownerHref}
              className={styles.ownerLink}
              style={{ display: "inline" }}
            >
              <span className={styles.ownerName}>{owner.displayName}</span>
            </NextLinkAnchor>
          </p>
        ) : (
          <p className={styles.ownedBy}>
            <BadgeCheck size={15} aria-hidden className={styles.icon} />
            <span className={styles.label}>{t("places.ownerRowUnnamed")}</span>
          </p>
        )}

        <span className={styles.separator} aria-hidden>
          ·
        </span>

        {/* The aria-label DISAMBIGUATES (which venue?) without renaming: it is
            a strict superset of the visible "Request transfer" label, so voice
            control ("click request transfer") still matches — WCAG 2.5.3 Label
            in Name. Both catalogs keep the visible string as the prefix. */}
        <button
          type="button"
          className={styles.transferAction}
          onClick={onTransferPress}
          aria-label={String(
            t("places.ownerRowRequestTransferAria", { name: placeName }),
          )}
        >
          <ShieldQuestion size={14} aria-hidden />
          {t("places.ownerRowRequestTransfer")}
        </button>
      </div>

      {isSignedIn ? (
        <OwnershipDisputeDialog
          placeId={placeId}
          placeName={placeName}
          open={disputeOpen}
          onClose={() => setDisputeOpen(false)}
        />
      ) : null}
    </>
  );
}

PlaceOwnerRow.displayName = "PlaceOwnerRow";
