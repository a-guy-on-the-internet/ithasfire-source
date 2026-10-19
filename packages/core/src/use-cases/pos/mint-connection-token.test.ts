import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { EventRecord } from "@th/ports/repos/events";

import { posMintConnectionToken } from "./mint-connection-token";

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;
const fixedClock: ClockPort = { now: () => new Date("2026-04-29T00:00:00Z") };

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const PAYEE_ID = "00000000-0000-4000-8000-0000000000a9";
const STRIPE_ACCT = "acct_test_punkhouse";
const TOKEN_SECRET = "pst_test_abcdef123";
const TERMINAL_LOCATION_ID = "tml_test_platform_location";

function makeDeps(opts: {
  event?: Partial<EventRecord> | null;
  membership?: OrgMembership | null;
  payeeRef?: { id: string } | null;
  payee?: { id: string; stripeAccountId: string | null } | null;
  tokenError?: unknown;
  tokenSecret?: string;
  /** Existing PlatformSetting value for "pos:terminalLocationId". */
  cachedLocationId?: string | null;
}) {
  const event =
    opts.event === null
      ? null
      : ({
          id: EVENT_ID,
          orgId: ORG_ID,
          ...(opts.event ?? {}),
        } as EventRecord);

  const cachedLocationId =
    opts.cachedLocationId === undefined
      ? TERMINAL_LOCATION_ID
      : opts.cachedLocationId;

  const repos = {
    events: { getById: vi.fn(async () => event) },
    authz: {
      getOrgMembership: vi.fn(async () =>
        opts.membership === undefined
          ? ({
              orgId: ORG_ID,
              humanId: ACTOR,
              role: "SCANNER",
            } satisfies OrgMembership)
          : opts.membership,
      ),
    },
    payees: {
      getBySubject: vi.fn(async () =>
        opts.payeeRef === undefined ? { id: PAYEE_ID } : opts.payeeRef,
      ),
      getById: vi.fn(async () =>
        opts.payee === undefined
          ? { id: PAYEE_ID, stripeAccountId: STRIPE_ACCT }
          : opts.payee,
      ),
    },
    platformSettings: {
      get: vi.fn(async () =>
        cachedLocationId == null ? null : { value: cachedLocationId },
      ),
      upsert: vi.fn(async () => undefined),
    },
  } as unknown as Repos;

  const payments = {
    createTerminalConnectionToken: vi.fn(async () => {
      if (opts.tokenError) throw opts.tokenError;
      return { secret: opts.tokenSecret ?? TOKEN_SECRET };
    }),
    createTerminalLocation: vi.fn(async () => ({
      locationId: "tml_freshly_created",
    })),
  } as unknown as PaymentProcessorPort;

  return { repos, payments };
}

describe("posMintConnectionToken", () => {
  it("returns the secret on the happy path and never logs it", async () => {
    const { repos, payments } = makeDeps({});
    const info = vi.fn();
    const logger = {
      info,
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      child: vi.fn(() => logger),
      withTime: vi.fn(() => logger),
    } as any;

    const result = await posMintConnectionToken(
      { repos, authz: denyingAuthz, clock: fixedClock, payments, logger },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );

    expect(result).toEqual({
      secret: TOKEN_SECRET,
      locationId: TERMINAL_LOCATION_ID,
    });
    expect(payments.createTerminalConnectionToken).toHaveBeenCalledWith({
      stripeAccountId: STRIPE_ACCT,
    });

    // The secret must not appear in any logged payload.
    for (const call of info.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN_SECRET);
    }
  });

  it("provisions a Location on first call when none cached", async () => {
    const { repos, payments } = makeDeps({ cachedLocationId: null });

    const result = await posMintConnectionToken(
      { repos, authz: denyingAuthz, clock: fixedClock, payments },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );

    expect(result).toEqual({
      secret: TOKEN_SECRET,
      locationId: "tml_freshly_created",
    });
    expect(payments.createTerminalLocation).toHaveBeenCalledOnce();
  });

  it("throws not_found when the event does not exist", async () => {
    const { repos, payments } = makeDeps({ event: null });
    await expect(
      posMintConnectionToken(
        { repos, authz: denyingAuthz, clock: fixedClock, payments },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws forbidden when the event is personal (no orgId)", async () => {
    const { repos, payments } = makeDeps({ event: { orgId: null } });
    await expect(
      posMintConnectionToken(
        { repos, authz: denyingAuthz, clock: fixedClock, payments },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ORG_OWNED" });
  });

  it("throws forbidden when the actor lacks a scanner role on the org", async () => {
    const { repos, payments } = makeDeps({ membership: null });
    await expect(
      posMintConnectionToken(
        { repos, authz: denyingAuthz, clock: fixedClock, payments },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws invalid_input when the org has no Payee", async () => {
    const { repos, payments } = makeDeps({ payeeRef: null });
    await expect(
      posMintConnectionToken(
        { repos, authz: denyingAuthz, clock: fixedClock, payments },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "PAYEE_NOT_CONNECTED" });
  });

  it("throws invalid_input when the Payee has no stripeAccountId", async () => {
    const { repos, payments } = makeDeps({
      payee: { id: PAYEE_ID, stripeAccountId: null },
    });
    await expect(
      posMintConnectionToken(
        { repos, authz: denyingAuthz, clock: fixedClock, payments },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "PAYEE_MISSING_STRIPE_ACCOUNT" });
  });

  it("propagates Stripe errors from the port", async () => {
    const stripeErr = new Error("connect_account_capability_inactive");
    const { repos, payments } = makeDeps({ tokenError: stripeErr });
    await expect(
      posMintConnectionToken(
        { repos, authz: denyingAuthz, clock: fixedClock, payments },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toBe(stripeErr);
  });
});
