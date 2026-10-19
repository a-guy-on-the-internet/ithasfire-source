import { describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

import { SnsSmsAdapter } from "../sns-sms";
import { createFakeIdempotencyPort, createTestLogger } from "@th/test-utils";
import type { MetricsPort } from "@th/ports/metric";

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

describe("SnsSmsAdapter", () => {
  it("publishes a simple sms message", async () => {
    const metrics = createMetrics();
    const client = new SNSClient({ region: "us-east-1" });
    // NOTE: aws-sdk-client-mock's types can conflict with AWS SDK v3's (Smithy) types when
    // multiple copies of @smithy/types exist in the dependency graph. The runtime behavior is
    // fine; we loosen the generics here to keep package-level `tsc` happy.
    const snsMock = mockClient(
      SNSClient as unknown as new (...args: any[]) => any,
    );
    snsMock
      .on(PublishCommand as unknown as new (...args: any[]) => any)
      .resolves({ MessageId: "msg-123" } as any);

    const adapter = new SnsSmsAdapter({
      client,
      logger: createTestLogger(),
      metrics,
      originationNumbers: { otp: "+18885550100", notification: "+18885550200" },
      defaultSmsType: "Transactional",
    });

    const { result } = await adapter.send({
      to: { toE164: "+15555551111" },
      body: "Hello world",
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe("msg-123");
    expect(metrics.increment).toHaveBeenCalledWith(
      "comms.sms.sent",
      expect.objectContaining({ channel: "sms", provider: "sns" }),
    );

    expect(snsMock.commandCalls(PublishCommand as any).length).toBe(1);
    const call = snsMock.commandCalls(PublishCommand as any)[0];
    const input = call?.args[0].input;
    expect(input?.PhoneNumber).toBe("+15555551111");
    expect(input?.Message).toBe("Hello world");
    expect(input?.MessageAttributes?.["AWS.SNS.SMS.SMSType"]?.StringValue).toBe(
      "Transactional",
    );
    // No purpose → notification number. US numbers take no sender ID.
    expect(
      input?.MessageAttributes?.["AWS.MM.SMS.OriginationNumber"]?.StringValue,
    ).toBe("+18885550200");
    expect(input?.MessageAttributes?.["AWS.SNS.SMS.SenderID"]).toBeUndefined();
  });

  describe("origination number", () => {
    const publishOnce = async (
      originationNumbers: { otp?: string; notification?: string } | undefined,
      purpose: "otp" | "notification" | undefined,
    ) => {
      const client = new SNSClient({ region: "us-east-1" });
      const snsMock = mockClient(
        SNSClient as unknown as new (...args: any[]) => any,
      );
      snsMock
        .on(PublishCommand as unknown as new (...args: any[]) => any)
        .resolves({ MessageId: "msg-o" } as any);
      const adapter = new SnsSmsAdapter({
        client,
        logger: createTestLogger(),
        originationNumbers,
      });
      await adapter.send({
        to: { toE164: "+15555551111" },
        body: "Hi",
        ...(purpose ? { purpose } : {}),
      });
      const attrs = snsMock.commandCalls(PublishCommand as any)[0]?.args[0]
        .input?.MessageAttributes;
      return {
        origination: attrs?.["AWS.MM.SMS.OriginationNumber"]?.StringValue as
          | string
          | undefined,
        hasOriginationKey: attrs
          ? "AWS.MM.SMS.OriginationNumber" in attrs
          : false,
        smsType: attrs?.["AWS.SNS.SMS.SMSType"]?.StringValue,
        senderId: attrs?.["AWS.SNS.SMS.SenderID"],
      };
    };

    const both = { otp: "+18885550100", notification: "+18885550200" };

    it("sends an otp from the otp number", async () => {
      const r = await publishOnce(both, "otp");
      expect(r.origination).toBe("+18885550100");
      expect(r.smsType).toBe("Transactional");
      expect(r.senderId).toBeUndefined();
    });

    it("sends a notification from the notification number", async () => {
      expect((await publishOnce(both, "notification")).origination).toBe(
        "+18885550200",
      );
    });

    it("falls back to the notification number for an otp when only it is set", async () => {
      expect(
        (await publishOnce({ notification: "+18885550200" }, "otp"))
          .origination,
      ).toBe("+18885550200");
    });

    it("falls back to the otp number for a notification when only it is set", async () => {
      expect(
        (await publishOnce({ otp: "+18885550100" }, "notification"))
          .origination,
      ).toBe("+18885550100");
    });

    it("treats an empty string as unset", async () => {
      expect(
        (await publishOnce({ otp: "", notification: "+18885550200" }, "otp"))
          .origination,
      ).toBe("+18885550200");
    });

    it("omits the attribute when neither number is set", async () => {
      const r = await publishOnce(undefined, "otp");
      expect(r.hasOriginationKey).toBe(false);
      expect(r.smsType).toBe("Transactional");
    });

    it("accepts a phone-number ARN", async () => {
      const arn =
        "arn:aws:sms-voice:us-east-1:123456789012:phone-number/phone-abc";
      expect((await publishOnce({ otp: arn }, "otp")).origination).toBe(arn);
    });
  });

  it("truncates long body", async () => {
    const client = new SNSClient({ region: "us-east-1" });
    const snsMock = mockClient(
      SNSClient as unknown as new (...args: any[]) => any,
    );
    snsMock
      .on(PublishCommand as unknown as new (...args: any[]) => any)
      .resolves({ MessageId: "msg-long" } as any);

    const adapter = new SnsSmsAdapter({
      client,
      logger: createTestLogger(),
    });

    const longBody = "A".repeat(1700);
    await adapter.send({
      to: { toE164: "+15555551111" },
      body: longBody,
    });

    const call = snsMock.commandCalls(PublishCommand as any)[0];
    const input = call?.args[0].input;
    const sent = input?.Message as string;
    expect(sent.length).toBe(1600);
    expect(sent.endsWith("...")).toBe(true);
  });

  it("replays idempotent send without additional publish", async () => {
    const client = new SNSClient({ region: "us-east-1" });
    const snsMock = mockClient(
      SNSClient as unknown as new (...args: any[]) => any,
    );
    snsMock
      .on(PublishCommand as unknown as new (...args: any[]) => any)
      .resolves({ MessageId: "msg-idem" } as any);
    const idempotency = createFakeIdempotencyPort();

    const adapter = new SnsSmsAdapter({
      client,
      logger: createTestLogger(),
      idempotency,
    });

    const input = {
      to: { toE164: "+15555551111" },
      body: "Hello",
      idempotencyKey: "sms-idem",
    } as const;

    const first = await adapter.send(input);
    expect(first.result.success).toBe(true);
    expect(first.result.id).toBe("msg-idem");
    expect(snsMock.commandCalls(PublishCommand as any).length).toBe(1);

    const second = await adapter.send(input);
    expect(second.result.success).toBe(true);
    expect(second.result.idempotentReplay).toBe(true);
    expect(snsMock.commandCalls(PublishCommand as any).length).toBe(1);
  });

  describe("US-only destinations", () => {
    const makeAdapter = () => {
      const client = new SNSClient({ region: "us-east-1" });
      const snsMock = mockClient(
        SNSClient as unknown as new (...args: any[]) => any,
      );
      snsMock
        .on(PublishCommand as unknown as new (...args: any[]) => any)
        .resolves({ MessageId: "msg-x" } as any);
      const metrics = createMetrics();
      const adapter = new SnsSmsAdapter({
        client,
        logger: createTestLogger(),
        metrics,
      });
      return { adapter, snsMock, metrics };
    };

    it.each([
      ["UK", "+447700900123"],
      ["international premium", "+882123456789"],
      ["US premium-rate 900", "+19005551234"],
      ["Jamaica behind +1", "+18765551234"],
      ["invalid exchange", "+12120001234"],
    ])("refuses %s (%s) before any Publish", async (_label, toE164) => {
      const { adapter, snsMock, metrics } = makeAdapter();

      const err = await adapter
        .send({ purpose: "otp", to: { toE164 }, body: "code 123456" })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toMatchObject({
        name: "CommsPortError",
        code: "invalid_input",
        message: "sms_destination_not_us",
      });
      expect(snsMock.commandCalls(PublishCommand as any)).toHaveLength(0);
      expect(metrics.increment).toHaveBeenCalledWith(
        "comms.sms.error",
        expect.objectContaining({ errorCode: "invalid_input" }),
      );
    });

    it("a batch with one foreign number fails only that item", async () => {
      const { adapter, snsMock } = makeAdapter();

      const batch = await adapter.sendBatch([
        { to: { toE164: "+15555551111" }, body: "Hello" },
        { to: { toE164: "+447700900123" }, body: "Hello" },
      ]);

      expect(batch.okCount).toBe(1);
      expect(batch.errorCount).toBe(1);
      expect(batch.results[1]).toMatchObject({
        success: false,
        errorCode: "invalid_input",
      });
      expect(snsMock.commandCalls(PublishCommand as any)).toHaveLength(1);
    });
  });

  it("handles batch send with partial failure", async () => {
    const client = new SNSClient({ region: "us-east-1" });
    const snsMock = mockClient(
      SNSClient as unknown as new (...args: any[]) => any,
    );
    snsMock
      .on(PublishCommand as unknown as new (...args: any[]) => any)
      .resolvesOnce({ MessageId: "msg-one" } as any)
      .rejectsOnce(
        Object.assign(new Error("down"), {
          name: "ServiceUnavailableException",
          $metadata: { httpStatusCode: 503 },
        }),
      );

    const adapter = new SnsSmsAdapter({
      client,
      logger: createTestLogger(),
    });

    const batch = await adapter.sendBatch([
      { to: { toE164: "+15555551111" }, body: "Hello" },
      { to: { toE164: "+15555552222" }, body: "World" },
    ]);

    expect(batch.okCount).toBe(1);
    expect(batch.errorCount).toBe(1);
    expect(batch.results).toHaveLength(2);
  });

  describe("phone numbers in provider errors", () => {
    it("never reach the retry, give-up or failure logs", async () => {
      const client = new SNSClient({ region: "us-east-1" });
      const snsMock = mockClient(
        SNSClient as unknown as new (...args: any[]) => any,
      );
      const throttled = Object.assign(
        new Error("Throttled publishing to +16155550100"),
        { name: "ThrottlingException" },
      );
      snsMock
        .on(PublishCommand as unknown as new (...args: any[]) => any)
        .rejects(throttled);
      const logged: unknown[] = [];
      const sink = (...args: unknown[]) => void logged.push(args);
      const logger: any = {
        info: sink,
        warn: sink,
        error: sink,
        debug: sink,
        child: () => logger,
      };
      const adapter = new SnsSmsAdapter({ client, logger });

      const result = await adapter
        .send({ to: { toE164: "+16155550100" }, body: "Hi" })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(result).toBeTruthy();
      const text = JSON.stringify(logged);
      expect(text).toContain("sns.send.retry");
      expect(text).toContain("sns.send.failed");
      expect(text).not.toContain("5550100");
    });

    it("stay out of logs and the idempotency record on a non-retryable refusal", async () => {
      const client = new SNSClient({ region: "us-east-1" });
      const snsMock = mockClient(
        SNSClient as unknown as new (...args: any[]) => any,
      );
      const refused = Object.assign(
        new Error("Invalid parameter: PhoneNumber +16155550100"),
        {
          name: "InvalidParameterException",
          $metadata: { httpStatusCode: 400 },
        },
      );
      snsMock
        .on(PublishCommand as unknown as new (...args: any[]) => any)
        .rejects(refused);
      const logged: unknown[] = [];
      const sink = (...args: unknown[]) => void logged.push(args);
      const logger: any = {
        info: sink,
        warn: sink,
        error: sink,
        debug: sink,
        child: () => logger,
      };
      const idempotency = createFakeIdempotencyPort();
      const adapter = new SnsSmsAdapter({ client, logger, idempotency });

      await expect(
        adapter.send({
          to: { toE164: "+16155550100" },
          body: "Hi",
          idempotencyKey: "sms-refused",
        }),
      ).rejects.toBeTruthy();

      expect(snsMock.commandCalls(PublishCommand as any).length).toBe(1);
      const text = JSON.stringify(logged);
      expect(text).toContain("sns.send.failed");
      expect(text).not.toContain("5550100");
      const failCalls = idempotency.__mocks.fail.mock.calls;
      expect(failCalls).toHaveLength(1);
      expect(JSON.stringify(failCalls)).not.toContain("5550100");
      expect(JSON.stringify(failCalls)).toContain("[redacted]");
    });
  });
});
