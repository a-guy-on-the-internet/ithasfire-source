import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { holdStyles } from "./booking-hold-styles";

export type BookingHoldChallengedProps = {
  placeName: string;
  /** Pre-formatted, place-local day ("Thu, Aug 14, 2026"). */
  dateLabel: string;
  /** Pre-formatted keep-or-release deadline in the place's zone. */
  respondByLabel: string;
  /** 1 = this act must answer; 2 = next in line, informational. */
  position: 1 | 2;
  /** True when the deadline moved later (FR-005) rather than a new challenge. */
  extended: boolean;
  /** The act's request view — where Keep / Release live. */
  targetUrl: string;
  /**
   * booking-the-night N19 / FR-014, the challenged act (position 1) only:
   * what Keep will do — agree the sent terms and book the night, or ask the
   * venue for terms. Absent = the generic copy.
   */
  keepWill?: "book_now" | "ask_for_terms";
};

/**
 * Act-facing challenge (booking-holds FR-004) and deadline extension
 * (FR-005). The challenged act gets the Keep / Release call to action; the
 * act at position 2 is told when they'll hear. Neither learns who the other
 * is.
 */
export const BookingHoldChallenged = (
  props: BookingHoldChallengedProps,
): ReactElement => {
  const { placeName, dateLabel, respondByLabel, position, extended, targetUrl, keepWill } = props;
  const challenged = position === 1;

  const title = challenged
    ? extended
      ? `More time to answer ${placeName} about ${dateLabel}`
      : `${placeName} needs an answer on ${dateLabel}`
    : extended
      ? `Update on ${dateLabel} at ${placeName}`
      : `The first hold on ${dateLabel} was challenged`;

  const lede = challenged
    ? extended
      ? "Your deadline moved later. Keep the hold if the date still works, or release it so the line can move."
      : // N20 (owner copy): never names the other act.
        keepWill === "book_now"
        ? `Another act is ready to book ${dateLabel}. Agree your terms by ${respondByLabel} to keep it. Keep agrees them and books the night.`
        : keepWill === "ask_for_terms"
          ? // Before the tap: "within 48 hours of keeping", never a date — the
            // keep sets the deadline (review W2).
            `Another act is ready to book ${dateLabel}. Keep it by ${respondByLabel} and the place sends you terms. Agree them within 48 hours of keeping, or the hold lapses.`
          : `Another act is ready to book ${dateLabel}. Keep the hold if you're taking the date, or release it. If nobody answers by the deadline, the hold lapses on its own.`
    : "You're next in line at this place. If the act ahead of you releases or misses the deadline, the date moves to you and you'll be told.";

  return (
    <Shell
      title={title}
      previewText={
        challenged
          ? `Keep or release your hold by ${respondByLabel}.`
          : `You'll hear by ${respondByLabel}.`
      }
    >
      <Section style={holdStyles.sectionGap}>
        <Text style={holdStyles.eyebrow}>
          {challenged ? "ANSWER NEEDED" : "BOOKING HOLD"}
        </Text>
        <Text style={holdStyles.heading}>{title}</Text>
        <Text style={holdStyles.subtitle}>{lede}</Text>
      </Section>

      <Section style={holdStyles.card}>
        <Text style={holdStyles.label}>PLACE</Text>
        <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>{placeName}</Text>
        <Text style={holdStyles.label}>DATE</Text>
        <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>{dateLabel}</Text>
        <Text style={holdStyles.label}>
          {challenged ? "ANSWER BY" : "YOU'LL HEAR BY"}
        </Text>
        <Text style={holdStyles.value}>{respondByLabel}</Text>
      </Section>

      <Section style={holdStyles.center}>
        <Button style={holdStyles.primaryButton} href={targetUrl}>
          {challenged ? "Keep or release the hold" : "View your request"}
        </Button>
      </Section>

      <Text style={holdStyles.muted}>
        You&apos;re receiving this because you sent a booking request to{" "}
        {placeName} on Ithas Fire.
      </Text>
    </Shell>
  );
};
