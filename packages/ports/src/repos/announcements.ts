import type {
  AnnouncementRecord,
  CreateAnnouncementInput,
  GetLatestAnnouncementInput,
  ListAnnouncementsByOrgInput,
  ListAnnouncementsBySenderInput,
  ListPublicAnnouncementsByOrgInput,
  ListPublicAnnouncementsBySenderInput,
  ListAnnouncementsResult,
  AnnouncementAudienceType,
  CountAudienceRecipientsInput,
  AudienceFilter,
  AudienceFilterMultipleEvents,
  AudienceFilterEventTicketTier,
  AudienceRecipient,
  InsertAnonymousSuppressionInput,
  GetAnonymousSuppressedEmailsInput,
} from "@th/types/repos/announcements";

export interface AnnouncementsRepo {
  create(input: CreateAnnouncementInput): Promise<AnnouncementRecord>;
  findById(id: string): Promise<AnnouncementRecord | null>;
  listByOrg(
    input: ListAnnouncementsByOrgInput,
  ): Promise<ListAnnouncementsResult>;
  listBySender(
    input: ListAnnouncementsBySenderInput,
  ): Promise<ListAnnouncementsResult>;
  listPublicForOrgEntityPage(
    input: ListPublicAnnouncementsByOrgInput,
  ): Promise<ListAnnouncementsResult>;
  listPublicForSenderEntityPage(
    input: ListPublicAnnouncementsBySenderInput,
  ): Promise<ListAnnouncementsResult>;

  /**
   * Return the most recent announcement matching org + audience type + audienceRef.
   * Used for cooldown enforcement (prevent rapid-fire sends to the same audience).
   * Returns null when no prior announcement exists.
   */
  getLatestByAudience(
    input: GetLatestAnnouncementInput,
  ): Promise<AnnouncementRecord | null>;

  /**
   * Count the number of distinct recipients for a given audience configuration.
   * Used for the "preview audience count" feature before sending.
   */
  countAudienceRecipients(input: CountAudienceRecipientsInput): Promise<number>;

  /**
   * Resolve the full list of recipient emails for an audience configuration.
   * Used for actual bulk email dispatch. Excludes unsubscribed contacts.
   */
  listAudienceRecipientEmails(
    input: CountAudienceRecipientsInput,
  ): Promise<AudienceRecipient[]>;

  /**
   * Update the stored `recipientCount` for an announcement after preference
   * filtering, so the persisted count reflects the actually-dispatched set
   * rather than the pre-filter preview count.
   */
  updateRecipientCount(id: string, recipientCount: number): Promise<void>;

  /**
   * Record an anonymous (no linked Human) email suppression for an org.
   * Idempotent: repeat calls for the same `(email, orgId)` are no-ops.
   */
  insertAnonymousSuppression(
    input: InsertAnonymousSuppressionInput,
  ): Promise<void>;

  /**
   * Return the subset of `emails` that are suppressed for the given org.
   * All comparisons are case-insensitive; the returned set contains
   * lowercased emails.
   */
  getAnonymousSuppressedEmails(
    input: GetAnonymousSuppressedEmailsInput,
  ): Promise<Set<string>>;
}

export type {
  AnnouncementRecord,
  CreateAnnouncementInput,
  GetLatestAnnouncementInput,
  ListAnnouncementsByOrgInput,
  ListAnnouncementsBySenderInput,
  ListPublicAnnouncementsByOrgInput,
  ListPublicAnnouncementsBySenderInput,
  ListAnnouncementsResult,
  AnnouncementAudienceType,
  CountAudienceRecipientsInput,
  AudienceFilter,
  AudienceFilterMultipleEvents,
  AudienceFilterEventTicketTier,
  AudienceRecipient,
  InsertAnonymousSuppressionInput,
  GetAnonymousSuppressedEmailsInput,
} from "@th/types/repos/announcements";
