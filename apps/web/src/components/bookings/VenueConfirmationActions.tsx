"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  CharCountTextarea,
  Modal,
  Radio,
  RadioGroupField,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";
import { CalendarCheck, CalendarX } from "lucide-react";

import { trpc } from "@/trpc";
import { extractEventMoved } from "@/lib/event-moved-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { shouldRetryPlacePrivacyRead } from "@/lib/places/venue-location-ceiling";
import type { BookingRequestStatus } from "@/lib/booking-requests";
import type { BookingVenueConfirmationState } from "./booking-stage-rail";

// ─────────────────────────────────────────────────────────────────────────────
// The venue's vouch, decided IN THE CONVERSATION (venue-confirmation-and-
// booking-intents spec, docs/specs/2026-08-27 "UI/Flow › Thread": "Venue-side
// actions: Confirm (with owner override: Venue owns it / They own it),
// Withdraw confirmation (reason)").
//
// Rendered by the venue inbox into `BookingThread`'s `nextStep` slot, under
// "Create event from this booking" — the two are neighbours because they
// answer adjacent questions: "is there an event?" and "does the venue stand
// behind it?". One slot, one of three shapes, decided by the row's projected
// `venueConfirmation` (see `venueConfirmationOffer`):
//   · CONFIRM — the row's event is not venue-confirmed (never stamped, or
//     withdrawn), or the request is ACCEPTED with an agreement and no event
//     yet. Confirming an event-less booking MINTS the event first, so that
//     shape asks who owns it (default by intent: PERFORM → venue, RENT/USE →
//     the requester). An existing event's owner never moves on confirm, so
//     the radio is not shown for one;
//   · WITHDRAW — confirmed and REQUESTER-owned. A venue-owned event is
//     confirmed by construction and the server refuses to withdraw it, so
//     the action is not offered rather than offered-and-refused;
//   · nothing — everything else (no event on an unaccepted request, a
//     venue-owned show, a closed request). The rail already says the state.
//
// THIS IS THE STAMP, NOT AN ACCEPT. Accept is the mint point
// (docs/specs/2026-09-05) and lives on the row's own Accept button; a hold is
// confirmed from the Holds tab. `venueConfirmation.confirm` by request id
// resolves the event the request is about (origin event → agreement-anchored
// event → mint) and stamps it. Authority, the request/place match, the ledger
// entry and idempotency all live in the use case; this surface orchestrates.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `reason` bound on `withdrawVenueConfirmationInputSchema`: core's
 * `BOOKING_REASON_MAX` (1000, one cap for every booking reason; FR-013).
 * A literal, not an import, so this client component does not pull core's
 * booking-thread module into the browser bundle.
 */
export const WITHDRAW_REASON_MAX = 1000;

/**
 * Whose event it is (core's `EVENT_OWNER_SIDES`). Every read of an owner side
 * off the wire compares with `"requester"` only, so a payload from an API
 * build that still spells the place side the old way reads the same.
 */
export type EventOwnerSide = "place" | "requester";

export type VenueConfirmationOffer = "confirm" | "withdraw" | null;

const CLOSED_REQUEST_STATUSES: ReadonlySet<string> = new Set([
  "DECLINED",
  "WITHDRAWN",
  "EXPIRED",
]);

/**
 * Which action, if any, the slot offers. Pure so the decision table is pinned
 * in a test without a render. Mirrors the server's own gates: a closed
 * request cannot have anything attached; a mint needs an agreement (accept is
 * the mint point, and confirm refuses `booking_request_not_accepted`); a
 * venue-owned event refuses withdrawal.
 */
export function venueConfirmationOffer(args: {
  state: BookingVenueConfirmationState | string;
  ownerSide: EventOwnerSide | null;
  requestStatus: BookingRequestStatus;
  agreementId: string | null;
  /**
   * The request was built from an event (`builtFromEvent` on the row). The
   * request variant of confirm — the only one this slot sends — is refused
   * VENUE_CONFIRMATION_NOT_FOR_REQUESTS for any other request
   * (booking-the-night FR-011), so Confirm is offered only here. Withdraw is
   * per EVENT (`withdraw({ eventId })`) and stays offered either way.
   */
  builtFromEvent: boolean;
}): VenueConfirmationOffer {
  if (CLOSED_REQUEST_STATUSES.has(args.requestStatus)) return null;
  switch (args.state) {
    case "unconfirmed":
    case "withdrawn":
      return args.builtFromEvent ? "confirm" : null;
    case "confirmed":
      return args.ownerSide === "requester" ? "withdraw" : null;
    case "none":
      return args.builtFromEvent && args.requestStatus === "ACCEPTED" && args.agreementId
        ? "confirm"
        : null;
    default:
      return null;
  }
}

/** The spec's default (`defaultEventOwnerSideForIntent` in core). */
export function defaultOwnerSideForIntent(
  intent: "PERFORM" | "RENT" | "USE" | string,
): EventOwnerSide {
  return intent === "PERFORM" ? "place" : "requester";
}

/**
 * The two refusals the venue can act on, mapped to catalog keys; everything
 * else falls through to `formatErrorMessage`. Reads the structured
 * `data.appCode` first (error-contract shape) and the message second — an
 * `INVALID_STATUS` carries its reason in the message.
 */
export function venueConfirmationErrorNotice(
  err: unknown,
): { tone: "warning" | "danger"; key: string } | null {
  const e = err as {
    message?: string;
    data?: { appCode?: string } | null;
  } | null;
  const appCode = e?.data?.appCode ?? null;
  const message = e?.message ?? "";
  if (
    appCode === "HOLD_LINE_HAS_OPEN_CHALLENGE" ||
    message === "HOLD_LINE_HAS_OPEN_CHALLENGE"
  ) {
    return { tone: "warning", key: "errors.holdLineHasOpenChallenge" };
  }
  if (message === "booking_request_not_accepted") {
    return {
      tone: "danger",
      key: "errors.venueConfirmationRequestNotAccepted",
    };
  }
  return null;
}

const STATE_LINE_KEYS: Record<string, string> = {
  none: "booking.vcStateNone",
  unconfirmed: "booking.vcStateUnconfirmed",
  withdrawn: "booking.vcStateWithdrawn",
  confirmed: "booking.vcStateConfirmed",
};

type Dialog = "confirm" | "withdraw" | null;

/**
 * `expectedStartsAt` for a confirm that MINTS the event and has no start on
 * screen. Core requires the field on both variants but does not compare it
 * when the call mints (the row did not exist a moment ago). If the server
 * resolves an EXISTING event instead — one this row's projection has not
 * caught up with — this can never equal a real start, so the server refuses
 * with EVENT_MOVED and the refresh puts that event's date on screen. It can
 * never vouch for a date by accident.
 */
const NOTHING_ON_SCREEN_STARTS_AT = new Date(0).toISOString();

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

const NO_VENUE_CONFIRMATION = {
  state: "none",
  eventId: null,
  ownerSide: null,
} as const;

export function VenueConfirmationActions({
  bookingRequestId,
  requestStatus,
  agreementId,
  intent,
  eventStartsAt,
  venueConfirmation: venueConfirmationProp,
  placeId,
  builtFromEvent,
  testIdBase,
}: {
  bookingRequestId: string;
  requestStatus: BookingRequestStatus;
  agreementId: string | null;
  intent: "PERFORM" | "RENT" | "USE";
  /**
   * The event start the thread SHOWS (the stage rail's date). A confirmation
   * vouches for it: sent as `expectedStartsAt`, and refused with EVENT_MOVED
   * if the organizer has moved the event since. Null while no event exists
   * (the confirm mints one) or while the row has not loaded it yet.
   */
  eventStartsAt: Date | string | null;
  /**
   * The row's projected stance. Nullable for the same reason the rail's is:
   * a row this build cannot describe (a degraded projection, an older
   * payload) reads as "no event", never as a wrong offer.
   */
  venueConfirmation:
    | {
        state: BookingVenueConfirmationState | string;
        eventId: string | null;
        ownerSide: EventOwnerSide | null;
      }
    | null
    | undefined;
  /**
   * The venue the request is addressed to — read only to learn whether it
   * withholds its address, so the confirm dialog can say what Confirm
   * releases. Null (a row that carries no place) shows the note: an unknown
   * venue fails toward telling.
   */
  placeId: string | null;
  /** Built from an event — Confirm is offered only then (FR-011). */
  builtFromEvent: boolean;
  testIdBase: string;
}) {
  const venueConfirmation = venueConfirmationProp ?? NO_VENUE_CONFIRMATION;
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const [dialog, setDialog] = useState<Dialog>(null);
  const [ownerSide, setOwnerSide] = useState<EventOwnerSide>(
    defaultOwnerSideForIntent(intent),
  );
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const baseId = useId();
  const legendId = `${baseId}-owner`;
  const reasonId = `${baseId}-reason`;
  const reasonErrorId = `${reasonId}-error`;
  const addressNoteId = useId();

  const offer = venueConfirmationOffer({
    state: venueConfirmation.state,
    ownerSide: venueConfirmation.ownerSide,
    requestStatus,
    agreementId,
    builtFromEvent,
  });
  // Confirming with no event MINTS one, and only then is there an owner to
  // choose. An existing event keeps its owner — the radio would be a lie.
  const mints = venueConfirmation.eventId === null;
  const shownStartsAt = validDate(eventStartsAt);
  // Confirming an EXISTING event vouches for its date, so there has to be one
  // on screen. (The only way to get here without one is the inbox's brief
  // post-create cache write, before the refetch lands.)
  const cannotVouch = !mints && shownStartsAt === null;

  // Whether the venue hides its address, for the confirm dialog's disclosure
  // (the same read and the same rule as the venue calendar's confirm dialog).
  // The ANONYMOUS projection on purpose: it answers "what does this venue
  // publish?". Read only while Confirm is on offer, so the answer is usually
  // in before the dialog opens.
  const placePrivacyQuery = trpc.places.getPlacePublic.useQuery(
    { placeId: placeId ?? "" },
    {
      enabled: Boolean(placeId) && offer === "confirm",
      staleTime: 60_000,
      // Once, and only for a transient failure: a NOT_FOUND is final.
      retry: shouldRetryPlacePrivacyRead,
    },
  );
  // Unknown (loading, failed, no place) counts as withheld: the cost of the
  // line at a venue that publishes its address is one sentence; the cost of a
  // missing line is a venue sharing its street without being told.
  const venueWithholdsAddress =
    placePrivacyQuery.data?.place.locationIsExact !== true;
  // Which arm the confirm lands on decides WHEN holders see the street. A
  // mint the venue owns becomes its own show (the OWNER arm: the event's
  // reveal setting decides, no day-before floor). Everything else — an
  // existing event (a third party's; a venue-owned one is confirmed by
  // construction) or a mint the requester owns — is the STAMP arm.
  const addressNoteKey =
    mints && ownerSide === "place"
      ? "booking.vcConfirmSharesAddressOwnEvent"
      : "admin.venueCalConfirmSharesAddress";

  // Modal.Panel places focus on mount; the reason field is what the withdraw
  // dialog is for, so focus lands on it once the dialog is open.
  useEffect(() => {
    if (dialog !== "withdraw") return;
    const raf = requestAnimationFrame(() => {
      document.getElementById(reasonId)?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [dialog, reasonId]);

  // Three reads change on either write: the row's projection (rail state,
  // `eventId` after a mint), the THREAD (the server writes the
  // `booking_event.place_confirmed` / `…withdrawn` ledger entry in the same
  // transaction), and — after a mint — the agreement's own finalize link.
  const refresh = useCallback(() => {
    void utils.bookingRequests.list.invalidate();
    void utils.bookingRequests.messages.list.invalidate({ bookingRequestId });
    if (agreementId) {
      void utils.bookingAgreements.get.invalidate({ agreementId });
    }
  }, [utils, bookingRequestId, agreementId]);

  const onError = useCallback(
    (err: unknown) => {
      // The organizer moved the event since this thread loaded: nothing was
      // written. Close, refresh so the rail shows the new date, and say so —
      // the next Confirm vouches for what is then on screen.
      if (extractEventMoved(err)) {
        refresh();
        setDialog(null);
        toast.warning({
          id: "venue-confirmation-thread-moved",
          title: String(t("errors.eventMoved")),
        });
        return;
      }
      const notice = venueConfirmationErrorNotice(err);
      if (notice?.tone === "warning") {
        toast.warning({
          id: "venue-confirmation-thread-blocked",
          title: String(t("booking.vcConfirmBlocked")),
          message: String(t(notice.key)),
        });
        return;
      }
      toast.danger({
        id: "venue-confirmation-thread-failed",
        title: String(t("booking.vcActionFailed")),
        message: notice ? String(t(notice.key)) : formatErrorMessage(err, t),
      });
    },
    [toast, t, refresh],
  );

  const confirm = trpc.venueConfirmation.confirm.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      refresh();
      toast.success({
        id: "venue-confirmation-thread-confirmed",
        title: String(t("booking.vcToastConfirmed")),
      });
      setDialog(null);
    },
    onError,
  });
  const withdraw = trpc.venueConfirmation.withdraw.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      refresh();
      toast.success({
        id: "venue-confirmation-thread-withdrawn",
        title: String(t("booking.vcToastWithdrawn")),
      });
      setDialog(null);
    },
    onError,
  });

  const pending = confirm.isPending || withdraw.isPending;

  const openConfirm = useCallback(() => {
    setOwnerSide(defaultOwnerSideForIntent(intent));
    setDialog("confirm");
  }, [intent]);

  const openWithdraw = useCallback(() => {
    setReason("");
    setReasonError(null);
    setDialog("withdraw");
  }, []);

  const closeDialog = useCallback(() => {
    if (pending) return;
    setDialog(null);
  }, [pending]);

  const handleConfirm = useCallback(() => {
    if (pending || cannotVouch) return;
    // The request variant: the server resolves the event the request is
    // about. `ownerOverride` only when this call mints — on an existing
    // event it may only agree with the owner, so it is not sent at all.
    // `expectedStartsAt` is the date the thread shows (see the prop).
    const expectedStartsAt =
      shownStartsAt?.toISOString() ?? NOTHING_ON_SCREEN_STARTS_AT;
    confirm.mutate(
      mints
        ? { bookingRequestId, ownerOverride: ownerSide, expectedStartsAt }
        : { bookingRequestId, expectedStartsAt },
    );
  }, [
    pending,
    cannotVouch,
    shownStartsAt,
    confirm,
    mints,
    bookingRequestId,
    ownerSide,
  ]);

  const handleReasonChange = useCallback((next: string) => {
    setReason(next);
    // Clear on input — the error goes away the moment the reader edits.
    setReasonError(null);
  }, []);

  const handleWithdraw = useCallback(() => {
    if (pending || !venueConfirmation.eventId) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError(String(t("booking.vcWithdrawReasonRequired")));
      document.getElementById(reasonId)?.focus();
      return;
    }
    withdraw.mutate({ eventId: venueConfirmation.eventId, reason: trimmed });
  }, [pending, venueConfirmation.eventId, reason, withdraw, t, reasonId]);

  if (offer === null) return null;

  const testId = `${testIdBase}-venue-confirmation`;
  const stateLineKey =
    STATE_LINE_KEYS[venueConfirmation.state] ?? "booking.vcStateUnconfirmed";

  return (
    <YStack gap="$2" minWidth={0} data-testid={testId}>
      <Text variant="overline" tone="muted">
        {String(t("booking.vcKicker"))}
      </Text>
      <XStack gap="$3" alignItems="center" flexWrap="wrap" minWidth={0}>
        {/* Shrinkable, so at 320px the sentence wraps inside the panel and
            the button drops to its own line instead of pushing past the
            border (Tamagui inherits RN's flexShrink: 0). */}
        <Text
          variant="bodySmall"
          tone="muted"
          flexShrink={1}
          minWidth={0}
          data-testid={`${testId}-state`}
        >
          {String(t(stateLineKey))}
        </Text>
        {/* Secondary: the thread's Send is the one primary in this panel. */}
        {offer === "confirm" ? (
          <Button
            variant="secondary"
            size="$2"
            disabled={pending}
            onPress={openConfirm}
            testID={`${testId}-confirm`}
          >
            <CalendarCheck size={14} strokeWidth={2} aria-hidden />
            {String(t("booking.vcConfirmCta"))}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="$2"
            disabled={pending}
            onPress={openWithdraw}
            testID={`${testId}-withdraw`}
          >
            <CalendarX size={14} strokeWidth={2} aria-hidden />
            {String(t("booking.vcWithdrawCta"))}
          </Button>
        )}
      </XStack>

      {/* Confirm — with the owner choice only when this mints the event. */}
      <Modal open={dialog === "confirm"} onClose={closeDialog}>
        <Modal.Panel width={440} data-testid={`${testId}-confirm-dialog`}>
          <Modal.Header
            title={String(t("booking.vcConfirmTitle"))}
            onClose={closeDialog}
          />
          <Modal.Body>
            <YStack gap="$3">
              <Text variant="body" tone="muted">
                {String(t("booking.vcConfirmNote"))}
              </Text>
              {mints ? (
                <YStack gap="$2">
                  <Text variant="label" id={legendId}>
                    {String(t("booking.vcOwnerLegend"))}
                  </Text>
                  <RadioGroupField
                    value={ownerSide}
                    onValueChange={(next: string) =>
                      setOwnerSide(next === "place" ? "place" : "requester")
                    }
                    aria-labelledby={legendId}
                  >
                    <YStack gap="$3">
                      <Radio
                        value="place"
                        testIdBase={`${testId}-owner-venue`}
                        disabled={pending}
                        label={String(t("booking.vcOwnerVenue"))}
                        description={String(t("booking.vcOwnerVenueDesc"))}
                      />
                      <Radio
                        value="requester"
                        testIdBase={`${testId}-owner-requester`}
                        disabled={pending}
                        label={String(t("booking.vcOwnerRequester"))}
                        description={String(t("booking.vcOwnerRequesterDesc"))}
                      />
                    </YStack>
                  </RadioGroupField>
                </YStack>
              ) : null}
              {venueWithholdsAddress ? (
                // Full ink, in the notice idiom the venue calendar uses for
                // the same rule: this is the consequence of the button below,
                // not background, so it must not read as a muted aside.
                <YStack
                  paddingVertical={10}
                  paddingHorizontal={12}
                  borderLeftWidth={3}
                  borderLeftColor="$accent"
                  backgroundColor="$surfaceMuted"
                >
                  <Text
                    variant="bodySmall"
                    id={addressNoteId}
                    data-testid={`${testId}-address-note`}
                  >
                    {String(t(addressNoteKey))}
                  </Text>
                </YStack>
              ) : null}
            </YStack>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="ghost"
              size="$4"
              onPress={closeDialog}
              disabled={pending}
              testID={`${testId}-confirm-cancel`}
            >
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="primary"
              size="$4"
              onPress={handleConfirm}
              disabled={pending || cannotVouch}
              aria-busy={confirm.isPending}
              // The disclosure is what this press does; a screen reader hears
              // it on the button, not only if it reads the body.
              aria-describedby={
                venueWithholdsAddress ? addressNoteId : undefined
              }
              testID={`${testId}-confirm-submit`}
            >
              {confirm.isPending
                ? String(t("booking.vcConfirming"))
                : String(t("booking.vcConfirmCta"))}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>

      {/* Withdraw — a reason is required; the organizer is told it. */}
      <Modal open={dialog === "withdraw"} onClose={closeDialog}>
        <Modal.Panel width={440} data-testid={`${testId}-withdraw-dialog`}>
          <Modal.Header
            title={String(t("booking.vcWithdrawTitle"))}
            onClose={closeDialog}
          />
          <Modal.Body>
            <YStack gap="$2">
              <label htmlFor={reasonId}>
                <Text variant="label">
                  {String(t("booking.vcWithdrawReasonLabel"))}
                </Text>
              </label>
              <CharCountTextarea
                id={reasonId}
                value={reason}
                onChange={handleReasonChange}
                maxLength={WITHDRAW_REASON_MAX}
                disabled={pending}
                error={Boolean(reasonError)}
                ariaDescribedBy={reasonError ? reasonErrorId : undefined}
                testIdBase={`${testId}-reason`}
              />
              {reasonError ? (
                <Text
                  variant="caption"
                  color="$danger"
                  id={reasonErrorId}
                  role="alert"
                  data-testid={`${testId}-reason-error`}
                >
                  {reasonError}
                </Text>
              ) : null}
              <Text variant="caption" tone="muted">
                {String(t("booking.vcWithdrawReasonHelp"))}
              </Text>
            </YStack>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="ghost"
              size="$4"
              onPress={closeDialog}
              disabled={pending}
              testID={`${testId}-withdraw-cancel`}
            >
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="primary"
              size="$4"
              onPress={handleWithdraw}
              disabled={pending}
              aria-busy={withdraw.isPending}
              testID={`${testId}-withdraw-submit`}
            >
              {withdraw.isPending
                ? String(t("booking.vcWithdrawing"))
                : String(t("booking.vcWithdrawSubmit"))}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>
    </YStack>
  );
}
