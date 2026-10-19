import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { holdStyles } from "./booking-hold-styles";

export type BookingRequestRespondedAction = "accepted" | "declined" | "closed";

export type BookingRequestRespondedProps = {
  /**
   * Who answered: the venue's name on a request to a venue, the act's name
   * on an organiser's request to an act. Caller-resolved, non-empty.
   */
  responderName: string;
  action: BookingRequestRespondedAction;
  /**
   * The responder's reason on a decline or a close (sanitized plain text at
   * the use case's input boundary; React escapes it here). Absent on accept.
   */
  reason?: string;
  /**
   * What happens next on an accept: `terms_coming` (a venue accepted; terms
   * follow) or `agreement_ready` (an act accepted an organiser's request; a
   * draft agreement is open to both). Ignored otherwise.
   */
  acceptedNext?: "terms_coming" | "agreement_ready";
  /** Where the sender sees the request (or its agreement). */
  targetUrl: string;
};

/** Mirrors the core renderer title (comms/renderers.ts, booking.request-responded). */
export function bookingRequestRespondedSubject(props: {
  responderName: string;
  action: BookingRequestRespondedAction;
}): string {
  switch (props.action) {
    case "accepted":
      return `${props.responderName} accepted your booking request`;
    case "declined":
      return `${props.responderName} declined your booking request`;
    case "closed":
      return `${props.responderName} closed your booking request`;
  }
}

function ledeFor(props: BookingRequestRespondedProps): string {
  switch (props.action) {
    case "accepted":
      return props.acceptedNext === "agreement_ready"
        ? "A draft agreement is open for you both. Open it to work out the terms together."
        : "They'll send terms for a night. You'll hear from us when the terms are ready for you to agree.";
    case "declined":
      return "This request won't go ahead.";
    case "closed":
      return "They accepted this request earlier and have now closed it. It won't go ahead, and its holds were released.";
  }
}

/**
 * Sent to whoever SENT a booking request when the other side answers it
 * (booking-the-night N9 / FR-008): a venue accepting, declining or closing a
 * request an act sent it, or an act accepting or declining an organiser's
 * request. One template for both directions (the organiser variant folds into
 * it). Carries the responder's reason on a decline or close. Hardcoded
 * English, like the other booking templates.
 */
export const BookingRequestResponded = (
  props: BookingRequestRespondedProps,
): ReactElement => {
  const { action, reason, targetUrl } = props;
  const title = bookingRequestRespondedSubject(props);
  const lede = ledeFor(props);
  const buttonLabel =
    action === "accepted" && props.acceptedNext === "agreement_ready"
      ? "Open the agreement"
      : "View the request";

  return (
    <Shell title={title} previewText={lede}>
      <Section style={holdStyles.sectionGap}>
        <Text style={holdStyles.eyebrow}>BOOKING REQUEST</Text>
        <Text style={holdStyles.heading}>{title}</Text>
        <Text style={holdStyles.subtitle}>{lede}</Text>
      </Section>

      {reason ? (
        <Section style={holdStyles.card}>
          <Text style={holdStyles.label}>THEIR REASON</Text>
          <Text style={{ ...holdStyles.value, whiteSpace: "pre-wrap" }}>
            {reason}
          </Text>
        </Section>
      ) : null}

      <Section style={holdStyles.center}>
        <Button style={holdStyles.primaryButton} href={targetUrl}>
          {buttonLabel}
        </Button>
      </Section>

      <Text style={holdStyles.muted}>
        You&apos;re receiving this because you sent this booking request on
        Ithas Fire.
      </Text>
    </Shell>
  );
};
