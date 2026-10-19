/**
 * Bans that stick (2026-09-29).
 *
 * Two concerns, both keyed on a BANNED human:
 *
 *  - BannedIdentity rows: keyed HASHES (never plaintext) of the banned
 *    human's canonical email and recent network prefixes. EMAIL rows block
 *    sign-up and email changes; NETWORK rows flag same-network sign-ups.
 *  - Banned owners: whether a human or an org is withheld from public reads
 *    because of a ban. DERIVED from `Human.status` at read time — nothing is
 *    stored, so reactivating a human brings everything back.
 */

import type { WithheldOwnerIds } from "@th/types/repos/events";

export type BannedIdentityKind = "EMAIL" | "NETWORK";

export interface BansRepo {
  /**
   * Upsert identity rows for a banned human, per
   * `(sourceHumanId, kind, valueHash)`. An existing row keeps the LATER
   * expiry (NULL = never expires wins), so a re-ban never shortens coverage.
   * Returns the rows inserted or updated.
   */
  recordForHuman(input: {
    humanId: string;
    rows: Array<{
      kind: BannedIdentityKind;
      valueHash: string;
      expiresAt: Date | null;
    }>;
  }): Promise<{ count: number }>;

  /** Remove every identity row this human is the source of. */
  removeForHuman(humanId: string): Promise<{ count: number }>;

  /**
   * Whether a row of `kind` with `valueHash` is active at `now` (no expiry,
   * or expiring after `now`).
   */
  isActive(input: {
    kind: BannedIdentityKind;
    valueHash: string;
    now: Date;
  }): Promise<boolean>;

  /** Retention purge: delete rows whose `expiresAt` is before `before`. */
  purgeExpired(input: { before: Date }): Promise<{ count: number }>;

  /**
   * Which of these owners are withheld from public reads:
   *  - a human whose status is BANNED;
   *  - an org with at least one OWNER member and NO OWNER member who is not
   *    BANNED (i.e. its sole owner — or every owner — is banned).
   * Unknown ids are simply absent from the result.
   */
  findBannedOwners(input: {
    humanIds: string[];
    orgIds: string[];
  }): Promise<{ humanIds: string[]; orgIds: string[] }>;

  /**
   * The WHOLE withheld set (same rule as {@link findBannedOwners}), in one
   * small query. For a request that makes several list reads with
   * `excludeBannedOwners`: resolve once, pass it to each read as
   * `withheldOwners`, and the reads share one snapshot of the bans.
   */
  listWithheldOwners(): Promise<WithheldOwnerIds>;
}
