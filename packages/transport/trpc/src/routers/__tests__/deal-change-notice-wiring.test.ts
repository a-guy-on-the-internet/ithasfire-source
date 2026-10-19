import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// freeze-the-deal FR-006 at the transport: EVERY procedure whose input carries
// `frozenChange` hands its use case the notice deps (notify with the mailer
// bound, the ctx reporter, the deal link). Without them a frozen change takes
// core's `not_wired` branch and nobody is told. The use cases are mocked to
// capture (deps, input); their behaviour is pinned in core and, end to end
// through a real use case, in deals-freeze.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const captured: Array<{ name: string; deps: Record<string, unknown>; input: Record<string, unknown> }> = [];

function capture(name: string) {
  return vi.fn(async (deps: Record<string, unknown>, input: Record<string, unknown>) => {
    captured.push({ name, deps, input });
    // Stop before the output schema: only the wiring is under test.
    throw new Error("captured");
  });
}

vi.mock("@th/core/use-cases/booking-agreements/finalize-booking-agreement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/core/use-cases/booking-agreements/finalize-booking-agreement")>()),
  finalizeBookingAgreement: capture("finalizeBookingAgreement"),
}));
vi.mock("@th/core/use-cases/booking-agreements/upsert-booking-agreement-line", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/core/use-cases/booking-agreements/upsert-booking-agreement-line")>()),
  upsertBookingAgreementLine: capture("upsertBookingAgreementLine"),
}));
vi.mock("@th/core/use-cases/booking-agreements/remove-booking-agreement-line", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/core/use-cases/booking-agreements/remove-booking-agreement-line")>()),
  removeBookingAgreementLine: capture("removeBookingAgreementLine"),
}));
vi.mock("@th/core/use-cases/booking-agreements/update-booking-agreement-header", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/core/use-cases/booking-agreements/update-booking-agreement-header")>()),
  updateBookingAgreementHeader: capture("updateBookingAgreementHeader"),
}));
vi.mock("@th/core/use-cases/events/update-event-splits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/core/use-cases/events/update-event-splits")>()),
  updateEventSplits: capture("updateEventSplits"),
}));
vi.mock("@th/core/use-cases/deals/set-terms-deal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/core/use-cases/deals/set-terms-deal")>()),
  setTermsDeal: capture("setTermsDeal"),
}));
vi.mock("@th/core/use-cases/deals/set-resale-clause", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/core/use-cases/deals/set-resale-clause")>()),
  setResaleClause: capture("setResaleClause"),
}));

import { bookingAgreementsRouter } from "../booking-agreements";
import { dealsRouter } from "../deals";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const AGREEMENT = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";
const LINE = "44444444-4444-4444-8444-444444444444";
const PAYEE_HUMAN = "55555555-5555-4555-8555-555555555555";
const APP = "https://app.example.test/";

function ctxOverrides(extra: Record<string, unknown> = {}) {
  return {
    repos: {} as never,
    actorHumanId: ACTOR,
    notify: vi.fn(async () => ({ ok: true })),
    notifyWithEmail: vi.fn(async () => ({ ok: true })),
    reportError: vi.fn(),
    publicAppUrl: APP,
    ...extra,
  };
}

/** Every fenced procedure, with a valid `frozenChange: true` input. */
const calls: Array<{
  name: string;
  run: (o: ReturnType<typeof ctxOverrides>) => Promise<unknown>;
}> = [
  {
    name: "finalizeBookingAgreement",
    run: (o) =>
      createCaller(bookingAgreementsRouter, o as never).caller.finalize({
        agreementId: AGREEMENT,
        eventId: EVENT,
        frozenChange: true,
      }),
  },
  {
    name: "upsertBookingAgreementLine",
    run: (o) =>
      createCaller(bookingAgreementsRouter, o as never).caller.upsertLine({
        agreementId: AGREEMENT,
        payeeRef: { kind: "human", id: PAYEE_HUMAN },
        percent: 20,
        frozenChange: true,
      }),
  },
  {
    name: "removeBookingAgreementLine",
    run: (o) =>
      createCaller(bookingAgreementsRouter, o as never).caller.removeLine({
        agreementId: AGREEMENT,
        lineId: LINE,
        frozenChange: true,
      }),
  },
  {
    name: "updateBookingAgreementHeader",
    run: (o) =>
      createCaller(bookingAgreementsRouter, o as never).caller.updateHeader({
        agreementId: AGREEMENT,
        guaranteeCents: 50_000,
        frozenChange: true,
      }),
  },
  {
    name: "updateEventSplits",
    run: (o) =>
      createCaller(eventsRouter, o as never).caller.updateEventSplits({
        eventId: EVENT,
        kind: "PRIMARY",
        lines: [],
        clientKey: "client-key-0001",
        frozenChange: true,
      }),
  },
  {
    name: "setTermsDeal",
    run: (o) =>
      createCaller(dealsRouter, o as never).caller.setTermsDeal({
        target: { kind: "EVENT", eventId: EVENT },
        expectedDealFingerprint: "fp",
        deal: { source: "CLAUSES", clauses: [], deductions: [], remainder: { kind: "human", id: PAYEE_HUMAN } },
        frozenChange: true,
      } as never),
  },
  {
    name: "setResaleClause",
    run: (o) =>
      createCaller(dealsRouter, o as never).caller.setResaleClause({
        target: { kind: "EVENT", eventId: EVENT },
        clause: null,
        expectedVersion: null,
        frozenChange: true,
      }),
  },
];

beforeEach(() => {
  captured.length = 0;
});

describe("frozen-change notice deps reach every fenced use case", () => {
  for (const { name, run } of calls) {
    it(`${name}: frozenChange on the wire; notifyWithEmail, ctx.reportError and the deal link in its deps`, async () => {
      const o = ctxOverrides();
      await expect(run(o)).rejects.toBeTruthy();
      expect(captured.map((c) => c.name)).toEqual([name]);
      const { deps, input } = captured[0]!;
      expect(input).toMatchObject({ frozenChange: true, actorHumanId: ACTOR });
      // The mailer-bound notify: F7 is email AND in-app.
      expect(deps.notify).toBe(o.notifyWithEmail);
      expect(deps.reportError).toBe(o.reportError);
      const dealUrlFor = deps.dealUrlFor as (eventId: string) => string | null;
      expect(dealUrlFor(EVENT)).toBe(`https://app.example.test/deals/${EVENT}`);
    });
  }

  it("falls back to ctx.notify when no mailer-bound notify is wired; no link without publicAppUrl", async () => {
    for (const { name, run } of calls) {
      captured.length = 0;
      const o = ctxOverrides({ notifyWithEmail: null, publicAppUrl: null });
      await expect(run(o)).rejects.toBeTruthy();
      const { deps } = captured[0]!;
      expect(deps.notify, name).toBe(o.notify);
      expect((deps.dealUrlFor as (id: string) => string | null)(EVENT), name).toBeNull();
    }
  });
});
