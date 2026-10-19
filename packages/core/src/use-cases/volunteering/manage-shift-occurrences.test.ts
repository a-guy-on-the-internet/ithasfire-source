import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { NotifyOutput } from "../comms/notify";
import { renderNotification } from "../comms/renderers";

import {
  createShiftOccurrence,
  updateShiftOccurrence,
  cancelShiftOccurrence,
  listAskOccurrences,
  type ManageShiftOccurrencesDeps,
} from "./manage-shift-occurrences";

// ── Constants ────────────────────────────────────────────────────────────────

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const STRANGER_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000004";
const ASK_ID = "00000000-0000-4000-8000-000000000005";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const OCCURRENCE_ID = "00000000-0000-4000-8000-000000000020";
const NOW = new Date("2026-07-01T12:00:00.000Z");
const STARTS = new Date("2026-07-10T19:00:00.000Z");
const ENDS = new Date("2026-07-10T23:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseAsk = {
  id: ASK_ID,
  subjectType: "ORG" as const,
  subjectId: ORG_ID,
  orgId: ORG_ID,
  title: "Door help every Friday",
  description: null,
  status: "OPEN" as const,
  cadence: "RECURRING" as const,
  startsAt: null,
  endsAt: null,
  capacity: null,
  autoApprove: false,
  waiverRequired: false,
  waiverTemplateId: null,
  smsOptInEnabled: false,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const askRole = {
  id: ROLE_ID,
  eventId: null,
  askId: ASK_ID,
  templateId: null,
  name: "Door",
  description: null,
  capacity: null,
  autoApprove: null,
  defaultHours: null,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
  shifts: [],
};

const baseOccurrence = {
  id: OCCURRENCE_ID,
  askId: ASK_ID,
  roleId: ROLE_ID,
  patternId: null,
  startsAt: STARTS,
  endsAt: ENDS,
  capacity: 3,
  notes: null,
  status: "SCHEDULED" as const,
  createdAt: NOW,
  updatedAt: NOW,
};

const NOTIFY_RESULT: NotifyOutput = {
  ok: true,
  variant: "volunteer.occurrence-cancelled",
  category: "transactional",
  scope: { kind: "ORG", orgId: ORG_ID },
  inApp: { status: "skipped", reason: "no_adapter" },
};

const rosterRow = (over: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-000000000030",
  occurrenceId: OCCURRENCE_ID,
  signupId: "00000000-0000-4000-8000-000000000040",
  status: "CLAIMED",
  source: "SELF",
  checkedInAt: null,
  hoursWorked: null,
  createdAt: NOW,
  updatedAt: NOW,
  contactEmail: "vol@example.com",
  contactName: "Vol",
  humanId: "00000000-0000-4000-8000-000000000050",
  groupId: null,
  roleId: ROLE_ID,
  signupStatus: "APPROVED",
  ...over,
});

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeTxRepos(overrides: Record<string, unknown> = {}) {
  return {
    authz: {
      // Default: OWNER_ID is an ADMIN member; everyone else is a stranger.
      getOrgMembership: vi.fn(async ({ humanId }: { humanId: string }) =>
        humanId === OWNER_ID ? { role: "ADMIN" } : null,
      ),
    },
    volunteering: {
      getAsk: vi.fn(async () => baseAsk),
      getEventRole: vi.fn(async () => askRole),
      getOccurrence: vi.fn(async () => baseOccurrence),
      createOccurrence: vi.fn(async (input: any) => ({
        ...baseOccurrence,
        ...input,
        id: OCCURRENCE_ID,
      })),
      updateOccurrence: vi.fn(async (id: string, input: any) => ({
        ...baseOccurrence,
        ...input,
        id,
      })),
      listOccurrencesByAsk: vi.fn(async () => [
        { ...baseOccurrence, claimedCount: 1 },
      ]),
      listClaimsByOccurrence: vi.fn(async () => [rosterRow()]),
    },
    audit: { log: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function makeDeps(txOverrides: Record<string, unknown> = {}) {
  const txRepos = makeTxRepos(txOverrides);
  const notify = vi.fn(async () => NOTIFY_RESULT);
  const mailerSend = vi.fn(async () => ({ result: { success: true } }));
  const reportError = vi.fn();
  const deps: ManageShiftOccurrencesDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
    notify,
    mailer: { send: mailerSend } as any,
    appBaseUrl: "https://test.local",
    reportError,
  };
  return { deps, txRepos, notify, mailerSend, reportError };
}

// ── createShiftOccurrence ────────────────────────────────────────────────────

describe("createShiftOccurrence", () => {
  const validInput = {
    actorHumanId: OWNER_ID,
    askId: ASK_ID,
    roleId: ROLE_ID,
    startsAt: STARTS,
    endsAt: ENDS,
    capacity: 3,
  };

  it("owner creates a one-off occurrence and audits it", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await createShiftOccurrence(deps, validInput);

    expect(result.id).toBe(OCCURRENCE_ID);
    expect((txRepos.volunteering as any).createOccurrence).toHaveBeenCalledWith(
      {
        askId: ASK_ID,
        roleId: ROLE_ID,
        startsAt: STARTS,
        endsAt: ENDS,
        capacity: 3,
        notes: null,
      },
    );
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "volunteer_occurrence",
        action: "created",
      }),
    );
  });

  it("rejects endsAt <= startsAt at the schema level", async () => {
    const { deps } = makeDeps();
    await expect(
      createShiftOccurrence(deps, { ...validInput, endsAt: STARTS }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a window longer than 24h (Decimal(5,2) hours insurance)", async () => {
    const { deps } = makeDeps();
    await expect(
      createShiftOccurrence(deps, {
        ...validInput,
        // 24h + 1 minute.
        endsAt: new Date("2026-07-11T19:01:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // Exactly 24h is allowed (overnight slots).
    await expect(
      createShiftOccurrence(deps, {
        ...validInput,
        endsAt: new Date("2026-07-11T19:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ id: OCCURRENCE_ID });
  });

  it("404s an EVENT-subject ask (occurrences are standing-ask only)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getAsk = vi.fn(async () => ({
      ...baseAsk,
      subjectType: "EVENT",
    }));
    await expect(
      createShiftOccurrence(deps, validInput),
    ).rejects.toMatchObject({ message: "ask_not_found" });
  });

  it("404s a role that belongs to another ask (or an event role)", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getEventRole = vi.fn(async () => ({
      ...askRole,
      askId: "00000000-0000-4000-8000-00000000f00d",
    }));
    await expect(
      createShiftOccurrence(deps, validInput),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("denies a non-owner", async () => {
    const { deps } = makeDeps();
    await expect(
      createShiftOccurrence(deps, { ...validInput, actorHumanId: STRANGER_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ── updateShiftOccurrence ────────────────────────────────────────────────────

describe("updateShiftOccurrence", () => {
  it("patches time/capacity/notes and audits", async () => {
    const { deps, txRepos } = makeDeps();
    const newEnd = new Date("2026-07-11T00:00:00.000Z");

    const result = await updateShiftOccurrence(deps, {
      actorHumanId: OWNER_ID,
      occurrenceId: OCCURRENCE_ID,
      endsAt: newEnd,
      capacity: 5,
    });

    expect(result.capacity).toBe(5);
    expect((txRepos.volunteering as any).updateOccurrence).toHaveBeenCalledWith(
      OCCURRENCE_ID,
      { endsAt: newEnd, capacity: 5 },
    );
  });

  it("validates the MERGED window when only one bound arrives", async () => {
    const { deps } = makeDeps();
    // startsAt moved past the STORED endsAt.
    await expect(
      updateShiftOccurrence(deps, {
        actorHumanId: OWNER_ID,
        occurrenceId: OCCURRENCE_ID,
        startsAt: new Date("2026-07-10T23:30:00.000Z"),
      }),
    ).rejects.toMatchObject({ message: "ends_before_starts" });
  });

  it("rejects a MERGED window longer than 24h (one bound moved alone)", async () => {
    const { deps } = makeDeps();
    await expect(
      updateShiftOccurrence(deps, {
        actorHumanId: OWNER_ID,
        occurrenceId: OCCURRENCE_ID,
        // Stored startsAt is 2026-07-10T19:00Z — this end is 25h later.
        endsAt: new Date("2026-07-11T20:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ message: "window_too_long" });
  });

  it("refuses to edit a CANCELLED occurrence", async () => {
    const { deps, txRepos } = makeDeps();
    (txRepos.volunteering as any).getOccurrence = vi.fn(async () => ({
      ...baseOccurrence,
      status: "CANCELLED",
    }));
    await expect(
      updateShiftOccurrence(deps, {
        actorHumanId: OWNER_ID,
        occurrenceId: OCCURRENCE_ID,
        capacity: 9,
      }),
    ).rejects.toMatchObject({ message: "occurrence_cancelled" });
  });
});

// ── cancelShiftOccurrence ────────────────────────────────────────────────────

describe("cancelShiftOccurrence", () => {
  const input = { actorHumanId: OWNER_ID, occurrenceId: OCCURRENCE_ID };

  it("cancels, audits the claimant count, notifies each account-linked ACTIVE claimant and emails each SHADOW claimant", async () => {
    const { deps, txRepos, notify, mailerSend } = makeDeps();
    (txRepos.volunteering as any).listClaimsByOccurrence = vi.fn(async () => [
      rosterRow({ id: "claim-1", humanId: "00000000-0000-4000-8000-0000000000a1" }),
      // Withdrawn claim — not notified, not emailed.
      rosterRow({ id: "claim-2", status: "WITHDRAWN" }),
      // Shadow claimant (no account) — direct mailer send.
      rosterRow({
        id: "claim-3",
        humanId: null,
        contactEmail: "shadow@example.com",
        contactName: "Shadow Vol",
      }),
    ]);

    const result = await cancelShiftOccurrence(deps, input);

    expect(result.status).toBe("CANCELLED");
    expect((txRepos.volunteering as any).updateOccurrence).toHaveBeenCalledWith(
      OCCURRENCE_ID,
      { status: "CANCELLED" },
    );
    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cancelled",
        // Both ACTIVE claimants count (linked + shadow), withdrawn doesn't.
        data: expect.objectContaining({ claimantCount: 2 }),
      }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: "00000000-0000-4000-8000-0000000000a1",
        variant: "volunteer.occurrence-cancelled",
        scope: { kind: "ORG", orgId: ORG_ID },
        idempotencyKey: `${OCCURRENCE_ID}:cancelled:claim-1`,
        payload: expect.objectContaining({
          askId: ASK_ID,
          occurrenceId: OCCURRENCE_ID,
          roleName: "Door",
          askUrl: `https://test.local/v/${ASK_ID}`,
        }),
      }),
    );
    // Shadow leg: one direct mailer send, stable per-claim key.
    expect(mailerSend).toHaveBeenCalledTimes(1);
    expect(mailerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "shadow@example.com", name: "Shadow Vol" },
        idempotencyKey: "volunteer-occ-cancel:claim-3",
      }),
    );
  });

  it("replay on an already-CANCELLED occurrence skips flip + audit but RE-RUNS the fan-out (crash healing)", async () => {
    const { deps, txRepos, notify, mailerSend } = makeDeps();
    (txRepos.volunteering as any).getOccurrence = vi.fn(async () => ({
      ...baseOccurrence,
      status: "CANCELLED",
    }));
    (txRepos.volunteering as any).listClaimsByOccurrence = vi.fn(async () => [
      rosterRow({ id: "claim-1", humanId: "00000000-0000-4000-8000-0000000000a1" }),
      rosterRow({ id: "claim-3", humanId: null }),
    ]);

    const result = await cancelShiftOccurrence(deps, input);

    expect(result.status).toBe("CANCELLED");
    expect(
      (txRepos.volunteering as any).updateOccurrence,
    ).not.toHaveBeenCalled();
    expect((txRepos.audit as any).log).not.toHaveBeenCalled();
    // The fan-out re-runs — notify()'s / the mailer's stable idempotency
    // keys dedupe already-delivered sends, so a crash mid-fan-out is
    // repaired by cancelling again.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `${OCCURRENCE_ID}:cancelled:claim-1`,
      }),
    );
    expect(mailerSend).toHaveBeenCalledTimes(1);
  });

  it("swallows a notify failure (cancellation persists) and reports it", async () => {
    const { deps, notify, reportError } = makeDeps();
    notify.mockRejectedValueOnce(new Error("smtp down"));

    const result = await cancelShiftOccurrence(deps, input);

    expect(result.status).toBe("CANCELLED");
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("shadow email with an unconfigured mailer is swallowed + reported; linked notify still goes", async () => {
    const { deps, txRepos, notify, reportError } = makeDeps();
    deps.mailer = null;
    (txRepos.volunteering as any).listClaimsByOccurrence = vi.fn(async () => [
      rosterRow({ id: "claim-1", humanId: "00000000-0000-4000-8000-0000000000a1" }),
      rosterRow({ id: "claim-3", humanId: null }),
    ]);

    const result = await cancelShiftOccurrence(deps, input);

    expect(result.status).toBe("CANCELLED");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: expect.objectContaining({ stage: "shadow_email" }),
    });
  });

  it("unset appBaseUrl: skips the notify() leg with a reported config warning; shadow email sends without the link", async () => {
    const { deps, txRepos, notify, mailerSend, reportError } = makeDeps();
    deps.appBaseUrl = null;
    (txRepos.volunteering as any).listClaimsByOccurrence = vi.fn(async () => [
      rosterRow({ id: "claim-1", humanId: "00000000-0000-4000-8000-0000000000a1" }),
      rosterRow({ id: "claim-3", humanId: null, contactEmail: "shadow@example.com" }),
    ]);

    const result = await cancelShiftOccurrence(deps, input);

    expect(result.status).toBe("CANCELLED");
    // No notify send: a non-URL askUrl would fail the strict renderer
    // schema on every recipient — skipped once, loudly, instead.
    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    // Shadow leg needs no URL — still sends, link line omitted.
    expect(mailerSend).toHaveBeenCalledTimes(1);
    const sent = mailerSend.mock.calls[0]![0] as any;
    expect(sent.text).not.toContain("View the schedule");
  });
});

// ── listAskOccurrences ───────────────────────────────────────────────────────

describe("listAskOccurrences", () => {
  it("returns the ask's occurrences with claim counts for the owner", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await listAskOccurrences(deps, {
      actorHumanId: OWNER_ID,
      askId: ASK_ID,
      status: "SCHEDULED",
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.claimedCount).toBe(1);
    expect(
      (txRepos.volunteering as any).listOccurrencesByAsk,
    ).toHaveBeenCalledWith(ASK_ID, expect.objectContaining({ status: "SCHEDULED" }));
  });

  it("denies a non-owner", async () => {
    const { deps } = makeDeps();
    await expect(
      listAskOccurrences(deps, { actorHumanId: STRANGER_ID, askId: ASK_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// ── cancelShiftOccurrence: the time zone the notice reads in ────────────────

describe("cancelShiftOccurrence time zone", () => {
  const input = { actorHumanId: OWNER_ID, occurrenceId: OCCURRENCE_ID };
  const PLACE_ID = "00000000-0000-4000-8000-000000000060";
  const placeAsk = { ...baseAsk, subjectType: "PLACE" as const, subjectId: PLACE_ID };
  const place = (timezone: string | null) => ({
    id: PLACE_ID,
    humanIdsWithAccess: [OWNER_ID],
    orgIdsWithAccess: [],
    timezone,
  });

  it("a PLACE ask passes the place's zone to the notice", async () => {
    const { deps, txRepos, notify } = makeDeps({
      places: { getById: vi.fn(async () => place("America/Chicago")) },
    });
    (txRepos.volunteering as any).getAsk = vi.fn(async () => placeAsk);

    await cancelShiftOccurrence(deps, input);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "volunteer.occurrence-cancelled",
        payload: expect.objectContaining({ timezone: "America/Chicago" }),
      }),
    );
  });

  it("a PLACE with no zone, and an ORG ask, omit it (the notice reads in the platform default)", async () => {
    const placeless = makeDeps({
      places: { getById: vi.fn(async () => place(null)) },
    });
    (placeless.txRepos.volunteering as any).getAsk = vi.fn(async () => placeAsk);
    await cancelShiftOccurrence(placeless.deps, input);

    const org = makeDeps();
    await cancelShiftOccurrence(org.deps, input);

    for (const notify of [placeless.notify, org.notify]) {
      expect(notify).toHaveBeenCalledTimes(1);
      const payload = (notify.mock.calls[0] as any[])[0].payload;
      expect("timezone" in payload).toBe(false);
    }
  });

  it("omits a zone longer than the renderer's max(100) and still sends", async () => {
    const { deps, txRepos, notify } = makeDeps({
      places: { getById: vi.fn(async () => place("A".repeat(101))) },
    });
    (txRepos.volunteering as any).getAsk = vi.fn(async () => placeAsk);

    await cancelShiftOccurrence(deps, input);

    expect(notify).toHaveBeenCalledTimes(1);
    const { variant, payload } = (notify.mock.calls[0] as any[])[0];
    expect("timezone" in payload).toBe(false);
    // The stored payload passes the strict renderer schema.
    expect(() =>
      renderNotification(variant, payload, { now: new Date() }),
    ).not.toThrow();
  });

  const shadowRoster = (txRepos: any) => {
    txRepos.volunteering.listClaimsByOccurrence = vi.fn(async () => [
      rosterRow({
        id: "claim-3",
        humanId: null,
        contactEmail: "shadow@example.com",
        contactName: "Shadow Vol",
      }),
    ]);
  };

  it("the shadow email reads the start in the place's local time when the zone is known", async () => {
    const { deps, txRepos, mailerSend } = makeDeps({
      places: { getById: vi.fn(async () => place("America/Chicago")) },
    });
    (txRepos.volunteering as any).getAsk = vi.fn(async () => placeAsk);
    shadowRoster(txRepos);

    await cancelShiftOccurrence(deps, input);

    expect(mailerSend).toHaveBeenCalledTimes(1);
    const text = ((mailerSend.mock.calls[0] as any[])[0].text as string).replace(
      /[  ]/gu,
      " ",
    );
    expect(text).toContain("Fri, Jul 10, 2026, 2:00 PM CDT");
    expect(text).not.toContain(STARTS.toUTCString());
  });

  // It used to print the server's UTC string, which names the wrong day for
  // an evening shift; the platform default zone matches every other date.
  it("the shadow email reads in the platform default zone when no zone is known", async () => {
    // 9 PM CDT Fri Jul 10 = 02:00Z Sat Jul 11: the UTC string named Saturday.
    const evening = {
      ...baseOccurrence,
      startsAt: new Date("2026-07-11T02:00:00.000Z"),
      endsAt: new Date("2026-07-11T04:00:00.000Z"),
    };
    const { deps, txRepos, mailerSend } = makeDeps();
    (txRepos.volunteering as any).getOccurrence = vi.fn(async () => evening);
    (txRepos.volunteering as any).updateOccurrence = vi.fn(
      async (id: string, patch: any) => ({ ...evening, ...patch, id }),
    );
    shadowRoster(txRepos);

    await cancelShiftOccurrence(deps, input);

    expect(mailerSend).toHaveBeenCalledTimes(1);
    const text = ((mailerSend.mock.calls[0] as any[])[0].text as string).replace(
      /[  ]/gu,
      " ",
    );
    expect(text).toContain("Fri, Jul 10, 2026, 9:00 PM CDT");
    expect(text).not.toContain("Sat, 11 Jul 2026");
  });
});
