import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { holdStyles } from "./booking-hold-styles";

export type BookingLineupInvitedProps = {
  /** Who pitched the bill (the sender of the request). */
  senderName: string;
  /** The venue the bill was pitched to. */
  venueName: string;
  /**
   * Lineup v3 (L17): the tagged GROUP this recipient edits, when the bill
   * names a group rather than the recipient. The invite then says which
   * group it is for. Absent for a tagged person.
   */
  asGroupName?: string;
  /**
   * The nights the request asks about, pre-formatted by the renderer
   * ("Fri, Aug 14, 2026" / "… at 8:00 PM"). May be empty.
   */
  dateLabels: string[];
  /** The one-tap join / pass page for this request. */
  targetUrl: string;
};

/**
 * Act-facing: a sender tagged this act onto a bill they pitched to a venue
 * (lineup-booking-requests v2 FR-003, v3 L17). Calm on purpose (NFR-002): it
 * says who and where, that the answer is theirs, and that it takes one tap —
 * no deadline, no urgency. Join / pass, never "confirm" (CONTEXT.md).
 * Hardcoded English copy, like the other booking templates; styles shared
 * with the booking-hold family.
 */
export const BookingLineupInvited = (
  props: BookingLineupInvitedProps,
): ReactElement => {
  const { senderName, venueName, asGroupName, dateLabels, targetUrl } = props;
  const who = asGroupName ?? "you";
  const title = `${senderName} added ${who} to a bill at ${venueName}`;
  const pitched = `They pitched ${venueName} with ${who} on the bill.`;

  return (
    <Shell
      title={title}
      previewText={`${senderName} pitched ${venueName} with ${who} on the bill.`}
    >
      <Section style={holdStyles.sectionGap}>
        <Text style={holdStyles.eyebrow}>ON THE BILL</Text>
        <Text style={holdStyles.heading}>{title}</Text>
        <Text style={holdStyles.subtitle}>{pitched}</Text>
      </Section>

      <Section style={holdStyles.card}>
        <Text style={holdStyles.label}>FROM</Text>
        <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>
          {senderName}
        </Text>
        {asGroupName ? (
          <>
            <Text style={holdStyles.label}>FOR</Text>
            <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>
              {asGroupName}
            </Text>
          </>
        ) : null}
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
            <Text style={holdStyles.label}>DATES THEY ASKED ABOUT</Text>
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

      <Text style={holdStyles.body}>
        {asGroupName
          ? `Join if ${asGroupName} is in, or pass — either way takes one tap, and any editor of the group can answer. The place only sees the group as joined once someone says so, and if you pass, the name comes off what they see.`
          : "Join if you’re in, or pass — either way takes one tap. The place only sees you as joined once you say so, and if you pass, your name comes off what they see."}
      </Text>

      <Section style={holdStyles.center}>
        <Button style={holdStyles.primaryButton} href={targetUrl}>
          Review
        </Button>
      </Section>

      <Text style={holdStyles.muted}>
        {asGroupName
          ? `You’re receiving this because ${senderName} added ${asGroupName}, a group you edit, to a booking request on Ithas Fire.`
          : `You’re receiving this because ${senderName} added you to a booking request on Ithas Fire.`}
      </Text>
    </Shell>
  );
};
