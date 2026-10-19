import { Link, Text } from "@react-email/components";
import { formatEventTimeRange } from "@th/locale";
import { type ReactElement } from "react";

import {
  formatLinkExpiry,
  formatShortDate,
} from "./components/application-dates";
import { Ledger, type LedgerRow } from "./components/Ledger";
import { PrintedCta } from "./components/PrintedCta";
import { PrintedFrame, RawUrl, SmallPrint } from "./components/PrintedFrame";
import { bodyText, linkStyle } from "./components/printed-styles";
import { usableTimeZone } from "../lib/event-time-zone";

export type ApplicationApprovedProps = {
  eventTitle: string;
  /** Tokenised link that opens the gated event. Preferred button target. */
  approvalUrl?: string | null;
  /** Plain event page; the button falls back to it without `approvalUrl`. */
  eventUrl?: string | null;
  /** When `approvalUrl` stops working; the "Link works until" row. */
  expiresAtISO?: string | null;
  startsAtISO?: string | null;
  endsAtISO?: string | null;
  /** The event's IANA timezone; every date renders in it. */
  timezone?: string | null;
  /** "Add to calendar" link under the When row. Omitted when absent. */
  calendarUrl?: string | null;
  /** Organizer contact email. When present the card invites a reply. */
  organizerContactEmail?: string | null;
};

// Keep in step with the registry `subjectTemplate`; this is the document <title>.
const subjectFor = (eventTitle: string) => `You're in: ${eventTitle}`;

const isValidISO = (iso: string) => !Number.isNaN(new Date(iso).getTime());

export const ApplicationApproved = (
  props: ApplicationApprovedProps,
): ReactElement => {
  const {
    eventTitle,
    approvalUrl,
    eventUrl,
    expiresAtISO,
    startsAtISO,
    endsAtISO,
    timezone,
    calendarUrl,
    organizerContactEmail,
  } = props;

  const buttonHref = approvalUrl ?? eventUrl ?? null;
  const when =
    startsAtISO && isValidISO(startsAtISO)
      ? formatEventTimeRange(
          startsAtISO,
          endsAtISO && isValidISO(endsAtISO) ? endsAtISO : undefined,
          { timeZone: usableTimeZone(timezone) },
        )
      : null;
  // The expiry belongs to the claim link: without `approvalUrl` the button
  // falls back to the plain event page, which never expires, so neither the
  // "Link works until" row nor the dated preview may show.
  const linkExpiresAtISO = approvalUrl && expiresAtISO ? expiresAtISO : null;
  const until = linkExpiresAtISO
    ? formatLinkExpiry(linkExpiresAtISO, timezone)
    : null;
  // The link's lifetime is set per approval, so the preview names the date
  // rather than a fixed number of days.
  const openBy = linkExpiresAtISO
    ? formatShortDate(linkExpiresAtISO, timezone)
    : null;

  const rows: LedgerRow[] = [
    { label: "Event", value: <strong>{eventTitle}</strong> },
  ];
  if (when) {
    rows.push({
      label: "When",
      value: calendarUrl ? (
        <>
          {when}
          <br />
          <Link href={calendarUrl} style={{ ...linkStyle, fontSize: "14px" }}>
            Add to calendar
          </Link>
        </>
      ) : (
        when
      ),
    });
  }
  if (until) rows.push({ label: "Link works until", value: until });

  return (
    <PrintedFrame
      subject={subjectFor(eventTitle)}
      previewText={
        openBy
          ? `The organizer approved your application. Open the event by ${openBy}.`
          : "The organizer approved your application."
      }
      kicker="Application approved"
      stage="approved"
      title="You're in"
      accentTitle
      organizerContactEmail={organizerContactEmail}
    >
      <Text style={bodyText}>
        The organizer approved your application. The event page is open to you
        now.
      </Text>
      <Ledger rows={rows} />
      {buttonHref ? (
        <PrintedCta kind="primary" label="Open the event" href={buttonHref} />
      ) : null}
      {approvalUrl ? (
        <>
          <SmallPrint>
            Button not working? Paste this link into your browser:
          </SmallPrint>
          <RawUrl url={approvalUrl} />
        </>
      ) : null}
    </PrintedFrame>
  );
};
