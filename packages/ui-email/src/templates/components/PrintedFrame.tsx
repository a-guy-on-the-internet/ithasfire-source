import {
  Body,
  Column,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Row,
  Text,
} from "@react-email/components";
import { type ReactElement, type ReactNode } from "react";

import { tokens } from "../../theme/tokens";
import { EmailFooter } from "../EmailFooter";
import {
  ACCENT,
  INK,
  SANS,
  monoLabel,
  rawUrlText,
  smallText,
} from "./printed-styles";
import { MsoGhostClose, MsoGhostOpen } from "./mso";
import { StatusBar, type ApplicationStage } from "./StatusBar";

/**
 * Absolute URL of the black lockup. Emails have no base-URL mechanism (the
 * footer context carries address/contact only), so this points straight at
 * the public web asset `apps/web/public/brand/ithasfire-lockup-black.png`
 * (1161x291, so 112 wide is 28 tall).
 */
const LOCKUP_URL = "https://ithasfire.com/brand/ithasfire-lockup-black.png";

const WHITE = "#FFFFFF";

const NARROW_CSS =
  "@media only screen and (max-width: 420px) { .pf-h1 { font-size: 32px !important; } }";

export type PrintedFrameProps = {
  /** The email subject; also the document `<title>`. */
  subject: string;
  previewText: string;
  /** Uppercase mono line above the status bar, e.g. "Application sent". */
  kicker: string;
  /** The application status bar. Omitted for mail that isn't about an application (the event invite). */
  stage?: ApplicationStage;
  /** The `<h1>`. */
  title: string;
  /** Headline in the accent instead of ink. Approved only. */
  accentTitle?: boolean;
  /** When present, the card ends with a line inviting a reply. */
  organizerContactEmail?: string | null;
  locale?: string;
  children: ReactNode;
};

/**
 * "Printed" (direction B, approved 2026-09-30): cream page, white card in a
 * 2px ink frame, lockup, mono kicker, three-segment status bar, then the
 * headline and whatever the template puts in `children` (body, organizer note,
 * ledger, CTA, small print). The platform footer sits outside the card.
 *
 * No box-shadow anywhere (DS D-122: email drops shadows; Outlook on Windows
 * ignores them). Padding and borders sit on `<td>`s, never on `<table>`s,
 * because Outlook desktop ignores table padding. Outlook also ignores the
 * container's `max-width`, so the frame sits in an MSO-only 600px ghost table
 * (see `./mso`).
 */
export const PrintedFrame = ({
  subject,
  previewText,
  kicker,
  stage,
  title,
  accentTitle = false,
  organizerContactEmail,
  locale = "en",
  children,
}: PrintedFrameProps): ReactElement => (
  <Html lang={locale} dir="ltr">
    <Head>
      <title>{subject}</title>
      <meta name="color-scheme" content="light" />
      <meta name="supported-color-schemes" content="light" />
      {/* Montserrat (readable text) and IBM Plex Mono (labels). Keep in sync
          with `tokens.typography.fontFamily` / `monoFamily`; clients that
          skip remote CSS use the fallback stacks there. */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap"
      />
      {/* At 320px the card's content box is 228px and the 40px headline's
          longest words are 235px ("application") and 228px ("withdrawn"), so
          narrow screens step the headline down. Clients that drop <style>
          keep 40px and fall back to the heading's overflow-wrap. */}
      <style>{NARROW_CSS}</style>
    </Head>
    <Preview>{previewText}</Preview>
    {/* `lang`/`dir` on <body> too: some clients strip <html>. */}
    <Body
      lang={locale}
      dir="ltr"
      style={{
        margin: 0,
        padding: 0,
        backgroundColor: tokens.colors.canvas,
        color: INK,
        fontFamily: SANS,
      }}
    >
      <MsoGhostOpen />
      <Container style={{ maxWidth: "600px", margin: "0 auto" }}>
        <Row>
          <Column style={{ padding: "24px 16px" }}>
            <Row>
              <Column
                style={{
                  backgroundColor: WHITE,
                  border: `2px solid ${INK}`,
                  padding: "24px 28px 32px",
                }}
              >
                <Img
                  src={LOCKUP_URL}
                  alt="Ithas Fire"
                  width="112"
                  height="28"
                  style={{ display: "block" }}
                />
                <Text
                  style={{
                    ...monoLabel(11),
                    marginTop: "14px",
                    marginBottom: "22px",
                  }}
                >
                  {kicker}
                </Text>
                {stage ? <StatusBar stage={stage} /> : null}
                <Heading
                  as="h1"
                  className="pf-h1"
                  style={{
                    fontFamily: SANS,
                    fontSize: "40px",
                    fontWeight: 800,
                    lineHeight: 1.05,
                    letterSpacing: "-0.01em",
                    color: accentTitle ? ACCENT : INK,
                    margin: "28px 0 12px",
                    // Only breaks a word that can't fit on a line by itself.
                    // "anywhere" (not "break-word") so the word also stops
                    // forcing the table cell wider than the card.
                    // `word-break: break-word` is the same intent for clients
                    // that don't know `overflow-wrap: anywhere` (Outlook's
                    // Word engine, older WebKit).
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                  }}
                >
                  {title}
                </Heading>
                {children}
                {organizerContactEmail ? (
                  <SmallPrint>
                    Questions? Reply to this email to reach the organizer.
                  </SmallPrint>
                ) : null}
              </Column>
            </Row>
            <Row>
              <Column style={{ padding: "0 4px" }}>
                <EmailFooter />
              </Column>
            </Row>
          </Column>
        </Row>
      </Container>
      <MsoGhostClose />
    </Body>
  </Html>
);

/** Muted 14px line under the CTA. */
export const SmallPrint = ({
  children,
}: {
  children: ReactNode;
}): ReactElement => (
  <Text style={{ ...smallText, marginTop: "16px" }}>{children}</Text>
);

/** A raw URL that must wrap anywhere rather than widen the card. */
export const RawUrl = ({ url }: { url: string }): ReactElement => (
  <Text style={rawUrlText}>{url}</Text>
);
