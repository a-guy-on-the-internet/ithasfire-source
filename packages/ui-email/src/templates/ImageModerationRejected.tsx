import { Link, Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { Shell } from "./Shell";
import { spacing, tokens } from "../theme/tokens";

export type ImageModerationRejectedProps = {
  /** Optional reviewer note explaining the decision. */
  note?: string | null;
  /** Name of the event the image was uploaded for, when known. */
  eventTitle?: string | null;
  /** Absolute public event URL (slug-based), when known. */
  eventUrl?: string | null;
  /** Optional Help Center link surfaced in the footer. */
  helpUrl?: string | null;
};

export const ImageModerationRejected = (
  props: ImageModerationRejectedProps,
): ReactElement => {
  const { note, eventTitle, eventUrl, helpUrl } = props;

  return (
    <Shell
      title="Your image wasn't approved"
      previewText="The image you uploaded wasn't approved. You can upload a different one."
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>Not approved</Text>
        <Text style={headingStyle}>Your image wasn't approved</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          {eventTitle ? (
            <>
              {"The image you uploaded for "}
              {eventUrl ? (
                <Link href={eventUrl} style={eventLinkStyle}>
                  {eventTitle}
                </Link>
              ) : (
                eventTitle
              )}
              {
                " wasn't approved and won't be shown. You can upload a different one anytime."
              }
            </>
          ) : (
            "The image you uploaded wasn't approved and won't be shown. You can upload a different one anytime."
          )}
        </Text>
      </Section>

      {note ? (
        <Section style={{ marginBottom: spacing(2) }}>
          <Text style={noteLabelStyle}>Note from our moderators</Text>
          <Text style={noteStyle}>{note}</Text>
        </Section>
      ) : null}

      <Text style={footerStyle}>
        {helpUrl ? (
          <>
            Questions? Visit our{" "}
            <Link href={helpUrl} style={footerLinkStyle}>
              Help Center
            </Link>
            .
          </>
        ) : (
          "This is an automated notice — no reply is needed."
        )}
      </Text>
    </Shell>
  );
};

const eyebrowStyle: CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: "12px",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: spacing(1),
};

const headingStyle: CSSProperties = {
  fontSize: "28px",
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

const eventLinkStyle: CSSProperties = {
  color: tokens.colors.text,
  textDecoration: "underline",
};

const noteLabelStyle: CSSProperties = {
  fontSize: "13px",
  color: tokens.colors.mutedText,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: 0,
  marginBottom: spacing(0),
};

const noteStyle: CSSProperties = {
  fontSize: "15px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.5,
  padding: `${spacing(1)} ${spacing(2)}`,
  borderLeft: `3px solid ${tokens.colors.border}`,
};

const footerStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};

const footerLinkStyle: CSSProperties = {
  color: tokens.colors.text,
  textDecoration: "underline",
};
