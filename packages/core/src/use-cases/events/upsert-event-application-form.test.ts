import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type {
  EventApplicationFormRecord,
  EventRecord,
  Repos,
  TxRepos,
} from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";

import { upsertEventApplicationForm } from "./upsert-event-application-form";

const EVENT_ID = "a0000000-0000-4000-8000-000000000001";
const ORG_ID = "b0000000-0000-4000-8000-000000000002";
const ACTOR_ID = "c0000000-0000-4000-8000-000000000003";
const FORM_ID = "d0000000-0000-4000-8000-000000000004";
const NOW = new Date("2025-12-03T12:00:00Z");

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Gated experience",
  status: "PUBLISHED",
  visibility: "PRIVATE",
  gateType: "APPLICATION",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2025-12-05T00:00:00Z"),
  endsAt: new Date("2025-12-05T02:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  slug: "gated-experience",
  shortId: "GATE123",
  regionCode: "US-CA",
  publishedAt: new Date("2025-12-01T00:00:00Z"),
  agreementPrimaryId: "e0000000-0000-4000-8000-000000000005",
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
};

const baseForm: EventApplicationFormRecord = {
  id: FORM_ID,
  eventId: EVENT_ID,
  introText: "Tell us about yourself",
  defaults: {
    includeName: true,
    includeReason: false,
    includeSocialLinks: false,
  },
  opensAt: null,
  closesAt: null,
  maxSubmissions: null,
  autoApprove: false,
  updatedByHumanId: ACTOR_ID,
  createdAt: new Date("2025-11-10T00:00:00Z"),
  updatedAt: NOW,
};

const membership: OrgMembership = {
  orgId: ORG_ID,
  humanId: ACTOR_ID,
  role: "ADMIN",
};

function createDeps(
  overrides: {
    event?: Partial<EventRecord | null>;
    form?: Partial<EventApplicationFormRecord>;
    /** The row already in storage, as seen by the effective-window check. */
    storedForm?: Partial<EventApplicationFormRecord> | null;
  } = {},
) {
  const eventValue =
    overrides.event === null
      ? null
      : { ...baseEvent, ...(overrides.event ?? {}) };
  const formValue = { ...baseForm, ...(overrides.form ?? {}) };

  const eventsRepo = {
    getById: vi.fn().mockResolvedValue(eventValue),
  };
  const authzRepo = {
    getOrgMembership: vi.fn().mockResolvedValue(eventValue ? membership : null),
    getStaffRolesForHumanId: vi.fn(async () => []),
  };
  const eventApplicationsRepo = {
    upsertForm: vi.fn().mockResolvedValue(formValue),
    // Read back by the effective-window check on PARTIAL updates. Defaults
    // to the same row `upsertForm` resolves; `overrides.storedForm` supplies
    // a different "already stored" state where a test needs one.
    getForm: vi
      .fn()
      .mockResolvedValue(
        overrides.storedForm === null
          ? null
          : { ...baseForm, ...(overrides.storedForm ?? overrides.form ?? {}) },
      ),
  };
  const auditRepo = {
    log: vi.fn(),
  };

  const tx = {
    events: eventsRepo,
    authz: authzRepo,
    eventApplications: eventApplicationsRepo,
    audit: auditRepo,
  } as unknown as TxRepos;

  const repos = {
    tx: vi.fn(async (fn: (txRepos: TxRepos) => Promise<unknown>) => fn(tx)),
  } as unknown as Repos;

  const clock: ClockPort = {
    now: vi.fn(() => NOW),
  };

  const info = vi.fn();
  const logger: LoggerPort = {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as LoggerPort;

  return {
    repos,
    clock,
    logger,
    info,
    eventsRepo,
    authzRepo,
    eventApplicationsRepo,
    auditRepo,
  };
}

describe("upsertEventApplicationForm", () => {
  it("creates or updates the form when actor can edit", async () => {
    const { repos, eventApplicationsRepo, auditRepo, clock, logger, info } =
      createDeps({
        form: {
          introText: "Tell us why you want in",
          defaults: {
            includeName: true,
            includeReason: true,
            includeSocialLinks: false,
          },
        },
      });

    const result = await upsertEventApplicationForm(
      { repos, clock, logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        introText: "  Tell us why you want in  ",
        defaults: {
          includeName: true,
          includeReason: true,
          includeSocialLinks: false,
        },
      },
    );

    expect(eventApplicationsRepo.upsertForm).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      purpose: "ATTEND",
      introText: "Tell us why you want in",
      defaults: {
        includeName: true,
        includeReason: true,
        includeSocialLinks: false,
      },
      updatedByHumanId: ACTOR_ID,
    });

    expect(auditRepo.log).toHaveBeenCalledWith({
      entity: "event",
      entityId: EVENT_ID,
      action: "event_application_form_upserted",
      data: {
        actorHumanId: ACTOR_ID,
        formId: FORM_ID,
      },
      at: NOW,
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      formId: FORM_ID,
      introText: "Tell us why you want in",
      defaults: {
        includeName: true,
        includeReason: true,
        includeSocialLinks: false,
      },
      opensAt: null,
      closesAt: null,
      maxSubmissions: null,
      autoApprove: false,
      updatedAt: NOW,
    });

    expect(info).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({
        action: "application_form_upserted",
        result: "success",
      }),
    );
  });

  it("passes the lifecycle fields (opensAt/closesAt/maxSubmissions/autoApprove) through to the repo", async () => {
    const opensAt = new Date("2025-12-01T00:00:00Z");
    const closesAt = new Date("2025-12-04T00:00:00Z");
    const { repos, eventApplicationsRepo, clock, logger } = createDeps({
      form: { opensAt, closesAt, maxSubmissions: 25, autoApprove: true },
    });

    const result = await upsertEventApplicationForm(
      { repos, clock, logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        opensAt,
        closesAt,
        maxSubmissions: 25,
        autoApprove: true,
      },
    );

    expect(eventApplicationsRepo.upsertForm).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      purpose: "ATTEND",
      updatedByHumanId: ACTOR_ID,
      opensAt,
      closesAt,
      maxSubmissions: 25,
      autoApprove: true,
    });
    expect(result).toMatchObject({
      opensAt,
      closesAt,
      maxSubmissions: 25,
      autoApprove: true,
    });
  });

  it("omits absent fields from the repo call so the adapter preserves stored values", async () => {
    const { repos, eventApplicationsRepo, clock, logger } = createDeps();

    await upsertEventApplicationForm(
      { repos, clock, logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        autoApprove: true,
      },
    );

    // Exact payload: no introText/defaults/opensAt/closesAt/maxSubmissions
    // keys at all — absent must stay absent (presence-guarded update).
    expect(eventApplicationsRepo.upsertForm.mock.calls[0]![0]).toStrictEqual({
      eventId: EVENT_ID,
      purpose: "ATTEND",
      updatedByHumanId: ACTOR_ID,
      autoApprove: true,
    });
  });

  it("passes explicit nulls through so the adapter clears stored values", async () => {
    const { repos, eventApplicationsRepo, clock, logger } = createDeps();

    await upsertEventApplicationForm(
      { repos, clock, logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        opensAt: null,
        closesAt: null,
        maxSubmissions: null,
      },
    );

    expect(eventApplicationsRepo.upsertForm.mock.calls[0]![0]).toStrictEqual({
      eventId: EVENT_ID,
      purpose: "ATTEND",
      updatedByHumanId: ACTOR_ID,
      opensAt: null,
      closesAt: null,
      maxSubmissions: null,
    });
  });

  it("rejects a closesAt at or before opensAt", async () => {
    const { repos, clock, logger } = createDeps();
    const opensAt = new Date("2025-12-04T00:00:00Z");
    const windowIssue = {
      code: "invalid_input",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ["closesAt"],
          message: "closes_at_must_be_after_opens_at",
        }),
      ]),
    };

    // Strictly-before rejects…
    await expect(
      upsertEventApplicationForm(
        { repos, clock, logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          opensAt,
          closesAt: new Date("2025-12-03T00:00:00Z"),
        },
      ),
    ).rejects.toMatchObject(windowIssue);

    // …and exactly-equal rejects too (a zero-length window is unusable).
    await expect(
      upsertEventApplicationForm(
        { repos, clock, logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          opensAt,
          closesAt: opensAt,
        },
      ),
    ).rejects.toMatchObject(windowIssue);
  });

  it("accepts a one-sided window without refinement errors", async () => {
    const { repos, eventApplicationsRepo, clock, logger } = createDeps();
    const closesAt = new Date("2025-12-04T00:00:00Z");

    await upsertEventApplicationForm(
      { repos, clock, logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        closesAt,
      },
    );

    expect(eventApplicationsRepo.upsertForm).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      purpose: "ATTEND",
      updatedByHumanId: ACTOR_ID,
      closesAt,
    });
  });

  it("rejects a PARTIAL update that inverts the STORED window", async () => {
    // The adapter's update is presence-guarded, so sending closesAt alone
    // merges with the stored opensAt. Neither value is wrong on its own —
    // only the merged pair is — so an input-only refinement can't see this.
    const { repos, eventApplicationsRepo, clock, logger } = createDeps({
      storedForm: { opensAt: new Date("2026-10-01T00:00:00Z") },
    });

    await expect(
      upsertEventApplicationForm(
        { repos, clock, logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          closesAt: new Date("2026-09-01T00:00:00Z"),
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ["closesAt"],
          message: "closes_at_must_be_after_opens_at",
        }),
      ]),
    });

    // Nothing was written — the guard runs before the upsert.
    expect(eventApplicationsRepo.upsertForm).not.toHaveBeenCalled();
  });

  it("rejects a PARTIAL opensAt that lands after the STORED closesAt", async () => {
    const { repos, eventApplicationsRepo, clock, logger } = createDeps({
      storedForm: { closesAt: new Date("2026-09-01T00:00:00Z") },
    });

    await expect(
      upsertEventApplicationForm(
        { repos, clock, logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          opensAt: new Date("2026-10-01T00:00:00Z"),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(eventApplicationsRepo.upsertForm).not.toHaveBeenCalled();
  });

  it("accepts a PARTIAL update that keeps the merged window ordered", async () => {
    const { repos, eventApplicationsRepo, clock, logger } = createDeps({
      storedForm: { opensAt: new Date("2026-09-01T00:00:00Z") },
    });

    await upsertEventApplicationForm(
      { repos, clock, logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        closesAt: new Date("2026-10-01T00:00:00Z"),
      },
    );

    expect(eventApplicationsRepo.upsertForm).toHaveBeenCalledTimes(1);
  });

  it("allows CLEARING one side even when the stored other side would invert", async () => {
    // closesAt: null = "never closes" — no ordering to violate.
    const { repos, eventApplicationsRepo, clock, logger } = createDeps({
      storedForm: { opensAt: new Date("2026-10-01T00:00:00Z") },
    });

    await upsertEventApplicationForm(
      { repos, clock, logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        closesAt: null,
      },
    );

    expect(eventApplicationsRepo.upsertForm).toHaveBeenCalledTimes(1);
  });

  it("skips the stored-form read when the input cannot invert anything", async () => {
    const { repos, eventApplicationsRepo, clock, logger } = createDeps();

    // Neither window side supplied → nothing to merge, no read.
    await upsertEventApplicationForm(
      { repos, clock, logger },
      { actorHumanId: ACTOR_ID, eventId: EVENT_ID, autoApprove: true },
    );
    expect(eventApplicationsRepo.getForm).not.toHaveBeenCalled();

    // BOTH supplied → the schema already decided; no stored value survives.
    await upsertEventApplicationForm(
      { repos, clock, logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        opensAt: new Date("2026-09-01T00:00:00Z"),
        closesAt: new Date("2026-10-01T00:00:00Z"),
      },
    );
    expect(eventApplicationsRepo.getForm).not.toHaveBeenCalled();
  });

  it("allows a one-sided window on a form that does not exist yet", async () => {
    const { repos, eventApplicationsRepo, clock, logger } = createDeps({
      storedForm: null,
    });

    await upsertEventApplicationForm(
      { repos, clock, logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        closesAt: new Date("2026-09-01T00:00:00Z"),
      },
    );

    expect(eventApplicationsRepo.upsertForm).toHaveBeenCalledTimes(1);
  });

  it("rejects maxSubmissions below 1", async () => {
    const { repos, clock, logger } = createDeps();

    await expect(
      upsertEventApplicationForm(
        { repos, clock, logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          maxSubmissions: 0,
        },
      ),
    ).rejects.toThrow();
  });

  it("throws when the event is not application gated", async () => {
    const { repos, clock, logger } = createDeps({
      event: { gateType: "PASSWORD" },
    });

    await expect(
      upsertEventApplicationForm(
        { repos, clock, logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          introText: null,
          defaults: {
            includeName: true,
            includeReason: false,
            includeSocialLinks: false,
          },
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_APPLICATION_GATED" });
  });

  it("throws when the event cannot be found", async () => {
    const { repos, authzRepo, clock, logger } = createDeps({ event: null });
    authzRepo.getOrgMembership.mockResolvedValue(null);

    await expect(
      upsertEventApplicationForm(
        { repos, clock, logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          introText: null,
          defaults: {
            includeName: true,
            includeReason: false,
            includeSocialLinks: false,
          },
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});
