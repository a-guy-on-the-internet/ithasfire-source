"use client";

import { useCallback, useId, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Alert,
  Button,
  Text,
  Spinner,
  Switch,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

import { SetHoursModal } from "../../calendars/_components/SetHoursModal";
import { shouldShowHoursWarning } from "../../calendars/_components/availability-setup-helpers";

export interface BookingAcceptanceToggleProps {
  placeId: string;
}

/**
 * The venue's on/off switch for inbound booking requests — flips
 * `Place.acceptsBookingRequests` via `places.setBookingAcceptance`. The actor is
 * injected server-side, so we only send `{ placeId, accepts }`.
 *
 * IT LIVES ON THE BOOKINGS PAGE, and that placement is the fix, not a detail.
 * It used to sit inside the COLLAPSED "Page settings" drawer of the public-page
 * editor, between the slug field and three raw hex colour inputs. A venue owner
 * reported that the control did not exist; it did, and even the bookings inbox
 * pointed at it ("Open venue page settings") without saying it was behind a
 * disclosure. One home, and the home is the page you open when you are dealing
 * with bookings.
 *
 * STATE COMES FROM THE QUERY CACHE, not a local `useState` seeded from a prop.
 * `BookingInbox` reads the same `places.getPlaceForEdit` entry to decide which
 * empty state to show ("not verified" vs "turned off" vs "nothing yet"), so a
 * private optimistic copy here would let the switch and the copy under it
 * disagree for a round trip. React Query dedupes the two subscriptions into one
 * request.
 *
 * Unverified venues see the control disabled with helper copy; the backend also
 * rejects enabling on an unverified place with `PLACE_NOT_VERIFIED`.
 *
 * THE SAME DISABLED-PLUS-HELPER SHAPE CARRIES THE PERMISSION CASE. The read
 * that renders this switch admits OWNER/ADMIN/EDITOR (`canManagePlace`), while
 * the write bar is a direct human owner or an org OWNER/ADMIN — so EDITOR is
 * the one role that loads a live-looking switch it may not flip.
 * `viewerCanManageSwitches` (derived server-side, never stored) moves that
 * discovery to before the click. The toast stays as the backstop for anyone
 * who reaches the mutation another way.
 *
 * VIEWER, SCANNER and FINANCE used to land here too; the server refuses them the
 * read, and this component returns null for them. That is a DIFFERENT
 * state from "locked", and deliberately so — they can still reach the booking
 * inbox around it, because `listBookingRequests` scope `venue` admits any
 * member of an owning org.
 */
export function BookingAcceptanceToggle({
  placeId,
}: BookingAcceptanceToggleProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const placeQuery = trpc.places.getPlaceForEdit.useQuery(
    { placeId },
    { enabled: Boolean(placeId), staleTime: 10_000, retry: 1 },
  );

  /**
   * Covers the window the mutation itself does not: `isPending` goes false the
   * moment the flag is written, but the public page is still stale until the
   * ISR purge below returns. Holding the switch in its saving state until then
   * is what makes "it saved" mean "your visitors see it".
   */
  const [isPurging, setIsPurging] = useState(false);

  const place = placeQuery.data?.place;
  const isVerified = place?.verificationStatus === "VERIFIED";
  const accepts = place?.acceptsBookingRequests ?? false;
  /**
   * Fails CLOSED while the read is in flight, which costs nothing here: the
   * switch is not rendered at all until the query resolves (spinner above).
   */
  const canManage = place?.viewerCanManageSwitches ?? false;

  /**
   * PERMISSION BEATS VERIFICATION when both are true. Only one explanation
   * belongs on screen, and "verify your venue" is advice this reader cannot
   * take — they cannot request verification either, and once it landed they
   * would still be refused. Naming the authority is the line that ends the
   * question.
   */
  const lockReasonKey = !canManage
    ? "admin.placeSwitchNoPermission"
    : !isVerified
      ? "admin.bkAcceptanceUnverified"
      : null;

  /**
   * A disabled switch whose explanation is visual-only announces "Accept
   * booking requests, switch, off, dimmed" and nothing about why. The lock
   * reason is a DESCRIPTION, so it rides `aria-describedby` (added to `Switch`
   * for this) and the name stays the title alone — it used to be folded into
   * `aria-labelledby`, which renamed the control.
   *
   * The id points at the helper `<Text>` actually on screen, so the announced
   * reason and the visible one cannot drift. Only while locked: unlocked, the
   * help line is a sentence about the public page and the switch's own state
   * already says the rest.
   */
  const fieldId = useId();
  const helpId = `${fieldId}-help`;

  /**
   * The availability-onboarding detector (spec FR-001): a Place with zero
   * CalendarAvailability rows is UNCONFIGURED — every date on the public
   * booking form computes as unavailable, so a venue with the toggle ON is
   * silently uncontactable. One shared read drives this warning, the hours
   * modal's scope, and the bookings-workspace banner; nothing re-derives it.
   */
  const setupQuery = trpc.places.getAvailabilitySetupState.useQuery(
    { placeId },
    { enabled: Boolean(placeId), staleTime: 10_000, retry: 1 },
  );

  const [hoursOpen, setHoursOpen] = useState(false);

  // Renders NOTHING until the detector answers (no flash-and-retract), and
  // nothing on a failed read — asserting "you're unconfigured" over an error
  // would be a guess, and the toggle itself is unaffected either way.
  const showHoursWarning = shouldShowHoursWarning({
    accepts,
    isVerified,
    state: setupQuery.error ? undefined : setupQuery.data,
  });

  const handleHoursClose = useCallback(() => {
    setHoursOpen(false);
    // The shared Modal restores focus to its opener — but when hours were just
    // set, the warning (and its "Set your hours" CTA, the opener) has already
    // left the page, so that restore no-ops against a detached node and focus
    // falls to <body> once the exit animation unmounts the dialog.
    //
    // Decide by STATE, not by probing activeElement: the first version of
    // this guard checked `activeElement !== body` inside the rAF, and the
    // exiting (still-mounted, animating) dialog's close button held focus at
    // that instant — so the reseat never fired (measured in a live drive).
    if (showHoursWarning) return; // CTA still on the page; Modal restores it.
    // rAF, not synchronous: the Modal marks the page inert while open, and
    // focus() on a still-inert element is a silent no-op — wait for the
    // close commit (and the inert release in its effects) to land first.
    requestAnimationFrame(() => {
      // The Switch's focusable <button> carries id = testId; its data-testid
      // is suffixed ("-track"), so the id is the stable handle.
      document.getElementById("booking-acceptance-switch")?.focus();
    });
  }, [showHoursWarning]);

  /**
   * Purge the Next route cache for the public entity page. Best effort BY
   * DESIGN: the flag is already written, so a failure here is a staleness
   * warning, not a failed save.
   *
   * Read `app/api/places/[placeId]/revalidate/route.ts` before touching this —
   * it records what was actually measured, including that today's public routes
   * render dynamically (so they are already fresh) and that the staleness a real
   * visitor hits is Cloudflare's, which no code in this app can purge yet. That
   * is why the success toast talks about a propagation window instead of
   * promising an instant flip.
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

  const mutation = trpc.places.setBookingAcceptance.useMutation({
    // Optimistic write into the SHARED cache entry, so the switch and the
    // inbox's empty-state copy move together.
    onMutate: async (variables) => {
      await utils.places.getPlaceForEdit.cancel({ placeId });
      const previous = utils.places.getPlaceForEdit.getData({ placeId });
      utils.places.getPlaceForEdit.setData({ placeId }, (prev) =>
        prev
          ? {
              ...prev,
              place: {
                ...prev.place,
                acceptsBookingRequests: variables.accepts,
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
                acceptsBookingRequests: result.acceptsBookingRequests,
              },
            }
          : prev,
      );
      setIsPurging(true);
      const purged = await purgePublicPage();
      setIsPurging(false);
      if (purged) {
        toast.success({
          id: "booking-acceptance-saved",
          title: String(
            t(
              result.acceptsBookingRequests
                ? "admin.bkAcceptanceSavedOn"
                : "admin.bkAcceptanceSavedOff",
            ),
          ),
          message: String(t("admin.bkAcceptanceSavedNote")),
        });
      } else {
        toast.warning({
          id: "booking-acceptance-saved-stale",
          title: String(t("admin.bkAcceptanceSavedStale")),
        });
      }
    },
    onError: (err, _variables, context) => {
      // Roll the optimistic flip back to the snapshot taken in `onMutate`.
      if (context?.previous) {
        utils.places.getPlaceForEdit.setData({ placeId }, context.previous);
      }
      toast.danger({
        id: "booking-acceptance-failed",
        title: String(t("admin.bkAcceptanceUpdateFailed")),
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
      // The detector's answer EMBEDS acceptsBookingRequests-adjacent state:
      // the bookings-workspace banner shows only for ON+unconfigured, and this
      // component populates the same cache entry. Without this line, flipping
      // the toggle and navigating there serves a ~30s-stale detector — no
      // banner right after turning ON, a ghost banner right after OFF.
      void utils.places.getAvailabilitySetupState.invalidate({ placeId });
    },
  });

  const handleChange = (next: boolean) => {
    if (!isVerified || !canManage) return;
    mutation.mutate({ placeId, accepts: next });
  };

  // The place lookup failing is not this control's story to tell — the inbox
  // renders its own error state for the same page. Showing a switch whose
  // position we cannot vouch for would be worse than showing nothing.
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
      {/* WRAPS, and the `flexBasis` is what decides when. MEASURED at 320px
          inside the admin shell: the card gets ~208px of content, so a
          side-by-side row left the label column ~110px and `ACCEPT BOOKING
          REQUESTS` broke mid-word ("BOOKIN / G"). At `flexBasis={220}` the pair
          no longer fits at that width and the switch drops to its own line
          under the copy, which reads as a normal mobile setting row; on desktop
          both sit on one line and the label grows into the space. */}
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
          {/* `body` bold, not `h4`: the page's own H3 sits directly above this
              card, and the design system's rule is to match text scale to the
              container — the 2px border is what gives this control its weight,
              not a second heading-scale line. */}
          <Text variant="body" weight="bold">
            {String(t("admin.bkAcceptanceTitle"))}
          </Text>
          <Text
            variant="bodySmall"
            tone="muted"
            id={helpId}
            testId="booking-acceptance-help"
          >
            {String(
              t(
                lockReasonKey ??
                  (accepts
                    ? "admin.bkAcceptanceHelpOn"
                    : "admin.bkAcceptanceHelpOff"),
              ),
            )}
          </Text>
        </YStack>
        {/* A disabled OFF switch during the load would assert a state we do not
            know yet, then flip under the reader. A spinner asserts nothing. */}
        {placeQuery.isLoading ? (
          <Spinner size="sm" />
        ) : (
          <XStack flexShrink={0}>
            <Switch
              checked={accepts}
              onCheckedChange={handleChange}
              disabled={!isVerified || !canManage}
              saving={mutation.isPending || isPurging}
              aria-label={String(t("admin.bkAcceptanceTitle"))}
              aria-describedby={lockReasonKey ? helpId : undefined}
              testId="booking-acceptance-switch"
            />
          </XStack>
        )}
      </XStack>

      {/* FR-001: DIRECTLY UNDER the slider, persistent inline content — a
          toast would vanish before it is read. Names the consequence in the
          venue's terms, never the schema, and carries the fix.

          The CTA is Alert CHILDREN, deliberately NOT the `actions` slot:
          `actions` renders trailing in the SAME ROW as the body, and the
          non-wrapping button squeezed the text column to ~1ch at 320px (one
          character per line, 2,228px tall — measured on a live 320×800
          viewport) while itself overflowing the card. As children it stacks
          beneath the description inside the flex:1 body column, which wraps
          at full width on every viewport with no media query — admin sits
          behind the 256px rail, where viewport queries lie about content
          width. */}
      {showHoursWarning && (
        <Alert
          tone="warning"
          title={String(t("admin.bkHoursWarnTitle"))}
          description={String(t("admin.bkHoursWarnBody"))}
          // NO icon, deliberately: the admin card leaves ~138px of inner
          // width at a 320px viewport, and Alert's 32px icon column (plus
          // gap) would take a third of it from the text. The amber border
          // and the title carry the warning; the glyph was ornament this
          // card cannot afford.
          testID="booking-hours-warning"
        >
          <Button
            variant="primary"
            // Content-sized (alignSelf) so the accent fill never spans a
            // desktop column, but capped at the body's width with an auto
            // height so the label WRAPS when the column physically cannot
            // hold it — "SET YOUR HOURS" is ~185px and the 320px admin card
            // cannot fit that on one line no matter the arrangement.
            // minHeight keeps the 44px touch floor either way.
            size="$4"
            alignSelf="flex-start"
            maxWidth="100%"
            height="auto"
            minHeight={44}
            paddingVertical="$2"
            marginTop="$1"
            onPress={() => setHoursOpen(true)}
            testID="booking-hours-warning-cta"
          >
            {String(t("admin.bkHoursWarnCta"))}
          </Button>
        </Alert>
      )}

      {/* Mounted OUTSIDE the warning conditional: the first saved row flips
          the detector to configured and unmounts the warning — tearing the
          open modal down with it would slam the editor shut mid-edit. */}
      <SetHoursModal
        placeId={placeId}
        open={hoursOpen}
        onClose={handleHoursClose}
      />
    </YStack>
  );
}
