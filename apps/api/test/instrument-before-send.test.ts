import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Defect 1 backstop: `beforeSend` must DROP expected domain errors (an
 * `AppError` mapping to a non-500 tRPC bucket — e.g. a 412
 * `PAID_TICKETING_REQUIRES_STRIPE`) so the pino integration can't turn an
 * error-level log of the thrown error into a handled Sentry issue, while
 * KEEPING genuine 500-bucket AppErrors and every non-AppError exception.
 */

const initMock = vi.fn();

vi.mock("@sentry/node", () => ({
  init: initMock,
  // The integration factories are called inline in `Sentry.init({ integrations })`
  // — stub them so the config object (and our `beforeSend`) is built.
  fastifyIntegration: vi.fn(() => ({ name: "Fastify" })),
  pinoIntegration: vi.fn(() => ({ name: "Pino" })),
}));

// `isbot` is exercised separately; default it to "not a bot" here so the UA
// branch never short-circuits the AppError classification under test.
vi.mock("isbot", () => ({
  isbot: () => false,
}));

type SentryEvent = {
  exception?: { values?: Array<{ type?: string; value?: string }> };
  request?: {
    headers?: Record<string, string>;
    url?: string;
    query_string?: string;
  };
  transaction?: string;
};
type BeforeSend = (event: SentryEvent) => SentryEvent | null;

async function loadSentryHooks(): Promise<{
  beforeSend: BeforeSend;
  beforeSendTransaction: BeforeSend;
}> {
  initMock.mockClear();
  vi.resetModules();
  process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";
  await import("../src/instrument");
  const config = initMock.mock.calls.at(-1)?.[0] as
    | { beforeSend?: BeforeSend; beforeSendTransaction?: BeforeSend }
    | undefined;
  const beforeSend = config?.beforeSend;
  if (!beforeSend) throw new Error("beforeSend was not configured");
  const beforeSendTransaction = config?.beforeSendTransaction;
  if (!beforeSendTransaction)
    throw new Error("beforeSendTransaction was not configured");
  return { beforeSend, beforeSendTransaction };
}

async function loadBeforeSend(): Promise<BeforeSend> {
  return (await loadSentryHooks()).beforeSend;
}

const appErrorEvent = (code: string): SentryEvent => ({
  exception: { values: [{ type: "AppError", value: code }] },
});

describe("instrument beforeSend AppError filter", () => {
  const prevDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = prevDsn;
  });

  it("drops an expected non-500 AppError (412 PAID_TICKETING_REQUIRES_STRIPE)", async () => {
    const beforeSend = await loadBeforeSend();
    expect(beforeSend(appErrorEvent("PAID_TICKETING_REQUIRES_STRIPE"))).toBeNull();
  });

  it.each(["EVENT_NOT_FOUND", "ORDER_NOT_REFUNDABLE", "NON_POSITIVE_AMOUNT"])(
    "drops the expected non-500 AppError %s",
    async (code) => {
      const beforeSend = await loadBeforeSend();
      expect(beforeSend(appErrorEvent(code))).toBeNull();
    },
  );

  it("keeps a genuine 500-bucket AppError (REFUND_FAILED)", async () => {
    const beforeSend = await loadBeforeSend();
    const event = appErrorEvent("REFUND_FAILED");
    expect(beforeSend(event)).toBe(event);
  });

  it("keeps an AppError with an unrecognized value (custom message)", async () => {
    const beforeSend = await loadBeforeSend();
    // A throw site that passed a human message: value is not a canonical code,
    // so we keep the event rather than risk hiding a real failure.
    const event = appErrorEvent("Stripe refund was rejected");
    expect(beforeSend(event)).toBe(event);
  });

  it("keeps a non-AppError exception", async () => {
    const beforeSend = await loadBeforeSend();
    const event: SentryEvent = {
      exception: { values: [{ type: "TypeError", value: "x is not a function" }] },
    };
    expect(beforeSend(event)).toBe(event);
  });

  it("keeps an event with no exception (e.g. a message-only event)", async () => {
    const beforeSend = await loadBeforeSend();
    const event: SentryEvent = {};
    expect(beforeSend(event)).toBe(event);
  });

  it("keeps when a real (non-AppError) exception rides alongside an AppError", async () => {
    const beforeSend = await loadBeforeSend();
    const event: SentryEvent = {
      exception: {
        values: [
          { type: "AppError", value: "PAID_TICKETING_REQUIRES_STRIPE" },
          { type: "Error", value: "db exploded" },
        ],
      },
    };
    expect(beforeSend(event)).toBe(event);
  });
});

describe("instrument volunteering feed-token scrub", () => {
  const prevDsn = process.env.SENTRY_DSN;
  const FEED_URL =
    "https://api.ithasfire.com/api/volunteering/vft_s3cr3tT0ken/calendar.ics";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = prevDsn;
  });

  it("beforeSend redacts the token path segment and query string", async () => {
    const { beforeSend } = await loadSentryHooks();
    const event: SentryEvent = {
      request: { url: `${FEED_URL}?utm=leak`, query_string: "utm=leak" },
    };
    const sent = beforeSend(event);
    expect(sent?.request?.url).toBe(
      "https://api.ithasfire.com/api/volunteering/[redacted]/calendar.ics?utm=leak",
    );
    expect(sent?.request?.url).not.toContain("vft_s3cr3tT0ken");
    expect(sent?.request?.query_string).toBe("[redacted]");
  });

  it("beforeSend leaves non-volunteering request URLs untouched", async () => {
    const { beforeSend } = await loadSentryHooks();
    const event: SentryEvent = {
      request: {
        url: "https://api.ithasfire.com/api/trpc/events.list?input=%7B%7D",
        query_string: "input=%7B%7D",
      },
    };
    const sent = beforeSend(event);
    expect(sent?.request?.url).toBe(
      "https://api.ithasfire.com/api/trpc/events.list?input=%7B%7D",
    );
    expect(sent?.request?.query_string).toBe("input=%7B%7D");
  });

  it("beforeSendTransaction scrubs a concrete token from request.url and the name", async () => {
    const { beforeSendTransaction } = await loadSentryHooks();
    const event: SentryEvent = {
      transaction: "GET /api/volunteering/vft_s3cr3tT0ken/calendar.ics",
      request: { url: FEED_URL },
    };
    const sent = beforeSendTransaction(event);
    expect(sent?.transaction).toBe(
      "GET /api/volunteering/[redacted]/calendar.ics",
    );
    expect(sent?.request?.url).not.toContain("vft_s3cr3tT0ken");
  });

  it("beforeSendTransaction keeps parameterized route-template names verbatim", async () => {
    const { beforeSendTransaction } = await loadSentryHooks();
    const event: SentryEvent = {
      transaction: "GET /api/volunteering/:feedToken/calendar.ics",
      request: { url: FEED_URL },
    };
    const sent = beforeSendTransaction(event);
    // Grouping-friendly template name is preserved…
    expect(sent?.transaction).toBe(
      "GET /api/volunteering/:feedToken/calendar.ics",
    );
    // …while the concrete request URL is still scrubbed.
    expect(sent?.request?.url).toBe(
      "https://api.ithasfire.com/api/volunteering/[redacted]/calendar.ics",
    );
  });
});

// L1: `includeLocalVariables` + `sendDefaultPii` ship frame locals and the
// request body. A frame holding a Place row carries the true address of a
// venue that withholds it — the hooks must run the location scrub
// (`scrubLocationFromErrorEvent`, unit-tested in @th/errors). These pin the
// WIRING: remove the call and they fail.
describe("instrument location scrub", () => {
  const prevDsn = process.env.SENTRY_DSN;
  const PLACE = {
    id: "place-1",
    name: "Hidden House",
    address: "1412 Holly St",
    postcode: "37206",
    city: "Nashville",
    lat: 36.1771,
    lng: -86.7389,
    phone: "+1 615 555 0199",
  };
  const TRUTH = ["1412 Holly", "37206", "36.1771", "-86.7389", "555 0199"];

  function expectNoTruth(value: unknown) {
    const text = JSON.stringify(value);
    for (const needle of TRUTH) expect(text).not.toContain(needle);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = prevDsn;
  });

  it("beforeSend scrubs frame locals, extra, breadcrumbs and a JSON request body", async () => {
    const { beforeSend } = await loadSentryHooks();
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            stacktrace: {
              frames: [{ function: "upsertPlace", vars: { place: PLACE, lat: 36.1771 } }],
            },
          },
        ],
      },
      extra: { place: PLACE },
      breadcrumbs: [{ category: "db", data: { row: PLACE } }],
      request: {
        url: "https://api.ithasfire.com/api/trpc/places.upsertPlace",
        data: JSON.stringify({ 0: { json: PLACE } }),
      },
    } as unknown as SentryEvent;

    const sent = beforeSend(event) as Record<string, any> | null;

    expect(sent).not.toBeNull();
    expectNoTruth(sent);
    // Triage fields survive.
    expect(sent!.extra.place).toMatchObject({ id: "place-1", city: "Nashville" });
    expect(sent!.request.url).toBe(
      "https://api.ithasfire.com/api/trpc/places.upsertPlace",
    );
  });

  it("beforeSendTransaction scrubs the request body too", async () => {
    const { beforeSendTransaction } = await loadSentryHooks();
    const event = {
      transaction: "POST /api/trpc/places.upsertPlace",
      request: { data: { 0: { json: PLACE } } },
    } as unknown as SentryEvent;

    const sent = beforeSendTransaction(event);

    expectNoTruth(sent);
    expect(sent?.transaction).toBe("POST /api/trpc/places.upsertPlace");
  });
});

describe("Sentry — user.ip_address pinned to the resolved client_ip tag", () => {
  // Sentry's requestDataIntegration fills user.ip_address from the
  // client-writable X-Client-IP / leftmost X-Forwarded-For. `beforeSend` must
  // overwrite it with the `client_ip` tag (cf-connecting-ip precedence).
  it("beforeSend overwrites a spoofed ip_address with the client_ip tag", async () => {
    const beforeSend = await loadBeforeSend();
    const event = {
      exception: { values: [{ type: "Error", value: "boom" }] },
      tags: { client_ip: "203.0.113.7" },
      user: { ip_address: "6.6.6.6", id: "u1" },
    } as unknown as SentryEvent;

    const sent = beforeSend(event) as Record<string, any> | null;

    expect(sent?.user).toEqual({ ip_address: "203.0.113.7", id: "u1" });
  });

  it("beforeSend leaves user alone when no client_ip tag is present", async () => {
    const beforeSend = await loadBeforeSend();
    const event = {
      exception: { values: [{ type: "Error", value: "boom" }] },
      user: { ip_address: "198.51.100.1" },
    } as unknown as SentryEvent;

    const sent = beforeSend(event) as Record<string, any> | null;

    expect(sent?.user).toEqual({ ip_address: "198.51.100.1" });
  });

  it("beforeSendTransaction pins it too", async () => {
    const { beforeSendTransaction } = await loadSentryHooks();
    const sent = beforeSendTransaction({
      transaction: "GET /health",
      tags: { client_ip: "203.0.113.7" },
    } as unknown as SentryEvent) as Record<string, any> | null;

    expect(sent?.user).toEqual({ ip_address: "203.0.113.7" });
  });
});

describe("instrument location scrub of the request query (tRPC GET input)", () => {
  const prevDsn = process.env.SENTRY_DSN;
  const input = encodeURIComponent(
    JSON.stringify({ json: { near: { lat: 36.161234, lng: -86.781234 } } }),
  );
  const URL_WITH_NEAR = `https://api.ithasfire.com/api/trpc/search.events?input=${input}`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = prevDsn;
  });

  it("beforeSend and beforeSendTransaction replace a query carrying near lat/lng, keeping the path", async () => {
    const { beforeSend, beforeSendTransaction } = await loadSentryHooks();
    for (const hook of [beforeSend, beforeSendTransaction]) {
      const sent = hook({
        request: { url: URL_WITH_NEAR, query_string: `input=${input}` },
      });
      expect(sent?.request?.url).toBe(
        "https://api.ithasfire.com/api/trpc/search.events?[scrubbed]",
      );
      expect(sent?.request?.query_string).toBe("[scrubbed]");
      expect(JSON.stringify(sent)).not.toMatch(/36\.16|86\.78/);
    }
  });
});
