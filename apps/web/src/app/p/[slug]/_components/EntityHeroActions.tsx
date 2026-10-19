"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { Flag, Link2 } from "lucide-react";
import { useNotify, useTranslations } from "@th/ui";

import { authClient } from "@/lib/auth/auth-client";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import {
  RowActionMenu,
  type RowActionMenuItem,
} from "@/components/data-table/RowActionMenu";
import { ReportEntityDialog } from "@/components/community/ReportEntityDialog";
import styles from "./place-entity.module.css";

type Props = {
  /** Report subject: which listing kind this page is (from `entity.type`). */
  subjectType: "HUMAN" | "ORGANIZATION";
  /** Report subject: the owner entity's id (humanId / orgId — NOT the page id). */
  subjectId: string;
  /** Display name for the report dialog's context line. */
  subjectName: string;
  /**
   * Canonical page URL for Copy link. When omitted the action falls back to
   * the live `window.location.href` at invocation time.
   */
  shareUrl?: string;
};

/**
 * HUMAN / ORG hero overflow — the profile counterpart to `PlaceHeroActions`.
 *
 * Follow and Share already have their own hero controls (`FollowButton`,
 * `ProfileShareButton`), so this `⋯` carries only what has no other home:
 *
 *   • Copy link — genuinely additive next to Share: on a device with a native
 *     share sheet, Share hands the URL to the OS and there is otherwise no way
 *     to just put it on the clipboard.
 *   • Report — the in-place intake dialog (entity-report-intake FR-001);
 *     destructive tone.
 *
 * Signed-OUT viewers never navigate: Report opens the sign-in card in place
 * with the CURRENT path as the redirect, so finishing sign-in leaves the
 * viewer on the profile; the reactive session then mounts the dialog and the
 * second press opens it.
 *
 * Request-to-book is deliberately absent — that CTA is the hero's own
 * `HeroPerformerBookingButton`. Directions / claim / dispute are PLACE-only
 * concepts and stay with `PlaceHeroActions`.
 */
export function EntityHeroActions({
  subjectType,
  subjectId,
  subjectName,
  shareUrl,
}: Props) {
  const t = useTranslations();
  const pathname = usePathname();
  const { toast } = useNotify();
  const session = authClient.useSession();
  const isSignedIn = Boolean(session.data?.user);
  const { showSignInOverlay } = useAppOverlay();

  const [reportOpen, setReportOpen] = useState(false);

  const resolveUrl = useCallback(() => {
    if (shareUrl) return shareUrl;
    if (typeof window !== "undefined") return window.location.href;
    return "";
  }, [shareUrl]);

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

  const openReportOrSignIn = useCallback(() => {
    if (isSignedIn) {
      setReportOpen(true);
    } else {
      showSignInOverlay({ redirect: pathname ?? "/" });
    }
  }, [isSignedIn, pathname, showSignInOverlay]);

  // Copy link only earns a slot where the hero's Share button hands off to the
  // OS share sheet. Without `navigator.share`, ProfileShareButton IS
  // copy-to-clipboard, so listing both would be the same action twice with two
  // different confirmations.
  const hasNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  const items = useMemo<RowActionMenuItem[]>(
    () => [
      ...(hasNativeShare
        ? [
            {
              key: "copyLink",
              label: String(t("pageActions.copyLink")),
              icon: <Link2 size={14} aria-hidden />,
              testId: "entity-hero-copy-link",
              onPress: () => void copyLink(),
            } satisfies RowActionMenuItem,
          ]
        : []),
      {
        key: "report",
        label: String(t("pageActions.report")),
        icon: <Flag size={14} aria-hidden />,
        tone: "danger",
        testId: "entity-hero-report",
        onPress: openReportOrSignIn,
      },
    ],
    [t, copyLink, openReportOrSignIn, hasNativeShare],
  );

  return (
    <>
      <span
        className={styles.heroOverflow}
        data-testid="entity-hero-actions-menu"
      >
        <RowActionMenu
          items={items}
          ariaLabel={String(t("pageActions.moreActions"))}
          triggerVariant="framed"
        />
      </span>

      {isSignedIn ? (
        <ReportEntityDialog
          subjectType={subjectType}
          subjectId={subjectId}
          subjectName={subjectName}
          open={reportOpen}
          onOpenChange={setReportOpen}
        />
      ) : null}
    </>
  );
}

EntityHeroActions.displayName = "EntityHeroActions";
