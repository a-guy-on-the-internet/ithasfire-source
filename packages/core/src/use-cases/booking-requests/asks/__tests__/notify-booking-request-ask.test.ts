import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { OrgMemberRecord } from "@th/types/repos/organizations";

import { renderNotification } from "../../../comms/renderers";
import { buildBookingRequestRecord, NOW } from "../../__tests__/helpers";
import {
  BOOKING_ASK_ANSWERED_VARIANT,
  BOOKING_ASK_RECEIVED_VARIANT,
  fireAskNotice,
  notifyBookingRequestAsk,
  type NotifyBookingRequestAskArgs,
  type NotifyBookingRequestAskDeps,
} from "../notify-booking-request-ask";
import { buildAsk } from "./ask-fakes";

// ── P3b (asks) ── FR-009b notices: the ask reaches every person on the SENDER
// side (in-app + email); the answer reaches every person on the VENUE side
// (in-app). Never the actor. Keys are per (ask, recipient) — and per answer
// revision for answers, so a replaced answer is a new notice.

const PUBLIC_APP_URL = "https://ithasfire.test";
const ACT_HUMAN_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const VENUE_OWNER_ID = "13131313-1313-4131-8131-131313131313";
const VENUE_ORG_ID = "22222222-2222-4222-8222-222222222299";
const VENUE_ADMIN_ID = "99999999-9999-4999-8999-999999999991";

function member(humanId: string, role: OrgMemberRecord["role"]): OrgMemberRecord {
  return { humanId, name: null, email: null, role, joinedAt: NOW };
}

function buildDeps() {
  const notify = vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: true }));
  const repos = {
    places: {
      getById: vi.fn(async (id: string) => ({
        id,
        humanIdsWithAccess: [VENUE_OWNER_ID],
        orgIdsWithAccess: [VENUE_ORG_ID],
      })),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({ id, name: "Corner Stage LLC", slug: "corner-stage" })),
      getByIds: vi.fn(async () => []),
      listMembers: vi.fn(async ({ offset }: { offset: number }) => ({
        items: offset === 0 ? [member(VENUE_ADMIN_ID, "ADMIN")] : [],
        total: 1,
      })),
    },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, name: "Alice Act" })),
      getByIdWithIdentity: vi.fn(async () => ({ identity: { username: "venue-owner" } })),
    },
    entityPages: { getByOwner: vi.fn(async () => null) },
    performerBookingDefaults: { getByOwner: vi.fn(async () => ({ actName: "The Midnight Ramblers" })) },
  };
  const reportError = vi.fn();
  const logger = createTestLogger();
  vi.mocked(logger.child).mockReturnValue(logger);
  const deps: NotifyBookingRequestAskDeps = {
    repos: repos as unknown as NotifyBookingRequestAskDeps["repos"],
    notify: notify as unknown as NotifyBookingRequestAskDeps["notify"],
    logger,
    reportError,
    publicAppUrl: PUBLIC_APP_URL,
  };
  return { deps, notify, reportError };
}

const request = buildBookingRequestRecord({
  performerOwnerType: "human",
  performerOwnerId: ACT_HUMAN_ID,
  placeName: "The Corner Stage",
  actName: null,
});

const args = (over: Partial<NotifyBookingRequestAskArgs> = {}): NotifyBookingRequestAskArgs => ({
  event: "asked",
  bookingRequest: request,
  ask: buildAsk({ kind: "IMAGE", label: "Poster", note: "Portrait" }),
  actorHumanId: VENUE_ADMIN_ID,
  ...over,
});

describe("notifyBookingRequestAsk", () => {
  it("asked → the sender, booking.ask-received, a payload the renderer accepts", async () => {
    const { deps, notify } = buildDeps();
    await notifyBookingRequestAsk(deps, args());
    expect(notify).toHaveBeenCalledTimes(1);
    const call = notify.mock.calls[0]![0] as {
      humanId: string;
      variant: string;
      idempotencyKey: string;
      payload: unknown;
    };
    expect(call.humanId).toBe(ACT_HUMAN_ID);
    expect(call.variant).toBe(BOOKING_ASK_RECEIVED_VARIANT);
    expect(call.idempotencyKey).toBe(`booking-ask-received:${args().ask.id}:${ACT_HUMAN_ID}`);
    const rendered = renderNotification(call.variant, call.payload, { now: NOW });
    expect(rendered.inApp?.title).toBe("The Corner Stage asked you for: Poster");
    expect(rendered.email).toBeDefined();
  });

  it("answered → every venue-side person but the actor, booking.ask-answered, keyed per revision", async () => {
    const { deps, notify } = buildDeps();
    const ask = buildAsk({ status: "ANSWERED", answerUrl: "https://v.test", answerRevision: 2 });
    await notifyBookingRequestAsk(
      deps,
      args({ event: "answered", ask, actorHumanId: ACT_HUMAN_ID }),
    );
    const calls = notify.mock.calls.map((c) => c[0] as { humanId: string; variant: string; idempotencyKey: string; payload: unknown });
    expect(calls.map((c) => c.humanId).sort()).toEqual([VENUE_ADMIN_ID, VENUE_OWNER_ID].sort());
    for (const c of calls) {
      expect(c.variant).toBe(BOOKING_ASK_ANSWERED_VARIANT);
      expect(c.idempotencyKey).toBe(`booking-ask-answered:${ask.id}:2:${c.humanId}`);
      expect(renderNotification(c.variant, c.payload, { now: NOW }).inApp?.title).toBe(
        "The Midnight Ramblers answered: Live video",
      );
    }
  });

  it("never notifies the actor; one recipient's failure is isolated and reported", async () => {
    const { deps, notify, reportError } = buildDeps();
    notify.mockRejectedValueOnce(new Error("push down"));
    await notifyBookingRequestAsk(
      deps,
      args({ event: "answered", ask: buildAsk({ status: "ANSWERED" }), actorHumanId: VENUE_ADMIN_ID }),
    );
    const humans = notify.mock.calls.map((c) => (c[0] as { humanId: string }).humanId);
    expect(humans).not.toContain(VENUE_ADMIN_ID);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("fireAskNotice swallows a throwing notifier and reports it (a throwing reporter changes nothing)", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(
      fireAskNotice(
        {
          notifyBookingRequestAsk: async () => {
            throw new Error("boom");
          },
          reportError,
        },
        args(),
        "askOnBookingRequest",
      ),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalled();
  });
});
