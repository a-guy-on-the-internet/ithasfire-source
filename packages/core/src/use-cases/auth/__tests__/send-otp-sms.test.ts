import { describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { SMSPort, SMSSendInput } from "@th/ports/comms/sms";
import { CommsPortError } from "@th/ports/comms/schemas";

import { sendPhoneOtp } from "../send-phone-otp";
import { sendTwoFactorOtp } from "../send-two-factor-otp";

function makeSms(fail = false) {
  const send = vi.fn(async (_input: SMSSendInput) => {
    if (fail) throw new Error("sns down");
    return { result: { success: true, id: "m1" } };
  });
  const sms = {
    send,
    sendBatch: vi.fn(),
    health: vi.fn(),
  } as unknown as SMSPort;
  return { sms, send };
}

function makeMailer(): MailerPort {
  return {
    send: vi.fn(async () => ({ result: { success: true, id: "e1" } })),
    sendBatch: vi.fn(),
    health: vi.fn(),
  } as unknown as MailerPort;
}

// GSM-7 basic set (no extension chars) — a body outside it is sent as UCS-2
// and splits at 70 chars instead of 160.
const GSM7 =
  /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà]*$/;

describe("OTP texts", () => {
  it("phone OTP is sent from the otp number with the registered body", async () => {
    const { sms, send } = makeSms();
    await sendPhoneOtp(
      { sms },
      {
        toPhoneNumber: "+15555551111",
        productName: "Ithas Fire",
        verificationCode: "123456",
      },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0];
    expect(sent.purpose).toBe("otp");
    expect(sent.body).toBe(
      "Ithas Fire: your verification code is 123456. Don't share it with anyone.",
    );
    expect(sent.body!.length).toBeLessThanOrEqual(160);
    expect(sent.body).toMatch(GSM7);
  });

  it("phone OTP still throws SMS_SEND_FAILED when the send throws", async () => {
    const { sms } = makeSms(true);
    await expect(
      sendPhoneOtp(
        { sms },
        { toPhoneNumber: "+15555551111", productName: "Ithas Fire" },
      ),
    ).rejects.toMatchObject({ code: "SMS_SEND_FAILED" });
  });

  it("phone OTP send failure logs neither the number nor the code from the provider text", async () => {
    const sms = {
      send: vi.fn(async () => {
        throw new Error(
          "Invalid parameter: PhoneNumber Reason: +15555551111 is not valid (code 123456)",
        );
      }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    } as unknown as SMSPort;
    const logger = {
      child: () => logger,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const err = await sendPhoneOtp(
      { sms, logger: logger as never },
      {
        toPhoneNumber: "+15555551111",
        productName: "Ithas Fire",
        verificationCode: "123456",
      },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "SMS_SEND_FAILED" });
    expect(logger.warn).toHaveBeenCalledWith(
      "phone_otp_send_failed",
      expect.anything(),
    );
    const logs = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logs).not.toContain("5551111");
    expect(logs).not.toContain("123456");
    expect(JSON.stringify(err)).not.toContain("5551111");
  });

  it("2FA OTP by SMS is sent from the otp number with the registered body", async () => {
    const { sms, send } = makeSms();
    const result = await sendTwoFactorOtp(
      { sms, mailer: makeMailer() },
      {
        userId: "u1",
        email: "user@example.com",
        phoneNumber: "+15555551111",
        phoneNumberVerified: true,
        otpCode: "654321",
        productName: "Ithas Fire",
      },
    );
    expect(result).toEqual({ ok: true, method: "sms" });
    const sent = send.mock.calls[0]![0];
    expect(sent.purpose).toBe("otp");
    expect(sent.body).toBe(
      "Ithas Fire: your verification code is 654321. Don't share it with anyone.",
    );
    expect(sent.body!.length).toBeLessThanOrEqual(160);
    expect(sent.body).toMatch(GSM7);
  });

  it("2FA OTP falls back to email for an unverified phone and sends no SMS", async () => {
    const { sms, send } = makeSms();
    const result = await sendTwoFactorOtp(
      { sms, mailer: makeMailer() },
      {
        userId: "u1",
        email: "user@example.com",
        phoneNumber: "+15555551111",
        phoneNumberVerified: false,
        otpCode: "654321",
        productName: "Ithas Fire",
      },
    );
    expect(result.method).toBe("email");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("US-only OTP texts (SMS pumping guard)", () => {
  const notUs = [
    ["UK", "+447700900123"],
    ["international premium", "+882123456789"],
    ["US premium-rate 900", "+19005551234"],
    ["Jamaica behind +1", "+18765551234"],
    ["exchange starting 0", "+12120001234"],
    ["area code starting 1", "+11125551234"],
    ["national format", "2125551234"],
  ] as const;

  it.each(notUs)(
    "phone OTP refuses %s (%s) before any send",
    async (_label, number) => {
      const { sms, send } = makeSms();
      await expect(
        sendPhoneOtp(
          { sms },
          { toPhoneNumber: number, productName: "Ithas Fire" },
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([["+12125551234"], ["+13105550199"], ["+15555551111"]])(
    "phone OTP accepts the US number %s",
    async (number) => {
      const { sms, send } = makeSms();
      await sendPhoneOtp(
        { sms },
        { toPhoneNumber: number, productName: "Ithas Fire" },
      );
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(notUs)(
    "2FA with a verified %s number (%s) goes by email, never SMS",
    async (_label, number) => {
      const { sms, send } = makeSms();
      const mailer = makeMailer();
      const result = await sendTwoFactorOtp(
        { sms, mailer },
        {
          userId: "u1",
          email: "user@example.com",
          phoneNumber: number,
          phoneNumberVerified: true,
          otpCode: "654321",
          productName: "Ithas Fire",
        },
      );
      expect(result.method).toBe("email");
      expect(send).not.toHaveBeenCalled();
      expect(mailer.send).toHaveBeenCalledTimes(1);
    },
  );
});

describe("2FA OTP respects STOP and the 2FA budget", () => {
  const input = {
    userId: "u1",
    email: "user@example.com",
    phoneNumber: "+16155550100",
    phoneNumberVerified: true,
    otpCode: "654321",
    productName: "Ithas Fire",
  };

  it("a number that replied STOP gets the code by email, and spends no budget", async () => {
    const { sms, send } = makeSms();
    const mailer = makeMailer();
    const getByPhone = vi.fn(async () => ({ status: "OPTED_OUT" }) as never);
    const smsBudget = vi.fn(async () => true);

    const result = await sendTwoFactorOtp(
      { sms, mailer, smsConsent: { getByPhone }, smsBudget },
      input,
    );

    expect(result.method).toBe("email");
    expect(getByPhone).toHaveBeenCalledWith("+16155550100");
    expect(send).not.toHaveBeenCalled();
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(smsBudget).not.toHaveBeenCalled();
  });

  it.each([null, { status: "OPTED_IN" }])(
    "a number with consent %j is texted",
    async (record) => {
      const { sms, send } = makeSms();
      const result = await sendTwoFactorOtp(
        {
          sms,
          mailer: makeMailer(),
          smsConsent: { getByPhone: vi.fn(async () => record as never) },
        },
        input,
      );
      expect(result.method).toBe("sms");
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("a failed consent lookup falls back to email and is reported without the number", async () => {
    const { sms, send } = makeSms();
    const mailer = makeMailer();
    const reportError = vi.fn();
    const error = vi.fn();
    const logger = {
      child: () => logger,
      info: vi.fn(),
      warn: vi.fn(),
      error,
      debug: vi.fn(),
    };

    const result = await sendTwoFactorOtp(
      {
        sms,
        mailer,
        logger: logger as never,
        reportError,
        smsConsent: {
          getByPhone: vi.fn(async () => {
            // A database error can print its arguments, the number among them.
            throw new Error(
              'Invalid `smsConsent.findUnique()` invocation: { phoneE164: "+16155550100" }',
            );
          }),
        },
      },
      input,
    );

    expect(result.method).toBe("email");
    expect(send).not.toHaveBeenCalled();
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "2fa_otp_sms_consent_lookup_failed",
      expect.anything(),
    );
    const reported = reportError.mock.calls[0]![0] as Error;
    expect(reported.message).toContain("smsConsent.findUnique");
    expect(reported.message).not.toContain("5550100");
    expect(reported.stack ?? "").not.toContain("5550100");
    expect(JSON.stringify(error.mock.calls)).not.toContain("5550100");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { stage: "sms_consent_lookup", swallowed: "true" },
    });
    expect(JSON.stringify(reportError.mock.calls[0]![1])).not.toContain(
      "5550100",
    );
  });

  it("a throwing reporter changes nothing: still email", async () => {
    const result = await sendTwoFactorOtp(
      {
        sms: makeSms().sms,
        mailer: makeMailer(),
        reportError: () => {
          throw new Error("sentry down");
        },
        smsConsent: {
          getByPhone: vi.fn(async () => {
            throw new Error("db down");
          }),
        },
      },
      input,
    );
    expect(result.method).toBe("email");
  });

  describe("a text that fails to send", () => {
    function makeLogger() {
      const logger = {
        child: () => logger,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      return logger;
    }

    it("sends the same code by email, reports once without the number, and answers email", async () => {
      const { sms, send } = makeSms(true);
      const mailer = makeMailer();
      const reportError = vi.fn();
      const logger = makeLogger();

      const result = await sendTwoFactorOtp(
        { sms, mailer, reportError, logger: logger as never },
        input,
      );

      expect(result).toEqual({ ok: true, method: "email" });
      expect(send).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mailer.send).mock.calls[0]![0]).toMatchObject({
        to: { to: "user@example.com" },
        template: {
          key: "auth.2fa_otp",
          variables: { otpCode: "654321" },
        },
      });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(reportError.mock.calls[0]![1]).toMatchObject({
        tags: {
          useCase: "auth.sendTwoFactorOtp",
          stage: "sms_send",
          swallowed: "true",
        },
        extra: { phoneNumberLast4: "0100" },
      });
      expect(JSON.stringify(reportError.mock.calls[0]![1])).not.toContain(
        "5550100",
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "2fa_otp_sms_send_failed_email_fallback",
        expect.anything(),
      );
    });

    it("never leaks the number or the code when the provider error echoes them", async () => {
      const sms = {
        send: vi.fn(async () => {
          throw new Error(
            "Invalid parameter: PhoneNumber Reason: +16155550100 is not valid (body had 654321)",
          );
        }),
        sendBatch: vi.fn(),
        health: vi.fn(),
      } as unknown as SMSPort;
      const reportError = vi.fn();
      const logger = makeLogger();

      const result = await sendTwoFactorOtp(
        { sms, mailer: makeMailer(), reportError, logger: logger as never },
        input,
      );

      expect(result.method).toBe("email");
      expect(reportError).toHaveBeenCalledTimes(1);
      const reported = reportError.mock.calls[0]![0] as Error;
      expect(reported.message).not.toContain("5550100");
      expect(reported.message).not.toContain("654321");
      expect(reported.stack ?? "").not.toContain("5550100");
      expect(reported.stack ?? "").not.toContain("654321");
      const context = JSON.stringify(reportError.mock.calls[0]![1]);
      expect(context).not.toContain("5550100");
      expect(context).not.toContain("654321");
      const logs = JSON.stringify([
        logger.warn.mock.calls,
        logger.error.mock.calls,
        logger.info.mock.calls,
      ]);
      expect(logs).not.toContain("5550100");
      expect(logs).not.toContain("654321");
      // The redacted copy still says what went wrong.
      expect(reported.message).toContain("Invalid parameter");
    });

    it("tags the report with the provider's error code", async () => {
      const sms = {
        send: vi.fn(async () => {
          throw new CommsPortError("rate_limited", "Throttling");
        }),
        sendBatch: vi.fn(),
        health: vi.fn(),
      } as unknown as SMSPort;
      const reportError = vi.fn();

      await sendTwoFactorOtp({ sms, mailer: makeMailer(), reportError }, input);

      expect(reportError.mock.calls[0]![1]).toMatchObject({
        tags: { stage: "sms_send", errorCode: "rate_limited" },
      });
    });

    it("still throws transient when the email fallback fails too", async () => {
      const { sms } = makeSms(true);
      const mailer = makeMailer();
      vi.mocked(mailer.send).mockRejectedValueOnce(new Error("ses down"));
      const reportError = vi.fn();

      await expect(
        sendTwoFactorOtp({ sms, mailer, reportError }, input),
      ).rejects.toEqual({ code: "transient", message: "sms_send_failed" });
      expect(mailer.send).toHaveBeenCalledTimes(1);
      // The SMS failure is reported here; the throw is the caller's to report.
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("a throwing reporter changes nothing: the code still goes by email", async () => {
      const { sms } = makeSms(true);
      const mailer = makeMailer();

      const result = await sendTwoFactorOtp(
        {
          sms,
          mailer,
          reportError: () => {
            throw new Error("sentry down");
          },
        },
        input,
      );

      expect(result).toEqual({ ok: true, method: "email" });
      expect(mailer.send).toHaveBeenCalledTimes(1);
    });
  });

  it("over the 2FA budget, the code goes by email", async () => {
    const { sms, send } = makeSms();
    const smsBudget = vi.fn(async () => false);
    const result = await sendTwoFactorOtp(
      { sms, mailer: makeMailer(), smsBudget },
      input,
    );
    expect(result.method).toBe("email");
    expect(smsBudget).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
