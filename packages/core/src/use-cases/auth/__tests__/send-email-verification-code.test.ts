import { describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import type { ClockPort } from "@th/ports/clock";

import { sendEmailVerificationCode } from "../send-email-verification-code";

function makeMailerMock(): MailerPort {
  return {
    send: vi.fn(async () => ({ result: { success: true, id: "msg_1" } })),
    sendBatch: vi.fn(
      async () =>
        ({ ok: true, results: [{ success: true, id: "msg_1" }] }) as any,
    ),
    health: vi.fn(async () => ({ ok: true, vendor: "mock", latencyMs: 0 })),
  };
}

describe("sendEmailVerificationCode", () => {
  it("replays the same code for the same idempotency key", async () => {
    const idempotency = createFakeIdempotencyPort();
    const mailer = makeMailerMock();
    const clock: ClockPort = { now: () => new Date() };

    const first = await sendEmailVerificationCode(
      { idempotency, mailer, clock },
      {
        toEmail: "user@example.com",
        productName: "Ithas Fire",
        clientKey: "better-auth",
      },
    );

    expect(first.ok).toBe(true);
    expect(first.code).toMatch(/^[0-9]{6}$/);
    expect((mailer.send as any).mock.calls.length).toBe(1);

    const second = await sendEmailVerificationCode(
      { idempotency, mailer, clock },
      {
        toEmail: "user@example.com",
        productName: "Ithas Fire",
        clientKey: "better-auth",
      },
    );

    expect(second.ok).toBe(true);
    expect(second.code).toBe(first.code);
    expect(second.idempotentReplay).toBe(true);
    expect((mailer.send as any).mock.calls.length).toBe(1);
  });
});
