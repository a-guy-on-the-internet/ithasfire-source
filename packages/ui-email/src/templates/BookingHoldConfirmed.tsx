import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { holdStyles } from "./booking-hold-styles";

export type BookingHoldConfirmedProps = {
  placeName: string;
  /** Pre-formatted, place-local day ("Thu, Aug 14, 2026"). */
  dateLabel: string;
  /** The act's request / booking view. */
  targetUrl: string;
};

/**
 * Act-facing: the venue confirmed their hold (booking-holds FR-008). The
 * request is accepted and a draft event exists on that date.
 */
export const BookingHoldConfirmed = (
  props: BookingHoldConfirmedProps,
): ReactElement => {
  const { placeName, dateLabel, targetUrl } = props;
  const title = `${placeName} confirmed ${dateLabel}`;

  return (
    <Shell title={title} previewText={`Your date at ${placeName} is booked.`}>
      <Section style={holdStyles.sectionGap}>
        <Text style={holdStyles.eyebrow}>DATE CONFIRMED</Text>
        <Text style={holdStyles.heading}>{title}</Text>
        <Text style={holdStyles.subtitle}>
          Your date is booked. A draft event was created for it, and the place
          will finish the details with you on the request.
        </Text>
      </Section>

      <Section style={holdStyles.card}>
        <Text style={holdStyles.label}>PLACE</Text>
        <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>{placeName}</Text>
        <Text style={holdStyles.label}>DATE</Text>
        <Text style={holdStyles.value}>{dateLabel}</Text>
      </Section>

      <Section style={holdStyles.center}>
        <Button style={holdStyles.primaryButton} href={targetUrl}>
          View your booking
        </Button>
      </Section>

      <Text style={holdStyles.muted}>
        You&apos;re receiving this because you sent a booking request to{" "}
        {placeName} on Ithas Fire.
      </Text>
    </Shell>
  );
};
