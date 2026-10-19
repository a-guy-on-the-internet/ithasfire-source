export type NotificationKind = "INFO" | "SUCCESS" | "WARNING" | "ERROR";

export interface NotificationAction {
  label: string;
  href?: string | null;
  route?: string | null;
}

export interface NotificationRecord {
  id: string;
  humanId: string;
  title: string | null;
  body: string;
  kind: NotificationKind;
  metadata: Record<string, string> | null;
  tags: string[];
  expiresAt: Date | null;
  readAt: Date | null;
  action: NotificationAction | null;
  templateKey: string | null;
  templateVersion: string | null;
  templateVariables: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateNotificationInput {
  humanId: string;
  title?: string | null;
  body: string;
  kind: NotificationKind;
  metadata?: Record<string, string> | null;
  tags?: string[];
  expiresAt?: Date | null;
  action?: NotificationAction | null;
  template?: {
    key: string;
    version?: string | null;
    variables?: Record<string, unknown> | null;
  } | null;
}

export interface CreateNotificationResult {
  id: string;
  createdAt: Date;
}

export interface ListNotificationsInput {
  humanId: string;
  /** Return only unread (`false`), only read (`true`), or all (`undefined`). */
  read?: boolean;
  limit?: number;
  /** Cursor-based pagination: pass the `createdAt` of the last item. */
  cursor?: Date;
}

export interface ListNotificationsResult {
  items: NotificationRecord[];
  /** `null` when there are no more pages. */
  nextCursor: Date | null;
}

export interface MarkReadResult {
  /** Number of notifications actually updated. */
  count: number;
}

/**
 * Ledger-style lookup backing durable fan-out dedup: every persisted
 * notification carries its variant in `tags` and (for event-scoped variants)
 * the renderer's `eventId` in `metadata`, so "(variant, eventId, humanId)
 * already notified?" is answerable without a dedicated ledger table.
 */
export interface FindNotifiedHumanIdsForEventInput {
  eventId: string;
  variant: string;
  /** Candidate humanIds to check (the fan-out audience). */
  humanIds: string[];
}
