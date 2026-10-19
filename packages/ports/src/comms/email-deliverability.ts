export type EmailDeliveryStatus = "DELIVERABLE" | "BOUNCED" | "COMPLAINED";

export type EmailDeliverabilityRecord = {
  authUserId: string;
  email: string;
  status: EmailDeliveryStatus | null;
  statusAt: Date | null;
  statusRef: string | null;
};

export type RecordEmailDeliveryProviderEventInput = {
  provider: string;
  providerEventId: string;
  eventType: string;
  email: string;
  status: EmailDeliveryStatus;
  occurredAt: Date;
  payload: unknown;
};

export type EmailDeliveryEventRecord = {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  email: string;
  status: EmailDeliveryStatus;
  occurredAt: Date;
  processedAt: Date;
  authUserId: string | null;
  replayed: boolean;
};

export interface EmailDeliverabilityPort {
  getByEmail(email: string): Promise<EmailDeliverabilityRecord | null>;
  recordProviderEvent(
    input: RecordEmailDeliveryProviderEventInput,
  ): Promise<EmailDeliveryEventRecord>;
  clearByEmail(email: string): Promise<boolean>;
  /**
   * GDPR erasure: severs the link between a deleted AuthUser and their
   * delivery-event audit rows. Overwrites `recipientEmail` and any matching
   * occurrence inside `payload` with a per-row sentinel
   * (`deleted-<eventId>@deleted.local`) and nulls `authUserId`, preserving the
   * row for bounce-storm forensics without retaining PII. Returns the number
   * of rows anonymized. Safe to call repeatedly (already-anonymized rows match
   * nothing on re-run).
   */
  anonymizeForUser(authUserId: string): Promise<number>;
}
