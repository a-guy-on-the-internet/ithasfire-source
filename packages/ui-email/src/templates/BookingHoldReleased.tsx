import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { holdStyles } from "./booking-hold-styles";

export type BookingHoldReleaseReason =
  | "released"
  | "request_closed"
  | "sibling_confirmed"
  | "lost_date"
  | "expired"
  | "event_scheduled";

export type BookingHoldReleasedProps = {
  reason: BookingHoldReleaseReason;
  placeName: string;
  /** Pre-formatted, place-local day ("Thu, Aug 14, 2026"). */
  dateLabel: string;
  /** The act's request view. */
  targetUrl: string;
};

const copyFor = (
  reason: BookingHoldReleaseReason,
  placeName: string,
  dateLabel: string,
): { title: string; lede: string; eyebrow: string } => {
  switch (reason) {
    case "lost_date":
      return {
        eyebrow: "DATE TAKEN",
        title: `${dateLabel} at ${placeName} went to another act`,
        lede: "Your hold on this date was released. Your request stays open, so you can propose another date in the thread.",
      };
    case "expired":
      return {
        eyebrow: "HOLD LAPSED",
        title: `Your hold on ${dateLabel} at ${placeName} lapsed`,
        lede: "The deadline to keep or release passed without an answer, so the hold was released. Your request is still open.",
      };
    case "sibling_confirmed":
      return {
        eyebrow: "HOLD RELEASED",
        title: `Your hold on ${dateLabel} at ${placeName} was released`,
        lede: "Your booking was confirmed for a different date, so this hold is no longer needed.",
      };
    case "request_closed":
      return {
        eyebrow: "HOLD RELEASED",
        title: `Your hold on ${dateLabel} at ${placeName} was released`,
        lede: "The request was closed, so the hold went with it.",
      };
    case "event_scheduled":
      return {
        eyebrow: "HOLD RELEASED",
        title: `Your hold on ${dateLabel} at ${placeName} was released`,
        lede: `${placeName} scheduled an event on that date, so the hold was released. Your request is still open.`,
      };
    case "released":
    default:
      return {
        eyebrow: "HOLD RELEASED",
        title: `Your hold on ${dateLabel} at ${placeName} was released`,
        lede: `${placeName} released the hold. Your request is still open.`,
      };
  }
};

/**
 * Act-facing: a hold left the line (booking-holds FR-006 / FR-007 / FR-008
 * / FR-009 / FR-018). One template, six reasons — the reason picks the sentence.
 * Never names another act.
 */
export const BookingHoldReleased = (props: BookingHoldReleasedProps): ReactElement => {
  const { reason, placeName, dateLabel, targetUrl } = props;
  const { title, lede, eyebrow } = copyFor(reason, placeName, dateLabel);

  return (
    <Shell title={title} previewText={lede}>
      <Section style={holdStyles.sectionGap}>
        <Text style={holdStyles.eyebrow}>{eyebrow}</Text>
        <Text style={holdStyles.heading}>{title}</Text>
        <Text style={holdStyles.subtitle}>{lede}</Text>
      </Section>

      <Section style={holdStyles.card}>
        <Text style={holdStyles.label}>PLACE</Text>
        <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>{placeName}</Text>
        <Text style={holdStyles.label}>DATE</Text>
        <Text style={holdStyles.value}>{dateLabel}</Text>
      </Section>

      <Section style={holdStyles.center}>
        <Button style={holdStyles.primaryButton} href={targetUrl}>
          View your request
        </Button>
      </Section>

      <Text style={holdStyles.muted}>
        You&apos;re receiving this because you sent a booking request to{" "}
        {placeName} on Ithas Fire.
      </Text>
    </Shell>
  );
};
