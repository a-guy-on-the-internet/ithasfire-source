/**
 * sentry.server.config.ts / sentry.edge.config.ts delete `query_string` but
 * `request.url` still carries it. Both configs must redact bearer `token=`
 * values from events AND transactions (security review, 2026-09-29).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const initMock = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({ init: initMock }));
vi.mock("isbot", () => ({ isbot: () => false }));

type Hook = (event: Record<string, unknown>) => Record<string, unknown> | null;

async function hooksOf(path: "server" | "edge") {
  initMock.mockClear();
  vi.resetModules();
  if (path === "server") await import("../../../../sentry.server.config");
  else await import("../../../../sentry.edge.config");
  const cfg = initMock.mock.calls.at(-1)?.[0] as {
    beforeSend: Hook;
    beforeSendTransaction?: Hook;
  };
  return cfg;
}

const leakyEvent = () => ({
  request: {
    url: "https://ithasfire.com/invite/accept?token=SECRET1",
    query_string: "token=SECRET1",
    headers: { referer: "https://ithasfire.com/delegate/accept?token=SECRET2" },
  },
  transaction: "GET /sign-in?redirect=%2Finvite%2Faccept%3Ftoken%3DSECRET3",
  breadcrumbs: [{ data: { url: "/delegate/accept?token=SECRET4" } }],
});

describe.each(["server", "edge"] as const)("sentry.%s.config token scrub", (which) => {
  beforeEach(() => {
    process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";
  });

  it("beforeSend redacts request.url, the name and breadcrumbs", async () => {
    const { beforeSend } = await hooksOf(which);
    const out = beforeSend(leakyEvent());
    expect(JSON.stringify(out)).not.toMatch(/SECRET[1-4]/);
  });

  it("beforeSendTransaction exists and redacts the same", async () => {
    const { beforeSendTransaction } = await hooksOf(which);
    expect(beforeSendTransaction).toBeTypeOf("function");
    const out = beforeSendTransaction!(leakyEvent());
    expect(JSON.stringify(out)).not.toMatch(/SECRET[1-4]/);
  });
});

// beforeSendTransaction also runs the location scrub (a server render that
// holds a Place row puts it in trace context data and breadcrumbs). Pattern:
// apps/jobs/src/__tests__/instrument-before-send.test.ts.
describe("sentry.server.config location scrub on transactions", () => {
  const PLACE = {
    id: "place-1",
    name: "Hidden House",
    address: "1412 Holly St",
    addrLine1: "1412 Holly St",
    city: "Nashville",
    region: "TN",
    postcode: "37206",
    lat: 36.1771,
    lng: -86.7389,
    phone: "+1 615 555 0199",
    locationMode: "OBSCURED",
  };
  const TRUTH = ["1412 Holly", "37206", "36.1771", "-86.7389", "555 0199"];

  beforeEach(() => {
    process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";
  });

  it("a Place in contexts.trace.data and in a breadcrumb leaves no street, pin or phone", async () => {
    const { beforeSendTransaction } = await hooksOf("server");
    const sent = beforeSendTransaction!({
      transaction: "GET /places/hidden-house",
      contexts: { trace: { trace_id: "abc", data: { place: PLACE } } },
      breadcrumbs: [
        { category: "render", data: { place: PLACE } },
        {
          category: "prisma",
          message: `place.update failed: { lat: ${PLACE.lat}, lng: ${PLACE.lng}, phone: "${PLACE.phone}" }`,
        },
      ],
    }) as Record<string, any>;

    const text = JSON.stringify(sent);
    for (const needle of TRUTH) expect(text).not.toContain(needle);
    expect(sent.contexts.trace.trace_id).toBe("abc");
    expect(sent.contexts.trace.data.place).toMatchObject({
      id: "place-1",
      city: "Nashville",
    });
    expect(sent.breadcrumbs[1].message).toContain("place.update failed");
  });
});
