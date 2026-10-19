import { beforeEach, describe, expect, it, vi } from "vitest";

import { isAppError } from "@th/errors";

import { createJobHandle, resetJobRegistryCaches } from "../registry";
import { JOB_MODULE_LOADERS } from "../modules";

vi.mock("../modules", () => ({
  JOB_MODULE_LOADERS: {
    tickets: vi.fn(),
  },
  JOB_MODULE_IDS: ["tickets"],
}));

const loadTickets = JOB_MODULE_LOADERS.tickets as unknown as ReturnType<
  typeof vi.fn
>;

const ENTRY = {
  module: "tickets" as const,
  name: "tickets.release-expired-holds",
  description: "Release seat holds that have exceeded their TTL.",
} as unknown as Parameters<typeof createJobHandle>[0];

function makeDefinition(name = ENTRY.name) {
  return {
    name,
    input: { parse: vi.fn((value: unknown) => value) },
    handler: vi.fn(async () => ({ ok: true })),
  };
}

describe("job registry / lazy handler loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJobRegistryCaches();
  });

  it("does not import the handler module until load() is called", async () => {
    const handle = createJobHandle(ENTRY);

    // Building the handle — which is all `allJobs` / `getJob` do — must be free.
    expect(handle.name).toBe(ENTRY.name);
    expect(handle.description).toBe(ENTRY.description);
    expect(loadTickets).not.toHaveBeenCalled();

    const definition = makeDefinition();
    loadTickets.mockResolvedValue([definition]);

    await expect(handle.load()).resolves.toBe(definition);
    expect(loadTickets).toHaveBeenCalledTimes(1);
  });

  it("imports a repeatedly-invoked job's module exactly once", async () => {
    const definition = makeDefinition();
    loadTickets.mockResolvedValue([definition]);

    const handle = createJobHandle(ENTRY);
    await handle.load();
    await handle.load();
    await handle.load();

    expect(loadTickets).toHaveBeenCalledTimes(1);
  });

  it("shares one import between two jobs in the same module", async () => {
    const first = makeDefinition("tickets.release-expired-holds");
    const second = makeDefinition("tickets.release-expired-carts");
    loadTickets.mockResolvedValue([first, second]);

    const holds = createJobHandle(ENTRY);
    const carts = createJobHandle({
      ...ENTRY,
      name: "tickets.release-expired-carts",
    });

    await expect(holds.load()).resolves.toBe(first);
    await expect(carts.load()).resolves.toBe(second);
    expect(loadTickets).toHaveBeenCalledTimes(1);
  });

  it("invalidates a handle's memo on reset, not just the module map", async () => {
    // Regression guard for the reset seam itself: clearing `moduleCache` alone
    // left an ALREADY-BUILT handle holding its old resolved promise, and the
    // suite only looked correct because `vi.resetModules()` happened to throw
    // the handle away too. Same handle across the reset here, deliberately.
    const first = makeDefinition();
    loadTickets.mockResolvedValue([first]);

    const handle = createJobHandle(ENTRY);
    await expect(handle.load()).resolves.toBe(first);
    expect(loadTickets).toHaveBeenCalledTimes(1);

    resetJobRegistryCaches();

    const second = makeDefinition();
    loadTickets.mockResolvedValue([second]);

    await expect(handle.load()).resolves.toBe(second);
    expect(loadTickets).toHaveBeenCalledTimes(2);
  });

  it("fails that job with a typed error when its module will not import", async () => {
    const cause = new Error("Cannot find module './tickets'");
    loadTickets.mockRejectedValue(cause);

    const handle = createJobHandle(ENTRY);

    const err = await handle.load().catch((e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("JOB_MODULE_LOAD_FAILED");
    expect((err as { meta?: Record<string, unknown> }).meta).toEqual({
      job: ENTRY.name,
      module: "tickets",
    });
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });

  it("does not cache an import failure — a later invocation retries", async () => {
    loadTickets.mockRejectedValueOnce(new Error("transient"));
    const definition = makeDefinition();
    loadTickets.mockResolvedValueOnce([definition]);

    const handle = createJobHandle(ENTRY);

    await expect(handle.load()).rejects.toMatchObject({
      code: "JOB_MODULE_LOAD_FAILED",
    });
    await expect(handle.load()).resolves.toBe(definition);
    expect(loadTickets).toHaveBeenCalledTimes(2);
  });

  it("fails typed when the module loads but no longer defines the job", async () => {
    loadTickets.mockResolvedValue([makeDefinition("tickets.something-else")]);

    const handle = createJobHandle(ENTRY);

    const err = await handle.load().catch((e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("JOB_MODULE_LOAD_FAILED");
    expect((err as Error).message).toMatch(/generate:registry/);
  });
});
