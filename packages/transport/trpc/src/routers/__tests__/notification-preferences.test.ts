import { describe, expect, it, vi } from "vitest";

import { notificationPreferencesRouter } from "../notification-preferences";
import { createCaller } from "./test-helpers";
import { createTestLogger } from "@th/test-utils";

const HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15555550123";

const SNAPSHOT = {
  in_app: { transactional: true },
  email: { transactional: true },
  sms: { transactional: true },
};

function buildFakes(options?: {
  phone?: string | null;
  phoneVerified?: boolean;
  upsertStatusError?: Error;
}) {
  const phone = options?.phone === undefined ? PHONE : options.phone;
  const phoneVerified = options?.phoneVerified ?? true;

  const notificationPrefs = {
    upsert: vi.fn(async () => {}),
    readEffective: vi.fn(async () => SNAPSHOT),
  };
  const smsConsent = {
    getByPhone: vi.fn(async () => null),
    applyDecisionIfNewer: vi.fn(async () => {
      if (options?.upsertStatusError) throw options.upsertStatusError;
      return { applied: true, record: { status: "OPTED_IN" } };
    }),
    recordEvent: vi.fn(async () => {}),
  };
  const audit = { log: vi.fn(async () => {}) };
  const humans = {
    getByIdWithIdentity: vi.fn(async () => ({
      human: { id: HUMAN_ID },
      identity: {
        authUserId: HUMAN_ID,
        email: "human@example.com",
        emailVerified: true,
        phone,
        phoneVerified,
        username: null,
        displayUsername: null,
        image: null,
      },
    })),
  };

  const repos = {
    notificationPrefs,
    smsConsent,
    audit,
    humans,
    tx: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({ smsConsent, audit }),
  };

  return { repos, notificationPrefs, smsConsent, audit, humans };
}

const makeCaller = (
  fakes: ReturnType<typeof buildFakes>,
  logger = createTestLogger(),
  reportError?: (error: unknown, context?: unknown) => void,
) =>
  createCaller(
    { notificationPreferences: notificationPreferencesRouter } as any,
    {
      actorHumanId: HUMAN_ID,
      repos: fakes.repos as any,
      logger,
      ...(reportError ? { reportError } : {}),
    } as any,
  );

describe("notificationPreferences.update — settings SMS toggle opt-in", () => {
  it("records a durable opt-in when an SMS category flips to enabled", async () => {
    const fakes = buildFakes();
    const { caller } = makeCaller(fakes);

    const result = await caller.notificationPreferences.update({
      channels: { sms: { transactional: true } },
    });

    expect(result.ok).toBe(true);
    expect(fakes.notificationPrefs.upsert).toHaveBeenCalledTimes(1);
    expect(fakes.smsConsent.applyDecisionIfNewer).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneE164: PHONE,
        status: "OPTED_IN",
        source: "settings_sms_toggle",
        actorHumanId: HUMAN_ID,
      }),
    );
    expect(fakes.smsConsent.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneE164: PHONE,
        eventType: "opt_in",
        source: "settings_sms_toggle",
      }),
    );
  });

  it("does not touch the consent ledger when SMS categories are only disabled", async () => {
    const fakes = buildFakes();
    const { caller } = makeCaller(fakes);

    await caller.notificationPreferences.update({
      channels: { sms: { transactional: false } },
    });

    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();
  });

  it("does not touch the consent ledger for non-SMS channel updates", async () => {
    const fakes = buildFakes();
    const { caller } = makeCaller(fakes);

    await caller.notificationPreferences.update({
      channels: { email: { marketing: true } },
    });

    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();
    expect(fakes.humans.getByIdWithIdentity).not.toHaveBeenCalled();
  });

  it("skips the ledger when the human has no verified phone", async () => {
    const fakes = buildFakes({ phone: PHONE, phoneVerified: false });
    const { caller } = makeCaller(fakes);

    const result = await caller.notificationPreferences.update({
      channels: { sms: { transactional: true } },
    });

    expect(result.ok).toBe(true);
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();
  });

  it("never fails the preference write when the ledger write errors (best-effort)", async () => {
    const fakes = buildFakes({
      upsertStatusError: new Error("ledger unavailable"),
    });
    // authedProcedure replaces ctx.logger with logger.child(...); pin child()
    // to the same instance so the warn spy observes the router's log call.
    const logger = createTestLogger();
    (logger.child as ReturnType<typeof vi.fn>).mockImplementation(() => logger);
    const warnSpy = logger.warn as ReturnType<typeof vi.fn>;
    const { caller } = makeCaller(fakes, logger);

    const result = await caller.notificationPreferences.update({
      channels: { sms: { transactional: true } },
    });

    expect(result.ok).toBe(true);
    // Never-texted SMS categories always read as off.
    expect(result.preferences).toEqual({
      ...SNAPSHOT,
      sms: {
        transactional: true,
        announcements: false,
        reminders: false,
        marketing: false,
        organizerMessages: false,
        billsYoureOn: false,
      },
    });
    expect(fakes.notificationPrefs.upsert).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "notification_preferences.sms_opt_in_record_failed",
      expect.objectContaining({ error: expect.stringContaining("ledger") }),
    );
  });
});

describe("notificationPreferences.update — a failed opt-in record is reported", () => {
  it("reports the swallowed ledger failure with tags; the update still succeeds", async () => {
    const fakes = buildFakes({
      upsertStatusError: new Error("ledger unavailable"),
    });
    const reportError = vi.fn();
    const { caller } = makeCaller(fakes, createTestLogger(), reportError);

    const result = await caller.notificationPreferences.update({
      channels: { sms: { transactional: true } },
    });

    expect(result.ok).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        router: "notificationPreferences.update",
        stage: "sms_opt_in_record",
        swallowed: "true",
      },
    });
  });

  it("a ledger error that echoes the phone is redacted before the log and the report", async () => {
    const fakes = buildFakes({
      upsertStatusError: new Error(
        'Unique constraint failed on phoneE164 "+16155550100"',
      ),
    });
    const reportError = vi.fn();
    const logger = createTestLogger();
    (logger.child as ReturnType<typeof vi.fn>).mockImplementation(() => logger);
    const { caller } = makeCaller(fakes, logger, reportError);

    await caller.notificationPreferences.update({
      channels: { sms: { transactional: true } },
    });

    const reported = reportError.mock.calls[0]![0] as Error;
    expect(reported.message).not.toContain("5550100");
    expect(reported.stack ?? "").not.toContain("5550100");
    for (const level of ["error", "warn", "info", "debug"] as const) {
      const fn = (logger as any)[level] as ReturnType<typeof vi.fn> | undefined;
      expect(JSON.stringify(fn?.mock.calls ?? [])).not.toContain("5550100");
    }
  });

  it("stamps the opt-in with the time the switch was flipped, not the later ledger write", async () => {
    const fakes = buildFakes();
    const FLIPPED = new Date("2026-07-07T12:00:00.000Z");
    const LATER = new Date("2026-07-07T12:00:05.000Z");
    let now = FLIPPED;
    // Time moves on while the preference write commits.
    fakes.notificationPrefs.upsert.mockImplementation(async () => {
      now = LATER;
    });
    const { caller } = createCaller(
      { notificationPreferences: notificationPreferencesRouter } as any,
      {
        actorHumanId: HUMAN_ID,
        repos: fakes.repos as any,
        logger: createTestLogger(),
        clock: { now: () => now },
      } as any,
    );

    await caller.notificationPreferences.update({
      channels: { sms: { transactional: true } },
    });

    expect(fakes.smsConsent.applyDecisionIfNewer).toHaveBeenCalledWith(
      expect.objectContaining({ status: "OPTED_IN", eventAt: FLIPPED }),
    );
  });

  it("a throwing reporter does not fail the update", async () => {
    const fakes = buildFakes({
      upsertStatusError: new Error("ledger unavailable"),
    });
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const { caller } = makeCaller(fakes, createTestLogger(), reportError);

    const result = await caller.notificationPreferences.update({
      channels: { sms: { transactional: true } },
    });

    expect(result.ok).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("notificationPreferences — SMS-eligible categories", () => {
  it("get exposes the SMS-eligible categories", async () => {
    const fakes = buildFakes();
    const { caller } = makeCaller(fakes);

    const result = await caller.notificationPreferences.get({});

    expect(result.smsEligibleCategories).toEqual(["transactional"]);
  });

  it("update exposes the SMS-eligible categories", async () => {
    const fakes = buildFakes();
    const { caller } = makeCaller(fakes);

    const result = await caller.notificationPreferences.update({
      channels: { sms: { transactional: true } },
    });

    expect(result.smsEligibleCategories).toEqual(["transactional"]);
  });

  it("refuses turning SMS on for an ineligible category and writes nothing", async () => {
    const fakes = buildFakes();
    const { caller } = makeCaller(fakes);

    await expect(
      caller.notificationPreferences.update({
        channels: { sms: { marketing: true } },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "sms_category_ineligible: marketing",
    });

    expect(fakes.notificationPrefs.upsert).not.toHaveBeenCalled();
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();
  });

  it("accepts turning SMS off for an ineligible category", async () => {
    const fakes = buildFakes();
    const { caller } = makeCaller(fakes);

    const result = await caller.notificationPreferences.update({
      channels: { sms: { marketing: false } },
    });

    expect(result.ok).toBe(true);
    expect(fakes.notificationPrefs.upsert).toHaveBeenCalledTimes(1);
  });

  it("get shows a stored SMS opt-in for a never-texted category as off", async () => {
    const fakes = buildFakes();
    const ALL_ON = {
      transactional: true,
      announcements: true,
      reminders: true,
      marketing: true,
      organizerMessages: true,
      billsYoureOn: true,
    };
    fakes.notificationPrefs.readEffective.mockResolvedValueOnce({
      in_app: ALL_ON,
      email: ALL_ON,
      sms: ALL_ON,
    } as never);
    const { caller } = makeCaller(fakes);

    const result = await caller.notificationPreferences.get({});

    expect(result.preferences.sms).toEqual({
      transactional: true,
      reminders: false,
      announcements: false,
      marketing: false,
      organizerMessages: false,
      billsYoureOn: false,
    });
    // Other channels are untouched.
    expect(result.preferences.email).toEqual(ALL_ON);
  });

  it("an SMS write also clears stale opt-ins for never-texted categories", async () => {
    const fakes = buildFakes();
    const { caller } = makeCaller(fakes);

    await caller.notificationPreferences.update({
      channels: { sms: { transactional: true } },
    });

    expect(fakes.notificationPrefs.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        delta: expect.objectContaining({
          channels: {
            sms: {
              transactional: true,
              reminders: false,
              announcements: false,
              marketing: false,
              organizerMessages: false,
              billsYoureOn: false,
            },
          },
        }),
      }),
    );
  });

  it("a write without an SMS delta leaves the SMS channel alone", async () => {
    const fakes = buildFakes();
    const { caller } = makeCaller(fakes);

    await caller.notificationPreferences.update({
      channels: { email: { marketing: false } },
    });

    expect(fakes.notificationPrefs.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        delta: expect.objectContaining({
          channels: { email: { marketing: false } },
        }),
      }),
    );
  });
});
