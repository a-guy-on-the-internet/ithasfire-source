import { Prisma } from "@prisma/client";
import type { EventApplicationForm as PrismaEventApplicationForm } from "@prisma/client";
import type {
  ApplicationFormDefaults,
  CountSubmissionsByFormInput,
  EventApplicationsRepo,
  OpenCallAnchor,
  OpenCallFormRecord,
  OpenCallPoster,
  PosterOpenCallRecord,
  SeriesEventOpenCallRecord,
  UpsertOpenCallFormInput,
} from "@th/ports/repos/events";

import { mintApplicationFormPublicId } from "@th/core/lib/application-form-public-id";

import { resolveWithheldOwners } from "./banned-owner";
import type { PrismaClientOrTx } from "./types";

/**
 * Open-call (PERFORM form) methods of the event-applications repo (open calls
 * v1 step 3). Kept in their own module so the attendee-gate adapter stays
 * readable; `makeEventApplicationsRepo` spreads them in.
 *
 * Every read here filters `purpose: 'PERFORM'`, so an ATTEND form is
 * invisible: a lookup by its id or publicId answers null.
 */

type OpenCallMethods = Pick<
  EventApplicationsRepo,
  | "getOpenCall"
  | "getOpenCallById"
  | "getOpenCallByPublicId"
  | "upsertOpenCall"
  | "lockSeriesOpenCalls"
  | "listUpcomingEventOpenCallsInSeries"
  | "lockOpenCallForClose"
  | "lockOpenCallForSubmit"
  | "lockOpenCallForCappedSubmit"
  | "setOpenCallPosted"
  | "deleteOpenCallDraft"
  | "setOpenCallClosed"
  | "rejectPendingOpenCallSubmissions"
  | "countSubmissionsByForm"
  | "listOpenCallsByPoster"
>;

const DEFAULT_FORM_DEFAULTS: ApplicationFormDefaults = {
  includeName: false,
  includeReason: false,
  includeSocialLinks: false,
};

/** Occurrence statuses that are a live, upcoming night of a series. */
const LIVE_OCCURRENCE_STATUSES = ["PLANNED", "GENERATED", "PUBLISHED"] as const;

/**
 * A live night's materialised event, if any, is not CANCELLED: cancelling
 * the event alone leaves its occurrence reading live (core
 * listOpenCallDates and the step-8 sweep apply the same rule).
 */
const LIVE_NIGHT_EVENT = {
  OR: [{ eventId: null }, { event: { is: { status: { not: "CANCELLED" as const } } } }],
};

/** Upper bound on rows the poster list reads before sorting. */
const POSTER_CALLS_READ_CEILING = 200;

/** Event statuses whose night is over or off (no call can run on them). */
const ENDED_EVENT_STATUSES = ["CANCELLED", "ARCHIVED", "COMPLETED"] as const;

const coerceDefaults = (value: Prisma.JsonValue | null): ApplicationFormDefaults => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_FORM_DEFAULTS;
  }
  const parsed = value as Partial<ApplicationFormDefaults>;
  return {
    includeName: parsed.includeName ?? DEFAULT_FORM_DEFAULTS.includeName,
    includeReason: parsed.includeReason ?? DEFAULT_FORM_DEFAULTS.includeReason,
    includeSocialLinks:
      parsed.includeSocialLinks ?? DEFAULT_FORM_DEFAULTS.includeSocialLinks,
  };
};

/**
 * Map a PERFORM row. A non-PERFORM row reaching here is a broken invariant
 * (every query filters on purpose), so it throws rather than mis-typing.
 */
export function mapOpenCall(record: PrismaEventApplicationForm): OpenCallFormRecord {
  if (record.purpose !== "PERFORM") {
    throw new Error(
      `EventApplicationForm ${record.id} is ${record.purpose}, not an open call`,
    );
  }
  return {
    id: record.id,
    purpose: "PERFORM",
    eventId: record.eventId,
    seriesId: record.seriesId,
    publicId: record.publicId,
    introText: record.introText,
    defaults: coerceDefaults(record.defaults),
    opensAt: record.opensAt,
    closesAt: record.closesAt,
    maxSubmissions: record.maxSubmissions,
    autoApprove: record.autoApprove,
    payKind: record.payKind,
    payDetails: record.payDetails,
    closedAt: record.closedAt,
    closedByHumanId: record.closedByHumanId,
    postedAt: record.postedAt,
    postedByHumanId: record.postedByHumanId,
    updatedByHumanId: record.updatedByHumanId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Runtime guard: Prisma silently drops an undefined filter value. */
function requireAnchor(anchor: unknown, method: string): OpenCallAnchor {
  const a = anchor as Partial<{ kind: string; eventId: string; seriesId: string }>;
  if (a?.kind === "event" && typeof a.eventId === "string" && a.eventId) {
    return { kind: "event", eventId: a.eventId };
  }
  if (a?.kind === "series" && typeof a.seriesId === "string" && a.seriesId) {
    return { kind: "series", seriesId: a.seriesId };
  }
  throw new Error(`eventApplications.${method}: a valid open-call anchor is required`);
}

function requireId(value: unknown, method: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`eventApplications.${method}: ${name} is required`);
  }
  return value;
}

function anchorWhere(
  anchor: OpenCallAnchor,
): Prisma.EventApplicationFormWhereUniqueInput {
  return anchor.kind === "event"
    ? { eventId_purpose: { eventId: anchor.eventId, purpose: "PERFORM" } }
    : { seriesId_purpose: { seriesId: anchor.seriesId, purpose: "PERFORM" } };
}

export function makeOpenCallMethods(p: PrismaClientOrTx): OpenCallMethods {
  const lockRow = async (
    formId: string,
    mode: "UPDATE" | "NO KEY UPDATE" | "KEY SHARE",
  ): Promise<OpenCallFormRecord | null> => {
    // Parameterised tagged template (formId is a bind value); the lock mode
    // is one of three literals chosen here, never caller text.
    const rows =
      mode === "UPDATE"
        ? await p.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "EventApplicationForm"
            WHERE "id" = ${formId} AND "purpose" = 'PERFORM'::"ApplicationFormPurpose"
            FOR UPDATE`
        : mode === "NO KEY UPDATE"
          ? await p.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "EventApplicationForm"
            WHERE "id" = ${formId} AND "purpose" = 'PERFORM'::"ApplicationFormPurpose"
            FOR NO KEY UPDATE`
          : await p.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "EventApplicationForm"
            WHERE "id" = ${formId} AND "purpose" = 'PERFORM'::"ApplicationFormPurpose"
            FOR KEY SHARE`;
    if (rows.length === 0) return null;
    // Same transaction, row already locked: this read sees the locked
    // (latest committed) version.
    const record = await p.eventApplicationForm.findUnique({ where: { id: formId } });
    return record ? mapOpenCall(record) : null;
  };

  return {
    getOpenCall: async (anchor) => {
      const where = anchorWhere(requireAnchor(anchor, "getOpenCall"));
      const record = await p.eventApplicationForm.findUnique({ where });
      return record ? mapOpenCall(record) : null;
    },

    getOpenCallById: async (formId) => {
      const record = await p.eventApplicationForm.findFirst({
        where: { id: requireId(formId, "getOpenCallById", "formId"), purpose: "PERFORM" },
      });
      return record ? mapOpenCall(record) : null;
    },

    getOpenCallByPublicId: async (publicId) => {
      const record = await p.eventApplicationForm.findFirst({
        where: {
          publicId: requireId(publicId, "getOpenCallByPublicId", "publicId"),
          purpose: "PERFORM",
        },
        include: {
          event: { select: { humanId: true, orgId: true } },
          series: { select: { ownerScope: true, ownerId: true } },
        },
      });
      if (!record) return null;
      const { event, series, ...row } = record;
      const withheld = await resolveWithheldOwners(p);
      let ownerBanned = false;
      if (event) {
        ownerBanned =
          (event.humanId !== null && withheld.humanIds.includes(event.humanId)) ||
          (event.orgId !== null && withheld.orgIds.includes(event.orgId));
      } else if (series) {
        ownerBanned =
          series.ownerScope === "HUMAN"
            ? withheld.humanIds.includes(series.ownerId)
            : withheld.orgIds.includes(series.ownerId);
      }
      return { ...mapOpenCall(row), ownerBanned };
    },

    upsertOpenCall: async (input: UpsertOpenCallFormInput) => {
      const anchor = requireAnchor(input.anchor, "upsertOpenCall");
      const has = (key: keyof UpsertOpenCallFormInput) =>
        Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;

      const update: Prisma.EventApplicationFormUncheckedUpdateInput = {
        updatedByHumanId: input.updatedByHumanId,
      };
      if (has("introText")) update.introText = input.introText ?? null;
      if (has("defaults")) update.defaults = input.defaults as unknown as Prisma.InputJsonValue;
      if (has("opensAt")) update.opensAt = input.opensAt ?? null;
      if (has("closesAt")) update.closesAt = input.closesAt ?? null;
      if (has("maxSubmissions")) update.maxSubmissions = input.maxSubmissions ?? null;
      if (has("payKind")) update.payKind = input.payKind ?? null;
      if (has("payDetails")) update.payDetails = input.payDetails ?? null;

      const record = await p.eventApplicationForm.upsert({
        where: anchorWhere(anchor),
        update,
        create: {
          ...(anchor.kind === "event"
            ? { eventId: anchor.eventId }
            : { seriesId: anchor.seriesId }),
          purpose: "PERFORM",
          publicId: mintApplicationFormPublicId(),
          introText: input.introText ?? null,
          defaults: (input.defaults ?? DEFAULT_FORM_DEFAULTS) as unknown as Prisma.InputJsonValue,
          opensAt: input.opensAt ?? null,
          closesAt: input.closesAt ?? null,
          maxSubmissions: input.maxSubmissions ?? null,
          payKind: input.payKind ?? null,
          payDetails: input.payDetails ?? null,
          updatedByHumanId: input.updatedByHumanId,
        },
      });
      return mapOpenCall(record);
    },

    lockSeriesOpenCalls: async (seriesId) => {
      const id = requireId(seriesId, "lockSeriesOpenCalls", "seriesId");
      // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns `void`,
      // which the driver adapter cannot deserialize (see authz.ts).
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`open_call_series:${id}`}))`;
    },

    listUpcomingEventOpenCallsInSeries: async (input) => {
      const seriesId = requireId(input.seriesId, "listUpcomingEventOpenCallsInSeries", "seriesId");
      const rows = await p.eventApplicationForm.findMany({
        where: {
          purpose: "PERFORM",
          event: {
            is: {
              startsAt: { gt: input.startsAfter },
              status: { notIn: [...ENDED_EVENT_STATUSES] },
              seriesOccurrence: {
                is: { seriesId, status: { not: "DETACHED" } },
              },
            },
          },
        },
        select: {
          id: true,
          event: { select: { id: true, title: true, startsAt: true } },
        },
        orderBy: { event: { startsAt: "asc" } },
      });
      return rows
        .filter((r): r is typeof r & { event: NonNullable<typeof r.event> } => r.event !== null)
        .map(
          (r): SeriesEventOpenCallRecord => ({
            formId: r.id,
            eventId: r.event.id,
            eventTitle: r.event.title,
            eventStartsAt: r.event.startsAt,
          }),
        );
    },

    lockOpenCallForClose: async (formId) =>
      lockRow(requireId(formId, "lockOpenCallForClose", "formId"), "UPDATE"),

    lockOpenCallForSubmit: async (formId) =>
      // FOR KEY SHARE: conflicts with close/reopen's FOR UPDATE (so a submit
      // waits for a close in flight and then sees closedAt), but NOT with the
      // FOR NO KEY UPDATE a plain organizer edit takes, so editing the call's
      // intro or deadline never queues behind an applicant's submit.
      lockRow(requireId(formId, "lockOpenCallForSubmit", "formId"), "KEY SHARE"),

    lockOpenCallForCappedSubmit: async (formId) =>
      // FOR NO KEY UPDATE: capped submits serialise on it (hard cap), it
      // still waits for close's FOR UPDATE, and it does not conflict with a
      // submission INSERT's FK KEY SHARE.
      lockRow(requireId(formId, "lockOpenCallForCappedSubmit", "formId"), "NO KEY UPDATE"),

    setOpenCallPosted: async (input) => {
      const formId = requireId(input.formId, "setOpenCallPosted", "formId");
      const record = await p.eventApplicationForm.update({
        where: { id: formId, purpose: "PERFORM" },
        data: {
          postedAt: input.postedAt,
          postedByHumanId: input.postedByHumanId,
        },
      });
      return mapOpenCall(record);
    },

    deleteOpenCallDraft: async (formId) => {
      const id = requireId(formId, "deleteOpenCallDraft", "formId");
      // Questions cascade with the form. The submissions guard matters: they
      // cascade too, so the statement itself refuses a form that has any.
      const { count } = await p.eventApplicationForm.deleteMany({
        where: {
          id,
          purpose: "PERFORM",
          postedAt: null,
          submissions: { none: {} },
        },
      });
      return count > 0;
    },

    setOpenCallClosed: async (input) => {
      const formId = requireId(input.formId, "setOpenCallClosed", "formId");
      const record = await p.eventApplicationForm.update({
        where: { id: formId, purpose: "PERFORM" },
        data: {
          closedAt: input.closedAt,
          closedByHumanId: input.closedByHumanId,
        },
      });
      return mapOpenCall(record);
    },

    rejectPendingOpenCallSubmissions: async (input) => {
      const formId = requireId(input.formId, "rejectPendingOpenCallSubmissions", "formId");
      // One guarded statement: only rows still PENDING at write time flip, so
      // a concurrent pick / reply / withdraw that commits first is never
      // overwritten (its row is no longer PENDING when this re-checks).
      const rows = await p.eventApplicationSubmission.updateManyAndReturn({
        // Scalar-only filter (no relation filter in an updateMany); callers
        // pass a formId they read through the PERFORM-only methods above.
        where: { formId, status: "PENDING" },
        data: { status: "REJECTED", reviewedAt: input.reviewedAt },
        select: { id: true },
      });
      return { ids: rows.map((r) => r.id) };
    },

    countSubmissionsByForm: async (input: CountSubmissionsByFormInput) =>
      p.eventApplicationSubmission.count({
        where: {
          formId: requireId(input.formId, "countSubmissionsByForm", "formId"),
          ...(input.statuses ? { status: { in: input.statuses } } : {}),
        },
      }),

    listOpenCallsByPoster: async (input) => {
      const poster: OpenCallPoster = input.poster;
      const withheld = await resolveWithheldOwners(p);
      if (
        (poster.kind === "human" && withheld.humanIds.includes(poster.humanId)) ||
        (poster.kind === "org" && withheld.orgIds.includes(poster.orgId))
      ) {
        return [];
      }

      const eventOwner: Prisma.EventWhereInput =
        poster.kind === "org"
          ? { orgId: poster.orgId }
          : { humanId: poster.humanId, orgId: null };
      const seriesOwner: Prisma.EventSeriesWhereInput =
        poster.kind === "org"
          ? { ownerScope: "ORGANIZATION", ownerId: poster.orgId }
          : { ownerScope: "HUMAN", ownerId: poster.humanId };

      const rows = await p.eventApplicationForm.findMany({
        where: {
          purpose: "PERFORM",
          // Drafts are never listed (owner ruling Q41).
          postedAt: { not: null },
          closedAt: null,
          OR: [
            {
              event: {
                is: {
                  ...eventOwner,
                  visibility: "PUBLIC",
                  status: { notIn: [...ENDED_EVENT_STATUSES] },
                  startsAt: { gt: input.now },
                },
              },
            },
            {
              series: {
                is: {
                  ...seriesOwner,
                  archivedAt: null,
                  occurrences: {
                    some: {
                      status: { in: [...LIVE_OCCURRENCE_STATUSES] },
                      startsAt: { gt: input.now },
                      ...LIVE_NIGHT_EVENT,
                    },
                  },
                },
              },
            },
          ],
        },
        select: {
          id: true,
          publicId: true,
          eventId: true,
          seriesId: true,
          payKind: true,
          closesAt: true,
          event: { select: { title: true, startsAt: true, timezone: true } },
          series: {
            select: {
              name: true,
              timezone: true,
              occurrences: {
                where: {
                  status: { in: [...LIVE_OCCURRENCE_STATUSES] },
                  startsAt: { gt: input.now },
                  ...LIVE_NIGHT_EVENT,
                },
                orderBy: { startsAt: "asc" },
                take: 1,
                select: { startsAt: true },
              },
            },
          },
        },
        // The final order is by next start (below), which spans two
        // relations and cannot be one ORDER BY; a poster holds a handful of
        // open calls, so read them all up to a hard ceiling and sort here.
        take: POSTER_CALLS_READ_CEILING,
        orderBy: { createdAt: "desc" },
      });

      const cards: PosterOpenCallRecord[] = [];
      for (const r of rows) {
        if (r.eventId && r.event) {
          cards.push({
            formId: r.id,
            publicId: r.publicId,
            anchor: { kind: "event", eventId: r.eventId },
            title: r.event.title,
            payKind: r.payKind,
            closesAt: r.closesAt,
            nextStartsAt: r.event.startsAt,
            timezone: r.event.timezone,
          });
        } else if (r.seriesId && r.series && r.series.occurrences[0]) {
          cards.push({
            formId: r.id,
            publicId: r.publicId,
            anchor: { kind: "series", seriesId: r.seriesId },
            title: r.series.name,
            payKind: r.payKind,
            closesAt: r.closesAt,
            nextStartsAt: r.series.occurrences[0].startsAt,
            timezone: r.series.timezone,
          });
        }
      }
      cards.sort((a, b) => a.nextStartsAt.getTime() - b.nextStartsAt.getTime());
      return cards.slice(0, input.limit);
    },
  };
}
