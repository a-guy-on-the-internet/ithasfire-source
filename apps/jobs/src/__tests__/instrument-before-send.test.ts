import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * L1: the jobs service carries no local variables and no default PII, but a
 * `reportError(err, { extra })` can still hand Sentry a Place or Event row —
 * the true address of a venue that withholds it. The jobs hooks run the same
 * location scrub as the API (`scrubLocationFromErrorEvent`, unit-tested in
 * @th/errors). This pins the WIRING.
 */

const initMock = vi.fn();

vi.mock("@sentry/node", () => ({
  init: initMock,
}));

type Hook = (event: Record<string, unknown>) => Record<string, unknown> | null;

async function loadHooks(): Promise<{
  beforeSend: Hook;
  beforeSendTransaction: Hook;
}> {
  initMock.mockClear();
  vi.resetModules();
  process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";
  await import("../instrument");
  const config = initMock.mock.calls.at(-1)?.[0] as
    | { beforeSend?: Hook; beforeSendTransaction?: Hook }
    | undefined;
  if (!config?.beforeSend || !config.beforeSendTransaction) {
    throw new Error("jobs Sentry hooks were not configured");
  }
  return {
    beforeSend: config.beforeSend,
    beforeSendTransaction: config.beforeSendTransaction,
  };
}

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

describe("jobs instrument location scrub", () => {
  const prevDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = prevDsn;
  });

  it("beforeSend scrubs a Place row out of extra and contexts, keeping triage fields", async () => {
    const { beforeSend } = await loadHooks();
    const sent = beforeSend({
      exception: { values: [{ type: "Error", value: "boom" }] },
      extra: { place: PLACE, jobName: "reindex-search" },
      contexts: { job: { place: PLACE } },
    }) as Record<string, any>;

    const text = JSON.stringify(sent);
    for (const needle of TRUTH) expect(text).not.toContain(needle);
    expect(sent.extra.jobName).toBe("reindex-search");
    expect(sent.extra.place).toMatchObject({ id: "place-1", city: "Nashville" });
  });

  it("beforeSendTransaction scrubs too", async () => {
    const { beforeSendTransaction } = await loadHooks();
    const sent = beforeSendTransaction({
      transaction: "job reindex-search",
      contexts: { trace: { trace_id: "abc", data: { place: PLACE } } },
    }) as Record<string, any>;

    const text = JSON.stringify(sent);
    for (const needle of TRUTH) expect(text).not.toContain(needle);
    expect(sent.contexts.trace.trace_id).toBe("abc");
  });
});
