import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";

import { claimBookingRequest } from "../claim-booking-request";
import type { ClaimBookingRequestDeps } from "../claim-booking-request";
import { markBookingRequestViewed } from "../mark-booking-request-viewed";
import type { MarkBookingRequestViewedDeps } from "../mark-booking-request-viewed";
import { withdrawBookingRequest } from "../withdraw-booking-request";
import type { WithdrawBookingRequestDeps } from "../withdraw-booking-request";
import { resendBookingRequestInvite } from "../resend-booking-request-invite";
import type { ResendBookingRequestInviteDeps } from "../resend-booking-request-invite";
import {
  ACTOR_ID,
  NOW,
  ORGANIZER_ORG_ID,
  ORG_ID,
  OTHER_HUMAN_ID,
  REQUEST_ID,
  buildOrganizerBookingRequestRecord,
  buildPerformerProfile,
  makeFakeIdempotency,
  withTx,
} from "./helpers";

/**
 * NFR-001 direction-guard matrix (organizer-booking-requests): TO_PERFORMER
 * rows must never ride the venue-side machinery, and the receiving-side authz
 * must follow the direction. The list-scope leakage half of NFR-001 is
 * enforced at the repo WHERE clause (see the adapters integration suite);
 * these tests cover the per-request use cases.
 */

type GuardOptions = {
  membership?: OrgMembership | null;
  memberships?: OrgMembership[];
};

function buildGuardDeps(
  record: ReturnType<typeof buildOrganizerBookingRequestRecord>,
  options: GuardOptions = {},
) {
  let current = record;
  const bookingRequests = {
    getById: vi.fn(async () => current),
    markViewed: vi.fn(
      async (input: { id: string; now: Date }) =>
        (current = { ...current, status: "VIEWED", viewedAt: input.now }),
    ),
    updateStatus: vi.fn(
      async (input: { status: string }) =>
        (current = {
          ...current,
          status: input.status as typeof current.status,
        }),
    ),
  };
  const places = {
    getById: vi.fn(async () => {
      throw new Error("places must never load for a TO_PERFORMER request");
    }),
  };
  const authz = {
    getOrgMembership: vi.fn(async () => options.membership ?? null),
    getOrgMemberships: vi.fn(async () => options.memberships ?? []),
  };
  const audit = { log: vi.fn(async () => {}) };

  const mocks = withTx({ bookingRequests, places, authz, audit });
  return {
    mocks: { bookingRequests, places, authz, audit },
    repos: mocks,
    clock: { now: () => NOW },
  };
}

describe("markBookingRequestViewed — TO_PERFORMER authz", () => {
  it("the target human act can mark viewed (no place load)", async () => {
    const { repos, mocks, clock } = buildGuardDeps(
      buildOrganizerBookingRequestRecord(),
    );
    const deps = {
      repos,
      clock,
    } as unknown as MarkBookingRequestViewedDeps;

    const result = await markBookingRequestViewed(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(result.status).toBe("VIEWED");
    expect(mocks.places.getById).not.toHaveBeenCalled();
  });

  it("an org-act member (any role) can mark viewed", async () => {
    const { repos, clock } = buildGuardDeps(
      buildOrganizerBookingRequestRecord({
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
      }),
      {
        membership: {
          orgId: ORG_ID,
          humanId: ACTOR_ID,
          role: "VIEWER",
        } as OrgMembership,
      },
    );
    const deps = { repos, clock } as unknown as MarkBookingRequestViewedDeps;

    const result = await markBookingRequestViewed(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(result.status).toBe("VIEWED");
  });

  it("a stranger (e.g. the sender org's member) cannot mark the act's copy viewed", async () => {
    const { repos, clock } = buildGuardDeps(
      buildOrganizerBookingRequestRecord(),
    );
    const deps = { repos, clock } as unknown as MarkBookingRequestViewedDeps;

    await expect(
      markBookingRequestViewed(deps, {
        actorHumanId: OTHER_HUMAN_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});

describe("withdrawBookingRequest — TO_PERFORMER authz", () => {
  it("a sender-org editor can withdraw the outbound request", async () => {
    const { repos, mocks, clock } = buildGuardDeps(
      buildOrganizerBookingRequestRecord(),
      {
        membership: {
          orgId: ORGANIZER_ORG_ID,
          humanId: OTHER_HUMAN_ID,
          role: "EDITOR",
        } as OrgMembership,
      },
    );
    const deps = { repos, clock } as unknown as WithdrawBookingRequestDeps;

    const result = await withdrawBookingRequest(deps, {
      actorHumanId: OTHER_HUMAN_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(result.status).toBe("WITHDRAWN");
    expect(mocks.authz.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORGANIZER_ORG_ID,
      humanId: OTHER_HUMAN_ID,
    });
  });

  it("the TARGET act cannot withdraw an organizer request (they decline instead)", async () => {
    // The act pair identifies the target here — without the direction branch
    // the old sender-based authz would let the act withdraw.
    const { repos, clock } = buildGuardDeps(
      buildOrganizerBookingRequestRecord(),
    );
    const deps = { repos, clock } as unknown as WithdrawBookingRequestDeps;

    await expect(
      withdrawBookingRequest(deps, {
        actorHumanId: ACTOR_ID, // the act itself
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("a sender-org viewer cannot withdraw", async () => {
    const { repos, clock } = buildGuardDeps(
      buildOrganizerBookingRequestRecord(),
      {
        membership: {
          orgId: ORGANIZER_ORG_ID,
          humanId: OTHER_HUMAN_ID,
          role: "VIEWER",
        } as OrgMembership,
      },
    );
    const deps = { repos, clock } as unknown as WithdrawBookingRequestDeps;

    await expect(
      withdrawBookingRequest(deps, {
        actorHumanId: OTHER_HUMAN_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

describe("claimBookingRequest — TO_PERFORMER guard", () => {
  it("a claim token that somehow resolves to a TO_PERFORMER row is rejected as TOKEN_INVALID (wrong_direction)", async () => {
    // Structurally unreachable in prod (TO_PERFORMER rows never carry a
    // token — DB CHECK + adapter never writes one), so force the corrupt
    // shape directly onto the record the token lookup returns.
    const corrupt = {
      ...buildOrganizerBookingRequestRecord({ status: "ACCEPTED" }),
      claimTokenHash: "deadbeef",
      claimTokenExpiresAt: new Date(NOW.getTime() + 86_400_000),
    };
    const bookingRequests = {
      findByClaimTokenHash: vi.fn(async () => corrupt),
      claim: vi.fn(async () => {
        throw new Error("claim must never run for a TO_PERFORMER row");
      }),
    };
    const places = {
      getById: vi.fn(async () => {
        throw new Error("places must never load for a TO_PERFORMER request");
      }),
    };
    const performerProfiles = {
      getByOwner: vi.fn(async () => buildPerformerProfile()),
    };
    const authz = {
      getOrgMembership: vi.fn(async () => null),
      getOrgMemberships: vi.fn(async () => []),
    };
    const audit = { log: vi.fn(async () => {}) };
    const deps = {
      repos: withTx({
        bookingRequests,
        places,
        performerProfiles,
        authz,
        audit,
      }),
      idempotency: makeFakeIdempotency(),
      clock: { now: () => NOW },
    } as unknown as ClaimBookingRequestDeps;

    await expect(
      claimBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        rawToken: "A".repeat(43),
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
      }),
    ).rejects.toMatchObject({
      code: "TOKEN_INVALID",
      meta: expect.objectContaining({ reason: "wrong_direction" }),
    });
    expect(bookingRequests.claim).not.toHaveBeenCalled();
    expect(places.getById).not.toHaveBeenCalled();
  });
});

describe("resendBookingRequestInvite — TO_PERFORMER guard", () => {
  it("rejects a TO_PERFORMER row before any venue machinery runs", async () => {
    const { repos, mocks, clock } = buildGuardDeps(
      buildOrganizerBookingRequestRecord({ status: "ACCEPTED" }),
    );
    const deps = {
      repos,
      clock,
    } as unknown as ResendBookingRequestInviteDeps;

    await expect(
      resendBookingRequestInvite(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_STATUS",
      meta: expect.objectContaining({ reason: "wrong_direction" }),
    });
    expect(mocks.places.getById).not.toHaveBeenCalled();
  });
});
