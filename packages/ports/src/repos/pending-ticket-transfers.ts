export type PendingTicketTransferStatus =
  | "PENDING"
  | "CLAIMED"
  | "CANCELLED"
  | "EXPIRED";

export interface PendingTicketTransferRecord {
  id: string;
  ticketId: string;
  fromHumanId: string;
  recipientEmail: string;
  reason: string;
  token: string;
  status: PendingTicketTransferStatus;
  expiresAt: Date;
  createdAt: Date;
  claimedAt: Date | null;
  claimedByHumanId: string | null;
  cancelledAt: Date | null;
}

export interface CreatePendingTicketTransferInput {
  ticketId: string;
  fromHumanId: string;
  recipientEmail: string;
  reason: string;
  token: string;
  expiresAt: Date;
}

export interface PendingTicketTransfersRepo {
  create(
    input: CreatePendingTicketTransferInput,
  ): Promise<PendingTicketTransferRecord>;

  getById(id: string): Promise<PendingTicketTransferRecord | null>;

  getByToken(token: string): Promise<PendingTicketTransferRecord | null>;

  /**
   * Find all PENDING transfers for a given recipient email.
   * Used after account creation to surface claimable transfers.
   */
  findPendingByEmail(email: string): Promise<PendingTicketTransferRecord[]>;

  /**
   * Find active (PENDING) transfer for a specific ticket.
   * A ticket may have at most one pending transfer at a time.
   */
  findPendingByTicketId(
    ticketId: string,
  ): Promise<PendingTicketTransferRecord | null>;

  /**
   * Mark a pending transfer as claimed by a human.
   */
  markClaimed(
    id: string,
    claimedByHumanId: string,
    claimedAt: Date,
  ): Promise<void>;

  /**
   * Cancel a pending transfer (by the sender).
   */
  markCancelled(id: string, cancelledAt: Date): Promise<void>;

  /**
   * List all PENDING transfers initiated by a given human.
   * Used to show outgoing pending transfers in the sender's UI.
   */
  findPendingByFromHumanId(
    fromHumanId: string,
  ): Promise<PendingTicketTransferRecord[]>;

  /**
   * Mark this ticket's PENDING invites whose `expiresAt` is strictly before
   * `now` as EXPIRED; returns how many rows changed. Strict `<` matches the
   * claim path, where an invite is still claimable AT `expiresAt`. Lets a
   * lapsed invite stop blocking a new one without a sweep job.
   */
  expireLapsedForTicket(ticketId: string, now: Date): Promise<number>;

  /**
   * Expire all pending transfers whose expiresAt has passed.
   * Returns the number of rows updated.
   */
  expireStale(now: Date): Promise<number>;
}
