"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import {
  Flag,
  Link2,
  Pencil,
  Share2,
  ShieldQuestion,
} from "lucide-react";
import { useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { OwnershipDisputeDialog } from "@/components/places/claim";
import {
  RowActionMenu,
  type RowActionMenuItem,
} from "@/components/data-table/RowActionMenu";
import { ReportEntityDialog } from "@/components/community/ReportEntityDialog";
import { useVenueEditorLink } from "./useVenueEditorLink";
import styles from "./place-entity.module.css";

type Props = {
  /** The Place id — dispute/report subject AND eligibility query key. */
  placeId: string;
  placeName: string;
  /**
   * Canonical share URL. When omitted the action falls back to the live
   * `window.location.href` at invocation time.
   */
  shareUrl?: string;
  /** Title used for the native share sheet. */
  shareTitle: string;
};

/**
 * Venue-hero overflow: the PLACE page's secondary actions, owned by the page.
 *
 * Renders the `⋯` menu that sits last in `PlaceHero`'s action row, plus the
 * dialogs those items open. The primary affordances (Follow / Request to book
 * / Get directions) are their own hero controls — this component deliberately
 * carries only what has no other home:
 *
 *   • Share / Copy link — always available.
 *   • Request transfer — only once the place is already claimed.
 *   • Report — always available; destructive tone.
 *
 * Claiming is NOT here. It used to be the third item in this menu, which buried
 * the one action an unowned, imported place most needs; it now lives only in
 * the hero row as `HeroClaimPlaceButton`, shown while the place is claimable.
 *
 * Auth handling is uniform and load-bearing: a signed-OUT viewer never
 * navigates. Every gated item opens the sign-in card in place with the CURRENT
 * path as the redirect, so completing sign-in leaves the viewer on the venue
 * page; the reactive session then mounts the dialog and the second press opens
 * it.
 */
export function PlaceHeroActions({
  placeId,
  placeName,
  shareUrl,
  shareTitle,
}: Props) {
  const t = useTranslations();
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useNotify();

  // Owner-only editor link, shared with the hero's `EditPageButton` chip.
  // Null for anonymous viewers and non-owners.
  const { href: editorHref } = useVenueEditorLink(placeId);
  const session = authClient.useSession();
  const isSignedIn = Boolean(session.data?.user);
  const { showSignInOverlay } = useAppOverlay();

  const [disputeOpen, setDisputeOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const eligibilityQuery = trpc.places.getPlaceClaimEligibility.useQuery(
    { placeId },
    { staleTime: 30_000, retry: false, meta: { silent: true } },
  );
  const eligibility = eligibilityQuery.data;
  const state = eligibility?.state;

  const resolveUrl = useCallback(() => {
    if (shareUrl) return shareUrl;
    if (typeof window !== "undefined") return window.location.href;
    return "";
  }, [shareUrl]);

  // Dispute / report share ONE auth shape (as does the hero's claim chip): the
  // sign-in card opens in place (redirect = current page, no navigation) and
  // the reactive session mounts the dialog for the second press.
  const openDisputeOrSignIn = useCallback(() => {
    if (isSignedIn) {
      setDisputeOpen(true);
    } else {
      showSignInOverlay({ redirect: pathname ?? "/" });
    }
  }, [isSignedIn, pathname, showSignInOverlay]);

  const copyLink = useCallback(async () => {
    const url = resolveUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(String(t("places.shareCopiedToast")));
    } catch {
      toast.danger(String(t("places.shareCopyFailedToast")));
    }
  }, [resolveUrl, toast, t]);

  const share = useCallback(async () => {
    const url = resolveUrl();
    if (!url) return;
    // Prefer the native share sheet where available; otherwise fall back to
    // copying the link. A user-cancelled share (AbortError) is a no-op.
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function"
    ) {
      try {
        await navigator.share({ title: shareTitle, url });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Fall through to copy on any other failure.
      }
    }
    await copyLink();
  }, [resolveUrl, shareTitle, copyLink]);

  // Report opens the in-place intake dialog (entity-report-intake FR-001) —
  // same auth handling as dispute.
  const openReportOrSignIn = useCallback(() => {
    if (isSignedIn) {
      setReportOpen(true);
    } else {
      showSignInOverlay({ redirect: pathname ?? "/" });
    }
  }, [isSignedIn, pathname, showSignInOverlay]);

  // Share / copy / report are unconditional; transfer lights up on
  // `already_claimed`. Claim never appears here (see the doc comment).
  const items = useMemo<RowActionMenuItem[]>(() => {
    const next: RowActionMenuItem[] = [];

    // PHONES ONLY — the other half of the hero's "Edit page" chip. Below
    // 640px the chip is `display: none` and this item is the live one; at
    // 641px and up the reverse, so exactly one of the two is ever in the
    // accessibility tree. `.editPageMenuItem` does that hiding (see
    // place-entity.module.css); both halves always render, because a JS
    // viewport branch on a server-rendered, edge-cached page is a hydration
    // mismatch waiting to happen.
    //
    // FIRST in the menu, above Share, on purpose. Folding an owner control
    // into an overflow is how the venue booking toggle went missing — an
    // owner hunted for it, could not find it, and filed the switch as
    // non-existent. Buried at the bottom beside Report it would repeat that;
    // at the top it is the first thing the menu says.
    //
    // `editorHref` is null for anonymous viewers and non-owners, so they get
    // neither half. The resolution is shared with the chip via
    // `useVenueEditorLink`, and React Query's cache means the two callers
    // issue ONE pair of requests between them, not two.
    if (editorHref) {
      next.push({
        key: "editPage",
        label: String(t("places.editPage")),
        icon: <Pencil size={14} aria-hidden />,
        className: styles.editPageMenuItem,
        testId: "place-hero-edit-page",
        onPress: () => router.push(editorHref),
      });
    }

    next.push(
      {
        key: "share",
        label: String(t("pageActions.share")),
        icon: <Share2 size={14} aria-hidden />,
        testId: "place-hero-share",
        onPress: () => void share(),
      },
      {
        key: "copyLink",
        label: String(t("pageActions.copyLink")),
        icon: <Link2 size={14} aria-hidden />,
        testId: "place-hero-copy-link",
        onPress: () => void copyLink(),
      },
    );
    if (state === "already_claimed") {
      next.push({
        key: "requestTransfer",
        label: String(t("pageActions.requestTransfer")),
        icon: <ShieldQuestion size={14} aria-hidden />,
        testId: "place-hero-dispute",
        onPress: openDisputeOrSignIn,
      });
    }
    next.push({
      key: "report",
      label: String(t("pageActions.report")),
      icon: <Flag size={14} aria-hidden />,
      tone: "danger",
      testId: "place-hero-report",
      onPress: openReportOrSignIn,
    });
    return next;
  }, [
    t,
    state,
    share,
    copyLink,
    openDisputeOrSignIn,
    openReportOrSignIn,
    editorHref,
    router,
  ]);

  return (
    <>
      <span
        className={styles.heroOverflow}
        data-testid="place-hero-actions-menu"
      >
        <RowActionMenu
          items={items}
          ariaLabel={String(t("pageActions.moreActions"))}
          triggerVariant="framed"
        />
      </span>

      {isSignedIn && eligibility && eligibility.state === "already_claimed" ? (
        <OwnershipDisputeDialog
          placeId={placeId}
          placeName={placeName}
          open={disputeOpen}
          onClose={() => setDisputeOpen(false)}
        />
      ) : null}

      {isSignedIn ? (
        <ReportEntityDialog
          subjectType="PLACE"
          subjectId={placeId}
          subjectName={placeName}
          open={reportOpen}
          onOpenChange={setReportOpen}
        />
      ) : null}
    </>
  );
}

PlaceHeroActions.displayName = "PlaceHeroActions";
