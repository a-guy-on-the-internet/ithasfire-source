import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";
import * as volunteeringUseCases from "@th/core/use-cases/volunteering";
import { volunteerRouter } from "../volunteer";
import { createCaller } from "./test-helpers";

const createVolunteerCaller = (
  ctxOverrides?: Parameters<typeof createCaller>[1],
) => createCaller(volunteerRouter, ctxOverrides);

const ADMIN_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const ROLE_ID = "44444444-4444-4444-8444-444444444444";

describe("volunteerRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("templates.list", () => {
    it("injects actorHumanId from ctx and forwards deps to the use case", async () => {
      const templates = [
        {
          id: "template-1",
          orgId: ORG_ID,
          name: "Greeter",
          description: null,
          defaultCapacity: null,
          sortOrder: 0,
          isArchived: false,
          createdByHumanId: ADMIN_HUMAN_ID,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ];
      const listSpy = vi
        .spyOn(volunteeringUseCases, "listRoleTemplates")
        .mockResolvedValue(templates as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.templates.list({ orgId: ORG_ID });

      expect(result).toEqual(templates);
      expect(listSpy).toHaveBeenCalledTimes(1);
      const [deps, input] = listSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(deps.clock).toBe(ctx.clock);
      expect(deps.logger).toBeDefined();
      expect(input).toEqual({
        actorHumanId: ADMIN_HUMAN_ID,
        orgId: ORG_ID,
      });
    });
  });

  describe("signups.submit — anonymous abuse limits", () => {
    const submitInput = {
      eventId: EVENT_ID,
      roleId: ROLE_ID,
      contactEmail: "guest@example.com",
    };

    it("is rate limited per client IP (20/hour) before the use case runs", async () => {
      const submitSpy = vi
        .spyOn(volunteeringUseCases, "submitVolunteerSignup")
        .mockResolvedValue({ id: "s" } as any);
      const consume = vi.fn(async (key: string) =>
        key.startsWith("volunteer:signups:submit:ip:")
          ? { allowed: false, remaining: 0, retryAfterSeconds: 900 }
          : { allowed: true, remaining: 100, retryAfterSeconds: 0 },
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        clientIp: "198.51.100.7",
        rateLimit: { consume } as never,
      });

      await expect(caller.signups.submit(submitInput)).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
      });
      expect(consume).toHaveBeenCalledWith(
        "volunteer:signups:submit:ip:198.51.100.7",
        20,
        3600,
      );
      expect(submitSpy).not.toHaveBeenCalled();
    });

    it("passes the mailer and limiter for contact-only confirmation mail", async () => {
      const submitSpy = vi
        .spyOn(volunteeringUseCases, "submitVolunteerSignup")
        .mockResolvedValue({ id: "s" } as any);
      const mailer = { send: vi.fn() };
      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        mailer: mailer as never,
      });

      await caller.signups.submit(submitInput);

      const [deps] = submitSpy.mock.calls[0]!;
      expect(deps.mailer).toBe(mailer);
      expect(deps.rateLimit).toBe(ctx.rateLimit);
    });
  });

  describe("signups.review — contact-only decision mail deps", () => {
    it("passes the mailer (null when unwired) and the limiter", async () => {
      const reviewSpy = vi
        .spyOn(volunteeringUseCases, "reviewVolunteerSignup")
        .mockResolvedValue({ id: "s" } as any);
      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });

      await caller.signups.review({
        signupId: "55555555-5555-4555-8555-555555555555",
        decision: "APPROVED",
      });

      const [deps] = reviewSpy.mock.calls[0]!;
      expect(deps.mailer).toBeNull();
      expect(deps.rateLimit).toBe(ctx.rateLimit);
    });

    it("surfaces VOLUNTEER_APPROVALS_PAUSED as CONFLICT with the bare code", async () => {
      vi.spyOn(volunteeringUseCases, "reviewVolunteerSignup").mockRejectedValue(
        new AppError("VOLUNTEER_APPROVALS_PAUSED"),
      );
      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });

      await expect(
        caller.signups.review({
          signupId: "55555555-5555-4555-8555-555555555555",
          decision: "APPROVED",
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "VOLUNTEER_APPROVALS_PAUSED",
      });
    });
  });

  describe("signups.submit", () => {
    it("forwards ctx.actorHumanId (null when unauth) and notify deps", async () => {
      const signup = {
        id: "signup-1",
        eventId: EVENT_ID,
        roleId: ROLE_ID,
        shiftId: null,
        humanId: "human-guest",
        contactEmail: "guest@example.com",
        contactName: null,
        contactPhone: null,
        status: "PENDING" as const,
        answers: {},
        reviewerHumanId: null,
        reviewedAt: null,
        checkedInAt: null,
        notes: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      const submitSpy = vi
        .spyOn(volunteeringUseCases, "submitVolunteerSignup")
        .mockResolvedValue(signup as any);

      // Unauth: auth middleware resolves actorHumanId = null when auth is null.
      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      const result = await caller.signups.submit({
        eventId: EVENT_ID,
        roleId: ROLE_ID,
        contactEmail: "guest@example.com",
      });

      expect(result).toEqual(signup);
      expect(submitSpy).toHaveBeenCalledTimes(1);
      const [deps, input] = submitSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(deps.clock).toBe(ctx.clock);
      expect(deps.notify).toBe(ctx.notify);
      expect(input).toMatchObject({
        eventId: EVENT_ID,
        roleId: ROLE_ID,
        contactEmail: "guest@example.com",
        actorHumanId: null,
      });
    });

    it("injects ipAddress/userAgent from ctx — never from the client", async () => {
      const submitSpy = vi
        .spyOn(volunteeringUseCases, "submitVolunteerSignup")
        .mockResolvedValue({ id: "signup-1" } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
        clientIp: "198.51.100.10",
        userAgent: "VolunteerTest/1.0",
      });

      await caller.signups.submit({
        eventId: EVENT_ID,
        roleId: ROLE_ID,
        contactEmail: "guest@example.com",
        waiverAccepted: true,
        // Forged values must be rejected by the strict input schema —
        // asserted in the next test; here we just confirm ctx injection.
      });

      const [, input] = submitSpy.mock.calls[0]!;
      expect(input).toMatchObject({
        waiverAccepted: true,
        ipAddress: "198.51.100.10",
        userAgent: "VolunteerTest/1.0",
      });
    });

    it("rejects client-supplied ipAddress/userAgent at the input boundary", async () => {
      const submitSpy = vi
        .spyOn(volunteeringUseCases, "submitVolunteerSignup")
        .mockResolvedValue({ id: "signup-1" } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
        clientIp: "198.51.100.10",
        userAgent: "VolunteerTest/1.0",
      });

      // The submit input schema omits ipAddress/userAgent entirely; tRPC
      // strips unknown keys on non-strict objects, so forged values never
      // reach the use case — ctx wins.
      await caller.signups.submit({
        eventId: EVENT_ID,
        roleId: ROLE_ID,
        contactEmail: "guest@example.com",
        ipAddress: "6.6.6.6",
        userAgent: "Forged/666",
      } as any);

      const [, input] = submitSpy.mock.calls[0]!;
      expect(input).toMatchObject({
        ipAddress: "198.51.100.10",
        userAgent: "VolunteerTest/1.0",
      });
    });

    it("maps `conflict: volunteering_disabled` to a TRPCError", async () => {
      vi.spyOn(volunteeringUseCases, "submitVolunteerSignup").mockRejectedValue(
        {
          code: "conflict",
          message: "volunteering_disabled",
        },
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      await expect(
        caller.signups.submit({
          eventId: EVENT_ID,
          roleId: ROLE_ID,
          contactEmail: "guest@example.com",
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "volunteering_disabled",
      });
    });
  });

  describe("publicRoles.waiver", () => {
    const waiverResult = {
      waiverRequired: true,
      waiver: {
        templateId: "55555555-5555-4555-8555-555555555555",
        version: 2,
        title: "Volunteer Waiver",
        body: "I assume all risk.",
      },
      alreadyAccepted: false,
    };

    it("injects actorHumanId from ctx for signed-in viewers", async () => {
      const waiverSpy = vi
        .spyOn(volunteeringUseCases, "getPublicVolunteerWaiver")
        .mockResolvedValue(waiverResult as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.publicRoles.waiver({ eventId: EVENT_ID });

      expect(result).toEqual(waiverResult);
      const [deps, input] = waiverSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(input).toEqual({
        eventId: EVENT_ID,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("passes actorHumanId: null for guests", async () => {
      const waiverSpy = vi
        .spyOn(volunteeringUseCases, "getPublicVolunteerWaiver")
        .mockResolvedValue({
          waiverRequired: false,
          waiver: null,
          alreadyAccepted: false,
        } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });
      await caller.publicRoles.waiver({ eventId: EVENT_ID });

      const [, input] = waiverSpy.mock.calls[0]!;
      expect(input).toEqual({ eventId: EVENT_ID, actorHumanId: null });
    });

    it("maps the visibility-gate not_found to NOT_FOUND", async () => {
      vi.spyOn(
        volunteeringUseCases,
        "getPublicVolunteerWaiver",
      ).mockRejectedValue({ code: "not_found", message: "event_not_found" });

      const { caller } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      await expect(
        caller.publicRoles.waiver({ eventId: EVENT_ID }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "event_not_found",
      });
    });
  });

  describe("signups.counts", () => {
    const SHIFT_ID = "66666666-6666-4666-8666-666666666666";

    it("returns pending-inclusive maps untouched plus flat accepted-only maps from the accepted helpers", async () => {
      // RBAC + role discovery piggy-backs on list-event-roles — stub it so
      // the reshape loop has one role with one shift.
      vi.spyOn(
        volunteeringUseCases,
        "listEventVolunteerRoles",
      ).mockResolvedValue([
        { id: ROLE_ID, shifts: [{ id: SHIFT_ID }] },
      ] as any);

      // Distinct values per helper so we can prove each output field comes
      // from the right repo method (pending-inclusive vs accepted-only).
      const countByRole = vi.fn(async () => ({ [ROLE_ID]: 5 }));
      const countByShiftForEvent = vi.fn(async () => ({ [SHIFT_ID]: 5 }));
      const countAcceptedByRole = vi.fn(async () => ({ [ROLE_ID]: 3 }));
      const countAcceptedByShiftForEvent = vi.fn(async () => ({
        [SHIFT_ID]: 3,
      }));
      const txVolunteering = {
        countByRole,
        countByShiftForEvent,
        countAcceptedByRole,
        countAcceptedByShiftForEvent,
      };
      const repos = {
        tx: vi.fn(async (fn: (tx: unknown) => unknown) =>
          fn({ volunteering: txVolunteering }),
        ),
      };

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        repos: repos as any,
      });
      const result = await caller.signups.counts({ eventId: EVENT_ID });

      expect(result).toEqual({
        // Pending-inclusive fields keep their existing shape (byShift nested
        // per role) — other consumers depend on them.
        byRole: { [ROLE_ID]: 5 },
        byShift: { [ROLE_ID]: { [SHIFT_ID]: 5 } },
        // Additive accepted-only maps are flat (roleId → n, shiftId → n).
        acceptedByRole: { [ROLE_ID]: 3 },
        acceptedByShift: { [SHIFT_ID]: 3 },
      });
      expect(countByRole).toHaveBeenCalledWith(EVENT_ID);
      expect(countByShiftForEvent).toHaveBeenCalledWith(EVENT_ID);
      expect(countAcceptedByRole).toHaveBeenCalledWith(EVENT_ID);
      expect(countAcceptedByShiftForEvent).toHaveBeenCalledWith(EVENT_ID);
    });
  });

  describe("signups.listMyCommitments", () => {
    const OTHER_HUMAN_ID = "77777777-7777-4777-8777-777777777777";

    it("injects actorHumanId from ctx and passes Dates through untouched", async () => {
      const rows = [
        {
          signupId: "signup-1",
          status: "PENDING",
          source: "EVENT_SHIFT",
          title: "Block Party",
          roleName: "Setup",
          shiftLabel: "Load-in",
          startsAt: new Date("2026-07-01T17:00:00.000Z"),
          endsAt: new Date("2026-07-01T20:00:00.000Z"),
          eventId: EVENT_ID,
          eventSlug: "block-party",
          eventTimezone: "America/Chicago",
          addressText: "123 Test St",
          askId: null,
          hoursWorked: null,
          hoursCredited: 3,
          checkedInAt: null,
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ];
      const listSpy = vi
        .spyOn(volunteeringUseCases, "listMyVolunteerCommitments")
        .mockResolvedValue(rows as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.signups.listMyCommitments();

      // superjson transports real Dates — the router must not stringify.
      expect(result).toEqual(rows);
      expect(result[0]!.startsAt).toBeInstanceOf(Date);
      const [deps, input] = listSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(input).toEqual({ actorHumanId: ADMIN_HUMAN_ID });
    });

    // Ban that sticks (owner ruling 2026-10-08): the page reads the flag
    // straight off this procedure, so it must survive the transport as-is.
    it("passes signupsPaused through per row (true and false), nothing added", async () => {
      const base = {
        status: "APPROVED",
        source: "ASK_WINDOW",
        title: "Door help",
        roleName: "Door",
        shiftLabel: null,
        startsAt: new Date("2026-07-01T17:00:00.000Z"),
        endsAt: new Date("2026-07-01T20:00:00.000Z"),
        eventId: null,
        eventSlug: null,
        eventTimezone: null,
        addressText: null,
        hoursWorked: null,
        hoursCredited: null,
        checkedInAt: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      };
      const rows = [
        { ...base, signupId: "s-paused", askId: "ask-a", signupsPaused: true },
        { ...base, signupId: "s-live", askId: "ask-b", signupsPaused: false },
      ];
      vi.spyOn(
        volunteeringUseCases,
        "listMyVolunteerCommitments",
      ).mockResolvedValue(rows as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.signups.listMyCommitments();

      expect(result).toEqual(rows);
      expect(result.map((r) => r.signupsPaused)).toEqual([true, false]);
    });

    it("ignores a client-supplied human id — the actor always comes from ctx", async () => {
      const listSpy = vi
        .spyOn(volunteeringUseCases, "listMyVolunteerCommitments")
        .mockResolvedValue([] as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await caller.signups.listMyCommitments({
        humanId: OTHER_HUMAN_ID,
      } as never);

      const [, input] = listSpy.mock.calls[0]!;
      expect(input).toEqual({ actorHumanId: ADMIN_HUMAN_ID });
    });

    it("rejects an unauthenticated caller", async () => {
      const listSpy = vi
        .spyOn(volunteeringUseCases, "listMyVolunteerCommitments")
        .mockResolvedValue([] as any);

      const { caller } = createVolunteerCaller({ actorHumanId: null });

      await expect(caller.signups.listMyCommitments()).rejects.toThrow();
      expect(listSpy).not.toHaveBeenCalled();
    });
  });

  describe("hours.orgSummary", () => {
    it("forwards acceptedOnly through the input schema to the use case", async () => {
      const summarySpy = vi
        .spyOn(volunteeringUseCases, "getOrgVolunteerHoursSummary")
        .mockResolvedValue({ orgId: ORG_ID, rows: [] } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await caller.hours.orgSummary({ orgId: ORG_ID, acceptedOnly: true });

      const [, input] = summarySpy.mock.calls[0]!;
      expect(input).toEqual({
        actorHumanId: ADMIN_HUMAN_ID,
        orgId: ORG_ID,
        acceptedOnly: true,
      });
    });
  });

  // ── Generic volunteer asks (generic-volunteering-asks spec) ──────────────

  describe("asks", () => {
    const ASK_ID = "77777777-7777-4777-8777-777777777777";
    const PLACE_ID = "88888888-8888-4888-8888-888888888888";

    it("create injects actorHumanId from ctx and forwards deps", async () => {
      const createSpy = vi
        .spyOn(volunteeringUseCases, "createVolunteerAsk")
        .mockResolvedValue({ askId: ASK_ID } as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.asks.create({
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        title: "Standing door crew",
      });

      expect(result).toEqual({ askId: ASK_ID });
      const [deps, input] = createSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(input).toMatchObject({
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        title: "Standing door crew",
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("listBySubject gates through resolveAskOwnership inside the tx before listing", async () => {
      const ownershipSpy = vi
        .spyOn(volunteeringUseCases, "resolveAskOwnership")
        .mockResolvedValue({
          place: null,
          placeAccess: null,
          event: null,
        } as any);
      const asks = [{ id: ASK_ID, title: "Door crew" }];
      const listAsksBySubject = vi.fn(async () => asks);
      const repos = {
        tx: vi.fn(async (fn: (tx: unknown) => unknown) =>
          fn({ volunteering: { listAsksBySubject } }),
        ),
      };

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        repos: repos as any,
      });
      const result = await caller.asks.listBySubject({
        subjectType: "PLACE",
        subjectId: PLACE_ID,
      });

      expect(result).toEqual(asks);
      expect(ownershipSpy).toHaveBeenCalledWith(
        expect.anything(),
        { subjectType: "PLACE", subjectId: PLACE_ID, orgId: null },
        ADMIN_HUMAN_ID,
      );
      expect(listAsksBySubject).toHaveBeenCalledWith("PLACE", PLACE_ID);
    });

    it("listBySubject maps an ownership denial to FORBIDDEN and never lists", async () => {
      vi.spyOn(volunteeringUseCases, "resolveAskOwnership").mockRejectedValue(
        new AppError("INSUFFICIENT_ROLE"),
      );
      const listAsksBySubject = vi.fn();
      const repos = {
        tx: vi.fn(async (fn: (tx: unknown) => unknown) =>
          fn({ volunteering: { listAsksBySubject } }),
        ),
      };

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        repos: repos as any,
      });
      await expect(
        caller.asks.listBySubject({
          subjectType: "PLACE",
          subjectId: PLACE_ID,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(listAsksBySubject).not.toHaveBeenCalled();
    });

    it("listByOrg gates as an ORG subject and forwards the status filter", async () => {
      const ownershipSpy = vi
        .spyOn(volunteeringUseCases, "resolveAskOwnership")
        .mockResolvedValue({
          place: null,
          placeAccess: null,
          event: null,
        } as any);
      const listAsksByOrg = vi.fn(async () => []);
      const repos = {
        tx: vi.fn(async (fn: (tx: unknown) => unknown) =>
          fn({ volunteering: { listAsksByOrg } }),
        ),
      };

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        repos: repos as any,
      });
      await caller.asks.listByOrg({ orgId: ORG_ID, status: "OPEN" });

      expect(ownershipSpy).toHaveBeenCalledWith(
        expect.anything(),
        { subjectType: "ORG", subjectId: ORG_ID, orgId: ORG_ID },
        ADMIN_HUMAN_ID,
      );
      expect(listAsksByOrg).toHaveBeenCalledWith(ORG_ID, { status: "OPEN" });
    });

    it("update surfaces a domain conflict as CONFLICT with the stable message + meta.reason", async () => {
      // What a client sees for `ask_archived`: TRPC code CONFLICT (409),
      // message "ask_archived", and — through the API errorFormatter —
      // data.meta.reason = "ask_archived" / data.appCode = "CONFLICT".
      vi.spyOn(volunteeringUseCases, "updateVolunteerAsk").mockRejectedValue(
        new AppError("CONFLICT", {
          message: "ask_archived",
          meta: { reason: "ask_archived" },
        }),
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await expect(
        caller.asks.update({ askId: ASK_ID, title: "New title" }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "ask_archived",
        meta: { reason: "ask_archived", appCode: "CONFLICT" },
      });
    });
  });

  describe("schedule (shift occurrences + claims)", () => {
    const OCCURRENCE_ID = "55555555-5555-4555-8555-555555555555";
    const CLAIM_ID = "66666666-6666-4666-8666-666666666666";
    const SIGNUP_ID = "77777777-7777-4777-8777-777777777777";
    const ASK_ID = "88888888-8888-4888-8888-888888888888";

    it("createOccurrence injects actorHumanId + notify/appBaseUrl deps", async () => {
      const createSpy = vi
        .spyOn(volunteeringUseCases, "createShiftOccurrence")
        .mockResolvedValue({ id: OCCURRENCE_ID } as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        publicAppUrl: "https://app.test",
      });

      await caller.schedule.createOccurrence({
        askId: ASK_ID,
        roleId: ROLE_ID,
        startsAt: new Date("2026-07-10T19:00:00.000Z"),
        endsAt: new Date("2026-07-10T23:00:00.000Z"),
      });

      expect(createSpy).toHaveBeenCalledTimes(1);
      const [deps, input] = createSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(deps.notify).toBe(ctx.notify);
      expect(deps.appBaseUrl).toBe("https://app.test");
      expect(input).toMatchObject({
        askId: ASK_ID,
        roleId: ROLE_ID,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("createOccurrence ignores a client-supplied actorHumanId (ctx actor wins)", async () => {
      const createSpy = vi
        .spyOn(volunteeringUseCases, "createShiftOccurrence")
        .mockResolvedValue({ id: OCCURRENCE_ID } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });

      await caller.schedule.createOccurrence({
        askId: ASK_ID,
        roleId: ROLE_ID,
        startsAt: new Date("2026-07-10T19:00:00.000Z"),
        endsAt: new Date("2026-07-10T23:00:00.000Z"),
        // Spoof attempt — the transport schema strips it; the ctx actor is
        // injected AFTER the spread, so it can never win.
        actorHumanId: "99999999-9999-4999-8999-999999999999",
      } as any);

      const [, input] = createSpy.mock.calls[0]!;
      expect((input as any).actorHumanId).toBe(ADMIN_HUMAN_ID);
    });

    it("cancelOccurrence prefers ctx.notifyWithEmail (email leg must send)", async () => {
      const cancelSpy = vi
        .spyOn(volunteeringUseCases, "cancelShiftOccurrence")
        .mockResolvedValue({ id: OCCURRENCE_ID, status: "CANCELLED" } as any);
      const notifyWithEmail = vi.fn(async () => ({ ok: true }));

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        notifyWithEmail: notifyWithEmail as any,
      });

      await caller.schedule.cancelOccurrence({ occurrenceId: OCCURRENCE_ID });

      const [deps] = cancelSpy.mock.calls[0]!;
      expect(deps.notify).toBe(notifyWithEmail);
      expect(deps.notify).not.toBe(ctx.notify);
      // Shadow-claimant leg rides the direct mailer (null when unwired).
      expect(deps.mailer).toBeNull();
      // Unset publicAppUrl must arrive as NULL (never "") so the use case
      // skips the notify leg instead of feeding the strict renderer a
      // non-URL askUrl.
      expect(deps.appBaseUrl).toBeNull();
    });

    it("claim forwards the authenticated actor only", async () => {
      const claimSpy = vi
        .spyOn(volunteeringUseCases, "claimOccurrence")
        .mockResolvedValue({ id: CLAIM_ID } as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });

      const result = await caller.schedule.claim({
        occurrenceId: OCCURRENCE_ID,
      });

      expect(result).toEqual({ id: CLAIM_ID });
      const [deps, input] = claimSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(input).toEqual({
        occurrenceId: OCCURRENCE_ID,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("assign passes ctx.mailer (null when unconfigured) so email stays best-effort", async () => {
      const assignSpy = vi
        .spyOn(volunteeringUseCases, "assignOccurrenceClaim")
        .mockResolvedValue({ id: CLAIM_ID } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        // No mailer override — ctx.mailer is null.
      });

      await caller.schedule.assign({
        occurrenceId: OCCURRENCE_ID,
        signupId: SIGNUP_ID,
      });

      const [deps, input] = assignSpy.mock.calls[0]!;
      expect(deps.mailer).toBeNull();
      expect(input).toEqual({
        occurrenceId: OCCURRENCE_ID,
        signupId: SIGNUP_ID,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("assign surfaces VOLUNTEER_APPROVALS_PAUSED as CONFLICT with the bare code", async () => {
      vi.spyOn(volunteeringUseCases, "assignOccurrenceClaim").mockRejectedValue(
        new AppError("VOLUNTEER_APPROVALS_PAUSED"),
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });

      await expect(
        caller.schedule.assign({
          occurrenceId: OCCURRENCE_ID,
          signupId: SIGNUP_ID,
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "VOLUNTEER_APPROVALS_PAUSED",
      });
    });

    it("checkIn forwards the hours override", async () => {
      const checkInSpy = vi
        .spyOn(volunteeringUseCases, "checkInOccurrenceClaim")
        .mockResolvedValue({ id: CLAIM_ID } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });

      await caller.schedule.checkIn({ claimId: CLAIM_ID, hoursOverride: 2.5 });

      const [, input] = checkInSpy.mock.calls[0]!;
      expect(input).toEqual({
        claimId: CLAIM_ID,
        hoursOverride: 2.5,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("maps a use-case conflict (occurrence_full) to CONFLICT", async () => {
      vi.spyOn(volunteeringUseCases, "claimOccurrence").mockRejectedValue(
        new AppError("CONFLICT", {
          message: "occurrence_full",
          meta: { reason: "occurrence_full" },
        }),
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });

      await expect(
        caller.schedule.claim({ occurrenceId: OCCURRENCE_ID }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("publicAsks.schedule is reachable unauthenticated and forwards the clock", async () => {
      const scheduleSpy = vi
        .spyOn(volunteeringUseCases, "getPublicAskSchedule")
        .mockResolvedValue({ occurrences: [] } as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      const result = await caller.publicAsks.schedule({ askId: ASK_ID });

      expect(result).toEqual({ occurrences: [] });
      const [deps, input] = scheduleSpy.mock.calls[0]!;
      expect(deps.clock).toBe(ctx.clock);
      expect(input).toEqual({ askId: ASK_ID });
    });
  });

  describe("duplicate-name conflicts (volunteer adapter plain-object codes)", () => {
    // The Prisma volunteering adapter maps P2002 unique violations to plain
    // `{ code: "duplicate_*" }` objects which core propagates untouched.
    // Contract: the client sees CONFLICT (409), never a 500.
    const ASK_ID = "77777777-7777-4777-8777-777777777777";

    it("groups.create surfaces the adapter's duplicate_group_name as CONFLICT", async () => {
      vi.spyOn(volunteeringUseCases, "createVolunteerGroup").mockRejectedValue({
        code: "duplicate_group_name",
        message: "duplicate_group_name",
      });

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await expect(
        caller.groups.create({ askId: ASK_ID, name: "Door crew" }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "duplicate_group_name",
      });
    });

    it("askRoles.add surfaces the adapter's duplicate_role_name as CONFLICT", async () => {
      vi.spyOn(volunteeringUseCases, "addVolunteerAskRole").mockRejectedValue({
        code: "duplicate_role_name",
        message: "duplicate_role_name",
      });

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await expect(
        caller.askRoles.add({ askId: ASK_ID, name: "Greeter" }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "duplicate_role_name",
      });
    });
  });

  describe("signups.assignToGroup", () => {
    it("injects actorHumanId and forwards notify deps", async () => {
      const SIGNUP_ID = "99999999-9999-4999-8999-999999999999";
      const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const assignSpy = vi
        .spyOn(volunteeringUseCases, "assignSignupToGroup")
        .mockResolvedValue({ id: SIGNUP_ID, groupId: GROUP_ID } as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await caller.signups.assignToGroup({
        signupId: SIGNUP_ID,
        groupId: GROUP_ID,
      });

      const [deps, input] = assignSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(deps.notify).toBe(ctx.notify);
      expect(input).toEqual({
        signupId: SIGNUP_ID,
        groupId: GROUP_ID,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });
  });

  describe("signups.listByAsk", () => {
    const ASK_ID = "77777777-7777-4777-8777-777777777777";
    const emptyPage = {
      items: [],
      pageInfo: {
        total: 0,
        count: 0,
        limit: 200,
        offset: 0,
        hasNextPage: false,
        nextOffset: null,
      },
    };

    it("owner path: injects the actor and forwards scope + filters + deps", async () => {
      const listSpy = vi
        .spyOn(volunteeringUseCases, "listAskSignups")
        .mockResolvedValue(emptyPage as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.signups.listByAsk({
        askId: ASK_ID,
        scope: { kind: "ALL" },
        status: "PENDING",
        roleId: ROLE_ID,
      });

      expect(result).toEqual(emptyPage);
      const [deps, input] = listSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(deps.clock).toBe(ctx.clock);
      expect(input).toEqual({
        askId: ASK_ID,
        scope: { kind: "ALL" },
        status: "PENDING",
        roleId: ROLE_ID,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("coordinator pool path: forwards the POOL scope untouched", async () => {
      const listSpy = vi
        .spyOn(volunteeringUseCases, "listAskSignups")
        .mockResolvedValue(emptyPage as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await caller.signups.listByAsk({
        askId: ASK_ID,
        scope: { kind: "POOL" },
      });

      const [, input] = listSpy.mock.calls[0]!;
      expect(input).toEqual({
        askId: ASK_ID,
        scope: { kind: "POOL" },
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("coordinator ALL: the use case's ownership denial surfaces as FORBIDDEN", async () => {
      vi.spyOn(volunteeringUseCases, "listAskSignups").mockRejectedValue(
        new AppError("INSUFFICIENT_ROLE"),
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await expect(
        caller.signups.listByAsk({
          askId: ASK_ID,
          scope: { kind: "ALL" },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("roster (cursor pagination)", () => {
    const ASK_ID = "77777777-7777-4777-8777-777777777777";
    const askRosterOutput = {
      ask: { id: ASK_ID },
      roles: [],
      groups: [],
      generalPool: [],
      nextCursor: "2026-07-01T12:00:00.000Z|abc",
    };
    const coordinatorOutput = { groups: [], nextCursor: null };

    it("roster.ask forwards cursor + limit and injects the actor", async () => {
      const rosterSpy = vi
        .spyOn(volunteeringUseCases, "listAskRoster")
        .mockResolvedValue(askRosterOutput as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.roster.ask({
        askId: ASK_ID,
        cursor: "2026-06-30T00:00:00.000Z|prev",
        limit: 25,
      });

      expect(result).toEqual(askRosterOutput);
      const [deps, input] = rosterSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(input).toMatchObject({
        askId: ASK_ID,
        cursor: "2026-06-30T00:00:00.000Z|prev",
        limit: 25,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("roster.ask ACCEPTS the tRPC-injected `direction` and STRIPS it before the use case", async () => {
      // useInfiniteQuery injects a top-level `direction` on every request —
      // the input schema must not 400 on it, and the handler must not
      // forward it into core (the strict use-case parse would reject it).
      const rosterSpy = vi
        .spyOn(volunteeringUseCases, "listAskRoster")
        .mockResolvedValue(askRosterOutput as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await caller.roster.ask({
        askId: ASK_ID,
        direction: "forward",
      } as any);

      const [, input] = rosterSpy.mock.calls[0]!;
      expect(input).not.toHaveProperty("direction");
      expect(input).toMatchObject({
        askId: ASK_ID,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("roster.coordinator forwards cursor + limit and injects the actor", async () => {
      const coordSpy = vi
        .spyOn(volunteeringUseCases, "listCoordinatorRoster")
        .mockResolvedValue(coordinatorOutput as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.roster.coordinator({
        askId: ASK_ID,
        cursor: "group-1|2026-06-30T00:00:00.000Z|prev",
        limit: 10,
      });

      expect(result).toEqual(coordinatorOutput);
      const [, input] = coordSpy.mock.calls[0]!;
      expect(input).toMatchObject({
        askId: ASK_ID,
        cursor: "group-1|2026-06-30T00:00:00.000Z|prev",
        limit: 10,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("roster.coordinator ACCEPTS + STRIPS `direction` too", async () => {
      const coordSpy = vi
        .spyOn(volunteeringUseCases, "listCoordinatorRoster")
        .mockResolvedValue(coordinatorOutput as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await caller.roster.coordinator({
        askId: ASK_ID,
        direction: "backward",
      } as any);

      const [, input] = coordSpy.mock.calls[0]!;
      expect(input).not.toHaveProperty("direction");
    });
  });

  describe("broadcasts.send", () => {
    const ASK_ID = "77777777-7777-4777-8777-777777777777";

    it("fails PRECONDITION_FAILED when no mailer is configured", async () => {
      const sendSpy = vi.spyOn(volunteeringUseCases, "broadcastToRoster");

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        // No mailer override — ctx.mailer stays unconfigured.
      });
      await expect(
        caller.broadcasts.send({
          askId: ASK_ID,
          scope: { kind: "ALL" },
          subject: "Schedule change",
          body: "Doors now at 6pm.",
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("forwards mailer + notify deps and injects the actor", async () => {
      const sendSpy = vi
        .spyOn(volunteeringUseCases, "broadcastToRoster")
        .mockResolvedValue({
          broadcastId: "b-1",
          recipientCount: 3,
          alreadySent: false,
        } as any);
      const mailer = { send: vi.fn() };

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        mailer: mailer as any,
      });
      const result = await caller.broadcasts.send({
        askId: ASK_ID,
        scope: { kind: "ALL" },
        subject: "Schedule change",
        body: "Doors now at 6pm.",
      });

      expect(result).toMatchObject({ broadcastId: "b-1", recipientCount: 3 });
      const [deps, input] = sendSpy.mock.calls[0]!;
      expect(deps.mailer).toBe(mailer);
      expect(deps.notify).toBe(ctx.notify);
      expect(input).toMatchObject({
        askId: ASK_ID,
        scope: { kind: "ALL" },
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });
  });

  describe("publicAsks.get", () => {
    const ASK_ID = "77777777-7777-4777-8777-777777777777";

    it("is publicly callable and forwards the askId", async () => {
      const output = {
        ask: { id: ASK_ID, title: "Door crew", status: "OPEN" },
        roles: [],
      };
      const getSpy = vi
        .spyOn(volunteeringUseCases, "getPublicVolunteerAsk")
        .mockResolvedValue(output as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });
      const result = await caller.publicAsks.get({ askId: ASK_ID });

      expect(result).toEqual(output);
      const [deps, input] = getSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(input).toEqual({ askId: ASK_ID });
    });

    it("maps the visibility-gate denial to NOT_FOUND", async () => {
      vi.spyOn(volunteeringUseCases, "getPublicVolunteerAsk").mockRejectedValue(
        new AppError("NOT_FOUND", {
          message: "ask_not_found",
          meta: { entity: "volunteer_ask" },
        }),
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });
      await expect(
        caller.publicAsks.get({ askId: ASK_ID }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
    });
  });

  describe("ics", () => {
    it("myFeedToken passes only the ctx actor and returns the token untouched", async () => {
      const tokenSpy = vi
        .spyOn(volunteeringUseCases, "getMyVolunteerIcsFeedToken")
        .mockResolvedValue({ feedToken: "tok-abc", minted: true } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.ics.myFeedToken();

      // Token only — the UI composes the feed URL client-side.
      expect(result).toEqual({ feedToken: "tok-abc", minted: true });
      const [, input] = tokenSpy.mock.calls[0]!;
      expect(input).toEqual({ actorHumanId: ADMIN_HUMAN_ID });
    });

    it("rotateMyFeedToken passes only the ctx actor and returns the fresh token untouched", async () => {
      const rotateSpy = vi
        .spyOn(volunteeringUseCases, "rotateMyVolunteerIcsFeedToken")
        .mockResolvedValue({ feedToken: "tok-fresh", minted: true } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.ics.rotateMyFeedToken();

      // Same shape as myFeedToken — the UI swaps the composed URL in place.
      expect(result).toEqual({ feedToken: "tok-fresh", minted: true });
      const [, input] = rotateSpy.mock.calls[0]!;
      expect(input).toEqual({ actorHumanId: ADMIN_HUMAN_ID });
    });

    it("mySignupIcs injects the actor and forwards appBaseUrl from ctx", async () => {
      const SIGNUP_ID = "99999999-9999-4999-8999-999999999999";
      const icsSpy = vi
        .spyOn(volunteeringUseCases, "exportSignupIcs")
        .mockResolvedValue({
          icsBody: "BEGIN:VCALENDAR",
          filename: "shift.ics",
        } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        publicAppUrl: "https://ithasfire.com",
      });
      const result = await caller.ics.mySignupIcs({ signupId: SIGNUP_ID });

      expect(result).toEqual({
        icsBody: "BEGIN:VCALENDAR",
        filename: "shift.ics",
      });
      const [deps, input] = icsSpy.mock.calls[0]!;
      expect(deps.appBaseUrl).toBe("https://ithasfire.com");
      expect(input).toEqual({
        signupId: SIGNUP_ID,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });
  });

  describe("signups.submit (generic ask path)", () => {
    it("accepts askId and forwards it to the use case", async () => {
      const ASK_ID = "77777777-7777-4777-8777-777777777777";
      const submitSpy = vi
        .spyOn(volunteeringUseCases, "submitVolunteerSignup")
        .mockResolvedValue({ id: "signup-ask-1" } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });
      await caller.signups.submit({
        askId: ASK_ID,
        roleId: ROLE_ID,
        contactEmail: "guest@example.com",
      });

      const [, input] = submitSpy.mock.calls[0]!;
      expect(input).toMatchObject({
        askId: ASK_ID,
        roleId: ROLE_ID,
        contactEmail: "guest@example.com",
        actorHumanId: null,
      });
    });
  });

  describe("shifts.createBatch", () => {
    it("injects actorHumanId from ctx and forwards batch input to the use case", async () => {
      const shifts = [
        {
          id: "shift-1",
          roleId: ROLE_ID,
          label: "Setup",
          startsAt: new Date("2026-07-01T07:00:00.000Z"),
          endsAt: new Date("2026-07-01T09:00:00.000Z"),
          capacity: 3,
          notes: null,
          sortOrder: 0,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ];
      const createBatchSpy = vi
        .spyOn(volunteeringUseCases, "createVolunteerShiftBatch")
        .mockResolvedValue(shifts as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.shifts.createBatch({
        roleId: ROLE_ID,
        shifts: [
          {
            label: "Setup",
            startsAt: new Date("2026-07-01T07:00:00.000Z"),
            endsAt: new Date("2026-07-01T09:00:00.000Z"),
            capacity: 3,
          },
        ],
      });

      expect(result).toEqual(shifts);
      expect(createBatchSpy).toHaveBeenCalledTimes(1);
      const [deps, input] = createBatchSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(deps.clock).toBe(ctx.clock);
      expect(deps.logger).toBeDefined();
      expect(input).toEqual({
        actorHumanId: ADMIN_HUMAN_ID,
        roleId: ROLE_ID,
        shifts: [
          {
            label: "Setup",
            startsAt: new Date("2026-07-01T07:00:00.000Z"),
            endsAt: new Date("2026-07-01T09:00:00.000Z"),
            capacity: 3,
          },
        ],
      });
    });
  });

  // ── Comp-ticket rewards (volunteer-comp-tickets spec) ────────────────────

  describe("rewards", () => {
    const ASK_ID = "77777777-7777-4777-8777-777777777777";
    const REWARD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const TICKET_TYPE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    it("set injects actorHumanId from ctx and forwards deps", async () => {
      const setSpy = vi
        .spyOn(volunteeringUseCases, "setVolunteerReward")
        .mockResolvedValue({ ok: true, rewardId: REWARD_ID } as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.rewards.set({
        askId: ASK_ID,
        ticketTypeId: TICKET_TYPE_ID,
        trigger: "ON_CHECK_IN",
        maxGrants: 50,
      });

      expect(result).toEqual({ ok: true, rewardId: REWARD_ID });
      const [deps, input] = setSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(deps.clock).toBe(ctx.clock);
      expect(input).toMatchObject({
        askId: ASK_ID,
        ticketTypeId: TICKET_TYPE_ID,
        trigger: "ON_CHECK_IN",
        maxGrants: 50,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("set maps the use case's finance-gate denial to FORBIDDEN", async () => {
      vi.spyOn(volunteeringUseCases, "setVolunteerReward").mockRejectedValue(
        new AppError("INSUFFICIENT_ROLE"),
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await expect(
        caller.rewards.set({ askId: ASK_ID, ticketTypeId: TICKET_TYPE_ID }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("set surfaces the adapter's duplicate_reward race as CONFLICT (not 500)", async () => {
      // The Prisma partial-unique loser on a concurrent ask-level upsert
      // surfaces as a plain `{ code: "duplicate_reward" }` object which core
      // re-throws. Contract: the client sees CONFLICT (409).
      vi.spyOn(volunteeringUseCases, "setVolunteerReward").mockRejectedValue({
        code: "duplicate_reward",
        message: "duplicate_reward",
      });

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await expect(
        caller.rewards.set({ askId: ASK_ID, ticketTypeId: TICKET_TYPE_ID }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "duplicate_reward",
      });
    });

    it("ledger injects the actor and forwards deps", async () => {
      const ledger = {
        askId: ASK_ID,
        rewards: [],
        grants: [],
        counts: { granted: 0, redeemed: 0, revoked: 0, total: 0 },
        remainingBudget: 0,
        faceValueCents: 0,
      };
      const ledgerSpy = vi
        .spyOn(volunteeringUseCases, "listAskRewardLedger")
        .mockResolvedValue(ledger as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.rewards.ledger({ askId: ASK_ID });

      expect(result).toEqual(ledger);
      const [deps, input] = ledgerSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(input).toEqual({ askId: ASK_ID, actorHumanId: ADMIN_HUMAN_ID });
    });

    it("list injects the actor and forwards deps", async () => {
      const listSpy = vi
        .spyOn(volunteeringUseCases, "listAskRewards")
        .mockResolvedValue({ askId: ASK_ID, rewards: [] } as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.rewards.list({ askId: ASK_ID });

      expect(result).toEqual({ askId: ASK_ID, rewards: [] });
      const [deps, input] = listSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(input).toEqual({ askId: ASK_ID, actorHumanId: ADMIN_HUMAN_ID });
    });

    const GRANT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    it("revoke injects actorHumanId from ctx and forwards deps to the use case", async () => {
      const revokeSpy = vi
        .spyOn(volunteeringUseCases, "revokeVolunteerReward")
        .mockResolvedValue({ ok: true } as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      const result = await caller.rewards.revoke({
        grantId: GRANT_ID,
        reason: "duplicate grant",
      });

      expect(result).toEqual({ ok: true });
      const [deps, input] = revokeSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(deps.clock).toBe(ctx.clock);
      // The MANUAL path: actorHumanId is injected from ctx (never the client),
      // which is what flips the use case into its ORG_FINANCE_ROLES gate.
      expect(input).toEqual({
        grantId: GRANT_ID,
        reason: "duplicate grant",
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("revoke surfaces a redeemed-comp conflict as CONFLICT (not 500)", async () => {
      // The use case refuses to claw back a SCANNED/REDEEMED comp with
      // `fail("CONFLICT", { message: "reward_already_redeemed" })`. Mirrors the
      // asks.update `ask_archived` contract: client sees CONFLICT (409) with the
      // stable message + meta.reason, and data.appCode = "CONFLICT".
      vi.spyOn(volunteeringUseCases, "revokeVolunteerReward").mockRejectedValue(
        new AppError("CONFLICT", {
          message: "reward_already_redeemed",
          meta: { reason: "reward_already_redeemed", grantId: GRANT_ID },
        }),
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await expect(
        caller.rewards.revoke({ grantId: GRANT_ID, reason: "oops" }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "reward_already_redeemed",
        meta: { reason: "reward_already_redeemed", appCode: "CONFLICT" },
      });
    });

    it("revoke maps the use case's finance-gate denial to FORBIDDEN", async () => {
      // A plain organiser/editor without ORG_FINANCE_ROLES: the use case throws
      // its finance-gate denial, which the transport must surface as FORBIDDEN.
      vi.spyOn(volunteeringUseCases, "revokeVolunteerReward").mockRejectedValue(
        new AppError("INSUFFICIENT_ROLE"),
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await expect(
        caller.rewards.revoke({ grantId: GRANT_ID, reason: "no perms" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  // ── Comp-reward trigger wiring ───────────────────────────────────────────
  //
  // WITHOUT a `rewards` dep the signup use cases never fire a grant/revoke.
  // These prove the transport supplies one AND that the supplied hook actually
  // delegates to grant-/revoke-volunteer-reward.
  describe("comp-reward trigger wiring", () => {
    const SIGNUP_ID = "99999999-9999-4999-8999-999999999999";
    const REWARD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const GRANT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    it("signups.review passes a rewards.grant hook that invokes grantVolunteerReward", async () => {
      const reviewSpy = vi
        .spyOn(volunteeringUseCases, "reviewVolunteerSignup")
        .mockResolvedValue({ id: SIGNUP_ID, status: "APPROVED" } as any);
      const grantSpy = vi
        .spyOn(volunteeringUseCases, "grantVolunteerReward")
        .mockResolvedValue({ ok: true, grantId: null } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await caller.signups.review({ signupId: SIGNUP_ID, decision: "APPROVED" });

      const [deps] = reviewSpy.mock.calls[0]!;
      expect(deps.rewards).toBeDefined();
      expect(typeof deps.rewards!.grant).toBe("function");

      // Firing the hook delegates straight to the grant use case.
      await deps.rewards!.grant({
        signupId: SIGNUP_ID,
        rewardId: REWARD_ID,
        trigger: "ON_APPROVAL",
      });
      expect(grantSpy).toHaveBeenCalledWith(expect.anything(), {
        signupId: SIGNUP_ID,
        rewardId: REWARD_ID,
        trigger: "ON_APPROVAL",
      });
    });

    it("signups.checkIn passes a non-undefined rewards dep", async () => {
      const checkInSpy = vi
        .spyOn(volunteeringUseCases, "checkInVolunteer")
        .mockResolvedValue({ id: SIGNUP_ID, status: "CHECKED_IN" } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await caller.signups.checkIn({ signupId: SIGNUP_ID });

      const [deps] = checkInSpy.mock.calls[0]!;
      expect(deps.rewards).toBeDefined();
      expect(typeof deps.rewards!.grant).toBe("function");
    });

    it("signups.reviewBatch passes a rewards.grant hook (per-signup ON_APPROVAL grants)", async () => {
      const batchSpy = vi
        .spyOn(volunteeringUseCases, "reviewVolunteerSignupsBatch")
        .mockResolvedValue({ results: [] } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await caller.signups.reviewBatch({
        signupIds: [SIGNUP_ID],
        decision: "APPROVED",
      });

      // reviewVolunteerSignupsBatch fans each id out to reviewVolunteerSignup
      // with these same deps, so a non-undefined rewards.grant here means the
      // ON_APPROVAL grant fires once per approved signup, not once per batch.
      const [deps] = batchSpy.mock.calls[0]!;
      expect(deps.rewards).toBeDefined();
      expect(typeof deps.rewards!.grant).toBe("function");
    });

    it("signups.withdraw passes a rewards.revoke hook that invokes revokeVolunteerReward", async () => {
      const withdrawSpy = vi
        .spyOn(volunteeringUseCases, "withdrawVolunteerSignup")
        .mockResolvedValue({ id: SIGNUP_ID, status: "WITHDRAWN" } as any);
      const revokeSpy = vi
        .spyOn(volunteeringUseCases, "revokeVolunteerReward")
        .mockResolvedValue({ ok: true } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });
      await caller.signups.withdraw({ signupId: SIGNUP_ID });

      const [deps] = withdrawSpy.mock.calls[0]!;
      expect(deps.rewards).toBeDefined();
      expect(typeof deps.rewards!.revoke).toBe("function");

      // The revoke hook fires system-side (no actor) and delegates to the use
      // case with the grantId + reason it was handed.
      await deps.rewards!.revoke({ grantId: GRANT_ID, reason: "manual_test" });
      expect(revokeSpy).toHaveBeenCalledWith(expect.anything(), {
        grantId: GRANT_ID,
        reason: "manual_test",
      });
    });
  });

  // ── signups.mintScanToken ────────────────────────────────────────────────
  //
  // Ownership, `kind`, TTL and the anti-oracle response all live in
  // `mintVolunteerScanToken`. What the transport owes is narrow and is
  // exactly what these pin: it forwards `kind` untouched (so the volunteer's
  // own printable QR is reachable), and it injects `actorHumanId` from ctx so
  // a client can never mint as somebody else.
  describe("signups.mintScanToken", () => {
    const VOLUNTEER_HUMAN_ID = "55555555-5555-4555-8555-555555555555";
    const SCAN_SIGNUP_ID = "66666666-6666-4666-8666-666666666666";

    const stubTokenPort = () => ({
      sign: vi.fn(),
      verify: vi.fn(),
    });

    it("forwards kind: print verbatim for a plain volunteer (no transport-side gate)", async () => {
      const mintSpy = vi
        .spyOn(volunteeringUseCases, "mintVolunteerScanToken")
        .mockResolvedValue({
          token: "tok",
          expiresAt: new Date("2026-07-02T23:00:00.000Z"),
        } as any);
      const volunteerScanToken = stubTokenPort();

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: VOLUNTEER_HUMAN_ID,
        volunteerScanToken: volunteerScanToken as any,
      });
      const result = await caller.signups.mintScanToken({
        signupId: SCAN_SIGNUP_ID,
        kind: "print",
      });

      expect(result).toEqual({
        token: "tok",
        expiresAt: new Date("2026-07-02T23:00:00.000Z"),
      });
      const [deps, input] = mintSpy.mock.calls[0]!;
      expect(deps.repos).toBe(ctx.repos);
      expect(deps.volunteerScanToken).toBe(volunteerScanToken);
      expect(input).toEqual({
        actorHumanId: VOLUNTEER_HUMAN_ID,
        signupId: SCAN_SIGNUP_ID,
        kind: "print",
      });
    });

    it("ignores a client-supplied actorHumanId and uses the ctx actor", async () => {
      const mintSpy = vi
        .spyOn(volunteeringUseCases, "mintVolunteerScanToken")
        .mockResolvedValue({ token: "tok", expiresAt: new Date() } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: VOLUNTEER_HUMAN_ID,
        volunteerScanToken: stubTokenPort() as any,
      });
      await caller.signups.mintScanToken({
        signupId: SCAN_SIGNUP_ID,
        kind: "print",
        // Spoof attempt: `actorHumanId` is omitted from the client-facing
        // schema, so zod strips it before the router re-injects ctx's.
        actorHumanId: ADMIN_HUMAN_ID,
      } as any);

      const [, input] = mintSpy.mock.calls[0]!;
      expect(input.actorHumanId).toBe(VOLUNTEER_HUMAN_ID);
    });

    it("defaults kind to short when omitted", async () => {
      const mintSpy = vi
        .spyOn(volunteeringUseCases, "mintVolunteerScanToken")
        .mockResolvedValue({ token: "tok", expiresAt: new Date() } as any);

      const { caller } = createVolunteerCaller({
        actorHumanId: VOLUNTEER_HUMAN_ID,
        volunteerScanToken: stubTokenPort() as any,
      });
      await caller.signups.mintScanToken({ signupId: SCAN_SIGNUP_ID });

      expect(mintSpy.mock.calls[0]![1].kind).toBe("short");
    });

    it("fails PRECONDITION_FAILED when no token port is configured", async () => {
      const mintSpy = vi.spyOn(
        volunteeringUseCases,
        "mintVolunteerScanToken",
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: VOLUNTEER_HUMAN_ID,
      });

      await expect(
        caller.signups.mintScanToken({
          signupId: SCAN_SIGNUP_ID,
          kind: "print",
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(mintSpy).not.toHaveBeenCalled();
    });
  });

  describe("groups.assignCoordinator", () => {
    const GROUP_ID = "77777777-7777-4777-8777-777777777777";
    const COORD_ID = "88888888-8888-4888-8888-888888888888";

    it("prefers ctx.notifyWithEmail and passes reportError, rateLimit and the base URL", async () => {
      const assignSpy = vi
        .spyOn(volunteeringUseCases, "assignGroupCoordinator")
        .mockResolvedValue({ id: GROUP_ID } as any);
      const notifyWithEmail = vi.fn(async () => ({ ok: true }));
      const reportError = vi.fn();

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        notifyWithEmail: notifyWithEmail as any,
        reportError,
        publicAppUrl: "https://ithasfire.com",
      });

      await caller.groups.assignCoordinator({
        groupId: GROUP_ID,
        coordinatorHumanId: COORD_ID,
      });

      const [deps, input] = assignSpy.mock.calls[0]!;
      expect(deps.notify).toBe(notifyWithEmail);
      expect(deps.notify).not.toBe(ctx.notify);
      expect(deps.reportError).toBe(reportError);
      expect(deps.rateLimit).toBe(ctx.rateLimit);
      expect(deps.appBaseUrl).toBe("https://ithasfire.com");
      expect(input).toEqual({
        groupId: GROUP_ID,
        coordinatorHumanId: COORD_ID,
        actorHumanId: ADMIN_HUMAN_ID,
      });
    });

    it("falls back to ctx.notify without a mailer-bound notify, and passes a NULL base URL when unset", async () => {
      const assignSpy = vi
        .spyOn(volunteeringUseCases, "assignGroupCoordinator")
        .mockResolvedValue({ id: GROUP_ID } as any);

      const { caller, ctx } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
      });

      await caller.groups.assignCoordinator({
        groupId: GROUP_ID,
        coordinatorHumanId: COORD_ID,
      });

      const [deps] = assignSpy.mock.calls[0]!;
      expect(deps.notify).toBe(ctx.notify);
      // Never "" — the use case skips the notice with a reported warning.
      expect(deps.appBaseUrl).toBeNull();
    });

    it("is rate limited per actor (20/hour) and rejects with TOO_MANY_REQUESTS before the use case runs", async () => {
      const assignSpy = vi
        .spyOn(volunteeringUseCases, "assignGroupCoordinator")
        .mockResolvedValue({ id: GROUP_ID } as any);
      const consume = vi.fn(async (key: string) =>
        key.startsWith("volunteer:assignCoordinator:")
          ? { allowed: false, remaining: 0, retryAfterSeconds: 600 }
          : { allowed: true, remaining: 100, retryAfterSeconds: 0 },
      );

      const { caller } = createVolunteerCaller({
        actorHumanId: ADMIN_HUMAN_ID,
        rateLimit: { consume } as never,
      });

      await expect(
        caller.groups.assignCoordinator({
          groupId: GROUP_ID,
          coordinatorEmail: "someone@example.org",
        }),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
      expect(consume).toHaveBeenCalledWith(
        `volunteer:assignCoordinator:${ADMIN_HUMAN_ID}`,
        20,
        3600,
      );
      expect(assignSpy).not.toHaveBeenCalled();
    });
  });
});
