"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { YStack } from "tamagui";
import {
  Button,
  CharCountTextarea,
  Modal,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { extractEventMoved } from "@/lib/event-moved-error";
import { formatErrorMessage } from "@/lib/format-error-message";

// ─────────────────────────────────────────────────────────────────────────────
// Venue-side decision on a third-party listing at this venue
// (venue-confirmation spec, docs/specs/2026-08-27 "Venue calendar").
//
// Opens from a THIRD-PARTY chip. Two modes, one dialog:
//   Unconfirmed —
//   · Confirm — stamps the event; it may now say the venue's name in public
//     and it now blocks this calendar. One press, no form.
//   · Not mine — a required plain-text reason (the organizer is told why),
//     then `withdraw`. The event keeps its place, stays address-only and
//     keeps not blocking. Valid on a never-confirmed event too, and
//     idempotent on the same reason.
//   Confirmed (third-party) —
//   · Withdraw confirmation — the undo for a mis-click on Confirm and the
//     calendar-side home of the spec's withdraw action: straight to the
//     reason step, same textarea and validation, same `withdraw` call.
//
// Authority (venue staff / booking grant), the venue-owned refusal and the
// ledger all live in the use cases; this surface only orchestrates. A
// withdrawn event comes back `venueConfirmed:false` and renders exactly as it
// did before, so both actions stay offered after either succeeds.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `reason` bound on `withdrawVenueConfirmationInputSchema` ("Not mine"
 * withdraws): core's `BOOKING_REASON_MAX` (1000; FR-013). A literal so this
 * client component does not import core's booking-thread module.
 */
export const NOT_MINE_REASON_MAX = 1000;

export type VenueEventConfirmTarget = {
  id: string;
  title: string | null;
  startsAt: Date | null;
  /** `true` ⇒ the withdraw-only mode; `false` ⇒ Confirm / Not mine. */
  venueConfirmed: boolean;
};

export interface VenueEventConfirmDialogProps {
  /** The unconfirmed event under decision; `null` renders nothing. */
  event: VenueEventConfirmTarget | null;
  onClose: () => void;
  /**
   * The venue hides its address (anything but EXACT). Confirming is then
   * also a disclosure: it is the step that releases the street to this
   * event's ticket holders, a day before the start. The caller passes TRUE
   * while the venue's setting is unknown, so the line is never missing from
   * a confirm that shares an address.
   */
  venueWithholdsAddress?: boolean;
}

type Step = "choose" | "reason";

export function VenueEventConfirmDialog({
  event,
  onClose,
  venueWithholdsAddress = false,
}: VenueEventConfirmDialogProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const [step, setStep] = useState<Step>("choose");
  /**
   * The organizer moved the event after this dialog opened (EVENT_MOVED) and
   * the dialog now shows the NEW start. Stays up until the next open so the
   * venue reads why the date under the title changed before it confirms.
   */
  const [moved, setMoved] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reasonId = useId();
  const reasonErrorId = `${reasonId}-error`;
  const addressNoteId = `${reasonId}-address`;

  // The Modal stays MOUNTED through close (`open` flips instead): its
  // focus-restore and exit transition run on the open→closed edge and have
  // no unmount cleanup, so unmounting would drop focus on <body>. The last
  // target keeps the content drawn while the dialog is on its way out.
  //
  // Adjust-state-during-render: on every OPEN (a fresh target object per
  // press) the form resets so a half-typed reason never leaks onto the next
  // event — and not on close, which would flip the content mid-exit.
  const [prevEvent, setPrevEvent] = useState(event);
  const [shown, setShown] = useState(event);
  if (event !== prevEvent) {
    setPrevEvent(event);
    if (event) {
      setShown(event);
      setStep("choose");
      setMoved(false);
      setReason("");
      setReasonError(null);
    }
  }

  // Modal.Panel places focus on mount only; the reason step swaps content
  // inside the already-open dialog, so it manages its own focus move.
  useEffect(() => {
    if (step !== "reason") return;
    const raf = requestAnimationFrame(() => {
      document.getElementById(reasonId)?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [step, reasonId]);

  // Both admin reads carry the flag; refresh both so the calendar page and
  // the per-calendar month (holds strip) never disagree about one event.
  const refresh = useCallback(
    () =>
      Promise.all([
        utils.places.getVenueCalendar.invalidate(),
        utils.places.getCalendarEventsAdmin.invalidate(),
      ]),
    [utils],
  );

  const onError = useCallback(
    (err: unknown) => {
      toast.danger({
        id: "venue-confirmation-failed",
        title: String(t("admin.venueCalActionFailed")),
        message: formatErrorMessage(err, t),
      });
    },
    [toast, t],
  );

  // EVENT_MOVED: the organizer moved the show after this dialog opened, and
  // a confirmation vouches for a DATE, so the server refused and wrote
  // nothing. Refresh the calendar either way. When the error names the new
  // start, the dialog switches to it and says why — the next Confirm then
  // vouches for what is on screen. When it cannot (the move was caught by the
  // write itself), the dialog closes so the venue reopens the event from the
  // refreshed calendar rather than confirming a date nobody has shown it.
  const onConfirmError = useCallback(
    (err: unknown) => {
      const movedTo = extractEventMoved(err);
      if (!movedTo) {
        onError(err);
        return;
      }
      void refresh();
      if (movedTo.startsAt) {
        const startsAt = movedTo.startsAt;
        setShown((prev) => (prev ? { ...prev, startsAt } : prev));
        setMoved(true);
        return;
      }
      toast.warning({
        id: "venue-confirmation-moved",
        title: String(t("errors.eventMoved")),
      });
      onClose();
    },
    [onError, refresh, toast, t, onClose],
  );

  // Success is otherwise silent: after "Not mine" the event stays listed
  // as unconfirmed with both actions (spec), so nothing visible changes.
  const confirm = trpc.venueConfirmation.confirm.useMutation({
    onSuccess: () => {
      void refresh();
      toast.success({
        id: "venue-confirmation-confirmed",
        title: String(t("admin.venueCalConfirmed")),
      });
      onClose();
    },
    onError: onConfirmError,
  });
  const withdraw = trpc.venueConfirmation.withdraw.useMutation({
    onSuccess: () => {
      void refresh();
      toast.success({
        id: "venue-confirmation-not-mine",
        title: String(
          t(
            shown?.venueConfirmed
              ? "admin.venueCalWithdrawn"
              : "admin.venueCalNotMineDone",
          ),
        ),
      });
      onClose();
    },
    onError,
  });

  const pending = confirm.isPending || withdraw.isPending;

  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [pending, onClose]);

  // A confirmation vouches for the date ON SCREEN: `shown.startsAt` is the
  // value the subtitle renders (the opened target, or the new start after an
  // EVENT_MOVED), never a refetch the venue hasn't seen.
  const handleConfirm = useCallback(() => {
    if (!event || !shown?.startsAt || pending) return;
    confirm.mutate({
      eventId: shown.id,
      expectedStartsAt: shown.startsAt.toISOString(),
    });
  }, [event, shown, pending, confirm]);

  const handleReasonChange = useCallback((next: string) => {
    setReason(next);
    // Clear on input — the error goes away the moment the reader edits.
    setReasonError(null);
  }, []);

  const handleWithdraw = useCallback(() => {
    if (!event || pending) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError(String(t("admin.venueCalNotMineReasonRequired")));
      document.getElementById(reasonId)?.focus();
      return;
    }
    withdraw.mutate({ eventId: event.id, reason: trimmed });
  }, [event, pending, reason, withdraw, t, reasonId]);

  // Never opened: nothing to draw yet.
  if (!shown) return null;

  const withdrawOnly = shown.venueConfirmed;
  // Only on the CONFIRM side: withdrawing takes the address back, it
  // shares nothing.
  const showAddressNote = !withdrawOnly && venueWithholdsAddress;
  const title = shown.title ?? String(t("admin.ecUntitled"));
  const when = shown.startsAt
    ? fmt.dateTime(shown.startsAt, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : undefined;

  return (
    <Modal open={event !== null} onClose={handleClose}>
      <Modal.Panel width={440} data-testid="venue-event-confirm-dialog">
        <Modal.Header title={title} subtitle={when} onClose={handleClose} />
        <Modal.Body>
          {step === "choose" ? (
            <YStack gap="$2">
              {moved && !withdrawOnly && (
                <Text
                  variant="bodySmall"
                  role="alert"
                  data-testid="venue-event-confirm-moved"
                >
                  {String(t("errors.eventMoved"))}
                </Text>
              )}
              <Text variant="overline" tone="muted">
                {String(
                  t(
                    withdrawOnly
                      ? "admin.venueCalConfirmedByVenue"
                      : "admin.venueCalUnconfirmed",
                  ),
                )}
              </Text>
              <Text variant="body" tone="muted">
                {String(
                  t(
                    withdrawOnly
                      ? "admin.venueCalConfirmedHelp"
                      : "admin.venueCalUnconfirmedHelp",
                  ),
                )}
              </Text>
              {showAddressNote && (
                // Full ink, in the notice idiom the builder uses for the same
                // rule: this is the consequence of the button below, not
                // background, so it must not read as a muted aside.
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
                    data-testid="venue-event-confirm-address-note"
                  >
                    {String(t("admin.venueCalConfirmSharesAddress"))}
                  </Text>
                </YStack>
              )}
            </YStack>
          ) : (
            <YStack gap="$2">
              <label htmlFor={reasonId}>
                <Text variant="label">
                  {String(t("admin.venueCalNotMineReasonLabel"))}
                </Text>
              </label>
              <CharCountTextarea
                id={reasonId}
                value={reason}
                onChange={handleReasonChange}
                maxLength={NOT_MINE_REASON_MAX}
                disabled={pending}
                error={Boolean(reasonError)}
                ariaDescribedBy={reasonError ? reasonErrorId : undefined}
                testIdBase="venue-event-not-mine-reason"
              />
              {reasonError && (
                <Text
                  variant="caption"
                  color="$danger"
                  id={reasonErrorId}
                  role="alert"
                  data-testid="venue-event-not-mine-reason-error"
                >
                  {reasonError}
                </Text>
              )}
              {!withdrawOnly && (
                <Text variant="caption" tone="muted">
                  {String(t("admin.venueCalNotMineHelp"))}
                </Text>
              )}
            </YStack>
          )}
        </Modal.Body>
        <Modal.Footer>
          {step === "choose" && withdrawOnly ? (
            <>
              <Button
                variant="ghost"
                size="$4"
                onPress={handleClose}
                disabled={pending}
                data-testid="venue-event-cancel"
              >
                {String(t("admin.cancel"))}
              </Button>
              <Button
                variant="primary"
                size="$4"
                onPress={() => setStep("reason")}
                disabled={pending}
                data-testid="venue-event-withdraw"
              >
                {String(t("admin.venueCalWithdraw"))}
              </Button>
            </>
          ) : step === "choose" ? (
            <>
              <Button
                variant="secondary"
                size="$4"
                onPress={() => setStep("reason")}
                disabled={pending}
                data-testid="venue-event-not-mine"
              >
                {String(t("admin.venueCalNotMine"))}
              </Button>
              <Button
                variant="primary"
                size="$4"
                onPress={handleConfirm}
                // No start on screen, nothing to vouch for.
                disabled={pending || !shown.startsAt}
                aria-busy={confirm.isPending}
                // The disclosure is what this press does; a screen reader
                // hears it on the button, not only if it reads the body.
                aria-describedby={showAddressNote ? addressNoteId : undefined}
                data-testid="venue-event-confirm"
              >
                {confirm.isPending
                  ? String(t("admin.venueCalConfirming"))
                  : String(t("admin.venueCalConfirm"))}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="$4"
                onPress={() => setStep("choose")}
                disabled={pending}
                data-testid="venue-event-not-mine-back"
              >
                {String(t("admin.venueCalBack"))}
              </Button>
              <Button
                variant="primary"
                size="$4"
                onPress={handleWithdraw}
                disabled={pending}
                aria-busy={withdraw.isPending}
                data-testid={
                  withdrawOnly
                    ? "venue-event-withdraw-submit"
                    : "venue-event-not-mine-submit"
                }
              >
                {withdrawOnly
                  ? withdraw.isPending
                    ? String(t("admin.venueCalWithdrawing"))
                    : String(t("admin.venueCalWithdraw"))
                  : withdraw.isPending
                    ? String(t("admin.venueCalNotMineSending"))
                    : String(t("admin.venueCalNotMineSubmit"))}
              </Button>
            </>
          )}
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
