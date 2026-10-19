import { Link, Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { Shell } from "./Shell";
import { spacing, tokens } from "../theme/tokens";

export type ImageModerationApprovedProps = {
  /** Name of the event the image was uploaded for, when known. */
  eventTitle?: string | null;
  /** Absolute public event URL (slug-based), when known. */
  eventUrl?: string | null;
  /** Optional Help Center link surfaced in the footer. */
  helpUrl?: string | null;
};

export const ImageModerationApproved = (
  props: ImageModerationApprovedProps,
): ReactElement => {
  const { eventTitle, eventUrl, helpUrl } = props;

  return (
    <Shell
      title="Your image is now live"
      previewText="The image you uploaded has been approved and is now visible."
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>Approved</Text>
        <Text style={headingStyle}>Your image is now live</Text>
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
              {" has been approved and is now visible."}
            </>
          ) : (
            "The image you uploaded has been approved and is now visible."
          )}
        </Text>
      </Section>

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

const footerStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};

const footerLinkStyle: CSSProperties = {
  color: tokens.colors.text,
  textDecoration: "underline",
};
