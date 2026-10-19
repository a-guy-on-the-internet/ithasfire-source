import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import { getPublicAskWaiver } from "./get-public-ask-waiver";

// ── Constants ────────────────────────────────────────────────────────────────

const ASK_ID = "00000000-0000-4000-8000-000000000010";
const HUMAN_ID = "00000000-0000-4000-8000-000000000001";
const WAIVER_TEMPLATE_ID = "00000000-0000-4000-8000-000000000060";
const NOW = new Date("2026-07-07T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** OPEN ask with the flag on and a waiver template assigned (armed). */
const armedAsk = {
  id: ASK_ID,
  subjectType: "ORG",
  subjectId: "00000000-0000-4000-8000-000000000002",
  orgId: "00000000-0000-4000-8000-000000000002",
  title: "Standing bar crew",
  description: null,
  status: "OPEN",
  cadence: "ONGOING",
  startsAt: null,
  endsAt: null,
  capacity: null,
  autoApprove: false,
  waiverRequired: true,
  waiverTemplateId: WAIVER_TEMPLATE_ID,
  smsOptInEnabled: false,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const waiverTemplate = {
  id: WAIVER_TEMPLATE_ID,
  orgId: armedAsk.orgId,
  humanId: null,
  name: "Volunteer Waiver",
  body: "I assume all risk.",
  version: 2,
  isDefault: false,
  createdAt: NOW,
  updatedAt: NOW,
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
    volunteering: { getAsk: vi.fn(async () => armedAsk) },
    waiverTemplates: { getById: vi.fn(async () => waiverTemplate) },
    volunteerWaiverAcceptances: {
      findCurrentForHuman: vi.fn(async () => null),
    },
    bans: {
      findBannedOwners: vi.fn(async () => ({ humanIds: [], orgIds: [] })),
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
// getPublicAskWaiver
// ══════════════════════════════════════════════════════════════════════════════

describe("getPublicAskWaiver", () => {
  // ── Visibility gate (exact parity with getPublicVolunteerAsk) ─────────────

  it("throws ask_not_found for a missing ask", async () => {
    const { deps } = makeDeps({
      volunteering: { getAsk: vi.fn(async () => null) },
    });

    await expect(
      getPublicAskWaiver(deps, { askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
  });

  it.each(["DRAFT", "ARCHIVED"] as const)(
    "collapses a %s ask to ask_not_found (no existence oracle)",
    async (status) => {
      const { deps } = makeDeps({
        volunteering: {
          getAsk: vi.fn(async () => ({ ...armedAsk, status })),
        },
      });

      await expect(
        getPublicAskWaiver(deps, { askId: ASK_ID }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
    },
  );

  it.each(["PAUSED", "CLOSED"] as const)(
    "keeps a %s ask readable — shared links render the closed page with waiver context",
    async (status) => {
      const { deps } = makeDeps({
        volunteering: {
          getAsk: vi.fn(async () => ({ ...armedAsk, status })),
        },
      });

      const result = await getPublicAskWaiver(deps, { askId: ASK_ID });

      expect(result.waiverRequired).toBe(true);
      expect(result.waiver?.id).toBe(WAIVER_TEMPLATE_ID);
    },
  );

  it("collapses a withheld owner's ask to ask_not_found (ban that sticks)", async () => {
    const findBannedOwners = vi.fn(async () => ({
      humanIds: [],
      orgIds: [armedAsk.subjectId],
    }));
    const { deps, txRepos } = makeDeps({ bans: { findBannedOwners } });

    await expect(
      getPublicAskWaiver(deps, { askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "ask_not_found" });
    expect(findBannedOwners).toHaveBeenCalledWith({
      humanIds: [],
      orgIds: [armedAsk.subjectId],
    });
    const templates = txRepos.waiverTemplates as { getById: ReturnType<typeof vi.fn> };
    expect(templates.getById).not.toHaveBeenCalled();
  });

  it("serves the waiver when the owner is not withheld", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await getPublicAskWaiver(deps, { askId: ASK_ID });

    expect(result.waiver?.id).toBe(WAIVER_TEMPLATE_ID);
    const bans = txRepos.bans as { findBannedOwners: ReturnType<typeof vi.fn> };
    expect(bans.findBannedOwners).toHaveBeenCalledTimes(1);
  });

  // ── No-gate branches ───────────────────────────────────────────────────────

  it("returns waiverRequired: false when the ask flag is off", async () => {
    const { deps, txRepos } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => ({ ...armedAsk, waiverRequired: false })),
      },
    });

    const result = await getPublicAskWaiver(deps, { askId: ASK_ID });

    expect(result).toEqual({
      waiverRequired: false,
      waiver: null,
      alreadyOnFile: false,
    });
    expect((txRepos.waiverTemplates as any).getById).not.toHaveBeenCalled();
  });

  it("returns waiverRequired: false when the flag is on but no template is assigned (disarmed)", async () => {
    const { deps } = makeDeps({
      volunteering: {
        getAsk: vi.fn(async () => ({ ...armedAsk, waiverTemplateId: null })),
      },
    });

    const result = await getPublicAskWaiver(deps, { askId: ASK_ID });

    expect(result).toEqual({
      waiverRequired: false,
      waiver: null,
      alreadyOnFile: false,
    });
  });

  it("returns waiverRequired: false when the assigned template does not resolve", async () => {
    const { deps } = makeDeps({
      waiverTemplates: { getById: vi.fn(async () => null) },
    });

    const result = await getPublicAskWaiver(deps, { askId: ASK_ID });

    expect(result).toEqual({
      waiverRequired: false,
      waiver: null,
      alreadyOnFile: false,
    });
  });

  // ── Gated reads ────────────────────────────────────────────────────────────

  it("returns the waiver body/metadata with alreadyOnFile: false for guests", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await getPublicAskWaiver(deps, { askId: ASK_ID });

    expect(result).toEqual({
      waiverRequired: true,
      waiver: {
        id: WAIVER_TEMPLATE_ID,
        name: "Volunteer Waiver",
        body: "I assume all risk.",
        version: 2,
      },
      alreadyOnFile: false,
    });
    // Guests never trigger the acceptance lookup (anti-oracle).
    expect(
      (txRepos.volunteerWaiverAcceptances as any).findCurrentForHuman,
    ).not.toHaveBeenCalled();
  });

  it("returns alreadyOnFile: false for a signed-in viewer with nothing on file", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await getPublicAskWaiver(deps, {
      askId: ASK_ID,
      actorHumanId: HUMAN_ID,
    });

    expect(result.waiverRequired).toBe(true);
    expect(result.alreadyOnFile).toBe(false);
    expect(
      (txRepos.volunteerWaiverAcceptances as any).findCurrentForHuman,
    ).toHaveBeenCalledWith(HUMAN_ID, WAIVER_TEMPLATE_ID, 2);
  });

  it("returns alreadyOnFile: true for a signed-in viewer with a current acceptance", async () => {
    const { deps } = makeDeps({
      volunteerWaiverAcceptances: {
        findCurrentForHuman: vi.fn(async () => onFileAcceptance),
      },
    });

    const result = await getPublicAskWaiver(deps, {
      askId: ASK_ID,
      actorHumanId: HUMAN_ID,
    });

    expect(result.waiverRequired).toBe(true);
    expect(result.alreadyOnFile).toBe(true);
  });

  it("rejects malformed input at parse time", async () => {
    const { deps } = makeDeps();

    await expect(
      getPublicAskWaiver(deps, { askId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
