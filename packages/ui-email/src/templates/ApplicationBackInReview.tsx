import { Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Ledger } from "./components/Ledger";
import { PrintedCta } from "./components/PrintedCta";
import { PrintedFrame } from "./components/PrintedFrame";
import { bodyText } from "./components/printed-styles";

export type ApplicationBackInReviewProps = {
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
const subjectFor = (eventTitle: string) => `Back in review: ${eventTitle}`;

/**
 * Sent when an organizer withdraws an approval and the application returns to
 * review. It must NOT say the reader lost access: a guest's unlock cookie from
 * the earlier approval can't be revoked, so "you no longer have access" could
 * be false. It says only what changed and what happens next.
 */
export const ApplicationBackInReview = (
  props: ApplicationBackInReviewProps,
): ReactElement => {
  const { eventTitle, eventUrl, isGuest, organizerContactEmail } = props;

  return (
    <PrintedFrame
      subject={subjectFor(eventTitle)}
      previewText="The organizer withdrew their approval. We'll email you when they decide."
      kicker="Application update"
      stage="back_in_review"
      title="Your approval was withdrawn"
      organizerContactEmail={organizerContactEmail}
    >
      <Text style={bodyText}>
        The organizer of <strong>{eventTitle}</strong> withdrew their approval.
        Your application is back in review, and we&apos;ll email you when they
        decide.
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
