/**
 * Display-name helpers shared by every mail adapter (Resend, SES, SMTP) that
 * builds an RFC 5322 `"Name" <address>` mailbox from a caller-supplied name.
 */

/**
 * Header-injection hardening for a display name: collapse CR/LF and other
 * line-breaking whitespace to a single space and drop remaining control
 * characters. Mirrors `sanitizeSubject` in
 * `packages/core/src/use-cases/comms/channels/send-email.ts`.
 */
export const sanitizeDisplayName = (name: string): string =>
  name
    .replace(/[\r\n\t\f\v]+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();

/**
 * Escape `\` and `"` per RFC 5322 quoted-string rules so a display name
 * can't prematurely close the quoted string and append a second mailbox
 * (e.g. `Attacker", "second@evil.com` breaking out of `"${name}" <...>`).
 */
export const escapeQuotedString = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
