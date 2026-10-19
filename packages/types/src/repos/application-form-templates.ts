import type { TemplateOwnerScope } from "./event-templates";
import type { ApplicationFormPurpose } from "./events";

/**
 * Only the FOUR shipped question types (application-driven-events spec,
 * "Out of scope": new types beyond fixing the four are future work, and the
 * starter catalogue deliberately uses only these).
 */
export type ApplicationTemplateQuestionType =
  | "SHORT_TEXT"
  | "LONG_TEXT"
  | "SINGLE_CHOICE"
  | "MULTI_CHOICE";

/**
 * CANONICAL at-rest option shape — identical to
 * `EventApplicationQuestionOption`, because a template entry is copied into a
 * question row verbatim at apply time.
 */
export interface ApplicationTemplateQuestionOption {
  id: string;
  label: string;
}

/**
 * One stored question definition. This is the snapshot shape (spec D4):
 * position in the array IS the order, so no `order` field is stored — a
 * template that got its rows renumbered by hand would otherwise disagree with
 * itself.
 */
export interface ApplicationTemplateQuestion {
  type: ApplicationTemplateQuestionType;
  label: string;
  description?: string | null;
  /** Present (and non-empty) only for the two choice types. */
  options?: ApplicationTemplateQuestionOption[] | null;
  isRequired: boolean;
}

/**
 * Two kinds of row share this record (same split as
 * {@link TicketTypeTemplateRecord}):
 *
 *   - OWNED    — `ownerId` set, `isPlatform` false.
 *   - PLATFORM — `ownerId` NULL, `isPlatform` true. The seeded starter
 *                catalogue; `ownerScope` is ORGANIZATION by convention and
 *                ignored.
 *
 * Every consumer of `ownerId` must handle null deliberately — no non-null
 * assertions, no `?? ""`.
 */
export interface ApplicationFormTemplateRecord {
  id: string;
  ownerScope: TemplateOwnerScope;
  /** Null = platform catalogue row (see `isPlatform`). */
  ownerId: string | null;
  name: string;
  description: string | null;
  /**
   * Which builder the template belongs to (open calls v1): ATTEND for the
   * attendee gate, PERFORM for open calls. Never crosses over.
   */
  purpose: ApplicationFormPurpose;
  introText: string | null;
  questions: ApplicationTemplateQuestion[];
  /** True only on catalogue rows — read-only to organizers. */
  isPlatform: boolean;
  archivedAt: Date | null;
  /** Null when the creating account has been deleted (creator detached). */
  createdByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateApplicationFormTemplateRepoInput {
  ownerScope: TemplateOwnerScope;
  /** Required — this path can never mint a platform row. */
  ownerId: string;
  name: string;
  description: string | null;
  /** Required, no default: the caller states which builder it saves for. */
  purpose: ApplicationFormPurpose;
  introText: string | null;
  questions: ApplicationTemplateQuestion[];
  createdByHumanId: string;
  createdAt: Date;
}

/** Presence-guarded: an absent key leaves the stored value unchanged. */
export interface UpdateApplicationFormTemplateRepoInput {
  templateId: string;
  name?: string;
  description?: string | null;
  introText?: string | null;
  questions?: ApplicationTemplateQuestion[];
  updatedAt: Date;
}

export interface ArchiveApplicationFormTemplateRepoInput {
  templateId: string;
  archivedAt: Date;
}
