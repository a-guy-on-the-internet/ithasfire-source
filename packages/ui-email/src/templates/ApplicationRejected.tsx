import { Text } from "@react-email/components";
import { type ReactElement } from "react";

import { OrganizerNote } from "./components/OrganizerNote";
import { PrintedCta } from "./components/PrintedCta";
import { PrintedFrame } from "./components/PrintedFrame";
import { bodyText } from "./components/printed-styles";

export type ApplicationRejectedProps = {
  eventTitle: string;
  /** The organizer's note, shown verbatim under "From the organizer". */
  decisionReason?: string | null;
  /** The organizer's public page; the "other events" link. */
  organizerEventsUrl?: string | null;
  /** Organizer contact email. When present the card invites a reply. */
  organizerContactEmail?: string | null;
};

// Keep in step with the registry `subjectTemplate`; this is the document <title>.
const subjectFor = (eventTitle: string) => `Not approved: ${eventTitle}`;

/**
 * Applicant-facing decline. Direct, not soft (owner ruling 2026-09-30): it
 * states the decision, shows the organizer's note when there is one, and
 * offers their other events. No apology, no "thanks for applying".
 */
export const ApplicationRejected = (
  props: ApplicationRejectedProps,
): ReactElement => {
  const {
    eventTitle,
    decisionReason,
    organizerEventsUrl,
    organizerContactEmail,
  } = props;

  return (
    <PrintedFrame
      subject={subjectFor(eventTitle)}
      previewText={
        decisionReason
          ? "The organizer didn't approve your application and left a note."
          : "The organizer didn't approve your application."
      }
      kicker="Application decision"
      stage="declined"
      title="Not approved"
      organizerContactEmail={organizerContactEmail}
    >
      <Text style={bodyText}>
        The organizer of <strong>{eventTitle}</strong> didn&apos;t approve your
        application.
      </Text>
      <OrganizerNote note={decisionReason} />
      {organizerEventsUrl ? (
        <PrintedCta
          kind="link"
          label="See other events from this organizer"
          href={organizerEventsUrl}
        />
      ) : null}
    </PrintedFrame>
  );
};
