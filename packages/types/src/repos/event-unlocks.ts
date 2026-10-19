export type EventUnlockSource =
  | "PASSWORD"
  | "APPLICATION"
  | "ADMIN"
  | "INVITE_LIST"
  | "MAGIC_LINK";

export interface EventUnlockRecord {
  id: string;
  eventId: string;
  humanId: string;
  source: EventUnlockSource;
  applicationSubmissionId: string | null;
  /** The invite link this unlock was redeemed through (source MAGIC_LINK). */
  inviteId: string | null;
  metadata: Record<string, unknown>;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEventUnlockInput {
  eventId: string;
  humanId: string;
  source: EventUnlockSource;
  applicationSubmissionId?: string | null;
  /**
   * The invite link this unlock came through. Like `applicationSubmissionId`,
   * an upsert onto an existing row overwrites it (absent = null), so the row
   * always names the grant that last let this human in.
   */
  inviteId?: string | null;
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
}
