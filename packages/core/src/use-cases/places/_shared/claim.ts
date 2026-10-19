import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Shared helpers for the claim-venue flow (docs/specs/2026-07-05/
 * claim-venue-flow.spec.yaml). Kept dependency-free so both submit-place-claim
 * and the email-challenge use cases can reuse the domain + proof logic.
 */

/**
 * Public / free email providers that can NEVER satisfy an email-domain proof
 * (a gmail address does not prove you operate the venue). Maintained blocklist
 * per NFR-001 / FR-003. Lowercase, registrable-domain form.
 */
export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "tutanota.com",
  "fastmail.com",
  "hey.com",
]);

/** Number of failed challenge attempts before the challenge locks (FR / NFR). */
export const MAX_CHALLENGE_ATTEMPTS = 5;

/** Challenge time-to-live in milliseconds (15 minutes). */
export const CHALLENGE_TTL_MS = 15 * 60 * 1000;

/**
 * Normalize an arbitrary hostname / email domain to its registrable form: the
 * bare host, lowercased, `www.` stripped. NOTE: this is a pragmatic heuristic,
 * NOT a full Public Suffix List resolution — it intentionally keeps the full
 * host (minus a leading `www.`). Domain proof only ever yields a PROVISIONAL
 * claim gated by an admin backstop (except the TRUSTED_IMPORT fast-track), so a
 * loose registrable extraction is acceptable here. See spec risk notes.
 */
export function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.replace(/^www\./, "");
}

/**
 * Extract the registrable domain from a website URL (or bare host). Returns null
 * when the value has no parseable host.
 */
export function registrableDomainFromWebsite(
  website: string | null | undefined,
): string | null {
  if (!website) return null;
  const value = website.trim();
  if (!value) return null;

  let host: string | null = null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      ? value
      : `https://${value}`;
    host = new URL(withScheme).hostname;
  } catch {
    // Fall back to treating the value as a bare host token.
    host = value.split("/")[0] ?? null;
  }
  if (!host) return null;
  return normalizeDomain(host);
}

/** Extract the domain part of an email address (after the last `@`). */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return normalizeDomain(email.slice(at + 1));
}

export function isFreeEmailDomain(domain: string): boolean {
  return FREE_EMAIL_DOMAINS.has(domain);
}

/**
 * Whether an email domain is a plausible SIGNAL of control over a website's
 * registrable domain — bidirectional and deliberately loose (either is a
 * subdomain of the other). Only ever yields a PROVISIONAL claim (admin
 * backstop), so the looseness is acceptable here.
 */
export function domainMatchesWebsite(
  emailDom: string,
  websiteDom: string,
): boolean {
  if (emailDom === websiteDom) return true;
  return (
    emailDom.endsWith(`.${websiteDom}`) || websiteDom.endsWith(`.${emailDom}`)
  );
}

/**
 * Strict FORWARD-direction match for the FR-010 auto-verify fast-track: the
 * email domain must equal the website's registrable domain, or be a subdomain
 * OF it (`sales.acme.com` for `acme.com`). The reverse (a parent-domain email
 * for a subdomain website) is intentionally NOT auto-verified — it stays
 * provisional + admin-reviewed. On a non-PSL heuristic this is the safe side.
 */
export function domainMatchesWebsiteForward(
  emailDom: string,
  websiteDom: string,
): boolean {
  return emailDom === websiteDom || emailDom.endsWith(`.${websiteDom}`);
}

/** Generate a zero-padded 6-digit numeric challenge code. */
export function generateChallengeCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** SHA-256 hex hash of a challenge code (codes are never stored in plaintext). */
export function hashChallengeCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

/** Constant-time comparison of a candidate code against a stored hash. */
export function verifyChallengeCode(
  candidate: string,
  storedHash: string,
): boolean {
  const candidateHash = hashChallengeCode(candidate);
  const a = Buffer.from(candidateHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Structural detector for a Postgres unique-constraint violation surfaced by
 * Prisma (`P2002`). Core can't import Prisma, so we duck-type the code. MUST be
 * checked OUTSIDE the transaction: an in-tx P2002 aborts the Postgres tx
 * (25P02), so the tx rolls back and the caller catches it here.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "P2002"
  );
}

export type ClaimOwner =
  | { kind: "human"; humanId: string }
  | { kind: "org"; orgId: string };

/** Resolve a claim owner to the (ownerType, ownerId) persistence pair. */
export function ownerToPair(owner: ClaimOwner): {
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
} {
  return owner.kind === "org"
    ? { ownerType: "ORGANIZATION", ownerId: owner.orgId }
    : { ownerType: "HUMAN", ownerId: owner.humanId };
}
