import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type {
  EntityReportReason,
  EntityReportStatus,
  EntityReportSubjectType,
} from "@th/ports/repos/entity-reports";
import { fail } from "@th/errors";

import {
  arrivalAreaCostSchema,
  arrivalAreaGeometrySchema,
  arrivalAreaKindSchema,
} from "../../../lib/arrival-areas/geometry";
import { fail as failLegacy } from "../../../lib/errors";

/**
 * Shared validation helpers + constants for the entity-report intake flow
 * (docs/specs/2026-08-17/completed/entity-report-intake.spec.yaml FR-002/FR-003).
 * Exported so the transport router and the report dialog UI can reuse the
 * per-subject reason subsets instead of hand-copying them (drift guard: the
 * data lives here, next to the rule that enforces it).
 */

export const ENTITY_REPORT_SUBJECT_TYPES = [
  "PLACE",
  "HUMAN",
  "ORGANIZATION",
  "ARRIVAL_AREA",
] as const satisfies readonly EntityReportSubjectType[];

export const ENTITY_REPORT_REASONS = [
  "CLOSED_OR_GONE",
  "INCORRECT_INFO",
  "DUPLICATE",
  "INAPPROPRIATE",
  "SPAM",
  "IMPERSONATION",
  "OTHER",
] as const satisfies readonly EntityReportReason[];

export const ENTITY_REPORT_STATUSES = [
  "PENDING",
  "RESOLVED",
  "DISMISSED",
] as const satisfies readonly EntityReportStatus[];

// Union → array exhaustiveness guards (the `satisfies` above prove array →
// union): a port union member missing from its runtime array is a COMPILE
// error, so `z.enum(...)` schemas built from these arrays can never silently
// lag the port contract.
const _subjectTypesExhaustive: EntityReportSubjectType extends
  (typeof ENTITY_REPORT_SUBJECT_TYPES)[number]
  ? true
  : never = true;
void _subjectTypesExhaustive;
const _reasonsExhaustive: EntityReportReason extends
  (typeof ENTITY_REPORT_REASONS)[number]
  ? true
  : never = true;
void _reasonsExhaustive;
const _statusesExhaustive: EntityReportStatus extends
  (typeof ENTITY_REPORT_STATUSES)[number]
  ? true
  : never = true;
void _statusesExhaustive;

/**
 * Staff roles allowed to operate the /platform/reports queue (spec v1.1:
 * entity reports are PLATFORM-level trust & safety — potential impersonation/
 * abuse on platform entities — NOT community-listing stewardship, so
 * COMMUNITY_MODERATOR deliberately has NO access). Matches the transport's
 * `requirePlatformStaff` ADMIN/SUPPORT/DEVELOPER class (precedent:
 * `credits.grant` — guard.ts "ADMIN/SUPPORT/DEVELOPER via
 * requirePlatformStaff"); no shared core-side constant for this triple
 * exists (each platform use case declares its own), hence declared once
 * here for the entity-reports family.
 */
export const PLATFORM_STAFF_ROLES = ["ADMIN", "SUPPORT", "DEVELOPER"] as const;

/** FR-002: optional free-text details field, max 2000 chars (after sanitize). */
export const ENTITY_REPORT_DETAILS_MAX = 2000;

/**
 * FR-005: optional reviewer note cap. Deliberately the same bound as
 * {@link ENTITY_REPORT_DETAILS_MAX} (both are short moderation free-text),
 * but named separately so either can move without silently dragging the
 * other.
 */
export const ENTITY_REPORT_REVIEW_NOTE_MAX = 2000;

/**
 * FR-002 per-subject reason subsets. PLACE listings can be reported as
 * closed/duplicate (physical-venue failure modes); HUMAN and ORGANIZATION
 * listings can be reported for impersonation instead. INCORRECT_INFO /
 * INAPPROPRIATE / SPAM / OTHER apply everywhere.
 *
 * ARRIVAL_AREA (arrival-areas FR-011): a drawn parking / drop-off / load-in
 * shape. CLOSED_OR_GONE is the common real failure (the lot closed, the
 * street went residents-only); INCORRECT_INFO covers a wrong shape, cost or
 * kind; INAPPROPRIATE and SPAM cover abuse of the free-text label and note.
 * No DUPLICATE (two shapes of one lot is the manager's tidy-up, not
 * moderation) and no IMPERSONATION (an area is not anyone).
 */
export const ENTITY_REPORT_REASONS_BY_SUBJECT: Record<
  EntityReportSubjectType,
  readonly EntityReportReason[]
> = {
  PLACE: [
    "CLOSED_OR_GONE",
    "INCORRECT_INFO",
    "DUPLICATE",
    "INAPPROPRIATE",
    "SPAM",
    "OTHER",
  ],
  HUMAN: ["IMPERSONATION", "INCORRECT_INFO", "INAPPROPRIATE", "SPAM", "OTHER"],
  ORGANIZATION: [
    "IMPERSONATION",
    "INCORRECT_INFO",
    "INAPPROPRIATE",
    "SPAM",
    "OTHER",
  ],
  ARRIVAL_AREA: [
    "CLOSED_OR_GONE",
    "INCORRECT_INFO",
    "INAPPROPRIATE",
    "SPAM",
    "OTHER",
  ],
};

/**
 * Every way an entity-report submission can be rejected at the field level.
 * Mirrors the suggestions family's single-constructor anti-rot discipline
 * (`suggestionRejection`): one error family (`INVALID_INPUT`) carrying a
 * discriminating `meta.reason`, every throw site goes through
 * {@link entityReportRejection}, so a new rejection can't invent an untracked
 * reason string. (The suggestions family registered a bespoke AppErrorCode;
 * here the registered generic `INVALID_INPUT` carries the family — promoting
 * to a bespoke code would require a `packages/errors` + i18n-catalog change,
 * which is a transport/UI-step decision, not core's.)
 *
 *  - `invalid_reason_for_subject` — reason not in the subject type's subset
 *  - `details_required`           — reason = OTHER with empty/missing details
 *  - `seen_on_event_not_allowed`  — `seenOnEventId` on a subject other than
 *                                   ARRIVAL_AREA (it names where an area was
 *                                   seen; nothing else has one)
 *
 * (details-too-long collapses into the schema's `invalid_input` via
 * `plainTextMultilineOptional(ENTITY_REPORT_DETAILS_MAX)` — sanitize-then-max,
 * same treatment as the suggestions family's `note`.)
 */
export const ENTITY_REPORT_REJECTION_REASONS = [
  "invalid_reason_for_subject",
  "details_required",
  "seen_on_event_not_allowed",
] as const;

export type EntityReportRejectionReason =
  (typeof ENTITY_REPORT_REJECTION_REASONS)[number];

/**
 * The ONLY constructor for a field-level entity-report rejection. `meta`
 * shape is uniform: `{ reason, fields?: string[], ...extra }` so clients can
 * anchor the message inline at the offending input.
 */
export function entityReportRejection(
  reason: EntityReportRejectionReason,
  fields?: readonly string[],
  extra?: Record<string, unknown>,
): never {
  const meta: Record<string, unknown> = { reason, ...extra };
  if (fields && fields.length > 0) {
    meta.fields = [...fields];
  }
  return fail("INVALID_INPUT", { message: reason, meta });
}

/** FR-002: the reason must belong to the subject type's allowed subset. */
export function ensureReasonAllowedForSubject(
  subjectType: EntityReportSubjectType,
  reason: EntityReportReason,
): void {
  if (!ENTITY_REPORT_REASONS_BY_SUBJECT[subjectType].includes(reason)) {
    entityReportRejection("invalid_reason_for_subject", ["reason"], {
      subjectType,
      reportReason: reason,
      allowedReasons: [...ENTITY_REPORT_REASONS_BY_SUBJECT[subjectType]],
    });
  }
}

/**
 * FR-002: details is REQUIRED (non-empty after sanitize/trim) when
 * reason = OTHER — a bare "other" report gives a reviewer nothing to act on.
 */
export function ensureDetailsPresentForOther(
  reason: EntityReportReason,
  details: string | null,
): void {
  if (reason === "OTHER" && !details) {
    entityReportRejection("details_required", ["details"]);
  }
}

/**
 * Every repo-free field check of a submission, in the order the use case runs
 * them: the reason subset for the subject, details required for OTHER, and
 * `seenOnEventId` only on ARRIVAL_AREA. Exported so the transport can run the
 * same checks BEFORE its ARRIVAL_AREA gate read (a malformed report never
 * costs that read, and its answer cannot depend on whether the event is
 * readable). `details` is the sanitized value; empty counts as absent.
 */
export function ensureSubmissionFieldsValid(input: {
  subjectType: EntityReportSubjectType;
  reason: EntityReportReason;
  details?: string | null;
  seenOnEventId?: string | null;
}): void {
  ensureReasonAllowedForSubject(input.subjectType, input.reason);
  ensureDetailsPresentForOther(input.reason, input.details || null);
  if (
    input.seenOnEventId !== undefined &&
    input.seenOnEventId !== null &&
    input.subjectType !== "ARRIVAL_AREA"
  ) {
    entityReportRejection("seen_on_event_not_allowed", ["seenOnEventId"]);
  }
}

/**
 * FR-003 subject existence + public-visibility check. Missing and not-public
 * subjects collapse to the subject's NOT_FOUND code (no oracle: an authed
 * reporter cannot probe suspended/archived listings through this endpoint).
 *
 * SEMANTICS (documented decision): a subject is reportable iff it exists AND
 * `status === "ACTIVE"` —
 *  - PLACE:        `PlaceRecord.status`  ∈ {ACTIVE, SUSPENDED, ARCHIVED}
 *  - HUMAN:        `HumanRecord.status`  ∈ {INVITED, ACTIVE, SUSPENDED, BANNED}
 *  - ORGANIZATION: `OrganizationRecord.status` ∈ {ACTIVE, SUSPENDED, ARCHIVED}
 * ACTIVE is the common denominator of "the public entity page is reachable".
 * We deliberately do NOT additionally require an entity page with PUBLIC
 * visibility / directory listing (the stricter `upsert-featured-item` gate):
 * the Report action lives on the subject's live page, and a stricter gate
 * would block legitimate reports on visible listings that lack a curated page
 * row. None of these models has a soft-delete column; `status` IS the
 * lifecycle state, so status-based existence is the "existence + not-deleted"
 * check the spec accepts for HUMAN/ORG.
 */
export async function ensureReportableSubject(
  repos: Pick<Repos, "places" | "humans" | "organizations">,
  subjectType: EntityReportSubjectType,
  subjectId: string,
): Promise<void> {
  switch (subjectType) {
    case "PLACE": {
      const place = await repos.places.getById(subjectId);
      if (!place || place.status !== "ACTIVE") {
        throw fail("PLACE_NOT_FOUND");
      }
      return;
    }
    case "HUMAN": {
      const human = await repos.humans.getById(subjectId);
      if (!human || human.status !== "ACTIVE") {
        throw fail("HUMAN_NOT_FOUND");
      }
      return;
    }
    case "ORGANIZATION": {
      const organization = await repos.organizations.getById(subjectId);
      if (!organization || organization.status !== "ACTIVE") {
        throw fail("ORG_NOT_FOUND");
      }
      return;
    }
    case "ARRIVAL_AREA":
      // Visibility is per viewer (submit-entity-report's
      // `resolveReportableArrivalArea`); this viewer-less check can never
      // vouch for one, so it fails closed.
      throw fail("ARRIVAL_AREA_NOT_FOUND");
  }
}

/**
 * FR-003 dedupe: the reporter already has a PENDING report on this subject.
 * Thrown as the legacy `{ code: "report_already_open" }` shape — the SAME
 * domain error the Prisma adapter maps the partial-unique-index P2002 race to
 * (see `EntityReportsRepo.create`'s port contract), so the pre-check path and
 * the race-loser path are indistinguishable to the client. Registered in
 * core's `KnownErrorCode`; the tRPC `errorCodeMap` row
 * (`report_already_open → CONFLICT`) is the transport step's obligation.
 */
export function throwReportAlreadyOpen(): never {
  return failLegacy("report_already_open", "report_already_open");
}

/**
 * Zod shape of an {@link import("@th/ports/repos/entity-reports").EntityReportRecord}
 * for use-case output validation (mirrors `eventEditSuggestionRecordSchema`'s
 * role for the suggestions family; lives in core because `@th/schema` has no
 * entity-report module).
 */
/**
 * The ARRIVAL_AREA snapshot (FR-011) as stored on the report. Platform staff
 * only (the list and review use cases gate on `requirePlatformStaff`).
 * `geometry` is the shape the reporter was shown, null when the stored shape
 * was malformed (listed, not drawn).
 */
export const arrivalAreaReportSnapshotSchema = z
  .object({
    type: z.literal("ARRIVAL_AREA"),
    kind: arrivalAreaKindSchema,
    label: z.string(),
    cost: arrivalAreaCostSchema,
    priceText: z.string().nullable(),
    note: z.string().nullable(),
    geometry: arrivalAreaGeometrySchema.nullable(),
    placeId: z.string().nullable(),
    eventId: z.string().nullable(),
    seenOnEventId: z.string().nullable(),
  })
  .strict();

export const entityReportRecordSchema = z
  .object({
    id: z.string(),
    subjectType: z.enum(ENTITY_REPORT_SUBJECT_TYPES),
    subjectId: z.string(),
    reporterHumanId: z.string(),
    reason: z.enum(ENTITY_REPORT_REASONS),
    details: z.string().nullable(),
    subjectSnapshot: arrivalAreaReportSnapshotSchema.nullable(),
    status: z.enum(ENTITY_REPORT_STATUSES),
    reviewedByHumanId: z.string().nullable(),
    reviewedAt: z.date().nullable(),
    reviewNote: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
