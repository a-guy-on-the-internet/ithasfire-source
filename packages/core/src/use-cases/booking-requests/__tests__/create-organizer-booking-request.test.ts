import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { PerformerProfileRecord } from "@th/ports/repos/performer-profiles";
import type { CreateOrganizerBookingRequestRecordInput } from "@th/types/repos/booking-requests";

import { createOrganizerBookingRequest } from "../create-organizer-booking-request";
import type { CreateOrganizerBookingRequestDeps } from "../create-organizer-booking-request";
import { BOOKING_REQUEST_TTL_DAYS } from "../create-booking-request";
import { DAY_MS } from "../constants";
import {
  ACTOR_ID,
  ATTACHED_EVENT_ID,
  NOW,
  ORGANIZER_ORG_ID,
  ORG_ID,
  OTHER_HUMAN_ID,
  REQUEST_ID,
  buildOrganizerBookingRequestRecord,
  buildPerformerProfile,
  withTx,
} from "./helpers";

const PERFORMER_ID = OTHER_HUMAN_ID;

const VALID_INPUT = {
  actorHumanId: ACTOR_ID,
  organizerOrgId: ORGANIZER_ORG_ID,
  performerOwnerType: "human" as const,
  performerOwnerId: PERFORMER_ID,
  message: "We'd love you to headline our Friday showcase downtown.",
  preferredDates: ["2026-08-14", "2026-08-21"],
};

type BuildDepsOptions = {
  membership?: OrgMembership | null;
  profile?: PerformerProfileRecord | null;
  openRequest?: ReturnType<typeof buildOrganizerBookingRequestRecord> | null;
  event?: { id: string; orgId: string | null } | null;
  notifierFails?: boolean;
  createConflict?: boolean;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const membership =
    options.membership === undefined
      ? ({
          orgId: ORGANIZER_ORG_ID,
          humanId: ACTOR_ID,
          role: "EDITOR",
        } as OrgMembership)
      : options.membership;
  const profile =
    options.profile === undefined
      ? buildPerformerProfile({
          ownerId: PERFORMER_ID,
          acceptsBookingRequests: true,
        })
      : options.profile;

  const bookingRequests = {
    findOpenByOrganizerAndPerformer: vi.fn(
      async () => options.openRequest ?? null,
    ),
    createToPerformer: vi.fn(
      async (input: CreateOrganizerBookingRequestRecordInput) => {
        if (options.createConflict) {
          throw {
            code: "duplicate_open_request",
            message: "duplicate_open_request",
          } as const;
        }
        return buildOrganizerBookingRequestRecord({
          organizerOrgId: input.organizerOrgId,
          performerOwnerType: input.performerOwnerType,
          performerOwnerId: input.performerOwnerId,
          message: input.message,
          preferredDates: input.preferredDates,
          attachedEventId: input.attachedEventId ?? null,
          feeType: input.feeType ?? null,
          feeAmountCents: input.feeAmountCents ?? null,
          feeCurrency: input.feeCurrency ?? null,
          expiresAt: input.expiresAt,
        });
      },
    ),
  };
  const performerProfiles = { getByOwner: vi.fn(async () => profile) };
  const events = {
    getById: vi.fn(async () =>
      options.event === undefined
        ? { id: ATTACHED_EVENT_ID, orgId: ORGANIZER_ORG_ID }
        : options.event,
    ),
  };
  const authz = { getOrgMembership: vi.fn(async () => membership) };
  const audit = { log: vi.fn(async () => {}) };

  const mocks = withTx({
    bookingRequests,
    performerProfiles,
    events,
    authz,
    audit,
  });

  const notify = vi.fn(async () => {
    if (options.notifierFails) throw new Error("notify down");
  });
  const reportError = vi.fn();

  const deps: CreateOrganizerBookingRequestDeps = {
    repos: mocks as unknown as CreateOrganizerBookingRequestDeps["repos"],
    clock: { now: () => NOW },
    notifyOrganizerBookingRequestReceived: notify,
    reportError,
  };

  return {
    deps,
    mocks: { bookingRequests, performerProfiles, events, authz, audit },
    notify,
    reportError,
  };
}

describe("createOrganizerBookingRequest", () => {
  it("creates a TO_PERFORMER request with the 14-day TTL, audits and notifies", async () => {
    const { deps, mocks, notify } = buildDeps();

    const result = await createOrganizerBookingRequest(deps, VALID_INPUT);

    expect(result).toEqual({ bookingRequestId: REQUEST_ID });
    const expectedExpiry = new Date(
      NOW.getTime() + BOOKING_REQUEST_TTL_DAYS * DAY_MS,
    );
    expect(mocks.bookingRequests.createToPerformer).toHaveBeenCalledWith(
      expect.objectContaining({
        organizerOrgId: ORGANIZER_ORG_ID,
        performerOwnerType: "human",
        performerOwnerId: PERFORMER_ID,
        expiresAt: expectedExpiry,
        attachedEventId: null,
        feeCurrency: null,
      }),
    );
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "booking_request",
        action: "booking_request.created",
        data: expect.objectContaining({ direction: "TO_PERFORMER" }),
      }),
    );
    expect(notify).toHaveBeenCalledWith({
      bookingRequest: expect.objectContaining({
        id: REQUEST_ID,
        direction: "TO_PERFORMER",
      }),
    });
  });

  it("rejects when the actor lacks an edit role in the sender org", async () => {
    const { deps, mocks } = buildDeps({
      membership: {
        orgId: ORGANIZER_ORG_ID,
        humanId: ACTOR_ID,
        role: "VIEWER",
      } as OrgMembership,
    });

    await expect(
      createOrganizerBookingRequest(deps, VALID_INPUT),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(mocks.bookingRequests.createToPerformer).not.toHaveBeenCalled();
  });

  it("rejects an org booking ITSELF as the act (same-party guard)", async () => {
    const { deps, mocks } = buildDeps({
      profile: buildPerformerProfile({
        ownerType: "organization",
        ownerId: ORGANIZER_ORG_ID,
        acceptsBookingRequests: true,
      }),
    });

    await expect(
      createOrganizerBookingRequest(deps, {
        ...VALID_INPUT,
        performerOwnerType: "org",
        performerOwnerId: ORGANIZER_ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "CANNOT_BOOK_OWN_ACT" });
    expect(mocks.bookingRequests.createToPerformer).not.toHaveBeenCalled();
  });

  it("allows an org sender to request a DIFFERENT org act", async () => {
    const { deps, mocks } = buildDeps({
      profile: buildPerformerProfile({
        ownerType: "organization",
        ownerId: ORG_ID,
        acceptsBookingRequests: true,
      }),
    });

    await createOrganizerBookingRequest(deps, {
      ...VALID_INPUT,
      performerOwnerType: "org",
      performerOwnerId: ORG_ID,
    });

    expect(mocks.bookingRequests.createToPerformer).toHaveBeenCalledWith(
      expect.objectContaining({
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
      }),
    );
  });

  it("rejects when the target is performer-enabled but NOT accepting (opt-in gate)", async () => {
    const { deps, mocks } = buildDeps({
      profile: buildPerformerProfile({
        ownerId: PERFORMER_ID,
        acceptsBookingRequests: false,
      }),
    });

    await expect(
      createOrganizerBookingRequest(deps, VALID_INPUT),
    ).rejects.toMatchObject({ code: "PERFORMER_NOT_ACCEPTING_REQUESTS" });
    expect(mocks.bookingRequests.createToPerformer).not.toHaveBeenCalled();
  });

  it("rejects when the target has performer mode disabled even if the stale accepting flag is on", async () => {
    const { deps } = buildDeps({
      profile: buildPerformerProfile({
        ownerId: PERFORMER_ID,
        acceptsBookingRequests: true,
        disabledAt: NOW,
      }),
    });

    await expect(
      createOrganizerBookingRequest(deps, VALID_INPUT),
    ).rejects.toMatchObject({ code: "PERFORMER_NOT_ACCEPTING_REQUESTS" });
  });

  it("rejects when the target has no performer profile at all", async () => {
    const { deps } = buildDeps({ profile: null });

    await expect(
      createOrganizerBookingRequest(deps, VALID_INPUT),
    ).rejects.toMatchObject({ code: "PERFORMER_NOT_ACCEPTING_REQUESTS" });
  });

  it("rejects an open duplicate for the same (org, act) pair", async () => {
    const { deps, mocks } = buildDeps({
      openRequest: buildOrganizerBookingRequestRecord(),
    });

    await expect(
      createOrganizerBookingRequest(deps, VALID_INPUT),
    ).rejects.toMatchObject({ code: "DUPLICATE_OPEN_REQUEST" });
    expect(mocks.bookingRequests.createToPerformer).not.toHaveBeenCalled();
  });

  it("accepts an attached event owned by the sender org and stores its id", async () => {
    const { deps, mocks } = buildDeps();

    await createOrganizerBookingRequest(deps, {
      ...VALID_INPUT,
      attachedEventId: ATTACHED_EVENT_ID,
    });

    expect(mocks.events.getById).toHaveBeenCalledWith(ATTACHED_EVENT_ID);
    expect(mocks.bookingRequests.createToPerformer).toHaveBeenCalledWith(
      expect.objectContaining({ attachedEventId: ATTACHED_EVENT_ID }),
    );
  });

  it("rejects an attached event owned by another org", async () => {
    const { deps, mocks } = buildDeps({
      event: { id: ATTACHED_EVENT_ID, orgId: "not-the-sender-org" },
    });

    await expect(
      createOrganizerBookingRequest(deps, {
        ...VALID_INPUT,
        attachedEventId: ATTACHED_EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.bookingRequests.createToPerformer).not.toHaveBeenCalled();
  });

  it("rejects an unknown attached event", async () => {
    const { deps } = buildDeps({ event: null });

    await expect(
      createOrganizerBookingRequest(deps, {
        ...VALID_INPUT,
        attachedEventId: ATTACHED_EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("snapshots the platform fee currency when an amount is present", async () => {
    const { deps, mocks } = buildDeps();

    await createOrganizerBookingRequest(deps, {
      ...VALID_INPUT,
      feeType: "GUARANTEE",
      feeAmountCents: 50_000,
    });

    expect(mocks.bookingRequests.createToPerformer).toHaveBeenCalledWith(
      expect.objectContaining({
        feeType: "GUARANTEE",
        feeAmountCents: 50_000,
        feeCurrency: "usd",
      }),
    );
  });

  it("rejects a fee amount without a concrete ask type (cross-field rule)", async () => {
    const { deps } = buildDeps();

    await expect(
      createOrganizerBookingRequest(deps, {
        ...VALID_INPUT,
        feeType: "NEGOTIABLE",
        feeAmountCents: 50_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects more than 3 preferred dates (FR-003)", async () => {
    const { deps } = buildDeps();

    await expect(
      createOrganizerBookingRequest(deps, {
        ...VALID_INPUT,
        preferredDates: ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("maps the adapter's race-loser P2002 to DUPLICATE_OPEN_REQUEST semantics", async () => {
    const { deps } = buildDeps({ createConflict: true });

    await expect(
      createOrganizerBookingRequest(deps, VALID_INPUT),
    ).rejects.toMatchObject({ code: "duplicate_open_request" });
  });

  it("swallows a failing notifier and reports it — the submission still succeeds", async () => {
    const { deps, reportError } = buildDeps({ notifierFails: true });

    const result = await createOrganizerBookingRequest(deps, VALID_INPUT);

    expect(result).toEqual({ bookingRequestId: REQUEST_ID });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "createOrganizerBookingRequest" },
      }),
    );
  });

  // ── Venue-hierarchy FR-008: calendars route VENUE inboxes only ────────────

  it("REJECTS a smuggled calendarId — TO_PERFORMER requests are never calendar-routed", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createOrganizerBookingRequest(deps, {
        ...VALID_INPUT,
        calendarId: "ca1e0da1-1111-4111-8111-111111111111",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.createToPerformer).not.toHaveBeenCalled();
  });

  it("never passes a calendarId to the repo (typed record pins it null at rest)", async () => {
    const { deps, mocks } = buildDeps();

    await createOrganizerBookingRequest(deps, VALID_INPUT);

    const createInput =
      mocks.bookingRequests.createToPerformer.mock.calls[0]![0]!;
    expect("calendarId" in createInput).toBe(false);
  });
});
