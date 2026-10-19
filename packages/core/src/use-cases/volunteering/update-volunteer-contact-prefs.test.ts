import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  VolunteerAskRecord,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";

import { updateVolunteerContactPrefs } from "./update-volunteer-contact-prefs";
import type { UpdateVolunteerContactPrefsDeps } from "./update-volunteer-contact-prefs";
import { ensureSmsDeliverable } from "../comms/ensure-sms-deliverable";
import { recordSmsOptOut } from "../comms/record-sms-opt-out";
import { makeFakeSmsConsentRepo } from "../comms/__tests__/fake-sms-consent-repo";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000040";
const SHIFT_ID = "00000000-0000-4000-8000-000000000030";
const NOW = new Date("2026-06-10T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseSignup: VolunteerSignupRecord = {
  id: SIGNUP_ID,
  eventId: EVENT_ID,
  roleId: ROLE_ID,
  // A shift signup: reminded by its shift.
  shiftId: SHIFT_ID,
  humanId: ACTOR_ID,
  contactEmail: "volunteer@example.com",
  contactName: "Volunteer User",
  contactPhone: "+15555550100",
  smsOptIn: true,
  status: "APPROVED",
  hoursWorked: null,
  answers: {},
  reviewerHumanId: null,
  reviewedAt: null,
  checkedInAt: null,
  waiverAcceptedAt: null,
  notes: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeDeps(
  signup: VolunteerSignupRecord | null = baseSignup,
  identity: { phone: string | null; phoneVerified: boolean } = {
    phone: "+16155550100",
    phoneVerified: true,
  },
  /** The signup's ask, for ask signups (read only to decide the anchor). */
  ask: Partial<VolunteerAskRecord> | null = null,
  /** The signup's role's shifts (read only for a shiftless event signup). */
  roleShifts: unknown[] = [],
) {
  const smsConsent = makeFakeSmsConsentRepo(() => NOW);
  const txRepos = {
    smsConsent,
    volunteering: {
      getSignup: vi.fn(async () => signup),
      getAsk: vi.fn(async () => ask),
      getEventRole: vi.fn(async () => ({ id: ROLE_ID, shifts: roleShifts })),
      clearSmsOptInByPhone: vi.fn(async () => 0),
      updateSignupContactPrefs: vi.fn(
        async (
          id: string,
          input: { smsOptIn: boolean; contactPhone?: string },
        ) => ({
          ...(signup ?? baseSignup),
          id,
          smsOptIn: input.smsOptIn,
          ...(input.contactPhone !== undefined && {
            contactPhone: input.contactPhone,
          }),
          updatedAt: NOW,
        }),
      ),
    },
    audit: { log: vi.fn(async () => undefined) },
  };
  const deps: UpdateVolunteerContactPrefsDeps = {
    repos: {
      smsConsent,
      humans: {
        getByIdWithIdentity: vi.fn(async () => ({
          human: { id: ACTOR_ID },
          identity,
        })),
      },
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
  return { deps, txRepos, smsConsent };
}

/** A STOP received an hour before NOW, as the inbound webhook records it. */
async function replyStop(deps: UpdateVolunteerContactPrefsDeps, phone: string) {
  await recordSmsOptOut(
    { repos: deps.repos, clock: deps.clock },
    {
      phoneNumber: phone,
      source: "sns_inbound",
      keyword: "STOP",
      occurredAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    },
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// updateVolunteerContactPrefs
// ══════════════════════════════════════════════════════════════════════════════

describe("updateVolunteerContactPrefs", () => {
  it("owner disables SMS → persisted and audited", async () => {
    const { deps, txRepos } = makeDeps({ ...baseSignup, smsOptIn: true });

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: false,
    });

    expect(result.smsOptIn).toBe(false);
    expect(txRepos.volunteering.updateSignupContactPrefs).toHaveBeenCalledWith(
      SIGNUP_ID,
      { smsOptIn: false },
    );
    expect(txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_signup",
        entityId: SIGNUP_ID,
        action: "contact_prefs_updated",
        data: { humanId: ACTOR_ID, smsOptIn: false },
        at: NOW,
      }),
    );
  });

  it("owner disables SMS even with no phone on file (consent withdrawal is never blockable)", async () => {
    const { deps, txRepos } = makeDeps({
      ...baseSignup,
      contactPhone: null,
      smsOptIn: true,
    });

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: false,
    });

    expect(result.smsOptIn).toBe(false);
    expect(txRepos.volunteering.updateSignupContactPrefs).toHaveBeenCalledWith(
      SIGNUP_ID,
      { smsOptIn: false },
    );
  });

  it("owner enables SMS when a phone is on file → persisted and audited", async () => {
    const { deps, txRepos } = makeDeps({ ...baseSignup, smsOptIn: false });

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });

    expect(result.smsOptIn).toBe(true);
    expect(txRepos.volunteering.updateSignupContactPrefs).toHaveBeenCalledWith(
      SIGNUP_ID,
      { smsOptIn: true },
    );
    expect(txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact_prefs_updated",
        data: { humanId: ACTOR_ID, smsOptIn: true },
      }),
    );
  });

  it("enabling SMS on a number kept as typed stores it in E.164", async () => {
    const { deps, txRepos } = makeDeps({
      ...baseSignup,
      contactPhone: "615-555-0100",
      smsOptIn: false,
    });

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });

    expect(result.contactPhone).toBe("+16155550100");
    expect(txRepos.volunteering.updateSignupContactPrefs).toHaveBeenCalledWith(
      SIGNUP_ID,
      { smsOptIn: true, contactPhone: "+16155550100" },
    );
  });

  it("re-enabling SMS already on with a formatted number repairs the number", async () => {
    const { deps, txRepos } = makeDeps({
      ...baseSignup,
      contactPhone: "(615) 555-0100",
      smsOptIn: true,
    });

    await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });

    expect(txRepos.volunteering.updateSignupContactPrefs).toHaveBeenCalledWith(
      SIGNUP_ID,
      { smsOptIn: true, contactPhone: "+16155550100" },
    );
  });

  it("idempotent enable: already on with an E.164 number → no write", async () => {
    const { deps, txRepos } = makeDeps({
      ...baseSignup,
      contactPhone: "+16155550100",
      smsOptIn: true,
    });

    await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });

    expect(
      txRepos.volunteering.updateSignupContactPrefs,
    ).not.toHaveBeenCalled();
    expect(txRepos.audit.log).not.toHaveBeenCalled();
  });

  it("rejects enable when no phone is on file (phone_required_for_sms), no write", async () => {
    const { deps, txRepos } = makeDeps({
      ...baseSignup,
      contactPhone: null,
      smsOptIn: false,
    });

    await expect(
      updateVolunteerContactPrefs(deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        smsOptIn: true,
      }),
    ).rejects.toMatchObject({ code: "PHONE_REQUIRED_FOR_SMS" });

    expect(
      txRepos.volunteering.updateSignupContactPrefs,
    ).not.toHaveBeenCalled();
    expect(txRepos.audit.log).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only phone the same as no phone", async () => {
    const { deps, txRepos } = makeDeps({
      ...baseSignup,
      contactPhone: "   ",
      smsOptIn: false,
    });

    await expect(
      updateVolunteerContactPrefs(deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        smsOptIn: true,
      }),
    ).rejects.toMatchObject({ code: "PHONE_REQUIRED_FOR_SMS" });

    expect(
      txRepos.volunteering.updateSignupContactPrefs,
    ).not.toHaveBeenCalled();
  });

  it("rejects enable when the phone on file is not a number we text (Canada), no write", async () => {
    const { deps, txRepos } = makeDeps({
      ...baseSignup,
      contactPhone: "+14165550100",
      smsOptIn: false,
    });

    await expect(
      updateVolunteerContactPrefs(deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        smsOptIn: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "sms_requires_us_phone",
    });

    expect(
      txRepos.volunteering.updateSignupContactPrefs,
    ).not.toHaveBeenCalled();
  });

  it("rejects a non-owner actor (not_signup_owner), no write", async () => {
    const { deps, txRepos } = makeDeps({ ...baseSignup, smsOptIn: true });

    await expect(
      updateVolunteerContactPrefs(deps, {
        actorHumanId: OTHER_HUMAN_ID,
        signupId: SIGNUP_ID,
        smsOptIn: false,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(
      txRepos.volunteering.updateSignupContactPrefs,
    ).not.toHaveBeenCalled();
    expect(txRepos.audit.log).not.toHaveBeenCalled();
  });

  it("rejects when the signup is shadow-only (humanId null) — never a silent match", async () => {
    const { deps, txRepos } = makeDeps({ ...baseSignup, humanId: null });

    await expect(
      updateVolunteerContactPrefs(deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        smsOptIn: false,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(
      txRepos.volunteering.updateSignupContactPrefs,
    ).not.toHaveBeenCalled();
  });

  it("returns not_found for a missing signup", async () => {
    const { deps, txRepos } = makeDeps(null);

    await expect(
      updateVolunteerContactPrefs(deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        smsOptIn: false,
      }),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_FOUND" });

    expect(
      txRepos.volunteering.updateSignupContactPrefs,
    ).not.toHaveBeenCalled();
  });

  it("idempotent disable: already false → succeeds without a write or audit row", async () => {
    const { deps, txRepos } = makeDeps({
      ...baseSignup,
      contactPhone: null,
      smsOptIn: false,
    });

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: false,
    });

    expect(result.smsOptIn).toBe(false);
    expect(
      txRepos.volunteering.updateSignupContactPrefs,
    ).not.toHaveBeenCalled();
    expect(txRepos.audit.log).not.toHaveBeenCalled();
  });

  it("rejects invalid input (missing smsOptIn)", async () => {
    const { deps } = makeDeps();

    await expect(
      updateVolunteerContactPrefs(deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SMS consent ledger (owner 2026-10-17: switching it on counts as consent)
// ══════════════════════════════════════════════════════════════════════════════

describe("updateVolunteerContactPrefs → SMS consent ledger", () => {
  const PHONE = "+16155550100";

  it("own verified phone, opted out + toggle on → ledger OPTED_IN and the reminder guard allows it", async () => {
    const { deps, smsConsent } = makeDeps({
      ...baseSignup,
      contactPhone: PHONE,
      smsOptIn: false,
    });
    await replyStop(deps, PHONE);
    expect(
      await ensureSmsDeliverable(
        { repos: deps.repos },
        { phoneNumber: PHONE, category: "VOLUNTEER_REMINDER" },
      ),
    ).toEqual({ deliverable: false, reason: "app_opted_out" });

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });

    expect(result).toMatchObject({ smsOptIn: true, smsMayNeedStart: false });
    const row = smsConsent.consents.get(PHONE);
    expect(row?.status).toBe("OPTED_IN");
    expect(row?.source).toBe("volunteer_reminder_toggle");
    expect(row?.actorHumanId).toBe(ACTOR_ID);
    expect(row?.optedInAt).toEqual(NOW);
    expect(
      await ensureSmsDeliverable(
        { repos: deps.repos },
        { phoneNumber: PHONE, category: "VOLUNTEER_REMINDER" },
      ),
    ).toEqual({ deliverable: true, phoneE164: PHONE });
  });

  it("matches the verified phone when the signup number was kept as typed", async () => {
    const { deps, smsConsent } = makeDeps({
      ...baseSignup,
      contactPhone: "(615) 555-0100",
      smsOptIn: false,
    });

    await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });

    expect(smsConsent.consents.get(PHONE)?.status).toBe("OPTED_IN");
  });

  it("a number that is not the actor's verified phone: ledger untouched, hint set, ledger never read", async () => {
    const { deps, smsConsent } = makeDeps(
      { ...baseSignup, contactPhone: PHONE, smsOptIn: false },
      { phone: "+16155550199", phoneVerified: true },
    );
    await replyStop(deps, PHONE);
    const eventsBefore = smsConsent.events.length;
    const getByPhone = vi.spyOn(smsConsent, "getByPhone");

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });

    expect(result).toMatchObject({ smsOptIn: true, smsMayNeedStart: true });
    expect(getByPhone).not.toHaveBeenCalled();
    expect(smsConsent.consents.get(PHONE)?.status).toBe("OPTED_OUT");
    expect(smsConsent.events).toHaveLength(eventsBefore);
  });

  it("the actor's phone but unverified: ledger untouched, hint set, ledger never read", async () => {
    const { deps, smsConsent } = makeDeps(
      { ...baseSignup, contactPhone: PHONE, smsOptIn: false },
      { phone: PHONE, phoneVerified: false },
    );
    await replyStop(deps, PHONE);
    const eventsBefore = smsConsent.events.length;
    const getByPhone = vi.spyOn(smsConsent, "getByPhone");

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });

    expect(result.smsMayNeedStart).toBe(true);
    expect(getByPhone).not.toHaveBeenCalled();
    expect(smsConsent.consents.get(PHONE)?.status).toBe("OPTED_OUT");
    expect(smsConsent.events).toHaveLength(eventsBefore);
  });

  it("toggle off writes no opt-out to the ledger (2FA and other texts keep working)", async () => {
    const { deps, smsConsent } = makeDeps({
      ...baseSignup,
      contactPhone: PHONE,
      smsOptIn: true,
    });

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: false,
    });

    expect(result).toMatchObject({ smsOptIn: false, smsMayNeedStart: false });
    expect(smsConsent.consents.size).toBe(0);
    expect(smsConsent.events).toEqual([]);
  });

  it("own verified phone, ON that changed nothing: no new consent; its own standing STOP is hinted", async () => {
    const { deps, txRepos, smsConsent } = makeDeps({
      ...baseSignup,
      contactPhone: PHONE,
      smsOptIn: true,
    });
    await replyStop(deps, PHONE);
    const eventsBefore = smsConsent.events.length;

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });

    expect(
      txRepos.volunteering.updateSignupContactPrefs,
    ).not.toHaveBeenCalled();
    expect(result.smsMayNeedStart).toBe(true);
    expect(smsConsent.consents.get(PHONE)?.status).toBe("OPTED_OUT");
    expect(smsConsent.events).toHaveLength(eventsBefore);
  });

  it("a failed ledger write keeps the toggle ON, logs and reports it", async () => {
    const { deps, smsConsent } = makeDeps({
      ...baseSignup,
      contactPhone: PHONE,
      smsOptIn: false,
    });
    smsConsent.applyDecisionIfNewer = vi.fn(async () => {
      throw new Error("ledger down");
    });
    const reportError = vi.fn();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      withTime: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);

    const result = await updateVolunteerContactPrefs(
      { ...deps, reportError, logger: logger as never },
      { actorHumanId: ACTOR_ID, signupId: SIGNUP_ID, smsOptIn: true },
    );

    expect(result.smsOptIn).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "volunteering.sms_consent_record_failed",
      expect.objectContaining({
        signupId: SIGNUP_ID,
        source: "volunteer_reminder_toggle",
      }),
    );
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        useCase: "updateVolunteerContactPrefs",
        stage: "sms_consent_ledger",
        swallowed: "true",
      },
      extra: { signupId: SIGNUP_ID, source: "volunteer_reminder_toggle" },
    });
  });

  it("a throwing reporter does not fail the toggle", async () => {
    const { deps, smsConsent } = makeDeps({
      ...baseSignup,
      contactPhone: PHONE,
      smsOptIn: false,
    });
    smsConsent.applyDecisionIfNewer = vi.fn(async () => {
      throw new Error("ledger down");
    });
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    const result = await updateVolunteerContactPrefs(
      { ...deps, reportError },
      { actorHumanId: ACTOR_ID, signupId: SIGNUP_ID, smsOptIn: true },
    );

    expect(result.smsOptIn).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("updateVolunteerContactPrefs → consent time and redaction", () => {
  const PHONE = "+16155550100";

  it("a STOP landing between the toggle commit and the ledger write wins", async () => {
    const { deps, smsConsent } = makeDeps({
      ...baseSignup,
      contactPhone: PHONE,
      smsOptIn: false,
    });
    let now = NOW;
    const clock = { now: () => now };
    // The post-commit identity lookup is where the STOP slips in.
    (deps.repos as any).humans.getByIdWithIdentity = vi.fn(async () => {
      now = new Date(NOW.getTime() + 1_000);
      await recordSmsOptOut(
        { repos: deps.repos, clock },
        { phoneNumber: PHONE, source: "sns_inbound", keyword: "STOP" },
      );
      now = new Date(NOW.getTime() + 2_000);
      return {
        human: { id: ACTOR_ID },
        identity: { phone: PHONE, phoneVerified: true },
      };
    });
    const apply = vi.spyOn(smsConsent, "applyDecisionIfNewer");

    const result = await updateVolunteerContactPrefs(
      { ...deps, clock },
      { actorHumanId: ACTOR_ID, signupId: SIGNUP_ID, smsOptIn: true },
    );

    // The opt-in carries the toggle's time, not the later write's.
    expect(apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "OPTED_IN", eventAt: NOW }),
    );
    expect(smsConsent.consents.get(PHONE)?.status).toBe("OPTED_OUT");
    expect(result).toMatchObject({ smsOptIn: true, smsMayNeedStart: true });
  });

  it("a ledger error that echoes the phone is redacted before the log and the report", async () => {
    const { deps, smsConsent } = makeDeps({
      ...baseSignup,
      contactPhone: PHONE,
      smsOptIn: false,
    });
    smsConsent.applyDecisionIfNewer = vi.fn(async () => {
      throw new Error(`Unique constraint failed on phoneE164 "${PHONE}"`);
    });
    const reportError = vi.fn();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      withTime: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);

    await updateVolunteerContactPrefs(
      { ...deps, reportError, logger: logger as never },
      { actorHumanId: ACTOR_ID, signupId: SIGNUP_ID, smsOptIn: true },
    );

    expect(reportError).toHaveBeenCalledTimes(1);
    const reported = reportError.mock.calls[0]![0] as Error;
    expect(reported.message).not.toContain("5550100");
    expect(reported.stack ?? "").not.toContain("5550100");
    expect(logger.error).toHaveBeenCalled();
    for (const fn of [logger.error, logger.warn, logger.info, logger.log]) {
      expect(JSON.stringify(fn.mock.calls)).not.toContain("5550100");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ON only for a signup a reminder is sent for (volunteer-ask-reminders FR-005)
// ══════════════════════════════════════════════════════════════════════════════

describe("updateVolunteerContactPrefs → ON only where a reminder is sent", () => {
  const ASK_ID = "00000000-0000-4000-8000-0000000000a5";
  const askSignup = {
    ...baseSignup,
    eventId: null,
    shiftId: null,
    askId: ASK_ID,
    contactPhone: "+16155550100",
    smsOptIn: false,
  } as VolunteerSignupRecord;
  const oneTimeAsk = {
    id: ASK_ID,
    subjectType: "PLACE" as const,
    cadence: "ONE_TIME" as const,
    startsAt: new Date("2026-07-01T18:00:00.000Z"),
    // The organiser's old switch takes no part (R5).
    smsOptInEnabled: false,
  };

  it.each([
    [
      "an event signup on a role with no shifts (the event's start)",
      {
        ...baseSignup,
        shiftId: null,
        smsOptIn: false,
        contactPhone: "+16155550100",
      },
      null,
    ],
    ["a ONE_TIME ask signup with a start", askSignup, oneTimeAsk],
  ] as const)("allows turning SMS on for %s", async (_label, signup, ask) => {
    const { deps, txRepos } = makeDeps(
      signup as VolunteerSignupRecord,
      undefined,
      ask,
    );

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });

    expect(result.smsOptIn).toBe(true);
    expect(txRepos.volunteering.updateSignupContactPrefs).toHaveBeenCalledWith(
      SIGNUP_ID,
      { smsOptIn: true },
    );
  });

  it.each([
    ["an ONGOING ask", { ...oneTimeAsk, cadence: "ONGOING" as const }],
    ["a RECURRING ask", { ...oneTimeAsk, cadence: "RECURRING" as const }],
    ["a ONE_TIME ask without a start", { ...oneTimeAsk, startsAt: null }],
    ["an ask that no longer exists", null],
  ])(
    "refuses turning SMS on for a signup on %s, writes nothing",
    async (_label, ask) => {
      const { deps, txRepos, smsConsent } = makeDeps(askSignup, undefined, ask);

      await expect(
        updateVolunteerContactPrefs(deps, {
          actorHumanId: ACTOR_ID,
          signupId: SIGNUP_ID,
          smsOptIn: true,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "sms_reminders_unavailable",
      });
      expect(
        txRepos.volunteering.updateSignupContactPrefs,
      ).not.toHaveBeenCalled();
      expect(smsConsent.events).toEqual([]);
    },
  );

  it("refuses a shiftless signup on a role that HAS shifts (role-level, or its shift deleted)", async () => {
    const { deps, txRepos, smsConsent } = makeDeps(
      {
        ...baseSignup,
        shiftId: null,
        smsOptIn: false,
        contactPhone: "+16155550100",
      },
      undefined,
      null,
      [{ id: SHIFT_ID }],
    );

    await expect(
      updateVolunteerContactPrefs(deps, {
        actorHumanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        smsOptIn: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "sms_reminders_unavailable",
    });
    expect(txRepos.volunteering.getEventRole).toHaveBeenCalledWith(ROLE_ID);
    expect(
      txRepos.volunteering.updateSignupContactPrefs,
    ).not.toHaveBeenCalled();
    expect(smsConsent.events).toEqual([]);
  });

  it("a shift signup reads neither its role nor an ask", async () => {
    const { deps, txRepos } = makeDeps({
      ...baseSignup,
      smsOptIn: false,
      contactPhone: "+16155550100",
    });
    await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });
    expect(txRepos.volunteering.getEventRole).not.toHaveBeenCalled();
    expect(txRepos.volunteering.getAsk).not.toHaveBeenCalled();
  });

  it("an event signup never reads an ask", async () => {
    const { deps, txRepos } = makeDeps({
      ...baseSignup,
      shiftId: null,
      smsOptIn: false,
      contactPhone: "+16155550100",
    });
    await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: true,
    });
    // The shiftless event branch reads the role (no shifts) and still no ask.
    expect(txRepos.volunteering.getEventRole).toHaveBeenCalledWith(ROLE_ID);
    expect(txRepos.volunteering.getAsk).not.toHaveBeenCalled();
  });

  it("turning SMS off is always allowed, shift or not", async () => {
    const { deps, txRepos } = makeDeps({
      ...baseSignup,
      shiftId: null,
      contactPhone: "+16155550100",
      smsOptIn: true,
    });

    const result = await updateVolunteerContactPrefs(deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID,
      smsOptIn: false,
    });

    expect(result.smsOptIn).toBe(false);
    expect(txRepos.volunteering.updateSignupContactPrefs).toHaveBeenCalledWith(
      SIGNUP_ID,
      { smsOptIn: false },
    );
  });
});
