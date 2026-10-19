import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import { revokeVolunteerReward } from "./revoke-volunteer-reward";
import type { RevokeVolunteerRewardDeps } from "./revoke-volunteer-reward";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ASK_ID = "00000000-0000-4000-8000-000000000003";
const REWARD_ID = "00000000-0000-4000-8000-000000000004";
const GRANT_ID = "00000000-0000-4000-8000-000000000005";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000006";
const ORDER_ID = "00000000-0000-4000-8000-000000000007";
const TICKET_ID = "00000000-0000-4000-8000-000000000008";
const ITEM_ID = "00000000-0000-4000-8000-000000000009";
const SEAT_ID = "00000000-0000-4000-8000-00000000000a";
const LISTING_ID = "00000000-0000-4000-8000-00000000000b";
const SELLER_ID = "00000000-0000-4000-8000-00000000000c";
/** The volunteer: buyer of the comp order and, until it passes on, the ticket's owner. */
const VOLUNTEER_ID = SELLER_ID;
const RESALE_ORDER_ID = "00000000-0000-4000-8000-00000000000d";
const RESALE_BUYER_ID = "00000000-0000-4000-8000-00000000000e";
const NOW = new Date("2026-07-02T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: GRANT_ID,
    rewardId: REWARD_ID,
    signupId: SIGNUP_ID,
    humanId: null,
    contactEmail: "vol@example.com",
    status: "GRANTED" as const,
    compOrderId: ORDER_ID,
    ticketId: TICKET_ID,
    faceValueCents: 5000,
    grantedAt: NOW,
    redeemedAt: null,
    revokedAt: null,
    revokeReason: null,
    ...overrides,
  };
}

const baseReward = {
  id: REWARD_ID,
  askId: ASK_ID,
  roleId: null,
  ticketTypeId: "tt",
  trigger: "ON_CHECK_IN" as const,
  maxGrants: 10,
  grantsUsed: 3,
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
};

const baseAsk = {
  id: ASK_ID,
  subjectType: "EVENT" as const,
  subjectId: "event",
  orgId: ORG_ID,
  title: "Door crew",
  description: null,
  status: "OPEN" as const,
  cadence: "ONE_TIME" as const,
  startsAt: null,
  endsAt: null,
  capacity: null,
  autoApprove: false,
  waiverRequired: false,
  smsOptInEnabled: false,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

function makeTxRepos(overrides: {
  grant?: Record<string, unknown>;
  ticketStatus?: string;
  /** Reserved-seat comp: the grant's ticket occupies a real seat. */
  ticketSeatId?: string | null;
  membershipRole?: string | null;
  volunteering?: Record<string, unknown>;
  /**
   * The comp's resale listing status, when it has one. `cancel` flips an
   * ACTIVE one to CANCELLED, like the adapter's ACTIVE-gated `updateMany`.
   */
  listingStatus?: "ACTIVE" | "HELD" | "SOLD" | "CANCELLED";
  /** A buyer's `hold` lands between revoke's read and its cancel CAS. */
  holdWinsTheRace?: boolean;
  /** The order the ticket sits on now. Default: the comp order. */
  ticketOrderId?: string | null;
  /** Who owns the ticket now. Default: the volunteer. */
  ticketOwnerId?: string;
} = {}) {
  const grant = makeGrant(overrides.grant);
  const ticket =
    grant.ticketId != null
      ? {
          id: grant.ticketId,
          status: overrides.ticketStatus ?? "VALID",
          seatId: overrides.ticketSeatId ?? null,
          orderItemId: ITEM_ID,
          orderId:
            overrides.ticketOrderId === undefined
              ? grant.compOrderId
              : overrides.ticketOrderId,
          ownerHumanId: overrides.ticketOwnerId ?? VOLUNTEER_ID,
        }
      : null;

  return {
    volunteering: {
      getGrant: vi.fn(async () => grant),
      getReward: vi.fn(async () => baseReward),
      getAsk: vi.fn(async () => baseAsk),
      updateGrantStatus: vi.fn(async (_id: string, patch: any) => ({
        ...grant,
        status: patch.status,
        revokedAt: patch.revokedAt ?? null,
        revokeReason: patch.revokeReason ?? null,
      })),
      decrementGrantsUsed: vi.fn(async () => undefined),
      ...overrides.volunteering,
    },
    tickets: {
      getById: vi.fn(async () => ticket),
      // The locked read revoke decides from.
      getByIdForUpdate: vi.fn(async () => ticket),
      // Compare-and-swap answer for a ticket still in the status read.
      setStatus: vi.fn(async (..._args: unknown[]) => true),
      clearSeatAssignments: vi.fn(async () => undefined),
    },
    orders: {
      cancelCompOrder: vi.fn(async () => true),
      getById: vi.fn(async (id: string) => ({
        id,
        buyerHumanId: VOLUNTEER_ID,
        source: "COMP",
      })),
    },
    resaleListings: (() => {
      let status = overrides.listingStatus;
      const current = () =>
        status
          ? { id: LISTING_ID, ticketId: TICKET_ID, sellerHumanId: SELLER_ID, status }
          : null;
      return {
        getByTicketId: vi.fn(async () => current()),
        getById: vi.fn(async () => current()),
        // The adapter's ACTIVE-gated CAS: true only when it flipped a row.
        cancel: vi.fn(async () => {
          if (overrides.holdWinsTheRace) status = "HELD";
          if (status !== "ACTIVE") return false;
          status = "CANCELLED";
          return true;
        }),
      };
    })(),
    // A comp can be seated. INVALID does not own a seat, so the revoke has to
    // hand it back or the Seat stays SOLD with nobody in it forever.
    orderItems: {
      recordReleasedSeats: vi.fn(async () => undefined),
      setResaleListingId: vi.fn(async () => undefined),
    },
    seats: {
      updateStatuses: vi.fn(async () => undefined),
      releaseSeats: vi.fn(async () => undefined),
    },
    authz: {
      getOrgMembership: vi.fn(async () =>
        overrides.membershipRole === undefined
          ? { role: "FINANCE" }
          : overrides.membershipRole === null
            ? null
            : { role: overrides.membershipRole },
      ),
    },
    audit: { log: vi.fn(async () => undefined) },
  };
}

function makeDeps(
  txOverrides: Parameters<typeof makeTxRepos>[0] = {},
  extra: Pick<RevokeVolunteerRewardDeps, "reportError"> = {},
) {
  const txRepos = makeTxRepos(txOverrides);
  const deps: RevokeVolunteerRewardDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
    ...extra,
  };
  return { deps, txRepos };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("revokeVolunteerReward", () => {
  it("voids the ticket, cancels the comp order, revokes the grant, and returns the budget slot", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await revokeVolunteerReward(deps, {
      grantId: GRANT_ID,
      reason: "signup_withdrawn",
    });

    expect(result).toEqual({ ok: true });
    expect((txRepos.tickets as any).setStatus).toHaveBeenCalledWith(
      TICKET_ID,
      "INVALID",
      { expectedStatus: "VALID" },
    );
    expect((txRepos.orders as any).cancelCompOrder).toHaveBeenCalledWith(
      ORDER_ID,
    );
    expect((txRepos.volunteering as any).updateGrantStatus).toHaveBeenCalledWith(
      GRANT_ID,
      expect.objectContaining({ status: "REVOKED", revokeReason: "signup_withdrawn" }),
    );
    expect(
      (txRepos.volunteering as any).decrementGrantsUsed,
    ).toHaveBeenCalledWith(REWARD_ID);
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "volunteer_reward_revoked" }),
    );
  });

  it("refuses to revoke a redeemed (SCANNED) comp — a manual refund decision", async () => {
    const { deps, txRepos } = makeDeps({ ticketStatus: "SCANNED" });

    await expect(
      revokeVolunteerReward(deps, { grantId: GRANT_ID, reason: "manual" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "reward_already_redeemed",
    });

    expect((txRepos.tickets as any).setStatus).not.toHaveBeenCalled();
    expect(
      (txRepos.volunteering as any).decrementGrantsUsed,
    ).not.toHaveBeenCalled();
  });

  it("is an idempotent no-op for an already-REVOKED grant (never double-decrements)", async () => {
    const { deps, txRepos } = makeDeps({ grant: { status: "REVOKED" } });

    const result = await revokeVolunteerReward(deps, {
      grantId: GRANT_ID,
      reason: "again",
    });

    expect(result).toEqual({ ok: true, skipped: "ALREADY_REVOKED" });
    expect(
      (txRepos.volunteering as any).decrementGrantsUsed,
    ).not.toHaveBeenCalled();
    expect((txRepos.tickets as any).setStatus).not.toHaveBeenCalled();
  });

  it("rejects a missing grant", async () => {
    const { deps } = makeDeps({
      volunteering: { getGrant: vi.fn(async () => null) },
    });

    await expect(
      revokeVolunteerReward(deps, { grantId: GRANT_ID, reason: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enforces ORG_FINANCE_ROLES on a manual (actor-carrying) revoke", async () => {
    const { deps } = makeDeps({ membershipRole: "EDITOR" });

    await expect(
      revokeVolunteerReward(deps, {
        actorHumanId: ACTOR_ID,
        grantId: GRANT_ID,
        reason: "manual",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("allows a manual revoke by a FINANCE actor", async () => {
    const { deps, txRepos } = makeDeps({ membershipRole: "FINANCE" });

    const result = await revokeVolunteerReward(deps, {
      actorHumanId: ACTOR_ID,
      grantId: GRANT_ID,
      reason: "manual",
    });

    expect(result).toEqual({ ok: true });
    expect((txRepos.authz as any).getOrgMembership).toHaveBeenCalled();
  });
  // ── Reserved seats ─────────────────────────────────────────────────────────

  it("gives a seated comp's seat back — INVALID does not own a seat", async () => {
    // Without this the Seat stays SOLD with no live ticket in it: permanently
    // unsellable inventory. Same bug class the refund paths close, and this
    // was the one voiding site still leaking it.
    const { deps, txRepos } = makeDeps({ ticketSeatId: SEAT_ID });

    await revokeVolunteerReward(deps, {
      grantId: GRANT_ID,
      reason: "signup_withdrawn",
    });

    expect((txRepos.tickets as any).clearSeatAssignments).toHaveBeenCalledWith([
      TICKET_ID,
    ]);
    expect((txRepos.seats as any).updateStatuses).toHaveBeenCalledWith({
      seatIds: [SEAT_ID],
      status: "AVAILABLE",
      updatedAt: NOW,
    });
    // `releaseSeats` is HELD-gated and this seat is SOLD — it would no-op.
    expect((txRepos.seats as any).releaseSeats).not.toHaveBeenCalled();
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "volunteer_reward_revoked",
        data: expect.objectContaining({ releasedSeatIds: [SEAT_ID] }),
      }),
    );
  });

  it("touches no seat for a GA comp", async () => {
    const { deps, txRepos } = makeDeps();

    await revokeVolunteerReward(deps, {
      grantId: GRANT_ID,
      reason: "signup_withdrawn",
    });

    expect((txRepos.seats as any).updateStatuses).not.toHaveBeenCalled();
    expect(
      (txRepos.tickets as any).clearSeatAssignments,
    ).not.toHaveBeenCalled();
  });

  it("touches no seat when the ticket was already INVALID (nothing voided here)", async () => {
    const { deps, txRepos } = makeDeps({
      ticketStatus: "INVALID",
      ticketSeatId: SEAT_ID,
    });

    await revokeVolunteerReward(deps, {
      grantId: GRANT_ID,
      reason: "signup_withdrawn",
    });

    expect((txRepos.tickets as any).setStatus).not.toHaveBeenCalled();
    expect((txRepos.seats as any).updateStatuses).not.toHaveBeenCalled();
  });

  // Refunds restock (spec 2026-10-09): INVALID is terminal, and a comp that
  // has passed to someone else is not the volunteer's to void.
  describe("a LISTED comp's resale listing", () => {
    it("ACTIVE: cancels the listing first, then voids from LISTED, and clears the item's pointer", async () => {
      const reportError = vi.fn();
      const { deps, txRepos } = makeDeps(
        { ticketStatus: "LISTED", listingStatus: "ACTIVE" },
        { reportError },
      );

      const result = await revokeVolunteerReward(deps, {
        grantId: GRANT_ID,
        reason: "signup_withdrawn",
      });

      expect(result).toEqual({ ok: true });
      const cancel = (txRepos.resaleListings as any).cancel;
      const setStatus = (txRepos.tickets as any).setStatus;
      expect(cancel).toHaveBeenCalledWith(LISTING_ID, SELLER_ID);
      expect(setStatus).toHaveBeenCalledWith(TICKET_ID, "INVALID", {
        expectedStatus: "LISTED",
      });
      expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(
        setStatus.mock.invocationCallOrder[0],
      );
      expect(
        (txRepos.orderItems as any).setResaleListingId,
      ).toHaveBeenCalledWith(ITEM_ID, null);
      expect(reportError).not.toHaveBeenCalled();
    });

    it.each([
      ["HELD (a buyer's checkout in flight)", { listingStatus: "HELD" as const }],
      [
        "ACTIVE when read, but a hold wins the cancel CAS",
        { listingStatus: "ACTIVE" as const, holdWinsTheRace: true },
      ],
    ])("%s: the comp is passing on, so the ticket is NOT voided", async (_name, listing) => {
      const reportError = vi.fn();
      const { deps, txRepos } = makeDeps(
        { ticketStatus: "LISTED", ...listing },
        { reportError },
      );

      const result = await revokeVolunteerReward(deps, {
        grantId: GRANT_ID,
        reason: "signup_withdrawn",
      });

      expect(result).toEqual({ ok: true });
      // The buyer's finalize needs the ticket still LISTED.
      expect((txRepos.tickets as any).setStatus).not.toHaveBeenCalled();
      expect((txRepos.orders as any).cancelCompOrder).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).decrementGrantsUsed,
      ).not.toHaveBeenCalled();
      // The grant is still revoked.
      expect(
        (txRepos.volunteering as any).updateGrantStatus,
      ).toHaveBeenCalledWith(
        GRANT_ID,
        expect.objectContaining({ status: "REVOKED" }),
      );
      expect((txRepos.audit as any).log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketPassedOn: {
              ticketId: TICKET_ID,
              ownerHumanId: VOLUNTEER_ID,
              reason: "resale_in_flight",
              listingId: LISTING_ID,
              listingStatus: "HELD",
            },
          }),
        }),
      );
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "revoke_volunteer_reward_ticket_passed_on",
        }),
        expect.objectContaining({
          tags: expect.objectContaining({ reason: "resale_in_flight" }),
        }),
      );
    });

    it("never lets a throwing reporter change the outcome", async () => {
      const { deps } = makeDeps(
        { ticketStatus: "LISTED", listingStatus: "HELD" },
        {
          reportError: () => {
            throw new Error("reporter down");
          },
        },
      );

      await expect(
        revokeVolunteerReward(deps, { grantId: GRANT_ID, reason: "signup_withdrawn" }),
      ).resolves.toEqual({ ok: true });
    });

    it("does not look for a listing when the comp was VALID", async () => {
      const { deps, txRepos } = makeDeps({ ticketStatus: "VALID" });

      await revokeVolunteerReward(deps, {
        grantId: GRANT_ID,
        reason: "signup_withdrawn",
      });

      expect(
        (txRepos.resaleListings as any).getByTicketId,
      ).not.toHaveBeenCalled();
    });
  });

  // The comp is voided only while it is still the volunteer's. Once it has
  // been resold or gifted, the person holding it did nothing wrong: voiding
  // it stranded a refund (the unwind could not hand a dead ticket back) and
  // took a ticket from someone who paid for it.
  describe("a comp that has passed to someone else", () => {
    it.each([
      [
        "resold (the ticket sits on the buyer's RESALE order)",
        { ticketOrderId: RESALE_ORDER_ID, ticketOwnerId: RESALE_BUYER_ID },
      ],
      ["gifted (same order, new owner)", { ticketOwnerId: RESALE_BUYER_ID }],
    ])("%s: revokes the grant and leaves the ticket, comp order and budget alone", async (_name, where) => {
      const reportError = vi.fn();
      const { deps, txRepos } = makeDeps(
        { ticketStatus: "VALID", ...where },
        { reportError },
      );

      const result = await revokeVolunteerReward(deps, {
        grantId: GRANT_ID,
        reason: "signup_withdrawn",
      });

      expect(result).toEqual({ ok: true });
      expect((txRepos.tickets as any).setStatus).not.toHaveBeenCalled();
      expect((txRepos.seats as any).updateStatuses).not.toHaveBeenCalled();
      expect((txRepos.orders as any).cancelCompOrder).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).decrementGrantsUsed,
      ).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).updateGrantStatus,
      ).toHaveBeenCalledWith(
        GRANT_ID,
        expect.objectContaining({ status: "REVOKED" }),
      );
      expect((txRepos.audit as any).log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketPassedOn: {
              ticketId: TICKET_ID,
              ownerHumanId: RESALE_BUYER_ID,
              reason: "resold_or_transferred",
            },
          }),
        }),
      );
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("comp_order_missing: a grant whose comp order cannot be found is treated as passed on", async () => {
      const reportError = vi.fn();
      const { deps, txRepos } = makeDeps(
        { ticketStatus: "VALID" },
        { reportError },
      );
      (txRepos.orders as any).getById.mockResolvedValueOnce(null);

      const result = await revokeVolunteerReward(deps, {
        grantId: GRANT_ID,
        reason: "signup_withdrawn",
      });

      expect(result).toEqual({ ok: true });
      expect((txRepos.tickets as any).setStatus).not.toHaveBeenCalled();
      expect((txRepos.orders as any).cancelCompOrder).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).decrementGrantsUsed,
      ).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).updateGrantStatus,
      ).toHaveBeenCalledWith(
        GRANT_ID,
        expect.objectContaining({ status: "REVOKED" }),
      );
      expect((txRepos.audit as any).log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketPassedOn: expect.objectContaining({
              ticketId: TICKET_ID,
              reason: "comp_order_missing",
            }),
          }),
        }),
      );
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("reads the ticket under the row lock, not with a plain read", async () => {
      const { deps, txRepos } = makeDeps();

      await revokeVolunteerReward(deps, {
        grantId: GRANT_ID,
        reason: "signup_withdrawn",
      });

      expect((txRepos.tickets as any).getByIdForUpdate).toHaveBeenCalledWith(
        TICKET_ID,
      );
      expect((txRepos.tickets as any).getById).not.toHaveBeenCalled();
    });

    it("refuses with a conflict if the void's compare-and-swap loses", async () => {
      const { deps, txRepos } = makeDeps();
      (txRepos.tickets as any).setStatus.mockResolvedValueOnce(false);

      await expect(
        revokeVolunteerReward(deps, { grantId: GRANT_ID, reason: "signup_withdrawn" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(
        (txRepos.volunteering as any).updateGrantStatus,
      ).not.toHaveBeenCalled();
    });
  });
});
