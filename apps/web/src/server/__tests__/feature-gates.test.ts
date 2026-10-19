import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeFeatureGates } from "@/lib/feature-gates/test-helpers";

const mockedQuery = vi.fn();
const mockedRedirect = vi.fn();
const mockedNotFound = vi.fn();

vi.mock("@/server/trpc-client", () => ({
  getServerTrpcClient: () => ({
    features: {
      getFeatureGates: {
        query: () => mockedQuery(),
      },
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => mockedRedirect(...args),
  notFound: (...args: unknown[]) => mockedNotFound(...args),
}));

// `fetchFeatureGates` is wrapped in React's `cache()` at module scope, which
// memoizes its result. Re-import the module fresh in each test so one test's
// mocked fetch result can't bleed into the next.
async function loadFeatureGates() {
  vi.resetModules();
  return import("../feature-gates");
}

describe("assertFeatureEnabled", () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedRedirect.mockReset();
    mockedNotFound.mockReset();
  });

  it("404s the route when the named gate is off", async () => {
    mockedQuery.mockResolvedValue(makeFeatureGates({ promos: false }));

    const { assertFeatureEnabled } = await loadFeatureGates();
    await assertFeatureEnabled("promos");

    expect(mockedNotFound).toHaveBeenCalledTimes(1);
  });

  it("does not 404 when the named gate is on", async () => {
    mockedQuery.mockResolvedValue(makeFeatureGates({ promos: true }));

    const { assertFeatureEnabled } = await loadFeatureGates();
    await assertFeatureEnabled("promos");

    expect(mockedNotFound).not.toHaveBeenCalled();
  });
});

describe("getFeatureGatesServer", () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedRedirect.mockReset();
    mockedNotFound.mockReset();
  });

  it("fails OPEN to discovery defaults when the gates fetch fails", async () => {
    mockedQuery.mockRejectedValue(new Error("api down"));

    const { getFeatureGatesServer } = await loadFeatureGates();
    const gates = await getFeatureGatesServer();

    // Render fallback is unchanged: a network hiccup shows discovery (no
    // maintenance), never crashes the page or hides public content.
    expect(gates.maintenanceMode).toBe(false);
  });

  it("returns the fetched snapshot when the fetch succeeds", async () => {
    mockedQuery.mockResolvedValue(makeFeatureGates({ maintenanceMode: true }));

    const { getFeatureGatesServer } = await loadFeatureGates();
    const gates = await getFeatureGatesServer();

    expect(gates.maintenanceMode).toBe(true);
  });
});
