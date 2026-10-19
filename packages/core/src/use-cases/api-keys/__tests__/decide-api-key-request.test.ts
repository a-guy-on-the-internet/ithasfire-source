import { describe, expect, it, vi } from "vitest";

import { ApiKeyRepoError } from "@th/ports/repos/api-keys";
import type { StepUpPort } from "@th/ports/step-up";

import { decideApiKeyRequest } from "../decide-api-key-request";
import {
  ACTING_KEY,
  ALICE,
  BOB,
  CAROL,
  daysAgo,
  defaultWorld,
  makeHarness,
  makeRequest,
  MODERATOR,
  NOW,
  ORG,
  OUTSIDER,
  OWNER_ID,
  REQ,
  STAFF_ADMIN,
  STAFF_REVIEWER,
  SUSPENDED_ADMIN,
  DAY,
  type World,
} from "./api-keys-harness";

const REASON = "Please say which reports this script needs.";

function setup(
  request: Parameters<typeof makeRequest>[0],
  world: World = defaultWorld(),
  stepUp: StepUpPort | null = null,
) {
  const h = makeHarness(world);
  h.apiKeys.requests.set(REQ, makeRequest(request));
  const deps = { ...h.deps, stepUp };
  return { h, deps };
}

const approve = (
  actorHumanId: string,
  extra: Record<string, unknown> = {},
) => ({
  actorHumanId,
  actingApiKeyId: null,
  requestId: REQ,
  decision: "APPROVED" as const,
  ...extra,
});
const deny = (actorHumanId: string) => ({
  actorHumanId,
  actingApiKeyId: null,
  requestId: REQ,
  decision: "DENIED" as const,
  reason: REASON,
});

const soleOwnerWorld = () => {
  const w = defaultWorld();
  w.orgRoles[ORG] = {
    [ALICE]: "OWNER",
    [SUSPENDED_ADMIN]: "ADMIN",
    [CAROL]: "VIEWER",
  };
  return w;
};

describe("decideApiKeyRequest: who approves (Key scopes table)", () => {
  type Row = [
    string,
    Parameters<typeof makeRequest>[0],
    () => World,
    string,
    string | null,
  ];
  const ORG_REQ = {
    subject: "ORG",
    orgId: ORG,
    requesterHumanId: ALICE,
  } as const;
  const rows: Row[] = [
    ["ORG: another org admin", ORG_REQ, defaultWorld, BOB, null],
    [
      "ORG: org viewer",
      ORG_REQ,
      defaultWorld,
      CAROL,
      "api_key_request_not_found",
    ],
    [
      "ORG: owner of another org",
      ORG_REQ,
      defaultWorld,
      OUTSIDER,
      "api_key_request_not_found",
    ],
    [
      "ORG: staff while the org has an approver",
      ORG_REQ,
      defaultWorld,
      STAFF_ADMIN,
      "api_key_decide_not_allowed",
    ],
    ["ORG: the requester", ORG_REQ, defaultWorld, ALICE, "api_key_own_request"],
    [
      "ORG fallback: platform staff (reviewer)",
      ORG_REQ,
      soleOwnerWorld,
      STAFF_REVIEWER,
      null,
    ],
    [
      "ORG fallback: platform staff (admin)",
      ORG_REQ,
      soleOwnerWorld,
      STAFF_ADMIN,
      null,
    ],
    [
      "ORG fallback: community moderator",
      ORG_REQ,
      soleOwnerWorld,
      MODERATOR,
      "api_key_request_not_found",
    ],
    [
      "ORG fallback: org viewer",
      ORG_REQ,
      soleOwnerWorld,
      CAROL,
      "api_key_request_not_found",
    ],
    [
      "PERSONAL: staff reviewer",
      { subject: "PERSONAL" },
      defaultWorld,
      STAFF_REVIEWER,
      null,
    ],
    [
      "PERSONAL: staff admin",
      { subject: "PERSONAL" },
      defaultWorld,
      STAFF_ADMIN,
      null,
    ],
    [
      "PERSONAL: an org admin",
      { subject: "PERSONAL" },
      defaultWorld,
      BOB,
      "api_key_request_not_found",
    ],
    [
      "PERSONAL: moderator",
      { subject: "PERSONAL" },
      defaultWorld,
      MODERATOR,
      "api_key_request_not_found",
    ],
    [
      "PERSONAL: the requester",
      { subject: "PERSONAL" },
      defaultWorld,
      ALICE,
      "api_key_own_request",
    ],
    [
      "STAFF: staff admin",
      { subject: "STAFF", requesterHumanId: STAFF_REVIEWER },
      defaultWorld,
      STAFF_ADMIN,
      null,
    ],
    [
      "STAFF: staff reviewer",
      { subject: "STAFF", requesterHumanId: STAFF_ADMIN },
      defaultWorld,
      STAFF_REVIEWER,
      "api_key_decide_not_allowed",
    ],
    [
      "STAFF: outsider",
      { subject: "STAFF", requesterHumanId: STAFF_REVIEWER },
      defaultWorld,
      OUTSIDER,
      "api_key_request_not_found",
    ],
    [
      "PLATFORM_WIDE: staff admin",
      { subject: "PLATFORM_WIDE", requesterHumanId: OUTSIDER },
      defaultWorld,
      STAFF_ADMIN,
      null,
    ],
    [
      "PLATFORM_WIDE: staff reviewer",
      { subject: "PLATFORM_WIDE", requesterHumanId: OUTSIDER },
      defaultWorld,
      STAFF_REVIEWER,
      "api_key_decide_not_allowed",
    ],
  ];

  it.each(rows)("%s", async (_name, request, world, actor, refusal) => {
    const { h, deps } = setup(request, world());
    const call = decideApiKeyRequest(deps, approve(actor));
    if (refusal === null) {
      await expect(call).resolves.toMatchObject({
        status: "ready_to_collect",
        selfApproved: false,
      });
      expect(h.apiKeys.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          decidedByHumanId: actor,
          selfApproved: false,
        }),
      );
    } else {
      await expect(call).rejects.toMatchObject({ message: refusal });
      expect(h.apiKeys.decide).not.toHaveBeenCalled();
    }
  });

  it("uses orgHasOtherLiveApprover (the queue's own rule) for the ORG fallback", async () => {
    const { h, deps } = setup(
      { subject: "ORG", orgId: ORG, requesterHumanId: ALICE },
      soleOwnerWorld(),
    );
    await decideApiKeyRequest(deps, approve(STAFF_REVIEWER));
    expect(h.apiKeys.orgHasOtherLiveApprover).toHaveBeenCalledWith({
      orgId: ORG,
      excludeHumanId: ALICE,
    });
  });

  it("answers not found for an unknown request", async () => {
    const h = makeHarness();
    await expect(
      decideApiKeyRequest(h.deps, approve(STAFF_ADMIN)),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "api_key_request_not_found",
    });
  });

  it("refuses a key caller (session only)", async () => {
    const { deps } = setup({ subject: "PERSONAL" });
    await expect(
      decideApiKeyRequest(
        deps,
        approve(STAFF_ADMIN, { actingApiKeyId: ACTING_KEY }),
      ),
    ).rejects.toMatchObject({ message: "api_key_session_only" });
  });
});

describe("decideApiKeyRequest: platform owner self-approval (FR-003, R21, R30)", () => {
  const ownStaff = {
    subject: "STAFF",
    requesterHumanId: OWNER_ID,
    expiryDays: 30,
    autoRenew: true,
  } as const;
  const verified = () => ({
    verifyFresh: vi.fn(async () => ({ verified: true })),
  });

  it("approves with a fresh step-up and records selfApproved", async () => {
    const stepUp = verified();
    const { h, deps } = setup(ownStaff, defaultWorld(), stepUp);
    const out = await decideApiKeyRequest(
      deps,
      approve(OWNER_ID, { stepUpProof: "proof-token" }),
    );
    expect(out).toMatchObject({
      status: "ready_to_collect",
      selfApproved: true,
    });
    expect(stepUp.verifyFresh).toHaveBeenCalledTimes(1);
    expect(stepUp.verifyFresh).toHaveBeenCalledWith({
      humanId: OWNER_ID,
      purpose: "api_key_self_approval",
      requestId: REQ,
      proof: "proof-token",
      maxAgeSeconds: 300,
    });
    expect(h.apiKeys.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        selfApproved: true,
        decidedByHumanId: OWNER_ID,
      }),
    );
    expect(h.auditEntries()[0]).toMatchObject({
      action: "api_key_request.approved",
      data: {
        via: "self_approval",
        selfApproved: true,
        holderHumanId: OWNER_ID,
      },
    });
    // Nobody to tell: the approver is the requester.
    expect(h.notifyApiKey).not.toHaveBeenCalled();
  });

  it.each([2, 30])("accepts a %i-day term", async (days) => {
    const { deps } = setup(
      { ...ownStaff, expiryDays: days },
      defaultWorld(),
      verified(),
    );
    await expect(
      decideApiKeyRequest(deps, approve(OWNER_ID, { stepUpProof: "p" })),
    ).resolves.toMatchObject({ selfApproved: true });
  });

  it("refuses without a proof, with a stale proof, or with no step-up port", async () => {
    const stale: StepUpPort = {
      verifyFresh: vi.fn(async () => ({ verified: false })),
    };
    for (const [stepUp, proof] of [
      [verified(), undefined],
      [stale, "old"],
      [null, "p"],
    ] as const) {
      const { h, deps } = setup(ownStaff, defaultWorld(), stepUp);
      await expect(
        decideApiKeyRequest(deps, approve(OWNER_ID, { stepUpProof: proof })),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "api_key_step_up_required",
      });
      expect(h.apiKeys.decide).not.toHaveBeenCalled();
    }
  });

  it.each([
    [{ expiryDays: 1, autoRenew: false }],
    [{ expiryDays: 30, autoRenew: false }],
  ])("refuses terms outside 2–30 days with auto-renew: %o", async (over) => {
    const stepUp = verified();
    const { deps } = setup({ ...ownStaff, ...over }, defaultWorld(), stepUp);
    await expect(
      decideApiKeyRequest(deps, approve(OWNER_ID, { stepUpProof: "p" })),
    ).rejects.toMatchObject({ message: "api_key_self_approval_terms" });
    expect(stepUp.verifyFresh).not.toHaveBeenCalled();
  });

  it("verifies the proof once, before the transaction: a deadlock retry does not re-verify", async () => {
    const stepUp = verified();
    const { h, deps } = setup(ownStaff, defaultWorld(), stepUp);
    h.apiKeys.decide.mockRejectedValueOnce(
      new ApiKeyRepoError({
        code: "retryable",
        reason: null,
        constraint: null,
        sqlState: "40P01",
        message: "deadlock detected",
      }),
    );
    await expect(
      decideApiKeyRequest(deps, approve(OWNER_ID, { stepUpProof: "p" })),
    ).resolves.toMatchObject({ selfApproved: true });
    expect(h.tx).toHaveBeenCalledTimes(2);
    expect(stepUp.verifyFresh).toHaveBeenCalledTimes(1);
    expect(stepUp.verifyFresh.mock.invocationCallOrder[0]!).toBeLessThan(
      h.tx.mock.invocationCallOrder[0]!,
    );
  });

  it("does not spend a proof on a decision refused by the cheap checks", async () => {
    const world = defaultWorld();
    world.humans[OWNER_ID]!.emailVerified = false;
    const ineligible = setup(ownStaff, world, verified());
    await expect(
      decideApiKeyRequest(
        ineligible.deps,
        approve(OWNER_ID, { stepUpProof: "p" }),
      ),
    ).rejects.toMatchObject({
      message: "api_key_requester_no_longer_eligible",
      // The requester's own path keeps the detail.
      meta: { why: "email_unverified" },
    });
    expect(ineligible.deps.stepUp!.verifyFresh).not.toHaveBeenCalled();

    const lapsed = setup(
      { ...ownStaff, createdAt: daysAgo(15) },
      defaultWorld(),
      verified(),
    );
    await expect(
      decideApiKeyRequest(lapsed.deps, approve(OWNER_ID, { stepUpProof: "p" })),
    ).rejects.toMatchObject({ message: "api_key_request_lapsed" });
    expect(lapsed.deps.stepUp!.verifyFresh).not.toHaveBeenCalled();
    expect(lapsed.h.apiKeys.decide).not.toHaveBeenCalled();
  });

  it("never self-approves without a verified proof, even when the transaction reads a pending request the pre-flight saw closed", async () => {
    const stepUp = verified();
    const { h, deps } = setup(ownStaff, defaultWorld(), stepUp);
    // Pre-flight reads a closed request (no proof spent); the transaction
    // reads it pending (e.g. a stale replica): it must refuse, not approve.
    h.apiKeys.getRequest.mockResolvedValueOnce(
      makeRequest({
        ...ownStaff,
        withdrawnAt: NOW,
        withdrawalReason: "ACCOUNT_SECURITY",
      }),
    );
    await expect(
      decideApiKeyRequest(deps, approve(OWNER_ID, { stepUpProof: "p" })),
    ).rejects.toMatchObject({ message: "api_key_step_up_required" });
    expect(stepUp.verifyFresh).not.toHaveBeenCalled();
    expect(h.apiKeys.decide).not.toHaveBeenCalled();
  });

  it("is STAFF only: the owner's own PERSONAL request is refused", async () => {
    const { deps } = setup(
      { subject: "PERSONAL", requesterHumanId: OWNER_ID },
      defaultWorld(),
      verified(),
    );
    await expect(
      decideApiKeyRequest(deps, approve(OWNER_ID, { stepUpProof: "p" })),
    ).rejects.toMatchObject({ message: "api_key_own_request" });
  });

  it("is the platform owner only: another staff ADMIN cannot self-approve", async () => {
    const { deps } = setup(
      { ...ownStaff, requesterHumanId: STAFF_ADMIN },
      defaultWorld(),
      verified(),
    );
    await expect(
      decideApiKeyRequest(deps, approve(STAFF_ADMIN, { stepUpProof: "p" })),
    ).rejects.toMatchObject({ message: "api_key_own_request" });
  });

  it("an environment with no platform owner lets nobody self-approve", async () => {
    const { deps } = setup(ownStaff, defaultWorld(), verified());
    await expect(
      decideApiKeyRequest(
        { ...deps, platformOwnerEnvironment: null },
        approve(OWNER_ID, { stepUpProof: "p" }),
      ),
    ).rejects.toMatchObject({ message: "api_key_own_request" });
    await expect(
      decideApiKeyRequest(
        // production has no owner id yet (fail closed)
        { ...deps, platformOwnerEnvironment: "production" },
        approve(OWNER_ID, { stepUpProof: "p" }),
      ),
    ).rejects.toMatchObject({ message: "api_key_own_request" });
  });

  it("the owner still needs the staff ADMIN role", async () => {
    const world = defaultWorld();
    world.staffRoles[OWNER_ID] = ["REVIEWER"];
    const { deps } = setup(ownStaff, world, verified());
    await expect(
      decideApiKeyRequest(deps, approve(OWNER_ID, { stepUpProof: "p" })),
    ).rejects.toMatchObject({ message: "api_key_own_request" });
  });

  it("the owner cannot deny their own request (withdraw it instead)", async () => {
    const { deps } = setup(ownStaff, defaultWorld(), verified());
    await expect(
      decideApiKeyRequest(deps, { ...deny(OWNER_ID), stepUpProof: "p" }),
    ).rejects.toMatchObject({ message: "api_key_own_request" });
  });
});

describe("decideApiKeyRequest: denial, eligibility, state", () => {
  it("needs a reason to deny and passes it on; an approval carries none", async () => {
    const { h, deps } = setup({ subject: "PERSONAL" });
    await expect(
      decideApiKeyRequest(deps, { ...deny(STAFF_ADMIN), reason: undefined }),
    ).rejects.toMatchObject({ message: "api_key_denial_reason_required" });
    await expect(
      decideApiKeyRequest(deps, { ...deny(STAFF_ADMIN), reason: "<b>no</b>" }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const out = await decideApiKeyRequest(deps, deny(STAFF_ADMIN));
    expect(out.status).toBe("denied");
    expect(h.apiKeys.decide).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "DENIED", denialReason: REASON }),
    );
    expect(h.notifyApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "request_denied",
        denialReason: REASON,
        audience: { kind: "human", humanId: ALICE },
      }),
    );
  });

  it("drops a reason sent with an approval", async () => {
    const { h, deps } = setup({ subject: "PERSONAL" });
    await decideApiKeyRequest(deps, approve(STAFF_ADMIN, { reason: REASON }));
    expect(h.apiKeys.decide).toHaveBeenCalledWith(
      expect.objectContaining({ denialReason: null }),
    );
  });

  it("tells the requester on approval, with the collect deadline", async () => {
    const { h, deps } = setup({ subject: "PERSONAL" });
    await decideApiKeyRequest(deps, approve(STAFF_ADMIN));
    expect(h.notifyApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "request_approved",
        collectBy: new Date(NOW.getTime() + 7 * DAY),
      }),
    );
  });

  it("re-checks the requester at approval (FR-002); denial still allowed", async () => {
    const world = defaultWorld();
    world.orgRoles[ORG]![BOB] = "VIEWER"; // demoted after asking
    const { deps } = setup(
      { subject: "ORG", orgId: ORG, requesterHumanId: BOB },
      world,
    );
    await expect(decideApiKeyRequest(deps, approve(ALICE))).rejects.toSatisfy(
      (e: unknown) =>
        // No `why` for the approver: "inactive" would reveal a ban.
        (e as { message: string }).message ===
          "api_key_requester_no_longer_eligible" &&
        (e as { meta?: unknown }).meta === undefined,
    );
    await expect(decideApiKeyRequest(deps, deny(ALICE))).resolves.toMatchObject(
      {
        status: "denied",
      },
    );
  });

  it.each([
    [
      { withdrawnAt: daysAgo(0), withdrawalReason: "REQUESTER" },
      "api_key_request_withdrawn",
    ],
    [
      { withdrawnAt: daysAgo(0), withdrawalReason: "ACCOUNT_SECURITY" },
      "api_key_request_closed_for_account_security",
    ],
    [{ createdAt: daysAgo(15) }, "api_key_request_lapsed"],
    [
      {
        decidedAt: daysAgo(0),
        decision: "APPROVED",
        decidedByHumanId: STAFF_REVIEWER,
      },
      "api_key_request_already_decided",
    ],
    [
      {
        decidedAt: daysAgo(0),
        decision: "DENIED",
        decidedByHumanId: STAFF_ADMIN,
        denialReason: REASON,
      },
      "api_key_request_already_decided",
    ],
  ] as const)("CAS outcome %o → %s", async (over, code) => {
    const { h, deps } = setup({ subject: "PERSONAL", ...over });
    await expect(
      decideApiKeyRequest(deps, approve(STAFF_ADMIN)),
    ).rejects.toMatchObject({
      code: "conflict",
      message: code,
    });
    expect(h.audit.log).not.toHaveBeenCalled();
    expect(h.notifyApiKey).not.toHaveBeenCalled();
  });

  it("is idempotent for the same decider and decision", async () => {
    const { h, deps } = setup({
      subject: "PERSONAL",
      decidedAt: NOW,
      decision: "APPROVED",
      decidedByHumanId: STAFF_ADMIN,
    });
    await expect(
      decideApiKeyRequest(deps, approve(STAFF_ADMIN)),
    ).resolves.toMatchObject({
      status: "ready_to_collect",
    });
    expect(h.apiKeys.decide).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it("allows denying a lapsed request", async () => {
    const { deps } = setup({ subject: "PERSONAL", createdAt: daysAgo(20) });
    await expect(
      decideApiKeyRequest(deps, deny(STAFF_ADMIN)),
    ).resolves.toMatchObject({
      status: "denied",
    });
  });
});

describe("decideApiKeyRequest: repo refusals and notices", () => {
  const refusal = (reason: string) =>
    new ApiKeyRepoError({
      code: "guard_refused",
      reason: reason as never,
      constraint: "api_key_requests_guard",
      sqlState: "23514",
      message: "api_key_requests_guard: secret detail",
    });

  it.each([
    ["request_lapsed", "api_key_request_lapsed"],
    ["decision_final", "api_key_request_already_decided"],
    ["request_withdrawn", "api_key_request_withdrawn"],
    ["undecided_with_decider", "api_key_write_refused"],
    ["check_violation", "api_key_write_refused"],
  ])("maps %s → %s", async (reason, code) => {
    const { h, deps } = setup({ subject: "PERSONAL" });
    h.apiKeys.decide.mockRejectedValueOnce(refusal(reason));
    const err = await decideApiKeyRequest(deps, approve(STAFF_ADMIN)).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ message: code });
    expect(String(err.message)).not.toContain("secret detail");
    expect(h.notifyApiKey).not.toHaveBeenCalled();
  });

  it("reports a failed notice; the decision stands", async () => {
    const { h, deps } = setup({ subject: "PERSONAL" });
    h.notifyApiKey.mockRejectedValueOnce(new Error("down"));
    h.reportError.mockImplementationOnce(() => {
      throw new Error("reporter down");
    });
    await expect(
      decideApiKeyRequest(deps, approve(STAFF_ADMIN)),
    ).resolves.toMatchObject({
      status: "ready_to_collect",
    });
    expect(h.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "decideApiKeyRequest", notice: "request_approved" },
      extra: { requestId: REQ },
    });
  });

  it("audits the decision with a scope snapshot", async () => {
    const { h, deps } = setup({
      subject: "ORG",
      orgId: ORG,
      requesterHumanId: ALICE,
    });
    await decideApiKeyRequest(deps, approve(BOB));
    expect(h.auditEntries()[0]).toMatchObject({
      action: "api_key_request.approved",
      data: {
        actorHumanId: BOB,
        actingApiKeyId: null,
        requestId: REQ,
        holderHumanId: ALICE,
        subject: "ORG",
        orgId: ORG,
        access: "READ",
        decidedByHumanId: BOB,
        selfApproved: false,
        via: "org_admin",
      },
    });
  });
});
