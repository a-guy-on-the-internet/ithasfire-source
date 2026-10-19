import { Button, Link, Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { Shell } from "./Shell";
import { spacing, tokens, primaryButtonStyle } from "../theme/tokens";

export type LineupPayoutInviteProps = {
  /** The editor who sent the invite (never empty). */
  inviterName: string;
  eventTitle: string;
  /** Full date + time + zone city; empty → left out. */
  whenLabel: string;
  /** The invitee's admin Payments page, where Stripe Connect is set up. */
  payoutsUrl: string;
  /**
   * Present only while the invitee has no usable account (a shadow profile
   * minted from the address the editor typed) — adds a "finish your
   * account" step before payouts.
   */
  accountCompletionUrl?: string | null;
  /** `{publicAppUrl}/my-lineups` — where they can take themselves off. */
  lineupsUrl: string;
  /** Any ticket type can take money: only then is there "a share of ticket sales". */
  paidEvent: boolean;
  /** Someone (an owning org or human) hears if the person leaves. */
  organiserWillBeTold: boolean;
};

/**
 * Subject line, shared with the registry's getSubject so the two cannot
 * drift.
 */
export function lineupPayoutInviteSubject(
  props: Pick<LineupPayoutInviteProps, "inviterName" | "eventTitle">,
): string {
  return `${props.inviterName} invited you to set up payouts for ${props.eventTitle}`;
}

/**
 * The invite behind the event builder's "Invite to set up payouts" (the
 * `events.inviteLineupHumanToRegister` mutation). Tells the person they are
 * on the lineup, why they are being asked, and the one or two steps to get
 * paid. Also the ONLY email they get about this event from the lineup
 * feature — their "you're on the lineup" notice goes in-app for an invited
 * row. Gender-neutral copy; no urgency.
 */
export const LineupPayoutInvite = (
  props: LineupPayoutInviteProps,
): ReactElement => {
  const {
    eventTitle,
    whenLabel,
    payoutsUrl,
    accountCompletionUrl,
    lineupsUrl,
    paidEvent,
    organiserWillBeTold,
  } = props;
  const title = lineupPayoutInviteSubject(props);

  return (
    <Shell
      title={title}
      previewText={`You're on the lineup for ${eventTitle}. Connect a payout account to get paid.`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={headingStyle}>{title}</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          You&apos;re on the lineup for <strong>{eventTitle}</strong>.{" "}
          {paidEvent
            ? "To be paid your share of ticket sales, connect a payout account with Stripe."
            : "To be paid through Ithas Fire for this event, connect a payout account with Stripe."}
        </Text>
        {whenLabel ? (
          <Text style={{ ...metaLineStyle, marginTop: spacing(1) }}>
            <strong>When:</strong> {whenLabel}
          </Text>
        ) : null}
      </Section>

      {accountCompletionUrl ? (
        <Section style={{ marginTop: spacing(3) }}>
          <Text style={bodyStyle}>
            First, finish your Ithas Fire account with this email address.
          </Text>
          <Section style={{ marginTop: spacing(2) }}>
            <Button href={accountCompletionUrl} style={primaryButtonStyle}>
              Finish your account
            </Button>
          </Section>
          <Text style={{ ...metaLineStyle, marginTop: spacing(2) }}>
            Then set up payouts here:{" "}
            <Link href={payoutsUrl} style={linkStyle}>
              {payoutsUrl}
            </Link>
          </Text>
        </Section>
      ) : (
        <Section style={{ marginTop: spacing(3) }}>
          <Button href={payoutsUrl} style={primaryButtonStyle}>
            Set up payouts
          </Button>
        </Section>
      )}

      <Text style={{ ...metaLineStyle, marginTop: spacing(3) }}>
        Not on this lineup, or the details are wrong? You can{" "}
        <Link href={lineupsUrl} style={linkStyle}>
          take yourself off
        </Link>
        .{organiserWillBeTold ? " The organiser will be told." : ""}
      </Text>

      <Text style={footerStyle}>
        You&apos;re getting this because someone added you to an event on
        Ithas Fire and asked to pay you through it.
      </Text>
    </Shell>
  );
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
