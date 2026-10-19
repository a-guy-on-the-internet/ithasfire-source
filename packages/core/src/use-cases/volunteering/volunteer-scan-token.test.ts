import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { VolunteerSignupRecord } from "@th/ports/repos/volunteering";
import type { VolunteerScanTokenPort } from "@th/ports/volunteer-scan-token";

import { mintVolunteerScanToken } from "./volunteer-scan-tokens";
import type { VolunteerScanTokenDeps } from "./volunteer-scan-tokens";

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const SHIFT_ID = "00000000-0000-4000-8000-000000000030";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000040";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000099";
const ADMIN_ID = "00000000-0000-4000-8000-000000000aaa";
const NOW = new Date("2026-06-01T12:00:00.000Z");

const DAY = 24 * 3600;

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Summer Fest",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  startsAt: new Date("2026-07-01T18:00:00Z"),
  endsAt: new Date("2026-07-01T23:00:00Z"),
} as unknown as EventRecord;

/** Organizer TTL for `baseEvent` at NOW: event end + 24h trailing. */
const ORGANIZER_TTL_FAR_EVENT =
  Math.floor((baseEvent.endsAt!.getTime() - NOW.getTime()) / 1000) + DAY;
/** Default ceiling on a self-minted printable QR. */
const SELF_PRINT_MAX_TTL = 14 * DAY;

const baseSignup: VolunteerSignupRecord = {
  id: SIGNUP_ID,
  eventId: EVENT_ID,
  roleId: ROLE_ID,
  shiftId: SHIFT_ID,
  humanId: ACTOR_ID,
  contactEmail: "vol@example.com",
  contactName: "Vol",
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
};

function makeTxRepos(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    events: {
      getById: vi.fn(async () => baseEvent),
    },
    authz: {
      getOrgMembership: vi.fn(async () => null),
    },
    volunteering: {
      getSignup: vi.fn(async () => baseSignup),
    },
    audit: {
      log: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

function makeTokenPort(): VolunteerScanTokenPort {
  return {
    sign: vi.fn(async (input) => ({
      token: `tok:${input.kind}:${input.ttlSeconds}`,
      expiresAt: new Date(NOW.getTime() + input.ttlSeconds * 1000),
    })),
    verify: vi.fn(),
  };
}

function makeDeps(
  txOverrides: Record<string, unknown> = {},
  options: {
    tokenPort?: VolunteerScanTokenPort;
    shortTtlHours?: number;
    printMaxTtlSeconds?: number;
    selfPrintMaxTtlSeconds?: number;
    authz?: AuthZPort;
  } = {},
) {
  const txRepos = makeTxRepos(txOverrides);
  const tokenPort = options.tokenPort ?? makeTokenPort();
  const deps: VolunteerScanTokenDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
    authz: options.authz ?? denyingAuthz,
    clock: { now: () => NOW },
    volunteerScanToken: tokenPort,
    shortTokenTtlHours: options.shortTtlHours,
    printTokenMaxTtlSeconds: options.printMaxTtlSeconds,
    selfPrintTokenMaxTtlSeconds: options.selfPrintMaxTtlSeconds,
  };
  return { deps, txRepos, tokenPort };
}

/** Capture whatever a rejected mint threw, in a comparable shape. */
async function captureRejection(
  promise: Promise<unknown>,
): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown; name?: unknown };
    return {
      name: e?.name,
      code: e?.code,
      message: e?.message,
    };
  }
  throw new Error("expected the mint to reject, but it resolved");
}

describe("mintVolunteerScanToken", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    signupId: SIGNUP_ID,
    kind: "short" as const,
  };

  it("lets the signup owner mint a short token (default 24h TTL)", async () => {
    const { deps, tokenPort } = makeDeps();

    const result = await mintVolunteerScanToken(deps, validInput);

    expect(result.token).toBe("tok:short:86400");
    expect(tokenPort.sign).toHaveBeenCalledWith({
      humanId: ACTOR_ID,
      eventId: EVENT_ID,
      kind: "short",
      ttlSeconds: 24 * 3600,
      jti: expect.any(String),
    });
  });

  it("respects a custom shortTokenTtlHours override", async () => {
    const { deps, tokenPort } = makeDeps({}, { shortTtlHours: 4 });

    await mintVolunteerScanToken(deps, validInput);

    expect(tokenPort.sign).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 4 * 3600 }),
    );
  });

  it("rejects when the owner's signup is not APPROVED", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getSignup: vi.fn(async () => ({
          ...baseSignup,
          status: "PENDING" as const,
        })),
      },
    });

    await expect(
      mintVolunteerScanToken(deps, validInput),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_APPROVED" });
  });

  it("lets an org admin mint a print token clamped to event end + 24h", async () => {
    const { deps, tokenPort } = makeDeps({
      authz: {
        getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })),
      },
    });

    await mintVolunteerScanToken(deps, {
      actorHumanId: ADMIN_ID,
      signupId: SIGNUP_ID,
      kind: "print",
    });

    // event ends 2026-07-01T23:00 = 30 days 11h after NOW, plus 24h trailing.
    // The organizer term is deliberately LONGER than the self-mint ceiling
    // here, which is what makes this a regression test for the self cap
    // leaking into the organizer path.
    expect(ORGANIZER_TTL_FAR_EVENT).toBeGreaterThan(SELF_PRINT_MAX_TTL);
    expect(tokenPort.sign).toHaveBeenCalledWith({
      // Scoped to the VOLUNTEER, not the minting admin.
      humanId: ACTOR_ID,
      eventId: EVENT_ID,
      kind: "print",
      ttlSeconds: ORGANIZER_TTL_FAR_EVENT,
      jti: expect.any(String),
    });
  });

  it("lets a platform ADMIN mint a print token on the organizer term and flags the override", async () => {
    const { deps, txRepos, tokenPort } = makeDeps(
      {},
      {
        authz: {
          hasStaffRole: vi.fn(async () => ({ allowed: true })),
        } as unknown as AuthZPort,
      },
    );

    await mintVolunteerScanToken(deps, {
      actorHumanId: ADMIN_ID,
      signupId: SIGNUP_ID,
      kind: "print",
    });

    expect(tokenPort.sign).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: ORGANIZER_TTL_FAR_EVENT }),
    );
    const audit = txRepos.audit as { log: ReturnType<typeof vi.fn> };
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "scan_token_minted.platform_admin_override",
        data: expect.objectContaining({
          isOwnerSelfMint: false,
          viaPlatformAdmin: true,
        }),
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Owner-minted printable QR (NOT a badge — badges stay organizer/venue-only)
// ══════════════════════════════════════════════════════════════════════════════

describe("mintVolunteerScanToken — owner-minted print (self-mint)", () => {
  const selfPrintInput = {
    actorHumanId: ACTOR_ID,
    signupId: SIGNUP_ID,
    kind: "print" as const,
  };

  it("lets the owner mint a print token for their OWN approved signup", async () => {
    const { deps, tokenPort } = makeDeps();

    const result = await mintVolunteerScanToken(deps, selfPrintInput);

    expect(result.token).toBe(`tok:print:${SELF_PRINT_MAX_TTL}`);
    expect(tokenPort.sign).toHaveBeenCalledWith({
      humanId: ACTOR_ID,
      eventId: EVENT_ID,
      kind: "print",
      ttlSeconds: SELF_PRINT_MAX_TTL,
      jti: expect.any(String),
    });
  });

  it("scopes the self-minted token to the owner's own human+event, never wider", async () => {
    const { deps, tokenPort } = makeDeps();

    await mintVolunteerScanToken(deps, selfPrintInput);

    const signArgs = (tokenPort.sign as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    // The token asserts nothing beyond "this human, this event". It carries
    // no org id, no signup id, and no self-mint marker (see the port docs).
    expect(Object.keys(signArgs).sort()).toEqual([
      "eventId",
      "humanId",
      "jti",
      "kind",
      "ttlSeconds",
    ]);
    // `jti` is a random per-mint id, NOT derived from the signup, the actor,
    // or the provenance — it must not become a second self-mint tell.
    expect(signArgs.jti).not.toBe(SIGNUP_ID);
    expect(signArgs.jti).not.toBe(ACTOR_ID);
    expect(signArgs.humanId).toBe(ACTOR_ID);
    expect(signArgs.eventId).toBe(EVENT_ID);
  });

  it("is indistinguishable on the wire from an organizer-minted print token", async () => {
    // Same event, same signup, both `print` — only the TTL may differ. If a
    // future change adds a provenance claim, this fails.
    const selfRun = makeDeps();
    await mintVolunteerScanToken(selfRun.deps, selfPrintInput);
    const selfArgs = (selfRun.tokenPort.sign as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;

    const orgRun = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })) },
    });
    await mintVolunteerScanToken(orgRun.deps, {
      actorHumanId: ADMIN_ID,
      signupId: SIGNUP_ID,
      kind: "print",
    });
    const orgArgs = (orgRun.tokenPort.sign as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;

    const { ttlSeconds: _selfTtl, jti: _selfJti, ...selfRest } = selfArgs;
    const { ttlSeconds: _orgTtl, jti: _orgJti, ...orgRest } = orgArgs;
    expect(selfRest).toEqual(orgRest);
    // The jti differs per mint by design (it is what joins a recovered QR to
    // its audit row) but it is random, so it discloses no provenance.
    expect(_selfJti).not.toBe(_orgJti);
  });

  it("records the self-mint in the audit log (the only place provenance lives)", async () => {
    const { deps, txRepos } = makeDeps();

    await mintVolunteerScanToken(deps, selfPrintInput);

    const audit = txRepos.audit as { log: ReturnType<typeof vi.fn> };
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_signup",
        entityId: SIGNUP_ID,
        action: "scan_token_minted",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          kind: "print",
          ttlSeconds: SELF_PRINT_MAX_TTL,
          isOwnerSelfMint: true,
          viaPlatformAdmin: false,
          orgId: ORG_ID,
          jti: expect.any(String),
        }),
      }),
    );
  });

  it("treats an owner who ALSO holds an org-edit role as an organizer (organizer TTL, not a self-mint)", async () => {
    const { deps, txRepos, tokenPort } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "EDITOR" })) },
    });

    await mintVolunteerScanToken(deps, selfPrintInput);

    expect(tokenPort.sign).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: ORGANIZER_TTL_FAR_EVENT }),
    );
    const audit = txRepos.audit as { log: ReturnType<typeof vi.fn> };
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isOwnerSelfMint: false }),
      }),
    );
  });

  it("does not log a platform-admin override when the staffer is minting for THEMSELVES", async () => {
    // An Ithas Fire staffer volunteering at somebody else's event. They are
    // acting as the volunteer, not exercising the override, so the row must
    // read as a plain self-mint — otherwise the highest-signal audit action
    // fills with false positives and a REAL override gets lost in them.
    const staffAuthz = {
      hasStaffRole: vi.fn(async () => ({ allowed: true })),
    } as unknown as AuthZPort;
    const { deps, txRepos, tokenPort } = makeDeps({}, { authz: staffAuthz });

    await mintVolunteerScanToken(deps, selfPrintInput);

    const audit = txRepos.audit as { log: ReturnType<typeof vi.fn> };
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "scan_token_minted",
        data: expect.objectContaining({
          isOwnerSelfMint: true,
          viaPlatformAdmin: false,
        }),
      }),
    );
    // ...and they get the SELF ceiling, not the 90-day organizer term.
    expect(tokenPort.sign).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: SELF_PRINT_MAX_TTL }),
    );
    // The staff probe is skipped entirely on the owner path.
    expect(staffAuthz.hasStaffRole).not.toHaveBeenCalled();
  });

  it("still probes staff role, and still logs the override, for a NON-owner", async () => {
    const staffAuthz = {
      hasStaffRole: vi.fn(async () => ({ allowed: true })),
    } as unknown as AuthZPort;
    const { deps, txRepos } = makeDeps({}, { authz: staffAuthz });

    await mintVolunteerScanToken(deps, {
      actorHumanId: ADMIN_ID,
      signupId: SIGNUP_ID,
      kind: "print",
    });

    expect(staffAuthz.hasStaffRole).toHaveBeenCalledTimes(1);
    const audit = txRepos.audit as { log: ReturnType<typeof vi.fn> };
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "scan_token_minted.platform_admin_override",
        data: expect.objectContaining({ viaPlatformAdmin: true }),
      }),
    );
  });

  it("writes the token's jti into the audit row so a found QR joins to its mint", async () => {
    const { deps, txRepos, tokenPort } = makeDeps();

    await mintVolunteerScanToken(deps, selfPrintInput);

    const audit = txRepos.audit as { log: ReturnType<typeof vi.fn> };
    const loggedJti = (audit.log.mock.calls[0]![0] as { data: { jti: string } })
      .data.jti;
    const signedJti = (tokenPort.sign as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].jti as string;

    expect(typeof loggedJti).toBe("string");
    expect(loggedJti).toHaveLength(36);
    expect(signedJti).toBe(loggedJti);
  });

  for (const status of [
    "PENDING",
    "REJECTED",
    "WITHDRAWN",
    "NO_SHOW",
  ] as const) {
    it(`refuses a ${status} owner — nothing scannable before APPROVED`, async () => {
      const { deps, tokenPort } = makeDeps({
        volunteering: {
          getSignup: vi.fn(async () => ({ ...baseSignup, status })),
        },
      });

      await expect(
        mintVolunteerScanToken(deps, selfPrintInput),
      ).rejects.toMatchObject({ code: "SIGNUP_NOT_APPROVED" });
      expect(tokenPort.sign).not.toHaveBeenCalled();
    });
  }

  it("refuses a CHECKED_IN owner too (mint requires APPROVED exactly)", async () => {
    const { deps, tokenPort } = makeDeps({
      volunteering: {
        getSignup: vi.fn(async () => ({
          ...baseSignup,
          status: "CHECKED_IN" as const,
        })),
      },
    });

    await expect(
      mintVolunteerScanToken(deps, selfPrintInput),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_APPROVED" });
    expect(tokenPort.sign).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TTL boundaries
// ══════════════════════════════════════════════════════════════════════════════

describe("mintVolunteerScanToken — self-print TTL boundaries", () => {
  const selfPrintInput = {
    actorHumanId: ACTOR_ID,
    signupId: SIGNUP_ID,
    kind: "print" as const,
  };

  it("caps a far-future event at the 14-day self ceiling", async () => {
    const { deps, tokenPort } = makeDeps();

    await mintVolunteerScanToken(deps, selfPrintInput);

    expect(tokenPort.sign).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: SELF_PRINT_MAX_TTL }),
    );
  });

  it("uses the organizer term verbatim when the event is nearer than the ceiling", async () => {
    // Event ends 2h after NOW → organizer term = 2h + 24h trailing = 26h,
    // which is well under the 14-day ceiling, so the min picks the anchor.
    const nearEvent = {
      ...baseEvent,
      endsAt: new Date(NOW.getTime() + 2 * 3600 * 1000),
    } as EventRecord;
    const { deps, tokenPort } = makeDeps({
      events: { getById: vi.fn(async () => nearEvent) },
    });

    await mintVolunteerScanToken(deps, selfPrintInput);

    expect(tokenPort.sign).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 2 * 3600 + DAY }),
    );
  });

  it("never exceeds what the organizer would get for the same signup", async () => {
    const nearEvent = {
      ...baseEvent,
      endsAt: new Date(NOW.getTime() + 3600 * 1000),
    } as EventRecord;

    const selfRun = makeDeps({
      events: { getById: vi.fn(async () => nearEvent) },
    });
    await mintVolunteerScanToken(selfRun.deps, selfPrintInput);
    const selfTtl = (selfRun.tokenPort.sign as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].ttlSeconds as number;

    const orgRun = makeDeps({
      events: { getById: vi.fn(async () => nearEvent) },
      authz: { getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })) },
    });
    await mintVolunteerScanToken(orgRun.deps, {
      actorHumanId: ADMIN_ID,
      signupId: SIGNUP_ID,
      kind: "print",
    });
    const orgTtl = (orgRun.tokenPort.sign as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].ttlSeconds as number;

    expect(selfTtl).toBeLessThanOrEqual(orgTtl);
    expect(selfTtl).toBe(3600 + DAY);
  });

  it("honours printTokenMaxTtlSeconds — the organizer cap still binds the self term", async () => {
    const { deps, tokenPort } = makeDeps({}, { printMaxTtlSeconds: 3600 });

    await mintVolunteerScanToken(deps, selfPrintInput);

    expect(tokenPort.sign).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 3600 }),
    );
  });

  it("honours a tighter selfPrintTokenMaxTtlSeconds override", async () => {
    const { deps, tokenPort } = makeDeps({}, { selfPrintMaxTtlSeconds: 7200 });

    await mintVolunteerScanToken(deps, selfPrintInput);

    expect(tokenPort.sign).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 7200 }),
    );
  });

  it("cannot be widened past the organizer cap by a larger self override", async () => {
    const { deps, tokenPort } = makeDeps(
      {},
      { printMaxTtlSeconds: 3600, selfPrintMaxTtlSeconds: 365 * DAY },
    );

    await mintVolunteerScanToken(deps, selfPrintInput);

    expect(tokenPort.sign).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 3600 }),
    );
  });

  it("gives a short fixed grace once the trailing window has closed, and does not grow with lateness", async () => {
    const tenDaysLate = {
      ...baseEvent,
      endsAt: new Date(NOW.getTime() - 10 * DAY * 1000),
    } as EventRecord;
    const aYearLate = {
      ...baseEvent,
      endsAt: new Date(NOW.getTime() - 365 * DAY * 1000),
    } as EventRecord;

    const near = makeDeps({
      events: { getById: vi.fn(async () => tenDaysLate) },
    });
    await mintVolunteerScanToken(near.deps, selfPrintInput);
    const far = makeDeps({ events: { getById: vi.fn(async () => aYearLate) } });
    await mintVolunteerScanToken(far.deps, selfPrintInput);

    const nearTtl = (near.tokenPort.sign as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].ttlSeconds as number;
    const farTtl = (far.tokenPort.sign as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].ttlSeconds as number;

    expect(nearTtl).toBe(15 * 60);
    // The bug shape this guards: a token minted LATER must never live LONGER.
    expect(farTtl).toBe(nearTtl);
  });

  it("still decays smoothly inside the trailing window", async () => {
    // 12h past the end is still inside end+24h, so the term is the remaining
    // 12h — strictly more than the post-window grace, and strictly less than
    // a token minted before the event ended.
    const justEnded = {
      ...baseEvent,
      endsAt: new Date(NOW.getTime() - 12 * 3600 * 1000),
    } as EventRecord;
    const { deps, tokenPort } = makeDeps({
      events: { getById: vi.fn(async () => justEnded) },
    });

    await mintVolunteerScanToken(deps, selfPrintInput);

    expect(tokenPort.sign).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 12 * 3600 }),
    );
  });

  it("caps an event with no end date at the self ceiling", async () => {
    const openEndedEvent = { ...baseEvent, endsAt: null } as EventRecord;
    const { deps, tokenPort } = makeDeps({
      events: { getById: vi.fn(async () => openEndedEvent) },
    });

    await mintVolunteerScanToken(deps, selfPrintInput);

    expect(tokenPort.sign).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: SELF_PRINT_MAX_TTL }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Anti-oracle: "not yours" must be indistinguishable from "doesn't exist"
// ══════════════════════════════════════════════════════════════════════════════

describe("mintVolunteerScanToken — anti-oracle guarantee", () => {
  const probe = {
    actorHumanId: ACTOR_ID,
    signupId: SIGNUP_ID,
    kind: "print" as const,
  };

  /**
   * Every "you have no business with this id" outcome must produce the SAME
   * rejection. If any branch grows its own error code, this fails — which is
   * the point: the distinguishability, not the code, is the contract.
   */
  it("returns an identical rejection for nonexistent, foreign, and ask-only signups", async () => {
    const nonexistent = makeDeps({
      volunteering: { getSignup: vi.fn(async () => null) },
    });
    const foreignApproved = makeDeps({
      volunteering: {
        getSignup: vi.fn(async () => ({
          ...baseSignup,
          humanId: OTHER_HUMAN_ID,
          status: "APPROVED" as const,
        })),
      },
    });
    const foreignPending = makeDeps({
      volunteering: {
        getSignup: vi.fn(async () => ({
          ...baseSignup,
          humanId: OTHER_HUMAN_ID,
          status: "PENDING" as const,
        })),
      },
    });
    const askOnly = makeDeps({
      volunteering: {
        getSignup: vi.fn(async () => ({
          ...baseSignup,
          eventId: null,
          askId: "00000000-0000-4000-8000-000000000050",
        })),
      },
    });
    const orgless = makeDeps({
      events: { getById: vi.fn(async () => ({ ...baseEvent, orgId: null })) },
      volunteering: {
        getSignup: vi.fn(async () => ({
          ...baseSignup,
          humanId: OTHER_HUMAN_ID,
        })),
      },
    });

    const rejections = await Promise.all([
      captureRejection(mintVolunteerScanToken(nonexistent.deps, probe)),
      captureRejection(mintVolunteerScanToken(foreignApproved.deps, probe)),
      captureRejection(mintVolunteerScanToken(foreignPending.deps, probe)),
      captureRejection(mintVolunteerScanToken(askOnly.deps, probe)),
      captureRejection(mintVolunteerScanToken(orgless.deps, probe)),
    ]);

    const [baseline, ...rest] = rejections;
    expect(baseline).toMatchObject({ code: "SIGNUP_NOT_FOUND" });
    for (const rejection of rest) {
      expect(rejection).toEqual(baseline);
    }

    // And none of them minted anything.
    for (const run of [
      nonexistent,
      foreignApproved,
      foreignPending,
      askOnly,
      orgless,
    ]) {
      expect(run.tokenPort.sign).not.toHaveBeenCalled();
    }
  });

  it("holds for the short kind too", async () => {
    const shortProbe = { ...probe, kind: "short" as const };
    const nonexistent = makeDeps({
      volunteering: { getSignup: vi.fn(async () => null) },
    });
    const foreign = makeDeps({
      volunteering: {
        getSignup: vi.fn(async () => ({
          ...baseSignup,
          humanId: OTHER_HUMAN_ID,
        })),
      },
    });

    expect(
      await captureRejection(mintVolunteerScanToken(foreign.deps, shortProbe)),
    ).toEqual(
      await captureRejection(
        mintVolunteerScanToken(nonexistent.deps, shortProbe),
      ),
    );
  });

  it("authorizes BEFORE inspecting status — a foreign signup never reports its state", async () => {
    // The stranger asks about a signup that is PENDING. Pre-authz status
    // inspection would answer SIGNUP_NOT_APPROVED and confirm the id exists.
    const { deps } = makeDeps({
      volunteering: {
        getSignup: vi.fn(async () => ({
          ...baseSignup,
          humanId: OTHER_HUMAN_ID,
          status: "PENDING" as const,
        })),
      },
    });

    await expect(mintVolunteerScanToken(deps, probe)).rejects.toMatchObject({
      code: "SIGNUP_NOT_FOUND",
    });
  });

  it("refuses an owner's own ask-only signup with the same non-answer", async () => {
    // Ask-only signups (no eventId) are unmintable even for their owner —
    // scan tokens are an event-gate concept — and say so with the id-probe
    // response rather than a classification.
    const { deps, tokenPort } = makeDeps({
      volunteering: {
        getSignup: vi.fn(async () => ({
          ...baseSignup,
          status: "APPROVED" as const,
          eventId: null,
          askId: "00000000-0000-4000-8000-000000000050",
        })),
      },
    });

    await expect(mintVolunteerScanToken(deps, probe)).rejects.toMatchObject({
      code: "SIGNUP_NOT_FOUND",
    });
    expect(tokenPort.sign).not.toHaveBeenCalled();
  });

  it("yields SIGNUP_NOT_FOUND for PENDING ask-only signups too (guard precedes status errors)", async () => {
    const { deps, tokenPort } = makeDeps({
      volunteering: {
        getSignup: vi.fn(async () => ({
          ...baseSignup,
          status: "PENDING" as const,
          eventId: null,
          askId: "00000000-0000-4000-8000-000000000050",
        })),
      },
    });

    // NOT SIGNUP_NOT_APPROVED — that would classify the probed id as an
    // existing-but-unapproved signup.
    await expect(
      mintVolunteerScanToken(deps, { ...probe, kind: "short" as const }),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_FOUND" });
    expect(tokenPort.sign).not.toHaveBeenCalled();
  });

  it("does not let a non-owner mint for someone else via the org path they lack", async () => {
    // Actor holds a VIEWER role on the org — a member, but not org-edit, and
    // not the owner. Still the id-probe non-answer, and still no token.
    const { deps, tokenPort } = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
      volunteering: {
        getSignup: vi.fn(async () => ({
          ...baseSignup,
          humanId: OTHER_HUMAN_ID,
        })),
      },
    });

    await expect(mintVolunteerScanToken(deps, probe)).rejects.toMatchObject({
      code: "SIGNUP_NOT_FOUND",
    });
    expect(tokenPort.sign).not.toHaveBeenCalled();
  });
});
