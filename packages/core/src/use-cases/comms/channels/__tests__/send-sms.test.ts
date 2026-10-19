import { describe, expect, it, vi } from "vitest";

import type { SMSPort } from "@th/ports/comms/sms";
import type { HumanWithIdentity } from "@th/ports/repos/humans";
import type { SmsConsentRecord } from "@th/ports/repos/sms-consent";

import { sendSms, type SendSmsInput } from "../send-sms";
import type { SmsChannelPayload } from "../../renderers";

const PHONE = "+15005550006";

const HUMAN = {
  human: { name: "Ada Lovelace" },
  identity: { phone: PHONE, phoneVerified: true },
} as unknown as HumanWithIdentity;

function createSmsPort() {
  const send = vi.fn(async () => ({
    result: { success: true, id: "sms-1" },
  }));
  return { sms: { send } as unknown as SMSPort, send };
}

function consentRecord(status: SmsConsentRecord["status"]): SmsConsentRecord {
  return {
    id: "consent-1",
    phoneE164: PHONE,
    status,
    source: "test",
    reasonKeyword: null,
    providerMessageId: null,
    actorHumanId: null,
    metadata: {},
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    optedOutAt: status === "OPTED_OUT" ? new Date() : null,
    optedInAt: status === "OPTED_IN" ? new Date() : null,
  };
}

function buildInput(overrides?: Partial<SendSmsInput>): SendSmsInput {
  return {
    human: HUMAN,
    variant: "notification.generic",
    category: "transactional",
    scope: { kind: "GLOBAL" },
    enabled: true,
    payload: {
      body: "SMS copy",
      tags: [],
      metadata: {},
    } as unknown as SmsChannelPayload,
    ...overrides,
  } as SendSmsInput;
}

describe("sendSms consent gate (FR-011)", () => {
  it("skips the send when the phone's consent ledger says OPTED_OUT, even with the preference enabled", async () => {
    const { sms, send } = createSmsPort();
    const getByPhone = vi.fn(async () => consentRecord("OPTED_OUT"));

    const result = await sendSms(
      { sms, smsConsent: { getByPhone } },
      buildInput(),
    );

    expect(result).toEqual({ status: "skipped", reason: "opted_out" });
    expect(getByPhone).toHaveBeenCalledWith(PHONE);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends when no consent row exists (opt-out ledger model: absence is not a block)", async () => {
    const { sms, send } = createSmsPort();
    const getByPhone = vi.fn(async () => null);

    const result = await sendSms(
      { sms, smsConsent: { getByPhone } },
      buildInput(),
    );

    expect(result.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends when the ledger says OPTED_IN", async () => {
    const { sms, send } = createSmsPort();
    const getByPhone = vi.fn(async () => consentRecord("OPTED_IN"));

    const result = await sendSms(
      { sms, smsConsent: { getByPhone } },
      buildInput(),
    );

    expect(result.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the consent lookup errors", async () => {
    const { sms, send } = createSmsPort();
    const getByPhone = vi.fn(async () => {
      throw new Error("ledger unavailable");
    });

    const result = await sendSms(
      { sms, smsConsent: { getByPhone } },
      buildInput(),
    );

    expect(result).toEqual({
      status: "skipped",
      reason: "consent_unavailable",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("still short-circuits on disabled preference before touching the ledger", async () => {
    const { sms, send } = createSmsPort();
    const getByPhone = vi.fn(async () => consentRecord("OPTED_IN"));

    const result = await sendSms(
      { sms, smsConsent: { getByPhone } },
      buildInput({ enabled: false }),
    );

    expect(result).toEqual({ status: "skipped", reason: "channel_disabled" });
    expect(getByPhone).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("sendSms category rule (only transactional texts)", () => {
  it.each(["transactional"] as const)(
    "sends %s from the notification number",
    async (category) => {
      const { sms, send } = createSmsPort();
      const result = await sendSms(
        { sms, smsConsent: { getByPhone: vi.fn(async () => null) } },
        buildInput({ category }),
      );
      expect(result.status).toBe("sent");
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: "notification" }),
      );
    },
  );

  it.each([
    "announcements",
    "reminders",
    "marketing",
    "organizerMessages",
    "billsYoureOn",
  ] as const)(
    "never texts %s, even with the channel enabled",
    async (category) => {
      const { sms, send } = createSmsPort();
      const getByPhone = vi.fn(async () => null);
      const result = await sendSms(
        { sms, smsConsent: { getByPhone } },
        buildInput({ category, enabled: true }),
      );
      expect(result).toEqual({
        status: "skipped",
        reason: "category_not_sms_eligible",
      });
      expect(send).not.toHaveBeenCalled();
      expect(getByPhone).not.toHaveBeenCalled();
    },
  );
});

describe("sendSms reportError on swallowed failures", () => {
  const getByPhone = vi.fn(async () => null);

  it("reports a consent lookup failure, still skips", async () => {
    const { sms, send } = createSmsPort();
    const reportError = vi.fn();
    const boom = new Error("ledger unavailable");
    const result = await sendSms(
      {
        sms,
        smsConsent: {
          getByPhone: vi.fn(async () => {
            throw boom;
          }),
        },
        reportError,
      },
      buildInput(),
    );
    expect(result).toEqual({
      status: "skipped",
      reason: "consent_unavailable",
    });
    expect(send).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: expect.objectContaining({
        useCase: "comms.sendSms",
        swallowed: "true",
        stage: "consent_check",
        category: "transactional",
      }),
    });
  });

  it("reports a provider refusal (success: false), still fails", async () => {
    const send = vi.fn(async () => ({
      result: {
        success: false,
        errorCode: "invalid_input",
        errorMessage: "bad number",
      },
    }));
    const reportError = vi.fn();
    const result = await sendSms(
      {
        sms: { send } as unknown as SMSPort,
        smsConsent: { getByPhone },
        reportError,
      },
      buildInput(),
    );
    expect(result).toEqual({ status: "failed", reason: "port_error" });
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, context] = reportError.mock.calls[0]!;
    expect(context).toEqual({
      tags: expect.objectContaining({
        useCase: "comms.sendSms",
        swallowed: "true",
        stage: "send_result",
        errorCode: "invalid_input",
      }),
      extra: { errorMessage: "bad number" },
    });
  });

  it("reports a provider throw, still fails", async () => {
    const boom = new Error("sns down");
    const send = vi.fn(async () => {
      throw boom;
    });
    const reportError = vi.fn();
    const result = await sendSms(
      {
        sms: { send } as unknown as SMSPort,
        smsConsent: { getByPhone },
        reportError,
      },
      buildInput(),
    );
    expect(result).toEqual({ status: "failed", reason: "port_error" });
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: expect.objectContaining({
        useCase: "comms.sendSms",
        swallowed: "true",
        stage: "send_threw",
      }),
    });
  });

  it("redacts the number from a provider refusal before logging and reporting", async () => {
    const send = vi.fn(async () => ({
      result: {
        success: false,
        errorCode: "dependency_failed",
        errorMessage:
          "Invalid parameter: PhoneNumber +15005550006 is opted out",
      },
    }));
    const reportError = vi.fn();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    await sendSms(
      {
        sms: { send } as unknown as SMSPort,
        smsConsent: { getByPhone },
        reportError,
        logger: logger as never,
      },
      buildInput(),
    );
    const [, context] = reportError.mock.calls[0]!;
    expect(context.extra).toEqual({
      errorMessage: "Invalid parameter: PhoneNumber [redacted] is opted out",
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("5550006");
    expect(JSON.stringify(reportError.mock.calls)).not.toContain("5550006");
  });

  it("redacts the number from a provider throw before logging and reporting", async () => {
    const boom = new Error("Publish failed for 15005550006: throttled");
    boom.name = "ThrottlingException";
    const send = vi.fn(async () => {
      throw boom;
    });
    const reportError = vi.fn();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    await sendSms(
      {
        sms: { send } as unknown as SMSPort,
        smsConsent: { getByPhone },
        reportError,
        logger: logger as never,
      },
      buildInput(),
    );
    const [reported] = reportError.mock.calls[0]!;
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).name).toBe("ThrottlingException");
    expect((reported as Error).message).toBe(
      "Publish failed for [redacted]: throttled",
    );
    expect((reported as Error).stack ?? "").not.toContain("5550006");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("5550006");
  });

  it("a throwing reporter changes no result", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const consentDown = await sendSms(
      {
        sms: createSmsPort().sms,
        smsConsent: {
          getByPhone: vi.fn(async () => {
            throw new Error("ledger unavailable");
          }),
        },
        reportError,
      },
      buildInput(),
    );
    expect(consentDown).toEqual({
      status: "skipped",
      reason: "consent_unavailable",
    });

    const threw = await sendSms(
      {
        sms: {
          send: vi.fn(async () => {
            throw new Error("sns down");
          }),
        } as unknown as SMSPort,
        smsConsent: { getByPhone },
        reportError,
      },
      buildInput(),
    );
    expect(threw).toEqual({ status: "failed", reason: "port_error" });

    const refused = await sendSms(
      {
        sms: {
          send: vi.fn(async () => ({
            result: { success: false, errorCode: "transient" },
          })),
        } as unknown as SMSPort,
        smsConsent: { getByPhone },
        reportError,
      },
      buildInput(),
    );
    expect(refused).toEqual({ status: "failed", reason: "port_error" });
    expect(reportError).toHaveBeenCalledTimes(3);
  });

  it("reports nothing on a clean send", async () => {
    const reportError = vi.fn();
    await sendSms(
      { sms: createSmsPort().sms, smsConsent: { getByPhone }, reportError },
      buildInput(),
    );
    expect(reportError).not.toHaveBeenCalled();
  });
});
