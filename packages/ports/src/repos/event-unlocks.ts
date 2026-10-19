import type {
  CreateEventUnlockInput,
  EventUnlockRecord,
} from "@th/types/repos/event-unlocks";

export interface EventUnlocksRepo {
  /**
   * Create or update an unlock record for a human+event pair.
   * If a record already exists (even if revoked), it will be updated/unrevoked.
   */
  upsert(input: CreateEventUnlockInput): Promise<EventUnlockRecord>;

  /**
   * Check if a human has an active (non-revoked, non-expired) unlock for an event.
   */
  isUnlocked(eventId: string, humanId: string): Promise<boolean>;

  /**
   * Get the unlock record for a human+event pair, if it exists.
   */
  get(eventId: string, humanId: string): Promise<EventUnlockRecord | null>;

  /**
   * Revoke an unlock (sets revokedAt).
   */
  revoke(eventId: string, humanId: string): Promise<EventUnlockRecord | null>;

  /**
   * Revoke EVERY still-active unlock minted from a given application
   * submission (regardless of which humanId it was keyed to — the redeemer /
   * forwarded-link clicker may differ from the original applicant). Returns
   * the count revoked. Used when an approval is rescinded.
   */
  revokeBySubmission(applicationSubmissionId: string): Promise<number>;

  /**
   * Revoke EVERY still-active unlock redeemed through a given invite (FR-006:
   * revoking a PERSONAL invite removes everyone it let in). Returns the count
   * revoked. Only unlocks carrying this `inviteId` are touched; a SHARED
   * link reset deliberately does not call this (R5).
   */
  revokeByInvite(inviteId: string, at: Date): Promise<number>;

  /**
   * Re-point ONE human's still-active unlock on an event from any of
   * `fromInviteIds` to `toInviteId`, as a guarded write (the WHERE re-checks
   * event, human, current inviteId and revokedAt). Used by "Reset and remove
   * everyone" to keep a named guest (a live PERSONAL invite for their
   * verified email) who first came in through the shared link: their unlock
   * then lives and dies with their own invite. True when a row moved.
   */
  repointInvite(input: {
    eventId: string;
    humanId: string;
    fromInviteIds: ReadonlyArray<string>;
    toInviteId: string;
  }): Promise<boolean>;

  /**
   * List all unlocks for an event (for admin dashboard).
   */
  listByEventId(eventId: string): Promise<EventUnlockRecord[]>;

  /**
   * List all unlocks for a human (for "my unlocked events" view).
   */
  listByHumanId(humanId: string): Promise<EventUnlockRecord[]>;
}

export type {
  CreateEventUnlockInput,
  EventUnlockRecord,
  EventUnlockSource,
} from "@th/types/repos/event-unlocks";
