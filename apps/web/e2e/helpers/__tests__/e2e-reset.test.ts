import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetE2eState } from "../e2e-reset";

/**
 * `/e2e/reset` is a full `deleteMany({})` across the API's database. These
 * cover the guard that stops it running against a stack the operator asked the
 * harness to REUSE — see the note on `resetE2eState`.
 */
describe("resetE2eState live-stack guard", () => {
  const saved = { ...process.env };

  // Reaching the network means the guard let the call through.
  const NETWORK = "SENTINEL_REACHED_NETWORK";
  const request = {
    post: () => Promise.reject(new Error(NETWORK)),
  } as never;

  beforeEach(() => {
    delete process.env.E2E_USE_LIVE_STACK;
    delete process.env.E2E_ALLOW_LIVE_RESET;
    // Keep the retry loop from burning its default 20s on the pass-through cases.
    process.env.E2E_RESET_TIMEOUT_MS = "150";
    process.env.E2E_RESET_RETRY_DELAY_MS = "10";
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("refuses to wipe when reusing a live stack", async () => {
    process.env.E2E_USE_LIVE_STACK = "1";

    await expect(
      resetE2eState(request, "http://localhost:3001"),
    ).rejects.toThrow(/Refusing to wipe the database of a live stack/);
  });

  it("names the escape hatch so the message is actionable", async () => {
    process.env.E2E_USE_LIVE_STACK = "1";

    await expect(
      resetE2eState(request, "http://localhost:3001"),
    ).rejects.toThrow(/E2E_ALLOW_LIVE_RESET=1/);
  });

  it("proceeds when the live-stack wipe is explicitly opted into", async () => {
    process.env.E2E_USE_LIVE_STACK = "1";
    process.env.E2E_ALLOW_LIVE_RESET = "1";

    await expect(
      resetE2eState(request, "http://localhost:3001"),
    ).rejects.toThrow(NETWORK);
  });

  it("proceeds on the disposable-stack path, where wiping is the point", async () => {
    await expect(
      resetE2eState(request, "http://localhost:3001"),
    ).rejects.toThrow(NETWORK);
  });
});
