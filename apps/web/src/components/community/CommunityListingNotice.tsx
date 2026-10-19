"use client";

import { useId, useState } from "react";
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { Info, Users } from "lucide-react";
import { XStack, YStack } from "tamagui";
import { DateTime, Link, Text, useLocale, useTranslations } from "@th/ui";

/**
 * Catalog namespace per stewardship. A LISTING is community-run (anyone may
 * suggest an edit); a PLACE page is moderator-run until the place is claimed,
 * so it must not say "anyone can suggest edits" (moderator-place-page D7).
 */
const COPY_NAMESPACE = {
  listing: "communityListing",
  place: "communityPlacePage",
} as const;

/**
 * Ownerless-host attribution for COMMUNITY listings — rendered where an
 * organizer/lineup block would sit on an owned event. Slimmed to a
 * lightweight, Wikipedia-style byline plus a keyboard-accessible "how this
 * works" info disclosure. "Suggest an edit" sits inline beside the byline
 * (see `suggestEditHref`) — this is the only place on the page framing the
 * listing as community-run, so the edit affordance belongs with it. The
 * recruitment CTA moved to a quiet page footer, so neither competes here.
 */
/**
 * The page data's `entity.claimable`, read only when the summary carries it.
 * Absent means "unknown": the notice then uses the unreviewed byline, which
 * is true whether or not the place has been claimed.
 */
export function placeClaimableFrom(entity: object): boolean {
  return "claimable" in entity && entity.claimable === true;
}

export function CommunityListingNotice({
  suggestEditHref,
  subject = "listing",
  lastChangedAt,
  placeClaimable,
}: {
  /**
   * PLACE only: the page data's `entity.claimable` (no owner, no claim in
   * review). The attribution outlives the claim until the owner keeps or
   * clears the moderators' work (D6), so "until the place is claimed" is only
   * said while that is still true. Server data, so SSR and client agree.
   */
  placeClaimable?: boolean;
  /** Whose stewardship this notice describes. Defaults to a listing. */
  subject?: keyof typeof COPY_NAMESPACE;
  /**
   * ISO timestamp of the last community change. Shown only inside the
   * popover, which renders client-side after a press, so the server-rendered
   * byline never carries a locale- or timezone-dependent date.
   */
  lastChangedAt?: string;
  /**
   * When set, the notice carries the "Suggest an edit" link. Community
   * listings are the only stewardship that offers it, and this notice is the
   * only place on the page that frames them as community-run — so the action
   * belongs beside that framing. (It used to live in the floating action bar,
   * removed 2026-08-27.)
   */
  suggestEditHref?: string;
} = {}) {
  const t = useTranslations();
  const locale = useLocale();
  const ns = COPY_NAMESPACE[subject];
  // A place that can no longer be claimed (owned, or a claim in review) gets
  // the copy that is true either way: moderators wrote it, and nobody who
  // runs the place has reviewed it yet.
  const unreviewed = subject === "place" && placeClaimable !== true;
  const bylineKey = unreviewed ? `${ns}.bylineUnreviewed` : `${ns}.byline`;
  const bodyKey = unreviewed ? `${ns}.bodyUnreviewed` : `${ns}.body`;
  const [open, setOpen] = useState(false);
  const titleId = useId();

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "bottom-start",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  return (
    <XStack
      gap="$2"
      alignItems="center"
      flexWrap="wrap"
      data-testid={
        subject === "place"
          ? "community-place-notice"
          : "community-listing-notice"
      }
    >
      <Users size={16} aria-hidden style={{ flexShrink: 0, opacity: 0.7 }} />
      <Text variant="bodySmall" tone="muted" style={{ letterSpacing: 0.2 }}>
        {String(t(bylineKey))}
      </Text>

      {suggestEditHref ? (
        <Link href={suggestEditHref} data-testid="event-suggest-edit-btn">
          <Text variant="bodySmall" style={{ textDecorationLine: "underline" }}>
            {String(t("pageActions.suggestEdit"))}
          </Text>
        </Link>
      ) : null}

      {/* Info disclosure — icon+label button, ≥44px tap target, keyboard
          openable with a visible focus ring and dialog semantics. */}
      <button
        ref={refs.setReference}
        type="button"
        // Starts with the visible label (WCAG 2.5.3 label-in-name), then says
        // what it is about.
        aria-label={`${String(t("communityListing.howItWorks"))}: ${String(
          t(`${ns}.infoAria`),
        )}`}
        data-testid="community-listing-info-btn"
        {...getReferenceProps()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minHeight: 44,
          padding: "0 8px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontFamily: "Montserrat, sans-serif",
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--colorMuted, #5C544A)",
        }}
      >
        <Info size={14} aria-hidden />
        {String(t("communityListing.howItWorks"))}
      </button>

      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            {/* Raw div owns Floating UI positioning; Tamagui YStack inside
                handles visual styling only (mirrors AccountManagementPopover
                — mixing floatingStyles into a Tamagui node breaks position). */}
            <div
              ref={refs.setFloating}
              {...getFloatingProps()}
              aria-labelledby={titleId}
              style={{ ...floatingStyles, zIndex: 100_000 }}
            >
              <YStack
                maxWidth={340}
                gap="$2"
                padding="$3"
                borderWidth={2}
                borderColor="$borderColor"
                borderRadius={0}
                backgroundColor="$surface"
                data-testid="community-listing-info-popover"
              >
                <Text
                  id={titleId}
                  variant="caption"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={0.5}
                >
                  {String(t(`${ns}.title`))}
                </Text>
                <Text variant="bodySmall" tone="muted">
                  {String(t(bodyKey))}
                </Text>
                {lastChangedAt ? (
                  <Text variant="caption" tone="muted">
                    {String(
                      t("communityPlacePage.lastChanged", {
                        date: DateTime.format(lastChangedAt, "date", {
                          timeZone: browserTimeZone(),
                          locale,
                        }),
                      }),
                    )}
                  </Text>
                ) : null}
              </YStack>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </XStack>
  );
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
