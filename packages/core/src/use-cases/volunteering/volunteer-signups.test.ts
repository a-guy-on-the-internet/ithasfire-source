import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  EventVolunteerRoleWithShiftsRecord,
  VolunteerShiftRecord,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";
import type { NotifyOutput } from "../comms/notify";
import {
  submitVolunteerSignup,
  ANONYMOUS_SUBMIT_FLOOR_MS,
  reviewVolunteerSignup,
  reviewVolunteerSignupsBatch,
  checkInVolunteer,
  withdrawVolunteerSignup,
  listMyVolunteerSignups,
  listVolunteerSignups,
} from "./volunteer-signups";
import type { VolunteerSignupDeps } from "./volunteer-signups";
import { ensureSmsDeliverable } from "../comms/ensure-sms-deliverable";
import { recordSmsOptOut } from "../comms/record-sms-opt-out";
import { makeFakeSmsConsentRepo } from "../comms/__tests__/fake-sms-consent-repo";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const REVIEWER_ID = "00000000-0000-4000-8000-000000000005";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const SHIFT_ID = "00000000-0000-4000-8000-000000000030";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000040";
const SIGNUP_ID_2 = "00000000-0000-4000-8000-000000000041";
const SIGNUP_ID_3 = "00000000-0000-4000-8000-000000000042";
const GUEST_HUMAN_ID = "00000000-0000-4000-8000-000000000050";
const WAIVER_TEMPLATE_ID = "00000000-0000-4000-8000-000000000060";
const EVENT_ASK_ID = "00000000-0000-4000-8000-000000000070";
const ASK_ID = "00000000-0000-4000-8000-000000000071";
const ASK_ROLE_ID = "00000000-0000-4000-8000-000000000072";
const GROUP_ID = "00000000-0000-4000-8000-000000000073";
const OTHER_GROUP_ID = "00000000-0000-4000-8000-000000000074";
const COORDINATOR_ID = "00000000-0000-4000-8000-000000000075";
const ASK_SIGNUP_ID = "00000000-0000-4000-8000-000000000076";
const NOW = new Date("2026-06-01T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Summer Fest",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2026-07-01T18:00:00Z"),
  endsAt: new Date("2026-07-01T23:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  locality: null,
  region: null,
  countryCode: null,
  postalCode: null,
  shortId: null,
  // Slug-based links: the approval notice routes to the public event page,
  // which resolves by slug / slug history only.
  slug: "org/us/austin/the-show--ab12cd",
  currency: "usd",
  heroImageUrl: null,
  content: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  defaultLocale: null,
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  refundCutoffAt: null,
  admissionTaxRateBps: null,
  taxRateSource: null,
  agreementPrimaryId: null,
  agreementResaleId: null,
  placeLayoutId: null,
  volunteeringEnabled: true,
  volunteerAutoApprove: false,
  createdAt: NOW,
  updatedAt: NOW,
} as EventRecord;

const baseRole: EventVolunteerRoleWithShiftsRecord = {
  id: ROLE_ID,
  eventId: EVENT_ID,
  templateId: null,
  name: "Security",
  description: null,
  capacity: 10,
  autoApprove: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [],
};

const baseShift: VolunteerShiftRecord = {
  id: SHIFT_ID,
  roleId: ROLE_ID,
  label: "Morning",
  startsAt: new Date("2026-07-01T09:00:00Z"),
  endsAt: new Date("2026-07-01T13:00:00Z"),
  capacity: 5,
  notes: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const baseSignup: VolunteerSignupRecord = {
  id: SIGNUP_ID,
  eventId: EVENT_ID,
  roleId: ROLE_ID,
  shiftId: null,
  humanId: ACTOR_ID,
  contactEmail: "volunteer@example.com",
  contactName: "Volunteer User",
  contactPhone: null,
  smsOptIn: false,
  status: "PENDING",
  hoursWorked: null,
  answers: {},
  reviewerHumanId: null,
  reviewedAt: null,
  checkedInAt: null,
  notes: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};

// ── Ask-path fixtures (generic-volunteering-asks A4) ─────────────────────────

/** Backfilled EVENT-subject ask for `baseEvent` (A1 migration shape). */
const baseEventAsk = {
  id: EVENT_ASK_ID,
  subjectType: "EVENT" as const,
  subjectId: EVENT_ID,
  orgId: ORG_ID,
  title: "Summer Fest",
  description: null,
  status: "OPEN" as const,
  cadence: "ONE_TIME" as const,
  startsAt: null,
  endsAt: null,
  capacity: null,
  autoApprove: false,
  waiverRequired: false,
  smsOptInEnabled: true,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

/** Generic ORG-subject ask. */
const baseAsk = {
  ...baseEventAsk,
  id: ASK_ID,
  subjectType: "ORG" as const,
  subjectId: ORG_ID,
  title: "Standing bar crew",
};

/** Ask-owned role (no eventId). */
const baseAskRole = {
  ...baseRole,
  id: ASK_ROLE_ID,
  eventId: null,
  askId: ASK_ID,
  defaultHours: null,
};

const baseGroup = {
  id: GROUP_ID,
  askId: ASK_ID,
  name: "Door team",
  description: null,
  capacity: null,
  coordinatorHumanId: COORDINATOR_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

/** Ask-only signup (null eventId) sitting in `baseGroup`. */
const baseAskSignup = {
  ...baseSignup,
  id: ASK_SIGNUP_ID,
  eventId: null,
  askId: ASK_ID,
  roleId: ASK_ROLE_ID,
  groupId: GROUP_ID,
};

const emptyPage = (limit = 25) => ({
  items: [] as VolunteerSignupRecord[],
  pageInfo: {
    total: 0,
    count: 0,
    limit,
    offset: 0,
    hasNextPage: false,
    nextOffset: null,
  },
});

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeTxRepos(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    events: {
      getById: vi.fn(async () => baseEvent),
    },
    // Ban that sticks: nobody withheld unless a test says so.
    bans: {
      findBannedOwners: vi.fn(async () => ({ humanIds: [], orgIds: [] })),
    },
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, slug: "summer-org" })),
      // Default: no members → the spot-opened fan-out resolves zero
      // recipients unless a test installs an admin roster.
      listMembers: vi.fn(async () => ({ items: [], total: 0 })),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })),
    },
    humans: {
      getById: vi.fn(async () => ({
        id: REVIEWER_ID,
        name: "Reviewer Name",
        phone: null,
      })),
      update: vi.fn(async (id: string, updates: any) => ({ id, ...updates })),
      ensureGuestHuman: vi.fn(async () => ({
        humanId: GUEST_HUMAN_ID,
        created: true,
      })),
      // A coordinator seat needs a verified email (B2).
      getByIdWithIdentity: vi.fn(async () => ({
        identity: { emailVerified: true },
      })),
    },
    eventHumans: {
      attach: vi.fn(async (input: any) => ({
        id: "eh-id",
        ...input,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })),
      detach: vi.fn(async () => undefined),
      listByEvent: vi.fn(async () => []),
    },
    volunteering: {
      getEventRole: vi.fn(async () => baseRole),
      getShift: vi.fn(async () => baseShift),
      getSignup: vi.fn(async () => baseSignup),
      getSignupByEmail: vi.fn(async () => null),
      // Ask surface (A4). Event-path submits/creates resolve the event's
      // backfilled EVENT-subject ask; ask-path flows override these. The
      // lazy insert goes through the race-safe createAskIfAbsent + re-read.
      listAsksBySubject: vi.fn(async () => [baseEventAsk]),
      createAskIfAbsent: vi.fn(async () => undefined),
      getAsk: vi.fn(async () => baseAsk),
      getGroup: vi.fn(async () => baseGroup),
      listGroupsByAsk: vi.fn(async () => []),
      listSignupsByAsk: vi.fn(async () => emptyPage()),
      updateSignupHoursWorked: vi.fn(
        async (input: { id: string; hoursWorked: number | null }) => ({
          ...baseAskSignup,
          id: input.id,
          status: "CHECKED_IN",
          hoursWorked: input.hoursWorked,
        }),
      ),
      createSignup: vi.fn(async (input: any) => ({
        ...baseSignup,
        ...input,
        id: SIGNUP_ID,
        createdAt: NOW,
        updatedAt: NOW,
      })),
      updateSignupStatus: vi.fn(async (id: string, input: any) => ({
        ...baseSignup,
        ...input,
        id,
        updatedAt: NOW,
      })),
      listSignups: vi.fn(async () => ({
        items: [baseSignup],
        total: 1,
        limit: 50,
        offset: 0,
      })),
      listSignupsByHuman: vi.fn(async () => [baseSignup]),
      countByRole: vi.fn(async () => ({})),
      countByShift: vi.fn(async () => ({})),
      countAcceptedOccupancy: vi.fn(async () => 0),
      countPendingSignups: vi.fn(async () => 0),
      countAcceptedByRole: vi.fn(async () => ({})),
      countAcceptedByShiftForEvent: vi.fn(async () => ({})),
      // Occurrence-claim cascade (generic-volunteer-shifts-occurrences
      // FR-003) — withdraw flips future claims in the same tx.
      withdrawFutureClaimsBySignup: vi.fn(async () => 0),
      // Other methods (not used here)
      createRoleTemplate: vi.fn(),
      updateRoleTemplate: vi.fn(),
      archiveRoleTemplate: vi.fn(),
      listRoleTemplates: vi.fn(),
      getRoleTemplate: vi.fn(),
      createEventRole: vi.fn(),
      updateEventRole: vi.fn(),
      deleteEventRole: vi.fn(),
      listEventRoles: vi.fn(),
      createShift: vi.fn(),
      updateShift: vi.fn(),
      deleteShift: vi.fn(),
      listShifts: vi.fn(),
    },
    waiverTemplates: {
      getById: vi.fn(async () => null),
    },
    volunteerWaiverAcceptances: {
      create: vi.fn(async (input: any) => ({
        id: "vwa-id",
        acceptedAt: NOW,
        ipAddress: null,
        userAgent: null,
        ...input,
      })),
      findCurrentForHuman: vi.fn(async () => null),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...overrides,
  };
}
const NOTIFY_RESULT: NotifyOutput = {
  ok: true,
  variant: "volunteer.signup-received",
  category: "transactional",
  scope: { kind: "EVENT", eventId: EVENT_ID },
  inApp: { status: "skipped", reason: "no_adapter" },
};

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

function makeDeps(
  txOverrides: Record<string, unknown> = {},
): VolunteerSignupDeps {
  const txRepos = makeTxRepos(txOverrides);
  return {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
      // B2: every recipient verified unless a test says otherwise.
      humans: {
        listEmailVerifiedIds: vi.fn(
          async (ids: readonly string[]): Promise<string[]> => [...ids],
        ),
      },
    } as unknown as Repos,
    authz: denyingAuthz,
    clock: { now: () => NOW },
    notify: vi.fn(async () => NOTIFY_RESULT),
    appBaseUrl: "https://test.local",
    // No timing floor in unit tests (it has its own tests below).
    anonymousSubmitFloorMs: 0,
  };
}

function makeDepsWithMocks(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const notify = vi.fn(async () => NOTIFY_RESULT);
  const deps: VolunteerSignupDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
      // B2: every recipient verified unless a test says otherwise.
      humans: {
        listEmailVerifiedIds: vi.fn(
          async (ids: readonly string[]): Promise<string[]> => [...ids],
        ),
      },
    } as unknown as Repos,
    authz: denyingAuthz,
    clock: { now: () => NOW },
    notify,
    appBaseUrl: "https://test.local",
    // No timing floor in unit tests (it has its own tests below).
    anonymousSubmitFloorMs: 0,
  };
  return { deps, txRepos, notify };
}

// ══════════════════════════════════════════════════════════════════════════════
// submitVolunteerSignup
// ══════════════════════════════════════════════════════════════════════════════

describe("submitVolunteerSignup", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    roleId: ROLE_ID,
    contactEmail: "volunteer@example.com",
    contactName: "Volunteer User",
  };

  it("creates a PENDING signup when auto-approve is off", async () => {
    const deps = makeDeps();
    const result = await submitVolunteerSignup(deps, validInput);

    expect(result).toMatchObject({
      id: SIGNUP_ID,
      status: "PENDING",
      contactEmail: "volunteer@example.com",
    });
  });

  it("creates an APPROVED signup when role-level autoApprove is true", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseRole,
      autoApprove: true,
    }));

    const result = await submitVolunteerSignup(deps, validInput);

    expect(result.status).toBe("APPROVED");
    // Should also create EventHuman link
    expect((txRepos.eventHumans as any).attach).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        humanId: ACTOR_ID,
        role: "VOLUNTEER",
        customRoleLabel: "Security",
      }),
    );
  });

  it("falls back to event-level autoApprove when role-level is null", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.events as any).getById = vi.fn(async () => ({
      ...baseEvent,
      volunteerAutoApprove: true,
    }));

    const result = await submitVolunteerSignup(deps, validInput);
    expect(result.status).toBe("APPROVED");
  });

  it("creates shadow profile for unauthenticated signup", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await submitVolunteerSignup(deps, {
      ...validInput,
      actorHumanId: null,
    });

    // Never passes a name to ensureGuestHuman (it would rename an existing
    // account); the name is applied only to the Human this call minted.
    expect((txRepos.humans as any).ensureGuestHuman).toHaveBeenCalledWith({
      email: "volunteer@example.com",
    });
    expect((txRepos.humans as any).update).toHaveBeenCalledWith(
      GUEST_HUMAN_ID,
      { name: "Volunteer User" },
    );

    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: GUEST_HUMAN_ID,
      }),
    );
  });

  it("reports (and swallows) a failed confirmation notify — the signup still returns", async () => {
    const { deps, notify } = makeDepsWithMocks();
    const boom = new Error("notify down");
    notify.mockRejectedValueOnce(boom);
    const reportError = vi.fn();
    deps.reportError = reportError;

    const result = await submitVolunteerSignup(deps, validInput);

    expect(result.id).toBe(SIGNUP_ID);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "submitVolunteerSignup", stage: "confirmation" },
      extra: { signupId: SIGNUP_ID },
    });
  });

  describe("anonymous signup naming an email that already has an account (contact-only)", () => {
    function existingAccountDeps(txOverrides: Record<string, unknown> = {}) {
      const made = makeDepsWithMocks({
        events: {
          getById: vi.fn(async () => ({
            ...baseEvent,
            volunteerAutoApprove: true,
          })),
        },
        ...txOverrides,
      });
      (made.txRepos.humans as any).ensureGuestHuman = vi.fn(async () => ({
        humanId: GUEST_HUMAN_ID,
        created: false,
      }));
      (made.txRepos.humans as any).getById = vi.fn(async () => ({
        id: GUEST_HUMAN_ID,
        name: null,
        phone: null,
      }));
      (made.txRepos.humans as any).update = vi.fn();
      return made;
    }
    const anonymous = {
      eventId: EVENT_ID,
      roleId: ROLE_ID,
      contactEmail: "volunteer@example.com",
      contactName: "Stranger",
      contactPhone: "+15555550100",
    };

    it("stores the signup with humanId null and writes nothing onto the account", async () => {
      const { deps, txRepos, notify } = existingAccountDeps();

      const result = await submitVolunteerSignup(deps, anonymous);

      expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: null,
          contactName: "Stranger",
          contactPhone: "+15555550100",
        }),
      );
      // (a) no profile carry-over — not even fill-if-null onto empty fields.
      expect((txRepos.humans as any).update).not.toHaveBeenCalled();
      // (c) not bound: no EventHuman link even though it auto-approved, no
      // confirmation to the account, and the caller sees no humanId.
      expect((txRepos.eventHumans as any).attach).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(result.humanId).toBeNull();
      expect((txRepos.audit as any).log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ humanId: null, contactOnly: true }),
        }),
      );
    });

    it("gives an anonymous NEW shadow the same response shape (no account-existence oracle)", async () => {
      const { deps, txRepos } = makeDepsWithMocks();

      const result = await submitVolunteerSignup(deps, anonymous);

      // Bound to the fresh shadow server-side…
      expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
        expect.objectContaining({ humanId: GUEST_HUMAN_ID }),
      );
      // …but the anonymous caller sees humanId null either way.
      expect(result.humanId).toBeNull();
    });

    it("(b) records the waiver acceptance with humanId NULL (never against the account), and keeps an audit copy", async () => {
      const { deps, txRepos } = existingAccountDeps({
        events: {
          getById: vi.fn(async () => ({
            ...baseEvent,
            volunteerWaiverRequired: true,
            waiverTemplateId: WAIVER_TEMPLATE_ID,
          })),
        },
        waiverTemplates: {
          getById: vi.fn(async () => ({
            id: WAIVER_TEMPLATE_ID,
            version: 3,
            body: "I accept.",
          })),
        },
      });

      await submitVolunteerSignup(deps, { ...anonymous, waiverAccepted: true });

      // The row is always written — the roster's waiver badge reads it —
      // but it is not attributed to the account.
      expect(
        (txRepos.volunteerWaiverAcceptances as any).create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: null,
          waiverTemplateId: WAIVER_TEMPLATE_ID,
          waiverVersion: 3,
        }),
      );
      expect(
        (txRepos.volunteerWaiverAcceptances as any).findCurrentForHuman,
      ).not.toHaveBeenCalled();
      expect((txRepos.audit as any).log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            contactOnly: true,
            waiverAccepted: true,
            waiverEvidence: expect.objectContaining({
              waiverTemplateId: WAIVER_TEMPLATE_ID,
              waiverVersion: 3,
            }),
          }),
        }),
      );
    });

    it("still requires the waiver to be accepted", async () => {
      const { deps } = existingAccountDeps({
        events: {
          getById: vi.fn(async () => ({
            ...baseEvent,
            volunteerWaiverRequired: true,
            waiverTemplateId: WAIVER_TEMPLATE_ID,
          })),
        },
        waiverTemplates: {
          getById: vi.fn(async () => ({
            id: WAIVER_TEMPLATE_ID,
            version: 3,
            body: "I accept.",
          })),
        },
      });

      await expect(
        submitVolunteerSignup(deps, anonymous),
      ).rejects.toMatchObject({ code: "WAIVER_REQUIRED" });
    });

    it("an AUTHENTICATED signup is unchanged: bound to the actor, carry-over runs", async () => {
      const { deps, txRepos } = existingAccountDeps();
      (txRepos.humans as any).getById = vi.fn(async () => ({
        id: ACTOR_ID,
        name: null,
        phone: null,
      }));

      const result = await submitVolunteerSignup(deps, {
        ...anonymous,
        actorHumanId: ACTOR_ID,
      });

      expect((txRepos.humans as any).ensureGuestHuman).not.toHaveBeenCalled();
      expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
        expect.objectContaining({ humanId: ACTOR_ID }),
      );
      expect((txRepos.humans as any).update).toHaveBeenCalled();
      expect((txRepos.eventHumans as any).attach).toHaveBeenCalled();
      expect(result.humanId).not.toBeNull();
    });

    function withMail(deps: VolunteerSignupDeps) {
      const send = vi.fn(async () => ({ result: { success: true, id: "m1" } }));
      const consume = vi.fn(async () => ({
        allowed: true,
        remaining: 2,
        retryAfterSeconds: 0,
      }));
      deps.mailer = { send } as never;
      deps.rateLimit = { consume } as never;
      return { send, consume };
    }

    it("confirms by fixed-copy direct email to contactEmail, capped per recipient", async () => {
      const { deps } = existingAccountDeps();
      const { send, consume } = withMail(deps);

      await submitVolunteerSignup(deps, anonymous);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

      expect(consume).toHaveBeenCalledWith(
        expect.stringMatching(/^volunteer:contactOnlyMail:to:[0-9a-f]{64}$/),
        3,
        86400,
      );
      const mail = (send.mock.calls[0] as unknown as [any])[0];
      expect(mail.to).toEqual({ to: "volunteer@example.com" });
      expect(mail.text).toContain("Someone signed up to volunteer for");
      expect(mail.text).toContain("If this wasn't you");
      // Fixed copy: nothing the submitter typed (name/phone/answers) is echoed.
      expect(mail.text).not.toContain("Stranger");
      expect(mail.text).not.toContain("+15555550100");
    });

    it("AWAITS post-commit work on an anonymous submit (Cloud Run gives no CPU after the response)", async () => {
      const { deps } = existingAccountDeps();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const send = vi.fn(async () => {
        await gate;
        return { result: { success: true } };
      });
      deps.mailer = { send } as never;
      deps.rateLimit = {
        consume: vi.fn(async () => ({ allowed: true, remaining: 1, retryAfterSeconds: 0 })),
      } as never;

      let settled = false;
      const pending = submitVolunteerSignup(deps, anonymous).then((r) => {
        settled = true;
        return r;
      });
      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).toBe(false);

      release();
      await expect(pending).resolves.toMatchObject({ humanId: null });
    });

    describe("anonymous timing floor", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it.each([
        ["a NEW address (notify branch)", false],
        ["an EXISTING account (contact-only mail branch)", true],
      ])("returns no sooner than the floor for %s", async (_label, existing) => {
        const { deps } = existing ? existingAccountDeps() : makeDepsWithMocks();
        deps.mailer = { send: vi.fn(async () => ({ result: { success: true } })) } as never;
        deps.rateLimit = {
          consume: vi.fn(async () => ({ allowed: true, remaining: 1, retryAfterSeconds: 0 })),
        } as never;
        deps.anonymousSubmitFloorMs = ANONYMOUS_SUBMIT_FLOOR_MS;

        let settled = false;
        const pending = submitVolunteerSignup(deps, anonymous).then(() => {
          settled = true;
        });

        await vi.advanceTimersByTimeAsync(ANONYMOUS_SUBMIT_FLOOR_MS - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(settled).toBe(true);
      });

      it("authenticated submits have no floor", async () => {
        const { deps } = makeDepsWithMocks();
        deps.anonymousSubmitFloorMs = ANONYMOUS_SUBMIT_FLOOR_MS;

        await expect(
          submitVolunteerSignup(deps, { ...anonymous, actorHumanId: ACTOR_ID }),
        ).resolves.toBeTruthy();
      });
    });

    it("a throwing logger in the post-commit failure branch cannot fail the submit", async () => {
      const { deps } = existingAccountDeps();
      deps.mailer = null;
      deps.rateLimit = null;
      deps.logger = {
        error: vi.fn(() => {
          throw new Error("logger down");
        }),
        warn: vi.fn(),
        info: vi.fn(),
      } as never;
      deps.reportError = vi.fn(() => {
        throw new Error("reporter down");
      });

      await expect(submitVolunteerSignup(deps, anonymous)).resolves.toMatchObject({
        humanId: null,
      });
    });

    it("reports a failed confirmation without surfacing it", async () => {
      const { deps } = existingAccountDeps();
      const { send } = withMail(deps);
      const boom = new Error("smtp down");
      send.mockRejectedValueOnce(boom);
      const reportError = vi.fn();
      deps.reportError = reportError;

      await expect(submitVolunteerSignup(deps, anonymous)).resolves.toBeTruthy();
      await vi.waitFor(() =>
        expect(reportError).toHaveBeenCalledWith(boom, {
          tags: { useCase: "volunteerContactOnlyMail", reason: "send_failed" },
          extra: { signupId: SIGNUP_ID, askId: expect.any(String), kind: "received" },
        }),
      );
    });
  });

  it("never renames an EXISTING account when a guest signs up with its email (event path)", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.humans as any).ensureGuestHuman.mockResolvedValueOnce({
      humanId: GUEST_HUMAN_ID,
      created: false,
    });

    await submitVolunteerSignup(deps, {
      ...validInput,
      contactName: "Attacker Chosen Name",
      actorHumanId: null,
    });

    expect((txRepos.humans as any).ensureGuestHuman).toHaveBeenCalledWith({
      email: "volunteer@example.com",
    });
    expect((txRepos.humans as any).update).not.toHaveBeenCalled();
  });

  it("does NOT name a new guest after their email when contactName is absent", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await submitVolunteerSignup(deps, {
      eventId: EVENT_ID,
      roleId: ROLE_ID,
      contactEmail: "volunteer@example.com",
    });

    expect((txRepos.humans as any).ensureGuestHuman).toHaveBeenCalledWith({
      email: "volunteer@example.com",
    });
    // The minted shadow stays unnamed — never named after the address.
    // Rosters render the signup's own contactName/contactEmail.
    expect((txRepos.humans as any).update).not.toHaveBeenCalled();
  });

  it("rejects when event not found", async () => {
    const deps = makeDeps({
      events: { getById: vi.fn(async () => null) },
    });

    await expect(submitVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "EVENT_NOT_FOUND" },
    );
  });

  it("rejects when volunteering is disabled", async () => {
    const deps = makeDeps({
      events: {
        getById: vi.fn(async () => ({
          ...baseEvent,
          volunteeringEnabled: false,
        })),
      },
    });

    await expect(submitVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "VOLUNTEERING_DISABLED" },
    );
  });

  it("rejects when role not found", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => null);

    await expect(submitVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "ROLE_NOT_FOUND" },
    );
  });

  it("rejects when role belongs to a different event", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseRole,
      eventId: "other-event-id",
    }));

    await expect(submitVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "ROLE_NOT_FOUND" },
    );
  });

  it("rejects when shift not found", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getShift = vi.fn(async () => null);

    await expect(
      submitVolunteerSignup(deps, { ...validInput, shiftId: SHIFT_ID }),
    ).rejects.toMatchObject({ code: "SHIFT_NOT_FOUND" });
  });

  it("rejects when shift belongs to a different role", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getShift = vi.fn(async () => ({
      ...baseShift,
      roleId: "other-role-id",
    }));

    await expect(
      submitVolunteerSignup(deps, { ...validInput, shiftId: SHIFT_ID }),
    ).rejects.toMatchObject({ code: "SHIFT_NOT_FOUND" });
  });

  it("rejects duplicate signup", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignupByEmail = vi.fn(
      async () => baseSignup,
    );

    await expect(submitVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "ALREADY_SIGNED_UP" },
    );
  });

  it("logs audit entry", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await submitVolunteerSignup(deps, validInput);

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_signup",
        action: "submitted",
      }),
    );
  });

  it("logs 'auto_approved' audit when auto-approved", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseRole,
      autoApprove: true,
    }));

    await submitVolunteerSignup(deps, validInput);

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auto_approved",
      }),
    );
  });

  it("calls notify with variant 'volunteer.signup-received' after success", async () => {
    const { deps, notify } = makeDepsWithMocks();
    await submitVolunteerSignup(deps, validInput);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: ACTOR_ID,
        variant: "volunteer.signup-received",
        scope: { kind: "EVENT", eventId: EVENT_ID },
        idempotencyKey: SIGNUP_ID,
        payload: expect.objectContaining({
          eventId: EVENT_ID,
          roleId: ROLE_ID,
          signupId: SIGNUP_ID,
          status: "PENDING",
          accountCompletionUrl: null,
        }),
      }),
    );
  });

  // The email renders the shift window in this zone; without it a UTC server
  // mailed a 7pm Chicago shift as the next day (prod, 2026-10-13).
  it("sends the event's timezone with the shift window", async () => {
    const { deps, notify, txRepos } = makeDepsWithMocks();
    (txRepos.events as any).getById = vi.fn(async () => ({
      ...baseEvent,
      timezone: "America/Chicago",
    }));

    await submitVolunteerSignup(deps, validInput);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "volunteer.signup-received",
        payload: expect.objectContaining({ timezone: "America/Chicago" }),
      }),
    );
  });

  it("includes accountCompletionUrl when shadow profile is created", async () => {
    const { deps, notify } = makeDepsWithMocks();
    await submitVolunteerSignup(deps, {
      eventId: EVENT_ID,
      roleId: ROLE_ID,
      contactEmail: "volunteer@example.com",
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          accountCompletionUrl: `https://test.local/auth/complete?email=${encodeURIComponent(
            "volunteer@example.com",
          )}&src=volunteer&event=${EVENT_ID}`,
        }),
      }),
    );
  });

  it("does not throw when notify rejects; signup still returned", async () => {
    const { deps, notify, txRepos } = makeDepsWithMocks();
    (notify as any).mockRejectedValueOnce(new Error("mail down"));

    const result = await submitVolunteerSignup(deps, validInput);

    expect(result.id).toBe(SIGNUP_ID);
    // signup was still persisted
    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalled();
  });

  // ── Capacity (Gap 1): submit never blocks; auto-approve degrades ──────────

  it("never blocks submission on a full shift when auto-approve is off", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    // Even if the shift were full, submit must not consult occupancy —
    // the pending pool is the waitlist.
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(async () => 5);

    const result = await submitVolunteerSignup(deps, {
      ...validInput,
      shiftId: SHIFT_ID,
    });

    expect(result.status).toBe("PENDING");
    expect(
      (txRepos.volunteering as any).countAcceptedOccupancy,
    ).not.toHaveBeenCalled();
  });

  it("degrades auto-approve to PENDING when the shift is full", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseRole,
      autoApprove: true,
    }));
    // baseShift capacity is 5; occupancy at capacity ⇒ degrade.
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(async () => 5);

    const result = await submitVolunteerSignup(deps, {
      ...validInput,
      shiftId: SHIFT_ID,
    });

    expect(result.status).toBe("PENDING");
    expect(
      (txRepos.volunteering as any).countAcceptedOccupancy,
    ).toHaveBeenCalledWith({ shiftId: SHIFT_ID });
    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PENDING" }),
    );
    // No EventHuman link until an admin actually approves.
    expect((txRepos.eventHumans as any).attach).not.toHaveBeenCalled();
    // Audited as a plain submission, with a degradation marker.
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "submitted",
        data: expect.objectContaining({
          status: "PENDING",
          autoApproveDegraded: true,
        }),
      }),
    );
  });

  it("keeps auto-approve when the shift has seats left", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseRole,
      autoApprove: true,
    }));
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(async () => 4);

    const result = await submitVolunteerSignup(deps, {
      ...validInput,
      shiftId: SHIFT_ID,
    });

    expect(result.status).toBe("APPROVED");
    expect((txRepos.eventHumans as any).attach).toHaveBeenCalled();
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auto_approved" }),
    );
  });

  it("degrades auto-approve on role capacity when no shift is selected", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseRole,
      autoApprove: true,
    }));
    // baseRole capacity is 10.
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(
      async () => 10,
    );

    const result = await submitVolunteerSignup(deps, validInput);

    expect(result.status).toBe("PENDING");
    expect(
      (txRepos.volunteering as any).countAcceptedOccupancy,
    ).toHaveBeenCalledWith({ roleId: ROLE_ID });
    expect((txRepos.eventHumans as any).attach).not.toHaveBeenCalled();
  });

  it("skips the occupancy check entirely when capacity is null", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseRole,
      capacity: null,
      autoApprove: true,
    }));

    const result = await submitVolunteerSignup(deps, validInput);

    expect(result.status).toBe("APPROVED");
    expect(
      (txRepos.volunteering as any).countAcceptedOccupancy,
    ).not.toHaveBeenCalled();
  });

  // ── Waiver gate (Gap 3) ────────────────────────────────────────────────────

  describe("waiver gate (Gap 3)", () => {
    const WAIVER_BODY = "I, the undersigned volunteer, assume all risk.";
    // sha256 of WAIVER_BODY — the snapshot the acceptance row must carry.
    const WAIVER_BODY_SHA256 = createHash("sha256")
      .update(WAIVER_BODY)
      .digest("hex");

    const waiverTemplate = {
      id: WAIVER_TEMPLATE_ID,
      orgId: ORG_ID,
      humanId: null,
      name: "Volunteer Waiver",
      body: WAIVER_BODY,
      version: 3,
      isDefault: false,
      createdAt: NOW,
      updatedAt: NOW,
    };

    /** Event with the flag on and a waiver assigned. */
    const gatedEvent = {
      ...baseEvent,
      volunteerWaiverRequired: true,
      waiverTemplateId: WAIVER_TEMPLATE_ID,
    };

    function makeGatedDeps(txOverrides: Record<string, unknown> = {}) {
      const { deps, txRepos } = makeDepsWithMocks({
        events: { getById: vi.fn(async () => gatedEvent) },
        waiverTemplates: { getById: vi.fn(async () => waiverTemplate) },
        ...txOverrides,
      });
      return { deps, txRepos };
    }

    it("rejects with waiver_required when no acceptance is on file and waiverAccepted is absent — signup not created", async () => {
      const { deps, txRepos } = makeGatedDeps();

      await expect(
        submitVolunteerSignup(deps, validInput),
      ).rejects.toMatchObject({ code: "WAIVER_REQUIRED" });

      expect((txRepos.volunteering as any).createSignup).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteerWaiverAcceptances as any).create,
      ).not.toHaveBeenCalled();
    });

    it("rejects with waiver_required when waiverAccepted is explicitly false", async () => {
      const { deps } = makeGatedDeps();

      await expect(
        submitVolunteerSignup(deps, { ...validInput, waiverAccepted: false }),
      ).rejects.toMatchObject({ code: "WAIVER_REQUIRED" });
    });

    it("creates the signup AND the acceptance row in the same tx, snapshotting template/version/hash + ip/ua", async () => {
      const { deps, txRepos } = makeGatedDeps();

      const result = await submitVolunteerSignup(deps, {
        ...validInput,
        waiverAccepted: true,
        ipAddress: "203.0.113.7",
        userAgent: "WaiverTest/1.0",
      });

      expect(result.id).toBe(SIGNUP_ID);
      // Same transaction: exactly one tx() call wraps both writes.
      expect((deps.repos.tx as any).mock.calls.length).toBe(1);
      expect((txRepos.volunteering as any).createSignup).toHaveBeenCalled();
      expect(
        (txRepos.volunteerWaiverAcceptances as any).create,
      ).toHaveBeenCalledWith({
        humanId: ACTOR_ID,
        signupId: SIGNUP_ID,
        waiverTemplateId: WAIVER_TEMPLATE_ID,
        waiverVersion: 3,
        waiverBodyHash: WAIVER_BODY_SHA256,
        ipAddress: "203.0.113.7",
        userAgent: "WaiverTest/1.0",
      });
    });

    it("returning volunteer with a current acceptance on file proceeds without waiverAccepted and writes NO duplicate row", async () => {
      const { deps, txRepos } = makeGatedDeps({
        volunteerWaiverAcceptances: {
          create: vi.fn(),
          findCurrentForHuman: vi.fn(async () => ({
            id: "vwa-existing",
            humanId: ACTOR_ID,
            signupId: "some-older-signup",
            waiverTemplateId: WAIVER_TEMPLATE_ID,
            waiverVersion: 3,
            waiverBodyHash: WAIVER_BODY_SHA256,
            acceptedAt: NOW,
            ipAddress: null,
            userAgent: null,
          })),
        },
      });

      // No waiverAccepted on the input — the on-file acceptance carries.
      const result = await submitVolunteerSignup(deps, validInput);

      expect(result.id).toBe(SIGNUP_ID);
      expect(
        (txRepos.volunteerWaiverAcceptances as any).findCurrentForHuman,
      ).toHaveBeenCalledWith(ACTOR_ID, WAIVER_TEMPLATE_ID, 3);
      expect(
        (txRepos.volunteerWaiverAcceptances as any).create,
      ).not.toHaveBeenCalled();
    });

    it("guest submits never take the on-file skip — email-matched acceptances are not honored", async () => {
      // A guest resolves the Human by email, so honoring an email-matched
      // acceptance would let anyone probe whether an address accepted this
      // waiver, and would attribute the signup to an acceptance the
      // submitter never made. Guests must always tick the box.
      const findCurrentForHuman = vi.fn(async () => ({
        id: "vwa-existing",
        humanId: GUEST_HUMAN_ID,
        signupId: "some-older-signup",
        waiverTemplateId: WAIVER_TEMPLATE_ID,
        waiverVersion: 3,
        waiverBodyHash: WAIVER_BODY_SHA256,
        acceptedAt: NOW,
        ipAddress: null,
        userAgent: null,
      }));
      const { deps, txRepos } = makeGatedDeps({
        volunteerWaiverAcceptances: {
          create: vi.fn(),
          findCurrentForHuman,
        },
      });

      const guestInput = { ...validInput, actorHumanId: undefined };

      await expect(submitVolunteerSignup(deps, guestInput)).rejects.toMatchObject(
        { code: "WAIVER_REQUIRED" },
      );
      // The oracle is closed at the source: no lookup happens for guests.
      expect(findCurrentForHuman).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).createSignup,
      ).not.toHaveBeenCalled();
    });

    it("re-arms the gate when the template version bumps past the on-file acceptance", async () => {
      // The volunteer accepted version 2; the template is now version 3.
      // findCurrentForHuman is version-exact, so it returns null for v3.
      const findCurrentForHuman = vi.fn(
        async (_humanId: string, _templateId: string, version: number) =>
          version === 2
            ? {
                id: "vwa-v2",
                humanId: ACTOR_ID,
                signupId: "older-signup",
                waiverTemplateId: WAIVER_TEMPLATE_ID,
                waiverVersion: 2,
                waiverBodyHash: "old-hash",
                acceptedAt: NOW,
                ipAddress: null,
                userAgent: null,
              }
            : null,
      );
      const { deps, txRepos } = makeGatedDeps({
        volunteerWaiverAcceptances: { create: vi.fn(), findCurrentForHuman },
      });

      await expect(
        submitVolunteerSignup(deps, validInput),
      ).rejects.toMatchObject({ code: "WAIVER_REQUIRED" });

      // The lookup ran against the CURRENT version (3), not the accepted one.
      expect(findCurrentForHuman).toHaveBeenCalledWith(
        ACTOR_ID,
        WAIVER_TEMPLATE_ID,
        3,
      );
      // Re-acceptance clears it.
      const again = await submitVolunteerSignup(deps, {
        ...validInput,
        waiverAccepted: true,
      });
      expect(again.id).toBe(SIGNUP_ID);
      expect(
        (txRepos.volunteerWaiverAcceptances as any).create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ waiverVersion: 3 }),
      );
    });

    it("imposes no gate when the flag is on but NO waiver template is assigned", async () => {
      // Semantics: volunteerWaiverRequired only bites when the event actually
      // has a resolvable waiver — flag-without-template is a no-op gate.
      const { deps, txRepos } = makeDepsWithMocks({
        events: {
          getById: vi.fn(async () => ({
            ...baseEvent,
            volunteerWaiverRequired: true,
            waiverTemplateId: null,
          })),
        },
      });

      const result = await submitVolunteerSignup(deps, validInput);

      expect(result.id).toBe(SIGNUP_ID);
      expect((txRepos.waiverTemplates as any).getById).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteerWaiverAcceptances as any).create,
      ).not.toHaveBeenCalled();
    });

    it("imposes no gate when the assigned template was deleted (resolves to null)", async () => {
      const { deps, txRepos } = makeGatedDeps({
        waiverTemplates: { getById: vi.fn(async () => null) },
      });

      const result = await submitVolunteerSignup(deps, validInput);

      expect(result.id).toBe(SIGNUP_ID);
      expect(
        (txRepos.volunteerWaiverAcceptances as any).findCurrentForHuman,
      ).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteerWaiverAcceptances as any).create,
      ).not.toHaveBeenCalled();
    });

    it("flag off → behavior unchanged: no template lookup, no acceptance write", async () => {
      const { deps, txRepos } = makeDepsWithMocks();

      const result = await submitVolunteerSignup(deps, {
        ...validInput,
        waiverAccepted: true, // even an unsolicited acceptance is ignored
      });

      expect(result.id).toBe(SIGNUP_ID);
      expect((txRepos.waiverTemplates as any).getById).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteerWaiverAcceptances as any).create,
      ).not.toHaveBeenCalled();
    });

    it("audit log carries waiverAccepted: true when a fresh acceptance was recorded", async () => {
      const { deps, txRepos } = makeGatedDeps();

      await submitVolunteerSignup(deps, { ...validInput, waiverAccepted: true });

      expect((txRepos.audit as any).log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ waiverAccepted: true }),
        }),
      );
    });
  });

  // ── Profile carry-over (Gap 3) ─────────────────────────────────────────────

  describe("profile carry-over (Gap 3)", () => {
    it("fills empty Human name/phone from signup contact info (fill-if-null)", async () => {
      const { deps, txRepos } = makeDepsWithMocks({
        humans: {
          getById: vi.fn(async () => ({
            id: ACTOR_ID,
            name: null,
            phone: null,
          })),
          update: vi.fn(async (id: string, updates: any) => ({
            id,
            ...updates,
          })),
          ensureGuestHuman: vi.fn(async () => ({
            humanId: GUEST_HUMAN_ID,
            created: true,
          })),
        },
      });

      await submitVolunteerSignup(deps, {
        ...validInput,
        contactPhone: "+16155550100",
      });

      expect((txRepos.humans as any).update).toHaveBeenCalledWith(ACTOR_ID, {
        name: "Volunteer User",
        phone: "+16155550100",
      });
    });

    it("never overwrites a populated Human profile", async () => {
      const { deps, txRepos } = makeDepsWithMocks({
        humans: {
          getById: vi.fn(async () => ({
            id: ACTOR_ID,
            name: "Existing Name",
            phone: "+16155550999",
          })),
          update: vi.fn(),
          ensureGuestHuman: vi.fn(async () => ({
            humanId: GUEST_HUMAN_ID,
            created: true,
          })),
        },
      });

      await submitVolunteerSignup(deps, {
        ...validInput,
        contactPhone: "+16155550100",
      });

      expect((txRepos.humans as any).update).not.toHaveBeenCalled();
    });

    it("patches only the missing field when the other is already set", async () => {
      const { deps, txRepos } = makeDepsWithMocks({
        humans: {
          getById: vi.fn(async () => ({
            id: ACTOR_ID,
            name: "Existing Name",
            phone: null,
          })),
          update: vi.fn(),
          ensureGuestHuman: vi.fn(async () => ({
            humanId: GUEST_HUMAN_ID,
            created: true,
          })),
        },
      });

      await submitVolunteerSignup(deps, {
        ...validInput,
        contactPhone: "+16155550100",
      });

      expect((txRepos.humans as any).update).toHaveBeenCalledWith(ACTOR_ID, {
        phone: "+16155550100",
      });
    });

    it("skips the profile read entirely when no contact name/phone was captured", async () => {
      const { deps, txRepos } = makeDepsWithMocks();

      await submitVolunteerSignup(deps, {
        eventId: EVENT_ID,
        roleId: ROLE_ID,
        actorHumanId: ACTOR_ID,
        contactEmail: "volunteer@example.com",
      });

      expect((txRepos.humans as any).getById).not.toHaveBeenCalled();
      expect((txRepos.humans as any).update).not.toHaveBeenCalled();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// reviewVolunteerSignup
// ══════════════════════════════════════════════════════════════════════════════

describe("reviewVolunteerSignup", () => {
  const approveInput = {
    actorHumanId: REVIEWER_ID,
    signupId: SIGNUP_ID,
    decision: "APPROVED" as const,
  };

  const rejectInput = {
    actorHumanId: REVIEWER_ID,
    signupId: SIGNUP_ID,
    decision: "REJECTED" as const,
    notes: "Not qualified",
  };

  it("approves a pending signup", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await reviewVolunteerSignup(deps, approveInput);

    expect(result.status).toBe("APPROVED");
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).toHaveBeenCalledWith(
      SIGNUP_ID,
      expect.objectContaining({
        status: "APPROVED",
        reviewerHumanId: REVIEWER_ID,
      }),
    );
  });

  it.each([
    ["APPROVED", "approved"],
    ["REJECTED", "declined"],
  ] as const)(
    "tells a contact-only signup (no Human) the %s decision by fixed-copy direct email",
    async (decision, word) => {
      const { deps, txRepos, notify } = makeDepsWithMocks();
      (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
        ...baseSignup,
        humanId: null,
      }));
      (txRepos.volunteering as any).updateSignupStatus = vi.fn(
        async (id: string, input: any) => ({
          ...baseSignup,
          ...input,
          humanId: null,
          id,
          updatedAt: NOW,
        }),
      );
      const send = vi.fn(async () => ({ result: { success: true } }));
      deps.mailer = { send } as never;
      deps.rateLimit = {
        consume: vi.fn(async () => ({ allowed: true, remaining: 2, retryAfterSeconds: 0 })),
      } as never;

      await reviewVolunteerSignup(deps, {
        ...approveInput,
        decision,
        ...(decision === "REJECTED" ? { notes: "Organiser-written note" } : {}),
      });

      expect(notify).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
      const mail = (send.mock.calls[0] as unknown as [any])[0];
      expect(mail.to).toEqual({ to: baseSignup.contactEmail });
      expect(mail.text).toContain(`was ${word}`);
      // Fixed copy: the organiser's note is never relayed to the address.
      expect(mail.text).not.toContain("Organiser-written note");
    },
  );

  it("creates EventHuman link on approval", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await reviewVolunteerSignup(deps, approveInput);

    expect((txRepos.eventHumans as any).attach).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        humanId: ACTOR_ID,
        role: "VOLUNTEER",
      }),
    );
  });

  it("rejects a pending signup", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const result = await reviewVolunteerSignup(deps, rejectInput);

    expect(result.status).toBe("REJECTED");
  });

  it("does not create EventHuman on rejection", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    await reviewVolunteerSignup(deps, rejectInput);

    expect((txRepos.eventHumans as any).attach).not.toHaveBeenCalled();
  });

  it("rejects when signup not found", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => null);

    await expect(
      reviewVolunteerSignup(deps, approveInput),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_FOUND" });
  });

  it("rejects when signup is not PENDING", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "APPROVED",
    }));

    await expect(
      reviewVolunteerSignup(deps, approveInput),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_REVIEWABLE" });
  });

  it("rejects when actor lacks EDIT role", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    await expect(
      reviewVolunteerSignup(deps, approveInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  // Pins the RBAC-before-status ordering: a foreign-org probe must not be
  // able to distinguish a reviewed signup (conflict) from a pending one
  // (forbidden). Both now uniformly yield `insufficient_org_role`.
  it("yields insufficient_org_role (not signup_not_reviewable) for a non-PENDING signup in a foreign org", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
      volunteering: {
        ...(makeTxRepos().volunteering as Record<string, unknown>),
        getSignup: vi.fn(async () => ({ ...baseSignup, status: "APPROVED" })),
      },
    });

    await expect(
      reviewVolunteerSignup(deps, approveInput),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  // The reorder must not change behavior for legit admins: an authorized
  // actor reviewing an already-reviewed signup still gets the conflict.
  it("authorized actor still gets signup_not_reviewable for a non-PENDING signup", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "REJECTED",
    }));

    await expect(
      reviewVolunteerSignup(deps, approveInput),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_REVIEWABLE" });
    // RBAC ran (and passed) before the status check threw.
    expect((txRepos.authz as any).getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: REVIEWER_ID,
    });
  });

  // Ban that sticks (owner ruling 2026-10-08): no NEW volunteer joins a
  // withheld owner's event; rejecting keeps working ("Nobody gets silence").
  describe("withheld event owner", () => {
    const withheldEvent = () =>
      vi.fn(async () => ({ ...baseEvent, ownerBanned: true }));

    it("refuses approval with VOLUNTEER_APPROVALS_PAUSED — no capacity read, no write, no audit, no notify", async () => {
      const { deps, txRepos, notify } = makeDepsWithMocks();
      (txRepos.events as any).getById = withheldEvent();

      const err = await reviewVolunteerSignup(deps, approveInput).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toMatchObject({
        code: "VOLUNTEER_APPROVALS_PAUSED",
        message: "VOLUNTEER_APPROVALS_PAUSED",
      });
      expect((err as { meta?: unknown }).meta).toBeUndefined();
      // The owner standing is read with the event, the same derived rule
      // as `ensureEventOpenToPublic`.
      expect((txRepos.events as any).getById).toHaveBeenCalledWith(EVENT_ID, {
        withOwnerStanding: true,
      });
      expect(
        (txRepos.volunteering as any).countAcceptedOccupancy,
      ).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).updateSignupStatus,
      ).not.toHaveBeenCalled();
      expect((txRepos.eventHumans as any).attach).not.toHaveBeenCalled();
      expect((txRepos.audit as any).log).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it("still lets the organiser reject, with the usual audit and notice", async () => {
      const { deps, txRepos, notify } = makeDepsWithMocks();
      (txRepos.events as any).getById = withheldEvent();

      const result = await reviewVolunteerSignup(deps, rejectInput);

      expect(result.status).toBe("REJECTED");
      expect((txRepos.audit as any).log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "rejected" }),
      );
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "volunteer.signup-rejected" }),
      );
    });

    it("a foreign actor still gets INSUFFICIENT_ROLE, never the paused code", async () => {
      const deps = makeDeps({
        events: { getById: withheldEvent() },
        authz: { getOrgMembership: vi.fn(async () => null) },
      });

      await expect(
        reviewVolunteerSignup(deps, approveInput),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    });

    it("an already-reviewed signup still gets SIGNUP_NOT_REVIEWABLE first", async () => {
      const { deps, txRepos } = makeDepsWithMocks();
      (txRepos.events as any).getById = withheldEvent();
      (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
        ...baseSignup,
        status: "APPROVED",
      }));

      await expect(
        reviewVolunteerSignup(deps, approveInput),
      ).rejects.toMatchObject({ code: "SIGNUP_NOT_REVIEWABLE" });
    });
  });

  it("sends the event's timezone with the approved shift window", async () => {
    const { deps, notify, txRepos } = makeDepsWithMocks();
    (txRepos.events as any).getById = vi.fn(async () => ({
      ...baseEvent,
      timezone: "America/Chicago",
    }));

    await reviewVolunteerSignup(deps, approveInput);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "volunteer.signup-approved",
        payload: expect.objectContaining({ timezone: "America/Chicago" }),
      }),
    );
  });

  it("calls notify with 'volunteer.signup-approved' on APPROVED", async () => {
    const { deps, notify } = makeDepsWithMocks();
    await reviewVolunteerSignup(deps, approveInput);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: ACTOR_ID,
        variant: "volunteer.signup-approved",
        scope: { kind: "EVENT", eventId: EVENT_ID },
        idempotencyKey: `${SIGNUP_ID}:APPROVED`,
        payload: expect.objectContaining({
          eventId: EVENT_ID,
          roleId: ROLE_ID,
          signupId: SIGNUP_ID,
          reviewerName: "Reviewer Name",
          destinationUrl:
            "https://test.local/events/org/us/austin/the-show--ab12cd",
        }),
      }),
    );
  });

  it("calls notify with 'volunteer.signup-rejected' on REJECTED", async () => {
    const { deps, notify } = makeDepsWithMocks();
    await reviewVolunteerSignup(deps, rejectInput);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: ACTOR_ID,
        variant: "volunteer.signup-rejected",
        idempotencyKey: `${SIGNUP_ID}:REJECTED`,
        payload: expect.objectContaining({
          signupId: SIGNUP_ID,
          rejectionNote: "Not qualified",
          reviewerName: "Reviewer Name",
        }),
      }),
    );
  });

  it("does not throw when notify rejects during review", async () => {
    const { deps, notify } = makeDepsWithMocks();
    (notify as any).mockRejectedValueOnce(new Error("mail down"));

    const result = await reviewVolunteerSignup(deps, approveInput);
    expect(result.status).toBe("APPROVED");
  });

  it("reports a swallowed notify failure via reportError (Sentry convention)", async () => {
    const { deps, notify } = makeDepsWithMocks();
    const reportError = vi.fn();
    deps.reportError = reportError;
    const boom = new Error("mail down");
    (notify as any).mockRejectedValueOnce(boom);

    const result = await reviewVolunteerSignup(deps, approveInput);
    expect(result.status).toBe("APPROVED");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: { useCase: "reviewVolunteerSignup", stage: "notify" },
      }),
    );
  });

  it("a THROWING reporter never breaks the review flow", async () => {
    const { deps, notify } = makeDepsWithMocks();
    deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    (notify as any).mockRejectedValueOnce(new Error("mail down"));

    const result = await reviewVolunteerSignup(deps, approveInput);
    expect(result.status).toBe("APPROVED");
  });

  it("does not call reportError when notify succeeds", async () => {
    const { deps } = makeDepsWithMocks();
    const reportError = vi.fn();
    deps.reportError = reportError;

    await reviewVolunteerSignup(deps, approveInput);
    expect(reportError).not.toHaveBeenCalled();
  });

  // ── Capacity (Gap 1): approve-path enforcement ─────────────────────────────
  //
  // A true concurrent-approve race can't be exercised in this mock harness
  // (no real DB). Instead we assert the occupancy check runs on the same tx
  // repo object, inside the same `repos.tx` callback, as the status update —
  // and rely on the adapter's `SELECT … FOR UPDATE` row lock to serialize
  // concurrent approvals in production.

  it("approves a shifted signup at capacity − 1", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      shiftId: SHIFT_ID,
    }));
    // baseShift capacity is 5.
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(async () => 4);

    const result = await reviewVolunteerSignup(deps, approveInput);

    expect(result.status).toBe("APPROVED");
    expect(
      (txRepos.volunteering as any).countAcceptedOccupancy,
    ).toHaveBeenCalledWith({ shiftId: SHIFT_ID });
  });

  it("throws shift_full when the shift is at capacity", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      shiftId: SHIFT_ID,
    }));
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(async () => 5);

    await expect(
      reviewVolunteerSignup(deps, approveInput),
    ).rejects.toMatchObject({ code: "SHIFT_FULL" });
    // The signup must stay PENDING and no EventHuman link is created.
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).not.toHaveBeenCalled();
    expect((txRepos.eventHumans as any).attach).not.toHaveBeenCalled();
  });

  it("throws role_full when an unshifted signup hits role capacity", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    // baseSignup has shiftId: null; baseRole capacity is 10.
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(
      async () => 10,
    );

    await expect(
      reviewVolunteerSignup(deps, approveInput),
    ).rejects.toMatchObject({ code: "ROLE_FULL" });
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).not.toHaveBeenCalled();
  });

  it("approves an unshifted signup below role capacity, counting by roleId", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(async () => 9);

    const result = await reviewVolunteerSignup(deps, approveInput);

    expect(result.status).toBe("APPROVED");
    expect(
      (txRepos.volunteering as any).countAcceptedOccupancy,
    ).toHaveBeenCalledWith({ roleId: ROLE_ID });
  });

  it("treats null shift capacity as unlimited — no occupancy query, no role fallback", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      shiftId: SHIFT_ID,
    }));
    (txRepos.volunteering as any).getShift = vi.fn(async () => ({
      ...baseShift,
      capacity: null,
    }));
    // Role capacity (10) would be "full" — but role capacity must NOT
    // apply to shifted signups, so this never gets consulted.
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(
      async () => 99,
    );

    const result = await reviewVolunteerSignup(deps, approveInput);

    expect(result.status).toBe("APPROVED");
    expect(
      (txRepos.volunteering as any).countAcceptedOccupancy,
    ).not.toHaveBeenCalled();
  });

  it("treats null role capacity as unlimited for unshifted signups", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseRole,
      capacity: null,
    }));
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(
      async () => 99,
    );

    const result = await reviewVolunteerSignup(deps, approveInput);

    expect(result.status).toBe("APPROVED");
    expect(
      (txRepos.volunteering as any).countAcceptedOccupancy,
    ).not.toHaveBeenCalled();
  });

  it("rejection performs no capacity interaction even when full", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(
      async () => 99,
    );

    const result = await reviewVolunteerSignup(deps, rejectInput);

    expect(result.status).toBe("REJECTED");
    expect(
      (txRepos.volunteering as any).countAcceptedOccupancy,
    ).not.toHaveBeenCalled();
  });

  it("runs the occupancy check and status update inside one repos.tx", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      shiftId: SHIFT_ID,
    }));
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(async () => 0);

    await reviewVolunteerSignup(deps, approveInput);

    // Both calls hit the same tx-scoped repo within a single transaction —
    // the FOR UPDATE lock taken by countAcceptedOccupancy therefore covers
    // the status update until commit.
    expect((deps.repos as any).tx).toHaveBeenCalledTimes(1);
    expect(
      (txRepos.volunteering as any).countAcceptedOccupancy,
    ).toHaveBeenCalledTimes(1);
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// reviewVolunteerSignupsBatch
// ══════════════════════════════════════════════════════════════════════════════

describe("reviewVolunteerSignupsBatch", () => {
  const batchApproveInput = {
    actorHumanId: REVIEWER_ID,
    signupIds: [SIGNUP_ID, SIGNUP_ID_2, SIGNUP_ID_3],
    decision: "APPROVED" as const,
  };

  it("approves a batch of 3 pending signups", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks();

    const { results } = await reviewVolunteerSignupsBatch(
      deps,
      batchApproveInput,
    );

    expect(results).toEqual([
      { id: SIGNUP_ID, ok: true },
      { id: SIGNUP_ID_2, ok: true },
      { id: SIGNUP_ID_3, ok: true },
    ]);
    const updateStatus = (txRepos.volunteering as any)
      .updateSignupStatus as ReturnType<typeof vi.fn>;
    expect(updateStatus).toHaveBeenCalledTimes(3);
    expect(updateStatus.mock.calls.map((c) => c[0])).toEqual([
      SIGNUP_ID,
      SIGNUP_ID_2,
      SIGNUP_ID_3,
    ]);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("continues past a full shift — mixed per-id results", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      shiftId: SHIFT_ID,
    }));
    // baseShift capacity is 5. First approve fits (4), the approval bumps
    // occupancy to 5 so the second hits the cap, the third fits again
    // (e.g. a withdrawal freed a seat between checks).
    (txRepos.volunteering as any).countAcceptedOccupancy = vi
      .fn()
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(4);

    const { results } = await reviewVolunteerSignupsBatch(
      deps,
      batchApproveInput,
    );

    expect(results).toEqual([
      { id: SIGNUP_ID, ok: true },
      { id: SIGNUP_ID_2, ok: false, code: "SHIFT_FULL" },
      { id: SIGNUP_ID_3, ok: true },
    ]);
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("surfaces signup_not_reviewable for a non-PENDING signup", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi
      .fn()
      .mockResolvedValueOnce(baseSignup)
      .mockResolvedValueOnce({ ...baseSignup, status: "REJECTED" });

    const { results } = await reviewVolunteerSignupsBatch(deps, {
      ...batchApproveInput,
      signupIds: [SIGNUP_ID, SIGNUP_ID_2],
    });

    expect(results).toEqual([
      { id: SIGNUP_ID, ok: true },
      { id: SIGNUP_ID_2, ok: false, code: "SIGNUP_NOT_REVIEWABLE" },
    ]);
  });

  it("surfaces signup_not_found for a missing signup", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi
      .fn()
      .mockResolvedValueOnce(baseSignup)
      .mockResolvedValueOnce(null);

    const { results } = await reviewVolunteerSignupsBatch(deps, {
      ...batchApproveInput,
      signupIds: [SIGNUP_ID, SIGNUP_ID_2],
    });

    expect(results).toEqual([
      { id: SIGNUP_ID, ok: true },
      { id: SIGNUP_ID_2, ok: false, code: "SIGNUP_NOT_FOUND" },
    ]);
  });

  it("surfaces VOLUNTEER_APPROVALS_PAUSED per id on a withheld owner's event, and still rejects", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.events as any).getById = vi.fn(async () => ({
      ...baseEvent,
      ownerBanned: true,
    }));

    const approved = await reviewVolunteerSignupsBatch(deps, {
      ...batchApproveInput,
      signupIds: [SIGNUP_ID, SIGNUP_ID_2],
    });
    // The typed code reaches the client per id, so the web copy can render.
    expect(approved.results).toEqual([
      { id: SIGNUP_ID, ok: false, code: "VOLUNTEER_APPROVALS_PAUSED" },
      { id: SIGNUP_ID_2, ok: false, code: "VOLUNTEER_APPROVALS_PAUSED" },
    ]);
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).not.toHaveBeenCalled();

    const rejected = await reviewVolunteerSignupsBatch(deps, {
      actorHumanId: REVIEWER_ID,
      signupIds: [SIGNUP_ID, SIGNUP_ID_2],
      decision: "REJECTED" as const,
    });
    expect(rejected.results).toEqual([
      { id: SIGNUP_ID, ok: true },
      { id: SIGNUP_ID_2, ok: true },
    ]);
  });

  it("applies the shared notes to every rejection", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks();

    const { results } = await reviewVolunteerSignupsBatch(deps, {
      actorHumanId: REVIEWER_ID,
      signupIds: [SIGNUP_ID, SIGNUP_ID_2],
      decision: "REJECTED" as const,
      notes: "Role was cancelled",
    });

    expect(results.every((r) => r.ok)).toBe(true);
    const updateStatus = (txRepos.volunteering as any)
      .updateSignupStatus as ReturnType<typeof vi.fn>;
    expect(updateStatus).toHaveBeenCalledTimes(2);
    for (const call of updateStatus.mock.calls) {
      expect(call[1]).toMatchObject({
        status: "REJECTED",
        notes: "Role was cancelled",
      });
    }
    expect(notify).toHaveBeenCalledTimes(2);
    for (const call of (notify as any).mock.calls) {
      expect(call[0]).toMatchObject({
        variant: "volunteer.signup-rejected",
        payload: expect.objectContaining({
          rejectionNote: "Role was cancelled",
        }),
      });
    }
  });

  it("does not dedupe — a duplicate id's second pass is not_reviewable", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    // First pass flips the signup out of PENDING; the second read sees it.
    (txRepos.volunteering as any).getSignup = vi
      .fn()
      .mockResolvedValueOnce(baseSignup)
      .mockResolvedValueOnce({ ...baseSignup, status: "APPROVED" });

    const { results } = await reviewVolunteerSignupsBatch(deps, {
      ...batchApproveInput,
      signupIds: [SIGNUP_ID, SIGNUP_ID],
    });

    expect(results).toEqual([
      { id: SIGNUP_ID, ok: true },
      { id: SIGNUP_ID, ok: false, code: "SIGNUP_NOT_REVIEWABLE" },
    ]);
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).toHaveBeenCalledTimes(1);
  });

  it("RBAC runs per signup — forbidden actor gets per-id results, not a throw", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    const { results } = await reviewVolunteerSignupsBatch(deps, {
      ...batchApproveInput,
      signupIds: [SIGNUP_ID, SIGNUP_ID_2],
    });

    expect(results).toEqual([
      { id: SIGNUP_ID, ok: false, code: "INSUFFICIENT_ROLE" },
      { id: SIGNUP_ID_2, ok: false, code: "INSUFFICIENT_ROLE" },
    ]);
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).not.toHaveBeenCalled();
  });

  it("collapses unexpected errors to internal_error without leaking details", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).updateSignupStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused: 10.0.0.5"))
      .mockImplementation(async (id: string, input: any) => ({
        ...baseSignup,
        ...input,
        id,
        updatedAt: NOW,
      }));

    const { results } = await reviewVolunteerSignupsBatch(deps, {
      ...batchApproveInput,
      signupIds: [SIGNUP_ID, SIGNUP_ID_2],
    });

    expect(results).toEqual([
      { id: SIGNUP_ID, ok: false, code: "internal_error" },
      { id: SIGNUP_ID_2, ok: true },
    ]);
  });

  it("yields per-id insufficient_org_role for non-PENDING foreign-org signups (status oracle closed)", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    // One already-reviewed, one pending — a foreign actor must not be able
    // to tell them apart through the batch results.
    (txRepos.volunteering as any).getSignup = vi
      .fn()
      .mockResolvedValueOnce({ ...baseSignup, status: "APPROVED" })
      .mockResolvedValueOnce(baseSignup);

    const { results } = await reviewVolunteerSignupsBatch(deps, {
      ...batchApproveInput,
      signupIds: [SIGNUP_ID, SIGNUP_ID_2],
    });

    expect(results).toEqual([
      { id: SIGNUP_ID, ok: false, code: "INSUFFICIENT_ROLE" },
      { id: SIGNUP_ID_2, ok: false, code: "INSUFFICIENT_ROLE" },
    ]);
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).not.toHaveBeenCalled();
  });

  it("collapses a structured non-Error throw with an unknown code to internal_error", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const errorLog = vi.fn();
    (deps as any).logger = { error: errorLog };
    // Structured port-style error — NOT a use-case `{ code, message }`:
    // its code is outside the canonical allowlist, so its message (raw
    // infra detail) must never reach the per-id result.
    (txRepos.volunteering as any).updateSignupStatus = vi
      .fn()
      .mockRejectedValueOnce({
        code: "redis_down",
        message: "ECONNREFUSED 10.0.0.5",
      })
      .mockImplementation(async (id: string, input: any) => ({
        ...baseSignup,
        ...input,
        id,
        updatedAt: NOW,
      }));

    const { results } = await reviewVolunteerSignupsBatch(deps, {
      ...batchApproveInput,
      signupIds: [SIGNUP_ID, SIGNUP_ID_2],
    });

    expect(results).toEqual([
      { id: SIGNUP_ID, ok: false, code: "internal_error" },
      { id: SIGNUP_ID_2, ok: true },
    ]);
    // The raw infra message must not appear anywhere client-visible.
    expect(JSON.stringify(results)).not.toContain("ECONNREFUSED");
    // ...but the failure IS logged server-side.
    expect(errorLog).toHaveBeenCalledWith(
      "volunteering.reviewVolunteerSignupsBatch.item_failed",
      expect.objectContaining({ signupId: SIGNUP_ID }),
    );
  });

  it("rejects an empty signupIds array at parse time", async () => {
    const { deps } = makeDepsWithMocks();

    await expect(
      reviewVolunteerSignupsBatch(deps, {
        ...batchApproveInput,
        signupIds: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// checkInVolunteer
// ══════════════════════════════════════════════════════════════════════════════

describe("checkInVolunteer", () => {
  const validInput = {
    actorHumanId: REVIEWER_ID,
    signupId: SIGNUP_ID,
  };

  it("checks in an approved volunteer", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "APPROVED",
    }));

    const result = await checkInVolunteer(deps, validInput);
    expect(result.status).toBe("CHECKED_IN");
  });

  it("is idempotent when already checked in", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    const checkedIn = {
      ...baseSignup,
      status: "CHECKED_IN" as const,
      checkedInAt: NOW,
    };
    (txRepos.volunteering as any).getSignup = vi.fn(async () => checkedIn);

    const result = await checkInVolunteer(deps, validInput);
    expect(result.status).toBe("CHECKED_IN");
    // Should NOT call updateSignupStatus
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).not.toHaveBeenCalled();
  });

  it("rejects when signup is PENDING", async () => {
    const deps = makeDeps(); // baseSignup is PENDING

    await expect(checkInVolunteer(deps, validInput)).rejects.toMatchObject({ code: "SIGNUP_NOT_APPROVED" });
  });

  it("rejects when signup not found", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => null);

    await expect(checkInVolunteer(deps, validInput)).rejects.toMatchObject({ code: "SIGNUP_NOT_FOUND" });
  });

  it("rejects an unauthorized actor before revealing CHECKED_IN state (PII/oracle guard)", async () => {
    // Signup ids circulate in volunteer-facing manage URLs; the idempotent
    // CHECKED_IN early-return must never hand the record (contact details)
    // to an actor without scanner access. Pins the RBAC-before-status order.
    const { deps, txRepos } = makeDepsWithMocks({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "CHECKED_IN" as const,
      checkedInAt: NOW,
    }));

    await expect(checkInVolunteer(deps, validInput)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).not.toHaveBeenCalled();
  });

  it("allows a platform admin without org membership via the override path", async () => {
    const { deps, txRepos } = makeDepsWithMocks({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    deps.authz = {
      hasStaffRole: vi.fn(async () => ({ allowed: true })),
    } as unknown as typeof deps.authz;
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "APPROVED",
    }));

    const result = await checkInVolunteer(deps, validInput);
    expect(result.status).toBe("CHECKED_IN");
    const auditLog = (txRepos.audit as any).log as ReturnType<typeof vi.fn>;
    const overrideCall = auditLog.mock.calls.find(
      (call) =>
        (call[0] as { action?: string })?.action ===
        "checked_in.platform_admin_override",
    );
    expect(overrideCall).toBeDefined();
  });

  it("includes scannerDeviceId in the audit log entry when provided", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "APPROVED",
    }));
    const SCANNER_DEVICE_ID = "00000000-0000-4000-8000-000000000777";

    await checkInVolunteer(deps, {
      ...validInput,
      scannerDeviceId: SCANNER_DEVICE_ID,
    });

    const auditLog = (txRepos.audit as any).log as ReturnType<typeof vi.fn>;
    expect(auditLog).toHaveBeenCalled();
    const auditCall = auditLog.mock.calls.find((call) => {
      const entry = call[0] as { action?: string };
      return entry?.action === "checked_in";
    });
    expect(auditCall).toBeDefined();
    const auditEntry = auditCall![0] as { data: Record<string, unknown> };
    expect(auditEntry.data).toMatchObject({
      scannerDeviceId: SCANNER_DEVICE_ID,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// withdrawVolunteerSignup
// ══════════════════════════════════════════════════════════════════════════════

describe("withdrawVolunteerSignup", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    signupId: SIGNUP_ID,
  };

  it("withdraws a PENDING signup", async () => {
    const deps = makeDeps();
    const result = await withdrawVolunteerSignup(deps, validInput);

    expect(result.status).toBe("WITHDRAWN");
  });

  it("withdraws an APPROVED signup and removes EventHuman", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "APPROVED",
    }));
    (txRepos.eventHumans as any).listByEvent = vi.fn(async () => [
      { id: "eh-1", humanId: ACTOR_ID, role: "VOLUNTEER" },
    ]);

    await withdrawVolunteerSignup(deps, validInput);

    expect((txRepos.eventHumans as any).detach).toHaveBeenCalledWith("eh-1");
  });

  // ── occurrence-claim cascade (generic-volunteer-shifts-occurrences FR-003) ──

  it("auto-withdraws the signup's FUTURE occurrence claims in the same tx and audits the count", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).withdrawFutureClaimsBySignup = vi.fn(
      async () => 3,
    );

    const result = await withdrawVolunteerSignup(deps, validInput);

    expect(result.status).toBe("WITHDRAWN");
    expect(
      (txRepos.volunteering as any).withdrawFutureClaimsBySignup,
    ).toHaveBeenCalledWith(SIGNUP_ID, NOW);
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "withdrawn",
        data: expect.objectContaining({ withdrawnClaimCount: 3 }),
      }),
    );
  });

  it("omits the cascade count from the audit when no claims were flipped", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await withdrawVolunteerSignup(deps, validInput);

    expect(
      (txRepos.volunteering as any).withdrawFutureClaimsBySignup,
    ).toHaveBeenCalledWith(SIGNUP_ID, NOW);
    const auditData = (txRepos.audit as any).log.mock.calls.find(
      ([entry]: any[]) => entry.action === "withdrawn",
    )![0].data;
    expect(auditData).not.toHaveProperty("withdrawnClaimCount");
  });

  // ── spot-opened notification (Gap 9) ──────────────────────────────────

  const ADMIN_ID_1 = "00000000-0000-4000-8000-000000000070";
  const ADMIN_ID_2 = "00000000-0000-4000-8000-000000000071";

  const adminRoster = [
    { humanId: ADMIN_ID_1, name: "Owner", email: "o@x.com", role: "OWNER" },
    { humanId: ADMIN_ID_2, name: "Admin", email: "a@x.com", role: "ADMIN" },
    { humanId: "00000000-0000-4000-8000-000000000072", name: "Viewer", email: "v@x.com", role: "VIEWER" },
  ];

  it("notifies each org admin once when an approved shift withdrawal leaves pending applicants", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "APPROVED",
      shiftId: SHIFT_ID,
    }));
    (txRepos.volunteering as any).countPendingSignups = vi.fn(async () => 2);
    (txRepos.eventHumans as any).listByEvent = vi.fn(async () => [
      { id: "eh-1", humanId: ACTOR_ID, role: "VOLUNTEER" },
    ]);
    (txRepos.organizations as any).listMembers = vi.fn(async () => ({
      items: adminRoster,
      total: adminRoster.length,
    }));

    const result = await withdrawVolunteerSignup(deps, validInput);

    // Existing behavior preserved.
    expect(result.status).toBe("WITHDRAWN");
    expect((txRepos.eventHumans as any).detach).toHaveBeenCalledWith("eh-1");

    // Shift-scoped pending count (signup had a shift).
    expect(
      (txRepos.volunteering as any).countPendingSignups,
    ).toHaveBeenCalledTimes(1);
    expect(
      (txRepos.volunteering as any).countPendingSignups,
    ).toHaveBeenCalledWith({ shiftId: SHIFT_ID });

    // One notify per edit-role member; the VIEWER is excluded.
    expect(notify).toHaveBeenCalledTimes(2);
    const calls = (notify.mock.calls as unknown as any[][]).map((c) => c[0]);
    expect(calls.map((c: any) => c.humanId).sort()).toEqual([
      ADMIN_ID_1,
      ADMIN_ID_2,
    ]);
    for (const call of calls) {
      expect(call.variant).toBe("volunteer.spot-opened");
      expect(call.scope).toEqual({ kind: "EVENT", eventId: EVENT_ID });
      expect(call.idempotencyKey).toBe(
        `${SIGNUP_ID}:spot-opened:${call.humanId}`,
      );
      expect(call.payload).toMatchObject({
        eventId: EVENT_ID,
        eventTitle: "Summer Fest",
        roleId: ROLE_ID,
        roleName: "Security",
        shiftId: SHIFT_ID,
        shiftLabel: "Morning",
        pendingCount: 2,
        withdrawnSignupId: SIGNUP_ID,
        signupsUrl: `https://test.local/admin/summer-org/events/${EVENT_ID}/volunteers`,
      });
    }
  });

  it("sends nothing when the freed spot has zero pending applicants", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "APPROVED",
      shiftId: SHIFT_ID,
    }));
    (txRepos.volunteering as any).countPendingSignups = vi.fn(async () => 0);
    (txRepos.organizations as any).listMembers = vi.fn(async () => ({
      items: adminRoster,
      total: adminRoster.length,
    }));

    const result = await withdrawVolunteerSignup(deps, validInput);

    expect(result.status).toBe("WITHDRAWN");
    expect(notify).not.toHaveBeenCalled();
    expect((txRepos.organizations as any).listMembers).not.toHaveBeenCalled();
  });

  it("sends nothing for a PENDING withdrawal and never counts the waitlist", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks();
    (txRepos.organizations as any).listMembers = vi.fn(async () => ({
      items: adminRoster,
      total: adminRoster.length,
    }));

    const result = await withdrawVolunteerSignup(deps, validInput);

    expect(result.status).toBe("WITHDRAWN");
    expect(notify).not.toHaveBeenCalled();
    expect(
      (txRepos.volunteering as any).countPendingSignups,
    ).not.toHaveBeenCalled();
  });

  it("uses a role-level pending count for shiftless signups", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "APPROVED",
      shiftId: null,
    }));
    (txRepos.volunteering as any).countPendingSignups = vi.fn(async () => 1);
    (txRepos.organizations as any).listMembers = vi.fn(async () => ({
      items: [adminRoster[0]],
      total: 1,
    }));

    await withdrawVolunteerSignup(deps, validInput);

    expect(
      (txRepos.volunteering as any).countPendingSignups,
    ).toHaveBeenCalledTimes(1);
    expect(
      (txRepos.volunteering as any).countPendingSignups,
    ).toHaveBeenCalledWith({ roleId: ROLE_ID });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(
      (notify.mock.calls as unknown as any[][])[0][0].payload,
    ).toMatchObject({
      shiftId: null,
      shiftLabel: null,
      pendingCount: 1,
    });
  });

  it("still succeeds when the spot-opened notify throws (post-commit, error-logged)", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks();
    const logger = { error: vi.fn() };
    (deps as any).logger = logger;
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "APPROVED",
      shiftId: SHIFT_ID,
    }));
    (txRepos.volunteering as any).countPendingSignups = vi.fn(async () => 3);
    (txRepos.organizations as any).listMembers = vi.fn(async () => ({
      items: adminRoster,
      total: adminRoster.length,
    }));
    notify.mockRejectedValue(new Error("smtp down"));

    const result = await withdrawVolunteerSignup(deps, validInput);

    expect(result.status).toBe("WITHDRAWN");
    // Both recipients were attempted; both failures were error-logged.
    expect(notify).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      "volunteering.withdrawVolunteerSignup.spot_opened_notify_failed",
      expect.objectContaining({ signupId: SIGNUP_ID }),
    );
  });

  it("rejects when actor is not the signup owner", async () => {
    const deps = makeDeps();

    await expect(
      withdrawVolunteerSignup(deps, {
        actorHumanId: "00000000-0000-4000-8000-000000000099",
        signupId: SIGNUP_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("rejects when signup is already WITHDRAWN", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "WITHDRAWN",
    }));

    await expect(
      withdrawVolunteerSignup(deps, validInput),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_WITHDRAWABLE" });
  });

  it("rejects when signup is REJECTED", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...baseSignup,
      status: "REJECTED",
    }));

    await expect(
      withdrawVolunteerSignup(deps, validInput),
    ).rejects.toMatchObject({ code: "SIGNUP_NOT_WITHDRAWABLE" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// listMyVolunteerSignups
// ══════════════════════════════════════════════════════════════════════════════

describe("listMyVolunteerSignups", () => {
  it("returns signups for the human", async () => {
    const deps = makeDeps();
    const result = await listMyVolunteerSignups(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: SIGNUP_ID });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// listVolunteerSignups (admin)
// ══════════════════════════════════════════════════════════════════════════════

describe("listVolunteerSignups", () => {
  const validInput = {
    actorHumanId: REVIEWER_ID,
    eventId: EVENT_ID,
  };

  it("returns paginated signups", async () => {
    const deps = makeDeps();
    const result = await listVolunteerSignups(deps, validInput);

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("rejects when actor lacks EDIT role", async () => {
    const deps = makeDeps({
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    });

    await expect(listVolunteerSignups(deps, validInput)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// A4 — generic-ask lifecycle (submit/review/check-in/withdraw)
// ══════════════════════════════════════════════════════════════════════════════

const pageWithTotal = (total: number) => ({
  items: [] as VolunteerSignupRecord[],
  pageInfo: {
    total,
    count: 0,
    limit: 1,
    offset: 0,
    hasNextPage: false,
    nextOffset: null,
  },
});

describe("submitVolunteerSignup — subject validation", () => {
  it("rejects when both eventId and askId are provided", async () => {
    const deps = makeDeps();
    await expect(
      submitVolunteerSignup(deps, {
        eventId: EVENT_ID,
        askId: ASK_ID,
        roleId: ROLE_ID,
        contactEmail: "volunteer@example.com",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects when neither eventId nor askId is provided", async () => {
    const deps = makeDeps();
    await expect(
      submitVolunteerSignup(deps, {
        roleId: ROLE_ID,
        contactEmail: "volunteer@example.com",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects shiftId on the ask path", async () => {
    const deps = makeDeps();
    await expect(
      submitVolunteerSignup(deps, {
        askId: ASK_ID,
        roleId: ASK_ROLE_ID,
        shiftId: SHIFT_ID,
        contactEmail: "volunteer@example.com",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("submitVolunteerSignup — event-path askId stamping", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    roleId: ROLE_ID,
    contactEmail: "volunteer@example.com",
  };

  it("stamps the backfilled EVENT ask's id on new event signups", async () => {
    const { deps, txRepos } = makeDepsWithMocks();

    await submitVolunteerSignup(deps, validInput);

    expect(
      (txRepos.volunteering as any).listAsksBySubject,
    ).toHaveBeenCalledWith("EVENT", EVENT_ID);
    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, askId: EVENT_ASK_ID }),
    );
    // Existing ask — no lazy create.
    expect(
      (txRepos.volunteering as any).createAskIfAbsent,
    ).not.toHaveBeenCalled();
  });

  it("lazily creates the EVENT ask when the event has none", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).listAsksBySubject = vi
      .fn()
      .mockResolvedValueOnce([]) // nothing yet
      .mockResolvedValueOnce([baseEventAsk]); // re-read after insert

    await submitVolunteerSignup(deps, validInput);

    expect(
      (txRepos.volunteering as any).createAskIfAbsent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "EVENT",
        subjectId: EVENT_ID,
        orgId: ORG_ID,
        status: "OPEN",
        smsOptInEnabled: true,
      }),
    );
    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({ askId: EVENT_ASK_ID }),
    );
  });

  it("recovers from an EVENT-ask insert race by re-reading the winner (insert no-ops, tx stays healthy)", async () => {
    const { deps, txRepos } = makeDepsWithMocks();
    (txRepos.volunteering as any).listAsksBySubject = vi
      .fn()
      .mockResolvedValueOnce([]) // nothing yet
      .mockResolvedValueOnce([baseEventAsk]); // the race winner's row
    // ON CONFLICT DO NOTHING: the race loser's insert resolves without
    // throwing — no P2002, no aborted transaction.
    (txRepos.volunteering as any).createAskIfAbsent = vi.fn(
      async () => undefined,
    );

    const result = await submitVolunteerSignup(deps, validInput);

    expect(result.id).toBe(SIGNUP_ID);
    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({ askId: EVENT_ASK_ID }),
    );
  });
});

describe("submitVolunteerSignup — ask path", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    askId: ASK_ID,
    roleId: ASK_ROLE_ID,
    contactEmail: "volunteer@example.com",
    contactName: "Volunteer User",
  };

  function makeAskDeps(txOverrides: Record<string, unknown> = {}) {
    const { deps, txRepos, notify } = makeDepsWithMocks(txOverrides);
    (txRepos.volunteering as any).getAsk = vi.fn(async () => baseAsk);
    (txRepos.volunteering as any).getEventRole = vi.fn(
      async () => baseAskRole,
    );
    (txRepos.volunteering as any).createSignup = vi.fn(
      async (input: any) => ({
        ...baseAskSignup,
        ...input,
        id: ASK_SIGNUP_ID,
        groupId: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    return { deps, txRepos, notify };
  }

  // Ban that sticks: a withheld owner's ask answers exactly like a missing
  // one, before any signup write.
  describe("withheld ask owner", () => {
    it("an ORG ask whose owner is withheld reads as missing", async () => {
      const { deps, txRepos } = makeAskDeps();
      (txRepos.bans as any).findBannedOwners = vi.fn(async () => ({
        humanIds: [],
        orgIds: [ORG_ID],
      }));

      await expect(
        submitVolunteerSignup(deps, validInput),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
      expect((txRepos.volunteering as any).createSignup).not.toHaveBeenCalled();
    });

    it("an EVENT ask whose event's owner is withheld reads as missing (ask-owned role)", async () => {
      const { deps, txRepos } = makeAskDeps();
      (txRepos.volunteering as any).getAsk = vi.fn(async () => baseEventAsk);
      (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
        ...baseAskRole,
        askId: EVENT_ASK_ID,
        autoApprove: true,
      }));
      (txRepos.events as any).getById = vi.fn(async () => ({
        ...baseEvent,
        ownerBanned: true,
      }));

      await expect(
        submitVolunteerSignup(deps, { ...validInput, askId: EVENT_ASK_ID }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
      expect((txRepos.events as any).getById).toHaveBeenCalledWith(EVENT_ID, {
        withOwnerStanding: true,
      });
      expect((txRepos.volunteering as any).createSignup).not.toHaveBeenCalled();
    });

    it("an EVENT ask whose event's owner is in good standing takes the signup", async () => {
      const { deps, txRepos } = makeAskDeps();
      (txRepos.volunteering as any).getAsk = vi.fn(async () => baseEventAsk);
      (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
        ...baseAskRole,
        askId: EVENT_ASK_ID,
      }));

      await submitVolunteerSignup(deps, { ...validInput, askId: EVENT_ASK_ID });

      expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
        expect.objectContaining({ askId: EVENT_ASK_ID, roleId: ASK_ROLE_ID }),
      );
    });
  });

  it("creates a PENDING ask signup with askId and no eventId", async () => {
    const { deps, txRepos } = makeAskDeps();

    const result = await submitVolunteerSignup(deps, validInput);

    expect(result.status).toBe("PENDING");
    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({
        askId: ASK_ID,
        roleId: ASK_ROLE_ID,
        shiftId: null,
        status: "PENDING",
      }),
    );
    const createInput = (txRepos.volunteering as any).createSignup.mock
      .calls[0][0];
    expect(createInput.eventId).toBeUndefined();
    // No EventHuman on the ask path.
    expect((txRepos.eventHumans as any).attach).not.toHaveBeenCalled();
  });

  /**
   * An existing signup that has EVOLVED server-side since submission —
   * exactly the fields an idempotent replay must never echo to anyone but
   * the authenticated owner.
   */
  const evolvedAskSignup = {
    ...baseAskSignup,
    status: "APPROVED" as const,
    contactPhone: "+15559876543",
    answers: { availability: "weekends" },
    notes: "Great with crowds — fast-track",
    reviewerHumanId: REVIEWER_ID,
    reviewedAt: NOW,
    hoursWorked: 12,
    groupId: GROUP_ID,
  };

  it("idempotent replay (unauthenticated): minimal echo of the caller's input — no dup, no notify, no server-evolved fields", async () => {
    const { deps, txRepos, notify } = makeAskDeps();
    (txRepos.volunteering as any).getSignupByEmail = vi.fn(
      async () => evolvedAskSignup,
    );
    const { actorHumanId: _actor, ...guestInput } = validInput;

    const result = await submitVolunteerSignup(deps, guestInput);

    // Idempotency preserved: same row, no duplicate, no re-notification.
    expect(result.id).toBe(ASK_SIGNUP_ID);
    expect(
      (txRepos.volunteering as any).getSignupByEmail,
    ).toHaveBeenCalledWith({
      askId: ASK_ID,
      roleId: ASK_ROLE_ID,
      contactEmail: "volunteer@example.com",
    });
    expect((txRepos.volunteering as any).createSignup).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    // Caller-echo fields reflect THIS request, never the stored record.
    expect(result).toMatchObject({
      askId: ASK_ID,
      roleId: ASK_ROLE_ID,
      eventId: null,
      contactEmail: "volunteer@example.com",
      contactName: "Volunteer User",
      contactPhone: null,
      answers: {},
      smsOptIn: false,
    });
    // Server-evolved state is scrubbed to fresh-submit defaults.
    expect(result.status).toBe("PENDING");
    expect(result.notes).toBeNull();
    expect(result.reviewerHumanId).toBeNull();
    expect(result.reviewedAt).toBeNull();
    expect(result.groupId).toBeNull();
    expect(result.hoursWorked).toBeNull();
    expect(result.checkedInAt).toBeNull();
    // Email→account linkage is withheld from non-owners.
    expect(result.humanId).toBeNull();
  });

  it("idempotent replay (authenticated owner): full record — it's their own signup", async () => {
    const { deps, txRepos, notify } = makeAskDeps();
    (txRepos.volunteering as any).getSignupByEmail = vi.fn(
      async () => evolvedAskSignup,
    );

    // validInput's actorHumanId === evolvedAskSignup.humanId (ACTOR_ID).
    const result = await submitVolunteerSignup(deps, validInput);

    expect(result).toEqual({ ...evolvedAskSignup, smsMayNeedStart: false });
    expect((txRepos.volunteering as any).createSignup).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("idempotent replay (authenticated NON-owner): minimal echo, same as unauthenticated", async () => {
    const { deps, txRepos, notify } = makeAskDeps();
    (txRepos.volunteering as any).getSignupByEmail = vi.fn(
      async () => evolvedAskSignup,
    );

    const result = await submitVolunteerSignup(deps, {
      ...validInput,
      // Authenticated, but NOT the human who owns the existing signup.
      actorHumanId: REVIEWER_ID,
    });

    expect(result.id).toBe(ASK_SIGNUP_ID);
    expect(result.status).toBe("PENDING");
    expect(result.humanId).toBeNull();
    expect(result.notes).toBeNull();
    expect(result.reviewerHumanId).toBeNull();
    expect(result.groupId).toBeNull();
    expect(result.hoursWorked).toBeNull();
    expect(result.contactPhone).toBeNull(); // not the stored +15559876543
    expect(result.answers).toEqual({});
    expect((txRepos.volunteering as any).createSignup).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("idempotent replay (shadow-stored signup + authenticated caller): sanitized echo, never the full record", async () => {
    const { deps, txRepos, notify } = makeAskDeps();
    // The stored signup belongs to a shadow profile (humanId: null) — an
    // authenticated caller can never "own" it, so the owner fast-path
    // (humanId === actorHumanId) must not fire and the full record must
    // never echo.
    (txRepos.volunteering as any).getSignupByEmail = vi.fn(async () => ({
      ...evolvedAskSignup,
      humanId: null,
    }));

    const result = await submitVolunteerSignup(deps, validInput);

    expect(result.id).toBe(ASK_SIGNUP_ID);
    expect((txRepos.volunteering as any).createSignup).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    // Sanitized: server-evolved state scrubbed, stored PII withheld.
    expect(result.status).toBe("PENDING");
    expect(result.humanId).toBeNull();
    expect(result.notes).toBeNull();
    expect(result.reviewerHumanId).toBeNull();
    expect(result.groupId).toBeNull();
    expect(result.hoursWorked).toBeNull();
    expect(result.contactPhone).toBeNull(); // not the stored +15559876543
    expect(result.answers).toEqual({});
  });

  it("rejects when the ask is not OPEN", async () => {
    const { deps, txRepos } = makeAskDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
      ...baseAsk,
      status: "PAUSED",
    }));

    await expect(submitVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "CONFLICT", message: "ask_not_open" },
    );
  });

  it("rejects event-owned roles on the ask path", async () => {
    const { deps, txRepos } = makeAskDeps();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseAskRole,
      eventId: EVENT_ID,
    }));

    await expect(submitVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "ROLE_NOT_FOUND" },
    );
  });

  it("rejects roles belonging to a different ask", async () => {
    const { deps, txRepos } = makeAskDeps();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseAskRole,
      askId: EVENT_ASK_ID,
    }));

    await expect(submitVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "ROLE_NOT_FOUND" },
    );
  });

  // ── Ask-level waiver gate (ask-level-volunteer-waivers FR-003/FR-004) ──────
  // The gate arms only when BOTH ask.waiverRequired AND ask.waiverTemplateId
  // are set (a flag-only ask stays inert until a template is assigned), and
  // rides the SAME resolveWaiverGate + acceptance-write path the event flow
  // uses — so this block proves the ask path is wired, not the mechanics.
  const ASK_WAIVER_BODY = "Standing crew waiver — I assume all risk.";
  const ASK_WAIVER_SHA256 = createHash("sha256")
    .update(ASK_WAIVER_BODY)
    .digest("hex");
  const askWaiverTemplate = {
    id: WAIVER_TEMPLATE_ID,
    orgId: ORG_ID,
    humanId: null,
    name: "Standing Crew Waiver",
    body: ASK_WAIVER_BODY,
    version: 2,
    isDefault: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
  /** Ask with the flag on AND a template assigned — the gate is armed. */
  const gatedAsk = {
    ...baseAsk,
    waiverRequired: true,
    waiverTemplateId: WAIVER_TEMPLATE_ID,
  };

  it("gates an armed ask when no acceptance is on file — signup not created", async () => {
    const { deps, txRepos } = makeAskDeps({
      waiverTemplates: { getById: vi.fn(async () => askWaiverTemplate) },
    });
    (txRepos.volunteering as any).getAsk = vi.fn(async () => gatedAsk);

    await expect(submitVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "WAIVER_REQUIRED" },
    );
    expect((txRepos.volunteering as any).createSignup).not.toHaveBeenCalled();
    expect(
      (txRepos.volunteerWaiverAcceptances as any).create,
    ).not.toHaveBeenCalled();
  });

  it("records the acceptance in-tx when the armed ask is accepted", async () => {
    const { deps, txRepos } = makeAskDeps({
      waiverTemplates: { getById: vi.fn(async () => askWaiverTemplate) },
    });
    (txRepos.volunteering as any).getAsk = vi.fn(async () => gatedAsk);

    const result = await submitVolunteerSignup(deps, {
      ...validInput,
      waiverAccepted: true,
    });

    expect(result.status).toBe("PENDING");
    expect(
      (txRepos.volunteerWaiverAcceptances as any).create,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: ACTOR_ID,
        signupId: ASK_SIGNUP_ID,
        waiverTemplateId: WAIVER_TEMPLATE_ID,
        waiverVersion: 2,
        waiverBodyHash: ASK_WAIVER_SHA256,
      }),
    );
  });

  it("skips the acceptance write when one is already on file (version-exact)", async () => {
    const create = vi.fn();
    const findCurrentForHuman = vi.fn(async () => ({
      id: "vwa-existing",
      humanId: ACTOR_ID,
      signupId: "prior-signup",
      waiverTemplateId: WAIVER_TEMPLATE_ID,
      waiverVersion: 2,
      waiverBodyHash: ASK_WAIVER_SHA256,
      acceptedAt: NOW,
      ipAddress: null,
      userAgent: null,
    }));
    const { deps, txRepos } = makeAskDeps({
      waiverTemplates: { getById: vi.fn(async () => askWaiverTemplate) },
      volunteerWaiverAcceptances: { create, findCurrentForHuman },
    });
    (txRepos.volunteering as any).getAsk = vi.fn(async () => gatedAsk);

    const result = await submitVolunteerSignup(deps, validInput);

    expect(result.status).toBe("PENDING");
    expect(create).not.toHaveBeenCalled();
    expect(findCurrentForHuman).toHaveBeenCalledWith(
      ACTOR_ID,
      WAIVER_TEMPLATE_ID,
      2,
    );
  });

  it("stays inert when waiverRequired is set but no template is assigned", async () => {
    const { deps, txRepos } = makeAskDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
      ...baseAsk,
      waiverRequired: true,
      waiverTemplateId: null,
    }));

    const result = await submitVolunteerSignup(deps, validInput);

    expect(result.status).toBe("PENDING");
    expect((txRepos.waiverTemplates as any).getById).not.toHaveBeenCalled();
  });

  it("gates an armed ask for a guest — shadow Human is resolved but no signup/acceptance is written", async () => {
    // A guest's freshly-resolved shadow Human is created inside the tx before
    // the gate runs; when the gate throws the whole tx rolls back, so no
    // signup and no acceptance row survive. The oracle stays closed: no
    // email-matched on-file lookup happens for guests (mirrors the event twin).
    const findCurrentForHuman = vi.fn(async () => null);
    const { deps, txRepos } = makeAskDeps({
      waiverTemplates: { getById: vi.fn(async () => askWaiverTemplate) },
      volunteerWaiverAcceptances: { create: vi.fn(), findCurrentForHuman },
    });
    (txRepos.volunteering as any).getAsk = vi.fn(async () => gatedAsk);

    const guestInput = { ...validInput, actorHumanId: undefined };

    await expect(submitVolunteerSignup(deps, guestInput)).rejects.toMatchObject(
      { code: "WAIVER_REQUIRED" },
    );
    expect((txRepos.humans as any).ensureGuestHuman).toHaveBeenCalled();
    expect(findCurrentForHuman).not.toHaveBeenCalled();
    expect((txRepos.volunteering as any).createSignup).not.toHaveBeenCalled();
    expect(
      (txRepos.volunteerWaiverAcceptances as any).create,
    ).not.toHaveBeenCalled();
  });

  it("ask path: an anonymous signup for an existing account's email is contact-only", async () => {
    const { deps, txRepos, notify } = makeAskDeps();
    (txRepos.humans as any).ensureGuestHuman = vi.fn(async () => ({
      humanId: GUEST_HUMAN_ID,
      created: false,
    }));
    (txRepos.humans as any).getById = vi.fn(async () => ({
      id: GUEST_HUMAN_ID,
      name: null,
      phone: null,
    }));
    (txRepos.humans as any).update = vi.fn();

    const result = await submitVolunteerSignup(deps, {
      ...validInput,
      actorHumanId: undefined,
      contactName: "Stranger",
      contactPhone: "+15555550100",
    });

    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: null }),
    );
    expect((txRepos.humans as any).update).not.toHaveBeenCalled();
    expect(result.humanId).toBeNull();
    // No confirmation to the account (pool fan-out to coordinators may
    // still happen — it names the signup, not the account).
    expect(notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "volunteer.signup-received" }),
    );
  });

  it("never renames an EXISTING account when a guest signs up with its email (ask path)", async () => {
    const { deps, txRepos } = makeAskDeps();
    (txRepos.humans as any).ensureGuestHuman = vi.fn(async () => ({
      humanId: GUEST_HUMAN_ID,
      created: false,
    }));
    (txRepos.humans as any).update = vi.fn();

    await submitVolunteerSignup(deps, {
      ...validInput,
      actorHumanId: undefined,
      contactName: "Attacker Chosen Name",
    });

    expect((txRepos.humans as any).ensureGuestHuman).toHaveBeenCalledWith({
      email: validInput.contactEmail,
    });
    expect((txRepos.humans as any).update).not.toHaveBeenCalled();
  });

  it("auto-approves per ask.autoApprove and degrades to PENDING at role capacity", async () => {
    const { deps, txRepos } = makeAskDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
      ...baseAsk,
      autoApprove: true,
    }));

    const approved = await submitVolunteerSignup(deps, validInput);
    expect(approved.status).toBe("APPROVED");

    // Role at capacity → degrade.
    (txRepos.volunteering as any).getSignupByEmail = vi.fn(async () => null);
    (txRepos.volunteering as any).countAcceptedOccupancy = vi.fn(
      async () => 10,
    );
    const degraded = await submitVolunteerSignup(deps, validInput);
    expect(degraded.status).toBe("PENDING");
  });

  it("degrades auto-approve to PENDING at the ask-level capacity", async () => {
    const { deps, txRepos } = makeAskDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
      ...baseAsk,
      autoApprove: true,
      capacity: 3,
    }));
    (txRepos.volunteering as any).listSignupsByAsk = vi.fn(async () =>
      pageWithTotal(3),
    );

    const result = await submitVolunteerSignup(deps, validInput);
    expect(result.status).toBe("PENDING");
  });

  // volunteer-ask-reminders FR-005 / R5: a ONE_TIME ask with a start is
  // reminded, so the volunteer's tick is kept; the organiser's old switch
  // takes no part.
  const remindableAsk = {
    ...baseAsk,
    cadence: "ONE_TIME" as const,
    startsAt: new Date("2026-08-01T18:00:00.000Z"),
    smsOptInEnabled: false,
  };

  it("a remindable ask stores the tick (as E.164) with the organiser's switch OFF", async () => {
    const { deps, txRepos } = makeAskDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => remindableAsk);

    await submitVolunteerSignup(deps, {
      ...validInput,
      contactPhone: "(615) 555-0100",
      smsOptIn: true,
    });

    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({
        contactPhone: "+16155550100",
        smsOptIn: true,
      }),
    );
  });

  it("a remindable ask refuses a ticked box with a number we do not text", async () => {
    const { deps, txRepos } = makeAskDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => remindableAsk);

    await expect(
      submitVolunteerSignup(deps, {
        ...validInput,
        contactPhone: "+447700900123",
        smsOptIn: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "sms_requires_us_phone",
    });
    expect((txRepos.volunteering as any).createSignup).not.toHaveBeenCalled();
  });

  it.each([
    ["ONGOING, switch on", { cadence: "ONGOING" as const, smsOptInEnabled: true }],
    ["RECURRING", { cadence: "RECURRING" as const }],
    ["ONE_TIME without a start", { startsAt: null }],
  ])(
    "an ask no reminder is sent for (%s): the tick is dropped",
    async (_label, over) => {
      const { deps, txRepos } = makeAskDeps();
      (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
        ...remindableAsk,
        ...over,
      }));

      const result = await submitVolunteerSignup(deps, {
        ...validInput,
        contactPhone: "(615) 555-0100",
        smsOptIn: true,
      });

      expect(result.smsOptIn).toBe(false);
      expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
        expect.objectContaining({
          contactPhone: "(615) 555-0100",
          smsOptIn: false,
        }),
      );
    },
  );

  it.each(["+14165550100", "+447700900123", "12345"])(
    "on an ask with no reminder, a ticked SMS box with %s is not refused (the tick is dropped)",
    async (contactPhone) => {
      const { deps, txRepos } = makeAskDeps();

      await submitVolunteerSignup(deps, {
        ...validInput,
        contactPhone,
        smsOptIn: true,
      });

      expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
        expect.objectContaining({ contactPhone, smsOptIn: false }),
      );
    },
  );

  it("without the SMS opt-in the phone stays free text", async () => {
    const { deps, txRepos } = makeAskDeps();

    await submitVolunteerSignup(deps, {
      ...validInput,
      contactPhone: "+44 7700 900123",
      smsOptIn: false,
    });

    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({
        contactPhone: "+44 7700 900123",
        smsOptIn: false,
      }),
    );
  });

  it("sends the responder confirmation with ask fields and ORG scope", async () => {
    const { deps, notify } = makeAskDeps();

    await submitVolunteerSignup(deps, validInput);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: ACTOR_ID,
        variant: "volunteer.signup-received",
        scope: { kind: "ORG", orgId: ORG_ID },
        payload: expect.objectContaining({
          askId: ASK_ID,
          eventId: null,
          eventTitle: "Standing bar crew",
          roleId: ASK_ROLE_ID,
        }),
      }),
    );
  });

  it("notifies every coordinator of a pool arrival when the ask has groups", async () => {
    const { deps, txRepos, notify } = makeAskDeps();
    (txRepos.volunteering as any).listGroupsByAsk = vi.fn(async () => [
      { ...baseGroup, coordinatorHumanId: COORDINATOR_ID },
      { ...baseGroup, id: OTHER_GROUP_ID, coordinatorHumanId: null },
    ]);

    await submitVolunteerSignup(deps, validInput);

    const poolCalls = (notify as any).mock.calls.filter(
      ([input]: any[]) => input.variant === "volunteer.pool-signup-received",
    );
    expect(poolCalls).toHaveLength(1);
    expect(poolCalls[0][0]).toMatchObject({
      humanId: COORDINATOR_ID,
      payload: expect.objectContaining({
        askId: ASK_ID,
        askTitle: "Standing bar crew",
        signupId: ASK_SIGNUP_ID,
      }),
      idempotencyKey: `${ASK_SIGNUP_ID}:pool-arrival:${COORDINATOR_ID}`,
    });
  });

  // B2 (account squatting through guest checkout): a coordinator seat can
  // be given BY EMAIL to an existing account, so an unverified coordinator
  // may be someone else's. Email still goes; in-app and push only verified.
  describe("pool arrival goes in-app and push only to verified coordinators (B2)", () => {
    const SECOND_COORDINATOR_ID = "00000000-0000-4000-8000-0000000000b2";
    const EMAIL_ONLY = {
      inApp: { enabled: false },
      push: { enabled: false },
      sms: { enabled: false },
    };
    const withTwoCoordinators = () => {
      const made = makeAskDeps();
      (made.txRepos.volunteering as any).listGroupsByAsk = vi.fn(async () => [
        { ...baseGroup, coordinatorHumanId: COORDINATOR_ID },
        {
          ...baseGroup,
          id: OTHER_GROUP_ID,
          coordinatorHumanId: SECOND_COORDINATOR_ID,
        },
      ]);
      const humans = (made.deps.repos as any).humans as {
        listEmailVerifiedIds: ReturnType<typeof vi.fn>;
      };
      const poolCall = (humanId: string) =>
        (made.notify as any).mock.calls
          .map(([input]: any[]) => input)
          .find(
            (input: any) =>
              input.variant === "volunteer.pool-signup-received" &&
              input.humanId === humanId,
          );
      return { ...made, humans, poolCall };
    };

    it("a verified coordinator gets every channel, an unverified one email only", async () => {
      const { deps, humans, poolCall } = withTwoCoordinators();
      humans.listEmailVerifiedIds.mockResolvedValueOnce([COORDINATOR_ID]);

      await submitVolunteerSignup(deps, validInput);

      expect(humans.listEmailVerifiedIds).toHaveBeenCalledWith([
        COORDINATOR_ID,
        SECOND_COORDINATOR_ID,
      ]);
      expect(poolCall(COORDINATOR_ID).channels).toBeUndefined();
      expect(poolCall(SECOND_COORDINATOR_ID).channels).toEqual(EMAIL_ONLY);
    });

    it("a failed lookup sends every coordinator email only, logs ERROR and reports", async () => {
      const { deps, humans, poolCall } = withTwoCoordinators();
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
      const reportError = vi.fn();
      deps.logger = logger as never;
      deps.reportError = reportError;
      humans.listEmailVerifiedIds.mockRejectedValueOnce(new Error("db down"));

      const result = await submitVolunteerSignup(deps, validInput);

      expect(result.id).toBe(ASK_SIGNUP_ID);
      expect(poolCall(COORDINATOR_ID).channels).toEqual(EMAIL_ONLY);
      expect(poolCall(SECOND_COORDINATOR_ID).channels).toEqual(EMAIL_ONLY);
      expect(logger.error).toHaveBeenCalledWith(
        "volunteering.submitVolunteerSignup.pool_arrival_verified_lookup_failed",
        expect.objectContaining({ askId: ASK_ID }),
      );
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            stage: "pool_arrival_verified_lookup",
          }),
        }),
      );
    });
  });

  it("sends no pool arrival when the ask has no groups", async () => {
    const { deps, notify } = makeAskDeps();

    await submitVolunteerSignup(deps, validInput);

    const poolCalls = (notify as any).mock.calls.filter(
      ([input]: any[]) => input.variant === "volunteer.pool-signup-received",
    );
    expect(poolCalls).toHaveLength(0);
  });
});

describe("reviewVolunteerSignup — ask path", () => {
  const pendingAskSignup = { ...baseAskSignup, status: "PENDING" as const };

  function makeAskReviewDeps(txOverrides: Record<string, unknown> = {}) {
    const { deps, txRepos, notify } = makeDepsWithMocks(txOverrides);
    (txRepos.volunteering as any).getSignup = vi.fn(
      async () => pendingAskSignup,
    );
    (txRepos.volunteering as any).getAsk = vi.fn(async () => baseAsk);
    (txRepos.volunteering as any).getEventRole = vi.fn(
      async () => baseAskRole,
    );
    return { deps, txRepos, notify };
  }

  const validInput = {
    actorHumanId: REVIEWER_ID,
    signupId: ASK_SIGNUP_ID,
    decision: "APPROVED" as const,
  };

  it("lets the ask owner approve; no EventHuman; ask-flavored notify", async () => {
    const { deps, txRepos, notify } = makeAskReviewDeps();

    const result = await reviewVolunteerSignup(deps, validInput);

    expect(result.status).toBe("APPROVED");
    expect((txRepos.eventHumans as any).attach).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "volunteer.signup-approved",
        scope: { kind: "ORG", orgId: ORG_ID },
        payload: expect.objectContaining({
          askId: ASK_ID,
          eventId: null,
          eventTitle: "Standing bar crew",
          destinationUrl: `https://test.local/v/${ASK_ID}`,
        }),
      }),
    );
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ askId: ASK_ID, via: "owner" }),
      }),
    );
  });

  it("lets the signup's group coordinator approve (via coordinator)", async () => {
    const { deps, txRepos } = makeAskReviewDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    (txRepos.volunteering as any).getGroup = vi.fn(async () => ({
      ...baseGroup,
      coordinatorHumanId: REVIEWER_ID,
    }));

    const result = await reviewVolunteerSignup(deps, validInput);

    expect(result.status).toBe("APPROVED");
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ via: "coordinator" }),
      }),
    );
  });

  it("forbids a coordinator of group X acting on group Y's signup", async () => {
    const { deps, txRepos } = makeAskReviewDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    // The target signup's group is coordinated by someone else — the actor
    // coordinates a different group on the same ask.
    (txRepos.volunteering as any).getGroup = vi.fn(async () => ({
      ...baseGroup,
      coordinatorHumanId: COORDINATOR_ID,
    }));

    await expect(reviewVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "INSUFFICIENT_ROLE" },
    );
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).not.toHaveBeenCalled();
  });

  it("forbids a coordinator reviewing a pool signup (owner only)", async () => {
    const { deps, txRepos } = makeAskReviewDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...pendingAskSignup,
      groupId: null,
    }));

    await expect(reviewVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "INSUFFICIENT_ROLE" },
    );
    expect((txRepos.volunteering as any).getGroup).not.toHaveBeenCalled();
  });

  it("throws SIGNUP_NOT_FOUND for a signup with neither event nor ask (anti-oracle)", async () => {
    const { deps, txRepos } = makeAskReviewDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...pendingAskSignup,
      askId: null,
    }));

    await expect(reviewVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "SIGNUP_NOT_FOUND" },
    );
  });

  it("enforces the ask-level capacity at accept time (ask_full)", async () => {
    const { deps, txRepos } = makeAskReviewDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
      ...baseAsk,
      capacity: 2,
    }));
    (txRepos.volunteering as any).listSignupsByAsk = vi.fn(async () =>
      pageWithTotal(1),
    );

    await expect(reviewVolunteerSignup(deps, validInput)).rejects.toMatchObject(
      { code: "CONFLICT", message: "ask_full" },
    );
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).not.toHaveBeenCalled();
  });

  it("rejection skips capacity and sends the rejected variant", async () => {
    const { deps, notify } = makeAskReviewDeps();

    const result = await reviewVolunteerSignup(deps, {
      ...validInput,
      decision: "REJECTED",
      notes: "Full up",
    });

    expect(result.status).toBe("REJECTED");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "volunteer.signup-rejected",
        payload: expect.objectContaining({
          askId: ASK_ID,
          rejectionNote: "Full up",
        }),
      }),
    );
  });

  // Ban that sticks (owner ruling 2026-10-08): no NEW volunteer joins a
  // withheld owner's ask; rejecting keeps working ("Nobody gets silence").
  describe("withheld ask owner", () => {
    const withheldOrg = () =>
      vi.fn(async () => ({ humanIds: [], orgIds: [ORG_ID] }));

    it("refuses approval on an ORG ask with VOLUNTEER_APPROVALS_PAUSED — no write, no audit, no notify", async () => {
      const { deps, txRepos, notify } = makeAskReviewDeps();
      (txRepos.bans as any).findBannedOwners = withheldOrg();

      const err = await reviewVolunteerSignup(deps, validInput).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toMatchObject({
        code: "VOLUNTEER_APPROVALS_PAUSED",
        message: "VOLUNTEER_APPROVALS_PAUSED",
      });
      expect((err as { meta?: unknown }).meta).toBeUndefined();
      expect((txRepos.bans as any).findBannedOwners).toHaveBeenCalledWith({
        humanIds: [],
        orgIds: [ORG_ID],
      });
      expect(
        (txRepos.volunteering as any).listSignupsByAsk,
      ).not.toHaveBeenCalled();
      expect(
        (txRepos.volunteering as any).updateSignupStatus,
      ).not.toHaveBeenCalled();
      expect((txRepos.audit as any).log).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it("refuses a coordinator's approval the same way", async () => {
      const { deps, txRepos } = makeAskReviewDeps({
        authz: { getOrgMembership: vi.fn(async () => null) },
      });
      (txRepos.bans as any).findBannedOwners = withheldOrg();
      (txRepos.volunteering as any).getGroup = vi.fn(async () => ({
        ...baseGroup,
        coordinatorHumanId: REVIEWER_ID,
      }));

      await expect(
        reviewVolunteerSignup(deps, validInput),
      ).rejects.toMatchObject({ code: "VOLUNTEER_APPROVALS_PAUSED" });
      expect(
        (txRepos.volunteering as any).updateSignupStatus,
      ).not.toHaveBeenCalled();
    });

    it("still lets the owner reject, with the usual audit and notice", async () => {
      const { deps, txRepos, notify } = makeAskReviewDeps();
      (txRepos.bans as any).findBannedOwners = withheldOrg();

      const result = await reviewVolunteerSignup(deps, {
        ...validInput,
        decision: "REJECTED",
      });

      expect(result.status).toBe("REJECTED");
      expect((txRepos.audit as any).log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "rejected" }),
      );
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "volunteer.signup-rejected" }),
      );
    });

    it("approves as before when the owner is not withheld", async () => {
      const { deps, txRepos } = makeAskReviewDeps();

      const result = await reviewVolunteerSignup(deps, validInput);

      expect(result.status).toBe("APPROVED");
      expect((txRepos.bans as any).findBannedOwners).toHaveBeenCalledTimes(1);
    });

    it("a coordinator of another group gets INSUFFICIENT_ROLE, and the ban is never checked", async () => {
      const { deps, txRepos } = makeAskReviewDeps({
        authz: { getOrgMembership: vi.fn(async () => null) },
      });
      (txRepos.bans as any).findBannedOwners = withheldOrg();
      (txRepos.volunteering as any).getGroup = vi.fn(async () => ({
        ...baseGroup,
        coordinatorHumanId: COORDINATOR_ID,
      }));

      await expect(
        reviewVolunteerSignup(deps, validInput),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect((txRepos.bans as any).findBannedOwners).not.toHaveBeenCalled();
    });

    it("an EVENT-subject ask with an ask-owned role checks the event's owner", async () => {
      const { deps, txRepos } = makeAskReviewDeps();
      (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
        ...pendingAskSignup,
        askId: EVENT_ASK_ID,
      }));
      (txRepos.volunteering as any).getAsk = vi.fn(async () => baseEventAsk);
      (txRepos.events as any).getById = vi.fn(async () => ({
        ...baseEvent,
        ownerBanned: true,
      }));

      await expect(
        reviewVolunteerSignup(deps, validInput),
      ).rejects.toMatchObject({ code: "VOLUNTEER_APPROVALS_PAUSED" });
      expect((txRepos.events as any).getById).toHaveBeenCalledWith(EVENT_ID, {
        withOwnerStanding: true,
      });
      expect(
        (txRepos.volunteering as any).updateSignupStatus,
      ).not.toHaveBeenCalled();
    });

    it("an EVENT-subject ask whose event owner is in good standing approves", async () => {
      const { deps, txRepos } = makeAskReviewDeps();
      (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
        ...pendingAskSignup,
        askId: EVENT_ASK_ID,
      }));
      (txRepos.volunteering as any).getAsk = vi.fn(async () => baseEventAsk);

      const result = await reviewVolunteerSignup(deps, validInput);

      expect(result.status).toBe("APPROVED");
    });
  });
});

describe("checkInVolunteer — ask path", () => {
  const approvedAskSignup = { ...baseAskSignup, status: "APPROVED" as const };

  function makeAskCheckInDeps(txOverrides: Record<string, unknown> = {}) {
    const { deps, txRepos, notify } = makeDepsWithMocks(txOverrides);
    (txRepos.volunteering as any).getSignup = vi.fn(
      async () => approvedAskSignup,
    );
    (txRepos.volunteering as any).getAsk = vi.fn(async () => baseAsk);
    (txRepos.volunteering as any).getEventRole = vi.fn(
      async () => baseAskRole,
    );
    return { deps, txRepos, notify };
  }

  const validInput = {
    actorHumanId: REVIEWER_ID,
    signupId: ASK_SIGNUP_ID,
  };

  it("owner checks in an ask signup; audit carries via + askId", async () => {
    const { deps, txRepos } = makeAskCheckInDeps();

    const result = await checkInVolunteer(deps, validInput);

    expect(result.status).toBe("CHECKED_IN");
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).toHaveBeenCalledWith(ASK_SIGNUP_ID, {
      status: "CHECKED_IN",
      checkedInAt: NOW,
    });
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "checked_in",
        data: expect.objectContaining({ askId: ASK_ID, via: "owner" }),
      }),
    );
  });

  it("coordinator of the signup's group can check in", async () => {
    const { deps, txRepos } = makeAskCheckInDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    (txRepos.volunteering as any).getGroup = vi.fn(async () => ({
      ...baseGroup,
      coordinatorHumanId: REVIEWER_ID,
    }));

    const result = await checkInVolunteer(deps, validInput);
    expect(result.status).toBe("CHECKED_IN");
  });

  it("forbids a cross-group coordinator (forbidden, not 404)", async () => {
    const { deps, txRepos } = makeAskCheckInDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    (txRepos.volunteering as any).getGroup = vi.fn(async () => ({
      ...baseGroup,
      coordinatorHumanId: COORDINATOR_ID,
    }));

    await expect(checkInVolunteer(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("stamps hoursWorked from role.defaultHours for shiftless ask signups", async () => {
    const { deps, txRepos } = makeAskCheckInDeps();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseAskRole,
      defaultHours: 3.5,
    }));

    const result = await checkInVolunteer(deps, validInput);

    expect(
      (txRepos.volunteering as any).updateSignupHoursWorked,
    ).toHaveBeenCalledWith({ id: ASK_SIGNUP_ID, hoursWorked: 3.5 });
    expect(result.hoursWorked).toBe(3.5);
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hoursWorkedFromDefault: 3.5 }),
      }),
    );
  });

  it("preserves explicit hoursWorked — no defaultHours stamping", async () => {
    const { deps, txRepos } = makeAskCheckInDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...approvedAskSignup,
      hoursWorked: 2,
    }));
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseAskRole,
      defaultHours: 3.5,
    }));

    await checkInVolunteer(deps, validInput);

    expect(
      (txRepos.volunteering as any).updateSignupHoursWorked,
    ).not.toHaveBeenCalled();
  });

  it("skips stamping when the role has no defaultHours", async () => {
    const { deps, txRepos } = makeAskCheckInDeps();

    await checkInVolunteer(deps, validInput);

    expect(
      (txRepos.volunteering as any).updateSignupHoursWorked,
    ).not.toHaveBeenCalled();
  });

  it("is idempotent when already CHECKED_IN", async () => {
    const { deps, txRepos } = makeAskCheckInDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...approvedAskSignup,
      status: "CHECKED_IN",
    }));

    const result = await checkInVolunteer(deps, validInput);

    expect(result.status).toBe("CHECKED_IN");
    expect(
      (txRepos.volunteering as any).updateSignupStatus,
    ).not.toHaveBeenCalled();
  });

  it("throws SIGNUP_NOT_FOUND for a signup with neither container", async () => {
    const { deps, txRepos } = makeAskCheckInDeps();
    (txRepos.volunteering as any).getSignup = vi.fn(async () => ({
      ...approvedAskSignup,
      askId: null,
    }));

    await expect(checkInVolunteer(deps, validInput)).rejects.toMatchObject({
      code: "SIGNUP_NOT_FOUND",
    });
  });
});

describe("withdrawVolunteerSignup — ask path", () => {
  const approvedAskSignup = {
    ...baseAskSignup,
    status: "APPROVED" as const,
    humanId: ACTOR_ID,
  };

  it("notifies org edit members when an ask-only APPROVED signup withdraws with waitlist behind", async () => {
    const { deps, txRepos, notify } = makeDepsWithMocks({
      organizations: {
        getById: vi.fn(async () => ({ id: ORG_ID, slug: "org" })),
        listMembers: vi.fn(async () => ({
          items: [
            { humanId: REVIEWER_ID, role: "ADMIN" },
            { humanId: GUEST_HUMAN_ID, role: "VIEWER" },
          ],
          total: 2,
        })),
      },
    });
    (txRepos.volunteering as any).getSignup = vi.fn(
      async () => approvedAskSignup,
    );
    (txRepos.volunteering as any).getAsk = vi.fn(async () => baseAsk);
    (txRepos.volunteering as any).getEventRole = vi.fn(
      async () => baseAskRole,
    );
    (txRepos.volunteering as any).countPendingSignups = vi.fn(async () => 2);

    await withdrawVolunteerSignup(deps, {
      actorHumanId: ACTOR_ID,
      signupId: ASK_SIGNUP_ID,
    });

    // No EventHuman detach on the ask path.
    expect((txRepos.eventHumans as any).listByEvent).not.toHaveBeenCalled();

    const spotCalls = (notify as any).mock.calls.filter(
      ([input]: any[]) => input.variant === "volunteer.spot-opened",
    );
    expect(spotCalls).toHaveLength(1);
    expect(spotCalls[0][0]).toMatchObject({
      humanId: REVIEWER_ID,
      scope: { kind: "ORG", orgId: ORG_ID },
      payload: expect.objectContaining({
        askId: ASK_ID,
        eventId: null,
        eventTitle: "Standing bar crew",
        pendingCount: 2,
      }),
    });
  });

  it("notifies the HUMAN subject when the ask has no org", async () => {
    const humanAsk = {
      ...baseAsk,
      orgId: null,
      subjectType: "HUMAN" as const,
      subjectId: REVIEWER_ID,
    };
    const { deps, txRepos, notify } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(
      async () => approvedAskSignup,
    );
    (txRepos.volunteering as any).getAsk = vi.fn(async () => humanAsk);
    (txRepos.volunteering as any).getEventRole = vi.fn(
      async () => baseAskRole,
    );
    (txRepos.volunteering as any).countPendingSignups = vi.fn(async () => 1);

    await withdrawVolunteerSignup(deps, {
      actorHumanId: ACTOR_ID,
      signupId: ASK_SIGNUP_ID,
    });

    const spotCalls = (notify as any).mock.calls.filter(
      ([input]: any[]) => input.variant === "volunteer.spot-opened",
    );
    expect(spotCalls).toHaveLength(1);
    expect(spotCalls[0][0]).toMatchObject({
      humanId: REVIEWER_ID,
      scope: { kind: "GLOBAL" },
    });
  });

  it("skips the fan-out for PLACE-subject asks without an org (nothing to send)", async () => {
    const placeAsk = {
      ...baseAsk,
      orgId: null,
      subjectType: "PLACE" as const,
    };
    const { deps, txRepos, notify } = makeDepsWithMocks();
    (txRepos.volunteering as any).getSignup = vi.fn(
      async () => approvedAskSignup,
    );
    (txRepos.volunteering as any).getAsk = vi.fn(async () => placeAsk);
    (txRepos.volunteering as any).countPendingSignups = vi.fn(async () => 1);

    const result = await withdrawVolunteerSignup(deps, {
      actorHumanId: ACTOR_ID,
      signupId: ASK_SIGNUP_ID,
    });

    expect(result.status).toBe("WITHDRAWN");
    expect(notify).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SMS consent ledger on submit (owner 2026-10-17: switching it on is consent)
// ══════════════════════════════════════════════════════════════════════════════

describe("submitVolunteerSignup → SMS opt-in rules and consent ledger", () => {
  const PHONE = "+16155550100";
  const STOP_AT = new Date(NOW.getTime() - 60 * 60 * 1000);

  /** Deps whose tx and top-level repos share one in-memory consent ledger. */
  function makeLedgerDeps(
    opts: { ask?: boolean; actorPhone?: string | null; verified?: boolean } = {},
  ) {
    const smsConsent = makeFakeSmsConsentRepo(() => NOW);
    const { deps, txRepos } = makeDepsWithMocks({ smsConsent });
    const getByIdWithIdentity = vi.fn(async () => ({
      human: { id: ACTOR_ID },
      identity: {
        phone: opts.actorPhone === undefined ? PHONE : opts.actorPhone,
        phoneVerified: opts.verified ?? true,
      },
    }));
    (deps.repos as any).smsConsent = smsConsent;
    (deps.repos as any).humans.getByIdWithIdentity = getByIdWithIdentity;
    if (opts.ask) {
      (txRepos.volunteering as any).getAsk = vi.fn(async () => baseAsk);
      (txRepos.volunteering as any).getEventRole = vi.fn(
        async () => baseAskRole,
      );
      (txRepos.volunteering as any).createSignup = vi.fn(
        async (input: any) => ({
          ...baseAskSignup,
          ...input,
          id: ASK_SIGNUP_ID,
          groupId: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
    }
    return { deps, txRepos, smsConsent, getByIdWithIdentity };
  }

  async function seedStop(
    smsConsent: ReturnType<typeof makeFakeSmsConsentRepo>,
  ): Promise<void> {
    await smsConsent.applyDecisionIfNewer({
      phoneE164: PHONE,
      status: "OPTED_OUT",
      eventAt: STOP_AT,
      source: "sns_inbound",
    });
  }

  const eventInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    roleId: ROLE_ID,
    shiftId: SHIFT_ID,
    contactEmail: "volunteer@example.com",
    contactName: "Volunteer User",
  };
  const askInput = {
    actorHumanId: ACTOR_ID,
    askId: ASK_ID,
    roleId: ASK_ROLE_ID,
    contactEmail: "volunteer@example.com",
    contactName: "Volunteer User",
  };

  it("event path with a shift: a national-format US number is stored as E.164", async () => {
    const { deps, txRepos } = makeLedgerDeps();

    await submitVolunteerSignup(deps, {
      ...eventInput,
      contactPhone: "(615) 555-0100",
      smsOptIn: true,
    });

    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({ contactPhone: PHONE, smsOptIn: true }),
    );
  });

  it("event path with a shift: a number we do not text is refused", async () => {
    const { deps, txRepos } = makeLedgerDeps();

    await expect(
      submitVolunteerSignup(deps, {
        ...eventInput,
        contactPhone: "+447700900123",
        smsOptIn: true,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "sms_requires_us_phone",
    });
    expect((txRepos.volunteering as any).createSignup).not.toHaveBeenCalled();
  });

  it("event path, a role WITH shifts but no shift chosen: the tick is dropped (no anchor)", async () => {
    const { deps, txRepos, smsConsent } = makeLedgerDeps();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...baseRole,
      shifts: [{ id: SHIFT_ID }],
    }));
    const { shiftId: _omit, ...noShift } = eventInput;

    const result = await submitVolunteerSignup(deps, {
      ...noShift,
      contactPhone: "(615) 555-0100",
      smsOptIn: true,
    });

    expect(result.smsOptIn).toBe(false);
    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({
        contactPhone: "(615) 555-0100",
        smsOptIn: false,
      }),
    );
    expect(smsConsent.events).toEqual([]);
  });

  it("event path without a shift on a role with no shifts: kept, reminded by the event's start (R7)", async () => {
    const { deps, txRepos } = makeLedgerDeps();
    const { shiftId: _omit, ...noShift } = eventInput;

    const result = await submitVolunteerSignup(deps, {
      ...noShift,
      contactPhone: "(615) 555-0100",
      smsOptIn: true,
    });

    expect(result.smsOptIn).toBe(true);
    expect((txRepos.volunteering as any).createSignup).toHaveBeenCalledWith(
      expect.objectContaining({ contactPhone: PHONE, smsOptIn: true }),
    );
  });

  it("own verified phone on an opted-out number: opted back in, reminder guard allows it", async () => {
    const { deps, smsConsent } = makeLedgerDeps();
    await seedStop(smsConsent);

    const result = await submitVolunteerSignup(deps, {
      ...eventInput,
      contactPhone: "(615) 555-0100",
      smsOptIn: true,
    });

    expect(result).toMatchObject({ smsOptIn: true, smsMayNeedStart: false });
    expect(smsConsent.consents.get(PHONE)).toMatchObject({
      status: "OPTED_IN",
      source: "volunteer_signup",
      actorHumanId: ACTOR_ID,
      optedInAt: NOW,
    });
    expect(
      await ensureSmsDeliverable(
        { repos: deps.repos },
        { phoneNumber: PHONE, category: "VOLUNTEER_REMINDER" },
      ),
    ).toEqual({ deliverable: true, phoneE164: PHONE });
  });

  it("the consent audit row carries actor, source and signup/event context", async () => {
    const { deps, txRepos, smsConsent } = makeLedgerDeps();
    await seedStop(smsConsent);

    await submitVolunteerSignup(deps, {
      ...eventInput,
      contactPhone: PHONE,
      smsOptIn: true,
    });

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "sms_consent",
        action: "sms_consent.opted_in",
        data: expect.objectContaining({
          source: "volunteer_signup",
          actorHumanId: ACTOR_ID,
          context: expect.objectContaining({
            signupId: SIGNUP_ID,
            eventId: EVENT_ID,
          }),
        }),
      }),
    );
  });

  it.each([
    ["has replied STOP", true],
    ["never replied STOP", false],
  ])(
    "a typed number that is not the actor's verified phone (%s): same static hint, ledger never read",
    async (_label, stopped) => {
      const { deps, smsConsent } = makeLedgerDeps({
        actorPhone: "+16155550199",
      });
      if (stopped) await seedStop(smsConsent);
      const getByPhone = vi.spyOn(smsConsent, "getByPhone");

      const result = await submitVolunteerSignup(deps, {
        ...eventInput,
        contactPhone: PHONE,
        smsOptIn: true,
      });

      // Identical either way: the hint is no oracle for a stranger's STOP.
      expect(result).toMatchObject({ smsOptIn: true, smsMayNeedStart: true });
      expect(getByPhone).not.toHaveBeenCalled();
      expect(smsConsent.events.map((e) => e.eventType)).toEqual([]);
      expect(smsConsent.consents.get(PHONE)?.status).toBe(
        stopped ? "OPTED_OUT" : undefined,
      );
    },
  );

  it("the actor's phone on file but NOT verified: ledger untouched, hint set", async () => {
    const { deps, smsConsent } = makeLedgerDeps({ verified: false });
    await seedStop(smsConsent);

    const result = await submitVolunteerSignup(deps, {
      ...eventInput,
      contactPhone: PHONE,
      smsOptIn: true,
    });

    expect(result.smsMayNeedStart).toBe(true);
    expect(smsConsent.consents.get(PHONE)?.status).toBe("OPTED_OUT");
  });

  it("an anonymous submit never touches the ledger and gets the static hint", async () => {
    const { deps, smsConsent, getByIdWithIdentity } = makeLedgerDeps();
    await seedStop(smsConsent);
    const getByPhone = vi.spyOn(smsConsent, "getByPhone");
    const { actorHumanId: _anon, ...anonymous } = eventInput;

    const result = await submitVolunteerSignup(deps, {
      ...anonymous,
      contactPhone: PHONE,
      smsOptIn: true,
    });

    expect(result.smsMayNeedStart).toBe(true);
    expect(getByPhone).not.toHaveBeenCalled();
    expect(getByIdWithIdentity).not.toHaveBeenCalled();
    expect(smsConsent.consents.get(PHONE)?.status).toBe("OPTED_OUT");
  });

  it("no SMS opt-in: no ledger read or write", async () => {
    const { deps, smsConsent, getByIdWithIdentity } = makeLedgerDeps();

    const result = await submitVolunteerSignup(deps, {
      ...eventInput,
      contactPhone: PHONE,
      smsOptIn: false,
    });

    expect(result.smsMayNeedStart).toBe(false);
    expect(getByIdWithIdentity).not.toHaveBeenCalled();
    expect(smsConsent.events).toEqual([]);
  });

  it("ask path, remindable ask: the actor's own verified phone is opted back in, as on the event path", async () => {
    const { deps, txRepos, smsConsent } = makeLedgerDeps({ ask: true });
    (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
      ...baseAsk,
      startsAt: new Date("2026-08-01T18:00:00.000Z"),
      smsOptInEnabled: false,
    }));
    await seedStop(smsConsent);

    const result = await submitVolunteerSignup(deps, {
      ...askInput,
      contactPhone: "(615) 555-0100",
      smsOptIn: true,
    });

    expect(result).toMatchObject({ smsOptIn: true, smsMayNeedStart: false });
    expect(smsConsent.consents.get(PHONE)).toMatchObject({
      status: "OPTED_IN",
      source: "volunteer_signup",
      actorHumanId: ACTOR_ID,
      optedInAt: NOW,
    });
  });

  it.each([
    ["a typed number that is not the actor's", { actorPhone: "+16155550199" }],
    ["the actor's own number, not verified", { verified: false }],
  ])(
    "ask path, remindable ask, %s: the static START hint, no ledger read or write",
    async (_label, opts) => {
      const { deps, txRepos, smsConsent } = makeLedgerDeps({
        ask: true,
        ...opts,
      });
      (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
        ...baseAsk,
        startsAt: new Date("2026-08-01T18:00:00.000Z"),
      }));
      await seedStop(smsConsent);
      const getByPhone = vi.spyOn(smsConsent, "getByPhone");

      const result = await submitVolunteerSignup(deps, {
        ...askInput,
        contactPhone: PHONE,
        smsOptIn: true,
      });

      expect(result).toMatchObject({ smsOptIn: true, smsMayNeedStart: true });
      expect(getByPhone).not.toHaveBeenCalled();
      expect(smsConsent.events.map((e) => e.eventType)).toEqual([]);
      expect(smsConsent.consents.get(PHONE)?.status).toBe("OPTED_OUT");
    },
  );

  it("ask path, ask with no reminder: the tick never reaches the ledger, even for a verified phone", async () => {
    // `baseAsk` is ONE_TIME without a start: nothing to remind of.
    const { deps, smsConsent } = makeLedgerDeps({ ask: true });
    await seedStop(smsConsent);

    const result = await submitVolunteerSignup(deps, {
      ...askInput,
      contactPhone: PHONE,
      smsOptIn: true,
    });

    expect(result.smsOptIn).toBe(false);
    expect(smsConsent.consents.get(PHONE)?.status).toBe("OPTED_OUT");
    expect(smsConsent.events).toEqual([]);
  });

  it("a STOP landing between the signup commit and the ledger write wins", async () => {
    const { deps, txRepos, smsConsent, getByIdWithIdentity } = makeLedgerDeps();
    (txRepos.volunteering as any).clearSmsOptInByPhone = vi.fn(async () => 0);
    let now = NOW;
    const clock = { now: () => now };
    getByIdWithIdentity.mockImplementation(async () => {
      now = new Date(NOW.getTime() + 1_000);
      await recordSmsOptOut(
        { repos: deps.repos, clock },
        { phoneNumber: PHONE, source: "sns_inbound", keyword: "STOP" },
      );
      now = new Date(NOW.getTime() + 2_000);
      return {
        human: { id: ACTOR_ID },
        identity: { phone: PHONE, phoneVerified: true },
      } as any;
    });
    const apply = vi.spyOn(smsConsent, "applyDecisionIfNewer");

    const result = await submitVolunteerSignup(
      { ...deps, clock },
      { ...eventInput, contactPhone: PHONE, smsOptIn: true },
    );

    // The opt-in carries the submit's time, not the later write's.
    expect(apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "OPTED_IN", eventAt: NOW }),
    );
    expect(smsConsent.consents.get(PHONE)?.status).toBe("OPTED_OUT");
    expect(result.smsMayNeedStart).toBe(true);
  });

  it("a ledger error that echoes the phone is redacted before the log and the report", async () => {
    const { deps, smsConsent } = makeLedgerDeps();
    smsConsent.applyDecisionIfNewer = vi.fn(async () => {
      throw new Error(`Unique constraint failed on phoneE164 "${PHONE}"`);
    });
    const reportError = vi.fn();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      withTime: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);

    await submitVolunteerSignup(
      { ...deps, reportError, logger: logger as never },
      { ...eventInput, contactPhone: PHONE, smsOptIn: true },
    );

    const ledgerReports = reportError.mock.calls.filter(
      ([, ctx]) => (ctx as any)?.tags?.stage === "sms_consent_ledger",
    );
    expect(ledgerReports).toHaveLength(1);
    const reported = ledgerReports[0]![0] as Error;
    expect(reported.message).not.toContain("5550100");
    expect(reported.stack ?? "").not.toContain("5550100");
    for (const fn of [logger.error, logger.warn, logger.info, logger.log]) {
      expect(JSON.stringify(fn.mock.calls)).not.toContain("5550100");
    }
  });

  it("a failed ledger write keeps the signup's smsOptIn, logs and reports it", async () => {
    const { deps, smsConsent } = makeLedgerDeps();
    smsConsent.applyDecisionIfNewer = vi.fn(async () => {
      throw new Error("ledger down");
    });
    const reportError = vi.fn();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      withTime: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);

    const result = await submitVolunteerSignup(
      { ...deps, reportError, logger: logger as never },
      { ...eventInput, contactPhone: PHONE, smsOptIn: true },
    );

    expect(result.smsOptIn).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "volunteering.sms_consent_record_failed",
      expect.objectContaining({ signupId: SIGNUP_ID, source: "volunteer_signup" }),
    );
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        useCase: "submitVolunteerSignup",
        stage: "sms_consent_ledger",
        swallowed: "true",
      },
      extra: { signupId: SIGNUP_ID, source: "volunteer_signup" },
    });
    // The confirmation still went out after the ledger failure.
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });
});
