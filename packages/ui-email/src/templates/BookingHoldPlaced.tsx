import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { holdStyles } from "./booking-hold-styles";

/** One date in a batch digest: pre-formatted day + the act's place in line. */
export type BookingHoldPlacedDate = {
  /** Pre-formatted, place-local day ("Thu, Aug 14, 2026"). */
  dateLabel: string;
  /** 1-based position in that date's line. */
  position: number;
};

export type BookingHoldPlacedProps =
  | {
      /** `placed` = a new hold; `moved` = the act moved up to first in line. */
      kind: "placed" | "moved";
      placeName: string;
      /** Pre-formatted, place-local day ("Thu, Aug 14, 2026"). */
      dateLabel: string;
      /** 1-based position in the line. */
      position: number;
      /** The act's request view. */
      targetUrl: string;
    }
  | {
      /**
       * `placed_batch` = several dates pencilled in by ONE staff action, sent
       * as a single digest instead of one email per hold.
       */
      kind: "placed_batch";
      placeName: string;
      /** Every date the digest covers, ascending. Two or more. */
      dates: BookingHoldPlacedDate[];
      /** The act's request view. */
      targetUrl: string;
    };

const ordinal = (n: number): string => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
};

const positionLabel = (position: number): string =>
  position === 1 ? "First in line" : `${ordinal(position)} in line`;

/**
 * Act-facing: the venue is holding a date for them (booking-holds FR-002),
 * moved them to the front of the line (FR-003 / move-ups), or pencilled in a
 * run of dates in one go (FR-002 batch). Never names the other acts — the
 * position is the only thing the act learns about the line. Hardcoded English
 * copy, like the other booking templates.
 */
export const BookingHoldPlaced = (props: BookingHoldPlacedProps): ReactElement => {
  const { kind, placeName, targetUrl } = props;

  if (kind === "placed_batch") {
    const { dates } = props;
    const title = `${placeName} is holding ${dates.length} dates for you`;
    return (
      <Shell
        title={title}
        previewText={`${dates.length} dates held for you at ${placeName}.`}
      >
        <Section style={holdStyles.sectionGap}>
          <Text style={holdStyles.eyebrow}>BOOKING HOLD</Text>
          <Text style={holdStyles.heading}>{title}</Text>
          <Text style={holdStyles.subtitle}>
            {`${placeName} pencilled you in for these dates. Your spot in line is per date.`}
          </Text>
        </Section>

        <Section style={holdStyles.card}>
          <Text style={holdStyles.label}>PLACE</Text>
          <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>{placeName}</Text>
          <Text style={holdStyles.label}>DATES HELD</Text>
          {dates.map((entry) => (
            <Text
              key={`${entry.dateLabel}-${entry.position}`}
              style={{ ...holdStyles.value, marginBottom: "4px" }}
            >
              {entry.dateLabel} — {positionLabel(entry.position)}
            </Text>
          ))}
        </Section>

        <Text style={holdStyles.body}>
          A hold is not a booking yet. The place confirms each date once it is
          settled, and you&apos;ll hear from them here either way. If they ask
          you to keep or release a hold, you&apos;ll get a separate message with
          a deadline.
        </Text>

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
  }

  const { dateLabel, position } = props;
  const first = position === 1;
  const title =
    kind === "moved"
      ? `You're now first in line for ${dateLabel}`
      : `${placeName} is holding ${dateLabel} for you`;
  const line = positionLabel(position);

  return (
    <Shell title={title} previewText={`${line} for ${dateLabel} at ${placeName}.`}>
      <Section style={holdStyles.sectionGap}>
        <Text style={holdStyles.eyebrow}>BOOKING HOLD</Text>
        <Text style={holdStyles.heading}>{title}</Text>
        <Text style={holdStyles.subtitle}>
          {kind === "moved"
            ? `${placeName} moved your hold to the front of the line.`
            : first
              ? "You're first in line for this date."
              : `You're ${ordinal(position)} in line for this date.`}
        </Text>
      </Section>

      <Section style={holdStyles.card}>
        <Text style={holdStyles.label}>PLACE</Text>
        <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>{placeName}</Text>
        <Text style={holdStyles.label}>DATE</Text>
        <Text style={{ ...holdStyles.value, marginBottom: "12px" }}>{dateLabel}</Text>
        <Text style={holdStyles.label}>YOUR SPOT IN LINE</Text>
        <Text style={holdStyles.value}>{line}</Text>
      </Section>

      <Text style={holdStyles.body}>
        A hold is not a booking yet. The place confirms it once the date is
        settled, and you&apos;ll hear from them here either way. If they ask you
        to keep or release the hold, you&apos;ll get a separate message with a
        deadline.
      </Text>

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
