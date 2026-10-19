import { Button, Link, Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { Shell } from "./Shell";
import { spacing, tokens, primaryButtonStyle } from "../theme/tokens";

export type VolunteerGroupCoordinatorAssignedProps = {
  /**
   * Display name of the ask owner who made the assignment. Null when the
   * owner has no usable display name — the copy then omits the "who".
   */
  assignerName?: string | null;
  groupName: string;
  askTitle: string;
  /** The coordinator view: /volunteers/coordinate/<askId>. */
  coordinateUrl: string;
  /**
   * Present only when the coordinator was invited by email and has no
   * account yet — adds a "create your account" step before the group link.
   */
  accountCompletionUrl?: string | null;
};

/**
 * Subject line, shared with the registry's getSubject so the two cannot
 * drift. Mirrors the renderer title in core comms/renderers.ts
 * (volunteer.group-coordinator-assigned) — keep all three in sync.
 */
export function volunteerGroupCoordinatorAssignedSubject(
  props: Pick<
    VolunteerGroupCoordinatorAssignedProps,
    "assignerName" | "groupName" | "askTitle"
  >,
): string {
  return props.assignerName
    ? `${props.assignerName} made you coordinator of ${props.groupName} for ${props.askTitle}`
    : `You're now coordinating ${props.groupName} for ${props.askTitle}`;
}

/**
 * Coordinator-facing: an ask owner put this person in charge of one
 * volunteer group (generic-volunteering-asks FR-008). Informational only —
 * there is no accept step — so the copy says who, which group, what a
 * coordinator can do, and where to find it. No urgency.
 */
export const VolunteerGroupCoordinatorAssigned = (
  props: VolunteerGroupCoordinatorAssignedProps,
): ReactElement => {
  const {
    assignerName,
    groupName,
    askTitle,
    coordinateUrl,
    accountCompletionUrl,
  } = props;
  const title = volunteerGroupCoordinatorAssignedSubject(props);

  return (
    <Shell
      title={title}
      previewText={`You can now review, approve and check in the volunteers in ${groupName}.`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>Volunteer coordinator</Text>
        <Text style={headingStyle}>{title}</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          As coordinator of <strong>{groupName}</strong>, you can review,
          approve and check in the volunteers in your group.
        </Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={metaLineStyle}>
          <strong>Group:</strong> {groupName}
        </Text>
        <Text style={metaLineStyle}>
          <strong>Volunteer ask:</strong> {askTitle}
        </Text>
        {assignerName ? (
          <Text style={metaLineStyle}>
            <strong>Assigned by:</strong> {assignerName}
          </Text>
        ) : null}
      </Section>

      {accountCompletionUrl ? (
        <Section style={{ marginTop: spacing(3) }}>
          <Text style={bodyStyle}>
            You&apos;ll need an Ithas Fire account to see your group.
          </Text>
          <Section style={{ marginTop: spacing(2) }}>
            <Button href={accountCompletionUrl} style={primaryButtonStyle}>
              Create your account
            </Button>
          </Section>
          {/* Account completion doesn't redirect to the group, so the
              group link is here too for after they've signed up. */}
          <Text style={{ ...metaLineStyle, marginTop: spacing(2) }}>
            Once you&apos;re signed in, your group is here:{" "}
            <Link href={coordinateUrl} style={linkStyle}>
              {coordinateUrl}
            </Link>
          </Text>
        </Section>
      ) : (
        <Section style={{ marginTop: spacing(3) }}>
          <Button href={coordinateUrl} style={primaryButtonStyle}>
            Open your group
          </Button>
        </Section>
      )}

      <Text style={footerStyle}>
        You&apos;re receiving this because
        {assignerName ? ` ${assignerName}` : " an organizer"} made you a
        volunteer coordinator on Ithas Fire.
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

const linkStyle: CSSProperties = {
  color: tokens.colors.text,
  textDecoration: "underline",
  wordBreak: "break-all",
};

const footerStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};
