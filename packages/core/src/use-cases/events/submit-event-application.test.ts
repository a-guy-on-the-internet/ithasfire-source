import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord, Repos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";

import { submitEventApplication } from "./submit-event-application";

const EVENT_ID = "50000000-0000-4000-8000-000000000005";
const ORG_ID = "60000000-0000-4000-8000-000000000006";
const HUMAN_ID = "70000000-0000-4000-8000-000000000007";
const OTHER_HUMAN_ID = "70000000-0000-4000-8000-000000000008";
const SUBMISSION_ID = "80000000-0000-4000-8000-000000000010";
const NOW = new Date("2025-12-03T12:00:00Z");

const buildEvent = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Gated Event",
  status: "PUBLISHED",
  visibility: "PRIVATE",
  gateType: "APPLICATION",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2025-12-10T00:00:00Z"),
  endsAt: new Date("2025-12-10T03:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  slug: "gated-event",
  shortId: "GATE",
  regionCode: "US-CA",
  publishedAt: new Date("2025-11-01T00:00:00Z"),
  agreementPrimaryId: "90000000-0000-4000-8000-000000000009",
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  ...overrides,
});

const createDeps = () => {
  const events = {
    getById: vi.fn(),
  };

  const authz = {
    getOrgMembership: vi.fn(),
  };

  const eventApplications = {
    createSubmission: vi.fn(),
    // Default: no form configured → empty snapshot, no required questions.
    getForm: vi.fn().mockResolvedValue(null),
    listQuestions: vi.fn().mockResolvedValue([]),
    // Cap check (maxSubmissions). Default: empty event.
    countSubmissions: vi.fn().mockResolvedValue(0),
    // One-open-application dedupe pre-check. Default: nothing open.
    findOpenSubmission: vi.fn().mockResolvedValue(null),
    updateSubmissionStatus: vi.fn(),
    // No form saved yet → the submit creates the default ATTEND form first
    // (open calls v1: a submission needs a formId). Returns the ATTEND form.
    ensureForm: vi.fn(async () => buildForm()),
  };

  const eventUnlocks = {
    upsert: vi.fn(),
  };

  const audit = {
    log: vi.fn(),
  };

  // Auto-approve runs create + approve in one tx; the tx-scoped repos are
  // the same fakes so assertions see every call.
  const txRepos = { events, authz, eventApplications, eventUnlocks, audit };
  const tx = vi.fn(
    async (fn: (repos: typeof txRepos) => Promise<unknown>) => fn(txRepos),
  );

  const repos = { events, authz, eventApplications, tx } as unknown as Pick<
    Repos,
    "events" | "authz" | "eventApplications" | "tx"
  >;

  const clock: ClockPort = {
    now: vi.fn(() => NOW),
  };

  const info = vi.fn();
  const logger: LoggerPort = {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as LoggerPort;

  return {
    repos,
    events,
    authz,
    eventApplications,
    eventUnlocks,
    audit,
    tx,
    clock,
    logger,
    info,
  };
};

const FORM_ID = "b0000000-0000-4000-8000-00000000000b";

const buildForm = (overrides: Record<string, unknown> = {}) => ({
  id: FORM_ID,
  eventId: EVENT_ID,
  introText: null,
  defaults: {
    includeName: false,
    includeReason: false,
    includeSocialLinks: false,
  },
  opensAt: null,
  closesAt: null,
  maxSubmissions: null,
  autoApprove: false,
  updatedByHumanId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

type QuestionOverrides = {
  id: string;
  type: "SHORT_TEXT" | "LONG_TEXT" | "SINGLE_CHOICE" | "MULTI_CHOICE";
  label?: string;
  options?: unknown;
  isRequired?: boolean;
  order?: number;
};

const buildQuestion = (overrides: QuestionOverrides) => ({
  formId: FORM_ID,
  label: "Question",
  description: null,
  options: null,
  isRequired: false,
  order: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const buildSubmissionRecord = (
  overrides: Record<string, unknown> = {},
) => ({
  id: SUBMISSION_ID,
  formId: FORM_ID,
  purpose: "ATTEND",
  eventId: EVENT_ID,
  humanId: null,
  contactEmail: "guest@example.com",
  contactPhone: null,
  status: "PENDING",
  answers: {},
  decisionReason: null,
  questionsSnapshot: {},
  reviewerHumanId: null,
  reviewedAt: null,
  approvalToken: null,
  tokenExpiresAt: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("submitEventApplication", () => {
  let repos: Pick<Repos, "events" | "authz" | "eventApplications" | "tx">;
  let events: { getById: ReturnType<typeof vi.fn> };
  let authz: { getOrgMembership: ReturnType<typeof vi.fn> };
  let eventApplications: ReturnType<typeof createDeps>["eventApplications"];
  let eventUnlocks: ReturnType<typeof createDeps>["eventUnlocks"];
  let audit: ReturnType<typeof createDeps>["audit"];
  let clock: ClockPort;
  let logger: LoggerPort;
  let loggerInfo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({
      repos,
      events,
      authz,
      eventApplications,
      eventUnlocks,
      audit,
      clock,
      logger,
      info: loggerInfo,
    } = createDeps());
  });

  it("creates submission when viewer cannot bypass", async () => {
    const event = buildEvent();
    events.getById.mockResolvedValue(event);
    authz.getOrgMembership.mockResolvedValue(null);

    eventApplications.createSubmission.mockResolvedValue({
      id: SUBMISSION_ID,
      eventId: EVENT_ID,
      humanId: null,
      contactEmail: "guest@example.com",
      contactPhone: null,
      status: "PENDING",
      answers: { q1: "hello" },
      reviewerHumanId: null,
      reviewedAt: null,
      approvalToken: null,
      tokenExpiresAt: null,
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await submitEventApplication(
      { repos, clock, logger },
      {
        eventId: EVENT_ID,
        viewerHumanId: null,
        contactEmail: "guest@example.com",
        answers: { q1: "hello" },
      },
    );

    // No form saved: the default ATTEND form is created first, and the
    // submission lands on it.
    expect(eventApplications.ensureForm).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      purpose: "ATTEND",
    });
    expect(eventApplications.createSubmission).toHaveBeenCalledWith({
      formId: FORM_ID,
      eventId: EVENT_ID,
      humanId: null,
      contactEmail: "guest@example.com",
      contactPhone: null,
      answers: { q1: "hello" },
      questionsSnapshot: {},
      submittedAt: NOW,
    });
    expect(result).toEqual({
      eventId: EVENT_ID,
      submissionId: SUBMISSION_ID,
      status: "PENDING",
      bypassed: false,
    });
    expect(loggerInfo).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({
        action: "application_submitted",
        result: "success",
      }),
    );
  });

  it("bypasses submission when viewer can edit event", async () => {
    const event = buildEvent();
    events.getById.mockResolvedValue(event);
    authz.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
      role: "ADMIN",
    } satisfies OrgMembership);

    const result = await submitEventApplication(
      { repos, clock, logger },
      {
        eventId: EVENT_ID,
        viewerHumanId: HUMAN_ID,
        answers: {},
      },
    );

    expect(result).toEqual({
      eventId: EVENT_ID,
      submissionId: null,
      status: null,
      bypassed: true,
    });
    expect(eventApplications.createSubmission).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({ result: "bypassed" }),
    );
  });

  it("throws when event is not application gated", async () => {
    const event = buildEvent({ gateType: "PASSWORD" });
    events.getById.mockResolvedValue(event);
    authz.getOrgMembership.mockResolvedValue(null);

    await expect(
      submitEventApplication(
        { repos, clock, logger },
        { eventId: EVENT_ID, viewerHumanId: OTHER_HUMAN_ID, answers: {} },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_APPLICATION_GATED" });
  });

  it("throws when event cannot be found", async () => {
    events.getById.mockResolvedValue(null);

    await expect(
      submitEventApplication(
        { repos, clock, logger },
        { eventId: EVENT_ID, viewerHumanId: OTHER_HUMAN_ID, answers: {} },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  describe("answers sanitization + bounds", () => {
    it("strips HTML and control/bidi characters from string answer values", async () => {
      const event = buildEvent();
      events.getById.mockResolvedValue(event);
      authz.getOrgMembership.mockResolvedValue(null);
      eventApplications.createSubmission.mockResolvedValue({
        id: SUBMISSION_ID,
        eventId: EVENT_ID,
        humanId: null,
        contactEmail: "guest@example.com",
        contactPhone: null,
        status: "PENDING",
        answers: {},
        reviewerHumanId: null,
        reviewedAt: null,
        approvalToken: null,
        tokenExpiresAt: null,
        metadata: {},
        createdAt: NOW,
        updatedAt: NOW,
      });

      await submitEventApplication(
        { repos, clock, logger },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: {
            q1: '<img src=x onerror=alert(1)>hello',
            // multi-choice answers may be string[] — sanitize elements too.
            q2: ["<b>rock</b>", "roll"],
            // non-string scalars must pass through untouched.
            q3: 42,
            q4: true,
          },
        },
      );

      expect(eventApplications.createSubmission).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: {
            q1: "hello",
            q2: ["rock", "roll"],
            q3: 42,
            q4: true,
          },
        }),
      );
    });

    it("rejects payloads with too many answer keys", async () => {
      const tooManyAnswers = Object.fromEntries(
        Array.from({ length: 51 }, (_, i) => [`q${i}`, "x"]),
      );

      await expect(
        submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            viewerHumanId: null,
            contactEmail: "guest@example.com",
            answers: tooManyAnswers,
          },
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(eventApplications.createSubmission).not.toHaveBeenCalled();
    });

    it("rejects payloads whose serialized answers exceed the size cap", async () => {
      const bigAnswer = "x".repeat(21_000);

      await expect(
        submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            viewerHumanId: null,
            contactEmail: "guest@example.com",
            answers: { q1: bigAnswer },
          },
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(eventApplications.createSubmission).not.toHaveBeenCalled();
    });

    it("rejects answer keys longer than 200 characters", async () => {
      const longKey = "q".repeat(201);

      await expect(
        submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            viewerHumanId: null,
            contactEmail: "guest@example.com",
            answers: { [longKey]: "hello" },
          },
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(eventApplications.createSubmission).not.toHaveBeenCalled();
    });
  });

  describe("questionsSnapshot (spec D3)", () => {
    it("snapshots the form's questions at submit time — options only for choice types", async () => {
      const event = buildEvent();
      events.getById.mockResolvedValue(event);
      authz.getOrgMembership.mockResolvedValue(null);
      eventApplications.getForm.mockResolvedValue(buildForm());
      eventApplications.listQuestions.mockResolvedValue([
        buildQuestion({
          id: "q-text",
          type: "SHORT_TEXT",
          label: "Act name",
          order: 0,
        }),
        buildQuestion({
          id: "q-single",
          type: "SINGLE_CHOICE",
          label: "Set length",
          order: 1,
          options: [
            { id: "opt-1", label: "15 min" },
            { id: "opt-2", label: "30 min" },
          ],
        }),
        buildQuestion({
          id: "q-multi",
          type: "MULTI_CHOICE",
          label: "Booth needs",
          order: 2,
          options: [{ id: "opt-1", label: "Power" }],
        }),
      ]);
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );

      await submitEventApplication(
        { repos, clock, logger },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: { "q-text": "The Ramblers" },
        },
      );

      // Each entry carries the question's `order` — Postgres jsonb sorts
      // object keys bytewise, so snapshot KEY order does not survive
      // persistence; the queue ranks by this value.
      expect(eventApplications.createSubmission).toHaveBeenCalledWith(
        expect.objectContaining({
          questionsSnapshot: {
            "q-text": { label: "Act name", type: "SHORT_TEXT", order: 0 },
            "q-single": {
              label: "Set length",
              type: "SINGLE_CHOICE",
              options: [
                { id: "opt-1", label: "15 min" },
                { id: "opt-2", label: "30 min" },
              ],
              order: 1,
            },
            "q-multi": {
              label: "Booth needs",
              type: "MULTI_CHOICE",
              options: [{ id: "opt-1", label: "Power" }],
              order: 2,
            },
          },
        }),
      );
    });

    it("normalizes legacy-shaped question options into canonical {id,label} snapshot entries", async () => {
      // A legacy question row can carry options as plain strings, numbers or
      // builder-shape {value,label?} objects. Copied verbatim, those poison
      // the snapshot and permanently fail the strict record-schema parse on
      // every queue list / review for the event — so the writer normalizes.
      const event = buildEvent();
      events.getById.mockResolvedValue(event);
      authz.getOrgMembership.mockResolvedValue(null);
      eventApplications.getForm.mockResolvedValue(buildForm());
      eventApplications.listQuestions.mockResolvedValue([
        buildQuestion({
          id: "q-strings",
          type: "SINGLE_CHOICE",
          label: "Set length",
          options: ["15 min", 30, "  "],
        }),
        buildQuestion({
          id: "q-builder",
          type: "MULTI_CHOICE",
          label: "Booth needs",
          options: [{ value: "Power" }, { value: "Tent", label: "Tent space" }],
        }),
      ]);
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );

      await submitEventApplication(
        { repos, clock, logger },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: { "q-strings": "15 min", "q-builder": ["Power"] },
        },
      );

      expect(eventApplications.createSubmission).toHaveBeenCalledWith(
        expect.objectContaining({
          questionsSnapshot: {
            "q-strings": {
              label: "Set length",
              type: "SINGLE_CHOICE",
              options: [
                { id: "opt-1", label: "15 min" },
                { id: "opt-2", label: "30" },
              ],
              order: 0,
            },
            "q-builder": {
              label: "Booth needs",
              type: "MULTI_CHOICE",
              options: [
                { id: "opt-1", label: "Power" },
                { id: "opt-2", label: "Tent space" },
              ],
              order: 0,
            },
          },
        }),
      );
    });

    it("writes an empty snapshot when the event has no form", async () => {
      const event = buildEvent();
      events.getById.mockResolvedValue(event);
      authz.getOrgMembership.mockResolvedValue(null);
      eventApplications.getForm.mockResolvedValue(null);
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );

      await submitEventApplication(
        { repos, clock, logger },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      expect(eventApplications.listQuestions).not.toHaveBeenCalled();
      expect(eventApplications.createSubmission).toHaveBeenCalledWith(
        expect.objectContaining({ questionsSnapshot: {} }),
      );
    });
  });

  describe("required-answer enforcement", () => {
    const setupForm = (questions: unknown[]) => {
      const event = buildEvent();
      events.getById.mockResolvedValue(event);
      authz.getOrgMembership.mockResolvedValue(null);
      eventApplications.getForm.mockResolvedValue(buildForm());
      eventApplications.listQuestions.mockResolvedValue(questions);
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );
    };

    it("rejects empty answers against an all-required form", async () => {
      setupForm([
        buildQuestion({
          id: "q-req",
          type: "SHORT_TEXT",
          label: "Act name",
          isRequired: true,
        }),
      ]);

      await expect(
        submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            viewerHumanId: null,
            contactEmail: "guest@example.com",
            answers: {},
          },
        ),
      ).rejects.toMatchObject({ code: "APPLICATION_ANSWERS_INCOMPLETE" });
      expect(eventApplications.createSubmission).not.toHaveBeenCalled();
    });

    it("rejects whitespace-only answers to required text questions", async () => {
      setupForm([
        buildQuestion({
          id: "q-req",
          type: "LONG_TEXT",
          label: "Tell us about your act",
          isRequired: true,
        }),
      ]);

      await expect(
        submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            viewerHumanId: null,
            contactEmail: "guest@example.com",
            answers: { "q-req": "   " },
          },
        ),
      ).rejects.toMatchObject({ code: "APPLICATION_ANSWERS_INCOMPLETE" });
    });

    it("rejects an empty array for a required multi-choice question", async () => {
      setupForm([
        buildQuestion({
          id: "q-multi",
          type: "MULTI_CHOICE",
          label: "Booth needs",
          isRequired: true,
          options: [{ id: "opt-1", label: "Power" }],
        }),
      ]);

      await expect(
        submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            viewerHumanId: null,
            contactEmail: "guest@example.com",
            answers: { "q-multi": [] },
          },
        ),
      ).rejects.toMatchObject({ code: "APPLICATION_ANSWERS_INCOMPLETE" });
    });

    it("does NOT block on a required choice question with zero valid options (gate parity)", async () => {
      // The client renders nothing for an option-less choice question and
      // deliberately doesn't gate on it — the server must agree, or the
      // applicant hits an unfixable rejection.
      setupForm([
        buildQuestion({
          id: "q-unanswerable",
          type: "SINGLE_CHOICE",
          label: "Set length",
          isRequired: true,
          options: [], // zero entries
        }),
        buildQuestion({
          id: "q-blank-options",
          type: "MULTI_CHOICE",
          label: "Booth needs",
          isRequired: true,
          options: ["   ", { value: "" }, { label: " " }],
        }),
      ]);

      const result = await submitEventApplication(
        { repos, clock, logger },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      expect(result.submissionId).toBe(SUBMISSION_ID);
      expect(eventApplications.createSubmission).toHaveBeenCalled();
    });

    it("passes when optional questions are unanswered and required ones are answered", async () => {
      setupForm([
        buildQuestion({
          id: "q-req",
          type: "SHORT_TEXT",
          label: "Act name",
          isRequired: true,
        }),
        buildQuestion({
          id: "q-opt",
          type: "LONG_TEXT",
          label: "Anything else?",
          isRequired: false,
        }),
        buildQuestion({
          id: "q-single",
          type: "SINGLE_CHOICE",
          label: "Set length",
          isRequired: true,
          options: [{ id: "opt-1", label: "15 min" }],
        }),
      ]);

      const result = await submitEventApplication(
        { repos, clock, logger },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: { "q-req": "The Ramblers", "q-single": "15 min" },
        },
      );

      expect(result.submissionId).toBe(SUBMISSION_ID);
    });

    it("ignores answers for question ids that no longer exist", async () => {
      setupForm([
        buildQuestion({
          id: "q-req",
          type: "SHORT_TEXT",
          label: "Act name",
          isRequired: true,
        }),
      ]);

      const result = await submitEventApplication(
        { repos, clock, logger },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: { "q-req": "The Ramblers", "q-deleted": "stale" },
        },
      );

      expect(result.submissionId).toBe(SUBMISSION_ID);
    });
  });

  describe("turnstile (anonymous-only)", () => {
    const makeTurnstile = (opts: { enabled: boolean; valid?: boolean }) => ({
      enabled: opts.enabled,
      verify: vi.fn(async () => opts.valid ?? true),
    });

    beforeEach(() => {
      const event = buildEvent();
      events.getById.mockResolvedValue(event);
      authz.getOrgMembership.mockResolvedValue(null);
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );
    });

    it("requires a token for anonymous submitters when enabled", async () => {
      const turnstile = makeTurnstile({ enabled: true });

      await expect(
        submitEventApplication(
          { repos, clock, logger, turnstile },
          {
            eventId: EVENT_ID,
            viewerHumanId: null,
            contactEmail: "guest@example.com",
            answers: {},
          },
        ),
      ).rejects.toMatchObject({ code: "TURNSTILE_TOKEN_REQUIRED" });
      expect(eventApplications.createSubmission).not.toHaveBeenCalled();
    });

    it("rejects when verification fails", async () => {
      const turnstile = makeTurnstile({ enabled: true, valid: false });

      await expect(
        submitEventApplication(
          { repos, clock, logger, turnstile },
          {
            eventId: EVENT_ID,
            viewerHumanId: null,
            contactEmail: "guest@example.com",
            answers: {},
            turnstileToken: "tok_bad",
            requestIp: "203.0.113.9",
          },
        ),
      ).rejects.toMatchObject({ code: "TURNSTILE_VERIFICATION_FAILED" });
      expect(turnstile.verify).toHaveBeenCalledWith(
        "tok_bad",
        "203.0.113.9",
      );
      expect(eventApplications.createSubmission).not.toHaveBeenCalled();
    });

    it("accepts a valid token for anonymous submitters", async () => {
      const turnstile = makeTurnstile({ enabled: true, valid: true });

      const result = await submitEventApplication(
        { repos, clock, logger, turnstile },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: {},
          turnstileToken: "tok_good",
        },
      );

      expect(result.submissionId).toBe(SUBMISSION_ID);
      expect(turnstile.verify).toHaveBeenCalledTimes(1);
    });

    it("skips turnstile entirely for signed-in submitters", async () => {
      const turnstile = makeTurnstile({ enabled: true });

      const result = await submitEventApplication(
        { repos, clock, logger, turnstile },
        {
          eventId: EVENT_ID,
          viewerHumanId: OTHER_HUMAN_ID,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      expect(result.submissionId).toBe(SUBMISSION_ID);
      expect(turnstile.verify).not.toHaveBeenCalled();
    });

    it("skips turnstile when the adapter is disabled", async () => {
      const turnstile = makeTurnstile({ enabled: false });

      const result = await submitEventApplication(
        { repos, clock, logger, turnstile },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      expect(result.submissionId).toBe(SUBMISSION_ID);
      expect(turnstile.verify).not.toHaveBeenCalled();
    });
  });

  describe("notification fan-out", () => {
    beforeEach(() => {
      const event = buildEvent();
      events.getById.mockResolvedValue(event);
      authz.getOrgMembership.mockResolvedValue(null);
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );
    });

    it("invokes the notify hook with the event and created submission", async () => {
      const notifyApplicationReceived = vi.fn(async () => undefined);

      await submitEventApplication(
        { repos, clock, logger, notifyApplicationReceived },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      expect(notifyApplicationReceived).toHaveBeenCalledTimes(1);
      expect(notifyApplicationReceived).toHaveBeenCalledWith({
        event: expect.objectContaining({ id: EVENT_ID }),
        submission: expect.objectContaining({ id: SUBMISSION_ID }),
      });
    });

    it("swallows a throwing notify hook and reports it (reporter regression)", async () => {
      const notifyError = new Error("notify boom");
      const notifyApplicationReceived = vi.fn(async () => {
        throw notifyError;
      });
      const reportError = vi.fn();

      const result = await submitEventApplication(
        { repos, clock, logger, notifyApplicationReceived, reportError },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      // Submission still succeeds — the swallow must never fail the commit.
      expect(result.submissionId).toBe(SUBMISSION_ID);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(notifyError, {
        tags: { useCase: "submitEventApplication" },
        extra: { submissionId: SUBMISSION_ID, eventId: EVENT_ID },
      });
    });

    it("a throwing reporter never fails the submission", async () => {
      const notifyApplicationReceived = vi.fn(async () => {
        throw new Error("notify boom");
      });
      const reportError = vi.fn(() => {
        throw new Error("reporter boom");
      });

      const result = await submitEventApplication(
        { repos, clock, logger, notifyApplicationReceived, reportError },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      expect(result.submissionId).toBe(SUBMISSION_ID);
    });
  });

  describe("application window (spec Phase 2)", () => {
    const submit = () =>
      submitEventApplication(
        { repos, clock, logger },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

    beforeEach(() => {
      events.getById.mockResolvedValue(buildEvent());
      authz.getOrgMembership.mockResolvedValue(null);
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );
    });

    it("rejects before opensAt", async () => {
      eventApplications.getForm.mockResolvedValue(
        buildForm({ opensAt: new Date(NOW.getTime() + 1) }),
      );

      await expect(submit()).rejects.toMatchObject({
        code: "APPLICATION_WINDOW_NOT_OPEN",
      });
      expect(eventApplications.createSubmission).not.toHaveBeenCalled();
    });

    it("allows exactly AT opensAt (boundary is open)", async () => {
      eventApplications.getForm.mockResolvedValue(
        buildForm({ opensAt: new Date(NOW.getTime()) }),
      );

      const result = await submit();
      expect(result.submissionId).toBe(SUBMISSION_ID);
    });

    it("rejects after closesAt", async () => {
      eventApplications.getForm.mockResolvedValue(
        buildForm({ closesAt: new Date(NOW.getTime() - 1) }),
      );

      await expect(submit()).rejects.toMatchObject({
        code: "APPLICATION_WINDOW_CLOSED",
      });
      expect(eventApplications.createSubmission).not.toHaveBeenCalled();
    });

    it("allows exactly AT closesAt (boundary is open)", async () => {
      eventApplications.getForm.mockResolvedValue(
        buildForm({ closesAt: new Date(NOW.getTime()) }),
      );

      const result = await submit();
      expect(result.submissionId).toBe(SUBMISSION_ID);
    });

    it("allows inside an explicit open window", async () => {
      eventApplications.getForm.mockResolvedValue(
        buildForm({
          opensAt: new Date(NOW.getTime() - 60_000),
          closesAt: new Date(NOW.getTime() + 60_000),
        }),
      );

      const result = await submit();
      expect(result.submissionId).toBe(SUBMISSION_ID);
    });
  });

  describe("maxSubmissions cap (spec Phase 2)", () => {
    const submit = () =>
      submitEventApplication(
        { repos, clock, logger },
        {
          eventId: EVENT_ID,
          viewerHumanId: null,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

    beforeEach(() => {
      events.getById.mockResolvedValue(buildEvent());
      authz.getOrgMembership.mockResolvedValue(null);
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );
      eventApplications.getForm.mockResolvedValue(
        buildForm({ maxSubmissions: 2 }),
      );
    });

    it("counts only non-WITHDRAWN/non-EXPIRED submissions (dedicated count, no list)", async () => {
      eventApplications.countSubmissions.mockResolvedValue(1);

      const result = await submit();

      expect(eventApplications.countSubmissions).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        purpose: "ATTEND",
        statuses: ["PENDING", "APPROVED", "REJECTED", "WAITLISTED"],
        excludeInvited: true,
      });
      expect(result.submissionId).toBe(SUBMISSION_ID);
    });

    it("rejects when the counted submissions reach the cap", async () => {
      eventApplications.countSubmissions.mockResolvedValue(2);

      await expect(submit()).rejects.toMatchObject({
        code: "APPLICATION_CAP_REACHED",
      });
      expect(eventApplications.createSubmission).not.toHaveBeenCalled();
    });

    it("rejects when the count exceeds the cap", async () => {
      eventApplications.countSubmissions.mockResolvedValue(3);

      await expect(submit()).rejects.toMatchObject({
        code: "APPLICATION_CAP_REACHED",
      });
    });

    it("skips the count entirely when the form is uncapped", async () => {
      eventApplications.getForm.mockResolvedValue(
        buildForm({ maxSubmissions: null }),
      );

      await submit();
      expect(eventApplications.countSubmissions).not.toHaveBeenCalled();
    });
  });

  describe("autoApprove (spec Phase 2 'registration with questions')", () => {
    // Claim link lasts 7 days (owner decision 2026-09-30).
    const APPROVED_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

    beforeEach(() => {
      events.getById.mockResolvedValue(buildEvent());
      authz.getOrgMembership.mockResolvedValue(null);
      eventApplications.getForm.mockResolvedValue(
        buildForm({ autoApprove: true }),
      );
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord({ humanId: OTHER_HUMAN_ID }),
      );
      eventApplications.updateSubmissionStatus.mockImplementation(
        async (input: Record<string, unknown>) =>
          buildSubmissionRecord({
            humanId: OTHER_HUMAN_ID,
            status: input.status,
            reviewerHumanId: input.reviewerHumanId ?? null,
            reviewedAt: input.reviewedAt ?? null,
            approvalToken: input.approvalToken ?? null,
            tokenExpiresAt: input.tokenExpiresAt ?? null,
          }),
      );
    });

    it("creates the submission APPROVED with reviewer null, unlock and token — all in one tx", async () => {
      const notify = vi.fn(async () => ({ ok: true }));

      const result = await submitEventApplication(
        { repos, clock, logger, notify: notify as never },
        {
          eventId: EVENT_ID,
          viewerHumanId: OTHER_HUMAN_ID,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      expect(eventApplications.updateSubmissionStatus).toHaveBeenCalledWith({
        submissionId: SUBMISSION_ID,
        status: "APPROVED",
        reviewerHumanId: null,
        reviewedAt: NOW,
        approvalToken: expect.any(String),
        tokenExpiresAt: new Date(NOW.getTime() + APPROVED_TOKEN_TTL_MS),
        decisionReason: null,
      });
      expect(eventUnlocks.upsert).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        humanId: OTHER_HUMAN_ID,
        source: "APPLICATION",
        applicationSubmissionId: SUBMISSION_ID,
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "event_application_auto_approved",
        }),
      );
      expect(result.status).toBe("APPROVED");
      expect(loggerInfo).toHaveBeenCalledWith(
        "event_gate",
        expect.objectContaining({
          metadata: expect.objectContaining({ autoApproved: true }),
        }),
      );
    });

    it("sends the APPROVAL notification once, keyed on this approval instance", async () => {
      const notify = vi.fn(async () => ({ ok: true }));

      await submitEventApplication(
        { repos, clock, logger, notify: notify as never },
        {
          eventId: EVENT_ID,
          viewerHumanId: OTHER_HUMAN_ID,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      // Same code path + idempotency key shape as the review flow's
      // approval: one key per approval instance (submission id + a hash of
      // the token — never the bearer token itself).
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: OTHER_HUMAN_ID,
          variant: "event.application-approved",
          idempotencyKey: expect.stringMatching(
            new RegExp(`^application-approved:${SUBMISSION_ID}:[0-9a-f]{16}$`),
          ),
        }),
      );
      const minted = (
        eventApplications.updateSubmissionStatus.mock.calls[0]![0] as {
          approvalToken: string;
        }
      ).approvalToken;
      const sentKey = (
        notify.mock.calls[0] as unknown as [{ idempotencyKey: string }]
      )[0].idempotencyKey;
      expect(sentKey).not.toContain(minted);
    });

    it("suppresses the received-ack leg but keeps the organizer notify (never both applicant emails)", async () => {
      const notify = vi.fn(async () => ({ ok: true }));
      const notifyApplicationReceived = vi.fn(async () => undefined);

      await submitEventApplication(
        {
          repos,
          clock,
          logger,
          notify: notify as never,
          notifyApplicationReceived,
        },
        {
          eventId: EVENT_ID,
          viewerHumanId: OTHER_HUMAN_ID,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      expect(notifyApplicationReceived).toHaveBeenCalledTimes(1);
      // Ack suppressed AND organizer leg email-muted — a high-volume
      // registration event must not email organizers per registrant.
      expect(notifyApplicationReceived).toHaveBeenCalledWith(
        expect.objectContaining({
          applicantAck: false,
          muteOrganizerEmail: true,
        }),
      );
    });

    it("does NOT auto-approve when the flag is off", async () => {
      eventApplications.getForm.mockResolvedValue(
        buildForm({ autoApprove: false }),
      );
      const notify = vi.fn(async () => ({ ok: true }));
      const notifyApplicationReceived = vi.fn(async () => undefined);

      const result = await submitEventApplication(
        {
          repos,
          clock,
          logger,
          notify: notify as never,
          notifyApplicationReceived,
        },
        {
          eventId: EVENT_ID,
          viewerHumanId: OTHER_HUMAN_ID,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      expect(result.status).toBe("PENDING");
      expect(eventApplications.updateSubmissionStatus).not.toHaveBeenCalled();
      expect(eventUnlocks.upsert).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      // Normal path: the ack leg stays ON (no applicantAck override).
      expect(notifyApplicationReceived).toHaveBeenCalledWith(
        expect.not.objectContaining({ applicantAck: false }),
      );
    });
  });

  // ── One OPEN application per applicant (spec Phase 3 item 2 / D5) ────────
  describe("one-open-application dedupe", () => {
    const setUpOpenEvent = () => {
      const event = buildEvent();
      events.getById.mockResolvedValue(event);
      authz.getOrgMembership.mockResolvedValue(null);
      // An open submission can only exist on a saved form, so the dedupe
      // suite runs against an event whose ATTEND form exists.
      eventApplications.getForm.mockResolvedValue(buildForm());
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );
      return event;
    };

    it("does NOT create a second open submission for the same guest email", async () => {
      setUpOpenEvent();
      eventApplications.findOpenSubmission.mockResolvedValue(
        buildSubmissionRecord({ status: "PENDING" }),
      );

      const result = await submitEventApplication(
        { repos, clock, logger },
        {
          eventId: EVENT_ID,
          contactEmail: "guest@example.com",
          answers: {},
        },
      );

      expect(eventApplications.findOpenSubmission).toHaveBeenCalledWith({
        formId: FORM_ID,
        contactEmail: "guest@example.com",
      });
      expect(eventApplications.createSubmission).not.toHaveBeenCalled();
      // …and it does NOT throw — see the enumeration-split suite below.
      expect(result.eventId).toBe(EVENT_ID);
    });

    it("dedupes guests on the LOWERCASED email (Ada@Example.COM === ada@example.com)", async () => {
      setUpOpenEvent();
      eventApplications.findOpenSubmission.mockResolvedValue(null);

      await submitEventApplication(
        { repos, clock, logger },
        {
          eventId: EVENT_ID,
          contactEmail: "  Ada@Example.COM ",
          answers: {},
        },
      );

      // Both the dedupe lookup AND the stored column are lowercased — the
      // partial unique index matches on lower(contactEmail).
      expect(eventApplications.findOpenSubmission).toHaveBeenCalledWith({
        formId: FORM_ID,
        contactEmail: "ada@example.com",
      });
      expect(eventApplications.createSubmission).toHaveBeenCalledWith(
        expect.objectContaining({ contactEmail: "ada@example.com" }),
      );
    });

    it.each(["WITHDRAWN", "REJECTED", "EXPIRED"] as const)(
      "allows re-application after a %s submission (repo reports nothing open)",
      async (_status) => {
        setUpOpenEvent();
        // The repo's OPEN set is (PENDING | APPROVED | WAITLISTED), so a
        // withdrawn / rejected / expired row simply isn't returned.
        eventApplications.findOpenSubmission.mockResolvedValue(null);

        const result = await submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            contactEmail: "guest@example.com",
            answers: {},
          },
        );

        expect(result.submissionId).toBe(SUBMISSION_ID);
        expect(eventApplications.createSubmission).toHaveBeenCalledTimes(1);
      },
    );

    it("rejects an AUTHED applicant's second open submission, keyed on humanId", async () => {
      setUpOpenEvent();
      eventApplications.findOpenSubmission.mockResolvedValue(
        buildSubmissionRecord({ humanId: HUMAN_ID, status: "APPROVED" }),
      );

      await expect(
        submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            viewerHumanId: OTHER_HUMAN_ID,
            answers: {},
          },
        ),
      ).rejects.toMatchObject({ code: "APPLICATION_ALREADY_SUBMITTED" });

      // Signed-in applicants dedupe on identity, never on a supplied email —
      // otherwise two accounts sharing a contact address would collide.
      expect(eventApplications.findOpenSubmission).toHaveBeenCalledWith({
        formId: FORM_ID,
        humanId: OTHER_HUMAN_ID,
      });
    });

    it("surfaces the AUTHED race loser (P2002 -> duplicate_open_application) as the typed error", async () => {
      setUpOpenEvent();
      eventApplications.findOpenSubmission.mockResolvedValue(null);
      eventApplications.createSubmission.mockRejectedValue({
        code: "duplicate_open_application",
        message: "duplicate_open_application",
      });

      await expect(
        submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            viewerHumanId: OTHER_HUMAN_ID,
            answers: {},
          },
        ),
      ).rejects.toMatchObject({ code: "APPLICATION_ALREADY_SUBMITTED" });
    });

    it("maps the race loser on the AUTO-APPROVE transaction path too", async () => {
      setUpOpenEvent();
      eventApplications.getForm.mockResolvedValue(
        buildForm({ autoApprove: true }),
      );
      eventApplications.findOpenSubmission.mockResolvedValue(null);
      eventApplications.createSubmission.mockRejectedValue({
        code: "duplicate_open_application",
        message: "duplicate_open_application",
      });

      await expect(
        submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            viewerHumanId: OTHER_HUMAN_ID,
            answers: {},
          },
        ),
      ).rejects.toMatchObject({ code: "APPLICATION_ALREADY_SUBMITTED" });
      expect(eventUnlocks.upsert).not.toHaveBeenCalled();
    });

    it("never dedupes an organizer who bypasses the gate", async () => {
      const event = buildEvent();
      events.getById.mockResolvedValue(event);
      authz.getOrgMembership.mockResolvedValue({
        orgId: ORG_ID,
        humanId: HUMAN_ID,
        role: "OWNER",
      } as OrgMembership);

      const result = await submitEventApplication(
        { repos, clock, logger },
        { eventId: EVENT_ID, viewerHumanId: HUMAN_ID, answers: {} },
      );

      expect(result.bypassed).toBe(true);
      expect(eventApplications.findOpenSubmission).not.toHaveBeenCalled();
    });

    it("rejects a GUEST with no contactEmail at the boundary (email is the only guest identity)", async () => {
      setUpOpenEvent();

      await expect(
        submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            // Phone-only: undeliverable AND it would slip the partial unique
            // index, whose entries over NULL are all distinct.
            contactPhone: "+15555550123",
            answers: {},
          },
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expect(eventApplications.createSubmission).not.toHaveBeenCalled();
    });
  });


  // ── Event status gate (only PUBLISHED accepts applications) ─────────────
  describe("event status", () => {
    it.each(["DRAFT", "CANCELLED", "COMPLETED", "ARCHIVED"] as const)(
      "refuses a %s event with EVENT_NOT_FOUND, before any write or notification",
      async (status) => {
        events.getById.mockResolvedValue(buildEvent({ status }));
        authz.getOrgMembership.mockResolvedValue(null);
        const notifyApplicationReceived = vi.fn();

        await expect(
          submitEventApplication(
            { repos, clock, logger, notifyApplicationReceived },
            {
              eventId: EVENT_ID,
              contactEmail: "guest@example.com",
              answers: {},
            },
          ),
        ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });

        // The bug this closes: the row + the organizer fan-out both happened.
        expect(eventApplications.createSubmission).not.toHaveBeenCalled();
        expect(notifyApplicationReceived).not.toHaveBeenCalled();
      },
    );

    it("still lets an ORGANIZER bypass a DRAFT event (status check sits after the bypass)", async () => {
      events.getById.mockResolvedValue(buildEvent({ status: "DRAFT" }));
      authz.getOrgMembership.mockResolvedValue({
        orgId: ORG_ID,
        humanId: HUMAN_ID,
        role: "OWNER",
      } as OrgMembership);

      const result = await submitEventApplication(
        { repos, clock, logger },
        { eventId: EVENT_ID, viewerHumanId: HUMAN_ID, answers: {} },
      );

      expect(result.bypassed).toBe(true);
    });

    it("accepts a PUBLISHED event", async () => {
      events.getById.mockResolvedValue(buildEvent({ status: "PUBLISHED" }));
      authz.getOrgMembership.mockResolvedValue(null);
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );

      const result = await submitEventApplication(
        { repos, clock, logger },
        { eventId: EVENT_ID, contactEmail: "guest@example.com", answers: {} },
      );

      expect(result.submissionId).toBe(SUBMISSION_ID);
    });
  });

  // ── The enumeration split (guest duplicates are INDISTINGUISHABLE) ──────
  //
  // A guest's dedupe key is a SELF-ASSERTED email, so a distinguishable
  // response would let anyone ask "has alice@example.com applied to this
  // event?" and read the answer off the status code. The duplicate response
  // must be byte-identical to a first-time submit, and the real applicant is
  // told out-of-band by email.
  describe("guest duplicate is indistinguishable from a first submit", () => {
    const guestInput = {
      eventId: EVENT_ID,
      contactEmail: "guest@example.com",
      answers: {},
    };

    const setUpEvent = () => {
      events.getById.mockResolvedValue(buildEvent());
      authz.getOrgMembership.mockResolvedValue(null);
      // A duplicate needs a saved ATTEND form to sit on.
      eventApplications.getForm.mockResolvedValue(buildForm());
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );
    };

    it("returns a response BYTE-IDENTICAL to a first-time guest submit", async () => {
      setUpEvent();

      // First-time submit is deliberately made to look like the duplicate
      // shape by the bypass contract: submissionId/status null are legal.
      eventApplications.findOpenSubmission.mockResolvedValue(null);
      eventApplications.createSubmission.mockResolvedValue(
        buildSubmissionRecord(),
      );
      const first = await submitEventApplication(
        { repos, clock, logger },
        guestInput,
      );

      eventApplications.findOpenSubmission.mockResolvedValue(
        buildSubmissionRecord({ status: "PENDING" }),
      );
      const duplicate = await submitEventApplication(
        { repos, clock, logger },
        guestInput,
      );

      // The KEYS must match exactly — a prober diffing the response shape
      // must learn nothing.
      expect(Object.keys(duplicate).sort()).toEqual(Object.keys(first).sort());
      expect(duplicate).toEqual({
        eventId: EVENT_ID,
        submissionId: null,
        status: null,
        bypassed: false,
      });
    });

    it("discloses NOTHING about the existing submission (no id, status or dates)", async () => {
      setUpEvent();
      eventApplications.findOpenSubmission.mockResolvedValue(
        buildSubmissionRecord({
          id: SUBMISSION_ID,
          status: "APPROVED",
        }),
      );

      const result = await submitEventApplication(
        { repos, clock, logger },
        guestInput,
      );

      // Explicitly NOT the "silently return the existing submission"
      // alternative — that upgrades a boolean oracle into data disclosure.
      expect(result.submissionId).toBeNull();
      expect(result.status).toBeNull();
      expect(JSON.stringify(result)).not.toContain(SUBMISSION_ID);
      expect(JSON.stringify(result)).not.toContain("APPROVED");
    });

    it("emails the ADDRESS OWNER instead, with an ignore-this line", async () => {
      setUpEvent();
      eventApplications.findOpenSubmission.mockResolvedValue(
        buildSubmissionRecord({ status: "PENDING" }),
      );
      const mailer = { send: vi.fn().mockResolvedValue(undefined) };

      await submitEventApplication(
        { repos, clock, logger, mailer: mailer as never },
        guestInput,
      );

      expect(mailer.send).toHaveBeenCalledTimes(1);
      const sent = mailer.send.mock.calls[0]![0] as {
        to: { to: string };
        text: string;
        html: string;
      };
      expect(sent.to.to).toBe("guest@example.com");
      expect(sent.text).toContain("already have an application in progress");
      // Someone else can type YOUR address into an anonymous form.
      expect(sent.text).toContain("Didn't apply?");
      expect(sent.html).toContain("Didn't apply?");
    });

    it("strips header-injection characters from the notice subject", async () => {
      setUpEvent();
      events.getById.mockResolvedValue(
        buildEvent({ title: "Gated\r\nBcc: victim@example.com Event" }),
      );
      eventApplications.findOpenSubmission.mockResolvedValue(
        buildSubmissionRecord({ status: "PENDING" }),
      );
      const mailer = { send: vi.fn().mockResolvedValue(undefined) };

      await submitEventApplication(
        { repos, clock, logger, mailer: mailer as never },
        guestInput,
      );

      const sent = mailer.send.mock.calls[0]![0] as { subject: string };
      expect(sent.subject).toBe(
        "You already have an application in progress for Gated Bcc: victim@example.com Event",
      );
      expect(sent.subject).not.toMatch(/[\r\n]/);
    });

    it("stays indistinguishable when the notice email FAILS (no 5xx leak)", async () => {
      setUpEvent();
      eventApplications.findOpenSubmission.mockResolvedValue(
        buildSubmissionRecord({ status: "PENDING" }),
      );
      const mailer = { send: vi.fn().mockRejectedValue(new Error("smtp")) };
      const reportError = vi.fn();

      await expect(
        submitEventApplication(
          { repos, clock, logger, mailer: mailer as never, reportError },
          guestInput,
        ),
      ).resolves.toEqual({
        eventId: EVENT_ID,
        submissionId: null,
        status: null,
        bypassed: false,
      });
      expect(reportError).toHaveBeenCalled();
    });

    it("applies the SAME split to the DB race loser (pre-check and race agree)", async () => {
      setUpEvent();
      eventApplications.findOpenSubmission.mockResolvedValue(null);
      eventApplications.createSubmission.mockRejectedValue({
        code: "duplicate_open_application",
        message: "duplicate_open_application",
      });
      const mailer = { send: vi.fn().mockResolvedValue(undefined) };

      const result = await submitEventApplication(
        { repos, clock, logger, mailer: mailer as never },
        guestInput,
      );

      // If the race threw while the pre-check returned success, the race
      // itself would become the oracle the split exists to close.
      expect(result).toEqual({
        eventId: EVENT_ID,
        submissionId: null,
        status: null,
        bypassed: false,
      });
      expect(mailer.send).toHaveBeenCalledTimes(1);
    });

    it("keeps the AUTHED branch distinguishable (you can only learn about yourself)", async () => {
      setUpEvent();
      eventApplications.findOpenSubmission.mockResolvedValue(
        buildSubmissionRecord({ humanId: OTHER_HUMAN_ID, status: "PENDING" }),
      );

      await expect(
        submitEventApplication(
          { repos, clock, logger },
          {
            eventId: EVENT_ID,
            viewerHumanId: OTHER_HUMAN_ID,
            answers: {},
          },
        ),
      ).rejects.toMatchObject({ code: "APPLICATION_ALREADY_SUBMITTED" });
    });
  });
});
