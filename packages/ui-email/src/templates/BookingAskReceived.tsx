import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { holdStyles } from "./booking-hold-styles";

export type BookingAskReceivedProps = {
  /** The venue's name. Non-empty. */
  venueName: string;
  /** What the venue asked for, in its own words (sanitized; React escapes it). */
  label: string;
  /** The venue's optional note (sanitized; React escapes it). */
  note?: string;
  /** How to answer, in words, from the renderer ("a file", "a link"). */
  answerPhrase: string;
  /** The recipient's own view of the request. */
  targetUrl: string;
};

/** Mirrors the core renderer title (comms/renderers.ts, booking.ask-received). */
export function bookingAskReceivedSubject(props: {
  venueName: string;
  label: string;
}): string {
  return `${props.venueName} asked you for: ${props.label}`;
}

/**
 * The sender side of a booking (venue-booking-standards v1.1 FR-009b): the
 * venue asked for one thing the night needs — a poster, a rider, a set
 * length. The answer is given on the request. Hardcoded English, like the
 * other booking templates.
 */
export const BookingAskReceived = (
  props: BookingAskReceivedProps,
): ReactElement => {
  const { note, answerPhrase, targetUrl } = props;
  const title = bookingAskReceivedSubject(props);
  const lede = `Answer with ${answerPhrase} on the request.`;

  return (
    <Shell title={title} previewText={lede}>
      <Section style={holdStyles.sectionGap}>
        <Text style={holdStyles.eyebrow}>THE PLACE ASKED</Text>
        <Text style={holdStyles.heading}>{title}</Text>
        <Text style={holdStyles.subtitle}>{lede}</Text>
      </Section>

      {note ? (
        <Section style={holdStyles.card}>
          <Text style={holdStyles.label}>THEIR NOTE</Text>
          <Text style={{ ...holdStyles.value, whiteSpace: "pre-wrap" }}>
            {note}
          </Text>
        </Section>
      ) : null}

      <Section style={holdStyles.center}>
        <Button style={holdStyles.primaryButton} href={targetUrl}>
          Answer the ask
        </Button>
      </Section>

      <Text style={holdStyles.muted}>
        You&apos;re receiving this because you&apos;re part of this booking on
        Ithas Fire.
      </Text>
    </Shell>
  );
};
