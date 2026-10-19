import { describe, expect, it, vi } from "vitest";

import {
  bookingLineupInvitedIdempotencyKey,
  notifyBookingLineupInvited,
  type NotifyBookingLineupInvitedDeps,
} from "../notify-booking-lineup-invited";
import { ACTOR_ID, PLACE_ID, REQUEST_ID, buildBookingRequestRecord } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// "You're on a bill" for a tagged GROUP (lineup-booking-requests v3, L17):
// the invite reaches every member holding an org edit role — the people who
// may answer for the group — once per (request, group, member).
// ─────────────────────────────────────────────────────────────────────────────

const GROUP_A = "6a6a6a6a-6a6a-46a6-86a6-6a6a6a6a6a6a";
const GROUP_B = "6b6b6b6b-6b6b-46b6-86b6-6b6b6b6b6b6b";
const TAGGED_HUMAN = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const OWNER = "c1c1c1c1-0000-4000-8000-000000000001";
const EDITOR = "c1c1c1c1-0000-4000-8000-000000000002";
const VIEWER = "c1c1c1c1-0000-4000-8000-000000000003";
const FINANCE = "c1c1c1c1-0000-4000-8000-000000000004";
const place = { id: PLACE_ID, name: "The Corner Stage" };

function buildDeps(
  options: {
    membersFail?: string;
  } = {},
) {
  type Sent = { humanId: string; idempotencyKey: string };
  const notify = vi.fn(async (_input: Sent) => ({ ok: true }));
  const reportError = vi.fn();
  type TestLogger = {
    child: () => TestLogger;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  const logger: TestLogger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const members: Record<string, Array<{ humanId: string; role: string }>> = {
    [GROUP_A]: [
      { humanId: OWNER, role: "OWNER" },
      { humanId: EDITOR, role: "EDITOR" },
      { humanId: VIEWER, role: "VIEWER" },
      { humanId: FINANCE, role: "FINANCE" },
    ],
    // The tagged human is ALSO an admin of group B.
    [GROUP_B]: [{ humanId: TAGGED_HUMAN, role: "ADMIN" }],
  };
  const repos = {
    humans: {
      getByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: "Sam Promoter" }))),
    },
    organizations: {
      getByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: "Org" }))),
      listMembers: vi.fn(async ({ orgId }: { orgId: string }) => {
        if (options.membersFail === orgId) throw new Error("members read down");
        const items = members[orgId] ?? [];
        return { items, total: items.length };
      }),
    },
  };
  const deps = {
    repos,
    notify,
    logger,
    reportError,
    publicAppUrl: "https://ithasfire.test",
  } as unknown as NotifyBookingLineupInvitedDeps;
  return { deps, notify, reportError, logger };
}

const bookingRequest = buildBookingRequestRecord({ performerOwnerId: ACTOR_ID });

describe("notifyBookingLineupInvited — tagged groups (v3 L17)", () => {
  it("a tagged group's invite goes to its EDIT-role members only, keyed per (request, group, member)", async () => {
    const { deps, notify } = buildDeps();

    await notifyBookingLineupInvited(deps, {
      bookingRequest,
      place,
      taggedHumanIds: [],
      taggedOrgIds: [GROUP_A],
    });

    const sends = notify.mock.calls.map(([input]) => input);
    // OWNER and EDITOR answer for the group; VIEWER and FINANCE do not.
    expect(sends.map((send) => send.humanId)).toEqual([OWNER, EDITOR]);
    expect(sends.map((send) => send.idempotencyKey)).toEqual([
      `booking-lineup-invited:${REQUEST_ID}:org:${GROUP_A}:${OWNER}`,
      `booking-lineup-invited:${REQUEST_ID}:org:${GROUP_A}:${EDITOR}`,
    ]);
    expect(sends[0]).toMatchObject({
      variant: "booking.lineup-invited",
      channels: { sms: { enabled: false } },
      payload: expect.objectContaining({
        targetUrl: `https://ithasfire.test/bookings/acts/${REQUEST_ID}`,
      }),
    });
  });

  it("a person tagged directly AND editing a tagged group gets one invite per act — two distinct keys; a person's key keeps its v2 shape", async () => {
    const { deps, notify } = buildDeps();

    await notifyBookingLineupInvited(deps, {
      bookingRequest,
      place,
      taggedHumanIds: [TAGGED_HUMAN],
      taggedOrgIds: [GROUP_B],
    });

    expect(notify.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      // As themselves: the v2 key, unchanged (a re-send must not double-invite).
      `booking-lineup-invited:${REQUEST_ID}:${TAGGED_HUMAN}`,
      // As an editor of group B: its own key.
      `booking-lineup-invited:${REQUEST_ID}:org:${GROUP_B}:${TAGGED_HUMAN}`,
    ]);
    expect(bookingLineupInvitedIdempotencyKey(REQUEST_ID, TAGGED_HUMAN, GROUP_B)).toBe(
      `booking-lineup-invited:${REQUEST_ID}:org:${GROUP_B}:${TAGGED_HUMAN}`,
    );
  });

  it("a failed member read loses only THAT group's invites: logged at error, REPORTED, the rest still sent", async () => {
    const { deps, notify, reportError, logger } = buildDeps({ membersFail: GROUP_A });

    await expect(
      notifyBookingLineupInvited(deps, {
        bookingRequest,
        place,
        taggedHumanIds: [TAGGED_HUMAN],
        taggedOrgIds: [GROUP_A, GROUP_B],
      }),
    ).resolves.toBeUndefined();

    expect(notify.mock.calls.map(([input]) => input.humanId)).toEqual([
      TAGGED_HUMAN,
      TAGGED_HUMAN,
    ]);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "notifyBookingLineupInvited", step: "group_members" },
      extra: { bookingRequestId: REQUEST_ID, placeId: PLACE_ID, orgId: GROUP_A },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.notify_lineup_invited.group_members_failed",
      expect.objectContaining({ orgId: GROUP_A }),
    );
  });

  it("a throwing reporter never escapes the group-members swallow", async () => {
    const { deps, notify } = buildDeps({ membersFail: GROUP_A });
    (deps as { reportError: unknown }).reportError = () => {
      throw new Error("sentry down");
    };

    await expect(
      notifyBookingLineupInvited(deps, {
        bookingRequest,
        place,
        taggedHumanIds: [],
        taggedOrgIds: [GROUP_A, GROUP_B],
      }),
    ).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
