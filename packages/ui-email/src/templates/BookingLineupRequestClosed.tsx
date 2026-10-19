import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { holdStyles } from "./booking-hold-styles";

export type BookingLineupRequestClosedProps = {
  /** Who sent the request (the sender, never an act on the bill). */
  senderName: string;
  /** The venue the request went to. */
  venueName: string;
  /** The group the recipient edits, when the joined act is a group. */
  asGroupName?: string;
  /** The request's nights, pre-formatted by the renderer. May be empty. */
  dateLabels: string[];
  /** The invite page, which shows the request as closed. */
  targetUrl: string;
};

/** Mirrors the core renderer title (comms/booking-lineup-notice-renderers.ts). */
export function bookingLineupRequestClosedSubject(props: {
  venueName: string;
}): string {
  return `The request to ${props.venueName} isn't going ahead`;
}

/**
 * Act-facing (lineup-booking-requests v3, L7 / FR-012b): a request the act
 * JOINED was declined, withdrawn or expired. Says only that it is not going
 * ahead — never why: the venue's reason never reaches an act. Category
 * "Bills you're on" (the footer says it can be switched off). Hardcoded
 * English, like the other booking templates.
 */
export const BookingLineupRequestClosed = (
  props: BookingLineupRequestClosedProps,
): ReactElement => {
  const { senderName, venueName, asGroupName, dateLabels, targetUrl } = props;
  const title = bookingLineupRequestClosedSubject(props);
  const onBill = asGroupName
    ? `with ${asGroupName} on the bill`
    : "with you on the bill";

  return (
    <Shell
      title={title}
      previewText={`${senderName}'s request to ${venueName} isn't going ahead.`}
    >
      <Section style={holdStyles.sectionGap}>
        <Text style={holdStyles.eyebrow}>BILLS YOU&apos;RE ON</Text>
        <Text style={holdStyles.heading}>{title}</Text>
        <Text style={holdStyles.subtitle}>
          {`${senderName}'s request to ${venueName}, ${onBill}, isn't going ahead.`}
        </Text>
      </Section>

      <Section style={holdStyles.card}>
        <Text style={holdStyles.label}>FROM</Text>
        <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>
          {senderName}
        </Text>
        <Text style={holdStyles.label}>PLACE</Text>
        <Text
          style={{
            ...holdStyles.value,
            marginBottom: dateLabels.length > 0 ? "12px" : 0,
          }}
        >
          {venueName}
        </Text>
        {dateLabels.length > 0 && (
          <>
            <Text style={holdStyles.label}>DATES</Text>
            {dateLabels.map((label, index) => (
              <Text
                key={`${label}-${index}`}
                style={{ ...holdStyles.value, marginBottom: "4px" }}
              >
                {label}
              </Text>
            ))}
          </>
        )}
      </Section>

      <Text style={holdStyles.body}>There&apos;s nothing you need to do.</Text>

      <Section style={holdStyles.center}>
        <Button style={holdStyles.primaryButton} href={targetUrl}>
          View the request
        </Button>
      </Section>

      <Text style={holdStyles.muted}>
        You&apos;re receiving this because {asGroupName ?? "you"} joined a bill
        on Ithas Fire. You can turn off &quot;Bills you&apos;re on&quot; emails
        in your notification settings.
      </Text>
    </Shell>
  );
};
