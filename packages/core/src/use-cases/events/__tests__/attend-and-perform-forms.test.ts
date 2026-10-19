/**
 * Open calls v1, step 2 (behaviour-neutral re-key): an event can hold an
 * ATTEND form (the attendee gate) AND a PERFORM form (an open call). The
 * attendee paths must read and write the ATTEND form only, and the
 * one-open-application rule is per FORM.
 *
 * The fake repo below stores forms by (eventId, purpose) and submissions by
 * formId, and answers each method only for the form its arguments name — so
 * a use case that asked for the wrong purpose (or forgot to scope by form)
 * gets the PERFORM data back and the assertions catch it.
 */
import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type {
  ApplicationFormPurpose,
  EventApplicationFormRecord,
  EventApplicationQuestionRecord,
  EventApplicationSubmissionRecord,
  EventRecord,
  Repos,
} from "@th/ports/repos";

import { getPublicEventApplicationForm } from "../get-public-event-application-form";
import { getViewerApplicationStatus } from "../get-viewer-application-status";
import { submitEventApplication } from "../submit-event-application";
import { eventApplicationSubmissionRecordSchema } from "../_shared/event-application-submission-schema";

const EVENT_ID = "50000000-0000-4000-8000-000000000005";
const ORG_ID = "60000000-0000-4000-8000-000000000006";
const HUMAN_ID = "70000000-0000-4000-8000-000000000007";
const ATTEND_FORM_ID = "a0000000-0000-4000-8000-00000000000a";
const PERFORM_FORM_ID = "b0000000-0000-4000-8000-00000000000b";
const ATTEND_Q_ID = "c0000000-0000-4000-8000-00000000000c";
const PERFORM_Q_ID = "d0000000-0000-4000-8000-00000000000d";
const PERFORM_SUB_ID = "e0000000-0000-4000-8000-00000000000e";
const NOW = new Date("2026-10-05T12:00:00Z");

const event = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Night with an open call",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "APPLICATION",
} as unknown as EventRecord;

const form = (
  id: string,
  purpose: ApplicationFormPurpose,
  introText: string,
): EventApplicationFormRecord => ({
  id,
  eventId: EVENT_ID,
  purpose,
  publicId: purpose === "ATTEND" ? "attend0001" : "perform001",
  introText,
  defaults: { includeName: false, includeReason: false, includeSocialLinks: false },
  opensAt: null,
  closesAt: null,
  maxSubmissions: null,
  autoApprove: false,
  updatedByHumanId: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const question = (
  id: string,
  formId: string,
  label: string,
): EventApplicationQuestionRecord => ({
  id,
  formId,
  type: "SHORT_TEXT",
  label,
  description: null,
  options: null,
  isRequired: false,
  order: 0,
  createdAt: NOW,
  updatedAt: NOW,
});

type StoredSubmission = EventApplicationSubmissionRecord;

function makeWorld() {
  const forms = [
    form(ATTEND_FORM_ID, "ATTEND", "Tell us why you want to come"),
    form(PERFORM_FORM_ID, "PERFORM", "Pitch your act"),
  ];
  const questions = [
    question(ATTEND_Q_ID, ATTEND_FORM_ID, "Who are you bringing?"),
    question(PERFORM_Q_ID, PERFORM_FORM_ID, "Link to your music"),
  ];
  const submissions: StoredSubmission[] = [];
  const formOf = (eventId: string, purpose: ApplicationFormPurpose) =>
    forms.find((f) => f.eventId === eventId && f.purpose === purpose) ?? null;
  const OPEN = new Set(["PENDING", "APPROVED", "WAITLISTED"]);

  const eventApplications = {
    getForm: vi.fn(async (eventId: string, purpose: ApplicationFormPurpose) =>
      formOf(eventId, purpose),
    ),
    ensureForm: vi.fn(
      async (input: { eventId: string; purpose: ApplicationFormPurpose }) => {
        const found = formOf(input.eventId, input.purpose);
        if (!found) throw new Error("test world always has both forms");
        return found;
      },
    ),
    listQuestions: vi.fn(async (formId: string) =>
      questions.filter((q) => q.formId === formId),
    ),
    countSubmissions: vi.fn(
      async (input: { eventId: string; purpose: ApplicationFormPurpose }) => {
        const f = formOf(input.eventId, input.purpose);
        return submissions.filter((s) => s.formId === f?.id).length;
      },
    ),
    findOpenSubmission: vi.fn(
      async (input: { formId: string; humanId?: string; contactEmail?: string }) =>
        submissions.find(
          (s) =>
            s.formId === input.formId &&
            OPEN.has(s.status) &&
            (input.humanId !== undefined
              ? s.humanId === input.humanId
              : s.humanId === null && s.contactEmail === input.contactEmail),
        ) ?? null,
    ),
    getSubmissionByEventAndHuman: vi.fn(
      async (eventId: string, purpose: ApplicationFormPurpose, humanId: string) => {
        const f = formOf(eventId, purpose);
        return (
          submissions.find((s) => s.formId === f?.id && s.humanId === humanId) ??
          null
        );
      },
    ),
    createSubmission: vi.fn(
      async (input: {
        formId: string;
        eventId: string;
        humanId?: string | null;
        contactEmail?: string | null;
        answers: Record<string, unknown>;
        submittedAt: Date;
      }) => {
        // Mirror the per-form partial unique index.
        if (
          input.humanId &&
          submissions.some(
            (s) =>
              s.formId === input.formId &&
              s.humanId === input.humanId &&
              OPEN.has(s.status),
          )
        ) {
          throw { code: "duplicate_open_application" };
        }
        const row: StoredSubmission = {
          id: `f000000${submissions.length}-0000-4000-8000-00000000000f`,
          formId: input.formId,
          purpose: input.formId === ATTEND_FORM_ID ? "ATTEND" : "PERFORM",
          eventId: input.eventId,
          humanId: input.humanId ?? null,
          contactEmail: input.contactEmail ?? null,
          contactPhone: null,
          status: "PENDING",
          answers: input.answers,
          decisionReason: null,
          questionsSnapshot: {},
          reviewerHumanId: null,
          reviewedAt: null,
          approvalToken: null,
          tokenExpiresAt: null,
          inviteId: null,
          metadata: {},
          createdAt: input.submittedAt,
          updatedAt: input.submittedAt,
        };
        submissions.push(row);
        return row;
      },
    ),
  };

  const repos = {
    events: { getById: vi.fn(async () => event) },
    authz: { getOrgMembership: vi.fn(async () => null) },
    eventApplications,
    tx: vi.fn(async (fn: (r: unknown) => Promise<unknown>) => fn(repos)),
    organizations: {},
  } as unknown as Pick<
    Repos,
    "events" | "authz" | "eventApplications" | "tx" | "organizations"
  >;
  const clock: ClockPort = { now: () => NOW };

  return { repos, clock, submissions, eventApplications };
}

const performSubmission = (status: "PENDING" | "APPROVED"): StoredSubmission => ({
  id: PERFORM_SUB_ID,
  formId: PERFORM_FORM_ID,
  purpose: "PERFORM",
  eventId: EVENT_ID,
  humanId: HUMAN_ID,
  contactEmail: null,
  contactPhone: null,
  status,
  answers: {},
  decisionReason: null,
  questionsSnapshot: {},
  reviewerHumanId: null,
  reviewedAt: null,
  approvalToken: null,
  tokenExpiresAt: null,
  inviteId: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
});

describe("an event holding BOTH an ATTEND and a PERFORM form", () => {
  it("the public attendee form shows the ATTEND form and its questions only", async () => {
    const { repos } = makeWorld();

    const result = await getPublicEventApplicationForm(
      { repos },
      { eventId: EVENT_ID },
    );

    expect(result.introText).toBe("Tell us why you want to come");
    expect(result.questions.map((q) => q.id)).toEqual([ATTEND_Q_ID]);
  });

  it("viewer status ignores the human's PERFORM application", async () => {
    const { repos, submissions } = makeWorld();
    submissions.push(performSubmission("APPROVED"));

    const result = await getViewerApplicationStatus(
      { repos },
      { eventId: EVENT_ID, viewerHumanId: HUMAN_ID },
    );

    // The performer pitch is not an attendee application.
    expect(result).toEqual({ hasSubmission: false, submission: null });
  });

  it("submitting to the attendee gate writes to the ATTEND form", async () => {
    const { repos, clock, submissions, eventApplications } = makeWorld();

    const result = await submitEventApplication(
      { repos, clock },
      { eventId: EVENT_ID, viewerHumanId: HUMAN_ID, answers: {} },
    );

    expect(result.status).toBe("PENDING");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.formId).toBe(ATTEND_FORM_ID);
    // The form already exists, so nothing is created.
    expect(eventApplications.ensureForm).not.toHaveBeenCalled();
  });

  it("the same human can hold an open application on EACH form (dedupe is per form)", async () => {
    const { repos, clock, submissions, eventApplications } = makeWorld();
    submissions.push(performSubmission("PENDING"));

    const result = await submitEventApplication(
      { repos, clock },
      { eventId: EVENT_ID, viewerHumanId: HUMAN_ID, answers: {} },
    );

    expect(result.status).toBe("PENDING");
    expect(eventApplications.findOpenSubmission).toHaveBeenCalledWith({
      formId: ATTEND_FORM_ID,
      humanId: HUMAN_ID,
    });
    expect(submissions.map((s) => [s.formId, s.status])).toEqual([
      [PERFORM_FORM_ID, "PENDING"],
      [ATTEND_FORM_ID, "PENDING"],
    ]);
  });

  it("a second attendee application from the same human is still refused", async () => {
    const { repos, clock } = makeWorld();
    const deps = { repos, clock };
    const input = { eventId: EVENT_ID, viewerHumanId: HUMAN_ID, answers: {} };

    await submitEventApplication(deps, input);

    await expect(submitEventApplication(deps, input)).rejects.toMatchObject({
      code: "APPLICATION_ALREADY_SUBMITTED",
    });
  });

  it("the API projection strips the internal formId / purpose (wire shape unchanged)", () => {
    const projected = eventApplicationSubmissionRecordSchema.parse(
      performSubmission("PENDING"),
    );
    expect(projected).not.toHaveProperty("formId");
    expect(projected).not.toHaveProperty("purpose");
    expect(projected).toHaveProperty("inviteId", null);
  });
});
