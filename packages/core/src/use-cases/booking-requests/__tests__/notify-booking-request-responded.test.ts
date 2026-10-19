import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { OrgMemberRecord } from "@th/types/repos/organizations";

import {
  BOOKING_REQUEST_RESPONDED_VARIANT,
  fireBookingRequestResponded,
  notifyBookingRequestResponded,
  type NotifyBookingRequestRespondedDeps,
} from "../notify-booking-request-responded";
import { renderNotification } from "../../comms/renderers";
import {
  AGREEMENT_ID,
  ORGANIZER_ORG_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// booking-the-night N9 / FR-008: whoever SENT a booking request hears the
// answer, through ONE variant for both directions (the organiser-only
// `booking.organizer-request-responded` folded into it).
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC_APP_URL = "https://ithasfire.test";
const ACT_HUMAN_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const ACT_ORG_ID = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const VENUE_STAFF_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ADMIN_ID = "99999999-9999-4999-8999-999999999991";
const MEMBER_EDITOR_ID = "99999999-9999-4999-8999-999999999992";
const MEMBER_SCANNER_ID = "99999999-9999-4999-8999-999999999994";
const REASON = "We're booked through the fall.";

function member(humanId: string, role: OrgMemberRecord["role"]): OrgMemberRecord {
  return { humanId, name: null, email: null, role, joinedAt: new Date("2026-01-01T00:00:00.000Z") };
}

function buildDeps(
  options: {
    members?: OrgMemberRecord[];
    notifyImpl?: (input: unknown) => Promise<unknown>;
    publicAppUrl?: string | null;
  } = {},
) {
  const notify = vi.fn(options.notifyImpl ?? (async () => ({ ok: true })));
  const members = options.members ?? [member(MEMBER_ADMIN_ID, "ADMIN")];
  const repos = {
    organizations: {
      getById: vi.fn(async (id: string) => ({
        id,
        name: "Some Org",
        slug: id === ORGANIZER_ORG_ID ? "corner-collective" : "the-band",
      })),
      getByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: "Band Org", slug: "band-org" }))),
      listMembers: vi.fn(async ({ offset }: { offset: number }) => ({
        items: offset === 0 ? members : [],
        total: members.length,
      })),
    },
    performerBookingDefaults: {
      getByOwner: vi.fn(async () => ({ actName: "The Midnight Ramblers" })),
    },
    entityPages: { getByOwner: vi.fn(async () => null) },
    humans: { getById: vi.fn(async (id: string) => ({ id, name: "Alice Act" })) },
  };
  const reportError = vi.fn();
  const logger = createTestLogger();
  // The use case logs on its child logger: hand back the same one.
  vi.mocked(logger.child).mockReturnValue(logger);
  const deps: NotifyBookingRequestRespondedDeps = {
    repos: repos as unknown as NotifyBookingRequestRespondedDeps["repos"],
    notify: notify as unknown as NotifyBookingRequestRespondedDeps["notify"],
    logger,
    reportError,
    publicAppUrl: options.publicAppUrl === undefined ? PUBLIC_APP_URL : options.publicAppUrl,
  };
  return { deps, notify, reportError, logger };
}

const toVenue = (over: Record<string, unknown> = {}) =>
  buildBookingRequestRecord({
    performerOwnerType: "human",
    performerOwnerId: ACT_HUMAN_ID,
    placeName: "The Corner Stage",
    ...over,
  } as Parameters<typeof buildBookingRequestRecord>[0]);

describe("notifyBookingRequestResponded — TO_VENUE (the venue answered the act)", () => {
  it("a decline reaches the human sender with the venue's REASON, links their sent requests", async () => {
    const { deps, notify } = buildDeps();

    await notifyBookingRequestResponded(deps, {
      bookingRequest: toVenue(),
      action: "declined",
      agreementId: null,
      reason: REASON,
      actorHumanId: VENUE_STAFF_ID,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      humanId: ACT_HUMAN_ID,
      variant: BOOKING_REQUEST_RESPONDED_VARIANT,
      idempotencyKey: `booking-request-responded:${REQUEST_ID}:declined:${ACT_HUMAN_ID}`,
      payload: {
        bookingRequestId: REQUEST_ID,
        responderName: "The Corner Stage",
        action: "declined",
        reason: REASON,
        targetUrl: `${PUBLIC_APP_URL}/account/settings/booking-requests`,
      },
      channels: { sms: { enabled: false } },
    });
  });

  it("an accept says terms follow (no reason), carries the agreement", async () => {
    const { deps, notify } = buildDeps();

    await notifyBookingRequestResponded(deps, {
      bookingRequest: toVenue(),
      action: "accepted",
      agreementId: AGREEMENT_ID,
      reason: "ignored on accept",
      actorHumanId: VENUE_STAFF_ID,
    });

    const call = notify.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(call.payload).toEqual({
      bookingRequestId: REQUEST_ID,
      responderName: "The Corner Stage",
      action: "accepted",
      acceptedNext: "terms_coming",
      agreementId: AGREEMENT_ID,
      targetUrl: `${PUBLIC_APP_URL}/account/settings/booking-requests`,
    });
  });

  it("an ORG sender: its edit-role members (scanner excluded), the org's bookings hub; never the acting human", async () => {
    const { deps, notify } = buildDeps({
      members: [
        member(MEMBER_ADMIN_ID, "ADMIN"),
        member(MEMBER_EDITOR_ID, "EDITOR"),
        member(MEMBER_SCANNER_ID, "SCANNER"),
        member(VENUE_STAFF_ID, "ADMIN"),
      ],
    });

    await notifyBookingRequestResponded(deps, {
      bookingRequest: toVenue({ performerOwnerType: "organization", performerOwnerId: ACT_ORG_ID }),
      action: "closed",
      agreementId: AGREEMENT_ID,
      reason: REASON,
      actorHumanId: VENUE_STAFF_ID,
    });

    expect(notify.mock.calls.map((c) => (c[0] as { humanId: string }).humanId)).toEqual([
      MEMBER_ADMIN_ID,
      MEMBER_EDITOR_ID,
    ]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          action: "closed",
          reason: REASON,
          targetUrl: `${PUBLIC_APP_URL}/admin/the-band/bookings`,
        }),
      }),
    );
  });

  it("an unclaimed embed inquiry has nobody on the platform to tell → skipped (logged, not reported)", async () => {
    const { deps, notify, reportError } = buildDeps();

    await notifyBookingRequestResponded(deps, {
      bookingRequest: toVenue({
        performerOwnerType: null,
        performerOwnerId: null,
        source: "EMBED",
        contactName: "A Fan",
        contactEmail: "fan@example.com",
      } as never),
      action: "declined",
      agreementId: null,
      reason: REASON,
      actorHumanId: VENUE_STAFF_ID,
    });

    expect(notify).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("renders through the registered renderer: title, the reason in the body, the email template", async () => {
    const { deps, notify } = buildDeps();
    await notifyBookingRequestResponded(deps, {
      bookingRequest: toVenue(),
      action: "declined",
      agreementId: null,
      reason: REASON,
      actorHumanId: VENUE_STAFF_ID,
    });
    const call = notify.mock.calls[0]![0] as { variant: string; payload: unknown };
    const rendered = renderNotification(call.variant, call.payload, { now: new Date() });

    expect(rendered.category).toBe("transactional");
    expect(rendered.inApp?.title).toBe("The Corner Stage declined your booking request");
    expect(rendered.inApp?.body).toContain(REASON);
    expect(rendered.email?.template?.key).toBe("booking.request_responded");
    expect(rendered.email?.template?.variables).toMatchObject({ reason: REASON, action: "declined" });
    expect(rendered.push?.title).toBe("The Corner Stage declined your booking request");
  });
});

describe("notifyBookingRequestResponded — TO_PERFORMER (folded organiser variant)", () => {
  it("the act's accept reaches the organiser org's edit-role members with the agreement link", async () => {
    const { deps, notify } = buildDeps({
      members: [member(MEMBER_ADMIN_ID, "ADMIN"), member(MEMBER_SCANNER_ID, "SCANNER")],
    });

    await notifyBookingRequestResponded(deps, {
      bookingRequest: buildOrganizerBookingRequestRecord(),
      action: "accepted",
      agreementId: AGREEMENT_ID,
      reason: null,
      actorHumanId: ACT_HUMAN_ID,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: MEMBER_ADMIN_ID,
        variant: "booking.request-responded",
        payload: expect.objectContaining({
          responderName: "The Midnight Ramblers",
          action: "accepted",
          acceptedNext: "agreement_ready",
          targetUrl: `${PUBLIC_APP_URL}/agreements/${AGREEMENT_ID}`,
        }),
      }),
    );
    const call = notify.mock.calls[0]![0] as { variant: string; payload: unknown };
    expect(
      renderNotification(call.variant, call.payload, { now: new Date() }).inApp?.title,
    ).toBe("The Midnight Ramblers accepted your booking request");
  });

  it("the act's decline links the organiser's bookings hub, with the act's reason when given", async () => {
    const { deps, notify } = buildDeps();

    await notifyBookingRequestResponded(deps, {
      bookingRequest: buildOrganizerBookingRequestRecord(),
      action: "declined",
      agreementId: null,
      reason: "Already booked that weekend.",
      actorHumanId: ACT_HUMAN_ID,
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          action: "declined",
          reason: "Already booked that weekend.",
          targetUrl: `${PUBLIC_APP_URL}/admin/corner-collective/bookings`,
        }),
      }),
    );
  });
});

describe("notifyBookingRequestResponded — failures (ReporterPort convention)", () => {
  it("a failing notify() is isolated per recipient: logged at error AND reported, guarded", async () => {
    const { deps, reportError, logger } = buildDeps({
      members: [member(MEMBER_ADMIN_ID, "ADMIN"), member(MEMBER_EDITOR_ID, "EDITOR")],
      notifyImpl: async () => {
        throw new Error("channel down");
      },
    });
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(
      notifyBookingRequestResponded(deps, {
        bookingRequest: buildOrganizerBookingRequestRecord(),
        action: "accepted",
        agreementId: AGREEMENT_ID,
        reason: null,
        actorHumanId: ACT_HUMAN_ID,
      }),
    ).resolves.toBeUndefined();

    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "channel down" }),
      expect.objectContaining({ tags: { useCase: "notifyBookingRequestResponded" } }),
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("a sender org with nobody to tell is a fault: logged at error AND reported", async () => {
    const { deps, notify, reportError } = buildDeps({ members: [member(MEMBER_SCANNER_ID, "SCANNER")] });

    await notifyBookingRequestResponded(deps, {
      bookingRequest: toVenue({ performerOwnerType: "organization", performerOwnerId: ACT_ORG_ID }),
      action: "declined",
      agreementId: null,
      reason: REASON,
      actorHumanId: VENUE_STAFF_ID,
    });

    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "booking_request_responded_no_recipients" }),
      expect.anything(),
    );
  });

  it("throws without a publicAppUrl — the caller's swallow (`fireBookingRequestResponded`) reports it and never throws", async () => {
    const { deps } = buildDeps({ publicAppUrl: null });
    const args = {
      bookingRequest: toVenue(),
      action: "declined" as const,
      agreementId: null,
      reason: REASON,
      actorHumanId: VENUE_STAFF_ID,
    };
    await expect(notifyBookingRequestResponded(deps, args)).rejects.toThrow(/publicAppUrl/);

    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const logger = createTestLogger();
    await expect(
      fireBookingRequestResponded(
        {
          notifyBookingRequestResponded: (a) => notifyBookingRequestResponded(deps, a),
          logger,
          reportError,
        },
        args,
        "respondToBookingRequest",
      ),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { useCase: "respondToBookingRequest", step: "request_responded" } }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.notify_responded_failed",
      expect.anything(),
    );
  });
});
