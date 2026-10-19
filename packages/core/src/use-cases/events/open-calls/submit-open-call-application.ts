import { randomUUID } from "node:crypto";

import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { OpenCallSubmissionRecord } from "@th/ports/repos/events";
import { toSafeExternalUrl } from "@th/types";

import { NOTIFICATION_LOCALES } from "../../comms/locale";

import { parseInput } from "../../../lib/io";
import { ORG_EDIT_ROLES, requireOrgMembership } from "../../../lib/rbac";
import { plainTextRequired } from "../../../lib/sanitize-plain-text";
import {
  answersSchema,
  buildQuestionsSnapshot,
  hasMissingRequiredAnswers,
} from "../_shared/application-answers";
import { isDuplicateOpenApplication } from "../_shared/status-conflict";
import { lowercasedContactEmailSchema } from "../_shared/viewer-contact-schema";
import { anchorOfForm, loadOpenCallAnchor } from "./_shared/open-call-anchor";
import {
  dateIdsSchema,
  OPEN_CALL_GUEST_NAME_MAX,
  openCallState,
  resolveDateChoices,
} from "./_shared/open-call-application";
import {
  deriveStatusToken,
  isUsableStatusTokenSecret,
  openCallStatusPath,
} from "./_shared/status-token";

/**
 * Statuses that use up a place under the call's `maxSubmissions` (same set
 * as the attendee gate): a withdrawn or expired application frees its place.
 */
const CAP_COUNTED_STATUSES = ["PENDING", "APPROVED", "REJECTED", "WAITLISTED"] as const;

/** Same bounds as a guest act's lineup row (`attachEventHuman` externalName / externalUrl). */
const GUEST_NAME_MAX = OPEN_CALL_GUEST_NAME_MAX;
const GUEST_URL_MAX = 500;

const guestSchema = z
  .object({
    name: plainTextRequired(GUEST_NAME_MAX),
    email: lowercasedContactEmailSchema.unwrap().unwrap(),
    url: z
      .string()
      .trim()
      .url()
      .max(GUEST_URL_MAX)
      .refine((value) => toSafeExternalUrl(value) !== null, {
        message: "external_url_invalid_protocol",
      })
      .nullable()
      .optional(),
  })
  .strict();

export const submitOpenCallApplicationInputSchema = z
  .object({
    publicId: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]{1,32}$/),
    /** The signed-in applicant; null / absent for a guest. Injected by the transport. */
    viewerHumanId: z.uuid().nullable().optional(),
    /** Apply on behalf of this organisation (signed-in only, Q33). */
    applyingAsOrgId: z.uuid().nullable().optional(),
    /** Guest identity (FR-006): required without a session, refused with one. */
    guest: guestSchema.nullable().optional(),
    answers: answersSchema,
    /** Chosen dates by occurrence / EventDate id (FR-007). */
    dateIds: dateIdsSchema,
    /** "Keep my application private" (FR-008). */
    isPrivate: z.boolean().default(false),
    /**
     * The language the applicant applied in (the page's locale; the
     * transport supplies it from the request in step 9). Stored on the
     * submission so a GUEST's later emails are written in it
     * (`resolveGuestNoticeLocale`). Absent → null → the platform default.
     */
    contactLocale: z.enum(NOTIFICATION_LOCALES).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.viewerHumanId) {
      if (value.guest) {
        ctx.addIssue({ code: "custom", message: "guest_with_session", path: ["guest"] });
      }
    } else {
      if (!value.guest) {
        ctx.addIssue({ code: "custom", message: "guest_details_required", path: ["guest"] });
      }
      if (value.applyingAsOrgId) {
        // Guests always apply as a name, never an organisation (FR-006).
        ctx.addIssue({
          code: "custom",
          message: "guest_cannot_apply_as_org",
          path: ["applyingAsOrgId"],
        });
      }
    }
  });

const anchorRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), eventId: z.uuid() }).strict(),
  z.object({ kind: z.literal("series"), seriesId: z.uuid() }).strict(),
]);

/**
 * What step 7 sends after the commit: the "application received" notice to
 * the submitter, or, for a guest whose email already holds an open
 * application here, the one email to that address (the enumeration split,
 * see below). The notice carries NO token: the notifier re-derives a guest's
 * status link at send time (`_shared/status-token.ts`), so the notice can be
 * re-sent by a reconcile from the submission id alone.
 */
const noticeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("application_received"),
      submissionId: z.uuid(),
      formId: z.uuid(),
      anchor: anchorRefSchema,
      title: z.string(),
      applicant: z
        .object({
          humanId: z.uuid().nullable(),
          applyingAsOrgId: z.uuid().nullable(),
          guestName: z.string().nullable(),
          contactEmail: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("guest_duplicate"),
      contactEmail: z.string(),
      publicId: z.string(),
      title: z.string(),
    })
    .strict(),
]);

/**
 * INTERNAL result, for the transport and step 7's notices. The transport
 * MUST NOT pass `outcome`, `statusToken`, `statusPath` or `notice` to a
 * GUEST client: the guest's link travels by email only (FR-009), and a
 * guest duplicate must look exactly like a first submit from outside.
 */
export const submitOpenCallApplicationOutputSchema = z
  .object({
    outcome: z.enum(["created", "guest_duplicate"]),
    publicId: z.string(),
    /** Null on guest_duplicate. */
    submissionId: z.uuid().nullable(),
    /**
     * The raw status token (re-derivable from the id and the secret; never
     * stored). Null on guest_duplicate. Never sent to a client: the link
     * travels by email only, to guests (FR-009).
     */
    statusToken: z.string().nullable(),
    /** `/call/<publicId>/application/<token>`. Null on guest_duplicate. */
    statusPath: z.string().nullable(),
    notice: noticeSchema,
  })
  .strict();

export type SubmitOpenCallApplicationInput = z.input<typeof submitOpenCallApplicationInputSchema>;
export type SubmitOpenCallApplicationOutput = z.infer<typeof submitOpenCallApplicationOutputSchema>;

export type SubmitOpenCallApplicationDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "eventApplications"
    | "events"
    | "series"
    | "eventDates"
    | "seriesOccurrences"
    | "authz"
    | "bans"
  >;
  clock: ClockPort;
  /**
   * The status-token key (HKDF of UNSUBSCRIBE_SECRET, see
   * `_shared/status-token.ts`). Null or short → NOT_CONFIGURED: never mint a
   * link under a weak key.
   */
  statusTokenSecret: string | null;
  logger?: LoggerPort;
};

/**
 * Apply to an open call (FR-006..FR-011). Beside the attendee gate's
 * `submitEventApplication`, sharing its answer validation
 * (`_shared/application-answers`) and its duplicate mapping, so the attendee
 * path stays untouched.
 *
 * Turnstile and the rate limit live at the transport (step 9), as they do
 * for `events.submitApplication`.
 *
 * ── The call must be open, read under the row lock ──────────────────────
 * Inside the transaction the FIRST statement is `lockOpenCallForSubmit`
 * (FOR KEY SHARE on the form row), and every open/closed decision reads that
 * locked row: refused when postedAt is null (a draft, Q41) or closedAt is
 * set. A close in flight holds FOR UPDATE, so this waits for it and then
 * sees closedAt; a close that starts after this lock waits for the insert
 * and its sweep sees the new row. No advisory lock is taken after the row
 * lock. A CAPPED call (maxSubmissions set) upgrades the lock to FOR NO KEY
 * UPDATE (`lockOpenCallForCappedSubmit`), so capped submits serialise and
 * the cap is hard; uncapped calls stay on KEY SHARE and never queue on each
 * other. Then: the opensAt / closesAt window (the deadline stops new
 * applications, FR-004), and the call's end (anchor ended, or the last date
 * started) as OPEN_CALL_CLOSED.
 *
 * ── Who applies ─────────────────────────────────────────────────────────
 * Signed in: as themselves, or as an org (Q33) where they hold an
 * ORG_EDIT_ROLES role (OWNER / ADMIN / EDITOR). Applying commits the org to
 * play a night, which is the same weight as editing what the org puts on;
 * a VIEWER, SCANNER or FINANCE member can't speak for the band.
 * One open application per applicant ENTITY per call (owner ruling Q42,
 * enforced by the partial unique indexes, no racy pre-check): one as
 * themselves (open_human_key, applyingAsOrgId null) and one per org
 * (open_org_key on (formId, applyingAsOrgId), whoever submits it). A person
 * in three bands may apply as each band and as themselves; a second member
 * applying for the same band gets APPLICATION_ALREADY_SUBMITTED. A banned
 * person or withheld org is refused (FORBIDDEN).
 * Guest: name + email (+ optional link), never an org.
 *
 * ── The enumeration split (as the attendee gate) ────────────────────────
 * A signed-in duplicate gets APPLICATION_ALREADY_SUBMITTED (it only tells
 * you about yourself). A guest duplicate is keyed by a self-asserted email,
 * so it returns outcome "guest_duplicate" with no id and no token, which the
 * transport turns into the same response as a first submit; step 7 emails
 * the address owner instead.
 */
export async function submitOpenCallApplication(
  deps: SubmitOpenCallApplicationDeps,
  rawInput: unknown,
): Promise<SubmitOpenCallApplicationOutput> {
  const input = parseInput(submitOpenCallApplicationInputSchema, rawInput);
  const statusTokenSecret = deps.statusTokenSecret;
  if (!isUsableStatusTokenSecret(statusTokenSecret)) throw fail("NOT_CONFIGURED");
  const viewerHumanId = input.viewerHumanId ?? null;
  const guest = viewerHumanId ? null : (input.guest ?? null);
  const applyingAsOrgId = viewerHumanId ? (input.applyingAsOrgId ?? null) : null;

  const call = await deps.repos.eventApplications.getOpenCallByPublicId(input.publicId);
  // Drafts (Q41) and banned owners' calls look like missing ones.
  if (!call || call.ownerBanned || !call.postedAt) throw fail("OPEN_CALL_NOT_FOUND");

  if (applyingAsOrgId && viewerHumanId) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: applyingAsOrgId,
      actorHumanId: viewerHumanId,
      roles: ORG_EDIT_ROLES,
    });
  }
  if (viewerHumanId) {
    // Ban-that-sticks: a banned person, or an org withheld because its
    // owners are banned, can't put its name on a call (the same rule as
    // every public read, `bans.findBannedOwners`).
    const withheld = await deps.repos.bans.findBannedOwners({
      humanIds: [viewerHumanId],
      orgIds: applyingAsOrgId ? [applyingAsOrgId] : [],
    });
    if (withheld.humanIds.length > 0 || withheld.orgIds.length > 0) throw fail("FORBIDDEN");
  }

  const questions = await deps.repos.eventApplications.listQuestions(call.id);
  if (hasMissingRequiredAnswers(questions, input.answers)) {
    throw fail("APPLICATION_ANSWERS_INCOMPLETE");
  }
  const questionsSnapshot = buildQuestionsSnapshot(questions);
  // The id is chosen here so the token can be derived from it before the
  // insert (the row stores only the hash).
  const submissionId = randomUUID();
  const { token, hash } = deriveStatusToken(statusTokenSecret, submissionId);

  let created: { submission: OpenCallSubmissionRecord; title: string };
  try {
    created = await deps.repos.tx(async (tx) => {
      let locked = await tx.eventApplications.lockOpenCallForSubmit(call.id);
      if (locked && locked.maxSubmissions !== null) {
        // A capped call: upgrade to FOR NO KEY UPDATE so concurrent submits
        // serialise and the count below sees every committed one (hard cap).
        // Decided from the LOCKED row, so a cap set after the pre-read counts;
        // but a cap set (null -> N) by an organizer UPDATE after an UNCAPPED
        // submit passed this KEY SHARE lock is missed by that in-flight submit.
        locked = await tx.eventApplications.lockOpenCallForCappedSubmit(call.id);
      }
      if (!locked || !locked.postedAt) throw fail("OPEN_CALL_NOT_FOUND");
      if (locked.closedAt) throw fail("OPEN_CALL_CLOSED");

      const now = deps.clock.now();
      if (locked.opensAt && now.getTime() < locked.opensAt.getTime()) {
        throw fail("APPLICATION_WINDOW_NOT_OPEN");
      }
      if (locked.closesAt && now.getTime() > locked.closesAt.getTime()) {
        throw fail("APPLICATION_WINDOW_CLOSED");
      }

      const anchor = await loadOpenCallAnchor(tx, locked);
      const { closedReason, upcoming } = await openCallState(tx, locked, anchor, now);
      if (closedReason) throw fail("OPEN_CALL_CLOSED");

      if (locked.maxSubmissions !== null) {
        const count = await tx.eventApplications.countSubmissionsByForm({
          formId: locked.id,
          statuses: [...CAP_COUNTED_STATUSES],
        });
        if (count >= locked.maxSubmissions) throw fail("APPLICATION_CAP_REACHED");
      }

      const dateChoices = resolveDateChoices(anchor, upcoming, input.dateIds);

      const submission = await tx.eventApplications.createOpenCallSubmission({
        id: submissionId,
        formId: locked.id,
        // Event call: the event; series call: null (the composite FK
        // requires the form's own eventId).
        eventId: locked.eventId,
        humanId: viewerHumanId,
        applyingAsOrgId,
        guestName: guest?.name ?? null,
        guestUrl: guest?.url ?? null,
        contactEmail: guest?.email ?? null,
        contactLocale: input.contactLocale ?? null,
        answers: input.answers,
        questionsSnapshot,
        isPrivate: input.isPrivate,
        statusTokenHash: hash,
        dateChoices,
        submittedAt: now,
      });

      const ref = anchorOfForm(locked);
      await tx.audit.log({
        entity: ref.kind === "event" ? "event" : "event_series",
        entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
        action: "open_call_application_submitted",
        data: {
          formId: locked.id,
          submissionId: submission.id,
          humanId: viewerHumanId,
          applyingAsOrgId,
          guest: guest !== null,
          dateChoiceCount: dateChoices.length,
          isPrivate: input.isPrivate,
        },
        at: now,
      });

      return {
        submission,
        title: anchor.kind === "event" ? anchor.event.title : anchor.series.name,
      };
    });
  } catch (error) {
    if (!isDuplicateOpenApplication(error)) throw error;
    if (viewerHumanId) throw fail("APPLICATION_ALREADY_SUBMITTED", { cause: error });
    deps.logger?.info("open_call", {
      category: "open_call",
      action: "application_guest_duplicate",
      formId: call.id,
    });
    const anchor = await loadOpenCallAnchor(deps.repos, call);
    return submitOpenCallApplicationOutputSchema.parse({
      outcome: "guest_duplicate",
      publicId: call.publicId,
      submissionId: null,
      statusToken: null,
      statusPath: null,
      notice: {
        kind: "guest_duplicate",
        contactEmail: guest!.email,
        publicId: call.publicId,
        title: anchor.kind === "event" ? anchor.event.title : anchor.series.name,
      },
    });
  }

  const { submission, title } = created;
  const statusPath = openCallStatusPath(call.publicId, token);

  deps.logger?.info("open_call", {
    category: "open_call",
    action: "application_submitted",
    formId: call.id,
    submissionId: submission.id,
    viewerHumanId,
    applyingAsOrgId,
    guest: guest !== null,
  });

  return submitOpenCallApplicationOutputSchema.parse({
    outcome: "created",
    publicId: call.publicId,
    submissionId: submission.id,
    statusToken: token,
    statusPath,
    notice: {
      kind: "application_received",
      submissionId: submission.id,
      formId: call.id,
      anchor: anchorOfForm(call),
      title,
      applicant: {
        humanId: submission.humanId,
        applyingAsOrgId: submission.applyingAsOrgId,
        guestName: submission.guestName,
        contactEmail: submission.contactEmail,
      },
    },
  });
}
