import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import { getPublicVolunteerWaiver } from "./get-public-volunteer-waiver";

// ── Constants ────────────────────────────────────────────────────────────────

const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const HUMAN_ID = "00000000-0000-4000-8000-000000000001";
const WAIVER_TEMPLATE_ID = "00000000-0000-4000-8000-000000000060";
const NOW = new Date("2026-06-11T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseEvent = {
  id: EVENT_ID,
  status: "PUBLISHED",
  volunteeringEnabled: true,
  volunteerWaiverRequired: true,
  waiverTemplateId: WAIVER_TEMPLATE_ID,
};

const waiverTemplate = {
  id: WAIVER_TEMPLATE_ID,
  name: "Volunteer Waiver",
  body: "I assume all risk.",
  version: 2,
};

const onFileAcceptance = {
  id: "vwa-1",
  humanId: HUMAN_ID,
  signupId: "older-signup",
  waiverTemplateId: WAIVER_TEMPLATE_ID,
  waiverVersion: 2,
  waiverBodyHash: "hash",
  acceptedAt: NOW,
  ipAddress: null,
  userAgent: null,
};

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos: Record<string, unknown> = {
    events: { getById: vi.fn(async () => baseEvent) },
    waiverTemplates: { getById: vi.fn(async () => waiverTemplate) },
    volunteerWaiverAcceptances: {
      findCurrentForHuman: vi.fn(async () => null),
    },
    ...txOverrides,
  };
  const deps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
  };
  return { deps, txRepos };
}

// ══════════════════════════════════════════════════════════════════════════════
// getPublicVolunteerWaiver
// ══════════════════════════════════════════════════════════════════════════════

describe("getPublicVolunteerWaiver", () => {
  // ── Visibility gate (mirrors listPublicEventVolunteerRoles) ───────────────

  it("throws not_found for a missing event", async () => {
    const { deps } = makeDeps({
      events: { getById: vi.fn(async () => null) },
    });

    await expect(
      getPublicVolunteerWaiver(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("collapses an unpublished event to not_found (no existence leak)", async () => {
    const { deps } = makeDeps({
      events: {
        getById: vi.fn(async () => ({ ...baseEvent, status: "DRAFT" })),
      },
    });

    await expect(
      getPublicVolunteerWaiver(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("collapses volunteering-disabled events to not_found", async () => {
    const { deps } = makeDeps({
      events: {
        getById: vi.fn(async () => ({
          ...baseEvent,
          volunteeringEnabled: false,
        })),
      },
    });

    await expect(
      getPublicVolunteerWaiver(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  // ── No-gate branches ───────────────────────────────────────────────────────

  it("returns waiverRequired: false when the event flag is off", async () => {
    const { deps, txRepos } = makeDeps({
      events: {
        getById: vi.fn(async () => ({
          ...baseEvent,
          volunteerWaiverRequired: false,
        })),
      },
    });

    const result = await getPublicVolunteerWaiver(deps, { eventId: EVENT_ID });

    expect(result).toEqual({
      waiverRequired: false,
      waiver: null,
      alreadyAccepted: false,
    });
    expect((txRepos.waiverTemplates as any).getById).not.toHaveBeenCalled();
  });

  it("returns waiverRequired: false when the flag is on but no template is assigned", async () => {
    const { deps } = makeDeps({
      events: {
        getById: vi.fn(async () => ({ ...baseEvent, waiverTemplateId: null })),
      },
    });

    const result = await getPublicVolunteerWaiver(deps, { eventId: EVENT_ID });

    expect(result).toEqual({
      waiverRequired: false,
      waiver: null,
      alreadyAccepted: false,
    });
  });

  it("returns waiverRequired: false when the assigned template was deleted", async () => {
    const { deps } = makeDeps({
      waiverTemplates: { getById: vi.fn(async () => null) },
    });

    const result = await getPublicVolunteerWaiver(deps, { eventId: EVENT_ID });

    expect(result).toEqual({
      waiverRequired: false,
      waiver: null,
      alreadyAccepted: false,
    });
  });

  // ── Gated reads ────────────────────────────────────────────────────────────

  it("returns the waiver body/metadata with alreadyAccepted: false for guests", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await getPublicVolunteerWaiver(deps, { eventId: EVENT_ID });

    expect(result).toEqual({
      waiverRequired: true,
      waiver: {
        templateId: WAIVER_TEMPLATE_ID,
        version: 2,
        title: "Volunteer Waiver",
        body: "I assume all risk.",
      },
      alreadyAccepted: false,
    });
    // Guests never trigger the acceptance lookup.
    expect(
      (txRepos.volunteerWaiverAcceptances as any).findCurrentForHuman,
    ).not.toHaveBeenCalled();
  });

  it("returns alreadyAccepted: false for a signed-in viewer with nothing on file", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await getPublicVolunteerWaiver(deps, {
      eventId: EVENT_ID,
      actorHumanId: HUMAN_ID,
    });

    expect(result.waiverRequired).toBe(true);
    expect(result.alreadyAccepted).toBe(false);
    expect(
      (txRepos.volunteerWaiverAcceptances as any).findCurrentForHuman,
    ).toHaveBeenCalledWith(HUMAN_ID, WAIVER_TEMPLATE_ID, 2);
  });

  it("returns alreadyAccepted: true for a signed-in viewer with a current acceptance", async () => {
    const { deps } = makeDeps({
      volunteerWaiverAcceptances: {
        findCurrentForHuman: vi.fn(async () => onFileAcceptance),
      },
    });

    const result = await getPublicVolunteerWaiver(deps, {
      eventId: EVENT_ID,
      actorHumanId: HUMAN_ID,
    });

    expect(result.waiverRequired).toBe(true);
    expect(result.alreadyAccepted).toBe(true);
  });

  it("rejects malformed input at parse time", async () => {
    const { deps } = makeDeps();

    await expect(
      getPublicVolunteerWaiver(deps, { eventId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
