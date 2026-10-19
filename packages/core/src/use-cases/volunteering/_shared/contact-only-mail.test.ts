import { describe, expect, it, vi } from "vitest";

import {
  CONTACT_ONLY_MAIL_PER_ASK_DAILY_MAX,
  CONTACT_ONLY_MAIL_PER_RECIPIENT_DAILY_MAX,
  contactOnlyMailAskKey,
  contactOnlyMailRecipientKey,
  renderContactOnlyMail,
  sendContactOnlySignupMail,
} from "./contact-only-mail";

const INPUT = {
  kind: "received" as const,
  signupId: "s-1",
  askId: "ask-1",
  contactEmail: "Someone@Example.org",
  askTitle: "Street team",
};

function makeDeps() {
  const send = vi.fn(async (_input: unknown) => ({
    result: { success: true, id: "m1" },
  }));
  const consume = vi.fn(async () => ({
    allowed: true,
    remaining: 2,
    retryAfterSeconds: 0,
  }));
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const reportError = vi.fn();
  return {
    deps: {
      mailer: { send } as never,
      rateLimit: { consume } as never,
      logger: logger as never,
      reportError,
    },
    send,
    consume,
    reportError,
  };
}

describe("renderContactOnlyMail (fixed copy)", () => {
  it("names the ask in the BODY only, and nothing else a sender controls", () => {
    const { subject, text } = renderContactOnlyMail("received", "Street team");
    // Anonymous trigger: no sender-influenced text in the subject line.
    expect(subject).toBe("Volunteer signup received");
    expect(text).toContain(
      "Someone signed up to volunteer for Street team with this address.",
    );
    expect(text).toContain("If this wasn't you, you can ignore this email.");
    expect(text).toContain("Nothing is linked to an Ithas Fire account.");
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("flattens control characters and bounds the ask title (no header or body smuggling)", () => {
    const { subject } = renderContactOnlyMail(
      "approved",
      `Evil\r\nBcc: victim@example.org\n${"x".repeat(300)}`,
    );
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject.length).toBeLessThan(160);
  });

  it("strips bidi overrides and other format characters (\\p{Cf}) from the title", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE, U+2066 LEFT-TO-RIGHT ISOLATE,
    // U+200B ZERO WIDTH SPACE.
    const { text } = renderContactOnlyMail(
      "received",
      "Street\u202Eteam\u2066\u200B crew",
    );
    expect(text).toContain("Streetteam crew");
    expect(text).not.toMatch(/\p{Cf}/u);
  });

  it("has an approved and a declined variant", () => {
    expect(renderContactOnlyMail("approved", "A").text).toContain("was approved");
    expect(renderContactOnlyMail("declined", "A").text).toContain("was declined");
  });
});

describe("sendContactOnlySignupMail", () => {
  it("spends the per-recipient budget (hashed, case-insensitive key) and sends once", async () => {
    const { deps, send, consume } = makeDeps();
    await expect(sendContactOnlySignupMail(deps, INPUT)).resolves.toBe("sent");

    expect(consume).toHaveBeenCalledWith(
      contactOnlyMailAskKey("ask-1"),
      CONTACT_ONLY_MAIL_PER_ASK_DAILY_MAX,
      86400,
    );
    expect(contactOnlyMailAskKey("ask-1")).toBe(
      "volunteer:contactOnlyMail:ask:ask-1",
    );
    expect(consume).toHaveBeenCalledWith(
      contactOnlyMailRecipientKey("someone@example.org"),
      CONTACT_ONLY_MAIL_PER_RECIPIENT_DAILY_MAX,
      86400,
    );
    expect(contactOnlyMailRecipientKey("someone@example.org")).not.toContain(
      "someone",
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: INPUT.contactEmail },
        idempotencyKey: "volunteer-contact-only:s-1:received",
      }),
    );
  });

  it("skips, fails closed and reports when the ASK's daily budget is spent — the recipient budget is not spent", async () => {
    const { deps, send, consume, reportError } = makeDeps();
    consume.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    await expect(sendContactOnlySignupMail(deps, INPUT)).resolves.toBe("skipped");
    expect(send).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "volunteerContactOnlyMail", reason: "ask_daily_cap" },
      extra: { signupId: "s-1", askId: "ask-1", kind: "received" },
    });
  });

  it("skips when the recipient's daily budget is spent", async () => {
    const { deps, send, consume, reportError } = makeDeps();
    consume
      .mockResolvedValueOnce({ allowed: true, remaining: 10, retryAfterSeconds: 0 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    await expect(sendContactOnlySignupMail(deps, INPUT)).resolves.toBe("skipped");
    expect(send).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("fails CLOSED and reports when the limiter errors", async () => {
    const { deps, send, consume, reportError } = makeDeps();
    const boom = new Error("redis down");
    consume.mockRejectedValueOnce(boom);
    await expect(sendContactOnlySignupMail(deps, INPUT)).resolves.toBe("skipped");
    expect(send).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "volunteerContactOnlyMail", reason: "cap_consume_failed" },
      extra: { signupId: "s-1", askId: "ask-1", kind: "received" },
    });
  });

  it("fails CLOSED and reports when no limiter or no mailer is wired", async () => {
    const a = makeDeps();
    await expect(
      sendContactOnlySignupMail({ ...a.deps, rateLimit: null }, INPUT),
    ).resolves.toBe("skipped");
    expect(a.send).not.toHaveBeenCalled();
    expect(a.reportError).toHaveBeenCalledTimes(1);

    const b = makeDeps();
    await expect(
      sendContactOnlySignupMail({ ...b.deps, mailer: null }, INPUT),
    ).resolves.toBe("skipped");
    expect(b.consume).not.toHaveBeenCalled();
    expect(b.reportError).toHaveBeenCalledTimes(1);
  });

  it("never throws: a failing mailer and a throwing reporter are both absorbed", async () => {
    const { deps, send } = makeDeps();
    send.mockRejectedValueOnce(new Error("smtp down"));
    deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(sendContactOnlySignupMail(deps, INPUT)).resolves.toBe("skipped");
  });
});
