import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";

import { expireEventApplications } from "../expire-event-applications";

const NOW = new Date("2026-08-11T03:00:00Z");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function createDeps() {
  const eventApplications = {
    expireSubmissionsForClosedForms: vi
      .fn()
      .mockResolvedValue({ count: 0, ids: [] }),
  };
  const audit = { log: vi.fn() };

  const txRepos = { eventApplications, audit } as unknown as TxRepos;
  const repos = {
    eventApplications,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Pick<Repos, "tx" | "eventApplications" | "audit">;

  const clock: ClockPort = { now: vi.fn(() => NOW) };

  const info = vi.fn();
  const logger: LoggerPort = {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as LoggerPort;

  return { repos, eventApplications, audit, clock, logger, info };
}

describe("expireEventApplications", () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    deps = createDeps();
  });

  it("passes the closesAt + 7-day-grace cutoff to the batch repo method", async () => {
    deps.eventApplications.expireSubmissionsForClosedForms.mockResolvedValue({
      count: 3,
      ids: ["a", "b", "c"],
    });

    const result = await expireEventApplications({
      repos: deps.repos,
      clock: deps.clock,
      logger: deps.logger,
    });

    // Grace boundary: cutoff = now - 7d. The adapter applies STRICT `lt`
    // against form.closesAt, so a form that closed exactly 7 days ago is
    // NOT yet past the grace window.
    expect(
      deps.eventApplications.expireSubmissionsForClosedForms,
    ).toHaveBeenCalledTimes(1);
    expect(
      deps.eventApplications.expireSubmissionsForClosedForms,
    ).toHaveBeenCalledWith({
      cutoff: new Date(NOW.getTime() - SEVEN_DAYS_MS),
      // Open calls Q12 / FR-004: the sweep only ever targets ATTEND forms.
      purpose: "ATTEND",
    });
    expect(result).toEqual({ expiredCount: 3 });
    expect(deps.info).toHaveBeenCalledWith(
      "events.applications_expired",
      expect.objectContaining({ expiredCount: 3 }),
    );
  });

  it("writes ONE batch audit row naming the expired ids", async () => {
    deps.eventApplications.expireSubmissionsForClosedForms.mockResolvedValue({
      count: 2,
      ids: ["a", "b"],
    });

    await expireEventApplications({
      repos: deps.repos,
      clock: deps.clock,
      logger: deps.logger,
    });

    expect(deps.audit.log).toHaveBeenCalledTimes(1);
    expect(deps.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: null,
        action: "event_application.expired_batch",
        data: expect.objectContaining({ count: 2, ids: ["a", "b"] }),
        at: NOW,
      }),
    );
  });

  it("skips the audit row when nothing expired", async () => {
    const result = await expireEventApplications({
      repos: deps.repos,
      clock: deps.clock,
      logger: deps.logger,
    });

    expect(result).toEqual({ expiredCount: 0 });
    expect(deps.audit.log).not.toHaveBeenCalled();
  });

  it("honors an explicit graceDays override", async () => {
    await expireEventApplications(
      { repos: deps.repos, clock: deps.clock, logger: deps.logger },
      { graceDays: 0 },
    );

    expect(
      deps.eventApplications.expireSubmissionsForClosedForms,
    ).toHaveBeenCalledWith({ cutoff: NOW, purpose: "ATTEND" });
  });

  it("rejects unknown input keys (strict schema)", async () => {
    await expect(
      expireEventApplications(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        { graceDays: 7, unexpected: true },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
