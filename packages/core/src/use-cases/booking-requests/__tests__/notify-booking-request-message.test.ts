import { describe, expect, it, vi } from "vitest";

import type { OrgMemberRecord } from "@th/types/repos/organizations";
import type { BookingRequestMessageRow } from "@th/types/repos/booking-request-messages";

import {
  notifyBookingRequestMessage,
  BOOKING_MESSAGE_RECEIVED_VARIANT,
  type NotifyBookingRequestMessageDeps,
} from "../notify-booking-request-message";
import { renderNotification } from "../../comms/renderers";
import {
  ACTOR_ID,
  ORG_ID,
  ORGANIZER_ORG_ID,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
  buildPlaceRecord,
} from "./helpers";

const OWNER_ID = "13131313-1313-4131-8131-131313131313";
const MEMBER_ADMIN_ID = "99999999-9999-4999-8999-999999999991";
const MEMBER_VIEWER_ID = "99999999-9999-4999-8999-999999999993";
const MESSAGE_ID = "5e55a6e5-1111-4111-8111-111111111111";
const PUBLIC_APP_URL = "https://ithasfire.test";

function member(
  humanId: string,
  role: OrgMemberRecord["role"],
): OrgMemberRecord {
  return {
    humanId,
    name: null,
    email: null,
    role,
    joinedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function buildMessage(
  overrides: Partial<BookingRequestMessageRow> = {},
): BookingRequestMessageRow {
  return {
    id: MESSAGE_ID,
    bookingRequestId: REQUEST_ID,
    authorSide: "VENUE",
    authorHumanId: OWNER_ID,
    body: "Does the 10th work?",
    readAt: null,
    createdAt: new Date("2026-06-10T12:00:00.000Z"),
    ...overrides,
  };
}

type BuildOptions = {
  membersByOrg?: Record<string, OrgMemberRecord[]>;
  place?: ReturnType<typeof buildPlaceRecord> | null;
  notifyImpl?: (input: unknown) => Promise<unknown>;
  publicAppUrl?: string | null;
};

function buildDeps(options: BuildOptions = {}) {
  const notify =
    options.notifyImpl !== undefined
      ? vi.fn(options.notifyImpl)
      : vi.fn(async () => ({ ok: true }));
  const reportError = vi.fn();
  const place =
    options.place === undefined
      ? buildPlaceRecord({ humanIdsWithAccess: [OWNER_ID] })
      : options.place;

  const repos = {
    humans: {
      getByIdWithIdentity: vi.fn(async (id: string) => ({
        human: { id, name: "Someone" },
        identity: { username: "someuser" },
      })),
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: "Performer Human" })),
      ),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({
        id,
        name: "Some Org",
        slug: "some-org",
      })),
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: "Performer Org", slug: "performer-org" })),
      ),
      listMembers: vi.fn(async ({ orgId }: { orgId: string }) => {
        const members = options.membersByOrg?.[orgId] ?? [];
        return { items: members, total: members.length };
      }),
    },
    entityPages: {
      getByOwner: vi.fn(async () => null),
    },
    places: {
      getById: vi.fn(async (id: string) =>
        place && id === place.id ? place : null,
      ),
    },
  } as unknown as NotifyBookingRequestMessageDeps["repos"];

  const deps: NotifyBookingRequestMessageDeps = {
    repos,
    notify,
    reportError,
    publicAppUrl:
      options.publicAppUrl === undefined ? PUBLIC_APP_URL : options.publicAppUrl,
  };

  return { deps, notify, reportError };
}

describe("notifyBookingRequestMessage", () => {
  it("VENUE recipient (TO_VENUE): notifies the direct human owner with a per-message idempotency key and a renderable payload", async () => {
    const { deps, notify } = buildDeps();
    const request = buildBookingRequestRecord({ actName: "The Fake Band" });
    const message = buildMessage({ authorSide: "PERFORMER" });

    await notifyBookingRequestMessage(deps, {
      bookingRequest: request,
      message,
      recipientSide: "VENUE",
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const call = notify.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.humanId).toBe(OWNER_ID);
    expect(call.variant).toBe(BOOKING_MESSAGE_RECEIVED_VARIANT);
    expect(call.idempotencyKey).toBe(
      `booking-message:${MESSAGE_ID}:${OWNER_ID}`,
    );
    const payload = call.payload as Record<string, unknown>;
    // Performer-authored → sender label is the act.
    expect(payload.senderLabel).toBe("The Fake Band");
    expect(payload.threadUrl).toContain(`/places/${PLACE_ID}/bookings`);

    // The payload must actually render — pins the schema and the renderer
    // registration together.
    const rendered = renderNotification(
      BOOKING_MESSAGE_RECEIVED_VARIANT,
      payload,
      { now: new Date() },
    );
    expect(rendered.inApp?.title).toContain("The Fake Band");
    expect(rendered.email?.subject).toContain("The Fake Band");
  });

  it("VENUE recipients via owning org: edit roles only", async () => {
    const { deps, notify } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      }),
      membersByOrg: {
        [ORG_ID]: [
          member(MEMBER_ADMIN_ID, "ADMIN"),
          member(MEMBER_VIEWER_ID, "VIEWER"),
        ],
      },
    });

    await notifyBookingRequestMessage(deps, {
      bookingRequest: buildBookingRequestRecord(),
      message: buildMessage({ authorSide: "PERFORMER" }),
      recipientSide: "VENUE",
    });

    const notified = notify.mock.calls.map(
      (c) => (c[0] as { humanId: string }).humanId,
    );
    expect(notified).toEqual([MEMBER_ADMIN_ID]);
  });

  it("PERFORMER recipient (owned human): account settings link; venue-authored label is the venue name", async () => {
    const { deps, notify } = buildDeps();

    await notifyBookingRequestMessage(deps, {
      bookingRequest: buildBookingRequestRecord(),
      message: buildMessage({ authorSide: "VENUE" }),
      recipientSide: "PERFORMER",
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const call = notify.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.humanId).toBe(ACTOR_ID);
    const payload = call.payload as Record<string, unknown>;
    expect(payload.senderLabel).toBe("Test Venue");
    expect(payload.threadUrl).toBe(
      `${PUBLIC_APP_URL}/account/settings/booking-requests`,
    );
  });

  it("TO_PERFORMER direction, VENUE recipient = the organizer org's edit members", async () => {
    const { deps, notify } = buildDeps({
      membersByOrg: {
        [ORGANIZER_ORG_ID]: [member(MEMBER_ADMIN_ID, "OWNER")],
      },
    });

    await notifyBookingRequestMessage(deps, {
      bookingRequest: buildOrganizerBookingRequestRecord(),
      message: buildMessage({ authorSide: "PERFORMER" }),
      recipientSide: "VENUE",
    });

    const call = notify.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.humanId).toBe(MEMBER_ADMIN_ID);
    expect((call.payload as Record<string, unknown>).threadUrl).toContain(
      "/admin/some-org/bookings",
    );
  });

  it("ANONYMOUS performer recipient: silently skipped, never reported (expected state)", async () => {
    const { deps, notify, reportError } = buildDeps();

    await notifyBookingRequestMessage(deps, {
      bookingRequest: buildBookingRequestRecord({
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: "Jane",
        contactEmail: "jane@example.com",
        source: "EMBED",
      }),
      message: buildMessage({ authorSide: "VENUE" }),
      recipientSide: "PERFORMER",
    });

    expect(notify).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("zero VENUE recipients is REPORTED (the thread is shouting into the void)", async () => {
    const { deps, notify, reportError } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [],
      }),
    });

    await notifyBookingRequestMessage(deps, {
      bookingRequest: buildBookingRequestRecord(),
      message: buildMessage({ authorSide: "PERFORMER" }),
      recipientSide: "VENUE",
    });

    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "notifyBookingRequestMessage" },
      }),
    );
  });

  it("one failing recipient does not sink the others and is reported", async () => {
    let calls = 0;
    const { deps, notify, reportError } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [OWNER_ID, MEMBER_ADMIN_ID],
      }),
      notifyImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error("first recipient down");
        return { ok: true };
      },
    });

    await notifyBookingRequestMessage(deps, {
      bookingRequest: buildBookingRequestRecord(),
      message: buildMessage({ authorSide: "PERFORMER" }),
      recipientSide: "VENUE",
    });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("missing publicAppUrl throws (the caller's swallow reports it)", async () => {
    const { deps } = buildDeps({ publicAppUrl: null });
    await expect(
      notifyBookingRequestMessage(deps, {
        bookingRequest: buildBookingRequestRecord(),
        message: buildMessage(),
        recipientSide: "VENUE",
      }),
    ).rejects.toThrow(/publicAppUrl/);
  });

  it("clips long bodies into the preview so the renderer's cap holds", async () => {
    const { deps, notify } = buildDeps();
    await notifyBookingRequestMessage(deps, {
      bookingRequest: buildBookingRequestRecord(),
      message: buildMessage({ authorSide: "VENUE", body: "y".repeat(4000) }),
      recipientSide: "PERFORMER",
    });
    const payload = (notify.mock.calls[0]![0] as { payload: { preview: string } })
      .payload;
    expect(payload.preview.length).toBeLessThanOrEqual(300);
    // Still renderable (schema max 500).
    expect(() =>
      renderNotification(BOOKING_MESSAGE_RECEIVED_VARIANT, {
        ...(notify.mock.calls[0]![0] as { payload: Record<string, unknown> })
          .payload,
      }, { now: new Date() }),
    ).not.toThrow();
  });
});
