export type TemplateOwnerScope = "HUMAN" | "ORGANIZATION";

export type TemplateVisibility = "PUBLIC" | "PRIVATE" | "UNLISTED";

export type TemplateLocation =
  | { kind: "place"; placeId: string }
  | { kind: "saved-location"; savedLocationId: string }
  | { kind: "freeform"; addressText: string; lat: number; lng: number }
  | { kind: "none" };

export interface TemplatePayoutTermsLine {
  payeeId: string;
  percent: number;
  floorCents: number;
  capPercent?: number | null;
  priority?: number;
  rounding?: "FLOOR" | "NEAREST";
}

export interface TemplatePayoutTermsDraft {
  lines: TemplatePayoutTermsLine[];
  /** INERT: kept for stored JSON; never mapped onto PayoutTerms.feeMode. */
  feeMode?: "INCLUSIVE" | "ON_TOP";
}

/** @deprecated Use TemplatePayoutTermsLine */
export type TemplateAgreementLine = TemplatePayoutTermsLine;
/** @deprecated Use TemplatePayoutTermsDraft */
export type TemplateAgreementDraft = TemplatePayoutTermsDraft;

export type TemplateTicketTypeStatus = "ACTIVE" | "INACTIVE";

export interface TemplateTicketType {
  name: string;
  priceCents: number;
  capacity: number;
  seatSectionId?: string | null;
  status?: TemplateTicketTypeStatus;
}

export interface TemplateMedia {
  bannerUrl?: string | null;
  gallery?: string[];
}

export interface TemplateEmbedConfig {
  allowResale?: boolean;
  showFees?: boolean;
}

export interface TemplateDefaults {
  title?: string;
  doorTimeMinsBefore?: number;
  visibility?: TemplateVisibility;
  location?: TemplateLocation;
  categories?: string[];
  types?: string[];
  attributes?: string[];
  feePolicyId?: string;
  payoutTermsDraft?: TemplatePayoutTermsDraft;
  /** @deprecated Use payoutTermsDraft */
  agreementDraft?: TemplatePayoutTermsDraft;
  ticketTypes?: TemplateTicketType[];
  media?: TemplateMedia;
  embed?: TemplateEmbedConfig;
}

export type TemplateOverrides = Partial<TemplateDefaults>;

export interface EventTemplateRecord {
  id: string;
  ownerScope: TemplateOwnerScope;
  ownerId: string;
  name: string;
  description: string | null;
  active: boolean;
  defaults: TemplateDefaults | null;
  /** Null when the creating account has been deleted (creator detached). */
  createdByHumanId: string | null;
  updatedByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface CreateEventTemplateRepoInput {
  ownerScope: TemplateOwnerScope;
  ownerId: string;
  name: string;
  description: string | null;
  defaults: TemplateDefaults | null;
  active: boolean;
  createdByHumanId: string;
  createdAt: Date;
}

export interface UpdateEventTemplateRepoPatch {
  name?: string;
  description?: string | null;
  defaults?: TemplateDefaults | null;
  active?: boolean;
  updatedByHumanId: string;
  updatedAt: Date;
}

export interface ArchiveEventTemplateRepoInput {
  templateId: string;
  archivedAt: Date;
  archivedByHumanId: string;
}

export interface EventTemplateListFilters {
  ownerScope: TemplateOwnerScope;
  ownerId: string;
  activeOnly?: boolean;
  q?: string;
  limit: number;
  cursor?: string | null;
}

export interface EventTemplateListResult {
  items: EventTemplateRecord[];
  nextCursor?: string | null;
}
