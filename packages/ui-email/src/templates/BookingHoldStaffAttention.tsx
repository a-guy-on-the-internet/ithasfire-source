import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { holdStyles } from "./booking-hold-styles";

export type BookingHoldStaffAttentionKind =
  | "answered_kept"
  | "answered_released"
  | "expired";

export type BookingHoldStaffAttentionProps = {
  kind: BookingHoldStaffAttentionKind;
  /** The act's display name (staff already see it on the request). */
  actName: string;
  placeName: string;
  /** Pre-formatted, place-local day ("Thu, Aug 14, 2026"). */
  dateLabel: string;
  /** The venue's booking inbox. */
  targetUrl: string;
  /**
   * booking-the-night FR-014 (`answered_kept` only): the act kept the hold
   * with no terms sent, and must agree the terms the venue sends by this
   * pre-formatted deadline. Absent = the plain "kept" copy.
   */
  respondByLabel?: string;
};

const copyFor = (
  kind: BookingHoldStaffAttentionKind,
  actName: string,
  dateLabel: string,
  respondByLabel: string | undefined,
): { eyebrow: string; title: string; lede: string; cta: string } => {
  switch (kind) {
    case "answered_kept":
      return {
        eyebrow: "CHALLENGE ANSWERED",
        title: `${actName} kept their hold on ${dateLabel}`,
        lede: respondByLabel
          ? `Send them terms to keep this night. They have until ${respondByLabel} to agree, or the hold lapses.`
          : "They're still first in line. Confirm the hold to book them, or release it if the date is going elsewhere.",
        cta: "Open booking inbox",
      };
    case "answered_released":
      return {
        eyebrow: "CHALLENGE ANSWERED",
        title: `${actName} released their hold on ${dateLabel}`,
        lede: "The line for this date moved up. The next act in line has been told.",
        cta: "Open booking inbox",
      };
    case "expired":
    default:
      return {
        eyebrow: "HOLD LAPSED",
        title: `Hold for ${actName} on ${dateLabel} lapsed`,
        lede: "They didn't answer the challenge in time. The hold was released and the line moved up.",
        cta: "Open booking inbox",
      };
  }
};

/**
 * Staff-facing: the two events the venue side gets by email (booking-holds
 * FR-016) — a challenge answer (FR-006) and a challenge expiry (FR-007).
 * Everything else the venue sees in-app.
 */
export const BookingHoldStaffAttention = (
  props: BookingHoldStaffAttentionProps,
): ReactElement => {
  const { kind, actName, placeName, dateLabel, targetUrl, respondByLabel } = props;
  const { eyebrow, title, lede, cta } = copyFor(
    kind,
    actName,
    dateLabel,
    kind === "answered_kept" ? respondByLabel : undefined,
  );

  return (
    <Shell title={title} previewText={lede}>
      <Section style={holdStyles.sectionGap}>
        <Text style={holdStyles.eyebrow}>{eyebrow}</Text>
        <Text style={holdStyles.heading}>{title}</Text>
        <Text style={holdStyles.subtitle}>{lede}</Text>
      </Section>

      <Section style={holdStyles.card}>
        <Text style={holdStyles.label}>ACT</Text>
        <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>{actName}</Text>
        <Text style={holdStyles.label}>PLACE</Text>
        <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>{placeName}</Text>
        <Text style={holdStyles.label}>DATE</Text>
        <Text style={holdStyles.value}>{dateLabel}</Text>
      </Section>

      <Section style={holdStyles.center}>
        <Button style={holdStyles.primaryButton} href={targetUrl}>
          {cta}
        </Button>
      </Section>

      <Text style={holdStyles.muted}>
        You&apos;re receiving this because you manage bookings for {placeName}{" "}
        on Ithas Fire.
      </Text>
    </Shell>
  );
};
