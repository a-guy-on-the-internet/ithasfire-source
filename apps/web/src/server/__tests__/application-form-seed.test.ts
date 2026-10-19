/**
 * `fetchPublicApplicationFormSeed`: the application gate's form definition,
 * read on the server so the gated page paints the form instead of a loading
 * line that grows into it.
 *
 * The pins: it reads through the NO-IDENTITY client (the gated document is
 * edge-cached with no `Vary: Cookie`); dates cross the RSC boundary as ISO
 * strings; and every failure degrades to `null` (the client fetches it after
 * paint) and is REPORTED, except the use case's own EVENT_NOT_FOUND.
 */
import { TRPCClientError } from "@trpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureExceptionMock, publicFormQuery, serverClientMock } = vi.hoisted(
  () => ({
    captureExceptionMock: vi.fn(),
    publicFormQuery: vi.fn(),
    serverClientMock: vi.fn(),
  }),
);

vi.mock("@sentry/nextjs", () => ({
  captureException: captureExceptionMock,
}));

vi.mock("@/server/trpc-client", () => ({
  getPublicTrpcClient: () => ({
    events: { getPublicApplicationForm: { query: publicFormQuery } },
  }),
  // The identity client must never feed the edge-cached gated document.
  getServerTrpcClient: serverClientMock,
}));

import { fetchPublicApplicationFormSeed } from "@/server/events";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

const FORM = {
  eventId: EVENT_ID,
  introText: "Tell us about you",
  opensAt: new Date("2026-09-01T10:00:00.000Z"),
  closesAt: null,
  questions: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      type: "SHORT_TEXT" as const,
      label: "What will you bring?",
      description: null,
      options: null,
      isRequired: true,
      order: 0,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  captureExceptionMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("fetchPublicApplicationFormSeed", () => {
  it("reads through the anonymous client and sends dates as ISO strings", async () => {
    publicFormQuery.mockResolvedValue(FORM);

    const seed = await fetchPublicApplicationFormSeed(EVENT_ID);

    expect(publicFormQuery).toHaveBeenCalledWith({ eventId: EVENT_ID });
    expect(serverClientMock).not.toHaveBeenCalled();
    expect(seed?.form).toEqual({
      ...FORM,
      opensAt: "2026-09-01T10:00:00.000Z",
      closesAt: null,
    });
    expect(Number.isNaN(Date.parse(seed!.fetchedAt))).toBe(false);
    // Plain JSON all the way down: nothing Flight would have to special-case.
    expect(JSON.parse(JSON.stringify(seed))).toEqual(seed);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  /** A tRPC client error with the wire `data` the API actually sends. */
  const trpcError = (message: string, data: Record<string, unknown>) =>
    new TRPCClientError(message, {
      result: { error: { data } },
    } as never);

  it("degrades to null and reports a network failure", async () => {
    const err = new TypeError("fetch failed");
    publicFormQuery.mockRejectedValue(err);

    const seed = await fetchPublicApplicationFormSeed(EVENT_ID);

    expect(seed).toBeNull();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(err, {
      tags: { area: "event-gate-ssr", section: "applicationForm" },
      extra: { eventId: EVENT_ID },
    });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  /**
   * A per-visitor 429 is the limiter working; a crawl missing the edge must
   * collapse to ONE quiet issue, while a missing IP forward (every render in
   * one bucket) still shows as that issue's count climbing.
   */
  it("reports a rate limit at warning, under one fingerprint", async () => {
    const err = trpcError("Too many requests while loading application forms", {
      code: "TOO_MANY_REQUESTS",
      httpStatus: 429,
    });
    publicFormQuery.mockRejectedValue(err);

    const seed = await fetchPublicApplicationFormSeed(EVENT_ID);

    expect(seed).toBeNull();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(err, {
      tags: { area: "event-gate-ssr", section: "applicationForm" },
      extra: { eventId: EVENT_ID },
      level: "warning",
      fingerprint: ["event-gate-ssr", "applicationForm", "TOO_MANY_REQUESTS"],
    });
  });

  it("degrades to null WITHOUT a report on the use case's EVENT_NOT_FOUND (an ineligible event: missing, banned owner, not published, not application-gated, or no attendee form)", async () => {
    // The wire shape the API sends (measured against the dev API).
    publicFormQuery.mockRejectedValue(
      trpcError("EVENT_NOT_FOUND", {
        code: "NOT_FOUND",
        httpStatus: 404,
        path: "events.getPublicApplicationForm",
        meta: { appCode: "EVENT_NOT_FOUND" },
        appCode: "EVENT_NOT_FOUND",
      }),
    );

    const seed = await fetchPublicApplicationFormSeed(EVENT_ID);

    expect(seed).toBeNull();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("REPORTS tRPC's missing-procedure NOT_FOUND (web/API version skew)", async () => {
    // @trpc/server 11.5.1 `resolveResponse`: same NOT_FOUND code, no appCode.
    const err = trpcError(
      'No procedure found on path "events.getPublicApplicationForm"',
      {
        code: "NOT_FOUND",
        httpStatus: 404,
        path: "events.getPublicApplicationForm",
      },
    );
    publicFormQuery.mockRejectedValue(err);

    const seed = await fetchPublicApplicationFormSeed(EVENT_ID);

    expect(seed).toBeNull();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(err, {
      tags: { area: "event-gate-ssr", section: "applicationForm" },
      extra: { eventId: EVENT_ID },
    });
  });

  it("still degrades to null when the reporter itself throws", async () => {
    publicFormQuery.mockRejectedValue(new Error("down"));
    captureExceptionMock.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(fetchPublicApplicationFormSeed(EVENT_ID)).resolves.toBeNull();
  });
});
