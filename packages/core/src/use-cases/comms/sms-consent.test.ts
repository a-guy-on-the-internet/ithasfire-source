import { describe, expect, it, vi } from "vitest";

import { recordSmsOptOut } from "./record-sms-opt-out";
import { recordSmsOptIn } from "./record-sms-opt-in";
import { ensureSmsDeliverable } from "./ensure-sms-deliverable";
import type { Repos } from "@th/ports/repos";
import type { SmsConsentRecord } from "@th/ports/repos/sms-consent";
import type { SmsProviderOptOutPort } from "@th/ports/comms/sms-opt-out";
import { makeFakeSmsConsentRepo } from "./__tests__/fake-sms-consent-repo";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const clock = { now: () => NOW };

type FakeState = {
  consents: Map<string, SmsConsentRecord>;
  events: Array<{ phoneE164: string; eventType: string }>;
  volunteerSmsOptIns: Map<string, number>; // phone -> currently-true signup count
  audit: Array<{ action: string; entityId?: string | null }>;
};

function makeFakeRepos(initial?: Partial<FakeState>): {
  repos: Repos;
  state: FakeState;
} {
  const state: FakeState = {
    consents: initial?.consents ?? new Map(),
    events: initial?.events ?? [],
    volunteerSmsOptIns: initial?.volunteerSmsOptIns ?? new Map(),
    audit: initial?.audit ?? [],
  };

  const smsConsent = makeFakeSmsConsentRepo(() => NOW);
  for (const [phone, row] of state.consents) smsConsent.consents.set(phone, row);
  state.consents = smsConsent.consents;
  state.events = smsConsent.events;

  const volunteering = {
    async clearSmsOptInByPhone(phoneE164: string) {
      const count = state.volunteerSmsOptIns.get(phoneE164) ?? 0;
      state.volunteerSmsOptIns.set(phoneE164, 0);
      return count;
    },
  };

  const audit = {
    async log(entry: { action: string; entityId?: string | null }) {
      state.audit.push({ action: entry.action, entityId: entry.entityId });
    },
  };

  const txRepos = { smsConsent, volunteering, audit };
  const repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: unknown) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  return { repos, state };
}

describe("recordSmsOptOut", () => {
  it("records OPTED_OUT, clears volunteer opt-ins, and writes audit + event", async () => {
    const { repos, state } = makeFakeRepos({
      volunteerSmsOptIns: new Map([["+15555550123", 2]]),
    });

    const out = await recordSmsOptOut(
      { repos, clock },
      {
        phoneNumber: "+1 (555) 555-0123",
        source: "provider_reconciliation",
        keyword: "STOP",
      },
    );

    expect(out).toEqual({
      status: "OPTED_OUT",
      phoneE164: "+15555550123",
      affectedVolunteerSignupCount: 2,
      applied: true,
    });
    expect(state.consents.get("+15555550123")?.status).toBe("OPTED_OUT");
    expect(state.events).toHaveLength(1);
    expect(state.audit[0]?.action).toBe("sms_consent.opted_out");
  });

  it("is idempotent on repeated STOP payloads", async () => {
    const { repos, state } = makeFakeRepos({
      volunteerSmsOptIns: new Map([["+15555550123", 1]]),
    });

    const first = await recordSmsOptOut(
      { repos, clock },
      { phoneNumber: "+15555550123", source: "inbound_stop" },
    );
    const second = await recordSmsOptOut(
      { repos, clock },
      { phoneNumber: "+15555550123", source: "inbound_stop" },
    );

    expect(first.affectedVolunteerSignupCount).toBe(1);
    expect(second.affectedVolunteerSignupCount).toBe(0);
    expect(state.consents.size).toBe(1);
    expect(state.consents.get("+15555550123")?.status).toBe("OPTED_OUT");
  });

  it("rejects a non-E.164 phone number", async () => {
    const { repos } = makeFakeRepos();
    await expect(
      recordSmsOptOut(
        { repos, clock },
        { phoneNumber: "5550123", source: "support_manual" },
      ),
    ).rejects.toMatchObject({ code: "PHONE_FORMAT_INVALID" });
  });
});

describe("recordSmsOptIn", () => {
  it("records OPTED_IN without re-enabling volunteer opt-ins", async () => {
    const { repos, state } = makeFakeRepos({
      volunteerSmsOptIns: new Map([["+15555550123", 0]]),
    });
    const clearSpy = vi.spyOn(
      repos.volunteering as unknown as {
        clearSmsOptInByPhone: (p: string) => Promise<number>;
      },
      "clearSmsOptInByPhone",
    );

    const out = await recordSmsOptIn(
      { repos, clock },
      { phoneNumber: "+15555550123", source: "user_settings" },
    );

    expect(out).toEqual({
      status: "OPTED_IN",
      phoneE164: "+15555550123",
      applied: true,
    });
    expect(state.consents.get("+15555550123")?.status).toBe("OPTED_IN");
    // Re-consent must not touch volunteer signup subscriptions.
    expect(clearSpy).not.toHaveBeenCalled();
  });
});

describe("consent ordering by event time", () => {
  const PHONE = "+15555550123";
  const T1 = new Date("2026-05-31T23:00:00.000Z");
  const T2 = new Date("2026-05-31T23:10:00.000Z");
  const T3 = new Date("2026-05-31T23:20:00.000Z");

  it("a redelivered START older than the STOP leaves the number opted out", async () => {
    const { repos, state } = makeFakeRepos();

    await recordSmsOptOut(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: T2 },
    );
    const stale = await recordSmsOptIn(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: T1 },
    );

    expect(stale).toEqual({
      status: "OPTED_OUT",
      phoneE164: PHONE,
      applied: false,
    });
    expect(state.consents.get(PHONE)?.status).toBe("OPTED_OUT");
    expect(state.consents.get(PHONE)?.optedOutAt).toEqual(T2);
    // The signal is kept in the log under its own type; no audit row.
    expect(state.events.map((e) => e.eventType)).toEqual([
      "opt_out",
      "opt_in_stale",
    ]);
    expect(state.audit.map((a) => a.action)).toEqual([
      "sms_consent.opted_out",
    ]);
  });

  it("a START newer than the STOP opts the number back in", async () => {
    const { repos, state } = makeFakeRepos();

    await recordSmsOptOut(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: T2 },
    );
    const out = await recordSmsOptIn(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: T3 },
    );

    expect(out).toMatchObject({ status: "OPTED_IN", applied: true });
    const row = state.consents.get(PHONE);
    expect(row?.status).toBe("OPTED_IN");
    expect(row?.optedInAt).toEqual(T3);
    // The opt-out time is kept, so a later stale STOP can be recognised.
    expect(row?.optedOutAt).toEqual(T2);
  });

  it("a redelivered STOP older than a newer START is ignored and clears no signups", async () => {
    const { repos, state } = makeFakeRepos({
      volunteerSmsOptIns: new Map([[PHONE, 1]]),
    });

    await recordSmsOptOut(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: T1 },
    );
    state.volunteerSmsOptIns.set(PHONE, 1); // volunteer switched back on
    await recordSmsOptIn(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: T3 },
    );
    const stale = await recordSmsOptOut(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: T2 },
    );

    expect(stale).toEqual({
      status: "OPTED_IN",
      phoneE164: PHONE,
      affectedVolunteerSignupCount: 0,
      applied: false,
    });
    expect(state.consents.get(PHONE)?.status).toBe("OPTED_IN");
    expect(state.volunteerSmsOptIns.get(PHONE)).toBe(1);
  });

  it("a START and STOP at the same instant resolve to opted out", async () => {
    const { repos, state } = makeFakeRepos();

    await recordSmsOptIn(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: T2 },
    );
    await recordSmsOptOut(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: T2 },
    );
    const again = await recordSmsOptIn(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: T2 },
    );

    expect(again.applied).toBe(false);
    expect(state.consents.get(PHONE)?.status).toBe("OPTED_OUT");
  });

  it("in-app consent (no occurredAt) uses now and beats an earlier STOP", async () => {
    const { repos, state } = makeFakeRepos();

    await recordSmsOptOut(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: T2 },
    );
    const out = await recordSmsOptIn(
      { repos, clock },
      { phoneNumber: PHONE, source: "volunteer_reminder_toggle" },
    );

    expect(out.applied).toBe(true);
    expect(state.consents.get(PHONE)?.optedInAt).toEqual(NOW);
  });

  it("clamps a future occurredAt to now", async () => {
    const { repos, state } = makeFakeRepos();
    const future = new Date(NOW.getTime() + 30 * 60 * 1000);

    await recordSmsOptOut(
      { repos, clock },
      { phoneNumber: PHONE, source: "sns_inbound", occurredAt: future },
    );

    expect(state.consents.get(PHONE)?.optedOutAt).toEqual(NOW);
  });
});

describe("ensureSmsDeliverable", () => {
  it("blocks reminder SMS when the phone is app-opted-out", async () => {
    const { repos } = makeFakeRepos();
    await repos.smsConsent.upsertStatus({
      phoneE164: "+15555550123",
      status: "OPTED_OUT",
      source: "test",
    });

    const out = await ensureSmsDeliverable(
      { repos },
      { phoneNumber: "+15555550123", category: "VOLUNTEER_REMINDER" },
    );

    expect(out).toEqual({ deliverable: false, reason: "app_opted_out" });
  });

  it("allows transactional SMS even when opted out", async () => {
    const { repos } = makeFakeRepos();
    await repos.smsConsent.upsertStatus({
      phoneE164: "+15555550123",
      status: "OPTED_OUT",
      source: "test",
    });

    const out = await ensureSmsDeliverable(
      { repos },
      { phoneNumber: "+15555550123", category: "TRANSACTIONAL" },
    );

    expect(out).toEqual({ deliverable: true, phoneE164: "+15555550123" });
  });

  it("consults the provider and blocks provider-opted-out numbers", async () => {
    const { repos } = makeFakeRepos();
    const providerOptOut: SmsProviderOptOutPort = {
      isOptedOut: vi.fn(async () => true),
      listOptedOut: vi.fn(async () => []),
    };

    const out = await ensureSmsDeliverable(
      { repos, providerOptOut },
      { phoneNumber: "+15555550124", category: "ANNOUNCEMENT" },
    );

    expect(out).toEqual({ deliverable: false, reason: "provider_opted_out" });
    expect(providerOptOut.isOptedOut).toHaveBeenCalledWith("+15555550124");
  });

  it("allows a clean number with no app or provider suppression", async () => {
    const { repos } = makeFakeRepos();
    const providerOptOut: SmsProviderOptOutPort = {
      isOptedOut: vi.fn(async () => false),
      listOptedOut: vi.fn(async () => []),
    };

    const out = await ensureSmsDeliverable(
      { repos, providerOptOut },
      { phoneNumber: "+15555550125", category: "VOLUNTEER_REMINDER" },
    );

    expect(out).toEqual({ deliverable: true, phoneE164: "+15555550125" });
  });

  it("treats an invalid phone number as not deliverable", async () => {
    const { repos } = makeFakeRepos();
    const out = await ensureSmsDeliverable(
      { repos },
      { phoneNumber: "nonsense", category: "VOLUNTEER_REMINDER" },
    );
    expect(out).toEqual({ deliverable: false, reason: "invalid_phone" });
  });
});

describe("ensureSmsDeliverable reportError on a failed provider check", () => {
  const failingProvider = (): SmsProviderOptOutPort => ({
    isOptedOut: vi.fn(async () => {
      throw new Error("provider down");
    }),
    listOptedOut: vi.fn(async () => []),
  });

  it("reports the failure with tags and still fails closed", async () => {
    const { repos } = makeFakeRepos();
    const reportError = vi.fn();

    const out = await ensureSmsDeliverable(
      { repos, providerOptOut: failingProvider(), reportError },
      { phoneNumber: "+15555550126", category: "VOLUNTEER_REMINDER" },
    );

    expect(out).toEqual({ deliverable: false, reason: "provider_opted_out" });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        useCase: "comms.ensureSmsDeliverable",
        swallowed: "true",
        stage: "provider_check",
        category: "VOLUNTEER_REMINDER",
      },
    });
  });

  it("a throwing reporter does not change the verdict", async () => {
    const { repos } = makeFakeRepos();
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    const out = await ensureSmsDeliverable(
      { repos, providerOptOut: failingProvider(), reportError },
      { phoneNumber: "+15555550127", category: "ANNOUNCEMENT" },
    );

    expect(out).toEqual({ deliverable: false, reason: "provider_opted_out" });
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
