import { Button, Column, Img, Row, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";
import type { TranslationValues } from "@th/locale";

import { Shell } from "./Shell";
import { spacing, tokens, primaryButtonStyle as sharedPrimaryButton } from "../theme/tokens";
import type { TemplateComponentContext } from "./registry";

export type TicketIssuedProps = {
  eventTitle: string;
  eventDateISO: string;
  venueName: string;
  tickets: Array<{
    code: string;
    qrUrl: string;
    /** Human-readable seat label for seated tickets (e.g. "Front Row · A12"). Omitted for GA. */
    seatLabel?: string;
  }>;
  orderId: string;
  manageUrl: string;
  supportUrl: string;
  /** Full address text for the event venue (optional). */
  venueAddress?: string;
  /** Static map image URL for the venue (optional). */
  mapImageUrl?: string;
  /** Google Maps deep-link for directions (optional). */
  directionsUrl?: string;
  /**
   * ISO timestamp (UTC) at which the exact address will be revealed to ticket holders.
   * When set and in the future at send time, the email will display a reveal notice
   * instead of the exact address/map/directions.
   */
  addressRevealAtISO?: string;
  /** IANA timezone identifier used to format the reveal timestamp (optional). */
  timezone?: string;
  /**
   * `/auth/complete` account-claim link. Present when the recipient is a
   * shadow (guest) human with no account yet (e.g. a volunteer comp-ticket
   * grant); the email then invites them to claim the ticket into an account.
   */
  accountCompletionUrl?: string;
  /**
   * arrival-areas FR-010: the event page, set only when the event has an
   * arrival area anyone may see AND this email already carries the exact
   * address. Renders one "Parking and drop-off: see the map" link line.
   */
  gettingThereUrl?: string;
};

const baseKey = "emails.ticketIssued";


/**
 * Nominal QR edge, in px. The QR *is* the ticket — it's the unauthenticated
 * `/tickets/qr/{code}` image the buyer holds up at the door — so it leads the email.
 *
 * 220 is the largest square that clears the narrowest column we render into with room to spare:
 * Shell gives 600 − 32 (section padding) − 64 (container padding) − 2 (borders) = 502px of content
 * at desktop and 292px at a 390px viewport; the hero band's 16px side padding leaves 260px there.
 * At 320px the same maths leaves only 190px, which is why the `<Img>` is fluid
 * (`width:100%; max-width:220px`) rather than a hard 220 — it shrinks instead of overflowing. The
 * `width`/`height` ATTRIBUTES stay at 220 for Outlook's Word engine, which ignores `max-width` but
 * renders at a fixed ~600px width where 220 always fits.
 */
const QR_SIZE = 220;

const toString = (input: unknown): string => {
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    return input.join("");
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(input ?? "");
};

const translateString = (
  context: TemplateComponentContext,
  key: string,
  values?: TranslationValues,
): string => {
  return toString(context.translator.t(`${baseKey}.${key}`, values));
};

const formatEventDate = (context: TemplateComponentContext, iso: string) =>
  context.translator.formatDate(iso, { dateStyle: "full", timeStyle: "short" });

export const TicketIssued = (
  props: TicketIssuedProps,
  context: TemplateComponentContext,
): ReactElement => {
  const {
    eventTitle,
    eventDateISO,
    venueName,
    tickets,
    orderId,
    manageUrl,
    supportUrl,
    venueAddress,
    mapImageUrl,
    directionsUrl,
    addressRevealAtISO,
    timezone,
    accountCompletionUrl,
    gettingThereUrl,
  } = props;
  const resolvedVenueName = venueName?.trim()
    ? venueName
    : translateString(context, "venueTba");

  // Determine if the exact address should be hidden behind a reveal notice.
  // The address is locked when addressRevealAtISO is set and still in the future.
  const revealAt = addressRevealAtISO ? new Date(addressRevealAtISO) : null;
  const addressLocked =
    revealAt !== null &&
    !Number.isNaN(revealAt.getTime()) &&
    revealAt.getTime() > Date.now();
  const revealDateFormatted =
    addressLocked && revealAt
      ? context.translator.formatDate(revealAt, {
          dateStyle: "full",
          timeStyle: "short",
          ...(timezone ? { timeZone: timezone } : {}),
        })
      : "";
  const showAddressLine =
    !addressLocked && Boolean(venueAddress) && venueAddress !== resolvedVenueName;

  const title = translateString(context, "title");
  const previewText = translateString(context, "preview", {
    eventTitle,
    venueName: resolvedVenueName,
  });
  const supportPrompt = translateString(context, "support.prompt");
  const supportLinkLabel = translateString(context, "support.linkLabel");
  const supportSuffix = translateString(context, "support.suffix");
  const manageLabel = translateString(context, "actions.manage.label");
  const manageAriaLabel = translateString(context, "actions.manage.ariaLabel");
  const securityNote = translateString(context, "securityNote", { orderId });
  const orderLabel = translateString(context, "orderLabel");
  const qrHint = translateString(context, "sections.tickets.qrHint");
  const qrLinkLabel = translateString(context, "sections.tickets.qrButtonLabel");
  const codeLabel = translateString(context, "sections.tickets.codeLabel");
  const seatLabelHeading = translateString(context, "sections.tickets.seatLabel");
  // arrival-areas FR-010: "Parking and drop-off: see the map", en and es.
  const gettingThereLabel = translateString(context, "sections.where.gettingThereLink");

  return (
    <Shell title={title} previewText={previewText} locale={context.locale}>
      {/* ── Zone 1 · Headline ─────────────────────────────────────────────── */}
      <Section style={headerSectionStyle}>
        <Text style={eyebrowStyle}>{translateString(context, "eyebrow")}</Text>
        <Text style={headingStyle}>{title}</Text>
        <Text style={subtitleStyle}>
          {translateString(context, "description", { orderId, eventTitle })}
        </Text>
      </Section>

      {/*
        ── Zone 2 · The ticket itself ───────────────────────────────────────
        The ONE tinted zone in this email (design-system-v2.md: at most one, and it goes to
        whatever earns it). It earns it: the QR is the thing the buyer opens this mail for, and the
        warm mat is what separates a white QR from the white page without another bordered card.
        No card-in-card here — the tint and hairline rules carry the grouping.
      */}
      <Section style={heroBandStyle}>
        <Row>
          <Column align="center" style={centeredCellStyle}>
            <Text style={heroKickerStyle}>
              {translateString(context, "sections.tickets.heading")}
            </Text>
          </Column>
        </Row>
        {tickets.map((ticket, index) => {
          const qrAltText = translateString(context, "sections.tickets.qrAltText", {
            code: ticket.code,
          });
          return (
            <Section
              key={ticket.code}
              style={index === 0 ? undefined : ticketDividerStyle}
            >
              <Row>
                <Column align="center" style={centeredCellStyle}>
                  {ticket.seatLabel && (
                    <>
                      <Text style={seatLabelHeadingStyle}>{seatLabelHeading}</Text>
                      <Text style={seatValueStyle}>{ticket.seatLabel}</Text>
                    </>
                  )}
                  <a href={ticket.qrUrl} aria-label={qrAltText} style={qrLinkStyle}>
                    {/*
                      `width` but deliberately NO `height` attribute. With the height pinned, a
                      blocked image (Gmail images-off, Outlook desktop — whose Word engine cannot
                      render SVG at all, so it is ALWAYS this path) reserves a 220px empty frame
                      and clips the alt text inside it. Without it the box collapses to the alt
                      line and the caption below carries the ticket. Reflow cost is nil in email.
                    */}
                    <Img
                      src={ticket.qrUrl}
                      alt={qrAltText}
                      width={QR_SIZE}
                      style={qrStyle}
                    />
                  </a>
                  {/*
                    Images-off insurance, and the manual-entry path for door staff. The code is a
                    bearer string no human needs to READ, so it is a caption — but it must always be
                    on the page, and so must a live link to the QR: with images blocked the `<Img>`
                    above collapses to its alt text and these two lines are the whole ticket.
                  */}
                  <Text style={codeCaptionStyle}>
                    <span style={codeCaptionLabelStyle}>{codeLabel}</span>{" "}
                    <span style={codeCaptionValueStyle}>{ticket.code}</span>
                  </Text>
                  <Text style={qrFallbackLineStyle}>
                    <a href={ticket.qrUrl} style={quietLinkStyle}>
                      {qrLinkLabel}
                    </a>
                  </Text>
                </Column>
              </Row>
            </Section>
          );
        })}
        <Row>
          <Column align="center" style={centeredCellStyle}>
            <Text style={heroHintStyle}>{qrHint}</Text>
            <Text style={heroNoteStyle}>{securityNote}</Text>
          </Column>
        </Row>
      </Section>

      {/* ── Zone 3 · Event facts. Ink values, not accent — the date is data, not a CTA. ── */}
      <Section style={factsSectionStyle}>
        <Text style={factLabelStyle}>
          {translateString(context, "sections.when.label")}
        </Text>
        <Text style={factValueStyle}>{formatEventDate(context, eventDateISO)}</Text>

        <Text style={factLabelSpacedStyle}>
          {translateString(context, "sections.event.label")}
        </Text>
        <Text style={factValueStyle}>{eventTitle}</Text>

        <Text style={factLabelSpacedStyle}>
          {translateString(context, "sections.where.label")}
        </Text>
        <Text style={factValueStyle}>{resolvedVenueName}</Text>
        {showAddressLine && <Text style={addressStyle}>{venueAddress}</Text>}
        {addressLocked && (
          <Text style={revealNoticeStyle}>
            {translateString(context, "sections.where.revealNotice", {
              date: revealDateFormatted,
            })}
          </Text>
        )}
        {!addressLocked && mapImageUrl && (
          <Section style={mapWrapStyle}>
            {directionsUrl ? (
              <a href={directionsUrl} target="_blank" rel="noopener noreferrer">
                <Img
                  src={mapImageUrl}
                  alt={translateString(context, "sections.where.mapAlt")}
                  style={mapImageStyle}
                />
              </a>
            ) : (
              <Img
                src={mapImageUrl}
                alt={translateString(context, "sections.where.mapAlt")}
                style={mapImageStyle}
              />
            )}
          </Section>
        )}
        {!addressLocked && directionsUrl && (
          <Section style={directionsWrapStyle}>
            <Button
              style={outlineButtonStyle}
              href={directionsUrl}
              aria-label={translateString(context, "sections.where.directionsLabel")}
            >
              {translateString(context, "sections.where.directionsLabel")}
            </Button>
          </Section>
        )}
        {/* arrival-areas FR-010: never beside a locked address. */}
        {!addressLocked && gettingThereUrl && (
          <Text style={gettingThereStyle}>
            <a href={gettingThereUrl} style={inlineLinkStyle}>
              {gettingThereLabel}
            </a>
          </Text>
        )}
      </Section>

      {/* ── Zone 4 · The one primary action. Everything else on this page is a link. ── */}
      <Section style={orderSectionStyle}>
        <Text style={factLabelStyle}>{orderLabel}</Text>
        <Text style={orderValueStyle}>{orderId}</Text>
        <Section style={primaryWrapStyle}>
          <Button style={primaryButtonStyle} href={manageUrl} aria-label={manageAriaLabel}>
            {manageLabel}
          </Button>
        </Section>
      </Section>

      {/*
        ── Zone 5 · Account claim. Optional by definition, and the copy says so — a hairline and a
        text link, never a second filled button competing with "Manage order".
      */}
      {accountCompletionUrl && (
        <Section style={claimStripStyle}>
          <Text style={claimPromptStyle}>{translateString(context, "claim.prompt")}</Text>
          <Text style={claimLinkLineStyle}>
            <a
              href={accountCompletionUrl}
              style={secondaryActionLinkStyle}
              aria-label={translateString(context, "claim.ariaLabel")}
            >
              {translateString(context, "claim.buttonLabel")}
            </a>
          </Text>
        </Section>
      )}

      {/* ── Zone 6 · Fine print ───────────────────────────────────────────── */}
      <Section style={finePrintStyle}>
        <Text style={finePrintTextStyle}>
          {supportPrompt}{" "}
          <a href={supportUrl} style={inlineLinkStyle}>
            {supportLinkLabel}
          </a>
          {supportSuffix}
          {/* Same line as the support sentence: the brand/order reference is a
              trailing attribution, not its own paragraph. Stacking them (plus the
              claim strip, plus Shell's EmailFooter) piled six footer-ish elements
              where three do the job. */}
          {" "}
          {translateString(context, "footer", { orderId })}
        </Text>

      </Section>
    </Shell>
  );
};

const fontFamily = tokens.typography.fontFamily;

/** Uppercase Swiss micro-label: the only place tracking is used. */
const microLabel: React.CSSProperties = {
  fontFamily,
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: tokens.colors.mutedText,
  lineHeight: 1.4,
  margin: 0,
};

/* ── Zone 1 · Headline ─────────────────────────────────────────────────── */

const headerSectionStyle: React.CSSProperties = {
  marginBottom: spacing(4),
};

const eyebrowStyle: React.CSSProperties = {
  ...microLabel,
  fontSize: "11px",
  letterSpacing: "0.12em",
  marginBottom: spacing(1),
};

const headingStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "26px",
  fontWeight: 700,
  margin: 0,
  marginBottom: spacing(1),
  color: tokens.colors.text,
  lineHeight: tokens.typography.headingTightLH,
};

const subtitleStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "15px",
  lineHeight: 1.5,
  margin: 0,
  color: tokens.colors.mutedText,
};

/* ── Zone 2 · QR hero ──────────────────────────────────────────────────── */

const heroBandStyle: React.CSSProperties = {
  backgroundColor: tokens.colors.surfaceMuted,
  // 16px sides, not 24: at a 320px viewport that padding is the difference between a 190px and a
  // 174px QR. The vertical padding carries the breathing room instead.
  padding: "24px 16px",
  marginBottom: spacing(4),
};

const centeredCellStyle: React.CSSProperties = {
  textAlign: "center",
  verticalAlign: "top",
};

const heroKickerStyle: React.CSSProperties = {
  ...microLabel,
  marginBottom: spacing(3),
};

/** Second and subsequent tickets: a hairline, never another box. */
const ticketDividerStyle: React.CSSProperties = {
  borderTop: `1px solid ${tokens.colors.border}`,
  marginTop: spacing(4),
  paddingTop: spacing(4),
};

const seatLabelHeadingStyle: React.CSSProperties = {
  ...microLabel,
  marginBottom: "2px",
};

const seatValueStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "16px",
  fontWeight: 700,
  color: tokens.colors.text,
  lineHeight: tokens.typography.headingTightLH,
  margin: `0 0 ${spacing(2)} 0`,
};

/**
 * The frame lives on the LINK, not the `<img>`, so a blocked image degrades to a small framed
 * alt-text link instead of a 220px empty box with the alt clipped inside it. Same pixels when the
 * image loads. The white padding IS the QR quiet zone: `/tickets/qr` emits a 2px margin on a
 * ~450px canvas — effectively none — and scanners need one.
 */
const qrLinkStyle: React.CSSProperties = {
  display: "inline-block",
  maxWidth: "100%",
  boxSizing: "border-box",
  padding: "10px",
  backgroundColor: "#FFFFFF",
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radius,
  textDecoration: "none",
  color: tokens.colors.text,
  fontFamily,
  fontSize: "12px",
  lineHeight: 1.4,
};

const qrStyle: React.CSSProperties = {
  display: "block",
  width: `${QR_SIZE}px`,
  maxWidth: "100%",
  height: "auto",
};

const codeCaptionStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "12px",
  lineHeight: 1.5,
  color: tokens.colors.mutedText,
  margin: `${spacing(2)} 0 0 0`,
};

const codeCaptionLabelStyle: React.CSSProperties = {
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const codeCaptionValueStyle: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  // A 24–32 char bearer string against 190px of column at 320px: break it rather than blow out the
  // email's width.
  wordBreak: "break-all",
};

const qrFallbackLineStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "12px",
  lineHeight: 1.5,
  margin: "2px 0 0 0",
};

const quietLinkStyle: React.CSSProperties = {
  color: tokens.colors.mutedText,
  textDecoration: "underline",
};

const heroHintStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "13px",
  lineHeight: 1.5,
  color: tokens.colors.text,
  margin: `${spacing(4)} 0 0 0`,
};

const heroNoteStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "12px",
  lineHeight: 1.5,
  color: tokens.colors.mutedText,
  margin: "4px 0 0 0",
};

/* ── Zone 3 · Event facts ──────────────────────────────────────────────── */

const factsSectionStyle: React.CSSProperties = {
  marginBottom: spacing(4),
};

const factLabelStyle: React.CSSProperties = {
  ...microLabel,
  marginBottom: "2px",
};

const factLabelSpacedStyle: React.CSSProperties = {
  ...factLabelStyle,
  marginTop: spacing(3),
};

const factValueStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "16px",
  fontWeight: 600,
  color: tokens.colors.text,
  lineHeight: 1.35,
  margin: 0,
};

const addressStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "14px",
  lineHeight: 1.5,
  margin: "2px 0 0 0",
  color: tokens.colors.mutedText,
};

const gettingThereStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "14px",
  lineHeight: 1.5,
  margin: `${spacing(2)} 0 0 0`,
  color: tokens.colors.text,
};

const revealNoticeStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "13px",
  lineHeight: 1.5,
  margin: `${spacing(2)} 0 0 0`,
  padding: "10px 12px",
  color: tokens.colors.text,
  backgroundColor: tokens.colors.warningBg,
  border: `1px solid ${tokens.colors.warningBorder}`,
  borderRadius: tokens.radius,
};

const mapWrapStyle: React.CSSProperties = {
  marginTop: spacing(2),
};

const mapImageStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: "100%",
  height: "auto",
  boxSizing: "border-box",
  borderRadius: tokens.radius,
  border: `1px solid ${tokens.colors.border}`,
};

const directionsWrapStyle: React.CSSProperties = {
  marginTop: spacing(2),
};

/** Hairline-outlined, ink label — a real action, but never competing with the primary fill. */
const outlineButtonStyle: React.CSSProperties = {
  display: "inline-block",
  fontFamily,
  fontSize: "13px",
  fontWeight: 700,
  // 12px + 13px×1 line ≈ 45px tall: clears the 44px touch floor without reading as a CTA.
  padding: "12px 20px",
  color: tokens.colors.brand,
  backgroundColor: tokens.colors.surface,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radius,
  textDecoration: "none",
};

/* ── Zone 4 · Order + primary action ───────────────────────────────────── */

const orderSectionStyle: React.CSSProperties = {
  borderTop: `1px solid ${tokens.colors.border}`,
  paddingTop: spacing(4),
};

const orderValueStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "16px",
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
  color: tokens.colors.text,
  lineHeight: 1.35,
  margin: 0,
};

const primaryWrapStyle: React.CSSProperties = {
  marginTop: spacing(3),
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
  fontFamily,
  fontSize: "15px",
  padding: "14px 28px",
  textAlign: "center",
};

const secondaryActionLinkStyle: React.CSSProperties = {
  color: tokens.colors.brand,
  fontWeight: 700,
  textDecoration: "underline",
};

/* ── Zone 5 · Account claim strip ──────────────────────────────────────── */

const claimStripStyle: React.CSSProperties = {
  borderTop: `1px solid ${tokens.colors.border}`,
  marginTop: spacing(4),
  paddingTop: spacing(4),
};

const claimPromptStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "13px",
  lineHeight: 1.5,
  color: tokens.colors.mutedText,
  margin: 0,
};

const claimLinkLineStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "14px",
  lineHeight: 1.5,
  margin: `${spacing(1)} 0 0 0`,
};

/* ── Zone 6 · Fine print ───────────────────────────────────────────────── */

const finePrintStyle: React.CSSProperties = {
  marginTop: spacing(4),
};

const finePrintTextStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "12px",
  lineHeight: 1.5,
  color: tokens.colors.mutedText,
  margin: 0,
};

const inlineLinkStyle: React.CSSProperties = {
  color: tokens.colors.brand,
  textDecoration: "underline",
};
