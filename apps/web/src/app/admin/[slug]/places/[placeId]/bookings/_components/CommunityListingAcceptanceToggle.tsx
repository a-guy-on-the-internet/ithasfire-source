"use client";

import { useCallback, useId, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Alert, Spinner, Switch, Text, useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

export interface CommunityListingAcceptanceToggleProps {
  placeId: string;
}

/**
 * The venue's standing consent to OWNERLESS community listings at this place —
 * flips `Place.acceptsCommunityListings` via
 * `places.setCommunityListingAcceptance` (community-listings-at-claimed-venues
 * FR-001/FR-005). The actor is injected server-side, so we send
 * `{ placeId, accepts }`.
 *
 * WHY IT SITS DIRECTLY UNDER THE BOOKING SWITCH, and why that is the design
 * rather than a placement detail: turning this on does not only change what the
 * public venue page shows. Confirmation drives availability and conflict
 * detection through the SAME predicate, so an accepted weekly open mic makes
 * that night unavailable for booking requests. A venue owner therefore has to
 * meet this control where they deal with bookings, not in a separate
 * "community" corner, or they will flip it and later find their calendar
 * quietly full. The copy under the switch says so in the venue's own terms.
 *
 * STATE COMES FROM THE QUERY CACHE, exactly as `BookingAcceptanceToggle` does,
 * and from the SAME `places.getPlaceForEdit` entry. React Query dedupes the two
 * subscriptions into one request, and a private `useState` here would let the
 * two switches disagree for a round trip.
 *
 * Unverified venues see the control disabled with helper copy; the backend also
 * rejects ENABLING on an unverified place with `PLACE_NOT_VERIFIED`. Disabling
 * is never gated — retracting consent must always be possible.
 *
 * PERMISSION RIDES THE SAME DISABLED-PLUS-HELPER SHAPE, exactly as on the
 * booking switch above: the read that renders this page admits ANY org
 * membership while the write bar is a direct human owner or an org
 * OWNER/ADMIN, so `viewerCanManageSwitches` is what stops a VIEWER discovering
 * that boundary by flipping the switch and catching a toast. Note this one
 * disables BOTH directions — unlike `PLACE_NOT_VERIFIED`, which only blocks
 * enabling, the authority bar applies to retracting consent too.
 */
export function CommunityListingAcceptanceToggle({
  placeId,
}: CommunityListingAcceptanceToggleProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const placeQuery = trpc.places.getPlaceForEdit.useQuery(
    { placeId },
    { enabled: Boolean(placeId), staleTime: 10_000, retry: 1 },
  );

  /**
   * Same window `BookingAcceptanceToggle` covers: `isPending` goes false when
   * the flag is written, but the public venue page is stale until the purge
   * returns. Holding the switch in its saving state until then is what makes
   * "it saved" mean "your visitors see it".
   */
  const [isPurging, setIsPurging] = useState(false);

  const place = placeQuery.data?.place;
  const isVerified = place?.verificationStatus === "VERIFIED";
  const accepts = place?.acceptsCommunityListings ?? false;
  /** FR-007: what the venue is actually being asked to accept. */
  const listingCount = place?.communityListingCount ?? 0;
  /** Fails CLOSED while the read is in flight; the spinner holds the slot. */
  const canManage = place?.viewerCanManageSwitches ?? false;

  /**
   * PERMISSION BEATS VERIFICATION when both are true — same ruling as the
   * booking switch, and for the same reason: "verify your venue" is advice
   * this reader cannot act on, and verifying would not unlock the switch for
   * them anyway. One explanation on screen, and it is the binding one.
   */
  const lockReasonKey = !canManage
    ? "admin.placeSwitchNoPermission"
    : !isVerified
      ? "admin.clAcceptanceUnverified"
      : null;

  /**
   * See `BookingAcceptanceToggle` for the full reasoning: while the control is
   * locked it is DESCRIBED by the helper line already on screen, rather than
   * left as a dimmed switch that announces no reason at all. The name stays the
   * title; the reason is a description, not a rename.
   */
  const fieldId = useId();
  const helpId = `${fieldId}-help`;

  /**
   * Reuses `/api/places/[placeId]/revalidate` — the SAME endpoint the booking
   * switch calls, deliberately NOT a second one. It is place-scoped and derives
   * its own paths from the place id, so it carries no knowledge of which flag
   * changed and needs none. Read that route's header before touching this: it
   * records what was measured, including that today's public routes render
   * dynamically and that the staleness a real visitor hits is Cloudflare's.
   *
   * Best effort BY DESIGN: the flag is already written, so a failure here is a
   * staleness warning, not a failed save.
   */
  const purgePublicPage = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/places/${placeId}/revalidate`, {
        method: "POST",
      });
      return res.ok;
    } catch {
      return false;
    }
  }, [placeId]);

  const mutation = trpc.places.setCommunityListingAcceptance.useMutation({
    onMutate: async (variables) => {
      await utils.places.getPlaceForEdit.cancel({ placeId });
      const previous = utils.places.getPlaceForEdit.getData({ placeId });
      utils.places.getPlaceForEdit.setData({ placeId }, (prev) =>
        prev
          ? {
              ...prev,
              place: {
                ...prev.place,
                acceptsCommunityListings: variables.accepts,
              },
            }
          : prev,
      );
      return { previous };
    },
    onSuccess: async (result) => {
      utils.places.getPlaceForEdit.setData({ placeId }, (prev) =>
        prev
          ? {
              ...prev,
              place: {
                ...prev.place,
                acceptsCommunityListings: result.acceptsCommunityListings,
              },
            }
          : prev,
      );
      setIsPurging(true);
      const purged = await purgePublicPage();
      setIsPurging(false);
      if (purged) {
        toast.success({
          id: "community-listing-acceptance-saved",
          title: String(
            t(
              result.acceptsCommunityListings
                ? "admin.clAcceptanceSavedOn"
                : "admin.clAcceptanceSavedOff",
            ),
          ),
          message: String(t("admin.clAcceptanceSavedNote")),
        });
      } else {
        toast.warning({
          id: "community-listing-acceptance-saved-stale",
          title: String(t("admin.clAcceptanceSavedStale")),
        });
      }
    },
    onError: (err, _variables, context) => {
      if (context?.previous) {
        utils.places.getPlaceForEdit.setData({ placeId }, context.previous);
      }
      toast.danger({
        id: "community-listing-acceptance-failed",
        title: String(t("admin.clAcceptanceUpdateFailed")),
        // `t` is load-bearing, not decoration: the dictionary inside
        // `formatErrorMessage` is case-sensitive and has no NOT_RESOURCE_OWNER
        // key, so without a translator the toggle's own refusal — now reachable
        // for any org member below OWNER/ADMIN — renders as "Something went
        // wrong." The i18n path resolves `errors.notResourceOwner`.
        message: formatErrorMessage(err, t),
      });
    },
    onSettled: () => {
      void utils.places.getPlaceForEdit.invalidate({ placeId });
    },
  });

  const handleChange = (next: boolean) => {
    if (!isVerified || !canManage) return;
    mutation.mutate({ placeId, accepts: next });
  };

  // The place lookup failing is not this control's story to tell — the inbox
  // renders its own error state for the same page, and showing a switch whose
  // position we cannot vouch for is worse than showing nothing.
  if (placeQuery.error) return null;

  return (
    <YStack
      padding="$4"
      gap="$3"
      borderWidth={2}
      borderColor="$borderColor"
      borderRadius={0}
      backgroundColor="$surface"
    >
      {/* Same wrap rule as the booking switch above it, and for the same
          measured reason: inside the admin shell at 320px this card gets
          ~208px of content, so a side-by-side row breaks the label mid-word.
          At flexBasis 220 the pair no longer fits and the switch drops to its
          own line under the copy. */}
      <XStack
        gap="$4"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
      >
        <YStack
          gap="$1"
          flexGrow={1}
          flexShrink={1}
          flexBasis={220}
          minWidth={0}
        >
          <Text variant="body" weight="bold">
            {String(t("admin.clAcceptanceTitle"))}
          </Text>
          <Text
            variant="bodySmall"
            tone="muted"
            id={helpId}
            testId="community-listing-acceptance-help"
          >
            {String(
              t(
                lockReasonKey ??
                  (accepts
                    ? "admin.clAcceptanceHelpOn"
                    : "admin.clAcceptanceHelpOff"),
              ),
            )}
          </Text>
        </YStack>
        {placeQuery.isLoading ? (
          <Spinner size="sm" />
        ) : (
          <XStack flexShrink={0}>
            <Switch
              checked={accepts}
              onCheckedChange={handleChange}
              disabled={!isVerified || !canManage}
              saving={mutation.isPending || isPurging}
              aria-label={String(t("admin.clAcceptanceTitle"))}
              aria-describedby={lockReasonKey ? helpId : undefined}
              testId="community-listing-acceptance-switch"
            />
          </XStack>
        )}
      </XStack>

      {/* FR-005/FR-007: the consequence, stated plainly and BEFORE the decision
          — accepted listings appear on the venue page AND occupy that time for
          booking availability. Persistent inline content, not a toast: a toast
          would vanish before it is read, and this is the sentence that stops a
          venue being surprised by a full calendar later.

          The COUNT is what makes the question concrete rather than abstract.
          Rendered only when there is something to count; at zero the sentence
          would read as an odd nothing-claim, and zero is the true answer for
          almost every place until the placeId backfill runs. */}
      {isVerified && (
        <Alert
          tone="info"
          // NO title, and COMPACT — both decided at a 1280 viewport against the
          // real page. With a title the Alert rendered its heading uppercased
          // in the accent at heading weight, which made this note the single
          // loudest element on the screen: louder than the card's own label,
          // and louder than the "BOOKING REQUESTS" page title above it. A
          // footnote explaining a switch must not outrank the page it sits on.
          // The title was also redundant — the description already says the
          // whole thing in one sentence. Card label → help line → this note is
          // now three tiers of decreasing weight, which is the order a reader
          // actually needs them in.
          compact
          description={String(
            listingCount > 0
              ? t("admin.clAcceptanceConsequenceWithCount", {
                  count: listingCount,
                })
              : t("admin.clAcceptanceConsequenceBody"),
          )}
          // NO icon, deliberately: at a 320px viewport this admin card leaves
          // ~138px of inner width and Alert's 32px icon column plus gap would
          // take a third of it from the text. Same call as the booking card's
          // hours warning.
          testID="community-listing-consequence"
        />
      )}
    </YStack>
  );
}
