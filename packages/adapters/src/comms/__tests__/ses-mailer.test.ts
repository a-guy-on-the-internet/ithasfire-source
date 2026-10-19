// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SESv2Client,
  SendEmailCommand,
  GetAccountCommand,
  type SendEmailCommandOutput,
} from "@aws-sdk/client-sesv2";

import { SESMailerAdapter } from "../ses-mailer";
import { createFakeIdempotencyPort, createTestLogger } from "@th/test-utils";
import type { MetricsPort } from "@th/ports/metric";
import { CommsPortError, type SendResult } from "@th/ports/comms/index";

const sesMock = mockClient(SESv2Client);

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

const createClient = () =>
  new SESv2Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  });

describe("SESMailerAdapter", () => {
  beforeEach(() => {
    sesMock.reset();
  });

  it("sends a simple email", async () => {
    const metrics = createMetrics();
    const client = createClient();
    sesMock
      .on(SendEmailCommand)
      .resolves({
        MessageId: "msg-123",
        $metadata: { requestId: "req-1" },
      } as SendEmailCommandOutput);

    const adapter = new SESMailerAdapter({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
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
    expect(metrics.increment).toHaveBeenCalledWith(
      "comms.mail.sent",
      expect.objectContaining({ channel: "mail" }),
    );
  });

  it("replays idempotent send without calling SES again", async () => {
    const metrics = createMetrics();
    const client = createClient();
    const idempotency = createFakeIdempotencyPort();
    sesMock
      .on(SendEmailCommand)
      .resolves({ MessageId: "msg-abc" } as SendEmailCommandOutput);

    const adapter = new SESMailerAdapter({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
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

    const callCountAfterFirst = sesMock.commandCalls(SendEmailCommand).length;

    const second = await adapter.send(input);
    expect(second.result.success).toBe(true);
    expect(second.result.idempotentReplay).toBe(true);
    expect(sesMock.commandCalls(SendEmailCommand).length).toBe(
      callCountAfterFirst,
    );
  });

  it("retries on rate limit and eventually succeeds", async () => {
    const metrics = createMetrics();
    const client = createClient();

    const rateLimitError = Object.assign(new Error("too many requests"), {
      name: "TooManyRequestsException",
      $metadata: { httpStatusCode: 429 },
    });

    sesMock
      .on(SendEmailCommand)
      .rejectsOnce(rateLimitError)
      .resolves({ MessageId: "msg-ret" } as SendEmailCommandOutput);

    const adapter = new SESMailerAdapter({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics,
    });

    const { result } = await adapter.send({
      to: { to: "user@example.com" },
      subject: "Hi",
      text: "Retry please",
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe("msg-ret");
    expect(sesMock.commandCalls(SendEmailCommand).length).toBe(2);
  });

  it("maps vendor validation error to CommsPortError", async () => {
    const metrics = createMetrics();
    const client = createClient();

    const validationError = Object.assign(new Error("bad request"), {
      name: "ValidationException",
      $metadata: { httpStatusCode: 400 },
    });

    sesMock.on(SendEmailCommand).rejects(validationError);

    const adapter = new SESMailerAdapter({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
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
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects template with attachments", async () => {
    const client = createClient();
    const adapter = new SESMailerAdapter({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    await expect(
      adapter.send({
        to: { to: "user@example.com" },
        template: { key: "welcome" },
        attachments: [
          {
            filename: "doc.txt",
            mime: "text/plain",
            bytesBase64: "SGVsbG8=",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CommsPortError);
  });

  it("passes template version metadata when not an ARN", async () => {
    const metrics = createMetrics();
    const client = createClient();
    sesMock
      .on(SendEmailCommand)
      .resolves({ MessageId: "msg-template" } as SendEmailCommandOutput);

    const adapter = new SESMailerAdapter({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics,
    });

    await adapter.send({
      to: { to: "user@example.com" },
      template: {
        key: "welcome-email",
        variables: { name: "User" },
        version: "v2",
      },
    });

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as any;
    expect(input.Content?.Template?.TemplateArn).toBeUndefined();
    expect(input.Content?.Template?.TemplateData).toBe(
      JSON.stringify({ name: "User", _version: "v2" }),
    );
  });

  it("uses template ARN when provided", async () => {
    const metrics = createMetrics();
    const client = createClient();
    sesMock
      .on(SendEmailCommand)
      .resolves({ MessageId: "msg-template" } as SendEmailCommandOutput);

    const adapter = new SESMailerAdapter({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics,
    });

    await adapter.send({
      to: { to: "user@example.com" },
      template: {
        key: "welcome-email",
        variables: { name: "User" },
        version: "arn:aws:ses:us-east-1:123456789012:template/welcome-email",
      },
    });

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as any;
    expect(input.Content?.Template?.TemplateArn).toBe(
      "arn:aws:ses:us-east-1:123456789012:template/welcome-email",
    );
    expect(input.Content?.Template?.TemplateData).toBe(
      JSON.stringify({ name: "User" }),
    );
  });

  it("requires raw body when attachments provided", async () => {
    const metrics = createMetrics();
    const client = createClient();
    sesMock
      .on(SendEmailCommand)
      .resolves({ MessageId: "msg-attachment" } as SendEmailCommandOutput);

    const adapter = new SESMailerAdapter({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics,
    });

    await expect(
      adapter.send({
        to: { to: "user@example.com" },
        subject: "Attachment",
        attachments: [
          {
            filename: "doc.txt",
            mime: "text/plain",
            bytesBase64: "SGVsbG8=",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("handles batch send with partial failures", async () => {
    const metrics = createMetrics();
    const client = createClient();

    sesMock
      .on(SendEmailCommand)
      .resolvesOnce({ MessageId: "msg-success" } as SendEmailCommandOutput)
      .rejectsOnce(
        Object.assign(new Error("boom"), {
          name: "ServiceException",
          $metadata: { httpStatusCode: 500 },
        }),
      );

    const adapter = new SESMailerAdapter({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
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
    const [first, second] = batch.results as [SendResult, SendResult];
    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.errorCode).toBe("dependency_failed");
  });

  it("reports health degraded on failure", async () => {
    const client = createClient();
    sesMock.on(GetAccountCommand).rejects(new Error("down"));

    const adapter = new SESMailerAdapter({
      region: "us-east-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      defaultFromEmail: "sender@example.com",
      client,
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    const health = await adapter.health();
    expect(health.ok).toBe(false);
    expect(health.vendor).toBe("aws-ses");
    expect(health.message).toBe("down");
  });
});
