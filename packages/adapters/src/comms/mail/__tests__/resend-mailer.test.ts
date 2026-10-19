// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIdempotencyPort, createTestLogger } from "@th/test-utils";
import { CommsPortError } from "@th/ports/comms/index";
import type { MetricsPort } from "@th/ports/metric";

import { ResendMailAdapter, isReservedTestEmail } from "../resend-mailer";

const createMetrics = (): MetricsPort & {
  increment: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
} => {
  const increment = vi.fn();
  const record = vi.fn();
  return {
    increment,
    record,
  } as unknown as MetricsPort & {
    increment: ReturnType<typeof vi.fn>;
    record: ReturnType<typeof vi.fn>;
  };
};

const createClient = () => ({
  emails: {
    send: vi.fn(),
  },
  domains: {
    list: vi.fn(),
  },
});

const successResponse = (id: string) => ({
  data: { id },
  error: null,
  headers: null,
});

describe("ResendMailAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a simple email", async () => {
    const metrics = createMetrics();
    const client = createClient();
    client.emails.send.mockResolvedValue(successResponse("msg-123"));

    const adapter = new ResendMailAdapter({
      apiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics,
    });

    const { result } = await adapter.send({
      to: { to: "user@example.com" },
      subject: "Welcome",
      text: "Hello world",
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe("msg-123");
    expect(client.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "sender@example.com",
        to: ["user@example.com"],
        subject: "Welcome",
        text: "Hello world",
      }),
      undefined,
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      "comms.mail.sent",
      expect.objectContaining({ channel: "mail" }),
    );
  });

  it("replays idempotent sends without calling Resend again", async () => {
    const metrics = createMetrics();
    const client = createClient();
    const idempotency = createFakeIdempotencyPort();
    client.emails.send.mockResolvedValue(successResponse("msg-abc"));

    const adapter = new ResendMailAdapter({
      apiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics,
      idempotency,
    });

    const input = {
      to: { to: "user@example.com" },
      subject: "Hello",
      text: "Hi",
      idempotencyKey: "idem-key",
    } as const;

    const first = await adapter.send(input);
    expect(first.result.success).toBe(true);
    expect(first.result.id).toBe("msg-abc");

    const callCountAfterFirst = client.emails.send.mock.calls.length;

    const second = await adapter.send(input);
    expect(second.result.success).toBe(true);
    expect(second.result.idempotentReplay).toBe(true);
    expect(client.emails.send.mock.calls.length).toBe(callCountAfterFirst);
    expect(client.emails.send).toHaveBeenCalledWith(expect.anything(), {
      idempotencyKey: "idem-key",
    });
  });

  it("renders templates and maps attachments", async () => {
    const metrics = createMetrics();
    const client = createClient();
    const renderer = vi.fn(async () => ({
      subject: "Rendered subject",
      html: "<p>Hello</p>",
      text: "Hello",
    }));
    client.emails.send.mockResolvedValue(successResponse("msg-template"));

    const adapter = new ResendMailAdapter({
      apiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics,
      renderer,
    });

    await adapter.send({
      to: { to: "user@example.com" },
      template: {
        key: "welcome-email",
        variables: { name: "User" },
        version: "v2",
      },
      attachments: [
        {
          filename: "doc.txt",
          mime: "text/plain",
          bytesBase64: "SGVsbG8=",
        },
      ],
    });

    expect(renderer).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: "welcome-email",
        props: { name: "User" },
      }),
    );
    expect(client.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Rendered subject",
        html: "<p>Hello</p>",
        text: "Hello",
        headers: expect.objectContaining({
          "X-Template": "welcome-email",
          "X-Template-Version": "v2",
        }),
        attachments: [
          expect.objectContaining({
            filename: "doc.txt",
            content: Buffer.from("Hello"),
            contentType: "text/plain",
          }),
        ],
      }),
      undefined,
    );
  });

  it("maps vendor validation errors to CommsPortError", async () => {
    const metrics = createMetrics();
    const client = createClient();
    client.emails.send.mockResolvedValue({
      data: null,
      error: {
        message: "bad request",
        statusCode: 400,
        name: "validation_error",
      },
      headers: null,
    });

    const adapter = new ResendMailAdapter({
      apiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics,
    });

    await expect(
      adapter.send({
        to: { to: "user@example.com" },
        subject: "Oops",
        text: "Broken",
      }),
    ).rejects.toBeInstanceOf(CommsPortError);
    await expect(
      adapter.send({
        to: { to: "user@example.com" },
        subject: "Oops",
        text: "Broken",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("skips RFC-reserved test-domain recipients when blockReservedTestDomains is on", async () => {
    const metrics = createMetrics();
    const client = createClient();

    const adapter = new ResendMailAdapter({
      apiKey: "re_test_123",
      defaultFromEmail: "sender@ithasfire.com",
      client,
      logger: createTestLogger(),
      metrics,
      blockReservedTestDomains: true,
    });

    const { result } = await adapter.send({
      to: { to: "ethan.brown@example.com" },
      subject: "Reminder",
      text: "Hello",
      idempotencyKey: "seed-reminder",
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: "conflict",
      errorMessage: "recipient_reserved_test_domain",
      details: { testDomainRecipientCount: 1 },
    });
    expect(client.emails.send).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith(
      "comms.mail.skipped_test_domain",
      expect.anything(),
    );
  });

  it("still sends to real domains when blockReservedTestDomains is on", async () => {
    const client = createClient();
    client.emails.send.mockResolvedValue(successResponse("msg-real"));

    const adapter = new ResendMailAdapter({
      apiKey: "re_test_123",
      defaultFromEmail: "sender@ithasfire.com",
      client,
      logger: createTestLogger(),
      metrics: createMetrics(),
      blockReservedTestDomains: true,
    });

    const { result } = await adapter.send({
      to: { to: "real.person@gmail.com" },
      subject: "Receipt",
      text: "Hello",
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe("msg-real");
    expect(client.emails.send).toHaveBeenCalled();
  });

  it("sends to example.com when blockReservedTestDomains is off (default)", async () => {
    const client = createClient();
    client.emails.send.mockResolvedValue(successResponse("msg-default"));

    const adapter = new ResendMailAdapter({
      apiKey: "re_test_123",
      defaultFromEmail: "sender@ithasfire.com",
      client,
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    const { result } = await adapter.send({
      to: { to: "user@example.com" },
      subject: "Test",
      text: "Hello",
    });

    expect(result.success).toBe(true);
    expect(client.emails.send).toHaveBeenCalled();
  });

  it("returns a failed result without calling Resend for suppressed recipients", async () => {
    const metrics = createMetrics();
    const client = createClient();
    const childLogger = createTestLogger();
    const logger = {
      ...createTestLogger(),
      child: vi.fn(() => childLogger),
    };
    const deliverability = {
      getByEmail: vi.fn(async () => ({
        authUserId: "auth-user-1",
        email: "user@example.com",
        status: "BOUNCED",
        statusAt: new Date("2026-05-25T10:00:00.000Z"),
        statusRef: "evt-bounced",
      })),
      recordProviderEvent: vi.fn(),
      clearByEmail: vi.fn(),
    };

    const adapter = new ResendMailAdapter({
      apiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      client,
      logger,
      metrics,
      deliverability,
    });

    const { result } = await adapter.send({
      to: { to: "user@example.com" },
      subject: "Blocked",
      text: "Hello",
      idempotencyKey: "blocked-send",
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: "conflict",
      errorMessage: "recipient_suppressed",
      details: {
        suppressedRecipients: [
          expect.objectContaining({
            email: "user@example.com",
            status: "BOUNCED",
          }),
        ],
      },
    });
    expect(client.emails.send).not.toHaveBeenCalled();
    expect(childLogger.warn).toHaveBeenCalledWith("resend.send.suppressed", {
      suppressedRecipientCount: 1,
      statuses: ["BOUNCED"],
      authUserIds: ["auth-user-1"],
      idem: "blocked-send",
      template: null,
    });
    expect(JSON.stringify(childLogger.warn.mock.calls)).not.toContain(
      "user@example.com",
    );
  });

  it("handles batch sends with partial failures", async () => {
    const metrics = createMetrics();
    const client = createClient();
    client.emails.send
      .mockResolvedValueOnce(successResponse("msg-success"))
      .mockResolvedValueOnce({
        data: null,
        error: {
          message: "boom",
          statusCode: 500,
          name: "internal_server_error",
        },
        headers: null,
      });

    const adapter = new ResendMailAdapter({
      apiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics,
    });

    const batch = await adapter.sendBatch([
      { to: { to: "user1@example.com" }, subject: "A", text: "Hello" },
      { to: { to: "user2@example.com" }, subject: "B", text: "Hello" },
    ]);

    expect(batch.okCount).toBe(1);
    expect(batch.errorCount).toBe(1);
    expect(batch.results).toHaveLength(2);
    expect(batch.results[0]).toMatchObject({
      success: true,
      id: "msg-success",
    });
    expect(batch.results[1]).toMatchObject({
      success: false,
      errorCode: "transient",
    });
  });

  it("returns per-item batch failures for suppressed recipients", async () => {
    const metrics = createMetrics();
    const client = createClient();
    client.emails.send.mockResolvedValue(successResponse("msg-ok"));
    const deliverability = {
      getByEmail: vi.fn(async (email: string) =>
        email === "blocked@example.com"
          ? {
              authUserId: "auth-user-1",
              email,
              status: "COMPLAINED",
              statusAt: new Date("2026-05-25T11:00:00.000Z"),
              statusRef: "evt-complained",
            }
          : {
              authUserId: "auth-user-2",
              email,
              status: null,
              statusAt: null,
              statusRef: null,
            },
      ),
      recordProviderEvent: vi.fn(),
      clearByEmail: vi.fn(),
    };

    const adapter = new ResendMailAdapter({
      apiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics,
      deliverability,
    });

    const batch = await adapter.sendBatch([
      { to: { to: "blocked@example.com" }, subject: "A", text: "Hello" },
      { to: { to: "ok@example.com" }, subject: "B", text: "Hello" },
    ]);

    expect(batch.okCount).toBe(1);
    expect(batch.errorCount).toBe(1);
    expect(batch.results[0]).toMatchObject({
      success: false,
      errorCode: "conflict",
      errorMessage: "recipient_suppressed",
    });
    expect(batch.results[1]).toMatchObject({
      success: true,
      id: "msg-ok",
    });
    expect(client.emails.send).toHaveBeenCalledTimes(1);
    expect(client.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["ok@example.com"] }),
      undefined,
    );
  });

  it("reports degraded health when Resend is unavailable", async () => {
    const client = createClient();
    client.domains.list.mockResolvedValue({
      data: null,
      error: {
        message: "forbidden",
        statusCode: 403,
        name: "forbidden_error",
      },
      headers: null,
    });

    const adapter = new ResendMailAdapter({
      apiKey: "re_test_123",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    const health = await adapter.health();
    expect(health.ok).toBe(false);
    expect(health.vendor).toBe("resend");
    expect(health.message).toBe("forbidden");
  });
});

describe("isReservedTestEmail", () => {
  it.each([
    ["a@example.com", true],
    ["a@example.net", true],
    ["a@example.org", true],
    ["a@host.test", true],
    ["a@thing.invalid", true],
    ["a@localhost", true],
    ["a@sub.localhost", true],
    ["A@Example.Com", true],
    ["real@gmail.com", false],
    ["real@ithasfire.com", false],
    ["malformed-no-at", false],
  ])("%s -> %s", (email, expected) => {
    expect(isReservedTestEmail(email as string)).toBe(expected);
  });
});
