import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  EventVolunteerRoleWithShiftsRecord,
  VolunteerShiftRecord,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";
import type { TicketRecord, TicketStatus } from "@th/types";
import type { VolunteerScanTokenPort } from "@th/ports/volunteer-scan-token";
import type { MetricsPort } from "@th/ports/metric";

import { generateTicketCode } from "../../lib/tickets/generate-ticket-code";

import {
  resolveScanPayload,
  sanitizeDisplayName,
  type ResolveScanPayloadDeps,
} from "./resolve-scan-payload";

// ── IDs / fixtures ──────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_EVENT_ID = "00000000-0000-4000-8000-000000000004";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const SHIFT_ID = "00000000-0000-4000-8000-000000000020";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000030";
const VOL_HUMAN_ID = "00000000-0000-4000-8000-000000000050";
const TICKET_HOLDER_ID = "00000000-0000-4000-8000-000000000051";
const TICKET_ID = "00000000-0000-4000-8000-000000000060";

const NOW = new Date("2026-07-01T11:30:00.000Z");

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

const role: EventVolunteerRoleWithShiftsRecord = {
  id: ROLE_ID,
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

const shift: VolunteerShiftRecord = {
  id: SHIFT_ID,
  roleId: ROLE_ID,
  label: "A",
  startsAt: new Date("2026-07-01T11:00:00Z"),
  endsAt: new Date("2026-07-01T12:30:00Z"),
  capacity: 5,
  notes: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

function makeSignup(
  overrides: Partial<VolunteerSignupRecord> = {},
): VolunteerSignupRecord {
  return {
    id: SIGNUP_ID,
    eventId: EVENT_ID,
    roleId: ROLE_ID,
    shiftId: SHIFT_ID,
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

function makeTicket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id: TICKET_ID,
    eventId: EVENT_ID,
    ticketTypeId: null,
    ownerHumanId: TICKET_HOLDER_ID,
    orderId: null,
    orderItemId: null,
    seatId: null,
    code: "ABC123",
    status: "VALID" as TicketStatus,
    issuedAt: NOW,
    scannedAt: null,
    ...overrides,
  };
}

// ── Mock builders ───────────────────────────────────────────────────────────

type Overrides = {
  events?: Partial<{
    getById: ReturnType<typeof vi.fn>;
  }>;
  authz?: Partial<{
    getOrgMembership: ReturnType<typeof vi.fn>;
  }>;
  humans?: Partial<{
    getById: ReturnType<typeof vi.fn>;
    getByIdWithIdentity: ReturnType<typeof vi.fn>;
  }>;
  volunteering?: Partial<{
    listSignupsByHuman: ReturnType<typeof vi.fn>;
    getEventRole: ReturnType<typeof vi.fn>;
    getShift: ReturnType<typeof vi.fn>;
  }>;
  tickets?: Partial<{
    getByCode: ReturnType<typeof vi.fn>;
    findByEventAndHuman: ReturnType<typeof vi.fn>;
  }>;
};

function makeTxRepos(overrides: Overrides = {}): Record<string, unknown> {
  return {
    events: {
      getById: vi.fn(async () => baseEvent),
      ...overrides.events,
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })),
      ...overrides.authz,
    },
    humans: {
      getById: vi.fn(async (id: string) =>
        id === TICKET_HOLDER_ID
          ? { id, name: "Jenny Rosen" }
          : { id, name: "Vol Test" },
      ),
      // Verified unless a test says otherwise (B2: an unverified holder's
      // tickets are not surfaced).
      getByIdWithIdentity: vi.fn(async () => ({
        identity: { emailVerified: true },
      })),
      ...overrides.humans,
    },
    volunteering: {
      listSignupsByHuman: vi.fn(async () => [makeSignup()]),
      getEventRole: vi.fn(async () => role),
      getShift: vi.fn(async () => shift),
      ...overrides.volunteering,
    },
  };
}

function makeRepos(overrides: Overrides = {}): Repos {
  const txRepos = makeTxRepos(overrides);
  const tickets = {
    getByCode: vi.fn(async () => null),
    findByEventAndHuman: vi.fn(async () => []),
    ...overrides.tickets,
  };
  const humans = txRepos.humans as { getById: ReturnType<typeof vi.fn> };
  return {
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
      fn(txRepos as TxRepos),
    ),
    tickets,
    humans,
  } as unknown as Repos;
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

function makeMetrics() {
  return {
    increment: vi.fn(),
    record: vi.fn(),
  } satisfies MetricsPort;
}

function makeDeps(
  overrides: Overrides = {},
  tokenPort: VolunteerScanTokenPort = makeTokenPort(),
  metrics: MetricsPort = makeMetrics(),
): ResolveScanPayloadDeps {
  return {
    repos: makeRepos(overrides),
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as AuthZPort,
    volunteerScanToken: tokenPort,
    clock: { now: () => NOW } as ClockPort,
    metrics,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// resolveScanPayload
// ══════════════════════════════════════════════════════════════════════════════

describe("resolveScanPayload — input parsing", () => {
  const validBase = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    raw: "ABC123",
  };

  it("rejects empty raw", async () => {
    await expect(
      resolveScanPayload(makeDeps(), { ...validBase, raw: "" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects raw exceeding 4096 chars", async () => {
    await expect(
      resolveScanPayload(makeDeps(), { ...validBase, raw: "x".repeat(4097) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects unknown keys (strict)", async () => {
    await expect(
      resolveScanPayload(makeDeps(), { ...validBase, foo: "bar" } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("resolveScanPayload — RBAC / event lookup", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    raw: "ABC123",
  };

  it("throws not_found when the event does not exist", async () => {
    const deps = makeDeps({
      events: { getById: vi.fn(async () => null) },
    });
    await expect(resolveScanPayload(deps, validInput)).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
  });

  it("throws forbidden when the actor lacks ORG_SCAN_ROLES", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    await expect(resolveScanPayload(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("allows actors with the SCANNER role", async () => {
    const deps = makeDeps(
      {
        authz: { getOrgMembership: vi.fn(async () => ({ role: "SCANNER" })) },
        tickets: {
          getByCode: vi.fn(async () => makeTicket()),
          findByEventAndHuman: vi.fn(async () => []),
        },
        volunteering: {
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => role),
          getShift: vi.fn(async () => shift),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
    );
    const result = await resolveScanPayload(deps, validInput);
    expect(result.kind).toBe("ticket");
  });
});

describe("resolveScanPayload — volunteer branch", () => {
  it("returns kind=volunteer with sanitized displayName and candidates (no PII)", async () => {
    const deps = makeDeps(
      {
        humans: {
          getById: vi.fn(async (id: string) =>
            id === VOL_HUMAN_ID ? { id, name: "Jenny Rosen" } : null,
          ),
        },
      },
      makeTokenPort(),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "vol.token.value",
    });

    expect(result.kind).toBe("volunteer");
    if (result.kind !== "volunteer") return;
    expect(result.humanId).toBe(VOL_HUMAN_ID);
    expect(result.displayName).toBe("Jenny R.");
    expect(result.candidates).toHaveLength(1);
    expect(result.alsoHoldsTicket).toEqual([]);

    // No raw PII fields exposed.
    const json = JSON.stringify(result);
    expect(json).not.toContain("vol@example.com");
    expect(json).not.toContain("vol.token.value");
  });

  it("returns wrong_event when token's eventId differs from the input eventId", async () => {
    const deps = makeDeps({}, makeTokenPort({ eventId: OTHER_EVENT_ID }));

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "vol.token.value",
    });

    expect(result).toMatchObject({
      kind: "wrong_event",
      payloadKind: "volunteer",
      scannedEventId: OTHER_EVENT_ID,
    });
  });

  it("discloses NO ticket codes when the bearer has no eligible signup (stale paper QR)", async () => {
    // The scenario this exists for: a volunteer prints a QR, then withdraws /
    // is rejected / loses approval. Someone else finds the paper and presents
    // it. The token still verifies — it is a stateless bearer artifact that
    // NAMES a human, it does not prove the bearer IS that human — but the
    // live signup re-read returns zero candidates.
    //
    // The operator screen renders `ticketCode` with a one-tap admit beside it,
    // so leaking it here would hand a finder the victim's ticket codes while
    // the volunteer section says "no eligible signups".
    const findByEventAndHuman = vi.fn(async () => [
      {
        ticketId: TICKET_ID,
        ticketCode: "SECRET-CODE-1",
        status: "VALID" as TicketStatus,
        scannedAt: null,
      },
    ]);
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => null),
          findByEventAndHuman,
        },
        volunteering: {
          // Withdrawn/rejected since minting: no eligible signups remain.
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => null),
          getShift: vi.fn(async () => null),
        },
      },
      makeTokenPort(),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "vol.token.value",
    });

    expect(result.kind).toBe("volunteer");
    if (result.kind !== "volunteer") return;
    expect(result.candidates).toEqual([]);
    expect(result.alsoHoldsTicket).toEqual([]);
    // Not merely filtered out of the response — never read at all.
    expect(findByEventAndHuman).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("SECRET-CODE-1");
  });

  it("surfaces VALID tickets in alsoHoldsTicket as {ticketId, ticketCode, status, scannedAt} (FR-006)", async () => {
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => null),
          findByEventAndHuman: vi.fn(async () => [
            {
              ticketId: TICKET_ID,
              ticketCode: "ABC123",
              status: "VALID" as TicketStatus,
              scannedAt: null,
            },
          ]),
        },
      },
      makeTokenPort(),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "vol.token.value",
    });

    expect(result.kind).toBe("volunteer");
    if (result.kind !== "volunteer") return;
    expect(result.alsoHoldsTicket).toEqual([
      {
        ticketId: TICKET_ID,
        ticketCode: "ABC123",
        status: "VALID",
        scannedAt: null,
      },
    ]);
  });

  it("B2: surfaces no tickets for a volunteer whose account email is unverified", async () => {
    const findByEventAndHuman = vi.fn(async () => [
      {
        ticketId: TICKET_ID,
        ticketCode: "VICTIM-CODE",
        status: "VALID" as TicketStatus,
        scannedAt: null,
      },
    ]);
    const deps = makeDeps(
      {
        humans: {
          getByIdWithIdentity: vi.fn(async () => ({
            identity: { emailVerified: false },
          })),
        },
        tickets: {
          getByCode: vi.fn(async () => null),
          findByEventAndHuman,
        },
      },
      makeTokenPort(),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "vol.token.value",
    });

    expect(result.kind).toBe("volunteer");
    if (result.kind !== "volunteer") return;
    expect(result.alsoHoldsTicket).toEqual([]);
    expect(findByEventAndHuman).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("VICTIM-CODE");
  });

  it("surfaces SCANNED tickets in alsoHoldsTicket with the scannedAt timestamp", async () => {
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => null),
          findByEventAndHuman: vi.fn(async () => [
            {
              ticketId: TICKET_ID,
              ticketCode: "ABC123",
              status: "SCANNED" as TicketStatus,
              scannedAt: NOW,
            },
          ]),
        },
      },
      makeTokenPort(),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "vol.token.value",
    });

    expect(result.kind).toBe("volunteer");
    if (result.kind !== "volunteer") return;
    expect(result.alsoHoldsTicket).toEqual([
      {
        ticketId: TICKET_ID,
        ticketCode: "ABC123",
        status: "SCANNED",
        scannedAt: NOW,
      },
    ]);
  });

  it("omits REFUNDED / INVALID / LISTED tickets from alsoHoldsTicket", async () => {
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => null),
          findByEventAndHuman: vi.fn(async () => [
            {
              ticketId: "t-1",
              ticketCode: "X1",
              status: "REFUNDED" as TicketStatus,
              scannedAt: null,
            },
            {
              ticketId: "t-2",
              ticketCode: "X2",
              status: "INVALID" as TicketStatus,
              scannedAt: null,
            },
            {
              ticketId: "t-3",
              ticketCode: "X3",
              status: "LISTED" as TicketStatus,
              scannedAt: null,
            },
          ]),
        },
      },
      makeTokenPort(),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "vol.token.value",
    });

    expect(result.kind).toBe("volunteer");
    if (result.kind !== "volunteer") return;
    expect(result.alsoHoldsTicket).toEqual([]);
  });
});

describe("resolveScanPayload — ticket branch", () => {
  it("returns kind=ticket with status, scannedAt, and sanitized displayName", async () => {
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () =>
            makeTicket({ status: "VALID" as TicketStatus }),
          ),
          findByEventAndHuman: vi.fn(async () => []),
        },
        volunteering: {
          // owner has no signups
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => role),
          getShift: vi.fn(async () => shift),
        },
      },
      // Ticket-only payload: token verify always rejects.
      makeTokenPort(undefined, "volunteer_qr_invalid"),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "abc123",
    });

    expect(result).toMatchObject({
      kind: "ticket",
      ticketId: TICKET_ID,
      ticketCode: "ABC123",
      status: "VALID",
      holderHumanId: TICKET_HOLDER_ID,
      holderDisplay: "Jenny R.",
    });
    if (result.kind !== "ticket") return;
    expect(result.alsoVolunteering).toEqual([]);
  });

  it("trims surrounding whitespace but passes the code through VERBATIM (no case folding)", async () => {
    // Regression: the resolver used to `.toUpperCase()` before the lookup.
    // `Ticket.code` is a case-sensitive unique column and real codes are
    // lowercase, so that guaranteed a miss for every minted ticket.
    const getByCode = vi.fn(async () => makeTicket({ code: "abc123" }));
    const deps = makeDeps(
      {
        tickets: {
          getByCode,
          findByEventAndHuman: vi.fn(async () => []),
        },
        volunteering: {
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => role),
          getShift: vi.fn(async () => shift),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
    );

    await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "  abc123  ",
    });

    expect(getByCode).toHaveBeenCalledWith("abc123");
  });

  it("returns ticket with status=SCANNED for already-scanned ticket", async () => {
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () =>
            makeTicket({ status: "SCANNED" as TicketStatus, scannedAt: NOW }),
          ),
          findByEventAndHuman: vi.fn(async () => []),
        },
        volunteering: {
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => role),
          getShift: vi.fn(async () => shift),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "ABC123",
    });

    expect(result.kind).toBe("ticket");
    if (result.kind !== "ticket") return;
    expect(result.status).toBe("SCANNED");
    expect(result.scannedAt).toEqual(NOW);
  });

  it("returns wrong_event when ticket belongs to a different event", async () => {
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => makeTicket({ eventId: OTHER_EVENT_ID })),
          findByEventAndHuman: vi.fn(async () => []),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "ABC123",
    });

    expect(result).toMatchObject({
      kind: "wrong_event",
      payloadKind: "ticket",
      scannedEventId: OTHER_EVENT_ID,
    });
  });

  it("populates alsoVolunteering when ticket owner also has eligible signups", async () => {
    const deps = makeDeps(
      {
        tickets: {
          // owner is also the volunteer human, so the volunteer search
          // returns a candidate
          getByCode: vi.fn(async () =>
            makeTicket({ ownerHumanId: VOL_HUMAN_ID }),
          ),
          findByEventAndHuman: vi.fn(async () => []),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "ABC123",
    });

    expect(result.kind).toBe("ticket");
    if (result.kind !== "ticket") return;
    expect(result.alsoVolunteering).toHaveLength(1);
    expect(result.alsoVolunteering[0].humanId).toBe(VOL_HUMAN_ID);
  });
});

describe("resolveScanPayload — unknown / dispatch order", () => {
  it("returns kind=unknown(reason=malformed) for garbage payloads", async () => {
    const deps = makeDeps({}, makeTokenPort(undefined, "volunteer_qr_invalid"));

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "!!!",
    });

    expect(result).toEqual({ kind: "unknown", reason: "malformed" });
  });

  it("returns kind=unknown(reason=ticket_not_found) when ticket-shaped code does not exist", async () => {
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => null),
          findByEventAndHuman: vi.fn(async () => []),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "GHOST1",
    });

    expect(result).toEqual({ kind: "unknown", reason: "ticket_not_found" });
  });

  it("returns kind=unknown(reason=signature_failed) when a JWT-shaped payload fails verification", async () => {
    const deps = makeDeps(
      {
        tickets: {
          // The ticket branch should never be consulted for a JWT-shape
          // payload (it's not in TICKET_CODE_PATTERN), but make sure of it.
          getByCode: vi.fn(async () => null),
          findByEventAndHuman: vi.fn(async () => []),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "aaaa.bbbb.cccc",
    });

    expect(result).toEqual({ kind: "unknown", reason: "signature_failed" });
  });

  it("propagates operational errors from volunteerScanToken.verify (e.g. not_configured)", async () => {
    const tokenPort: VolunteerScanTokenPort = {
      sign: vi.fn(),
      verify: vi.fn(async () => {
        throw { code: "not_configured", message: "missing key" } as const;
      }),
    };
    const deps = makeDeps({}, tokenPort);

    await expect(
      resolveScanPayload(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        raw: "ABC123",
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });

  it("dispatches volunteer-first when payload is a valid token (FR-004)", async () => {
    // Even though the raw could plausibly look like a ticket code, a
    // successful token verify must win.
    const tokenLooksLikeTicket = "ABC123";
    const deps = makeDeps(
      {
        tickets: {
          // Ensure if the resolver mistakenly fell through, this would also
          // succeed — proving the volunteer branch wins.
          getByCode: vi.fn(async () => makeTicket()),
          findByEventAndHuman: vi.fn(async () => []),
        },
      },
      makeTokenPort(),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: tokenLooksLikeTicket,
    });

    expect(result.kind).toBe("volunteer");
  });

  it("falls through to ticket branch when token verify throws (signature/expired)", async () => {
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => makeTicket()),
          findByEventAndHuman: vi.fn(async () => []),
        },
        volunteering: {
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => role),
          getShift: vi.fn(async () => shift),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_expired"),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "ABC123",
    });

    expect(result.kind).toBe("ticket");
  });
});

describe("resolveScanPayload — telemetry", () => {
  it("increments scan.resolve.attempt and scan.resolve.result with the kind tag", async () => {
    const metrics = makeMetrics();
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => makeTicket()),
          findByEventAndHuman: vi.fn(async () => []),
        },
        volunteering: {
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => role),
          getShift: vi.fn(async () => shift),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
      metrics,
    );

    await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "ABC123",
    });

    expect(metrics.increment).toHaveBeenCalledWith(
      "scan.resolve.attempt",
      expect.objectContaining({ eventId: EVENT_ID }),
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      "scan.resolve.result",
      expect.objectContaining({ kind: "ticket" }),
    );
  });

  it("tags wrong_event results with payloadKind", async () => {
    const metrics = makeMetrics();
    const deps = makeDeps(
      {},
      makeTokenPort({ eventId: OTHER_EVENT_ID }),
      metrics,
    );

    await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "vol.token.value",
    });

    expect(metrics.increment).toHaveBeenCalledWith(
      "scan.resolve.result",
      expect.objectContaining({
        kind: "wrong_event",
        payloadKind: "volunteer",
      }),
    );
  });

  it("does not throw when metrics.increment throws (degrades to debug log)", async () => {
    const metrics: MetricsPort = {
      increment: vi.fn(() => {
        throw new Error("metrics backend down");
      }),
      record: vi.fn(),
    };
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => makeTicket()),
          findByEventAndHuman: vi.fn(async () => []),
        },
        volunteering: {
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => role),
          getShift: vi.fn(async () => shift),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
      metrics,
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "ABC123",
    });

    expect(result.kind).toBe("ticket");
    // attempt + result both attempted, both swallowed
    expect(metrics.increment).toHaveBeenCalledTimes(2);
  });

  it("tags volunteer results with crossContextTicketCount when the human also holds tickets", async () => {
    const metrics = makeMetrics();
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => null),
          findByEventAndHuman: vi.fn(async () => [
            {
              ticketId: "t-1",
              ticketCode: "AAA111",
              status: "VALID" as TicketStatus,
              scannedAt: null,
            },
            {
              ticketId: "t-2",
              ticketCode: "BBB222",
              status: "SCANNED" as TicketStatus,
              scannedAt: NOW,
            },
          ]),
        },
      },
      makeTokenPort(),
      metrics,
    );

    await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "vol.token.value",
    });

    expect(metrics.increment).toHaveBeenCalledWith(
      "scan.resolve.result",
      expect.objectContaining({
        kind: "volunteer",
        crossContextTicket: "true",
        crossContextTicketCount: "2",
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// hf:// structured ticket-URL form
// ══════════════════════════════════════════════════════════════════════════════

describe("resolveScanPayload — hf:// structured ticket URL", () => {
  it("resolves hf://<matching-eventId>/<valid-code> via the ticket branch with full enrichment", async () => {
    const tokenVerify = vi.fn();
    const tokenPort: VolunteerScanTokenPort = {
      sign: vi.fn(),
      verify: tokenVerify,
    };
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => makeTicket()),
          findByEventAndHuman: vi.fn(async () => []),
        },
        volunteering: {
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => role),
          getShift: vi.fn(async () => shift),
        },
      },
      tokenPort,
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: `hf://${EVENT_ID}/ABC123`,
    });

    expect(result).toMatchObject({
      kind: "ticket",
      ticketId: TICKET_ID,
      ticketCode: "ABC123",
      status: "VALID",
      holderHumanId: TICKET_HOLDER_ID,
      holderDisplay: "Jenny R.",
    });
    // The structured short-circuit must skip the volunteer-verify call
    // (NFR-002): a JWT-shape verify never happens for hf:// payloads.
    expect(tokenVerify).not.toHaveBeenCalled();
  });

  it("returns wrong_event with payloadKind=ticket and the scanned eventId, without a tickets.getByCode call", async () => {
    const getByCode = vi.fn();
    const tokenVerify = vi.fn();
    const tokenPort: VolunteerScanTokenPort = {
      sign: vi.fn(),
      verify: tokenVerify,
    };
    const deps = makeDeps(
      {
        tickets: {
          getByCode,
          findByEventAndHuman: vi.fn(async () => []),
        },
      },
      tokenPort,
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: `hf://${OTHER_EVENT_ID}/ABC123`,
    });

    expect(result).toEqual({
      kind: "wrong_event",
      payloadKind: "ticket",
      scannedEventId: OTHER_EVENT_ID,
    });
    expect(getByCode).not.toHaveBeenCalled();
    expect(tokenVerify).not.toHaveBeenCalled();
  });

  it("accepts a case-insensitive scheme/uuid but passes the embedded code through VERBATIM", async () => {
    // Regression: the hf:// branch used to `.toUpperCase()` the code group.
    const getByCode = vi.fn(async () => makeTicket({ code: "abc123" }));
    const deps = makeDeps(
      {
        tickets: {
          getByCode,
          findByEventAndHuman: vi.fn(async () => []),
        },
        volunteering: {
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => role),
          getShift: vi.fn(async () => shift),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
    );

    await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: `HF://${EVENT_ID}/abc123`,
    });

    expect(getByCode).toHaveBeenCalledWith("abc123");
  });

  it("returns unknown(ticket_not_found) when the matching-event URL points to an unknown ticket code", async () => {
    const getByCode = vi.fn(async () => null);
    const tokenVerify = vi.fn();
    const tokenPort: VolunteerScanTokenPort = {
      sign: vi.fn(),
      verify: tokenVerify,
    };
    const deps = makeDeps(
      {
        tickets: {
          getByCode,
          findByEventAndHuman: vi.fn(async () => []),
        },
      },
      tokenPort,
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: `hf://${EVENT_ID}/NOTAREALCODE`,
    });

    expect(result).toEqual({ kind: "unknown", reason: "ticket_not_found" });
    expect(getByCode).toHaveBeenCalledWith("NOTAREALCODE");
    // Structured ticket URL short-circuits before volunteer verify.
    expect(tokenVerify).not.toHaveBeenCalled();
  });

  it("returns wrong_event with the ticket row's true eventId when the URL declares a different event (defense-in-depth)", async () => {
    // URL says EVENT_ID, but the ticket row is bound to OTHER_EVENT_ID.
    // The resolver must trust the row and surface OTHER_EVENT_ID, not the
    // URL-declared one.
    const getByCode = vi.fn(async () =>
      makeTicket({ eventId: OTHER_EVENT_ID }),
    );
    const tokenVerify = vi.fn();
    const tokenPort: VolunteerScanTokenPort = {
      sign: vi.fn(),
      verify: tokenVerify,
    };
    const deps = makeDeps(
      {
        tickets: {
          getByCode,
          findByEventAndHuman: vi.fn(async () => []),
        },
      },
      tokenPort,
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: `hf://${EVENT_ID}/ABC123`,
    });

    expect(result).toEqual({
      kind: "wrong_event",
      payloadKind: "ticket",
      scannedEventId: OTHER_EVENT_ID,
    });
    expect(getByCode).toHaveBeenCalledWith("ABC123");
    expect(tokenVerify).not.toHaveBeenCalled();
  });

  it("falls through to the existing branches for malformed hf URLs (e.g. bad uuid)", async () => {
    // Not a valid UUID-shape segment, so HF_TICKET_URL_PATTERN does not
    // match and dispatch falls through to volunteer → ticket → unknown.
    const tokenVerify = vi.fn(async () => {
      throw { code: "volunteer_qr_invalid", message: "test" } as const;
    });
    const tokenPort: VolunteerScanTokenPort = {
      sign: vi.fn(),
      verify: tokenVerify,
    };
    const deps = makeDeps(
      {
        tickets: {
          getByCode: vi.fn(async () => null),
          findByEventAndHuman: vi.fn(async () => []),
        },
      },
      tokenPort,
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "hf://not-a-uuid/ABC123",
    });

    // Doesn't match the structured URL, doesn't match a ticket-code (has
    // slashes and colons), volunteer verify rejects → unknown(malformed).
    expect(result).toEqual({ kind: "unknown", reason: "malformed" });
    expect(tokenVerify).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// sanitizeDisplayName
// ══════════════════════════════════════════════════════════════════════════════

describe("sanitizeDisplayName", () => {
  it("formats first + last to 'First L.'", () => {
    expect(sanitizeDisplayName("Jenny Rosen")).toBe("Jenny R.");
  });

  it("uses the last token as the surname when there are middle names", () => {
    expect(sanitizeDisplayName("Jenny Marie Rosen")).toBe("Jenny R.");
  });

  it("returns a single-token name unchanged", () => {
    expect(sanitizeDisplayName("Madonna")).toBe("Madonna");
  });

  it("returns null for empty / nullish input", () => {
    expect(sanitizeDisplayName(null)).toBeNull();
    expect(sanitizeDisplayName(undefined)).toBeNull();
    expect(sanitizeDisplayName("")).toBeNull();
    expect(sanitizeDisplayName("   ")).toBeNull();
  });

  it("upper-cases the surname initial", () => {
    expect(sanitizeDisplayName("anna lowe")).toBe("anna L.");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// REGRESSION — real minted / seeded ticket-code shapes
//
// The entire scan pipeline was broken in production while this suite was
// green, because every existing test used the fictional code "TK123456" —
// pure-uppercase alnum, a shape the system has never minted. These tests call
// the REAL generator and use the REAL seed shape so the fixtures cannot drift
// away from production again.
// ══════════════════════════════════════════════════════════════════════════════

describe("resolveScanPayload — real ticket-code shapes (regression)", () => {
  function makeTicketDeps(code: string) {
    const getByCode = vi.fn(async () => makeTicket({ code }));
    const deps = makeDeps(
      {
        tickets: {
          getByCode,
          findByEventAndHuman: vi.fn(async () => []),
        },
        volunteering: {
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => role),
          getShift: vi.fn(async () => shift),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
    );
    return { deps, getByCode };
  }

  it("sanity-checks that generateTicketCode() really produces the shape we claim", () => {
    const code = generateTicketCode();
    // `tk_` + 24 lowercase hex chars. If this ever changes, the resolver's
    // TICKET_CODE_PATTERN must be revisited — hence the assertion.
    expect(code).toMatch(/^tk_[0-9a-f]{24}$/);
    expect(code).toContain("_");
    expect(code).toBe(code.toLowerCase());
  });

  it("resolves a freshly generated generateTicketCode() payload (the shape every real QR carries)", async () => {
    const code = generateTicketCode();
    const { deps, getByCode } = makeTicketDeps(code);

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: code,
    });

    // Before the fix this returned { kind: "unknown", reason: "malformed" }
    // because `^[A-Z0-9]{6,64}$` rejected both the `_` and the lowercase hex.
    expect(getByCode).toHaveBeenCalledWith(code);
    expect(result).toMatchObject({
      kind: "ticket",
      ticketId: TICKET_ID,
      ticketCode: code,
      status: "VALID",
    });
  });

  it("resolves the hyphenated seed/POS code shape (SEED-E01-001-1)", async () => {
    const code = "SEED-E01-001-1";
    const { deps, getByCode } = makeTicketDeps(code);

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: code,
    });

    expect(getByCode).toHaveBeenCalledWith(code);
    expect(result).toMatchObject({ kind: "ticket", ticketCode: code });
  });

  it("resolves the hf://<uuid>/<code> form carrying a real generated code", async () => {
    const code = generateTicketCode();
    const { deps, getByCode } = makeTicketDeps(code);

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: `hf://${EVENT_ID}/${code}`,
    });

    expect(getByCode).toHaveBeenCalledWith(code);
    expect(result).toMatchObject({ kind: "ticket", ticketCode: code });
  });

  it("passes a case-variant of a real code through untouched so the repo fallback can resolve it", async () => {
    // Operator typed the code in upper case on the manual-entry field. The
    // resolver must NOT normalise it — it hands the string over as typed and
    // `tickets.getByCode` does the deliberate case-insensitive second query.
    const code = generateTicketCode();
    const typed = code.toUpperCase();
    const getByCode = vi.fn(async () => makeTicket({ code }));
    const deps = makeDeps(
      {
        tickets: {
          getByCode,
          findByEventAndHuman: vi.fn(async () => []),
        },
        volunteering: {
          listSignupsByHuman: vi.fn(async () => []),
          getEventRole: vi.fn(async () => role),
          getShift: vi.fn(async () => shift),
        },
      },
      makeTokenPort(undefined, "volunteer_qr_invalid"),
    );

    const result = await resolveScanPayload(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: typed,
    });

    expect(getByCode).toHaveBeenCalledWith(typed);
    // The resolved row's own (lowercase) code is what surfaces to the operator.
    expect(result).toMatchObject({ kind: "ticket", ticketCode: code });
  });

  it("still rejects payloads outside the widened shape as malformed", async () => {
    const deps = makeDeps({}, makeTokenPort(undefined, "volunteer_qr_invalid"));

    // Dots are excluded so a JWT-shaped payload can never be mistaken for a
    // ticket code; spaces and slashes stay out too.
    for (const raw of ["tk_abc.def", "tk_abc def", "tk_abc/def", "short"]) {
      await expect(
        resolveScanPayload(deps, {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          raw,
        }),
      ).resolves.toMatchObject({ kind: "unknown" });
    }
  });
});
