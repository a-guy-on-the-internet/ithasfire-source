import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";
import type { EventApplicationSubmissionRecord } from "@th/ports/repos/events";
import type { NotifyInput, NotifyOutput } from "../../comms/notify";

import { notifyEventApplicationReceived } from "../notify-event-application-received";

const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const ORG_ID = "50000000-0000-4000-8000-000000000005";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
const APPLICANT_ID = "80000000-0000-4000-8000-000000000008";
const OWNER_ID = "90000000-0000-4000-8000-000000000009";
const ADMIN_ID = "a0000000-0000-4000-8000-00000000000a";
const VIEWER_ID = "b0000000-0000-4000-8000-00000000000b";
const NOW = new Date("2025-12-05T12:00:00Z");
const BASE_URL = "https://app.test";

const baseSubmission: EventApplicationSubmissionRecord = {
  id: SUBMISSION_ID,
  eventId: EVENT_ID,
  humanId: APPLICANT_ID,
  contactEmail: "guest@example.com",
  contactPhone: null,
  status: "PENDING",
  answers: { q1: "hi" },
  decisionReason: null,
  questionsSnapshot: {},
  reviewerHumanId: null,
  reviewedAt: null,
  approvalToken: null,
  tokenExpiresAt: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const orgEvent = {
  id: EVENT_ID,
  title: "Secret show",
  humanId: null,
  orgId: ORG_ID,
};

const humanEvent = {
  id: EVENT_ID,
  title: "Secret show",
  humanId: OWNER_ID,
  orgId: null,
};

function createDeps(
  overrides: {
    members?: Array<{ humanId: string; role: string }>;
    applicantName?: string | null;
    username?: string | null;
    pageSlug?: string | null;
  } = {},
) {
  const members = overrides.members ?? [
    { humanId: OWNER_ID, role: "OWNER" },
    { humanId: ADMIN_ID, role: "ADMIN" },
    { humanId: VIEWER_ID, role: "VIEWER" },
  ];

  const humans = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        name:
          overrides.applicantName === undefined
            ? "Jordan Alvarez"
            : overrides.applicantName,
      })),
    ),
    getByIdWithIdentity: vi.fn(async (id: string) => ({
      id,
      identity: { username: overrides.username ?? null },
    })),
  };

  const organizations = {
    getById: vi.fn(async () => ({ id: ORG_ID, slug: "sunset-collective" })),
    listMembers: vi.fn(async () => ({
      items: members,
      total: members.length,
    })),
  };

  const entityPages = {
    getByOwner: vi.fn(async () =>
      overrides.pageSlug !== undefined && overrides.pageSlug !== null
        ? { slug: overrides.pageSlug }
        : null,
    ),
  };

  const repos = { humans, organizations, entityPages } as unknown as Parameters<
    typeof notifyEventApplicationReceived
  >[0]["repos"];

  const notifyResult = {
    ok: true,
    variant: "event.application-received",
    category: "transactional",
    scope: { kind: "GLOBAL" },
    inApp: { status: "skipped", reason: "channel_disabled" },
  } as unknown as NotifyOutput;
  const notify = vi.fn(async (_input: NotifyInput) => notifyResult);

  const mailerSend = vi.fn(async () => ({ result: { id: "mail-id" } }));
  const mailer = {
    send: mailerSend,
    sendBatch: vi.fn(),
    health: vi.fn(),
  } as unknown as import("@th/ports/comms/mailer").MailerPort;

  const error = vi.fn();
  const logger: LoggerPort = {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error,
  } as unknown as LoggerPort;

  const reportError = vi.fn();

  return {
    repos,
    humans,
    organizations,
    entityPages,
    notify,
    mailer,
    mailerSend,
    logger,
    loggerError: error,
    reportError,
  };
}

type Deps = ReturnType<typeof createDeps>;

const buildDeps = (deps: Deps) => ({
  repos: deps.repos,
  notify: deps.notify,
  mailer: deps.mailer,
  logger: deps.logger,
  reportError: deps.reportError,
  publicAppUrl: BASE_URL,
});

describe("notifyEventApplicationReceived", () => {
  let deps: Deps;

  beforeEach(() => {
    deps = createDeps();
  });

  it("throws when publicAppUrl is missing (caller's swallow reports it)", async () => {
    await expect(
      notifyEventApplicationReceived(
        { ...buildDeps(deps), publicAppUrl: null },
        { event: orgEvent, submission: baseSubmission },
      ),
    ).rejects.toThrow(/publicAppUrl/);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("acks the signed-in applicant and notifies org edit-role members with per-recipient idempotency keys", async () => {
    await notifyEventApplicationReceived(buildDeps(deps), {
      event: orgEvent,
      submission: baseSubmission,
    });

    // Applicant ack.
    expect(deps.notify).toHaveBeenCalledWith({
      humanId: APPLICANT_ID,
      variant: "event.application-received",
      idempotencyKey: `application-received:${SUBMISSION_ID}`,
      payload: {
        eventId: EVENT_ID,
        eventTitle: "Secret show",
        submissionId: SUBMISSION_ID,
        appliedAtIso: NOW.toISOString(),
      },
      scope: { kind: "EVENT", eventId: EVENT_ID },
      channels: { sms: { enabled: false } },
    });

    // Organizer fan-out: OWNER + ADMIN, but never the VIEWER.
    const queueUrl = `${BASE_URL}/admin/sunset-collective/events/${EVENT_ID}/applications`;
    for (const humanId of [OWNER_ID, ADMIN_ID]) {
      expect(deps.notify).toHaveBeenCalledWith({
        humanId,
        variant: "event.application-submission-received",
        idempotencyKey: `application-submission-received:${SUBMISSION_ID}:${humanId}`,
        payload: {
          eventId: EVENT_ID,
          eventTitle: "Secret show",
          submissionId: SUBMISSION_ID,
          applicantName: "Jordan Alvarez",
          queueUrl,
        },
        scope: { kind: "EVENT", eventId: EVENT_ID },
        channels: { sms: { enabled: false } },
      });
    }

    const notifiedIds = deps.notify.mock.calls.map(
      (call) => (call[0] as NotifyInput).humanId,
    );
    expect(notifiedIds).not.toContain(VIEWER_ID);
    // 1 ack + 2 organizers.
    expect(deps.notify).toHaveBeenCalledTimes(3);
  });

  it("notifies the owning human of a personal event via the @username admin slug", async () => {
    deps = createDeps({ username: "jane" });

    await notifyEventApplicationReceived(buildDeps(deps), {
      event: humanEvent,
      submission: baseSubmission,
    });

    expect(deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: OWNER_ID,
        variant: "event.application-submission-received",
        payload: expect.objectContaining({
          queueUrl: `${BASE_URL}/admin/@jane/events/${EVENT_ID}/applications`,
        }),
      }),
    );
  });

  it("keeps notifying remaining recipients when one delivery fails, and reports the failure", async () => {
    const boom = new Error("delivery boom");
    // Call order: applicant ack, then organizers. Fail the FIRST organizer.
    deps.notify
      .mockResolvedValueOnce({} as NotifyOutput)
      .mockRejectedValueOnce(boom);

    await notifyEventApplicationReceived(buildDeps(deps), {
      event: orgEvent,
      submission: baseSubmission,
    });

    // ack + 2 organizer attempts — the second organizer still notified.
    expect(deps.notify).toHaveBeenCalledTimes(3);
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect(deps.reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "notifyEventApplicationReceived" },
      extra: {
        submissionId: SUBMISSION_ID,
        eventId: EVENT_ID,
        humanId: OWNER_ID,
      },
    });
  });

  it("reports (and logs at error) when zero notifiable recipients resolve", async () => {
    deps = createDeps({ members: [{ humanId: VIEWER_ID, role: "VIEWER" }] });

    await notifyEventApplicationReceived(buildDeps(deps), {
      event: orgEvent,
      submission: baseSubmission,
    });

    // Applicant ack still goes out; no organizer notifies.
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.loggerError).toHaveBeenCalledWith(
      "events.notify_application_received.no_recipients",
      expect.objectContaining({ submissionId: SUBMISSION_ID }),
    );
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "event_application_notify_no_recipients",
      }),
      expect.objectContaining({
        tags: { useCase: "notifyEventApplicationReceived" },
      }),
    );
  });

  it("reports a failing applicant ack without sinking the organizer fan-out", async () => {
    const ackError = new Error("ack boom");
    deps.notify.mockRejectedValueOnce(ackError);

    await notifyEventApplicationReceived(buildDeps(deps), {
      event: orgEvent,
      submission: baseSubmission,
    });

    // ack (failed) + 2 organizers.
    expect(deps.notify).toHaveBeenCalledTimes(3);
    expect(deps.reportError).toHaveBeenCalledWith(ackError, {
      tags: {
        useCase: "notifyEventApplicationReceived",
        channel: "applicantAck",
      },
      extra: { submissionId: SUBMISSION_ID, eventId: EVENT_ID },
    });
  });

  it("emails an anonymous applicant's ack directly via the mailer", async () => {
    const anonSubmission = { ...baseSubmission, humanId: null };

    await notifyEventApplicationReceived(buildDeps(deps), {
      event: orgEvent,
      submission: anonSubmission,
    });

    expect(deps.mailerSend).toHaveBeenCalledTimes(1);
    const sent = deps.mailerSend.mock.calls[0]![0] as unknown as {
      to: { to: string };
      subject: string;
      html?: string;
      template: { key: string; variables: Record<string, unknown> };
    };
    expect(sent.to).toEqual({ to: "guest@example.com" });
    expect(sent.subject).toBe("Application sent: Secret show");
    // Branded template, never inline HTML.
    expect(sent.html).toBeUndefined();
    expect(sent.template.key).toBe("event.application_received");
    expect(sent.template.variables).toMatchObject({
      eventTitle: "Secret show",
      isGuest: true,
    });
    // Organizer fan-out still notify()-keyed; applicant leg used no notify.
    const ackCalls = deps.notify.mock.calls.filter(
      (call) =>
        (call[0] as NotifyInput).variant === "event.application-received",
    );
    expect(ackCalls).toHaveLength(0);
  });

  it("falls back to the contact email as the applicant display name when the human has no name", async () => {
    deps = createDeps({ applicantName: null });

    await notifyEventApplicationReceived(buildDeps(deps), {
      event: orgEvent,
      submission: baseSubmission,
    });

    expect(deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "event.application-submission-received",
        payload: expect.objectContaining({
          applicantName: "guest@example.com",
        }),
      }),
    );
  });

  it("skips the applicant ack (but keeps the organizer leg) when applicantAck is false", async () => {
    // Auto-approve path (spec Phase 2): the applicant gets the APPROVAL
    // email via the shared approval pipeline — the received ack would be a
    // duplicate, but organizers must still hear about the new submission.
    await notifyEventApplicationReceived(buildDeps(deps), {
      event: orgEvent,
      submission: baseSubmission,
      applicantAck: false,
    });

    const ackCalls = deps.notify.mock.calls.filter(
      (call) =>
        (call[0] as NotifyInput).variant === "event.application-received",
    );
    expect(ackCalls).toHaveLength(0);
    expect(deps.mailerSend).not.toHaveBeenCalled();

    const organizerCalls = deps.notify.mock.calls.filter(
      (call) =>
        (call[0] as NotifyInput).variant ===
        "event.application-submission-received",
    );
    expect(organizerCalls).toHaveLength(2);
  });

  it("mutes the organizer EMAIL channel (keeping in-app/push) when muteOrganizerEmail is set", async () => {
    await notifyEventApplicationReceived(buildDeps(deps), {
      event: orgEvent,
      submission: baseSubmission,
      applicantAck: false,
      muteOrganizerEmail: true,
    });

    const organizerCalls = deps.notify.mock.calls.filter(
      (call) =>
        (call[0] as NotifyInput).variant ===
        "event.application-submission-received",
    );
    expect(organizerCalls).toHaveLength(2);
    for (const call of organizerCalls) {
      expect((call[0] as NotifyInput).channels).toEqual({
        sms: { enabled: false },
        email: { enabled: false },
      });
    }
  });

  it("leaves the organizer EMAIL channel preference-driven by default", async () => {
    await notifyEventApplicationReceived(buildDeps(deps), {
      event: orgEvent,
      submission: baseSubmission,
    });

    const organizerCalls = deps.notify.mock.calls.filter(
      (call) =>
        (call[0] as NotifyInput).variant ===
        "event.application-submission-received",
    );
    expect(organizerCalls.length).toBeGreaterThan(0);
    for (const call of organizerCalls) {
      expect((call[0] as NotifyInput).channels).toEqual({
        sms: { enabled: false },
      });
    }
  });

  it("a throwing reporter never turns a swallow into a failure", async () => {
    deps.notify.mockRejectedValue(new Error("all deliveries down"));
    deps.reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });

    await expect(
      notifyEventApplicationReceived(buildDeps(deps), {
        event: orgEvent,
        submission: baseSubmission,
      }),
    ).resolves.toBeUndefined();
  });


  it("tells a guest they can ignore the ack if they didn't apply (anon submit only needs a Turnstile token)", async () => {
    const anonSubmission = { ...baseSubmission, humanId: null };

    await notifyEventApplicationReceived(buildDeps(deps), {
      event: orgEvent,
      submission: anonSubmission,
    });

    const sent = deps.mailerSend.mock.calls[0]![0] as unknown as {
      text: string;
      template: { variables: Record<string, unknown> };
    };
    // Someone else can type YOUR address into an anonymous form — an
    // unexpected ack must not read as "an account was created for me". The
    // template gets `isGuest`; the plain-text part carries the line itself.
    expect(sent.text).toContain("Didn't apply?");
    expect(sent.template.variables.isGuest).toBe(true);
  });

  describe("guest ack — template props (owner decisions 2026-09-30)", () => {
    const richOrgEvent = {
      ...orgEvent,
      slug: "sunset-collective/us/secret-show--ab12cd",
      timezone: "America/Chicago",
      startsAt: new Date("2025-12-20T02:00:00Z"),
      endsAt: null,
    };
    const anonSubmission = { ...baseSubmission, humanId: null };

    it("sends the template with event URL, applied-at, zone and organizer contact", async () => {
      deps.organizations.getById.mockResolvedValue({
        id: ORG_ID,
        slug: "sunset-collective",
        contactEmail: "hello@sunset.test",
      } as never);

      await notifyEventApplicationReceived(buildDeps(deps), {
        event: richOrgEvent,
        submission: anonSubmission,
      });

      const sent = deps.mailerSend.mock.calls[0]![0] as unknown as Record<
        string,
        unknown
      >;
      expect(sent).toEqual({
        to: { to: "guest@example.com" },
        subject: "Application sent: Secret show",
        text: expect.stringContaining("Your spot isn't confirmed yet."),
        replyTo: { to: "hello@sunset.test" },
        template: {
          key: "event.application_received",
          variables: {
            eventTitle: "Secret show",
            eventUrl: `${BASE_URL}/events/sunset-collective/us/secret-show--ab12cd`,
            appliedAtISO: NOW.toISOString(),
            timezone: "America/Chicago",
            isGuest: true,
            organizerContactEmail: "hello@sunset.test",
          },
        },
      });
    });

    it("drops a malformed org contact email instead of failing the template", async () => {
      deps.organizations.getById.mockResolvedValue({
        id: ORG_ID,
        slug: "sunset-collective",
        contactEmail: "not-an-email",
      } as never);

      await notifyEventApplicationReceived(buildDeps(deps), {
        event: richOrgEvent,
        submission: anonSubmission,
      });

      const sent = deps.mailerSend.mock.calls[0]![0] as unknown as {
        replyTo?: unknown;
        template: { variables: Record<string, unknown> };
      };
      expect(sent.replyTo).toBeUndefined();
      expect(sent.template.variables).not.toHaveProperty(
        "organizerContactEmail",
      );
    });

    it("passes the same props to the signed-in notify payload", async () => {
      deps.organizations.getById.mockResolvedValue({
        id: ORG_ID,
        slug: "sunset-collective",
        contactEmail: "hello@sunset.test",
      } as never);

      await notifyEventApplicationReceived(buildDeps(deps), {
        event: richOrgEvent,
        submission: baseSubmission,
      });

      expect(deps.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "event.application-received",
          payload: {
            eventId: EVENT_ID,
            eventTitle: "Secret show",
            submissionId: SUBMISSION_ID,
            eventUrl: `${BASE_URL}/events/sunset-collective/us/secret-show--ab12cd`,
            appliedAtIso: NOW.toISOString(),
            timezone: "America/Chicago",
            organizerContactEmail: "hello@sunset.test",
          },
        }),
      );
    });

    it("reports a failing guest send (logged at error) without throwing", async () => {
      const boom = new Error("mailer down");
      deps.mailerSend.mockRejectedValueOnce(boom);

      await expect(
        notifyEventApplicationReceived(buildDeps(deps), {
          event: richOrgEvent,
          submission: anonSubmission,
        }),
      ).resolves.toBeUndefined();

      expect(deps.loggerError).toHaveBeenCalledWith(
        "events.notify_application_received.anon_ack_failed",
        expect.objectContaining({ submissionId: SUBMISSION_ID, err: boom }),
      );
      expect(deps.reportError).toHaveBeenCalledWith(boom, {
        tags: {
          useCase: "notifyEventApplicationReceived",
          channel: "anonAckEmail",
        },
        extra: { submissionId: SUBMISSION_ID, eventId: EVENT_ID },
      });
    });

    it("a throwing reporter on a failed guest send changes nothing", async () => {
      deps.mailerSend.mockRejectedValueOnce(new Error("mailer down"));
      deps.reportError.mockImplementation(() => {
        throw new Error("reporter down");
      });

      await expect(
        notifyEventApplicationReceived(buildDeps(deps), {
          event: richOrgEvent,
          submission: anonSubmission,
        }),
      ).resolves.toBeUndefined();
      // Organizer fan-out still ran.
      expect(deps.notify).toHaveBeenCalledTimes(2);
    });

    it("a failed org lookup costs the contact prop, not the email (reported)", async () => {
      const lookupError = new Error("db blip");
      // Call order: the organizer leg resolves recipients FIRST (its lookup
      // succeeds), then the ack's context lookup fails.
      deps.organizations.getById
        .mockResolvedValueOnce({ id: ORG_ID, slug: "sunset-collective" } as never)
        .mockRejectedValueOnce(lookupError);

      await notifyEventApplicationReceived(buildDeps(deps), {
        event: richOrgEvent,
        submission: anonSubmission,
      });

      expect(deps.mailerSend).toHaveBeenCalledTimes(1);
      expect(deps.reportError).toHaveBeenCalledWith(lookupError, {
        tags: {
          useCase: "notifyEventApplicationReceived",
          channel: "applicantEmailContext",
        },
        extra: { eventId: EVENT_ID, lookup: "organization" },
      });
    });
  });
});
