import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import {
  authzRepoPrototype,
  humansRepoPrototype,
} from "@th/test-utils/fakes/prototypes/repos";

import {
  sendTestAnnouncement,
  type SendTestAnnouncementDeps,
} from "./send-test-announcement";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const ACTOR_ID = randomUUID();
const ACTOR_EMAIL = "admin@example.com";
const ACTOR_NAME = "Test Admin";

function makeMailerMock(): MailerPort {
  return {
    send: vi.fn(async () => ({ result: { success: true, id: "msg_test_1" } })),
    sendBatch: vi.fn(async () => ({ ok: true, results: [] }) as any),
    health: vi.fn(async () => ({ ok: true, vendor: "mock", latencyMs: 0 })),
  };
}

function makeDeps(overrides?: {
  mailer?: MailerPort | null;
  membership?: { role: string } | null;
  humanWithIdentity?: {
    human: { id: string; name: string | null };
    identity: { email: string };
  } | null;
}): SendTestAnnouncementDeps {
  const authz = { ...authzRepoPrototype };
  authz.getOrgMembership = vi.fn(async () =>
    overrides?.membership !== undefined
      ? overrides.membership
      : { role: "OWNER" },
  );

  const humans = { ...humansRepoPrototype };
  humans.getByIdWithIdentity = vi.fn(async () =>
    overrides?.humanWithIdentity !== undefined
      ? overrides.humanWithIdentity
      : {
          human: { id: ACTOR_ID, name: ACTOR_NAME },
          identity: {
            authUserId: randomUUID(),
            email: ACTOR_EMAIL,
            emailVerified: true,
            phone: null,
            phoneVerified: false,
            username: null,
            displayUsername: null,
            image: null,
          },
        },
  );

  const resolvedMailer =
    overrides && "mailer" in overrides
      ? (overrides.mailer ?? undefined)
      : makeMailerMock();

  return {
    repos: { authz, humans } as any,
    clock: { now: () => new Date() } satisfies ClockPort,
    logger: createTestLogger(),
    mailer: resolvedMailer,
  };
}

function validInput() {
  return {
    ownerType: "ORGANIZATION" as const,
    ownerId: ORG_ID,
    actorHumanId: ACTOR_ID,
    subject: "Weekly Update",
    bodyHtml: "<p>Hello world</p>",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("sendTestAnnouncement", () => {
  it("sends a test email and returns the actor's email", async () => {
    const mailer = makeMailerMock();
    const deps = makeDeps({ mailer });

    const result = await sendTestAnnouncement(deps, validInput());

    expect(result.sentToEmail).toBe(ACTOR_EMAIL);
    expect(mailer.send).toHaveBeenCalledOnce();

    const sendCall = (mailer.send as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(sendCall.to).toEqual({ to: ACTOR_EMAIL, name: ACTOR_NAME });
    expect(sendCall.subject).toBe("[TEST] Weekly Update");
    expect(sendCall.html).toBe("<p>Hello world</p>");
    expect(sendCall.tags).toContain("test");
    expect(sendCall.tags).toContain("announcement");
  });

  it("throws forbidden when actor lacks org role", async () => {
    const deps = makeDeps({ membership: null });

    await expect(
      sendTestAnnouncement(deps, validInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws forbidden for VIEWER role", async () => {
    const deps = makeDeps({ membership: { role: "VIEWER" } });

    await expect(
      sendTestAnnouncement(deps, validInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws when mailer is not configured", async () => {
    const deps = makeDeps({ mailer: null });

    await expect(
      sendTestAnnouncement(deps, validInput()),
    ).rejects.toMatchObject({ code: "MAILER_NOT_CONFIGURED" });
  });

  it("refuses when the actor cannot be resolved (verified-email gate)", async () => {
    const deps = makeDeps({ humanWithIdentity: null });

    await expect(
      sendTestAnnouncement(deps, validInput()),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("throws ACTOR_EMAIL_NOT_FOUND for a verified identity with no email", async () => {
    const deps = makeDeps({
      humanWithIdentity: {
        human: { id: ACTOR_ID, name: ACTOR_NAME },
        identity: { email: "", emailVerified: true } as never,
      },
    });

    await expect(
      sendTestAnnouncement(deps, validInput()),
    ).rejects.toMatchObject({ code: "ACTOR_EMAIL_NOT_FOUND" });
  });

  // Review round 2 (F8): the test copy mails caller-written HTML to the
  // actor's identity email; an unverified address made it a relay.
  it("refuses an unverified actor before the mailer runs", async () => {
    const mailer = makeMailerMock();
    const deps = makeDeps({
      mailer,
      humanWithIdentity: {
        human: { id: ACTOR_ID, name: ACTOR_NAME },
        identity: { email: "anyone@victim.example", emailVerified: false } as never,
      },
    });

    await expect(
      sendTestAnnouncement(deps, validInput()),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("throws when mailer returns a failed result", async () => {
    const mailer = makeMailerMock();
    (mailer.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      result: {
        success: false,
        errorCode: "rate_limited",
        errorMessage: "Too many requests",
      },
    });

    const deps = makeDeps({ mailer });

    await expect(
      sendTestAnnouncement(deps, validInput()),
    ).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });

    expect(deps.logger.warn).toHaveBeenCalledWith(
      "test_announcement_send_port_error",
      expect.objectContaining({ errorCode: "rate_limited" }),
    );
  });

  it("allows ADMIN role", async () => {
    const deps = makeDeps({ membership: { role: "ADMIN" } });
    const result = await sendTestAnnouncement(deps, validInput());
    expect(result.sentToEmail).toBe(ACTOR_EMAIL);
  });

  it("allows EDITOR role", async () => {
    const deps = makeDeps({ membership: { role: "EDITOR" } });
    const result = await sendTestAnnouncement(deps, validInput());
    expect(result.sentToEmail).toBe(ACTOR_EMAIL);
  });

  it("rejects invalid input (missing subject)", async () => {
    const deps = makeDeps();
    const input = { ...validInput(), subject: "" };

    await expect(sendTestAnnouncement(deps, input)).rejects.toThrow();
  });
});
