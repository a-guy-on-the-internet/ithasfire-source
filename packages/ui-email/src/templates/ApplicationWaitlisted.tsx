import { Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Ledger } from "./components/Ledger";
import { PrintedCta } from "./components/PrintedCta";
import { PrintedFrame } from "./components/PrintedFrame";
import { bodyText } from "./components/printed-styles";

export type ApplicationWaitlistedProps = {
  eventTitle: string;
  /**
   * Event page; drives the "Check status" button. Omitted when absent, and
   * for guests, who can't see their status on the event page.
   */
  eventUrl?: string | null;
  /** Guest (no account) applicant: no "Check status" button. */
  isGuest?: boolean;
  /** Organizer contact email. When present the card invites a reply. */
  organizerContactEmail?: string | null;
};

// Keep in step with the registry `subjectTemplate`; this is the document <title>.
const subjectFor = (eventTitle: string) => `Waitlisted: ${eventTitle}`;

/**
 * Applicant-facing WAITLISTED decision. No reason, no promises: if a spot
 * opens, the next email carries the link.
 */
export const ApplicationWaitlisted = (
  props: ApplicationWaitlistedProps,
): ReactElement => {
  const { eventTitle, eventUrl, isGuest, organizerContactEmail } = props;

  return (
    <PrintedFrame
      subject={subjectFor(eventTitle)}
      previewText="If a spot opens, we'll email you a link."
      kicker="Application decision"
      stage="waitlist"
      title="You're on the waitlist"
      organizerContactEmail={organizerContactEmail}
    >
      <Text style={bodyText}>
        The organizer of <strong>{eventTitle}</strong> put your application on
        the waitlist. If a spot opens, we&apos;ll email you a link. You
        don&apos;t need to do anything until then.
      </Text>
      <Ledger
        rows={[{ label: "Event", value: <strong>{eventTitle}</strong> }]}
      />
      {!isGuest && eventUrl ? (
        <PrintedCta kind="secondary" label="Check status" href={eventUrl} />
      ) : null}
    </PrintedFrame>
  );
};
