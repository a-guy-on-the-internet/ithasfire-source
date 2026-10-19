import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { OrgMemberRecord } from "@th/types/repos/organizations";

import {
  notifyOrganizerBookingRequestReceived,
  ORGANIZER_BOOKING_REQUEST_RECEIVED_VARIANT,
  type NotifyOrganizerBookingRequestReceivedDeps,
} from "../notify-organizer-booking-request-received";
import { renderNotification } from "../../comms/renderers";
import {
  ACTOR_ID,
  ORGANIZER_ORG_ID,
  ORG_ID,
  REQUEST_ID,
  buildOrganizerBookingRequestRecord,
} from "./helpers";

const MEMBER_ADMIN_ID = "99999999-9999-4999-8999-999999999991";
const MEMBER_VIEWER_ID = "99999999-9999-4999-8999-999999999993";
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
  membersByOrg?: Record<string, OrgMemberRecord[]>;
  orgSlugById?: Record<string, string | null>;
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
      const members = options.membersByOrg?.[orgId] ?? [];
      return { items: offset === 0 ? members : [], total: members.length };
    },
  );

  const repos = {
    organizations: {
      getById: vi.fn(async (id: string) => ({
        id,
        name: options.orgNameById?.[id] ?? "Corner Booking Collective",
        slug:
          options.orgSlugById?.[id] === undefined
            ? "corner-collective"
            : options.orgSlugById[id],
      })),
      listMembers,
    },
  };

  const reportError = vi.fn();
  const deps: NotifyOrganizerBookingRequestReceivedDeps = {
    repos: repos as unknown as NotifyOrganizerBookingRequestReceivedDeps["repos"],
    notify:
      notify as unknown as NotifyOrganizerBookingRequestReceivedDeps["notify"],
    logger: createTestLogger(),
    reportError,
    publicAppUrl:
      options.publicAppUrl === undefined
        ? PUBLIC_APP_URL
        : options.publicAppUrl,
  };

  return { deps, repos, notify, reportError };
}

describe("notifyOrganizerBookingRequestReceived", () => {
  it("notifies a human act directly with the account-settings link and derived idempotency key", async () => {
    const { deps, notify } = buildDeps();

    await notifyOrganizerBookingRequestReceived(deps, {
      bookingRequest: buildOrganizerBookingRequestRecord(),
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: ACTOR_ID,
        variant: ORGANIZER_BOOKING_REQUEST_RECEIVED_VARIANT,
        idempotencyKey: `organizer-booking-request-received:${REQUEST_ID}:${ACTOR_ID}`,
        channels: { sms: { enabled: false } },
        payload: expect.objectContaining({
          orgName: "Corner Booking Collective",
          requestsUrl: `${PUBLIC_APP_URL}/account/settings/booking-requests`,
        }),
      }),
    );
  });

  it("notifies an org act's edit-role members (viewers excluded) with the org-settings link", async () => {
    const { deps, notify } = buildDeps({
      membersByOrg: {
        [ORG_ID]: [
          member(MEMBER_ADMIN_ID, "ADMIN"),
          member(MEMBER_VIEWER_ID, "VIEWER"),
        ],
      },
      orgSlugById: { [ORG_ID]: "the-band" },
    });

    await notifyOrganizerBookingRequestReceived(deps, {
      bookingRequest: buildOrganizerBookingRequestRecord({
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
      }),
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: MEMBER_ADMIN_ID,
        payload: expect.objectContaining({
          // The org's inbox, not the settings index: booking-inbox-placement
          // moved it to /bookings and removed the settings section, so the
          // old target had no route to the request the email is about.
          requestsUrl: `${PUBLIC_APP_URL}/admin/the-band/bookings`,
        }),
      }),
    );
  });

  it("payload renders through the registered renderer (schema-valid before any claim)", async () => {
    const { deps, notify } = buildDeps();

    await notifyOrganizerBookingRequestReceived(deps, {
      bookingRequest: buildOrganizerBookingRequestRecord({
        attachedEventTitle: "East Side Showcase",
      }),
    });

    const call = notify.mock.calls[0]![0] as {
      variant: string;
      payload: unknown;
    };
    const rendered = renderNotification(call.variant, call.payload, {
      now: new Date(),
    });
    expect(rendered.inApp?.title).toBe(
      "Corner Booking Collective wants to book you",
    );
    expect(rendered.email?.template?.key).toBe(
      "booking.organizer_request_received",
    );
  });

  it("reports (not throws) when an org act resolves to zero notifiable members", async () => {
    const { deps, notify, reportError } = buildDeps({
      membersByOrg: { [ORG_ID]: [member(MEMBER_VIEWER_ID, "VIEWER")] },
    });

    await notifyOrganizerBookingRequestReceived(deps, {
      bookingRequest: buildOrganizerBookingRequestRecord({
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
      }),
    });

    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "notifyOrganizerBookingRequestReceived" },
      }),
    );
  });

  it("throws without a publicAppUrl (the caller's swallow reports it)", async () => {
    const { deps } = buildDeps({ publicAppUrl: null });

    await expect(
      notifyOrganizerBookingRequestReceived(deps, {
        bookingRequest: buildOrganizerBookingRequestRecord(),
      }),
    ).rejects.toThrow(/publicAppUrl/);
  });

  it("a failing notify() is swallowed per recipient and reported", async () => {
    const { deps, reportError } = buildDeps({
      notifyImpl: async () => {
        throw new Error("channel down");
      },
    });

    await notifyOrganizerBookingRequestReceived(deps, {
      bookingRequest: buildOrganizerBookingRequestRecord(),
    });

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ humanId: ACTOR_ID }),
      }),
    );
  });

  it("falls back to the org lookup when the denormalized org name is missing", async () => {
    const { deps, notify } = buildDeps({
      orgNameById: { [ORGANIZER_ORG_ID]: "Fresh Org Name" },
    });

    await notifyOrganizerBookingRequestReceived(deps, {
      bookingRequest: buildOrganizerBookingRequestRecord({
        organizerOrgName: null,
      }),
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ orgName: "Fresh Org Name" }),
      }),
    );
  });
});
