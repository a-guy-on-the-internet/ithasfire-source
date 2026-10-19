import { isUsSmsNumber } from "@th/ports/comms/sms";

// E.164 phone normalization shared by the SMS consent use cases. Keeps the
// ledger keyed by a single canonical representation so a STOP reply and a
// volunteer signup phone collapse to the same row.

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

/**
 * Normalize a raw phone string to E.164, or return null when it cannot be
 * represented as a valid E.164 number. Strips common formatting characters
 * (spaces, dashes, parens, dots) but never guesses a country code: a number
 * without a leading `+` is rejected rather than assumed to be US.
 */
export function normalizePhoneE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const cleaned = trimmed.replace(/[\s\-().]/g, "");
  return E164_REGEX.test(cleaned) ? cleaned : null;
}

/**
 * Normalize a number a volunteer typed for SMS to US E.164, or null when it
 * is not a number we text (`isUsSmsNumber`). Unlike `normalizePhoneE164`
 * this one does assume `+1` for a bare 10-digit number (or 11 digits
 * starting with 1): our SMS goes to the US only, so a number we could text
 * is always a `+1` number, and "(615) 555-0100" is what a US form receives.
 */
export function toUsSmsNumber(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s\-().]/g, "");
  let e164: string;
  if (cleaned.startsWith("+")) e164 = cleaned;
  else if (/^\d{10}$/.test(cleaned)) e164 = `+1${cleaned}`;
  else if (/^1\d{10}$/.test(cleaned)) e164 = `+${cleaned}`;
  else return null;
  return isUsSmsNumber(e164) ? e164 : null;
}
