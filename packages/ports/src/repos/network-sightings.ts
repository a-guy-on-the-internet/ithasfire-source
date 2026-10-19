/**
 * Network sightings — keyed hashes of the network a sign-up or sign-in came
 * from (ban-that-sticks, 2026-09-29). The repo only ever sees HASHES: the raw
 * IP is hashed in core (`lib/security/network-identity.ts`) before any call
 * here, so no method on this port accepts or returns an IP address.
 */

export type NetworkSightingKind = "SIGN_UP" | "SIGN_IN";

export type RecordNetworkSightingInput = {
  authUserId: string;
  humanId: string | null;
  kind: NetworkSightingKind;
  /** HMAC of the full normalised IP. */
  ipHash: string;
  /** HMAC of the /24 (IPv4) or /48 (IPv6) prefix. */
  networkHash: string;
  /** ISO-3166 alpha-2 (or Cloudflare's XX / T1), or null. */
  country: string | null;
  /** Coarse "Browser on OS" family, or null. Never a full UA string. */
  userAgentFamily: string | null;
};

/** A recent SIGN_UP whose network matches an active NETWORK ban. */
export type FlaggedSignupRecord = {
  humanId: string;
  authUserId: string;
  name: string | null;
  email: string;
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "BANNED";
  signedUpAt: Date;
  country: string | null;
  /** Every banned or suspended human whose network this sign-up shares. */
  matches: Array<{
    bannedHumanId: string;
    bannedHumanName: string | null;
    /** The source account's status now: BANNED or SUSPENDED. */
    bannedHumanStatus: "INVITED" | "ACTIVE" | "SUSPENDED" | "BANNED";
  }>;
};

export interface NetworkSightingsRepo {
  record(input: RecordNetworkSightingInput): Promise<void>;

  /**
   * Distinct network hashes seen for this human (by `humanId`, or by the
   * AuthUser linked to it) at or after `since`.
   */
  listNetworkHashesForHuman(input: {
    humanId: string;
    since: Date;
  }): Promise<string[]>;

  /**
   * DERIVED, never stored: SIGN_UP sightings at or after `since` whose
   * `networkHash` equals the value of a NETWORK BannedIdentity that is
   * active at `now` (no expiry, or expiring after `now`), excluding the
   * banned human's own sightings. One row per signed-up human, newest first.
   */
  listFlaggedSignups(input: {
    since: Date;
    now: Date;
    limit: number;
    offset: number;
  }): Promise<{ items: FlaggedSignupRecord[]; total: number }>;

  /** Retention purge: delete every sighting created before `before`. */
  purgeOlderThan(input: { before: Date }): Promise<{ count: number }>;
}
