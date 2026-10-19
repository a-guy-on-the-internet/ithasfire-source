import { Text } from "@react-email/components";
import { type ReactElement } from "react";

import { formatShortDate } from "./components/application-dates";
import { Ledger, type LedgerRow } from "./components/Ledger";
import { PrintedCta } from "./components/PrintedCta";
import { PrintedFrame, SmallPrint } from "./components/PrintedFrame";
import { bodyText } from "./components/printed-styles";

export type ApplicationReceivedProps = {
  eventTitle: string;
  /**
   * Event page; drives the "Check status" button. Omitted when absent, and
   * for guests, who can't see their status on the event page.
   */
  eventUrl?: string | null;
  /** When the application was submitted; the "Applied" row. */
  appliedAtISO?: string | null;
  /** The event's IANA timezone; dates render in it. */
  timezone?: string | null;
  /**
   * Guest (no account) applicant: adds the "Didn't apply?" line and drops the
   * "Check status" button.
   */
  isGuest?: boolean;
  /** Organizer contact email. When present the card invites a reply. */
  organizerContactEmail?: string | null;
};

// Keep in step with the registry `subjectTemplate`; this is the document <title>.
const subjectFor = (eventTitle: string) => `Application sent: ${eventTitle}`;

/**
 * Applicant acknowledgement, sent right after an event application is
 * submitted. Says plainly that the spot is NOT confirmed yet and that the
 * next email is the decision.
 */
export const ApplicationReceived = (
  props: ApplicationReceivedProps,
): ReactElement => {
  const {
    eventTitle,
    eventUrl,
    appliedAtISO,
    timezone,
    isGuest,
    organizerContactEmail,
  } = props;

  const applied = appliedAtISO ? formatShortDate(appliedAtISO, timezone) : null;
  const rows: LedgerRow[] = [
    { label: "Event", value: <strong>{eventTitle}</strong> },
    ...(applied ? [{ label: "Applied", value: applied }] : []),
  ];

  return (
    <PrintedFrame
      subject={subjectFor(eventTitle)}
      previewText="Your spot isn't confirmed yet. We'll email you when the organizer decides."
      kicker="Application sent"
      stage="review"
      title="Your application is in"
      organizerContactEmail={organizerContactEmail}
    >
      <Text style={bodyText}>
        The organizer of <strong>{eventTitle}</strong> has your application.
        Your spot isn&apos;t confirmed yet. We&apos;ll email you when they
        decide.
      </Text>
      <Ledger rows={rows} />
      {!isGuest && eventUrl ? (
        <PrintedCta kind="secondary" label="Check status" href={eventUrl} />
      ) : null}
      {isGuest ? (
        <SmallPrint>
          Didn&apos;t apply? Ignore this email. Someone may have typed your
          address by mistake. No account was created.
        </SmallPrint>
      ) : null}
    </PrintedFrame>
  );
};
