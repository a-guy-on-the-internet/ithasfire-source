"use client";

import type { CSSProperties, Ref } from "react";
import { useFormatters, useTranslations } from "@th/ui";

import { leftOrderUsuallyReleasedBy } from "./embed-payment-order";
import { TEXT, WARNING_BG } from "./embed-theme";
import { useCountdown } from "./useCountdown";

// ─────────────────────────────────────────────────────────────────────────────
// What the widget tells the buyer about the order behind the payment step,
// on the screens that do not show the payment form: that their tickets are
// reserved while they look at the event again (and the control that lets
// them go), and why an order they had is gone. Without these the order
// appears and disappears in silence.
// ─────────────────────────────────────────────────────────────────────────────

const noticeStyle: CSSProperties = {
  margin: 0,
  background: WARNING_BG,
  padding: "10px 14px",
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.5,
  color: TEXT,
};

// "Let these tickets go": a text button inside the band, in the band's own
// colour. No fill and no border, so it reads as part of the notice. The
// 44px is the tap target; the negative margin lets it use the band's bottom
// padding, so the band grows by the button and no more. The focus ring is
// the app's own (`:focus-visible` in globals.css, in the host's accent).
const letGoStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  minHeight: 44,
  margin: "0 0 -10px",
  padding: 0,
  border: "none",
  borderRadius: 0,
  background: "transparent",
  color: "inherit",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.5,
  textAlign: "left",
  textDecoration: "underline",
  cursor: "pointer",
};

/**
 * Why the order the buyer had is gone. "released": they let its tickets go
 * themselves (`EmbedReservedNotice`'s control).
 */
export type EmbedOrderNoticeKind = "changed" | "expired" | "released";

type Translate = ReturnType<typeof useTranslations>;
/** A time on the clock, in the viewer's locale and time zone. */
type ClockTime = (at: string) => string;

function useClockTime(): ClockTime {
  const { dateTime } = useFormatters();
  return (at) => dateTime(at, { hour: "numeric", minute: "2-digit" });
}

/**
 * On the event detail while an order is waiting to be paid: how long the
 * buyer has to pay for it, and that changing the tickets starts a new order
 * and puts these back on sale.
 *
 * With `onLetGo`, the control that gives the tickets back now. The widget
 * leaves it out for an order a payment may have gone through on. While the
 * release is out (`lettingGo`) the button says so and takes no second press;
 * it is `aria-disabled`, not `disabled`, so it keeps focus. A release that
 * did not happen (`letGoFailed`) is said in the line above the button, and
 * the button is there to press again.
 *
 * The countdown sentence is not a live region: it changes every second, and
 * a screen reader would read the whole sentence again each time. The line
 * that says a release failed is one, and is in the page before it has
 * anything to say, so the text arriving in it is announced.
 */
export function EmbedReservedNotice({
  reservedUntil,
  onLetGo,
  lettingGo = false,
  letGoFailed = false,
  letGoRef,
}: {
  reservedUntil: string | null;
  onLetGo?: () => void;
  lettingGo?: boolean;
  letGoFailed?: boolean;
  /**
   * The button itself. The widget compares it with the focused element when
   * a press has released the order, to move focus on from a button that is
   * about to go.
   */
  letGoRef?: Ref<HTMLButtonElement>;
}) {
  const t = useTranslations();
  const { countdown, isExpired } = useCountdown(reservedUntil);
  // No clock yet, or it has run out (the widget discards the order then).
  if (!countdown || isExpired) return null;
  return (
    <div style={noticeStyle}>
      <p style={{ margin: 0 }}>
        {String(t("checkout.embedTicketsReserved", { countdown }))}
      </p>
      {onLetGo && (
        <>
          <p role="status" style={{ margin: 0 }}>
            {letGoFailed && !lettingGo
              ? String(t("checkout.embedLetTicketsGoFailed"))
              : null}
          </p>
          <button
            ref={letGoRef}
            type="button"
            onClick={lettingGo ? undefined : onLetGo}
            aria-disabled={lettingGo || undefined}
            style={{
              ...letGoStyle,
              ...(lettingGo
                ? { textDecoration: "none", cursor: "default" }
                : {}),
            }}
          >
            {String(
              t(
                lettingGo
                  ? "checkout.embedLetTicketsGoBusy"
                  : "checkout.embedLetTicketsGo",
              ),
            )}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * After an order was left behind: why it is gone, and what is still true of
 * it. Each sentence is said only while it holds:
 *
 * - "You have not been charged" is left out when a payment on any order may
 *   have gone through, or did (`mayHaveBeenCharged`).
 * - A reservation that ran out invites the buyer to reserve again. When a
 *   payment's outcome is still unknown (`outcomeUnknown`), the invitation
 *   comes with the reminder to check their email first: past this point
 *   nothing stops a second purchase of the same tickets. An earlier order
 *   the server has since said was paid is not "unknown": the widget says
 *   that one plainly in its own banner.
 * - Tickets the buyer let go themselves ("released") are back on sale, and
 *   "You have not been charged" follows by the same rule as above.
 * - The earlier order's tickets staying reserved is said while the server
 *   can still be holding them (`earlierReservedUntil`, non-null for exactly
 *   that long; see `leftOrderReservedUntil`). That is an order the widget
 *   could not release, so until then its tickets can show as unavailable to
 *   the buyer who reserved them. Said as a fact about their own order, never
 *   as a guess at why a particular ticket is unavailable.
 * - An earlier order the server did release is said as that
 *   (`earlierReleased`). The widget passes it only when no other earlier
 *   order is still reserved: the two sentences side by side would read as a
 *   contradiction.
 *
 * `kind` is null when there is nothing to say about the order itself (the
 * buyer left the event and came back) but something is still true of its
 * tickets.
 *
 * `noticeRef`: the widget moves focus here when the buyer's own press made
 * the order go (the control they pressed is gone with it).
 */
export function EmbedOrderNotice({
  kind,
  mayHaveBeenCharged,
  outcomeUnknown = mayHaveBeenCharged,
  earlierReservedUntil,
  earlierReleased = false,
  noticeRef,
}: {
  kind: EmbedOrderNoticeKind | null;
  mayHaveBeenCharged: boolean;
  /** Some payment's outcome is still unknown. Defaults to `mayHaveBeenCharged`. */
  outcomeUnknown?: boolean;
  earlierReservedUntil: string | null;
  earlierReleased?: boolean;
  noticeRef?: Ref<HTMLParagraphElement>;
}) {
  const t = useTranslations();
  const clockTime = useClockTime();
  const sentences = [
    kind === "expired" ? String(t("checkout.embedReservationRanOut")) : null,
    kind === "expired" && outcomeUnknown
      ? String(t("checkout.embedPaymentOutcomeUnknown"))
      : null,
    kind === "changed" ? String(t("checkout.embedOrderChanged")) : null,
    kind === "released" ? String(t("checkout.embedTicketsReleased")) : null,
    (kind === "changed" || kind === "released") && !mayHaveBeenCharged
      ? String(t("checkout.embedNotCharged"))
      : null,
    earlierOrderSentence(t, clockTime, earlierReservedUntil),
    earlierReleased ? String(t("checkout.embedEarlierOrderReleased")) : null,
  ].filter((sentence): sentence is string => sentence !== null);
  if (sentences.length === 0) return null;
  return (
    // Focusable by script only (`tabIndex={-1}`), and with no ring: it is a
    // sentence, not a control.
    <p
      ref={noticeRef}
      tabIndex={-1}
      role="status"
      style={{ ...noticeStyle, outline: "none" }}
    >
      {sentences.join(" ")}
    </p>
  );
}

/**
 * Beside a refused checkout while an order the buyer left still has its
 * tickets reserved: the same fact, where they are looking. The server's own
 * error is printed as it came; this does not say which of the two it was.
 */
export function EmbedEarlierOrderNote({
  reservedUntil,
}: {
  /** The latest the earlier order can keep its tickets. */
  reservedUntil: string;
}) {
  const t = useTranslations();
  const clockTime = useClockTime();
  const sentence = earlierOrderSentence(t, clockTime, reservedUntil);
  if (sentence === null) return null;
  return (
    <p role="status" style={noticeStyle}>
      {sentence}
    </p>
  );
}

/** Null when there is no earlier order to speak of, or no readable time. */
function earlierOrderSentence(
  t: Translate,
  clockTime: ClockTime,
  reservedUntil: string | null,
): string | null {
  const typical = leftOrderUsuallyReleasedBy(reservedUntil);
  if (!reservedUntil || !typical) return null;
  return String(
    t("checkout.embedEarlierOrderReserved", {
      typicalTime: clockTime(typical),
      latestTime: clockTime(reservedUntil),
    }),
  );
}
