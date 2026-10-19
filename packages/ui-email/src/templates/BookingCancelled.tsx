import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { holdStyles } from "./booking-hold-styles";

export type BookingCancelledProps = {
  /** Who cancelled: the venue's name, or the act's. Non-empty. */
  cancelledByName: string;
  /** The booked night, pre-formatted by the renderer ("Fri, Oct 17, 2026"). */
  dateLabel: string;
  /** The canceller's reason (sanitized at the boundary; React escapes it). */
  reason: string;
  /** The booking's event was cancelled with it. */
  eventCancelled: boolean;
  /** The recipient's own view of the request. */
  targetUrl: string;
};

/** Mirrors the core renderer title (comms/renderers.ts, booking.booking-cancelled). */
export function bookingCancelledSubject(props: {
  cancelledByName: string;
  dateLabel: string;
}): string {
  return `${props.cancelledByName} cancelled the booking for ${props.dateLabel}`;
}

/**
 * Both sides of a booking (booking-the-night N13 / FR-009): its booked night
 * was cancelled — terms, booked hold and event together — with the
 * canceller's reason. Ticket buyers hear separately. Hardcoded English, like
 * the other booking templates.
 */
export const BookingCancelled = (props: BookingCancelledProps): ReactElement => {
  const { reason, eventCancelled, targetUrl } = props;
  const title = bookingCancelledSubject(props);
  const lede = eventCancelled
    ? "The night is free again, and the event is cancelled with it."
    : "The night is free again.";

  return (
    <Shell title={title} previewText={lede}>
      <Section style={holdStyles.sectionGap}>
        <Text style={holdStyles.eyebrow}>BOOKING CANCELLED</Text>
        <Text style={holdStyles.heading}>{title}</Text>
        <Text style={holdStyles.subtitle}>{lede}</Text>
      </Section>

      <Section style={holdStyles.card}>
        <Text style={holdStyles.label}>THEIR REASON</Text>
        <Text style={{ ...holdStyles.value, whiteSpace: "pre-wrap" }}>
          {reason}
        </Text>
      </Section>

      {eventCancelled ? (
        <Text style={holdStyles.body}>
          Anyone who bought a ticket hears from us about the cancellation and
          their refund.
        </Text>
      ) : null}

      <Section style={holdStyles.center}>
        <Button style={holdStyles.primaryButton} href={targetUrl}>
          View the request
        </Button>
      </Section>

      <Text style={holdStyles.muted}>
        You&apos;re receiving this because you&apos;re part of this booking on
        Ithas Fire.
      </Text>
    </Shell>
  );
};
