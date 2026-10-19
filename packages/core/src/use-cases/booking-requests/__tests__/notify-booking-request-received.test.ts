import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { OrgMemberRecord } from "@th/types/repos/organizations";

import {
  notifyBookingRequestReceived,
  BOOKING_REQUEST_RECEIVED_VARIANT,
  type NotifyBookingRequestReceivedDeps,
} from "../notify-booking-request-received";
import { renderNotification } from "../../comms/renderers";
import {
  ACTOR_ID,
  ORG_ID,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
} from "./helpers";

const OWNER_ID = ACTOR_ID;
const MEMBER_ADMIN_ID = "99999999-9999-4999-8999-999999999991";
const MEMBER_EDITOR_ID = "99999999-9999-4999-8999-999999999992";
const MEMBER_VIEWER_ID = "99999999-9999-4999-8999-999999999993";
const SECOND_ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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

type BuildDepsOptions = {
  /** identity.username for getByIdWithIdentity; null → no username. */
  username?: string | null;
  /** entity page slug fallback; null → no page. */
  pageSlug?: string | null;
  /** members per orgId (paged in one go unless memberPages given). */
  membersByOrg?: Record<string, OrgMemberRecord[]>;
  /** Explicit paged responses per orgId (overrides membersByOrg paging). */
  memberPagesByOrg?: Record<string, OrgMemberRecord[][]>;
  orgSlugById?: Record<string, string | null>;
  humanNameById?: Record<string, string | null>;
  orgNameById?: Record<string, string>;
  notifyImpl?: (input: unknown) => Promise<unknown>;
  publicAppUrl?: string | null;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const notify =
    options.notifyImpl !== undefined
      ? vi.fn(options.notifyImpl)
      : vi.fn(async () => ({ ok: true }));

  const listMembers = vi.fn(
    async ({ orgId, offset }: { orgId: string; offset: number }) => {
      const pages = options.memberPagesByOrg?.[orgId];
      if (pages) {
        const flat = pages.flat();
        // Serve pre-sliced pages by offset order.
        let served = 0;
        for (const page of pages) {
          if (served === offset) return { items: page, total: flat.length };
          served += page.length;
        }
        return { items: [], total: flat.length };
      }
      const members = options.membersByOrg?.[orgId] ?? [];
      return {
        items: offset === 0 ? members : [],
        total: members.length,
      };
    },
  );

  const repos = {
    humans: {
      getByIdWithIdentity: vi.fn(async (id: string) => ({
        human: { id, name: options.humanNameById?.[id] ?? "Venue Owner" },
        identity: {
          username: options.username === undefined ? "venueowner" : options.username,
        },
      })),
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          name:
            options.humanNameById?.[id] === undefined
              ? "Performer Human"
              : options.humanNameById[id],
        })),
      ),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({
        id,
        name: options.orgNameById?.[id] ?? "Owning Org",
        slug:
          options.orgSlugById?.[id] === undefined
            ? "owning-org"
            : options.orgSlugById[id],
      })),
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          name: options.orgNameById?.[id] ?? "Performer Org",
          slug: "performer-org",
        })),
      ),
      listMembers,
    },
    entityPages: {
      getByOwner: vi.fn(async () =>
        options.pageSlug === undefined || options.pageSlug === null
          ? null
          : { slug: options.pageSlug },
      ),
    },
  };

  const reportError = vi.fn();
  const deps: NotifyBookingRequestReceivedDeps = {
    repos: repos as unknown as NotifyBookingRequestReceivedDeps["repos"],
    notify: notify as unknown as NotifyBookingRequestReceivedDeps["notify"],
    logger: createTestLogger(),
    reportError,
    publicAppUrl:
      options.publicAppUrl === undefined ? PUBLIC_APP_URL : options.publicAppUrl,
  };

  return { deps, repos, notify, reportError };
}

const ownedRequest = buildBookingRequestRecord({ actName: "The Ramblers" });

const anonymousRequest = buildBookingRequestRecord({
  performerOwnerType: null,
  performerOwnerId: null,
  contactName: "Sam Torres",
  contactEmail: "sam@example.com",
  actName: "Basement Tapes",
  source: "EMBED",
  embedId: "00000000-0000-4000-8000-0000000000d0",
});

describe("notifyBookingRequestReceived", () => {
  // ── Recipient resolution: direct human owner ──────────────────────────────

  it("notifies the direct human owner with an @username inbox link, per-recipient key, and sms disabled", async () => {
    const { deps, notify } = buildDeps({ username: "venueowner" });
    const place = buildPlaceRecord(); // humanIdsWithAccess: [ACTOR_ID]

    await notifyBookingRequestReceived(deps, {
      bookingRequest: ownedRequest,
      place,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      humanId: OWNER_ID,
      variant: BOOKING_REQUEST_RECEIVED_VARIANT,
      idempotencyKey: `booking-request-received:${REQUEST_ID}:${OWNER_ID}`,
      payload: expect.objectContaining({
        bookingRequestId: REQUEST_ID,
        placeId: PLACE_ID,
        placeName: "Test Venue",
        actName: "The Ramblers",
        contactName: null,
        contactEmail: null,
        message: ownedRequest.message,
        preferredDates: ownedRequest.preferredDates,
        source: "PLATFORM",
        inboxUrl: `${PUBLIC_APP_URL}/admin/@venueowner/places/${PLACE_ID}/bookings`,
      }),
      channels: { sms: { enabled: false } },
    });
  });

  it("payload round-trips through the real renderer (no invalid_notification_payload for owned OR anonymous rows)", async () => {
    for (const request of [ownedRequest, anonymousRequest]) {
      const { deps, notify } = buildDeps();
      await notifyBookingRequestReceived(deps, {
        bookingRequest: request,
        place: buildPlaceRecord(),
      });
      expect(notify).toHaveBeenCalledTimes(1);
      const { variant, payload } = notify.mock.calls[0]![0] as {
        variant: string;
        payload: unknown;
      };
      const rendered = renderNotification(variant, payload, {
        now: new Date(),
      });
      expect(rendered.email?.template?.key).toBe("booking.request_received");
      expect(rendered.sms).toBeUndefined();
    }
  });

  it("falls back to the entity-page @slug, then @humanId, when the owner has no username", async () => {
    const withSlug = buildDeps({ username: null, pageSlug: "cool-owner" });
    await notifyBookingRequestReceived(withSlug.deps, {
      bookingRequest: ownedRequest,
      place: buildPlaceRecord(),
    });
    expect(withSlug.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          inboxUrl: `${PUBLIC_APP_URL}/admin/@cool-owner/places/${PLACE_ID}/bookings`,
        }),
      }),
    );

    const bare = buildDeps({ username: null, pageSlug: null });
    await notifyBookingRequestReceived(bare.deps, {
      bookingRequest: ownedRequest,
      place: buildPlaceRecord(),
    });
    expect(bare.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          inboxUrl: `${PUBLIC_APP_URL}/admin/@${OWNER_ID}/places/${PLACE_ID}/bookings`,
        }),
      }),
    );
  });

  // ── Recipient resolution: owning-org members ──────────────────────────────

  it("notifies org edit-role members only (viewer excluded) with the org-slug inbox link", async () => {
    const { deps, notify } = buildDeps({
      membersByOrg: {
        [ORG_ID]: [
          member(MEMBER_ADMIN_ID, "ADMIN"),
          member(MEMBER_EDITOR_ID, "EDITOR"),
          member(MEMBER_VIEWER_ID, "VIEWER"),
        ],
      },
      orgSlugById: { [ORG_ID]: "owning-org" },
    });
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [ORG_ID],
    });

    await notifyBookingRequestReceived(deps, {
      bookingRequest: ownedRequest,
      place,
    });

    expect(notify).toHaveBeenCalledTimes(2);
    const notified = notify.mock.calls.map(
      (call) => (call[0] as { humanId: string }).humanId,
    );
    expect(notified).toEqual([MEMBER_ADMIN_ID, MEMBER_EDITOR_ID]);
    for (const call of notify.mock.calls) {
      const input = call[0] as { payload: { inboxUrl: string } };
      expect(input.payload.inboxUrl).toBe(
        `${PUBLIC_APP_URL}/admin/owning-org/places/${PLACE_ID}/bookings`,
      );
    }
  });

  it("pages through listMembers and falls back to the orgId when the org has no slug", async () => {
    const { deps, notify, repos } = buildDeps({
      memberPagesByOrg: {
        [ORG_ID]: [
          [member(MEMBER_ADMIN_ID, "OWNER")],
          [member(MEMBER_EDITOR_ID, "EDITOR")],
        ],
      },
      orgSlugById: { [ORG_ID]: null },
    });
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [ORG_ID],
    });

    await notifyBookingRequestReceived(deps, {
      bookingRequest: ownedRequest,
      place,
    });

    expect(repos.organizations.listMembers).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          inboxUrl: `${PUBLIC_APP_URL}/admin/${ORG_ID}/places/${PLACE_ID}/bookings`,
        }),
      }),
    );
  });

  it("dedupes recipients: direct owner also in owning orgs gets ONE notification (human slug wins)", async () => {
    const { deps, notify } = buildDeps({
      username: "venueowner",
      membersByOrg: {
        [ORG_ID]: [member(OWNER_ID, "OWNER"), member(MEMBER_ADMIN_ID, "ADMIN")],
        [SECOND_ORG_ID]: [member(MEMBER_ADMIN_ID, "ADMIN")],
      },
    });
    const place = buildPlaceRecord({
      humanIdsWithAccess: [OWNER_ID],
      orgIdsWithAccess: [ORG_ID, SECOND_ORG_ID],
    });

    await notifyBookingRequestReceived(deps, {
      bookingRequest: ownedRequest,
      place,
    });

    expect(notify).toHaveBeenCalledTimes(2);
    const byHuman = new Map(
      notify.mock.calls.map((call) => {
        const input = call[0] as {
          humanId: string;
          payload: { inboxUrl: string };
        };
        return [input.humanId, input.payload.inboxUrl] as const;
      }),
    );
    expect(byHuman.size).toBe(2);
    // Direct-owner resolution wins for the dual-role human.
    expect(byHuman.get(OWNER_ID)).toBe(
      `${PUBLIC_APP_URL}/admin/@venueowner/places/${PLACE_ID}/bookings`,
    );
    expect(byHuman.get(MEMBER_ADMIN_ID)).toBe(
      `${PUBLIC_APP_URL}/admin/owning-org/places/${PLACE_ID}/bookings`,
    );
  });

  // ── actName resolution (email-template hazard: must never be empty) ───────

  it("owned row without a pitch actName falls back to the human sender's display name", async () => {
    const { deps, notify } = buildDeps({
      humanNameById: { [ACTOR_ID]: "Riley Strummer" },
    });

    await notifyBookingRequestReceived(deps, {
      bookingRequest: buildBookingRequestRecord({ actName: null }),
      place: buildPlaceRecord(),
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ actName: "Riley Strummer" }),
      }),
    );
  });

  it("owned ORG-sender row without a pitch actName falls back to the org name; nameless sender gets the neutral constant", async () => {
    const orgSender = buildBookingRequestRecord({
      actName: null,
      performerOwnerType: "organization",
      performerOwnerId: SECOND_ORG_ID,
    });
    const withName = buildDeps({ orgNameById: { [SECOND_ORG_ID]: "Org Band" } });
    await notifyBookingRequestReceived(withName.deps, {
      bookingRequest: orgSender,
      place: buildPlaceRecord(),
    });
    expect(withName.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ actName: "Org Band" }),
      }),
    );

    const nameless = buildDeps({ humanNameById: { [ACTOR_ID]: null } });
    await notifyBookingRequestReceived(nameless.deps, {
      bookingRequest: buildBookingRequestRecord({ actName: null }),
      place: buildPlaceRecord(),
    });
    expect(nameless.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ actName: "A performer" }),
      }),
    );
  });

  it("anonymous rows carry actName + contact fields in the payload", async () => {
    const { deps, notify } = buildDeps();

    await notifyBookingRequestReceived(deps, {
      bookingRequest: anonymousRequest,
      place: buildPlaceRecord(),
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          actName: "Basement Tapes",
          contactName: "Sam Torres",
          contactEmail: "sam@example.com",
          source: "EMBED",
        }),
      }),
    );
  });

  // ── Failure posture ────────────────────────────────────────────────────────

  it("a throwing notify() for one recipient is swallowed + reported and the rest still deliver", async () => {
    let calls = 0;
    const { deps, notify, reportError } = buildDeps({
      membersByOrg: {
        [ORG_ID]: [
          member(MEMBER_ADMIN_ID, "ADMIN"),
          member(MEMBER_EDITOR_ID, "EDITOR"),
        ],
      },
      notifyImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error("smtp down");
        return { ok: true };
      },
    });
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [ORG_ID],
    });

    await expect(
      notifyBookingRequestReceived(deps, {
        bookingRequest: ownedRequest,
        place,
      }),
    ).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "notifyBookingRequestReceived" },
      extra: {
        bookingRequestId: REQUEST_ID,
        placeId: PLACE_ID,
        humanId: MEMBER_ADMIN_ID,
      },
    });
  });

  it("a throwing reporter never escapes the per-recipient swallow", async () => {
    const { deps, notify } = buildDeps({
      notifyImpl: async () => {
        throw new Error("boom");
      },
    });
    deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    await expect(
      notifyBookingRequestReceived(deps, {
        bookingRequest: ownedRequest,
        place: buildPlaceRecord(),
      }),
    ).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("throws (for the caller's swallow) when publicAppUrl is missing — no notify call, no burned keys", async () => {
    const { deps, notify } = buildDeps({ publicAppUrl: null });

    await expect(
      notifyBookingRequestReceived(deps, {
        bookingRequest: ownedRequest,
        place: buildPlaceRecord(),
      }),
    ).rejects.toThrow(/publicAppUrl/);
    expect(notify).not.toHaveBeenCalled();
  });

  it("no recipients → no notify calls, resolves cleanly, and REPORTS the silent FR-008 gap", async () => {
    const { deps, notify, reportError } = buildDeps();
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [],
    });

    await expect(
      notifyBookingRequestReceived(deps, {
        bookingRequest: ownedRequest,
        place,
      }),
    ).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    // warn is not Sentry-captured — the zero-recipients no-op must be
    // reported or FR-008 silently no-ops for this place forever.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "notifyBookingRequestReceived" },
      extra: { bookingRequestId: REQUEST_ID, placeId: PLACE_ID },
    });
    expect((reportError.mock.calls[0]![0] as Error).message).toBe(
      "booking_request_notify_no_recipients",
    );
  });

  it("no recipients: works unwired and a throwing reporter is harmless", async () => {
    const place = buildPlaceRecord({
      humanIdsWithAccess: [],
      orgIdsWithAccess: [],
    });

    const unwired = buildDeps();
    unwired.deps.reportError = undefined;
    await expect(
      notifyBookingRequestReceived(unwired.deps, {
        bookingRequest: ownedRequest,
        place,
      }),
    ).resolves.toBeUndefined();

    const throwing = buildDeps();
    throwing.deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(
      notifyBookingRequestReceived(throwing.deps, {
        bookingRequest: ownedRequest,
        place,
      }),
    ).resolves.toBeUndefined();
    expect(throwing.notify).not.toHaveBeenCalled();
  });
});
