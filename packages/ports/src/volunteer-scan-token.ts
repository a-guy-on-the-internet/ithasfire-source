/**
 * Port for signing & verifying volunteer scan QR tokens.
 *
 * A volunteer scan token is human+event scoped (NOT signup-scoped) so a
 * single token covers all of a volunteer's eligible signups for the event.
 * Tokens are stateless (HS256-signed) and are issued in two TTL classes:
 *   - "short" (default 24h) for email + in-app delivery
 *   - "print" (long-lived) for anything that ends up on paper
 *
 * "print" covers two different pieces of paper, and the difference is a
 * product boundary, not a technical one:
 *   - an ORGANIZER-minted badge — venue-issued credential stock, printed by
 *     whoever is accountable at the door; and
 *   - a VOLUNTEER-minted QR for their OWN signup — just "scan me in", for the
 *     volunteer whose phone is dead. NOT a badge, and must never be surfaced
 *     as one.
 * The payload is deliberately IDENTICAL in SHAPE for both: nothing downstream
 * should behave differently based on who pressed print, and a self-mint marker
 * in the claims would be an invitation to build authorization on one.
 * Provenance lives in the audit log, which is where it is actually read.
 *
 * CAVEAT, so nobody mistakes the above for secrecy: a JWT is base64, not
 * encrypted. Anyone holding the QR can read `iat` / `exp` without the secret,
 * and self-minted tokens carry a tighter TTL ceiling than organizer ones — so
 * for an event further out than that ceiling, `exp - iat` IS an observable
 * self-mint tell. Nothing reads it today and nothing should: it is an
 * unauthenticated, attacker-chosen value (they hold the paper), so it must
 * never become an authorization signal. The claim we make is "the verifier
 * does not branch on provenance", not "provenance is unobservable".
 *
 * REVOCATION. There is no revocation list, and none is needed for the normal
 * case: the token is only ever an ASSERTION OF IDENTITY (this human, this
 * event), never of eligibility. Every consumer re-reads live signup state
 * before it shows anything actionable — `resolveVolunteerSignupByToken` and
 * `getVolunteerContextForTicketScan` both filter to currently-eligible
 * signups — so a volunteer who withdraws, is rejected, or is removed resolves
 * to zero candidates from that moment on, even while their printed token is
 * still cryptographically valid until `exp`. Revoking one specific token is
 * therefore NOT a supported operation: the only lever is rotating the signing
 * secret, which voids every outstanding token platform-wide (every organizer
 * badge included). Treat that as a break-glass action, not routine hygiene.
 *
 * Adapters MUST surface verification errors as the typed error codes listed
 * below so use cases can map them to user-facing copy:
 *   - `volunteer_qr_expired`  — token's `exp` is in the past
 *   - `volunteer_qr_invalid`  — bad signature, malformed, missing claims, etc.
 */

export type VolunteerScanTokenKind = "short" | "print";

export interface VolunteerScanTokenSignInput {
  humanId: string;
  eventId: string;
  kind: VolunteerScanTokenKind;
  ttlSeconds: number;
  /**
   * Unique id for THIS token. Minted by the caller (not the adapter) so the
   * same value can be written to the audit row inside the mint transaction:
   * without it, two mints of the same signup in the same second with the same
   * TTL are byte-identical, and a recovered piece of paper cannot be joined
   * to the row that says who printed it and when.
   *
   * It is a random opaque id — deliberately NOT derived from the signup, the
   * actor, or the provenance.
   */
  jti: string;
}

export interface VolunteerScanTokenSignResult {
  token: string;
  expiresAt: Date;
}

export interface VolunteerScanTokenPayload {
  humanId: string;
  eventId: string;
  kind: VolunteerScanTokenKind;
  iat: number;
  exp: number;
  /**
   * Optional on the VERIFY side only. Tokens minted before `jti` existed are
   * still in circulation with real expiries (an organizer print token can run
   * to event end + 24h, capped at 90 days), and rejecting them would void
   * every outstanding badge the moment this deploys. Sign always sets it.
   */
  jti?: string;
}

export interface VolunteerScanTokenPort {
  sign(
    input: VolunteerScanTokenSignInput,
  ): Promise<VolunteerScanTokenSignResult>;
  verify(token: string): Promise<VolunteerScanTokenPayload>;
}
