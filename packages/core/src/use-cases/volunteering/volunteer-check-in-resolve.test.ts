import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  EventVolunteerRoleWithShiftsRecord,
  VolunteerShiftRecord,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";
import type { VolunteerScanTokenPort } from "@th/ports/volunteer-scan-token";

import {
  mintVolunteerScanToken,
  resolveVolunteerSignupByToken,
  searchVolunteerSignupsForCheckIn,
  getVolunteerContextForTicketScan,
} from "./volunteer-scan-tokens";
import type { VolunteerScanTokenDeps } from "./volunteer-scan-tokens";

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

// ── Constants ───────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001"; // org admin
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_EVENT_ID = "00000000-0000-4000-8000-000000000004";
const ROLE_ID_A = "00000000-0000-4000-8000-000000000010";
const ROLE_ID_B = "00000000-0000-4000-8000-000000000011";
const SHIFT_ID_A = "00000000-0000-4000-8000-000000000030";
const SHIFT_ID_B = "00000000-0000-4000-8000-000000000031";
const SIGNUP_ID_A = "00000000-0000-4000-8000-000000000040";
const SIGNUP_ID_B = "00000000-0000-4000-8000-000000000041";
const VOL_HUMAN_ID = "00000000-0000-4000-8000-000000000050";

// `now` sits inside SHIFT_A (in-progress) and 30min before SHIFT_B (imminent).
const NOW = new Date("2026-07-01T11:30:00.000Z");

// ── Fixtures ────────────────────────────────────────────────────────────────

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Summer Fest",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  startsAt: new Date("2026-07-01T09:00:00Z"),
  endsAt: new Date("2026-07-01T23:00:00Z"),
} as unknown as EventRecord;

const roleA: EventVolunteerRoleWithShiftsRecord = {
  id: ROLE_ID_A,
  eventId: EVENT_ID,
  templateId: null,
  name: "Security",
  description: null,
  capacity: 10,
  autoApprove: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [],
};

const roleB: EventVolunteerRoleWithShiftsRecord = {
  ...roleA,
  id: ROLE_ID_B,
  name: "Greeter",
};

// In progress (NOW = 11:30; shift 11:00 → 12:30)
const shiftA: VolunteerShiftRecord = {
  id: SHIFT_ID_A,
  roleId: ROLE_ID_A,
  label: "A",
  startsAt: new Date("2026-07-01T11:00:00Z"),
  endsAt: new Date("2026-07-01T12:30:00Z"),
  capacity: 5,
  notes: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

// Imminent (starts at 12:00, 30min after NOW — within 60min window)
const shiftB: VolunteerShiftRecord = {
  ...shiftA,
  id: SHIFT_ID_B,
  roleId: ROLE_ID_B,
  label: "B",
  startsAt: new Date("2026-07-01T12:00:00Z"),
  endsAt: new Date("2026-07-01T15:00:00Z"),
};

function makeSignup(
  overrides: Partial<VolunteerSignupRecord> = {},
): VolunteerSignupRecord {
  return {
    id: SIGNUP_ID_A,
    eventId: EVENT_ID,
    roleId: ROLE_ID_A,
    shiftId: SHIFT_ID_A,
    humanId: VOL_HUMAN_ID,
    contactEmail: "vol@example.com",
    contactName: "Vol Test",
    contactPhone: null,
    status: "APPROVED",
    answers: {},
    reviewerHumanId: null,
    reviewedAt: null,
    checkedInAt: null,
    notes: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ── Mock builders ───────────────────────────────────────────────────────────

function makeTxRepos(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    events: {
      getById: vi.fn(async () => baseEvent),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })),
    },
    humans: {
      getById: vi.fn(async () => ({ id: VOL_HUMAN_ID, name: "Vol Test" })),
      searchByQuery: vi.fn(async () => [
        { human: { id: VOL_HUMAN_ID, name: "Vol Test" }, identity: {} },
      ]),
    },
    volunteering: {
      listSignupsByHuman: vi.fn(async () => [makeSignup()]),
      getEventRole: vi.fn(async (id: string) =>
        id === ROLE_ID_B ? roleB : roleA,
      ),
      getShift: vi.fn(async (id: string) =>
        id === SHIFT_ID_B ? shiftB : shiftA,
      ),
    },
    ...overrides,
  };
}

function makeTokenPort(
  payload?: Partial<{
    humanId: string;
    eventId: string;
    kind: "short" | "print";
    iat: number;
    exp: number;
  }>,
  errorCode?: "volunteer_qr_expired" | "volunteer_qr_invalid",
): VolunteerScanTokenPort {
  return {
    sign: vi.fn(),
    verify: vi.fn(async () => {
      if (errorCode) {
        throw { code: errorCode, message: "test" } as const;
      }
      return {
        humanId: payload?.humanId ?? VOL_HUMAN_ID,
        eventId: payload?.eventId ?? EVENT_ID,
        kind: payload?.kind ?? "short",
        iat: payload?.iat ?? Math.floor(NOW.getTime() / 1000) - 10,
        exp: payload?.exp ?? Math.floor(NOW.getTime() / 1000) + 3600,
      };
    }),
  };
}

function makeDeps(
  txOverrides: Record<string, unknown> = {},
  tokenPort: VolunteerScanTokenPort = makeTokenPort(),
) {
  const txRepos = makeTxRepos(txOverrides);
  const deps: VolunteerScanTokenDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
    authz: denyingAuthz,
    clock: { now: () => NOW },
    volunteerScanToken: tokenPort,
  };
  return { deps, txRepos, tokenPort };
}

// ══════════════════════════════════════════════════════════════════════════════
// resolveVolunteerSignupByToken
// ══════════════════════════════════════════════════════════════════════════════

describe("resolveVolunteerSignupByToken", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    token: "fake.token.value",
  };

  it("returns a single eligible candidate with status, window, and masked contact", async () => {
    const { deps } = makeDeps();
    const result = await resolveVolunteerSignupByToken(deps, validInput);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      signupId: SIGNUP_ID_A,
      humanId: VOL_HUMAN_ID,
      eventId: EVENT_ID,
      roleId: ROLE_ID_A,
      shiftId: SHIFT_ID_A,
      status: "APPROVED",
      window: "within",
      humanContactMasked: "v***@example.com",
      alsoHoldsTicket: false,
    });
    expect(result[0].scanWindowNote).toBe("Shift in progress");
  });

  it("orders multiple signups: in-progress before imminent, then by start time", async () => {
    const { deps } = makeDeps({
      volunteering: {
        listSignupsByHuman: vi.fn(async () => [
          // imminent first to test resorting
          makeSignup({
            id: SIGNUP_ID_B,
            roleId: ROLE_ID_B,
            shiftId: SHIFT_ID_B,
          }),
          // in-progress
          makeSignup({
            id: SIGNUP_ID_A,
            roleId: ROLE_ID_A,
            shiftId: SHIFT_ID_A,
          }),
        ]),
        getEventRole: vi.fn(async (id: string) =>
          id === ROLE_ID_B ? roleB : roleA,
        ),
        getShift: vi.fn(async (id: string) =>
          id === SHIFT_ID_B ? shiftB : shiftA,
        ),
      },
    });

    const result = await resolveVolunteerSignupByToken(deps, validInput);
    expect(result).toHaveLength(2);
    expect(result[0].signupId).toBe(SIGNUP_ID_A); // in-progress wins
    expect(result[0].window).toBe("within");
    expect(result[1].signupId).toBe(SIGNUP_ID_B);
  });

  it("filters out signups for unrelated events on the same human", async () => {
    const { deps } = makeDeps({
      volunteering: {
        listSignupsByHuman: vi.fn(async () => [
          makeSignup(), // EVENT_ID
          makeSignup({ id: SIGNUP_ID_B, eventId: OTHER_EVENT_ID }),
        ]),
        getEventRole: vi.fn(async () => roleA),
        getShift: vi.fn(async () => shiftA),
      },
    });

    const result = await resolveVolunteerSignupByToken(deps, validInput);
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe(EVENT_ID);
  });

  it("throws volunteer_qr_wrong_event when the token's event does not match", async () => {
    const tokenPort = makeTokenPort({ eventId: OTHER_EVENT_ID });
    const { deps } = makeDeps({}, tokenPort);

    await expect(
      resolveVolunteerSignupByToken(deps, validInput),
    ).rejects.toMatchObject({
      code: "volunteer_qr_wrong_event",
      eventId: OTHER_EVENT_ID,
    });
  });

  it("propagates volunteer_qr_expired from the port", async () => {
    const tokenPort = makeTokenPort(undefined, "volunteer_qr_expired");
    const { deps } = makeDeps({}, tokenPort);

    await expect(
      resolveVolunteerSignupByToken(deps, validInput),
    ).rejects.toMatchObject({ code: "volunteer_qr_expired" });
  });

  it("propagates volunteer_qr_invalid from the port", async () => {
    const tokenPort = makeTokenPort(undefined, "volunteer_qr_invalid");
    const { deps } = makeDeps({}, tokenPort);

    await expect(
      resolveVolunteerSignupByToken(deps, validInput),
    ).rejects.toMatchObject({ code: "volunteer_qr_invalid" });
  });

  it("rejects when actor lacks an org-edit role", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });

    await expect(
      resolveVolunteerSignupByToken(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// searchVolunteerSignupsForCheckIn
// ══════════════════════════════════════════════════════════════════════════════

describe("searchVolunteerSignupsForCheckIn", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    query: "Vol",
  };

  it("returns eligible candidates for matched humans", async () => {
    const { deps } = makeDeps();
    const result = await searchVolunteerSignupsForCheckIn(deps, validInput);

    expect(result).toHaveLength(1);
    expect(result[0].humanId).toBe(VOL_HUMAN_ID);
  });

  it("returns empty when no humans match", async () => {
    const { deps } = makeDeps({
      humans: {
        searchByQuery: vi.fn(async () => []),
      },
    });

    const result = await searchVolunteerSignupsForCheckIn(deps, validInput);
    expect(result).toEqual([]);
  });

  it("rejects when actor lacks org-edit role", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });

    await expect(
      searchVolunteerSignupsForCheckIn(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getVolunteerContextForTicketScan
// ══════════════════════════════════════════════════════════════════════════════

describe("getVolunteerContextForTicketScan", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    humanId: VOL_HUMAN_ID,
  };

  it("returns eligible volunteer signups for the (humanId, eventId) pair", async () => {
    const { deps } = makeDeps();
    const result = await getVolunteerContextForTicketScan(deps, validInput);

    expect(result).toHaveLength(1);
    expect(result[0].humanId).toBe(VOL_HUMAN_ID);
  });

  it("returns empty array when the human has no eligible signups for the event", async () => {
    const { deps } = makeDeps({
      volunteering: {
        listSignupsByHuman: vi.fn(async () => []),
        getEventRole: vi.fn(async () => roleA),
        getShift: vi.fn(async () => shiftA),
      },
    });

    const result = await getVolunteerContextForTicketScan(deps, validInput);
    expect(result).toEqual([]);
  });

  it("excludes WITHDRAWN/REJECTED signups", async () => {
    const { deps } = makeDeps({
      volunteering: {
        listSignupsByHuman: vi.fn(async () => [
          makeSignup({ status: "WITHDRAWN" }),
          makeSignup({ id: SIGNUP_ID_B, status: "REJECTED" }),
        ]),
        getEventRole: vi.fn(async () => roleA),
        getShift: vi.fn(async () => shiftA),
      },
    });

    const result = await getVolunteerContextForTicketScan(deps, validInput);
    expect(result).toEqual([]);
  });

  it("allows actors with the SCANNER org role (read-only ORG_SCAN_ROLES)", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "SCANNER" })) },
    });

    const result = await getVolunteerContextForTicketScan(deps, validInput);
    expect(result).toHaveLength(1);
    expect(result[0].humanId).toBe(VOL_HUMAN_ID);
  });

  it("rejects actors with no org membership", async () => {
    const { deps } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });

    await expect(
      getVolunteerContextForTicketScan(deps, validInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// mint → resolve round trip
//
// The load-bearing claim for the owner-minted printable QR: the door sees no
// difference. A volunteer's own `print` token must resolve through
// `resolveVolunteerSignupByToken` exactly as an organizer-minted one does —
// same candidates, and (for the same event window) the same token bytes.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Round-tripping token port: `sign` serializes the payload, `verify` parses
 * it back. Deterministic, so two mints of the same payload produce the same
 * token string — which is what lets the test assert indistinguishability.
 */
function makeRoundTripTokenPort(): VolunteerScanTokenPort {
  return {
    sign: vi.fn(async (input) => {
      const iat = Math.floor(NOW.getTime() / 1000);
      const exp = iat + input.ttlSeconds;
      return {
        token: JSON.stringify({
          humanId: input.humanId,
          eventId: input.eventId,
          kind: input.kind,
          iat,
          exp,
          jti: input.jti,
        }),
        expiresAt: new Date(exp * 1000),
      };
    }),
    verify: vi.fn(async (token: string) => JSON.parse(token)),
  };
}

function makeRoundTripDeps() {
  const tokenPort = makeRoundTripTokenPort();
  const { deps } = makeDeps(
    {
      // ACTOR_ID is the org admin; the volunteer has no membership, so their
      // own mint takes the self-mint path.
      authz: {
        getOrgMembership: vi.fn(async ({ humanId }: { humanId: string }) =>
          humanId === ACTOR_ID ? { role: "ADMIN" } : null,
        ),
      },
      volunteering: {
        getSignup: vi.fn(async () => makeSignup()),
        listSignupsByHuman: vi.fn(async () => [makeSignup()]),
        getEventRole: vi.fn(async () => roleA),
        getShift: vi.fn(async () => shiftA),
      },
      audit: { log: vi.fn(async () => undefined) },
    },
    tokenPort,
  );
  return { deps, tokenPort };
}

describe("self-minted print token → resolveVolunteerSignupByToken", () => {
  it("resolves to the same candidates as an organizer-minted one", async () => {
    const selfRun = makeRoundTripDeps();
    const selfMint = await mintVolunteerScanToken(selfRun.deps, {
      actorHumanId: VOL_HUMAN_ID,
      signupId: SIGNUP_ID_A,
      kind: "print",
    });

    const orgRun = makeRoundTripDeps();
    const orgMint = await mintVolunteerScanToken(orgRun.deps, {
      actorHumanId: ACTOR_ID,
      signupId: SIGNUP_ID_A,
      kind: "print",
    });

    // This event ends inside the self-mint ceiling, so the two terms coincide.
    // Everything the verifier reads is identical; only `jti` differs, and that
    // is a random per-mint id (it exists so a recovered QR joins to its audit
    // row), so the scanner has nothing to discriminate provenance on.
    const selfPayload = JSON.parse(selfMint.token) as Record<string, unknown>;
    const orgPayload = JSON.parse(orgMint.token) as Record<string, unknown>;
    const { jti: selfJti, ...selfRest } = selfPayload;
    const { jti: orgJti, ...orgRest } = orgPayload;
    expect(selfRest).toEqual(orgRest);
    expect(selfJti).not.toBe(orgJti);
    expect(selfMint.expiresAt).toEqual(orgMint.expiresAt);

    const viaSelf = await resolveVolunteerSignupByToken(selfRun.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      token: selfMint.token,
    });
    const viaOrg = await resolveVolunteerSignupByToken(orgRun.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      token: orgMint.token,
    });

    expect(viaSelf).toEqual(viaOrg);
    expect(viaSelf).toHaveLength(1);
    expect(viaSelf[0]).toMatchObject({
      signupId: SIGNUP_ID_A,
      humanId: VOL_HUMAN_ID,
      eventId: EVENT_ID,
      status: "APPROVED",
    });
  });

  it("still requires an org-edit operator to resolve — the QR admits nobody by itself", async () => {
    const { deps } = makeRoundTripDeps();
    const minted = await mintVolunteerScanToken(deps, {
      actorHumanId: VOL_HUMAN_ID,
      signupId: SIGNUP_ID_A,
      kind: "print",
    });

    // The volunteer holds their own token and cannot resolve it: check-in is
    // still an organizer action.
    await expect(
      resolveVolunteerSignupByToken(deps, {
        actorHumanId: VOL_HUMAN_ID,
        eventId: EVENT_ID,
        token: minted.token,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});
