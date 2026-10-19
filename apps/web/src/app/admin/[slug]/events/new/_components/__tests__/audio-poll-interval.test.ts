import { describe, it, expect, vi } from "vitest";

// The hook module pulls in the tRPC client at import time; only the pure
// interval helper is under test here.
vi.mock("@/trpc", () => ({ trpc: {} }));

const { nextAudioPollInterval } = await import("../useEventMediaMaps");

const NOW = new Date("2026-09-03T12:00:00.000Z").getTime();
const agoMs = (ms: number) => new Date(NOW - ms);

const pending = (ageMs: number, status = "TRANSCODING") => ({
  status,
  createdAt: agoMs(ageMs),
});

describe("nextAudioPollInterval", () => {
  it("stops polling entirely when there is no audio", () => {
    expect(nextAudioPollInterval(undefined, NOW)).toBe(false);
    expect(nextAudioPollInterval({ items: [] }, NOW)).toBe(false);
  });

  it("stops polling once every item is terminal", () => {
    const data = {
      items: [pending(1_000, "READY"), pending(1_000, "FAILED")],
    };
    // Load-bearing: without this the editor hits the API forever.
    expect(nextAudioPollInterval(data, NOW)).toBe(false);
  });

  it("polls every 2s for the first 30s of a pending upload", () => {
    expect(nextAudioPollInterval({ items: [pending(0)] }, NOW)).toBe(2_000);
    expect(nextAudioPollInterval({ items: [pending(29_999)] }, NOW)).toBe(2_000);
  });

  it("backs off to 5s from 30s until 2 minutes", () => {
    expect(nextAudioPollInterval({ items: [pending(30_000)] }, NOW)).toBe(5_000);
    expect(nextAudioPollInterval({ items: [pending(119_999)] }, NOW)).toBe(
      5_000,
    );
  });

  it("settles at 10s past 2 minutes", () => {
    expect(nextAudioPollInterval({ items: [pending(120_000)] }, NOW)).toBe(
      10_000,
    );
    expect(nextAudioPollInterval({ items: [pending(60 * 60_000)] }, NOW)).toBe(
      10_000,
    );
  });

  it("uses the youngest PENDING item, ignoring old terminal ones", () => {
    const data = {
      items: [
        pending(10 * 60_000, "READY"), // long done, must not slow the ramp
        pending(5 * 60_000), // old, still pending
        pending(3_000), // just uploaded — sets the tempo
      ],
    };
    expect(nextAudioPollInterval(data, NOW)).toBe(2_000);
  });

  it("ignores terminal items when picking the age", () => {
    const data = {
      items: [
        pending(1_000, "READY"), // young but DONE
        pending(5 * 60_000, "TRANSCODING"), // the only pending one
      ],
    };
    expect(nextAudioPollInterval(data, NOW)).toBe(10_000);
  });

  it("accepts serialized string timestamps as well as Dates", () => {
    const data = {
      items: [{ status: "UPLOADED", createdAt: agoMs(1_000).toISOString() }],
    };
    expect(nextAudioPollInterval(data, NOW)).toBe(2_000);
  });

  it("falls back to the old flat 10s when no pending item has a usable timestamp", () => {
    expect(
      nextAudioPollInterval({ items: [{ status: "PENDING" }] }, NOW),
    ).toBe(10_000);
    expect(
      nextAudioPollInterval(
        { items: [{ status: "PENDING", createdAt: "not-a-date" }] },
        NOW,
      ),
    ).toBe(10_000);
    expect(
      nextAudioPollInterval(
        { items: [{ status: "PENDING", createdAt: null }] },
        NOW,
      ),
    ).toBe(10_000);
  });

  it("treats every non-terminal status as pending", () => {
    for (const status of ["PENDING", "UPLOADED", "TRANSCODING"]) {
      expect(
        nextAudioPollInterval({ items: [pending(0, status)] }, NOW),
      ).toBe(2_000);
    }
  });
});
