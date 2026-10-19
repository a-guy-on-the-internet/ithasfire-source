import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";
import { createFakeBookingRequestActs } from "@th/test-utils/fakes/booking-request-acts";

import {
  listBookingLineupSuggestions,
  type ListBookingLineupSuggestionsDeps,
} from "../list-booking-lineup-suggestions";
import {
  AGREEMENT_ID,
  EVENT_ID,
  ORG_ID,
  REQUEST_ID,
  buildAgreementRecord,
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
} from "../../booking-requests/__tests__/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// "Suggested from the booking" (lineup-booking-requests v2, FR-006): tagged
// acts on the originating request's bill, PENDING or CONFIRMED, not yet on
// the event's lineup. EDITOR is an edit-role member of the event's owning org.
// ─────────────────────────────────────────────────────────────────────────────

const EDITOR_ID = "30303030-3030-4303-8303-303030303030";
const VIEWER_ID = "31313131-3131-4313-8313-313131313131";
const PENDING_ID = "32323232-3232-4323-8323-323232323232";
const CONFIRMED_ID = "33333333-3333-4333-8333-333333333334";
const DECLINED_ID = "34343434-3434-4343-8343-343434343434";
const ATTACHED_ID = "35353535-3535-4353-8353-353535353535";

function buildDeps(options: {
  agreement?: AgreementRecord | null;
  request?: BookingRequestRecord | null;
} = {}) {
  const event = { id: EVENT_ID, orgId: ORG_ID, humanId: null, stewardship: "OWNED" } as unknown as EventRecord;
  const agreement =
    options.agreement === undefined
      ? buildAgreementRecord({ draftEventId: EVENT_ID })
      : options.agreement;
  const request =
    options.request === undefined
      ? buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID })
      : options.request;

  const acts = createFakeBookingRequestActs({
    senderOf: () => ({ ownerType: "human", ownerId: request?.performerOwnerId ?? "x" }),
  });
  const listActsForRequests = vi.fn(acts.listActsForRequests);

  const repos = {
    events: { getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)) },
    eventHumans: {
      listByEvent: vi.fn(async () => [
        // Already on the lineup — never suggested again.
        { id: "eh-1", eventId: EVENT_ID, humanId: ATTACHED_ID, externalName: null, role: "PERFORMER", sortOrder: 0 },
        { id: "eh-2", eventId: EVENT_ID, humanId: null, externalName: "Free Text", role: "PERFORMER", sortOrder: 1 },
      ]),
    },
    agreements: { findByLinkedEventId: vi.fn(async () => agreement) },
    bookingRequests: {
      findByAgreementId: vi.fn(async () => request),
      listActsForRequests,
    },
    humans: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: `Human ${id.slice(0, 2)}`, status: "ACTIVE" })),
      ),
    },
    organizations: { getByIds: vi.fn(async () => []) },
    entityPages: {
      getByOwners: vi.fn(async (_type: string, ids: string[]) =>
        ids
          .filter((id) => id === CONFIRMED_ID)
          .map((id) => ({
            id: "page-1",
            ownerType: "HUMAN",
            ownerId: id,
            slug: "confirmed-act",
            displayName: "Confirmed Act",
            visibility: "PUBLIC",
          })),
      ),
    },
    authz: {
      getOrgMembership: vi.fn(async ({ humanId }: { humanId: string }) =>
        humanId === EDITOR_ID
          ? { orgId: ORG_ID, humanId, role: "ADMIN" }
          : humanId === VIEWER_ID
            ? { orgId: ORG_ID, humanId, role: "VIEWER" }
            : null,
      ),
    },
  };

  const deps = {
    repos: repos as unknown as ListBookingLineupSuggestionsDeps["repos"],
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
  } as unknown as ListBookingLineupSuggestionsDeps;

  return { deps, acts, repos, listActsForRequests };
}

async function seed(acts: ReturnType<typeof createFakeBookingRequestActs>) {
  await acts.addActs(REQUEST_ID, [
    { source: "SELF", sortOrder: 0 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: ATTACHED_ID, sortOrder: 1 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: PENDING_ID, sortOrder: 2 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: CONFIRMED_ID, sortOrder: 3 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: DECLINED_ID, sortOrder: 4 },
    { source: "EXTERNAL", externalName: "Free Text", sortOrder: 5 },
  ]);
  const answer = (actOwnerId: string, to: "CONFIRMED" | "DECLINED") =>
    acts.setActConfirmation({
      bookingRequestId: REQUEST_ID,
      actOwnerType: "human",
      actOwnerId,
      expectedFrom: "PENDING",
      to,
      respondedAt: new Date("2026-06-05T00:00:00.000Z"),
    });
  await answer(ATTACHED_ID, "CONFIRMED");
  await answer(CONFIRMED_ID, "CONFIRMED");
  await answer(DECLINED_ID, "DECLINED");
}

const input = { actorHumanId: EDITOR_ID, eventId: EVENT_ID };

describe("listBookingLineupSuggestions", () => {
  it("returns pending + confirmed-but-not-attached tagged acts; never declined, attached, SELF or free text", async () => {
    const { deps, acts } = buildDeps();
    await seed(acts);

    const result = await listBookingLineupSuggestions(deps, input);

    expect(result.bookingRequestId).toBe(REQUEST_ID);
    expect(result.suggestions).toEqual([
      expect.objectContaining({
        humanId: PENDING_ID,
        confirmation: "PENDING",
        sortOrder: 2,
        href: null,
      }),
      expect.objectContaining({
        humanId: CONFIRMED_ID,
        confirmation: "CONFIRMED",
        displayName: "Confirmed Act",
        href: "/humans/confirmed-act",
        sortOrder: 3,
      }),
    ]);
  });

  it("gates on the lineup editor's bar: a read-only member is refused, before any booking read", async () => {
    const { deps, acts, repos } = buildDeps();
    await seed(acts);

    await expect(
      listBookingLineupSuggestions(deps, { ...input, actorHumanId: VIEWER_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(repos.agreements.findByLinkedEventId).not.toHaveBeenCalled();
  });

  it("an unknown event is EVENT_NOT_FOUND", async () => {
    const { deps } = buildDeps();
    await expect(
      listBookingLineupSuggestions(deps, { ...input, eventId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("empty for an event with no booking behind it (no agreement / no request / TO_PERFORMER)", async () => {
    for (const options of [
      { agreement: null },
      { request: null },
      { request: buildOrganizerBookingRequestRecord({ agreementId: AGREEMENT_ID }) },
    ]) {
      const { deps, listActsForRequests } = buildDeps(options);
      await expect(listBookingLineupSuggestions(deps, input)).resolves.toEqual({
        bookingRequestId: null,
        suggestions: [],
      });
      expect(listActsForRequests).not.toHaveBeenCalled();
    }
  });

  it("numbers suggestions over the VENUE-FACING bill: a passed act ahead of an invited one leaves no gap (v3 FR-004 / NFR-002)", async () => {
    const { deps, acts } = buildDeps();
    await acts.addActs(REQUEST_ID, [
      { source: "SELF", sortOrder: 0 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: DECLINED_ID, sortOrder: 1 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: PENDING_ID, sortOrder: 2 },
    ]);
    await acts.setActConfirmation({
      bookingRequestId: REQUEST_ID,
      actOwnerType: "human",
      actOwnerId: DECLINED_ID,
      expectedFrom: "PENDING",
      to: "DECLINED",
      respondedAt: new Date("2026-06-05T00:00:00.000Z"),
    });

    const result = await listBookingLineupSuggestions(deps, input);
    // Stored at 2; the venue side counts SELF, then the invited act — the
    // passed one is not on its bill, so its slot must not show as a gap.
    expect(result.suggestions).toEqual([
      expect.objectContaining({ humanId: PENDING_ID, sortOrder: 1 }),
    ]);
  });

  it("a legacy booking (no act rows) suggests nothing", async () => {
    const { deps } = buildDeps();
    await expect(listBookingLineupSuggestions(deps, input)).resolves.toEqual({
      bookingRequestId: REQUEST_ID,
      suggestions: [],
    });
  });
});
