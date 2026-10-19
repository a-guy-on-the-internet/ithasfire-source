import { Button, Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { Shell } from "./Shell";
import { spacing, tokens, primaryButtonStyle } from "../theme/tokens";

export type LineupAddedProps = {
  /** Who put them on it (never empty — the caller falls back to the organiser). */
  addedByName: string;
  eventTitle: string;
  /**
   * Full date + time + the zone's city, e.g.
   * "Sunday, October 4, 2026 at 5:00 PM (Chicago time)". Empty → the When
   * row is left out.
   */
  whenLabel: string;
  /** "Performer", "DJ", … or the custom label for OTHER. */
  roleLabel: string;
  /** `{publicAppUrl}/my-lineups`. */
  lineupsUrl: string;
  /** PUBLIC event and a publicly listed role: the name is on the event page. */
  publiclyListed: boolean;
  /** The event is over — no "upcoming shows" line. */
  eventEnded: boolean;
  /** Someone (an owning org or human) hears if the person leaves. */
  organiserWillBeTold: boolean;
};

/**
 * Subject line, shared with the registry's getSubject so the two cannot
 * drift. Mirrors the renderer title in core comms/lineup-renderers.ts
 * (event.lineup-added) — keep all three in sync.
 */
export function lineupAddedSubject(
  props: Pick<LineupAddedProps, "eventTitle">,
): string {
  return `You're on the lineup for ${props.eventTitle}`;
}

/**
 * To the person an editor put on a lineup (owner ruling "option A",
 * 2026-09-30). Always sent (transactional): the point is that someone can
 * never be listed somewhere without knowing. Copy is the owner's draft;
 * gender-neutral throughout.
 */
export const LineupAdded = (props: LineupAddedProps): ReactElement => {
  const {
    addedByName,
    eventTitle,
    whenLabel,
    roleLabel,
    lineupsUrl,
    publiclyListed,
    eventEnded,
    organiserWillBeTold,
  } = props;
  const heading = `${addedByName} put you on a lineup`;

  return (
    <Shell title={lineupAddedSubject(props)} previewText={heading}>
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={headingStyle}>{heading}</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={metaLineStyle}>
          <strong>Event:</strong> {eventTitle}
        </Text>
        {whenLabel ? (
          <Text style={metaLineStyle}>
            <strong>When:</strong> {whenLabel}
          </Text>
        ) : null}
        <Text style={metaLineStyle}>
          <strong>As:</strong> {roleLabel}
        </Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          {!publiclyListed
            ? "Your name is on the lineup for this event."
            : eventEnded
              ? "Your name shows on the event page."
              : "Your name shows on the event page and in your profile's upcoming shows."}{" "}
          If you didn&apos;t agree to this, or the details are wrong, you can
          take yourself off the lineup.
          {organiserWillBeTold ? " The organiser will be told." : ""}
        </Text>
      </Section>

      <Section style={{ marginTop: spacing(3) }}>
        <Button href={lineupsUrl} style={primaryButtonStyle}>
          Review your lineups
        </Button>
      </Section>

      <Text style={footerStyle}>
        You&apos;re getting this because someone added your Ithas Fire profile
        to an event. You can&apos;t turn these off, so you know where your name
        appears.
      </Text>
    </Shell>
  );
};

const headingStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  lineHeight: tokens.typography.headingTightLH,
};

const bodyStyle: CSSProperties = {
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.5,
};

const metaLineStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.5,
};

const footerStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};
