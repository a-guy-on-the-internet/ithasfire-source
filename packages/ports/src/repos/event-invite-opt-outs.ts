/**
 * "Stop invites from this organiser" (gated-event invite links, owner
 * ruling 2026-10-05): an email address that asked one organiser for no more
 * event invites. The organiser is the event's OWNER: an org, or the human
 * who owns person-owned events.
 *
 * "Stop all event invites" (owner ruling 3(b), 2026-10-06): the same address
 * asked EVERY organiser for no more event invites. Stored as a row with no
 * owner. A DB CHECK allows at most one owner per row.
 *
 * Both kinds only block SENDING new invites; invites already sent keep
 * working (redeem and peek never read this repo).
 *
 * The address is never stored or passed here (fix round 1, security W3):
 * core hands over `hashInviteOptOutEmail(canonical address)`, a keyed
 * 43-char base64url HMAC. The repo only compares hashes.
 */
export type EventInviteOptOutOwner =
  | { kind: "ORG"; orgId: string }
  | { kind: "HUMAN"; humanId: string };

/**
 * Which opt-out already covers an address for one organiser: "ALL" when the
 * address stopped every organiser (it wins when both rows exist),
 * "ORGANISER" when it stopped only this one.
 */
export type EventInviteOptOutStanding = "ORGANISER" | "ALL";

export interface EventInviteOptOutsRepo {
  /**
   * Record the per-organiser opt-out. Idempotent: opting out again is a
   * no-op (the per-owner partial unique index plus ON CONFLICT DO NOTHING).
   * `created` is false when the row was already there.
   */
  add(input: {
    owner: EventInviteOptOutOwner;
    emailHash: string;
  }): Promise<{ created: boolean }>;
  /**
   * Record "Stop all event invites" (an ownerless row). Idempotent, like
   * `add`; `created` is false when it was already there.
   */
  addForAllOrganisers(input: { emailHash: string }): Promise<{ created: boolean }>;
  /**
   * What already covers this ONE address for this organiser, or null. One
   * query. Never answers for any address but the one given.
   */
  standing(input: {
    owner: EventInviteOptOutOwner;
    emailHash: string;
  }): Promise<EventInviteOptOutStanding | null>;
  /**
   * Which of `emailHashes` must not get this owner's invites: opted out of
   * this owner, or of all organisers. The returned set holds the matching
   * hashes and does not say which kind matched. A null owner checks the
   * all-organisers opt-out only. An empty input resolves to an empty set
   * without a query.
   */
  listOptedOut(input: {
    owner: EventInviteOptOutOwner | null;
    emailHashes: ReadonlyArray<string>;
  }): Promise<Set<string>>;
}
