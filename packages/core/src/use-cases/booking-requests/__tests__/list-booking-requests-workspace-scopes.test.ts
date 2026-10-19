import { describe, expect, it, vi } from "vitest";

import { createFakeBookingRequestActs } from "@th/test-utils/fakes/booking-request-acts";

import { listBookingRequests } from "../list-booking-requests";
import type { ListBookingRequestsDeps } from "../list-booking-requests";
import {
  ACTOR_ID,
  ORG_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
  buildStageRepos,
  buildUnreadCountingRepo,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// The admin workspace's own lists (lineup-booking-requests v3, FR-014 /
// L15): "sent-to-venues" — the requests the workspace's subject SENT to
// venues, as the venue inbox row mirrored for the sender (bill as the sender
// sees it, stage, the sender's holds) — and "received-as-performer". The
// subject is the org (`orgId`, ORG_EDIT_ROLES) or the actor (no id).
// ─────────────────────────────────────────────────────────────────────────────

const EDITOR = "30303030-3030-4303-8303-303030303030";
const VIEWER = "31313131-3131-4313-8313-313131313131";
const DELLA = "32323232-3232-4323-8323-323232323232";

function buildDeps() {
  const sentByOrg = buildBookingRequestRecord({
    performerOwnerType: "organization",
    performerOwnerId: ORG_ID,
  });
  const sentByActor = buildBookingRequestRecord({ id: "40404040-4040-4404-8404-404040404040" });
  const received = buildOrganizerBookingRequestRecord({
    id: "41414141-4141-4414-8414-414141414141",
  });
  const acts = createFakeBookingRequestActs({
    senderOf: async (id) =>
      id === REQUEST_ID ? { ownerType: "organization", ownerId: ORG_ID } : null,
  });
  const bookingRequests = {
    listForPerformer: vi.fn(async ({ ownerType }: { ownerType: string }) =>
      ownerType === "organization" ? [sentByOrg] : [sentByActor],
    ),
    listForPerformerInbox: vi.fn(async () => [received]),
    listActsForRequests: vi.fn(async (ids: readonly string[]) => acts.listActsForRequests(ids)),
  };
  const stage = buildStageRepos();
  const deps: ListBookingRequestsDeps = {
    repos: {
      bookingRequests,
      places: { getById: vi.fn() },
      authz: {
        getOrgMembership: vi.fn(async ({ orgId, humanId }: { orgId: string; humanId: string }) =>
          orgId === ORG_ID && humanId === EDITOR
            ? { orgId, humanId, role: "EDITOR" }
            : orgId === ORG_ID && humanId === VIEWER
              ? { orgId, humanId, role: "VIEWER" }
              : null,
        ),
        getOrgMemberships: vi.fn(async () => []),
      },
      humans: {
        getByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: id === DELLA ? "Della" : "Sam" }))),
      },
      organizations: {
        getByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: "Corner Collective" }))),
      },
      entityPages: { getByOwners: vi.fn(async () => []) },
      bookingRequestMessages: buildUnreadCountingRepo(),
      agreements: stage.agreements,
      events: stage.events,
      bookingHolds: stage.bookingHolds,
      bookingTags: stage.bookingTags,
    } as unknown as ListBookingRequestsDeps["repos"],
  };
  return { deps, acts, bookingRequests };
}

describe("listBookingRequests — workspace scopes (v3 FR-014)", () => {
  it("sent-to-venues for an ORG workspace: the org's sent rows with the bill as the sender sees it (a passed act kept)", async () => {
    const { deps, acts, bookingRequests } = buildDeps();
    await acts.addActs(REQUEST_ID, [
      { source: "SELF", sortOrder: 0 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: DELLA, sortOrder: 1 },
    ]);
    await acts.setActConfirmation({
      bookingRequestId: REQUEST_ID,
      actOwnerType: "human",
      actOwnerId: DELLA,
      expectedFrom: "PENDING",
      to: "DECLINED",
      respondedAt: new Date(),
    });

    const out = await listBookingRequests(deps, {
      actorHumanId: EDITOR,
      scope: "sent-to-venues",
      orgId: ORG_ID,
    });

    expect(bookingRequests.listForPerformer).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: "organization", ownerId: ORG_ID }),
    );
    expect(out.requests).toHaveLength(1);
    const row = out.requests[0]!;
    expect(row.bill.map((item) => [item.displayName, item.confirmation])).toEqual([
      ["Corner Collective", "CONFIRMED"],
      ["Della", "DECLINED"],
    ]);
    // The sender's own view: no venue-internal fields.
    expect(row.assigneeHumanId).toBeNull();
    expect(row.tags).toEqual([]);
  });

  it("the org workspace gate is ORG_EDIT_ROLES: a VIEWER and a stranger are refused", async () => {
    const { deps } = buildDeps();
    for (const actorHumanId of [VIEWER, DELLA]) {
      await expect(
        listBookingRequests(deps, { actorHumanId, scope: "sent-to-venues", orgId: ORG_ID }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      await expect(
        listBookingRequests(deps, { actorHumanId, scope: "received-as-performer", orgId: ORG_ID }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    }
  });

  it("the person's workspace (no orgId) is always the actor's own — no id to borrow", async () => {
    const { deps, bookingRequests } = buildDeps();
    const out = await listBookingRequests(deps, { actorHumanId: ACTOR_ID, scope: "sent-to-venues" });
    expect(bookingRequests.listForPerformer).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: "human", ownerId: ACTOR_ID }),
    );
    expect(out.requests.map((r) => r.id)).toEqual(["40404040-4040-4404-8404-404040404040"]);
  });

  it("received-as-performer lists the subject's RECEIVED organizer requests, which carry no bill", async () => {
    const { deps, bookingRequests } = buildDeps();
    const out = await listBookingRequests(deps, {
      actorHumanId: EDITOR,
      scope: "received-as-performer",
      orgId: ORG_ID,
    });
    expect(bookingRequests.listForPerformerInbox).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: "organization", ownerId: ORG_ID }),
    );
    expect(out.requests.map((r) => [r.direction, r.bill])).toEqual([["TO_PERFORMER", []]]);
    expect(bookingRequests.listActsForRequests).not.toHaveBeenCalled();
  });
});
