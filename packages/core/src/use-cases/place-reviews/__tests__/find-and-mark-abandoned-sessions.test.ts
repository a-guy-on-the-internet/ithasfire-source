import { describe, expect, it, vi } from "vitest";

import {
  findAndMarkAbandonedSessions,
  type FindAndMarkAbandonedSessionsDeps,
} from "../find-and-mark-abandoned-sessions";

// F16 (2026-09-29): one abandonment reminder per address per day.

const PLACE = "91000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-29T12:00:00.000Z");

function session(id: string, email: string | null) {
  return {
    id,
    sessionToken: `${id}-token`,
    placeId: PLACE,
    email,
    lastStepKey: null,
    pageReached: 1,
  };
}

function makeDeps(
  rows: ReturnType<typeof session>[],
  consume: FindAndMarkAbandonedSessionsDeps["rateLimit"]["consume"],
) {
  const markAbandonmentEmailSent = vi.fn(async () => undefined);
  const reportError = vi.fn();
  const deps = {
    repos: {
      placeReviewSessions: {
        findAbandoned: vi.fn(async () => rows),
        markAbandonmentEmailSent,
      },
      places: { getById: vi.fn(async () => ({ id: PLACE, name: "The Room" })) },
    },
    clock: { now: () => NOW },
    rateLimit: { consume },
    reportError,
  } as unknown as FindAndMarkAbandonedSessionsDeps;
  return { deps, markAbandonmentEmailSent, reportError };
}

describe("findAndMarkAbandonedSessions per-address cap", () => {
  it("returns one reminder per address and marks the capped duplicates", async () => {
    const spent = new Set<string>();
    const consume = vi.fn(async (key: string) => {
      const allowed = !spent.has(key);
      spent.add(key);
      return { allowed, remaining: allowed ? 0 : 0, retryAfterSeconds: 0 };
    });
    const { deps, markAbandonmentEmailSent } = makeDeps(
      [
        session("s1", "victim@example.com"),
        session("s2", "Victim@Example.com "),
        session("s3", "other@example.com"),
      ],
      consume,
    );

    const out = await findAndMarkAbandonedSessions(deps, {});
    expect(out.sessions.map((s) => s.sessionId)).toEqual(["s1", "s3"]);
    // The capped duplicate is marked so it never resurfaces.
    expect(markAbandonmentEmailSent).toHaveBeenCalledWith("s2");
    expect(markAbandonmentEmailSent).toHaveBeenCalledTimes(3);
    // Keys are hashed: no raw address in Redis.
    expect(consume.mock.calls[0]?.[0]).not.toContain("example.com");
    expect(consume.mock.calls[0]?.[0]).toBe(consume.mock.calls[1]?.[0]);
  });

  it("sends nothing and reports when the limiter fails", async () => {
    const boom = new Error("redis down");
    const { deps, reportError } = makeDeps(
      [session("s1", "a@example.com")],
      vi.fn(async () => Promise.reject(boom)),
    );

    const out = await findAndMarkAbandonedSessions(deps, {});
    expect(out.sessions).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ area: "abandonment_email_cap" }),
      }),
    );
  });
});
