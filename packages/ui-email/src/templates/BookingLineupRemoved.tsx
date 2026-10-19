import { Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { holdStyles } from "./booking-hold-styles";

export type BookingLineupRemovedProps = {
  /** Who sent the request and changed the bill. */
  senderName: string;
  /** The venue the request went to. */
  venueName: string;
  /** The group the recipient edits, when the removed act is a group. */
  asGroupName?: string;
  /** The request's nights, pre-formatted by the renderer. May be empty. */
  dateLabels: string[];
};

/** Mirrors the core renderer title (comms/booking-lineup-notice-renderers.ts). */
export function bookingLineupRemovedSubject(props: {
  senderName: string;
  venueName: string;
  asGroupName?: string;
}): string {
  return `${props.senderName} took ${props.asGroupName ?? "you"} off the bill at ${props.venueName}`;
}

/**
 * Act-facing (lineup-booking-requests v3, L5 / FR-012c): the sender took an
 * act that had JOINED off the bill. One calm notice; no link (off the bill,
 * the invite page no longer opens for them). Category "Bills you're on".
 */
export const BookingLineupRemoved = (
  props: BookingLineupRemovedProps,
): ReactElement => {
  const { senderName, venueName, asGroupName, dateLabels } = props;
  const title = bookingLineupRemovedSubject(props);
  const who = asGroupName ?? "you";

  return (
    <Shell
      title={title}
      previewText={`${senderName} changed the bill they pitched to ${venueName}.`}
    >
      <Section style={holdStyles.sectionGap}>
        <Text style={holdStyles.eyebrow}>BILLS YOU&apos;RE ON</Text>
        <Text style={holdStyles.heading}>{title}</Text>
        <Text style={holdStyles.subtitle}>
          {`${senderName} changed the bill they pitched to ${venueName}, and ${who} ${asGroupName ? "is" : "are"} no longer on it.`}
        </Text>
      </Section>

      <Section style={holdStyles.card}>
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

      <Text style={holdStyles.muted}>
        You&apos;re receiving this because {asGroupName ?? "you"} joined a bill
        on Ithas Fire. You can turn off &quot;Bills you&apos;re on&quot; emails
        in your notification settings.
      </Text>
    </Shell>
  );
};
