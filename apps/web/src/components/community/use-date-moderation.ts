"use client";

import { useCallback, useState } from "react";
import { useNotify, useTranslations } from "@th/ui";

import { getAppErrorCode } from "@/lib/app-error";
import { trpc } from "@/trpc";
import { useSecondFactorRequiredToast } from "./use-second-factor-required-toast";

/**
 * The moderator half of the "Upcoming dates" section: whether the person
 * looking may take a night of this listing off, and the two writes that do it.
 *
 * ── WHY THIS IS A SEPARATE, CLIENT-ONLY PROBE ───────────────────────────────
 *
 * The public event page is EDGE-CACHED (`s-maxage=120,
 * stale-while-revalidate=300`) with no `Cookie` in its `Vary`, and
 * `EventPageData` is type-, boundary- AND runtime-guarded against carrying any
 * viewer-scoped field (`assertNoViewerScopedFields`). So "is this reader a
 * moderator" cannot ride the document: put it there and the first moderator to
 * warm a colo hands "Call off" buttons to every anonymous reader served from
 * it for the next five minutes.
 *
 * It therefore arrives the same way the viewer's own RSVP flags do — after
 * first paint, on an uncached request. `community.checkModeratorAccess` is an
 * `authedProcedure` deliberately left OUT of the step-up-2FA allowlist, so it
 * keeps answering for a moderator who has not enrolled a second factor (the
 * one who most needs to be told what to do about it).
 *
 * `enabled` is the caller's HYDRATION + session gate, not an optimisation: on
 * the server render and on the first client render it is `false`, so
 * {@link DateModeration.isModerator} is `false` by premise there — the same
 * discipline that fixed this section's hydration mismatch. A role-derived
 * attribute that skips it reintroduces the mismatch.
 *
 * ── AND WHY FAILURE IS QUIET ────────────────────────────────────────────────
 *
 * `retry: false` plus "only `allowed === true` shows chrome" makes every
 * uncertain answer fail CLOSED: a non-moderator, a signed-out reader, a failed
 * probe and a probe still in flight all render the plain public schedule. The
 * controls are an accelerant, never the only route — `/moderate` is.
 */

export type DateModeration = {
  /** Render the moderator bar and the per-date controls. */
  isModerator: boolean;
  /** Per-date in-flight set — busy + inert that ONE date's controls. */
  pendingIds: ReadonlySet<string>;
  /** Take one night off. Emails everyone holding a live RSVP on it. */
  callOff: (eventDateId: string) => void;
  /** Put a called-off night back on, retracting its pending notices. */
  putBack: (eventDateId: string) => void;
};

export function useDateModeration({
  eventId,
  enabled,
}: {
  eventId: string;
  /**
   * The caller's hydrated-and-signed-in gate. FALSE on the server render and on
   * the first client render, always — see the note above.
   */
  enabled: boolean;
}): DateModeration {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const handleSecondFactorRequired = useSecondFactorRequiredToast();

  const accessQuery = trpc.community.checkModeratorAccess.useQuery(undefined, {
    enabled,
    // The role behind this changes about as often as a staff appointment, and
    // the same answer is already cached by /moderate's shell. Matches the
    // staleTime PasskeysSection invalidates against.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const addPending = useCallback((id: string) => {
    setPendingIds((prev) => new Set(prev).add(id));
  }, []);
  const removePending = useCallback((id: string) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const cancelMut = trpc.community.cancelEventDate.useMutation();
  const restoreMut = trpc.community.restoreEventDate.useMutation();

  /**
   * Both writes share one shape, and it is deliberately NOT optimistic.
   *
   * A call-off moves three things the client cannot recompute: the night's
   * status, which date the section LEADS with (`nextScheduledEventDateId` —
   * the server re-pins `Event.startsAt` in the same transaction), and possibly
   * the whole zero-dates state. Painting a strike-through locally and guessing
   * the rest is how the NEXT card ends up advertising a night that is off. So
   * the row goes busy, the write lands, and the list is re-read.
   */
  const run = useCallback(
    (
      eventDateId: string,
      mutation: typeof cancelMut | typeof restoreMut,
      failureTitle: string,
      /** A specific toast title per server refusal code, over the generic one. */
      titleForCode?: (code: string | null) => string | null,
    ) => {
      if (pendingIds.has(eventDateId)) return;
      addPending(eventDateId);
      mutation.mutate(
        { eventDateId },
        {
          onError: (err) => {
            // The step-up gate is NOT a failure to report as one: this page has
            // no edge gate to have redirected them, so the toast carrying a
            // link to /enroll-2fa is the only thing that tells a moderator what
            // to do. A plain STAFF_ONLY refusal never reaches here — a
            // non-moderator is shown no control to press.
            if (handleSecondFactorRequired(err)) return;
            toast.danger({
              title: titleForCode?.(getAppErrorCode(err)) ?? failureTitle,
            });
          },
          onSettled: () => {
            removePending(eventDateId);
            void utils.community.listEventDates.invalidate({ eventId });
          },
        },
      );
    },
    [
      addPending,
      eventId,
      handleSecondFactorRequired,
      pendingIds,
      removePending,
      toast,
      utils,
    ],
  );

  const callOff = useCallback(
    (eventDateId: string) =>
      run(eventDateId, cancelMut, String(t("rsvp.errCallOffFailed"))),
    [cancelMut, run, t],
  );

  const putBack = useCallback(
    (eventDateId: string) =>
      run(
        eventDateId,
        restoreMut,
        String(t("rsvp.errPutBackFailed")),
        // A cancelled, archived or completed listing refuses every put-back:
        // "try again" would send the moderator round in circles.
        (code) =>
          code === "EVENT_ALREADY_CANCELLED" || code === "EVENT_ARCHIVED"
            ? String(t("rsvp.errPutBackListingTakenDown"))
            : code === "EVENT_ALREADY_COMPLETED"
              ? String(t("rsvp.errPutBackListingEnded"))
              : null,
      ),
    [restoreMut, run, t],
  );

  return {
    // `enabled` is folded in rather than trusted to the query's own gating: a
    // disabled query keeps whatever it last resolved, so a signed-out reader on
    // a soft nav could otherwise inherit the previous viewer's `allowed`.
    isModerator: enabled && accessQuery.data?.allowed === true,
    pendingIds,
    callOff,
    putBack,
  };
}
