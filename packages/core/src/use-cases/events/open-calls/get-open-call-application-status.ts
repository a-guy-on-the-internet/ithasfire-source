import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { OpenCallSubmissionRecord } from "@th/ports/repos/events";
import { applicationSubmissionStatusSchema } from "@th/schema";

import { parseInput } from "../../../lib/io";
import type { OpenCallAnchorContext } from "./_shared/open-call-anchor";
import {
  openCallApplicantAuthSchema,
  openCallDateId,
  openCallState,
  resolveOpenCallApplication,
} from "./_shared/open-call-application";
import { openCallPayKindSchema } from "./_shared/open-call-pay";

/** Most peers the status page lists. */
export const MAX_OPEN_CALL_PEERS = 200;
/** Upcoming series dates the status page offers for an edit. */
const MAX_SERIES_DATES = 60;

export const getOpenCallApplicationStatusInputSchema = z
  .object({ auth: openCallApplicantAuthSchema })
  .strict();

const dateSchema = z
  .object({
    /** The id to name this date by in an edit (occurrence / EventDate); null when implied. */
    id: z.string().nullable(),
    startsAt: z.date(),
    endsAt: z.date().nullable(),
  })
  .strict();

/**
 * One other applicant on the call (FR-008): name, photo, links. Nothing
 * else, by construction (NFR-002): no status, vote, note, decision, email,
 * or any id.
 */
export const openCallPeerSchema = z
  .object({
    kind: z.enum(["human", "org", "guest"]),
    name: z.string(),
    photoUrl: z.string().nullable(),
    pageSlug: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict();

export const openCallApplicationViewSchema = z
  .object({
    /** The applicant's OWN status (fine to show them; Q38 copy lives in the UI). */
    status: applicationSubmissionStatusSchema,
    appliedAs: z
      .object({ kind: z.enum(["self", "org", "guest"]), name: z.string().nullable() })
      .strict(),
    answers: z.record(z.string(), z.unknown()),
    /** The questions as they were when the answers were given, in form order. */
    questions: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          type: z.string(),
          options: z.array(z.object({ id: z.string(), label: z.string() }).strict()).nullable(),
        })
        .strict(),
    ),
    dateChoices: z.array(z.object({ id: z.string(), startsAt: z.date() }).strict()),
    isPrivate: z.boolean(),
    /** Someone on the organizer side opened it (FR-010: Edit gives way to "they've seen it"). */
    seenByOrganizers: z.boolean(),
    createdAt: z.date(),
  })
  .strict();

export const getOpenCallApplicationStatusOutputSchema = z
  .object({
    application: openCallApplicationViewSchema,
    /** PENDING and not yet opened (FR-010). */
    canEdit: z.boolean(),
    /** PENDING (after a pick it's "drop out", step 6). */
    canWithdraw: z.boolean(),
    /**
     * Not WITHDRAWN and the identity's latest row on the call (the row the
     * peer list judges privacy by); never locked by opening or a decision.
     */
    canSetPrivacy: z.boolean(),
    call: z
      .object({
        publicId: z.string(),
        anchor: z.enum(["event", "series"]),
        title: z.string(),
        timezone: z.string(),
        pay: z
          .object({ kind: openCallPayKindSchema.nullable(), details: z.string().nullable() })
          .strict(),
        closesAt: z.date().nullable(),
        closed: z.boolean(),
        closedReason: z.enum(["closed_by_poster", "last_date_started", "event_ended"]).nullable(),
        /** The dates an edit may choose from (upcoming only). */
        dates: z.array(dateSchema),
      })
      .strict(),
    /**
     * FR-008 peer list: null while the call is closed or after this applicant
     * withdrew; otherwise the other non-private, non-withdrawn applicants.
     */
    peers: z.array(openCallPeerSchema).nullable(),
  })
  .strict();

export type GetOpenCallApplicationStatusInput = z.infer<
  typeof getOpenCallApplicationStatusInputSchema
>;
export type GetOpenCallApplicationStatusOutput = z.infer<
  typeof getOpenCallApplicationStatusOutputSchema
>;

export type GetOpenCallApplicationStatusDeps = {
  repos: Pick<
    Repos,
    | "eventApplications"
    | "events"
    | "series"
    | "eventDates"
    | "seriesOccurrences"
    | "humans"
    | "organizations"
    | "authz"
  >;
  clock: ClockPort;
};

/** Own statuses after which the applicant no longer sees the peer list. */
const NO_PEERS_FOR_OWN_STATUS: ReadonlySet<string> = new Set(["WITHDRAWN", "EXPIRED"]);

/**
 * The applicant's status page (FR-009), by session or status token: their
 * own application, what they may still do, the call summary and, while the
 * call is open, the peer list (FR-008).
 *
 * Every field is projected one by one, never spread from a record, so a
 * column added later can't leak (NFR-002). The peer list is filtered and
 * deduped in the query (one entry per applicant identity; private and
 * withdrawn rows never leave the database) and excludes every row sharing
 * this applicant's identity.
 */
export async function getOpenCallApplicationStatus(
  deps: GetOpenCallApplicationStatusDeps,
  rawInput: unknown,
): Promise<GetOpenCallApplicationStatusOutput> {
  const input = parseInput(getOpenCallApplicationStatusInputSchema, rawInput);
  const now = deps.clock.now();
  const { submission, form, anchor } = await resolveOpenCallApplication(
    deps.repos,
    input.auth,
    now,
  );
  const { closedReason, upcoming } = await openCallState(deps.repos, form, anchor, now);

  const peers =
    closedReason === null && !NO_PEERS_FOR_OWN_STATUS.has(submission.status)
      ? await deps.repos.eventApplications.listOpenCallPeers({
          formId: form.id,
          viewer: {
            humanId: submission.humanId,
            applyingAsOrgId: submission.applyingAsOrgId,
            contactEmail: submission.contactEmail,
          },
          limit: MAX_OPEN_CALL_PEERS,
        })
      : null;

  const dates = (anchor.kind === "series" ? upcoming.slice(0, MAX_SERIES_DATES) : upcoming).map(
    (d) => ({ id: openCallDateId(d), startsAt: d.startsAt, endsAt: d.endsAt }),
  );

  return getOpenCallApplicationStatusOutputSchema.parse({
    application: await projectOpenCallApplication(deps, submission),
    canEdit: submission.status === "PENDING" && submission.openedAt === null,
    canWithdraw: submission.status === "PENDING",
    canSetPrivacy:
      submission.status !== "WITHDRAWN" &&
      (await deps.repos.eventApplications.isLatestOpenCallSubmission({
        submissionId: submission.id,
        formId: form.id,
      })),
    call: {
      publicId: form.publicId,
      anchor: anchor.kind,
      title: anchorTitle(anchor),
      timezone: anchor.kind === "event" ? anchor.event.timezone : anchor.series.timezone,
      pay: { kind: form.payKind, details: form.payDetails },
      closesAt: form.closesAt,
      closed: closedReason !== null,
      closedReason,
      dates,
    },
    peers:
      peers?.map((p) => ({
        kind: p.kind,
        name: p.name,
        photoUrl: p.photoUrl,
        pageSlug: p.pageSlug,
        url: p.url,
      })) ?? null,
  });
}

export function anchorTitle(anchor: OpenCallAnchorContext): string {
  return anchor.kind === "event" ? anchor.event.title : anchor.series.name;
}

/** The applicant's own application, field by field (shared with the edit). */
export async function projectOpenCallApplication(
  deps: { repos: Pick<Repos, "humans" | "organizations"> },
  submission: OpenCallSubmissionRecord,
): Promise<z.infer<typeof openCallApplicationViewSchema>> {
  let appliedAs: { kind: "self" | "org" | "guest"; name: string | null };
  if (submission.applyingAsOrgId) {
    const org = await deps.repos.organizations.getById(submission.applyingAsOrgId);
    appliedAs = { kind: "org", name: org?.name ?? null };
  } else if (submission.humanId) {
    const human = await deps.repos.humans.getById(submission.humanId);
    appliedAs = { kind: "self", name: human?.name ?? null };
  } else {
    appliedAs = { kind: "guest", name: submission.guestName };
  }

  const questions = Object.entries(submission.questionsSnapshot)
    .map(([id, entry]) => ({ id, entry }))
    .sort((a, b) => (a.entry.order ?? 0) - (b.entry.order ?? 0))
    .map(({ id, entry }) => ({
      id,
      label: entry.label,
      type: entry.type,
      options: entry.options?.map((o) => ({ id: o.id, label: o.label })) ?? null,
    }));

  return {
    status: submission.status,
    appliedAs,
    answers: submission.answers,
    questions,
    dateChoices: submission.dateChoices.flatMap((c) => {
      const id = c.occurrenceId ?? c.eventDateId ?? null;
      return id ? [{ id, startsAt: c.startsAt }] : [];
    }),
    isPrivate: submission.isPrivate,
    seenByOrganizers: submission.openedAt !== null,
    createdAt: submission.createdAt,
  };
}
