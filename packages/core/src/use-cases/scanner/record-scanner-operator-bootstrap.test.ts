import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos, TxRepos } from "@th/ports/repos";

import { recordScannerOperatorBootstrap } from "./record-scanner-operator-bootstrap";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "00000000-0000-4000-8000-0000000000a2";
const NOW = new Date("2026-06-01T12:00:00.000Z");

const ORG_ID = "00000000-0000-4000-8000-0000000000b1";

function makeDeps(
  opts: {
    event?: { id: string; orgId: string | null } | null;
    role?: string | null;
    staff?: boolean;
  } = {},
) {
  const tx = {
    audit: { log: vi.fn(async () => undefined) },
  };
  const event =
    opts.event === undefined ? { id: EVENT_ID, orgId: ORG_ID } : opts.event;
  const role = opts.role === undefined ? "SCANNER" : opts.role;
  const repos = {
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
      fn(tx as unknown as TxRepos),
    ),
    events: { getById: vi.fn(async () => event) },
    authz: {
      getOrgMembership: vi.fn(async () => (role ? { role } : null)),
    },
  };
  const authz = {
    hasStaffRole: vi.fn(async () => ({ allowed: Boolean(opts.staff) })),
  };
  return {
    deps: {
      repos: repos as unknown as Repos,
      authz: authz as unknown as AuthZPort,
      clock: { now: () => NOW },
    },
    tx,
    mocks: repos,
  };
}

describe("recordScannerOperatorBootstrap", () => {
  it("writes a single audit-log entry on success", async () => {
    const { deps, tx } = makeDeps();

    const result = await recordScannerOperatorBootstrap(deps, {
      actorHumanId: ACTOR,
      appVersion: "0.4.2",
      channel: "pilot",
      outcome: "success",
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ ok: true });
    expect(tx.audit.log).toHaveBeenCalledTimes(1);
    expect(tx.audit.log).toHaveBeenCalledWith({
      entity: "scanner_operator",
      entityId: ACTOR,
      action: "scanner.bootstrap",
      at: NOW,
      data: {
        appVersion: "0.4.2",
        channel: "pilot",
        outcome: "success",
        eventId: EVENT_ID,
        failureReason: null,
      },
    });
  });

  it("captures failureReason when outcome is failure", async () => {
    const { deps, tx } = makeDeps();

    await recordScannerOperatorBootstrap(deps, {
      actorHumanId: ACTOR,
      appVersion: "0.4.2",
      channel: "production",
      outcome: "failure",
      failureReason: "camera_permission_denied",
    });

    expect(tx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: "failure",
          failureReason: "camera_permission_denied",
          eventId: null,
        }),
      }),
    );
  });

  // F16 (2026-09-29): an audit row only NAMES an event the actor may scan.
  // A rejected eventId is dropped and flagged; the telemetry row survives.
  it.each([
    ["no scanner role", { role: null }],
    ["unknown event", { event: null }],
    ["personal (non-org) event", { event: { id: EVENT_ID, orgId: null } }],
  ] as const)(
    "records the bootstrap with eventId:null for %s",
    async (_label, opts) => {
      const { deps, tx } = makeDeps(opts as Parameters<typeof makeDeps>[0]);

      await expect(
        recordScannerOperatorBootstrap(deps, {
          actorHumanId: ACTOR,
          appVersion: "0.4.2",
          channel: "production",
          outcome: "success",
          eventId: EVENT_ID,
        }),
      ).resolves.toEqual({ ok: true });
      expect(tx.audit.log).toHaveBeenCalledTimes(1);
      expect(tx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventId: null,
            eventIdRejected: true,
            outcome: "success",
          }),
        }),
      );
    },
  );

  // A platform ADMIN with no second factor has no override, so the saved
  // eventId is one they cannot scan: dropped and flagged like any other
  // denial, and the telemetry row survives.
  it("records the bootstrap with eventId:null for a non-member ADMIN with no second factor", async () => {
    const { deps, tx } = makeDeps({ role: null });
    (deps.authz.hasStaffRole as any).mockResolvedValueOnce({
      allowed: false,
      secondFactorRequired: true,
    });

    await expect(
      recordScannerOperatorBootstrap(deps, {
        actorHumanId: ACTOR,
        appVersion: "0.4.2",
        channel: "production",
        outcome: "success",
        eventId: EVENT_ID,
      }),
    ).resolves.toEqual({ ok: true });
    expect(tx.audit.log).toHaveBeenCalledTimes(1);
    expect(tx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: null,
          eventIdRejected: true,
        }),
      }),
    );
  });

  it("still throws a non-access failure (e.g. a DB error) from the gate", async () => {
    const { deps, tx, mocks } = makeDeps();
    (mocks.events.getById as any).mockRejectedValueOnce(new Error("db down"));

    await expect(
      recordScannerOperatorBootstrap(deps, {
        actorHumanId: ACTOR,
        appVersion: "0.4.2",
        channel: "production",
        outcome: "success",
        eventId: EVENT_ID,
      }),
    ).rejects.toThrow("db down");
    expect(tx.audit.log).not.toHaveBeenCalled();
  });

  it("does not need an event check when no eventId is sent", async () => {
    const { deps, tx, mocks } = makeDeps({ role: null });

    await recordScannerOperatorBootstrap(deps, {
      actorHumanId: ACTOR,
      appVersion: "0.4.2",
      channel: "production",
      outcome: "failure",
      failureReason: "no_scanner_role",
    });
    expect(mocks.events.getById).not.toHaveBeenCalled();
    expect(tx.audit.log).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid input", async () => {
    const { deps } = makeDeps();

    await expect(
      recordScannerOperatorBootstrap(deps, {
        actorHumanId: ACTOR,
        appVersion: "0.4.2",
        channel: "pilot",
        outcome: "succeeded", // invalid
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects unknown channel", async () => {
    const { deps } = makeDeps();

    await expect(
      recordScannerOperatorBootstrap(deps, {
        actorHumanId: ACTOR,
        appVersion: "0.4.2",
        channel: "canary",
        outcome: "success",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
