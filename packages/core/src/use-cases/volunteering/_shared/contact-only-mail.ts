import { createHash } from "node:crypto";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";

import { describeError } from "../../../lib/io";

/**
 * Direct mail to the contact address of a signup that has NO linked Human —
 * in practice a CONTACT-ONLY signup (an anonymous signup naming an email
 * that already has an account). Such a signup has no notify() identity, so
 * without this the person gets no confirmation and no decision.
 *
 * RELAY SAFETY. The confirmation is triggered from an ANONYMOUS endpoint, so
 * anyone can make us send it to any address. The copy is therefore FIXED:
 * no organiser-authored body text, no links, nothing a sender controls
 * except the ask title (plain text, control characters stripped, length
 * capped). And it is capped per recipient — see below.
 */

export type ContactOnlyMailKind = "received" | "approved" | "declined";

/** Per-recipient daily ceiling across all three kinds. */
export const CONTACT_ONLY_MAIL_PER_RECIPIENT_DAILY_MAX = 3;
/**
 * Per-ask daily ceiling. The ask title is the one sender-influenced string
 * in this mail, so an organiser who put a phishing line in their title and
 * then signed up a list of victims could otherwise fan it out; this bounds
 * that to one ask's worth per day regardless of how many addresses.
 */
export const CONTACT_ONLY_MAIL_PER_ASK_DAILY_MAX = 50;
const CONTACT_ONLY_MAIL_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Keyed by a hash so raw addresses never sit in Redis key names — the same
 * scheme as the waitlist confirmation caps (`waitlistConfirmationRecipientKey`).
 */
export const contactOnlyMailRecipientKey = (email: string): string =>
  `volunteer:contactOnlyMail:to:${createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")}`;

export const contactOnlyMailAskKey = (askId: string): string =>
  `volunteer:contactOnlyMail:ask:${askId}`;

export type ContactOnlyMailDeps = {
  mailer?: Pick<MailerPort, "send"> | null;
  rateLimit?: Pick<RateLimitPort, "consume"> | null;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

const MAX_TITLE = 120;

/** Plain, single-line, bounded — the only sender-influenced text we print. */
function safeTitle(title: string): string {
  const flat = title
    // Control characters (CR/LF etc.) AND format characters — bidi
    // overrides/isolates and zero-width joiners (\p{Cf}) can make a title
    // render as something other than what it says.
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\p{Cf}+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}

const NOT_YOU =
  "If this wasn't you, you can ignore this email. Nothing is linked to an Ithas Fire account.";

/** The fixed copy. Exported for tests. */
export function renderContactOnlyMail(
  kind: ContactOnlyMailKind,
  askTitle: string,
): { subject: string; text: string } {
  const title = safeTitle(askTitle);
  switch (kind) {
    case "received":
      return {
        // No title in the subject: this one is triggered anonymously, so the
        // only sender-influenced text stays in the body, never in the line
        // an inbox shows first.
        subject: "Volunteer signup received",
        text: [
          `Someone signed up to volunteer for ${title} with this address.`,
          "The organiser will review the signup. If it's approved or declined, we'll email this address.",
          "This signup was made while signed out, so it isn't linked to an Ithas Fire account. To see signups in your account, sign in before you sign up.",
          NOT_YOU,
        ].join("\n\n"),
      };
    case "approved":
      return {
        subject: `Volunteer signup approved: ${title}`,
        text: [
          `The volunteer signup for ${title} made with this address was approved.`,
          NOT_YOU,
        ].join("\n\n"),
      };
    case "declined":
      return {
        subject: `Volunteer signup declined: ${title}`,
        text: [
          `The volunteer signup for ${title} made with this address was declined.`,
          NOT_YOU,
        ].join("\n\n"),
      };
  }
}

function report(
  deps: ContactOnlyMailDeps,
  error: unknown,
  reason: string,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { useCase: "volunteerContactOnlyMail", reason },
      extra,
    });
  } catch {
    // Best-effort reporting only.
  }
}

/**
 * Send one fixed-copy email to a contact-only signup's address. NEVER
 * throws: every failure is logged and reported, because the signup or the
 * review decision it follows is already persisted.
 *
 * The per-recipient budget fails CLOSED — no limiter, a limiter error, or
 * an exhausted budget all skip the send (the first two loudly). A lost
 * confirmation is cheaper than an open relay.
 */
export async function sendContactOnlySignupMail(
  deps: ContactOnlyMailDeps,
  input: {
    kind: ContactOnlyMailKind;
    signupId: string;
    /** The ask (for event signups, the event's EVENT-subject ask). */
    askId: string;
    contactEmail: string;
    askTitle: string;
  },
): Promise<"sent" | "skipped"> {
  const extra = {
    signupId: input.signupId,
    askId: input.askId,
    kind: input.kind,
  };

  if (!deps.mailer) {
    deps.logger?.error("volunteering.contactOnlyMail.mailer_unwired", extra);
    report(deps, new Error("contact-only mail: mailer not wired"), "mailer_unwired", extra);
    return "skipped";
  }
  if (!deps.rateLimit) {
    deps.logger?.error("volunteering.contactOnlyMail.limiter_unwired", extra);
    report(deps, new Error("contact-only mail: rate limiter not wired"), "limiter_unwired", extra);
    return "skipped";
  }

  try {
    // Per-ask first, so a capped ask doesn't also spend the recipient's
    // allowance.
    const perAsk = await deps.rateLimit.consume(
      contactOnlyMailAskKey(input.askId),
      CONTACT_ONLY_MAIL_PER_ASK_DAILY_MAX,
      CONTACT_ONLY_MAIL_WINDOW_SECONDS,
    );
    if (!perAsk.allowed) {
      deps.logger?.warn("volunteering.contactOnlyMail.ask_daily_cap", extra);
      report(
        deps,
        new Error("contact-only mail: per-ask daily cap reached"),
        "ask_daily_cap",
        extra,
      );
      return "skipped";
    }
    const budget = await deps.rateLimit.consume(
      contactOnlyMailRecipientKey(input.contactEmail),
      CONTACT_ONLY_MAIL_PER_RECIPIENT_DAILY_MAX,
      CONTACT_ONLY_MAIL_WINDOW_SECONDS,
    );
    if (!budget.allowed) {
      deps.logger?.info("volunteering.contactOnlyMail.recipient_daily_cap", extra);
      return "skipped";
    }
  } catch (error) {
    deps.logger?.error("volunteering.contactOnlyMail.cap_consume_failed", {
      ...extra,
      error: describeError(error),
    });
    report(deps, error, "cap_consume_failed", extra);
    return "skipped";
  }

  const { subject, text } = renderContactOnlyMail(input.kind, input.askTitle);
  try {
    const out = await deps.mailer.send({
      to: { to: input.contactEmail },
      subject,
      text,
      idempotencyKey: `volunteer-contact-only:${input.signupId}:${input.kind}`,
      tags: ["volunteer", "contact-only", input.kind],
      metadata: { signupId: input.signupId, kind: input.kind },
    });
    if (!out.result.success) {
      const error = new Error(
        `contact-only mail failed: ${out.result.errorCode ?? "unknown"}`,
      );
      deps.logger?.error("volunteering.contactOnlyMail.send_failed", {
        ...extra,
        error: describeError(error),
      });
      report(deps, error, "send_failed", extra);
      return "skipped";
    }
    return "sent";
  } catch (error) {
    deps.logger?.error("volunteering.contactOnlyMail.send_failed", {
      ...extra,
      error: describeError(error),
    });
    report(deps, error, "send_failed", extra);
    return "skipped";
  }
}
