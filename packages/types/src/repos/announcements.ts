export type AnnouncementAudienceType =
  | "ALL_TICKET_HOLDERS"
  | "EVENT_TICKET_HOLDERS"
  | "MULTIPLE_EVENTS"
  | "EVENT_TICKET_TIER"
  | "CONTACT_LIST"
  | "WAITLIST_SUBSCRIBERS";

/**
 * Typed shapes for the `audienceFilter` JSON column.
 * The discriminant is `audienceType` on the parent record.
 */
export interface AudienceFilterMultipleEvents {
  eventIds: string[];
}

export interface AudienceFilterEventTicketTier {
  eventId: string;
  tierIds: string[];
}

export type AudienceFilter =
  | AudienceFilterMultipleEvents
  | AudienceFilterEventTicketTier;

export interface AnnouncementRecord {
  id: string;
  orgId: string;
  eventId: string | null;
  subject: string;
  bodyDoc: unknown;
  bodyHtml: string;
  publicOnEntityPage: boolean;
  audienceType: AnnouncementAudienceType;
  audienceRef: string | null;
  audienceFilter: AudienceFilter | null;
  excludedContactListId: string | null;
  recipientCount: number | null;
  sentAt: Date | null;
  sentBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAnnouncementInput {
  orgId: string;
  eventId?: string | null;
  subject: string;
  bodyDoc: unknown;
  bodyHtml: string;
  publicOnEntityPage?: boolean;
  audienceType: AnnouncementAudienceType;
  audienceRef?: string | null;
  audienceFilter?: AudienceFilter | null;
  excludedContactListId?: string | null;
  recipientCount?: number | null;
  sentAt?: Date | null;
  sentBy: string;
}

/**
 * Input for counting recipients before sending.
 * Mirrors the audience fields of CreateAnnouncementInput.
 */
export interface CountAudienceRecipientsInput {
  /**
   * Kind of owner `orgId` names. Every audience query is scoped to this owner
   * (events via Event.orgId / Event.humanId, lists via InviteList.ownerType +
   * ownerId), so a foreign audienceRef resolves to nobody.
   */
  ownerType: "HUMAN" | "ORGANIZATION";
  /** The owner id — an Organization id OR a Human id, per `ownerType`. */
  orgId: string;
  audienceType: AnnouncementAudienceType;
  audienceRef?: string | null;
  audienceFilter?: AudienceFilter | null;
  excludedContactListId?: string | null;
}

export interface ListAnnouncementsByOrgInput {
  orgId: string;
  limit?: number;
  offset?: number;
}

export interface ListAnnouncementsBySenderInput {
  humanId: string;
  limit?: number;
  offset?: number;
}

export interface ListPublicAnnouncementsByOrgInput {
  orgId: string;
  limit?: number;
  offset?: number;
}

export interface ListPublicAnnouncementsBySenderInput {
  humanId: string;
  limit?: number;
  offset?: number;
}

export interface ListAnnouncementsResult {
  items: AnnouncementRecord[];
  total: number;
}

/**
 * Input for looking up the most recent announcement sent to a specific audience.
 * Used for cooldown enforcement.
 */
export interface GetLatestAnnouncementInput {
  orgId: string;
  audienceType: AnnouncementAudienceType;
  audienceRef?: string | null;
}

/**
 * A recipient resolved from the audience. Used for bulk email dispatch.
 * - `contactListEntryId` / `inviteListId` are set only for CONTACT_LIST audiences.
 * - `waitlistEntryId` / `waitlistEventId` are set only for WAITLIST_SUBSCRIBERS audiences.
 */
export interface AudienceRecipient {
  email: string;
  name: string | null;
  contactListEntryId: string | null;
  inviteListId: string | null;
  waitlistEntryId: string | null;
  waitlistEventId: string | null;
  /** Human ID of the recipient, when known (e.g. authenticated waitlist subscribers). */
  humanId: string | null;
}

/** Input for recording an anonymous (no linked Human) email suppression. */
export interface InsertAnonymousSuppressionInput {
  email: string;
  orgId: string;
  /** "unsubscribe" | "bounce" | "complaint" */
  reason?: string;
}

/** Input for looking up suppressed anonymous emails for an org. */
export interface GetAnonymousSuppressedEmailsInput {
  orgId: string;
  emails: string[];
}
