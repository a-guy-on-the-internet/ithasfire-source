import { describe, expect, it, vi } from "vitest";

import type { BookingRequestActRecord } from "@th/ports/repos/booking-requests";

import {
  bookingLineupAnsweredIdempotencyKey,
  notifyBookingLineupAnswered,
  type NotifyBookingLineupAnsweredDeps,
} from "../notify-booking-lineup-answered";
import {
  bookingLineupInvitedIdempotencyKey,
  notifyBookingLineupInvited,
  type NotifyBookingLineupInvitedDeps,
} from "../notify-booking-lineup-invited";
import {
  bookingLineupRemovedIdempotencyKey,
  notifyBookingLineupRemoved,
  type NotifyBookingLineupRemovedDeps,
} from "../notify-booking-lineup-removed";
import {
  bookingLineupRequestClosedIdempotencyKey,
  notifyBookingLineupRequestClosed,
  type NotifyBookingLineupRequestClosedDeps,
} from "../notify-booking-lineup-request-closed";
import { renderNotification } from "../../comms/renderers";
import {
  ACTOR_ID,
  NOW,
  ORG_ID,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// The bill's notices (lineup-booking-requests v3, FR-012): who hears what,
// on which channels, under which idempotency key — and the swallow every one
// of them follows (logger.error + guarded reportError, CLAUDE.md).
// ─────────────────────────────────────────────────────────────────────────────

const DELLA = "e2e2e2e2-0000-4000-8000-000000000001";
const MAREN = "e2e2e2e2-0000-4000-8000-000000000002";
const MOTH = "6a6a6a6a-6a6a-46a6-86a6-6a6a6a6a6a6a";
const MOTH_OWNER = "e2e2e2e2-0000-4000-8000-000000000003";
const MOTH_EDITOR = "e2e2e2e2-0000-4000-8000-000000000004";
const MOTH_VIEWER = "e2e2e2e2-0000-4000-8000-000000000005";
const ORG_EDITOR = "e2e2e2e2-0000-4000-8000-000000000006";
const BASE = "https://ithasfire.test";

const MEMBERS: Record<string, Array<{ humanId: string; role: string }>> = {
  [MOTH]: [
    { humanId: MOTH_OWNER, role: "OWNER" },
    { humanId: MOTH_EDITOR, role: "EDITOR" },
    { humanId: MOTH_VIEWER, role: "VIEWER" },
  ],
  [ORG_ID]: [
    { humanId: ORG_EDITOR, role: "ADMIN" },
    { humanId: MOTH_EDITOR, role: "EDITOR" },
  ],
};

function act(over: Partial<BookingRequestActRecord>): BookingRequestActRecord {
  return {
    id: crypto.randomUUID(),
    bookingRequestId: REQUEST_ID,
    source: "TAGGED",
    actOwnerType: "human",
    actOwnerId: DELLA,
    externalName: null,
    externalUrl: null,
    role: "PERFORMER",
    customRoleLabel: null,
    sortOrder: 1,
    confirmation: "CONFIRMED",
    invitedAt: NOW,
    respondedAt: NOW,
    declineReason: null,
    removedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function harness(options: { failFor?: string; bill?: BookingRequestActRecord[] } = {}) {
  const notify = vi.fn(async (input: { humanId: string }) => {
    if (input.humanId === options.failFor) throw new Error("send failed");
    return { ok: true };
  });
  const reportError = vi.fn();
  const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const repos = {
    humans: {
      getByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: "Sam Sender" }))),
      getByIdWithIdentity: vi.fn(async () => ({ identity: { username: "sam" } })),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({
        id,
        slug: id === ORG_ID ? "corner-collective" : "paper-moth",
        name: id === MOTH ? "Paper Moth" : "Corner Collective",
      })),
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: id === MOTH ? "Paper Moth" : "Corner Collective" })),
      ),
      listMembers: vi.fn(async ({ orgId }: { orgId: string }) => {
        const items = MEMBERS[orgId] ?? [];
        return { items, total: items.length };
      }),
    },
    entityPages: { getByOwner: vi.fn(async () => null) },
    bookingRequests: {
      listActsForRequests: vi.fn(async () => options.bill ?? []),
    },
  };
  return { notify, reportError, logger, repos };
}

const sends = (notify: ReturnType<typeof vi.fn>) =>
  notify.mock.calls.map(([input]) => input as Record<string, unknown> & { humanId: string });

// ─────────────────────────────────────────────────────────────────────────────

describe("notifyBookingLineupAnswered (FR-012a)", () => {
  const request = buildBookingRequestRecord({ placeName: "The Corner Stage" });

  it("a human sender hears it IN-APP ONLY, linked to their own bookings; keyed per answer", async () => {
    const h = harness();
    const della = act({});
    await notifyBookingLineupAnswered(
      { ...h, publicAppUrl: BASE } as unknown as NotifyBookingLineupAnsweredDeps,
      { bookingRequest: request, act: della, actName: "Della", answer: "joined", actorHumanId: DELLA },
    );
    expect(sends(h.notify)).toEqual([
      {
        humanId: ACTOR_ID,
        variant: "booking.lineup-answered",
        idempotencyKey: bookingLineupAnsweredIdempotencyKey({
          bookingRequestId: REQUEST_ID,
          actId: della.id,
          humanId: ACTOR_ID,
          answer: "joined",
          respondedAt: NOW,
        }),
        payload: {
          bookingRequestId: REQUEST_ID,
          actId: della.id,
          humanId: ACTOR_ID,
          actName: "Della",
          venueName: "The Corner Stage",
          answer: "joined",
          targetUrl: `${BASE}/admin/@sam/bookings`,
        },
        channels: {
          email: { enabled: false },
          push: { enabled: false },
          sms: { enabled: false },
        },
      },
    ]);
    // The payload renders, and only in-app.
    const rendered = renderNotification("booking.lineup-answered", sends(h.notify)[0]!.payload, { now: NOW });
    expect(rendered.category).toBe("transactional");
    expect(rendered.inApp?.title).toBe("Della joined your bill at The Corner Stage");
    expect(rendered.email).toBeUndefined();
    expect(rendered.push).toBeUndefined();
  });

  it("an org sender's EDITORS hear it — minus the human who answered", async () => {
    const h = harness();
    await notifyBookingLineupAnswered(
      { ...h, publicAppUrl: BASE } as unknown as NotifyBookingLineupAnsweredDeps,
      {
        bookingRequest: buildBookingRequestRecord({
          performerOwnerType: "organization",
          performerOwnerId: ORG_ID,
        }),
        act: act({ actOwnerType: "organization", actOwnerId: MOTH }),
        actName: "Paper Moth",
        answer: "passed",
        // An editor of BOTH the sending org and the tagged group answered.
        actorHumanId: MOTH_EDITOR,
      },
    );
    expect(sends(h.notify).map((s) => s.humanId)).toEqual([ORG_EDITOR]);
    expect(sends(h.notify)[0]!.payload).toMatchObject({
      targetUrl: `${BASE}/admin/corner-collective/bookings`,
      answer: "passed",
    });
  });

  it("an unclaimed anonymous inquiry has nobody to tell", async () => {
    const h = harness();
    await notifyBookingLineupAnswered(
      { ...h, publicAppUrl: BASE } as unknown as NotifyBookingLineupAnsweredDeps,
      {
        bookingRequest: buildBookingRequestRecord({
          performerOwnerType: null,
          performerOwnerId: null,
          contactEmail: "anon@example.com",
          contactName: "Anon",
        }),
        act: act({}),
        actName: "Della",
        answer: "joined",
        actorHumanId: DELLA,
      },
    );
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a failed send is logged AND reported; a throwing reporter changes nothing", async () => {
    const h = harness({ failFor: ACTOR_ID });
    h.reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });
    await expect(
      notifyBookingLineupAnswered(
        { ...h, publicAppUrl: BASE } as unknown as NotifyBookingLineupAnsweredDeps,
        { bookingRequest: request, act: act({}), actName: "Della", answer: "joined", actorHumanId: DELLA },
      ),
    ).resolves.toBeUndefined();
    expect(h.logger.error).toHaveBeenCalledWith(
      "booking_requests.notify_lineup_answered.recipient_failed",
      expect.objectContaining({ humanId: ACTOR_ID }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { useCase: "notifyBookingLineupAnswered" } }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("notifyBookingLineupRequestClosed (FR-012b / L7)", () => {
  const request = buildBookingRequestRecord({
    status: "DECLINED",
    declineReason: "We are fully booked that month",
    placeName: "The Corner Stage",
    preferredDates: ["2026-08-14T20:00"],
  });

  it("JOINED acts only — never invited, passed, by-name or the sender — and never the venue's reason", async () => {
    const joinedPerson = act({ actOwnerId: DELLA });
    const joinedGroup = act({ actOwnerType: "organization", actOwnerId: MOTH });
    const h = harness({
      bill: [
        act({ source: "SELF", actOwnerId: ACTOR_ID }),
        joinedPerson,
        act({ actOwnerId: MAREN, confirmation: "PENDING" }),
        act({ actOwnerId: "e2e2e2e2-0000-4000-8000-000000000009", confirmation: "DECLINED" }),
        act({ source: "EXTERNAL", actOwnerType: null, actOwnerId: null, externalName: "Junco" }),
        joinedGroup,
      ],
    });

    await notifyBookingLineupRequestClosed(
      { ...h, publicAppUrl: BASE } as unknown as NotifyBookingLineupRequestClosedDeps,
      { bookingRequest: request, closedBy: "declined", actorHumanId: null },
    );

    expect(sends(h.notify).map((s) => [s.humanId, s.idempotencyKey])).toEqual([
      [DELLA, bookingLineupRequestClosedIdempotencyKey({ bookingRequestId: REQUEST_ID, actId: joinedPerson.id, humanId: DELLA })],
      [MOTH_OWNER, bookingLineupRequestClosedIdempotencyKey({ bookingRequestId: REQUEST_ID, actId: joinedGroup.id, humanId: MOTH_OWNER })],
      [MOTH_EDITOR, bookingLineupRequestClosedIdempotencyKey({ bookingRequestId: REQUEST_ID, actId: joinedGroup.id, humanId: MOTH_EDITOR })],
    ]);
    expect(sends(h.notify)[0]).toMatchObject({
      variant: "booking.lineup-request-closed",
      channels: { sms: { enabled: false }, push: { enabled: false } },
      payload: { targetUrl: `${BASE}/bookings/acts/${REQUEST_ID}`, senderName: "Sam Sender" },
    });
    expect(sends(h.notify)[1]!.payload).toMatchObject({ asGroupName: "Paper Moth" });
    // L7: the decline reason never reaches an act — not in any payload, and
    // not in what the payload renders to.
    for (const send of sends(h.notify)) {
      expect(JSON.stringify(send)).not.toContain("fully booked");
      const rendered = renderNotification("booking.lineup-request-closed", send.payload, { now: NOW });
      expect(rendered.category).toBe("billsYoureOn");
      expect(JSON.stringify(rendered)).not.toContain("fully booked");
      expect(rendered.email?.template?.key).toBe("booking.lineup_request_closed");
    }
  });

  it("skips the acting human in a group's fan-out (the sender withdrawing as a Moth editor)", async () => {
    const h = harness({ bill: [act({ actOwnerType: "organization", actOwnerId: MOTH })] });
    await notifyBookingLineupRequestClosed(
      { ...h, publicAppUrl: BASE } as unknown as NotifyBookingLineupRequestClosedDeps,
      { bookingRequest: request, closedBy: "withdrawn", actorHumanId: MOTH_OWNER },
    );
    expect(sends(h.notify).map((s) => s.humanId)).toEqual([MOTH_EDITOR]);
  });

  it("nobody joined → no send (and no base URL needed)", async () => {
    const h = harness({ bill: [act({ confirmation: "PENDING" })] });
    await notifyBookingLineupRequestClosed(
      { ...h } as unknown as NotifyBookingLineupRequestClosedDeps,
      { bookingRequest: request, closedBy: "expired", actorHumanId: null },
    );
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("one failed recipient is reported and the rest still go out", async () => {
    const h = harness({
      failFor: DELLA,
      bill: [act({ actOwnerId: DELLA }), act({ actOwnerId: MAREN })],
    });
    await notifyBookingLineupRequestClosed(
      { ...h, publicAppUrl: BASE } as unknown as NotifyBookingLineupRequestClosedDeps,
      { bookingRequest: request, closedBy: "declined", actorHumanId: null },
    );
    expect(sends(h.notify).map((s) => s.humanId)).toEqual([DELLA, MAREN]);
    expect(h.logger.error).toHaveBeenCalledWith(
      "booking_requests.notify_lineup_request_closed.recipient_failed",
      expect.objectContaining({ humanId: DELLA, closedBy: "declined" }),
    );
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("notifyBookingLineupRemoved (FR-012c)", () => {
  const request = buildBookingRequestRecord({ placeName: "The Corner Stage" });

  it("a removed JOINED act hears it once, in-app + email, keyed by the removal", async () => {
    const h = harness();
    const removed = act({ removedAt: NOW });
    await notifyBookingLineupRemoved(h as unknown as NotifyBookingLineupRemovedDeps, {
      bookingRequest: request,
      acts: [removed, act({ actOwnerId: MAREN, confirmation: "PENDING", removedAt: NOW })],
      actorHumanId: ACTOR_ID,
    });
    expect(sends(h.notify)).toEqual([
      expect.objectContaining({
        humanId: DELLA,
        variant: "booking.lineup-removed",
        idempotencyKey: bookingLineupRemovedIdempotencyKey({
          bookingRequestId: REQUEST_ID,
          actId: removed.id,
          humanId: DELLA,
          removedAt: NOW,
        }),
        channels: { sms: { enabled: false }, push: { enabled: false } },
      }),
    ]);
    const rendered = renderNotification("booking.lineup-removed", sends(h.notify)[0]!.payload, { now: NOW });
    expect(rendered.category).toBe("billsYoureOn");
    expect(rendered.inApp?.title).toBe("Sam Sender took you off the bill at The Corner Stage");
    expect(rendered.email?.template?.key).toBe("booking.lineup_removed");
  });

  it("a removed group is heard by its editors minus the actor", async () => {
    const h = harness();
    await notifyBookingLineupRemoved(h as unknown as NotifyBookingLineupRemovedDeps, {
      bookingRequest: request,
      acts: [act({ actOwnerType: "organization", actOwnerId: MOTH, removedAt: NOW })],
      actorHumanId: MOTH_EDITOR,
    });
    expect(sends(h.notify).map((s) => s.humanId)).toEqual([MOTH_OWNER]);
    expect(sends(h.notify)[0]!.payload).toMatchObject({ asGroupName: "Paper Moth" });
  });

  it("a failed recipient read is logged AND reported", async () => {
    const h = harness();
    h.repos.organizations.listMembers.mockRejectedValueOnce(new Error("members down"));
    await notifyBookingLineupRemoved(h as unknown as NotifyBookingLineupRemovedDeps, {
      bookingRequest: request,
      acts: [act({ actOwnerType: "organization", actOwnerId: MOTH, removedAt: NOW })],
    });
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { useCase: "notifyBookingLineupRemoved", step: "recipients" } }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("notifyBookingLineupInvited — v3 additions", () => {
  const place = { id: PLACE_ID, name: "The Corner Stage" };
  const request = buildBookingRequestRecord();

  it("a group editor's invite says which group (asGroupName); the tagging actor is skipped in the fan-out", async () => {
    const h = harness();
    await notifyBookingLineupInvited(
      { ...h, publicAppUrl: BASE } as unknown as NotifyBookingLineupInvitedDeps,
      { bookingRequest: request, place, taggedHumanIds: [], taggedOrgIds: [MOTH], actorHumanId: MOTH_OWNER },
    );
    expect(sends(h.notify).map((s) => s.humanId)).toEqual([MOTH_EDITOR]);
    expect(sends(h.notify)[0]!.payload).toMatchObject({ asGroupName: "Paper Moth" });
  });

  it("a re-invite carries its generation in the key; a first invite keeps the v2 key", async () => {
    const h = harness();
    const generation = NOW.getTime() + 5000;
    await notifyBookingLineupInvited(
      { ...h, publicAppUrl: BASE } as unknown as NotifyBookingLineupInvitedDeps,
      {
        bookingRequest: request,
        place,
        taggedHumanIds: [DELLA, MAREN],
        inviteGenerations: { [`human:${DELLA}`]: generation },
      },
    );
    expect(sends(h.notify).map((s) => s.idempotencyKey)).toEqual([
      `booking-lineup-invited:${REQUEST_ID}:${DELLA}:g${generation}`,
      bookingLineupInvitedIdempotencyKey(REQUEST_ID, MAREN),
    ]);
    expect(bookingLineupInvitedIdempotencyKey(REQUEST_ID, MAREN)).toBe(
      `booking-lineup-invited:${REQUEST_ID}:${MAREN}`,
    );
  });

  it("a failed group-name read degrades to no group line, reported", async () => {
    const h = harness();
    h.repos.organizations.getByIds.mockRejectedValueOnce(new Error("orgs down"));
    await notifyBookingLineupInvited(
      { ...h, publicAppUrl: BASE } as unknown as NotifyBookingLineupInvitedDeps,
      { bookingRequest: request, place, taggedHumanIds: [], taggedOrgIds: [MOTH] },
    );
    expect(sends(h.notify)).toHaveLength(2);
    expect(sends(h.notify)[0]!.payload).not.toHaveProperty("asGroupName");
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { useCase: "notifyBookingLineupInvited", step: "group_names" } }),
    );
  });
});
