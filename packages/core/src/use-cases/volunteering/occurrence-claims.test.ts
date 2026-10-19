import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import {
  claimOccurrence,
  withdrawOccurrenceClaim,
  assignOccurrenceClaim,
  checkInOccurrenceClaim,
  listOccurrenceRoster,
  getPublicAskSchedule,
  type OccurrenceClaimDeps,
} from "./occurrence-claims";

// ── Constants ────────────────────────────────────────────────────────────────

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const VOLUNTEER_ID = "00000000-0000-4000-8000-000000000002";
const COORDINATOR_ID = "00000000-0000-4000-8000-000000000003";
const ORG_ID = "00000000-0000-4000-8000-000000000004";
const ASK_ID = "00000000-0000-4000-8000-000000000005";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_ROLE_ID = "00000000-0000-4000-8000-000000000011";
const OCCURRENCE_ID = "00000000-0000-4000-8000-000000000020";
const CLAIM_ID = "00000000-0000-4000-8000-000000000030";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000040";
const GROUP_ID = "00000000-0000-4000-8000-000000000060";
const OTHER_GROUP_ID = "00000000-0000-4000-8000-000000000061";
const NOW = new Date("2026-07-01T12:00:00.000Z");
const STARTS = new Date("2026-07-10T19:00:00.000Z"); // future of NOW
const ENDS = new Date("2026-07-10T23:00:00.000Z"); // 4h window

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseAsk = {
  id: ASK_ID,
  subjectType: "ORG" as const,
  subjectId: ORG_ID,
  orgId: ORG_ID,
  title: "Door help every Friday",
  description: null,
  status: "OPEN" as const,
  cadence: "RECURRING" as const,
  startsAt: null,
  endsAt: null,
  capacity: null,
  autoApprove: false,
  waiverRequired: false,
  waiverTemplateId: null,
  smsOptInEnabled: false,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const baseOccurrence = {
  id: OCCURRENCE_ID,
  askId: ASK_ID,
  roleId: ROLE_ID,
  patternId: null,
  startsAt: STARTS,
  endsAt: ENDS,
  capacity: null,
  notes: null,
  status: "SCHEDULED" as const,
  createdAt: NOW,
  updatedAt: NOW,
};

const approvedSignup = {
  id: SIGNUP_ID,
  eventId: null,
  askId: ASK_ID,
  roleId: ROLE_ID,
  shiftId: null,
  groupId: null,
  humanId: VOLUNTEER_ID,
  contactEmail: "vol@example.com",
  contactName: "Vol Unteer",
  contactPhone: null,
  smsOptIn: false,
  status: "APPROVED" as const,
  hoursWorked: null,
  answers: {},
  reviewerHumanId: null,
  reviewedAt: null,
  checkedInAt: null,
  waiverAcceptedAt: null,
  waiverAccepted: false,
  notes: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const baseClaim = {
  id: CLAIM_ID,
  occurrenceId: OCCURRENCE_ID,
  signupId: SIGNUP_ID,
  status: "CLAIMED" as const,
  source: "SELF" as const,
  checkedInAt: null,
  hoursWorked: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const rosterRow = (over: Record<string, unknown> = {}) => ({
  ...baseClaim,
  contactEmail: "vol@example.com",
  contactName: "Vol Unteer",
  humanId: VOLUNTEER_ID,
  groupId: null,
  roleId: ROLE_ID,
  signupStatus: "APPROVED",
  ...over,
});

const coordinatedGroup = {
  id: GROUP_ID,
  askId: ASK_ID,
  name: "Door team",
  description: null,
  capacity: null,
  coordinatorHumanId: COORDINATOR_ID,
  memberCount: 1,
  coordinator: null,
  createdAt: NOW,
  updatedAt: NOW,
};

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeTxRepos(overrides: Record<string, unknown> = {}) {
  return {
    authz: {
      // OWNER_ID is an ADMIN member; everyone else is a stranger.
      getOrgMembership: vi.fn(async ({ humanId }: { humanId: string }) =>
        humanId === OWNER_ID ? { role: "ADMIN" } : null,
      ),
    },
    // The coordinator seat needs a verified email (B2); every actor here is
    // verified unless a test says otherwise.
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        identity: { emailVerified: true },
      })),
    },
    volunteering: {
      getAsk: vi.fn(async () => baseAsk),
      getOccurrence: vi.fn(async () => baseOccurrence),
      // FOR UPDATE lock + fresh re-read — the claim gates run on THIS row.
      getOccurrenceForUpdate: vi.fn(async () => baseOccurrence),
      getSignup: vi.fn(async () => approvedSignup),
      listSignupsByHuman: vi.fn(async () => [approvedSignup]),
      getClaimByOccurrenceAndSignup: vi.fn(async () => null),
      countActiveOccurrenceClaims: vi.fn(async () => 0),
      createOccurrenceClaim: vi.fn(async (input: any) => ({
        ...baseClaim,
        ...input,
        id: CLAIM_ID,
      })),
      updateOccurrenceClaim: vi.fn(async (id: string, input: any) => ({
        ...baseClaim,
        ...input,
        id,
      })),
      getOccurrenceClaim: vi.fn(async () => baseClaim),
      listClaimsByOccurrence: vi.fn(async () => [rosterRow()]),
      listGroupsByAsk: vi.fn(async () => [coordinatedGroup]),
      getGroup: vi.fn(async () => coordinatedGroup),
      getEventRole: vi.fn(async () => ({
        id: ROLE_ID,
        eventId: null,
        askId: ASK_ID,
        templateId: null,
        name: "Door",
        description: null,
        capacity: null,
        autoApprove: null,
        defaultHours: null,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
        shifts: [],
      })),
      listOccurrencesByAsk: vi.fn(async () => [
        { ...baseOccurrence, capacity: 3, claimedCount: 1 },
      ]),
    },
    audit: { log: vi.fn(async () => undefined) },
    bans: {
      findBannedOwners: vi.fn(async () => ({ humanIds: [], orgIds: [] })),
    },
    ...overrides,
  };
}

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const mailerSend = vi.fn(async () => ({ result: { success: true } }));
  const reportError = vi.fn();
  const deps: OccurrenceClaimDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
    appBaseUrl: "https://test.local",
    mailer: { send: mailerSend } as any,
    reportError,
  };
  return { deps, txRepos, mailerSend, reportError };
}

// ── claimOccurrence ──────────────────────────────────────────────────────────

describe("claimOccurrence", () => {
  const input = { actorHumanId: VOLUNTEER_ID, occurrenceId: OCCURRENCE_ID };

  it("APPROVED same-ask+role signup claims successfully (source SELF, audited)", async () => {
    const { deps, txRepos } = makeDeps();

    const claim = await claimOccurrence(deps, input);

    expect(claim.id).toBe(CLAIM_ID);
    expect(
      (txRepos.volunteering as any).createOccurrenceClaim,
    ).toHaveBeenCalledWith({
      occurrenceId: OCCURRENCE_ID,
      signupId: SIGNUP_ID,
      source: "SELF",
    });
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_occurrence_claim",
        action: "claimed",
      }),
    );
  });

  it("rejects a PENDING signup (capacity/eligibility: acceptance only)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listSignupsByHuman = vi.fn(async () => [
      { ...approvedSignup, status: "PENDING" },
    ]);
    await expect(claimOccurrence(deps, input)).rejects.toMatchObject({
      message: "signup_not_eligible",
    });
  });

  it("rejects an other-role signup on the same ask", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listSignupsByHuman = vi.fn(async () => [
      { ...approvedSignup, roleId: OTHER_ROLE_ID },
    ]);
    await expect(claimOccurrence(deps, input)).rejects.toMatchObject({
      message: "signup_not_eligible",
    });
  });

  it("rejects an other-ask signup", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listSignupsByHuman = vi.fn(async () => [
      { ...approvedSignup, askId: "00000000-0000-4000-8000-00000000beef" },
    ]);
    await expect(claimOccurrence(deps, input)).rejects.toMatchObject({
      message: "signup_not_eligible",
    });
  });

  it("rejects when the occurrence is at capacity (capacity from the LOCKED row)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getOccurrenceForUpdate = vi.fn(async () => ({
      ...baseOccurrence,
      capacity: 2,
    }));
    (txRepos.volunteering as any).countActiveOccurrenceClaims = vi.fn(
      async () => 2,
    );
    await expect(claimOccurrence(deps, input)).rejects.toMatchObject({
      message: "occurrence_full",
    });
  });

  it("gates capacity on the LOCKED row, not the stale pre-lock read (capacity lowered concurrently)", async () => {
    const { deps, txRepos } = makeDeps();
    // Pre-lock read says uncapped…
    (txRepos.volunteering as any).getOccurrence = vi.fn(async () => ({
      ...baseOccurrence,
      capacity: null,
    }));
    // …but the row committed before our lock acquires says capacity 1.
    (txRepos.volunteering as any).getOccurrenceForUpdate = vi.fn(async () => ({
      ...baseOccurrence,
      capacity: 1,
    }));
    (txRepos.volunteering as any).countActiveOccurrenceClaims = vi.fn(
      async () => 1,
    );
    await expect(claimOccurrence(deps, input)).rejects.toMatchObject({
      message: "occurrence_full",
    });
  });

  it("null capacity = unlimited (no count) but the row lock is STILL taken", async () => {
    const { deps, txRepos } = makeDeps();
    await claimOccurrence(deps, input);
    expect(
      (txRepos.volunteering as any).getOccurrenceForUpdate,
    ).toHaveBeenCalledWith(OCCURRENCE_ID);
    expect(
      (txRepos.volunteering as any).countActiveOccurrenceClaims,
    ).not.toHaveBeenCalled();
  });

  it("rejects a cancelled occurrence — gated on the LOCKED row even when the pre-lock read was SCHEDULED", async () => {
    const { deps, txRepos } = makeDeps();
    // Pre-lock read (resolveOccurrenceContext) still sees SCHEDULED — the
    // cancel committed while we waited on the lock. The gate must fail
    // closed off the locked re-read (claim-vs-cancel race regression).
    (txRepos.volunteering as any).getOccurrenceForUpdate = vi.fn(async () => ({
      ...baseOccurrence,
      status: "CANCELLED",
    }));
    await expect(claimOccurrence(deps, input)).rejects.toMatchObject({
      message: "occurrence_cancelled",
    });
  });

  it("rejects a past occurrence", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getOccurrenceForUpdate = vi.fn(async () => ({
      ...baseOccurrence,
      startsAt: new Date("2026-06-01T19:00:00.000Z"),
      endsAt: new Date("2026-06-01T23:00:00.000Z"),
    }));
    await expect(claimOccurrence(deps, input)).rejects.toMatchObject({
      message: "occurrence_in_past",
    });
  });

  it("is idempotent — an existing CLAIMED row returns as-is with no new write", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getClaimByOccurrenceAndSignup = vi.fn(
      async () => baseClaim,
    );

    const claim = await claimOccurrence(deps, input);

    expect(claim).toEqual(baseClaim);
    expect(
      (txRepos.volunteering as any).createOccurrenceClaim,
    ).not.toHaveBeenCalled();
    expect(
      (txRepos.volunteering as any).updateOccurrenceClaim,
    ).not.toHaveBeenCalled();
  });

  it("re-claims a WITHDRAWN row by flipping it back to CLAIMED (capacity re-checked)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getOccurrenceForUpdate = vi.fn(async () => ({
      ...baseOccurrence,
      capacity: 3,
    }));
    (txRepos.volunteering as any).getClaimByOccurrenceAndSignup = vi.fn(
      async () => ({ ...baseClaim, status: "WITHDRAWN" }),
    );

    const claim = await claimOccurrence(deps, input);

    expect(claim.status).toBe("CLAIMED");
    expect(
      (txRepos.volunteering as any).countActiveOccurrenceClaims,
    ).toHaveBeenCalledWith(OCCURRENCE_ID);
    expect(
      (txRepos.volunteering as any).updateOccurrenceClaim,
    ).toHaveBeenCalledWith(CLAIM_ID, { status: "CLAIMED", source: "SELF" });
    expect(
      (txRepos.volunteering as any).createOccurrenceClaim,
    ).not.toHaveBeenCalled();
  });

  // Ban that sticks (owner ruling 2026-10-07: "Refuse, but tell them why").
  describe("withheld owner's ask", () => {
    const withheld = () => vi.fn(async () => ({ humanIds: [], orgIds: [ORG_ID] }));

    it("refuses a NEW claim with SHIFT_SIGNUPS_PAUSED — no NOT_FOUND, no meta, no write", async () => {
      const { deps, txRepos } = makeDeps();
      (txRepos.bans as any).findBannedOwners = withheld();

      const err = await claimOccurrence(deps, input).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toMatchObject({
        code: "SHIFT_SIGNUPS_PAUSED",
        message: "SHIFT_SIGNUPS_PAUSED",
      });
      expect((err as { meta?: unknown }).meta).toBeUndefined();
      expect((txRepos.bans as any).findBannedOwners).toHaveBeenCalledWith({
        humanIds: [],
        orgIds: [ORG_ID],
      });
      expect(
        (txRepos.volunteering as any).createOccurrenceClaim,
      ).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).updateOccurrenceClaim,
      ).not.toHaveBeenCalled();
      expect((txRepos.audit as any).log).not.toHaveBeenCalled();
    });

    it("refuses re-claiming a WITHDRAWN row too (a re-claim is a new claim)", async () => {
      const { deps, txRepos } = makeDeps();
      (txRepos.bans as any).findBannedOwners = withheld();
      (txRepos.volunteering as any).getClaimByOccurrenceAndSignup = vi.fn(
        async () => ({ ...baseClaim, status: "WITHDRAWN" }),
      );

      await expect(claimOccurrence(deps, input)).rejects.toMatchObject({
        code: "SHIFT_SIGNUPS_PAUSED",
      });
      expect(
        (txRepos.volunteering as any).updateOccurrenceClaim,
      ).not.toHaveBeenCalled();
    });

    it("a banned HUMAN owner's ask refuses the same way", async () => {
      const { deps, txRepos } = makeDeps();
      (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
        ...baseAsk,
        subjectType: "HUMAN",
        subjectId: OWNER_ID,
      }));
      (txRepos.bans as any).findBannedOwners = vi.fn(async () => ({
        humanIds: [OWNER_ID],
        orgIds: [],
      }));

      await expect(claimOccurrence(deps, input)).rejects.toMatchObject({
        code: "SHIFT_SIGNUPS_PAUSED",
      });
      expect((txRepos.bans as any).findBannedOwners).toHaveBeenCalledWith({
        humanIds: [OWNER_ID],
        orgIds: [],
      });
    });

    it("keeps a claim already held: it returns untouched, nothing released", async () => {
      const { deps, txRepos } = makeDeps();
      (txRepos.bans as any).findBannedOwners = withheld();
      (txRepos.volunteering as any).getClaimByOccurrenceAndSignup = vi.fn(
        async () => baseClaim,
      );

      const claim = await claimOccurrence(deps, input);

      expect(claim).toEqual(baseClaim);
      expect(claim.status).toBe("CLAIMED");
      expect(
        (txRepos.volunteering as any).updateOccurrenceClaim,
      ).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).createOccurrenceClaim,
      ).not.toHaveBeenCalled();
    });

    it("a volunteer not accepted on the ask still gets signup_not_eligible (the code tells strangers nothing)", async () => {
      const { deps, txRepos } = makeDeps();
      (txRepos.bans as any).findBannedOwners = withheld();
      (txRepos.volunteering as any).listSignupsByHuman = vi.fn(async () => []);

      await expect(claimOccurrence(deps, input)).rejects.toMatchObject({
        message: "signup_not_eligible",
      });
      expect((txRepos.bans as any).findBannedOwners).not.toHaveBeenCalled();
    });

    it("a live owner's ask is checked and the claim lands", async () => {
      const { deps, txRepos } = makeDeps();

      const claim = await claimOccurrence(deps, input);

      expect(claim.id).toBe(CLAIM_ID);
      expect((txRepos.bans as any).findBannedOwners).toHaveBeenCalledTimes(1);
    });
  });
});

// ── withdrawOccurrenceClaim ──────────────────────────────────────────────────

describe("withdrawOccurrenceClaim", () => {
  const input = { actorHumanId: VOLUNTEER_ID, claimId: CLAIM_ID };

  it("the claim's own volunteer withdraws it (frictionless, audited)", async () => {
    const { deps, txRepos } = makeDeps();

    const claim = await withdrawOccurrenceClaim(deps, input);

    expect(claim.status).toBe("WITHDRAWN");
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "withdrawn" }),
    );
  });

  it("rejects a non-owner actor", async () => {
    const { deps } = makeDeps();
    await expect(
      withdrawOccurrenceClaim(deps, { ...input, actorHumanId: OWNER_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("is idempotent when already WITHDRAWN", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getOccurrenceClaim = vi.fn(async () => ({
      ...baseClaim,
      status: "WITHDRAWN",
    }));

    const claim = await withdrawOccurrenceClaim(deps, input);

    expect(claim.status).toBe("WITHDRAWN");
    expect(
      (txRepos.volunteering as any).updateOccurrenceClaim,
    ).not.toHaveBeenCalled();
  });
});

// ── assignOccurrenceClaim ────────────────────────────────────────────────────

describe("assignOccurrenceClaim", () => {
  const input = {
    actorHumanId: OWNER_ID,
    occurrenceId: OCCURRENCE_ID,
    signupId: SIGNUP_ID,
  };

  it("owner assigns any accepted signup; sends the .ics email post-commit", async () => {
    const { deps, txRepos, mailerSend } = makeDeps();

    const claim = await assignOccurrenceClaim(deps, input);

    expect(claim.id).toBe(CLAIM_ID);
    expect(
      (txRepos.volunteering as any).createOccurrenceClaim,
    ).toHaveBeenCalledWith({
      occurrenceId: OCCURRENCE_ID,
      signupId: SIGNUP_ID,
      source: "ASSIGNED",
    });
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assigned",
        data: expect.objectContaining({ via: "owner" }),
      }),
    );
    expect(mailerSend).toHaveBeenCalledTimes(1);
    const sent = mailerSend.mock.calls[0]![0] as any;
    expect(sent.to).toEqual({ to: "vol@example.com", name: "Vol Unteer" });
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0].mime).toBe("text/calendar");
    const ics = Buffer.from(
      sent.attachments[0].bytesBase64,
      "base64",
    ).toString("utf8");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART:20260710T190000Z");
    expect(ics).toContain(`volunteer-occurrence-claim-${CLAIM_ID}@`);
  });

  it("coordinator assigns a signup inside their OWN group", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...approvedSignup,
      groupId: GROUP_ID,
    }));

    const claim = await assignOccurrenceClaim(deps, {
      ...input,
      actorHumanId: COORDINATOR_ID,
    });

    expect(claim.id).toBe(CLAIM_ID);
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ via: "coordinator" }),
      }),
    );
  });

  it("coordinator cannot assign a pool (unassigned) signup — owner only", async () => {
    const { deps } = makeDeps();
    await expect(
      assignOccurrenceClaim(deps, { ...input, actorHumanId: COORDINATOR_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("coordinator cannot assign another group's signup (uniform forbidden)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...approvedSignup,
      groupId: OTHER_GROUP_ID,
    }));
    (txRepos.volunteering as any).getGroup = vi.fn(async () => ({
      ...coordinatedGroup,
      id: OTHER_GROUP_ID,
      coordinatorHumanId: "00000000-0000-4000-8000-00000000dead",
    }));
    await expect(
      assignOccurrenceClaim(deps, { ...input, actorHumanId: COORDINATOR_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects a role-mismatched signup", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...approvedSignup,
      roleId: OTHER_ROLE_ID,
    }));
    await expect(assignOccurrenceClaim(deps, input)).rejects.toMatchObject({
      message: "signup_role_mismatch",
    });
  });

  it("rejects a PENDING signup", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...approvedSignup,
      status: "PENDING",
    }));
    await expect(assignOccurrenceClaim(deps, input)).rejects.toMatchObject({
      code: "SIGNUP_NOT_APPROVED",
    });
  });

  it("fails closed when the occurrence was cancelled concurrently (LOCKED-row gate)", async () => {
    const { deps, txRepos, mailerSend } = makeDeps();
    // Pre-lock read still SCHEDULED; the locked re-read sees the committed
    // cancel — same claim-vs-cancel regression as self-claim.
    (txRepos.volunteering as any).getOccurrenceForUpdate = vi.fn(async () => ({
      ...baseOccurrence,
      status: "CANCELLED",
    }));
    await expect(assignOccurrenceClaim(deps, input)).rejects.toMatchObject({
      message: "occurrence_cancelled",
    });
    expect(mailerSend).not.toHaveBeenCalled();
  });

  it("shadow (no-account) volunteers are assignable — email goes to contactEmail", async () => {
    const { deps, txRepos, mailerSend } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...approvedSignup,
      humanId: null,
    }));

    const claim = await assignOccurrenceClaim(deps, input);

    expect(claim.id).toBe(CLAIM_ID);
    expect(mailerSend).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — an existing CLAIMED row returns as-is and sends NO duplicate email", async () => {
    const { deps, txRepos, mailerSend } = makeDeps();
    (txRepos.volunteering as any).getClaimByOccurrenceAndSignup = vi.fn(
      async () => baseClaim,
    );

    const claim = await assignOccurrenceClaim(deps, input);

    expect(claim).toEqual(baseClaim);
    expect(mailerSend).not.toHaveBeenCalled();
    expect(
      (txRepos.volunteering as any).createOccurrenceClaim,
    ).not.toHaveBeenCalled();
  });

  it("swallows a mailer failure (assignment persists) and reports it", async () => {
    const { deps, mailerSend, reportError } = makeDeps();
    mailerSend.mockRejectedValueOnce(new Error("smtp down"));

    const claim = await assignOccurrenceClaim(deps, input);

    expect(claim.id).toBe(CLAIM_ID);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("an unconfigured mailer never blocks the assignment", async () => {
    const { deps, reportError } = makeDeps();
    deps.mailer = null;

    const claim = await assignOccurrenceClaim(deps, input);

    expect(claim.id).toBe(CLAIM_ID);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  // Ban that sticks (owner ruling 2026-10-08: coordinator assignment
  // refuses too, with the staff-facing code rather than the volunteer's).
  describe("withheld owner's ask", () => {
    const withheld = () =>
      vi.fn(async () => ({ humanIds: [], orgIds: [ORG_ID] }));

    it("refuses a NEW assignment with VOLUNTEER_APPROVALS_PAUSED — no write, no audit, no email", async () => {
      const { deps, txRepos, mailerSend, reportError } = makeDeps();
      (txRepos.bans as any).findBannedOwners = withheld();

      const err = await assignOccurrenceClaim(deps, input).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toMatchObject({
        code: "VOLUNTEER_APPROVALS_PAUSED",
        message: "VOLUNTEER_APPROVALS_PAUSED",
      });
      expect((err as { meta?: unknown }).meta).toBeUndefined();
      expect((txRepos.bans as any).findBannedOwners).toHaveBeenCalledWith({
        humanIds: [],
        orgIds: [ORG_ID],
      });
      expect(
        (txRepos.volunteering as any).createOccurrenceClaim,
      ).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).updateOccurrenceClaim,
      ).not.toHaveBeenCalled();
      expect((txRepos.audit as any).log).not.toHaveBeenCalled();
      expect(mailerSend).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });

    it("refuses re-assigning a WITHDRAWN row too (a re-assign is a new claim)", async () => {
      const { deps, txRepos, mailerSend } = makeDeps();
      (txRepos.bans as any).findBannedOwners = withheld();
      (txRepos.volunteering as any).getClaimByOccurrenceAndSignup = vi.fn(
        async () => ({ ...baseClaim, status: "WITHDRAWN" }),
      );

      await expect(assignOccurrenceClaim(deps, input)).rejects.toMatchObject({
        code: "VOLUNTEER_APPROVALS_PAUSED",
      });
      expect(
        (txRepos.volunteering as any).updateOccurrenceClaim,
      ).not.toHaveBeenCalled();
      expect(mailerSend).not.toHaveBeenCalled();
    });

    it("an unauthorised caller still gets their existing error first (the ban is never checked)", async () => {
      const { deps, txRepos } = makeDeps();
      (txRepos.bans as any).findBannedOwners = withheld();

      // COORDINATOR_ID on a pool signup → owner-only gate.
      await expect(
        assignOccurrenceClaim(deps, { ...input, actorHumanId: COORDINATOR_ID }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect((txRepos.bans as any).findBannedOwners).not.toHaveBeenCalled();
    });

    it("an ineligible signup still gets its existing error first", async () => {
      const { deps, txRepos } = makeDeps();
      (txRepos.bans as any).findBannedOwners = withheld();
      (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
        ...approvedSignup,
        status: "PENDING",
      }));

      await expect(assignOccurrenceClaim(deps, input)).rejects.toMatchObject({
        code: "SIGNUP_NOT_APPROVED",
      });
      expect((txRepos.bans as any).findBannedOwners).not.toHaveBeenCalled();
    });

    it("keeps a claim already held: the replay returns it untouched, no email", async () => {
      const { deps, txRepos, mailerSend } = makeDeps();
      (txRepos.bans as any).findBannedOwners = withheld();
      (txRepos.volunteering as any).getClaimByOccurrenceAndSignup = vi.fn(
        async () => baseClaim,
      );

      const claim = await assignOccurrenceClaim(deps, input);

      expect(claim).toEqual(baseClaim);
      expect(
        (txRepos.volunteering as any).createOccurrenceClaim,
      ).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).updateOccurrenceClaim,
      ).not.toHaveBeenCalled();
      expect(mailerSend).not.toHaveBeenCalled();
    });

    it("a live owner's ask is checked and the assignment lands with its email", async () => {
      const { deps, txRepos, mailerSend } = makeDeps();

      const claim = await assignOccurrenceClaim(deps, input);

      expect(claim.id).toBe(CLAIM_ID);
      expect((txRepos.bans as any).findBannedOwners).toHaveBeenCalledTimes(1);
      expect(mailerSend).toHaveBeenCalledTimes(1);
    });
  });
});

// ── checkInOccurrenceClaim ───────────────────────────────────────────────────

describe("checkInOccurrenceClaim", () => {
  const input = { actorHumanId: OWNER_ID, claimId: CLAIM_ID };

  it("stamps duration-derived hours (2dp) from the occurrence window", async () => {
    const { deps, txRepos } = makeDeps();

    const claim = await checkInOccurrenceClaim(deps, input);

    // 19:00 → 23:00 = 4.00 hours.
    expect(claim.hoursWorked).toBe(4);
    expect(claim.checkedInAt).toEqual(NOW);
    expect(
      (txRepos.volunteering as any).updateOccurrenceClaim,
    ).toHaveBeenCalledWith(CLAIM_ID, { checkedInAt: NOW, hoursWorked: 4 });
  });

  it("rounds a non-integral duration to 2dp", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getOccurrence = vi.fn(async () => ({
      ...baseOccurrence,
      // 2h50m = 2.8333… → 2.83
      endsAt: new Date("2026-07-10T21:50:00.000Z"),
    }));

    const claim = await checkInOccurrenceClaim(deps, input);
    expect(claim.hoursWorked).toBe(2.83);
  });

  it("honors an explicit hours override", async () => {
    const { deps, txRepos } = makeDeps();

    await checkInOccurrenceClaim(deps, { ...input, hoursOverride: 2.5 });

    expect(
      (txRepos.volunteering as any).updateOccurrenceClaim,
    ).toHaveBeenCalledWith(CLAIM_ID, { checkedInAt: NOW, hoursWorked: 2.5 });
  });

  it("rejects derived hours beyond the Decimal(5,2) bound (legacy oversized window)", async () => {
    const { deps, txRepos } = makeDeps();
    // Hand-crafted legacy row with a ~6-week window (pre-cap rows only —
    // new windows are schema-capped at 24h): 1008h > 999.99.
    (txRepos.volunteering as any).getOccurrence = vi.fn(async () => ({
      ...baseOccurrence,
      startsAt: new Date("2026-07-10T19:00:00.000Z"),
      endsAt: new Date("2026-08-21T19:00:00.000Z"),
    }));
    await expect(checkInOccurrenceClaim(deps, input)).rejects.toMatchObject({
      message: "hours_out_of_range",
    });
    expect(
      (txRepos.volunteering as any).updateOccurrenceClaim,
    ).not.toHaveBeenCalled();
  });

  it("is idempotent when already checked in", async () => {
    const { deps, txRepos } = makeDeps();
    const checkedIn = { ...baseClaim, checkedInAt: NOW, hoursWorked: 4 };
    (txRepos.volunteering as any).getOccurrenceClaim = vi.fn(
      async () => checkedIn,
    );

    const claim = await checkInOccurrenceClaim(deps, input);

    expect(claim).toEqual(checkedIn);
    expect(
      (txRepos.volunteering as any).updateOccurrenceClaim,
    ).not.toHaveBeenCalled();
  });

  it("rejects a WITHDRAWN claim", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getOccurrenceClaim = vi.fn(async () => ({
      ...baseClaim,
      status: "WITHDRAWN",
    }));
    await expect(checkInOccurrenceClaim(deps, input)).rejects.toMatchObject({
      message: "claim_not_active",
    });
  });

  it("coordinator can check in their own group's member", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...approvedSignup,
      groupId: GROUP_ID,
    }));

    const claim = await checkInOccurrenceClaim(deps, {
      ...input,
      actorHumanId: COORDINATOR_ID,
    });
    expect(claim.checkedInAt).toEqual(NOW);
  });
});

// ── listOccurrenceRoster ─────────────────────────────────────────────────────

describe("listOccurrenceRoster", () => {
  it("owner sees every claim", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listClaimsByOccurrence = vi.fn(async () => [
      rosterRow(),
      rosterRow({ id: "claim-2", groupId: GROUP_ID }),
    ]);

    const { claims } = await listOccurrenceRoster(deps, {
      actorHumanId: OWNER_ID,
      occurrenceId: OCCURRENCE_ID,
    });

    expect(claims).toHaveLength(2);
  });

  it("coordinator sees ONLY their group's members (PII scoping)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listClaimsByOccurrence = vi.fn(async () => [
      rosterRow(), // pool — hidden
      rosterRow({ id: "claim-2", groupId: GROUP_ID }), // own group — visible
      rosterRow({ id: "claim-3", groupId: OTHER_GROUP_ID }), // other — hidden
    ]);

    const { claims } = await listOccurrenceRoster(deps, {
      actorHumanId: COORDINATOR_ID,
      occurrenceId: OCCURRENCE_ID,
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]!.id).toBe("claim-2");
  });

  it("a stranger gets the uniform ownership denial — never an empty 200", async () => {
    const { deps } = makeDeps();
    await expect(
      listOccurrenceRoster(deps, {
        actorHumanId: VOLUNTEER_ID,
        occurrenceId: OCCURRENCE_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ── getPublicAskSchedule ─────────────────────────────────────────────────────

describe("getPublicAskSchedule", () => {
  it("returns upcoming SCHEDULED occurrences with open-slot math only", async () => {
    const { deps, txRepos } = makeDeps();

    const { occurrences } = await getPublicAskSchedule(deps, {
      askId: ASK_ID,
    });

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toEqual({
      id: OCCURRENCE_ID,
      roleId: ROLE_ID,
      startsAt: STARTS,
      endsAt: ENDS,
      capacity: 3,
      claimedCount: 1,
      openCount: 2,
    });
    expect(
      (txRepos.volunteering as any).listOccurrencesByAsk,
    ).toHaveBeenCalledWith(ASK_ID, {
      status: "SCHEDULED",
      from: NOW,
      // 90-day horizon + row cap — public-endpoint insurance.
      to: new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000),
      limit: 200,
    });
  });

  it("uncapped occurrences report openCount null; overfull clamps to 0", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).listOccurrencesByAsk = vi.fn(async () => [
      { ...baseOccurrence, capacity: null, claimedCount: 5 },
      { ...baseOccurrence, id: "occ-2", capacity: 2, claimedCount: 3 },
    ]);

    const { occurrences } = await getPublicAskSchedule(deps, {
      askId: ASK_ID,
    });

    expect(occurrences[0]!.openCount).toBeNull();
    expect(occurrences[1]!.openCount).toBe(0);
  });

  it("DRAFT asks collapse to not_found (no existence oracle)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
      ...baseAsk,
      status: "DRAFT",
    }));
    await expect(
      getPublicAskSchedule(deps, { askId: ASK_ID }),
    ).rejects.toMatchObject({ message: "ask_not_found" });
  });

  it("a withheld owner's ask collapses to not_found (ban that sticks)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.bans as any).findBannedOwners = vi.fn(async () => ({
      humanIds: [],
      orgIds: [ORG_ID],
    }));
    await expect(
      getPublicAskSchedule(deps, { askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
    expect((txRepos.bans as any).findBannedOwners).toHaveBeenCalledWith({
      humanIds: [],
      orgIds: [ORG_ID],
    });
    expect(
      (txRepos.volunteering as any).listOccurrencesByAsk,
    ).not.toHaveBeenCalled();
  });

  it("a live owner's ask still returns its schedule", async () => {
    const { deps, txRepos } = makeDeps();
    const { occurrences } = await getPublicAskSchedule(deps, {
      askId: ASK_ID,
    });
    expect(occurrences).toHaveLength(1);
    expect((txRepos.bans as any).findBannedOwners).toHaveBeenCalledTimes(1);
  });

  it("EVENT-subject asks collapse to not_found", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
      ...baseAsk,
      subjectType: "EVENT",
    }));
    await expect(
      getPublicAskSchedule(deps, { askId: ASK_ID }),
    ).rejects.toMatchObject({ message: "ask_not_found" });
  });
});
