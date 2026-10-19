import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { ArrivalAreaReportSnapshot } from "@th/ports/repos/entity-reports";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import {
  ENTITY_REPORT_DETAILS_MAX,
  ENTITY_REPORT_REASONS,
  ENTITY_REPORT_SUBJECT_TYPES,
  ensureReportableSubject,
  ensureSubmissionFieldsValid,
  throwReportAlreadyOpen,
} from "./_shared/entity-report-validation";
import { notifyEntityReportSubmitted } from "./_shared/entity-report-notifications";
import { listArrivalAreasForViewer } from "../arrival-areas/list-arrival-areas-for-viewer";

/**
 * FR-003/FR-004 (entity-report-intake spec): an authed visitor reports a
 * PLACE / HUMAN / ORGANIZATION listing. Validates the reason against the
 * subject type's subset (FR-002), requires details for reason = OTHER,
 * verifies the subject exists and is publicly visible (status ACTIVE — see
 * `ensureReportableSubject`'s documented semantics), dedupes on
 * (reporter, subject, PENDING), creates the PENDING report + audit row in one
 * tx, then best-effort notifies platform staff (ADMIN + SUPPORT) post-commit.
 *
 * Idempotent-friendly: a second submit while one report is PENDING throws
 * `report_already_open` and creates no row. The pre-check
 * (`findPendingByReporterAndSubject`) is best-effort; the adapter's partial
 * unique index is the authoritative race guard and its P2002 is mapped to the
 * SAME `report_already_open` error, which this use case deliberately lets
 * propagate unchanged.
 *
 * Rate limiting (NFR-001) is a transport concern (authedProcedure +
 * `report:h:${actorHumanId}` keyed guard), not enforced here.
 */

export const submitEntityReportInputSchema = z
  .object({
    subjectType: z.enum(ENTITY_REPORT_SUBJECT_TYPES),
    subjectId: z.uuid(),
    reason: z.enum(ENTITY_REPORT_REASONS),
    /** Sanitized (tags/controls stripped, trimmed) BEFORE the max check. */
    details: plainTextMultilineOptional(ENTITY_REPORT_DETAILS_MAX).optional(),
    /**
     * ARRIVAL_AREA only (arrival-areas FR-011): the event page the reporter
     * saw the area on. A place's area seen on one of its events is checked
     * against THAT page's visibility (a withheld place shows its areas to a
     * ticket holder on the event page, never on the place page).
     */
    seenOnEventId: z.uuid().optional(),
    /**
     * Server-injected (ARRIVAL_AREA only): TRUE only when the transport has
     * passed this reporter through `seenOnEventId`'s password / application
     * gate (`hasFullEventReadAccessByEventId`). Read only together with
     * `seenOnEventId`; absent = not granted. The transport `.omit()`s it from
     * the client-facing input, as it does `actorHumanId`.
     */
    gateAccessGranted: z.boolean().optional(),
    /** The signed-in reporter (transport supplies from ctx — never trusted). */
    actorHumanId: z.uuid(),
  })
  .strict();

export const submitEntityReportOutputSchema = z
  .object({
    reportId: z.string(),
  })
  .strict();

export type SubmitEntityReportInput = z.infer<
  typeof submitEntityReportInputSchema
>;
export type SubmitEntityReportOutput = z.infer<
  typeof submitEntityReportOutputSchema
>;

export type SubmitEntityReportDeps = {
  repos: Repos;
  /**
   * ARRIVAL_AREA only: the viewer checks of `listArrivalAreasForViewer`.
   * Absent → every ARRIVAL_AREA report is ARRIVAL_AREA_NOT_FOUND (fails
   * closed); the listing subjects never read it.
   */
  authz?: Pick<AuthZPort, "canEditEvent" | "canManagePlace" | "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Sentry hook for the post-commit notification swallow branches (CLAUDE.md
   * Sentry convention: warn is not captured). Guarded downstream — a throwing
   * reporter never fails the committed submit.
   */
  reportError?: ReporterPort;
};

/**
 * The use case's repo-free field checks on `rawInput` parsed exactly as the
 * use case will parse it (`submitEntityReportInputSchema`, so free text is
 * sanitized the same number of times). The transport runs this before its
 * ARRIVAL_AREA gate read, so a malformed report never costs that read and
 * its answer cannot depend on whether the event is readable: a check run on
 * the transport's once-sanitized copy could pass `details` that the use
 * case's second sanitize empties.
 */
export function precheckSubmitEntityReport(rawInput: unknown): void {
  const input = parseInput(submitEntityReportInputSchema, rawInput);
  ensureSubmissionFieldsValid({
    subjectType: input.subjectType,
    reason: input.reason,
    details: normalizeOptionalDetails(input.details),
    seenOnEventId: input.seenOnEventId,
  });
}

export async function submitEntityReport(
  deps: SubmitEntityReportDeps,
  rawInput: unknown,
): Promise<SubmitEntityReportOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "submitEntityReport" });

  const execute = async (): Promise<SubmitEntityReportOutput> => {
    const input = parseInput(submitEntityReportInputSchema, rawInput);
    const details = normalizeOptionalDetails(input.details);
    const now = deps.clock.now();

    // FR-002: reason subset + OTHER-requires-details — cheap, repo-free
    // checks first. The transport runs the same function before its
    // ARRIVAL_AREA gate read.
    ensureSubmissionFieldsValid({
      subjectType: input.subjectType,
      reason: input.reason,
      details,
      seenOnEventId: input.seenOnEventId,
    });

    // FR-003: subject must exist and be publicly visible (collapses to the
    // subject's NOT_FOUND — no probing suspended/archived listings). An
    // arrival area must be one THIS reporter can see, and the report keeps
    // what they saw (arrival-areas FR-011).
    let subjectSnapshot: ArrivalAreaReportSnapshot | null = null;
    if (input.subjectType === "ARRIVAL_AREA") {
      subjectSnapshot = await resolveReportableArrivalArea(deps, {
        arrivalAreaId: input.subjectId,
        viewerHumanId: input.actorHumanId,
        seenOnEventId: input.seenOnEventId ?? null,
        gateAccessGranted:
          input.seenOnEventId !== undefined && input.gateAccessGranted === true,
      });
    } else {
      await ensureReportableSubject(
        deps.repos,
        input.subjectType,
        input.subjectId,
      );
    }

    // FR-003 dedupe pre-check (idempotent-friendly, no burned insert). The
    // adapter's partial unique index stays the authoritative race guard; its
    // race loser throws the SAME `report_already_open` from `create` below.
    const existing = await deps.repos.entityReports.findPendingByReporterAndSubject(
      {
        reporterHumanId: input.actorHumanId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      },
    );
    if (existing) {
      throwReportAlreadyOpen();
    }

    const report = await deps.repos.tx(async (tx) => {
      const created = await tx.entityReports.create({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        reporterHumanId: input.actorHumanId,
        reason: input.reason,
        details,
        ...(subjectSnapshot ? { subjectSnapshot } : {}),
      });

      await tx.audit.log({
        entity: "entity_report",
        entityId: created.id,
        action: "entity_report.submitted",
        data: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          reporterHumanId: input.actorHumanId,
          reason: input.reason,
          details,
          // Ids only: the snapshot (geometry) lives on the report row.
          ...(subjectSnapshot
            ? { seenOnEventId: subjectSnapshot.seenOnEventId }
            : {}),
        },
        at: now,
      });

      return created;
    });

    // FR-004: platform-staff feedback loop. Best-effort and AFTER commit — we
    // never notify about a report that rolled back, and a notification
    // failure never fails the submit. Every swallow inside keeps its
    // logger.warn AND reports via the guarded `reportError` (NFR-003 /
    // CLAUDE.md Sentry convention). No other catch-and-fallback branch
    // exists in this use case.
    await notifyEntityReportSubmitted(
      {
        repos: deps.repos,
        logger: scopedLogger ?? deps.logger,
        reportError: deps.reportError,
      },
      { report },
    );

    return submitEntityReportOutputSchema.parse({ reportId: report.id });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("submitEntityReport", execute);
  }

  return execute();
}

/**
 * arrival-areas FR-011: the area, as THIS reporter is shown it, or
 * ARRIVAL_AREA_NOT_FOUND. The one visibility rule is
 * `listArrivalAreasForViewer` (FR-008 / FR-009), never a parallel check: the
 * area must be in that viewer's list for the page it was seen on
 * (`seenOnEventId`, else its own parent's page). A missing id, an area this
 * viewer cannot see, a switched-off area and a projection failure all throw
 * the SAME bare error, so a report is no oracle for a withheld place's areas.
 * Gated events: the gate pass counts only for `seenOnEventId`, the page the
 * transport checked. An event-only area reported without it is checked on its
 * own event with no gate pass, so on a gated event only acts and staff can
 * report it that way (fails closed).
 */
async function resolveReportableArrivalArea(
  deps: SubmitEntityReportDeps,
  input: {
    arrivalAreaId: string;
    viewerHumanId: string;
    seenOnEventId: string | null;
    gateAccessGranted: boolean;
  },
): Promise<ArrivalAreaReportSnapshot> {
  const notFound = () => fail("ARRIVAL_AREA_NOT_FOUND");
  if (!deps.authz) throw notFound();
  const row = await deps.repos.arrivalAreas.getById(input.arrivalAreaId);
  if (!row) throw notFound();

  const page: { placeId: string } | { eventId: string } | null =
    input.seenOnEventId
      ? { eventId: input.seenOnEventId }
      : row.placeId
        ? { placeId: row.placeId }
        : row.eventId
          ? { eventId: row.eventId }
          : null;
  if (!page) throw notFound();

  const visible = await listArrivalAreasForViewer(
    {
      repos: deps.repos,
      authz: deps.authz,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    {
      ...page,
      viewerHumanId: input.viewerHumanId,
      ...("eventId" in page && input.gateAccessGranted
        ? { gateAccessGranted: true }
        : {}),
    },
  );
  const shown = visible.areas.find((area) => area.id === row.id);
  if (!shown) throw notFound();

  return {
    type: "ARRIVAL_AREA",
    kind: shown.kind,
    label: shown.label,
    cost: shown.cost,
    priceText: shown.priceText,
    note: shown.note,
    geometry: shown.geometry,
    placeId: row.placeId,
    eventId: row.eventId,
    seenOnEventId: input.seenOnEventId,
  };
}

/** Empty-after-sanitize details collapse to null (stored as SQL NULL). */
function normalizeOptionalDetails(details: string | undefined): string | null {
  if (!details) return null;
  return details.length > 0 ? details : null;
}
