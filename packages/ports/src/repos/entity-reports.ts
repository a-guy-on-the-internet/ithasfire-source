import type {
  ArrivalAreaCost,
  ArrivalAreaGeometry,
  ArrivalAreaKind,
} from "@th/types/repos/arrival-areas";

/**
 * What kind of listing an EntityReport points at. Mirrors the Prisma
 * `EntityReportSubjectType` enum; kept as a string union at the port boundary
 * so core never imports `@prisma/client`. ARRIVAL_AREA (arrival-areas
 * FR-011): `subjectId` is an ArrivalArea id, and the report carries a
 * {@link ArrivalAreaReportSnapshot}.
 */
export type EntityReportSubjectType =
  | "PLACE"
  | "HUMAN"
  | "ORGANIZATION"
  | "ARRIVAL_AREA";

/**
 * What the reporter saw of an arrival area when they reported it
 * (arrival-areas FR-011), so a moderator can judge the report after the area
 * is edited or deleted. Exactly one of `placeId` / `eventId` is set (the
 * area's parent). `seenOnEventId`: the event page the reporter was on, when
 * that is where they saw a place's area. Platform staff only: it carries the
 * geometry, which for a withheld address is protected location data.
 */
export interface ArrivalAreaReportSnapshot {
  type: "ARRIVAL_AREA";
  kind: ArrivalAreaKind;
  label: string;
  cost: ArrivalAreaCost;
  priceText: string | null;
  note: string | null;
  /** The shape as shown; null when the stored shape was malformed (listed, not drawn). */
  geometry: ArrivalAreaGeometry | null;
  placeId: string | null;
  eventId: string | null;
  seenOnEventId: string | null;
}

/** The snapshot a report keeps of its subject; null for the listing subjects. */
export type EntityReportSubjectSnapshot = ArrivalAreaReportSnapshot;

/**
 * Why the reporter flagged the subject. Mirrors the Prisma
 * `EntityReportReason` enum (string union at the port boundary). The
 * per-subject-type allowed subsets (entity-report-intake FR-002: PLACE gets
 * CLOSED_OR_GONE/DUPLICATE, HUMAN/ORG get IMPERSONATION) are enforced in core
 * (`submit-entity-report`), not here — the repo accepts the full enum.
 */
export type EntityReportReason =
  | "CLOSED_OR_GONE"
  | "INCORRECT_INFO"
  | "DUPLICATE"
  | "INAPPROPRIATE"
  | "SPAM"
  | "IMPERSONATION"
  | "OTHER";

/**
 * Report lifecycle. Mirrors the Prisma `EntityReportStatus` enum (string
 * union at the port boundary). PENDING → RESOLVED | DISMISSED, one-way via
 * {@link EntityReportsRepo.claimPendingForReview}.
 */
export type EntityReportStatus = "PENDING" | "RESOLVED" | "DISMISSED";

/**
 * The two terminal verdicts a reviewer may set (never back to PENDING).
 */
export type EntityReportVerdict = Exclude<EntityReportStatus, "PENDING">;

/**
 * A report filed against a PLACE / HUMAN / ORGANIZATION listing
 * (entity-report-intake spec). `subjectId` and the human ids are plain
 * strings, no FK — house style (mirrors EventEditSuggestion), so a report may
 * outlive its subject; queue surfaces render "subject no longer exists" and
 * the row stays reviewable.
 */
export interface EntityReportRecord {
  id: string;
  subjectType: EntityReportSubjectType;
  subjectId: string;
  reporterHumanId: string;
  reason: EntityReportReason;
  /** Optional free text; core requires it when reason = OTHER (FR-002). */
  details: string | null;
  /** Set for ARRIVAL_AREA reports (FR-011); null otherwise. */
  subjectSnapshot: EntityReportSubjectSnapshot | null;
  status: EntityReportStatus;
  reviewedByHumanId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEntityReportInput {
  subjectType: EntityReportSubjectType;
  subjectId: string;
  reporterHumanId: string;
  reason: EntityReportReason;
  details?: string | null;
  /** Core builds it; the adapter stores it as given (JSONB). */
  subjectSnapshot?: EntityReportSubjectSnapshot | null;
}

export interface FindPendingEntityReportByReporterAndSubjectInput {
  reporterHumanId: string;
  subjectType: EntityReportSubjectType;
  subjectId: string;
}

export interface ListEntityReportsPagedInput {
  /**
   * DEFAULTS to "PENDING" in the adapter when omitted: this list is
   * queue-shaped by name, so omitting the filter must never silently fold
   * RESOLVED/DISMISSED rows into the moderator queue (same
   * default-never-widens posture as `countOpenByPlace`'s statuses default).
   * Pass an explicit status to browse reviewed history.
   */
  status?: EntityReportStatus;
  /** Optional narrowing to one subject kind; omitted = all of them. */
  subjectType?: EntityReportSubjectType;
  /** Keyset cursor = report id of the last item of the previous page. */
  cursor?: string | null;
  limit?: number;
}

export interface ListEntityReportsPagedResult {
  items: EntityReportRecord[];
  nextCursor: string | null;
}

export interface CountPendingEntityReportsInput {
  /** Optional narrowing to one subject kind; omitted = all of them. */
  subjectType?: EntityReportSubjectType;
}

export interface ClaimPendingEntityReportForReviewInput {
  id: string;
  /** RESOLVED or DISMISSED — never back to PENDING. */
  status: EntityReportVerdict;
  reviewedByHumanId: string;
  reviewedAt: Date;
  reviewNote?: string | null;
}

/**
 * Repository for EntityReport rows — the moderation queue behind the
 * "Report" action on venue/entity pages (entity-report-intake spec).
 * PENDING rows are the moderator to-do; review is a single CAS transition to
 * RESOLVED | DISMISSED via {@link claimPendingForReview}. WHO may list/review
 * (COMMUNITY_MODERATION_ROLES) is the use case's job; the repo only enforces
 * row-level state transitions.
 */
export interface EntityReportsRepo {
  /**
   * Insert one PENDING report. The FR-003 one-PENDING-report-per-(reporter,
   * subject) rule is backstopped by the SQL-only partial unique index
   * "EntityReport_open_reporter_subject_key" ON (reporterHumanId, subjectType,
   * subjectId) WHERE status = 'PENDING': a P2002 from it can only be that
   * index (`id` is a fresh uuid; nothing else on the row is unique), and the
   * adapter maps it to a thrown `{ code: "report_already_open", message:
   * "report_already_open", cause }` — the race loser sees the SAME domain
   * error as the {@link findPendingByReporterAndSubject} pre-check path, and
   * a raw P2002 never leaks through the port. (Same contract as
   * `BookingRequestsRepo.createToPerformer`'s `duplicate_open_request`
   * mapping; core registers the code in `KnownErrorCode` + trpc's
   * `errorCodeMap`.)
   */
  create(input: CreateEntityReportInput): Promise<EntityReportRecord>;
  getById(id: string): Promise<EntityReportRecord | null>;
  /**
   * The reporter's open PENDING report on a subject, if any — the dedupe
   * pre-check for `submit-entity-report` (idempotent-friendly
   * REPORT_ALREADY_OPEN without burning an insert). Best-effort only: the
   * partial unique index behind {@link create} stays the authoritative race
   * guard (same posture as `findOpenByOrganizerAndPerformer`).
   */
  findPendingByReporterAndSubject(
    input: FindPendingEntityReportByReporterAndSubjectInput,
  ): Promise<EntityReportRecord | null>;
  /**
   * Moderator queue page. Newest first (createdAt desc, id desc) matching the
   * `eventEditSuggestions.listPending` / categoryRequests admin-queue
   * convention; keyset cursor = report id, backed by the
   * [status, createdAt] index. `status` defaults to PENDING (see
   * {@link ListEntityReportsPagedInput.status}); adapter caps `limit`.
   */
  listPaged(
    input: ListEntityReportsPagedInput,
  ): Promise<ListEntityReportsPagedResult>;
  /**
   * Counting twin of {@link listPaged}'s DEFAULT row set (status = PENDING,
   * optional subjectType narrowing — same WHERE, so the count can never
   * disagree with the queue it summarizes). Serves `list-entity-reports`'
   * `pendingCount` output and the ModerateShell nav badge without paging rows
   * just to read `.length`.
   */
  countPending(input?: CountPendingEntityReportsInput): Promise<number>;
  /**
   * Atomically review a PENDING report: single CAS (status guard in the WHERE
   * clause) from PENDING to RESOLVED | DISMISSED, stamping
   * reviewedByHumanId / reviewedAt / reviewNote. Returns the updated record;
   * returns null when the row was not PENDING — the loser of a concurrent
   * double-review sees null and bails (REPORT_ALREADY_REVIEWED is core's
   * word for it). Mirrors `eventEditSuggestions.claimPendingForReview`'s
   * loser expression, collapsed to one step because a report verdict has no
   * apply phase. WHICH actor may review is the use case's job (authz before
   * claim); the repo only enforces the status transition.
   */
  claimPendingForReview(
    input: ClaimPendingEntityReportForReviewInput,
  ): Promise<EntityReportRecord | null>;
}
