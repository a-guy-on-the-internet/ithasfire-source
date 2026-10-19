import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHARGEBACK_TERMS_VERSION } from "@/components/payments/ChargebackTermsContent";

import {
  resolveServerChargebackTermsAcceptance,
  useStoredChargebackTermsAcceptance,
} from "../chargeback-terms-acceptance";

type QueryState = { data?: unknown; error?: unknown };

const testState = vi.hoisted(() => ({
  org: {} as QueryState,
  human: {} as QueryState,
  orgCalls: [] as Array<{ input: unknown; enabled: boolean }>,
  humanCalls: [] as Array<{ enabled: boolean }>,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    orgs: {
      getOrg: {
        useQuery: (input: unknown, opts: { enabled: boolean }) => {
          testState.orgCalls.push({ input, enabled: opts.enabled });
          return opts.enabled
            ? { data: testState.org.data, error: testState.org.error ?? null }
            : { data: undefined, error: null };
        },
      },
    },
    humans: {
      getMyProfile: {
        useQuery: (_input: unknown, opts: { enabled: boolean }) => {
          testState.humanCalls.push({ enabled: opts.enabled });
          return opts.enabled
            ? {
                data: testState.human.data,
                error: testState.human.error ?? null,
              }
            : { data: undefined, error: null };
        },
      },
    },
  },
}));

const ACCEPTED_AT = "2026-10-12T15:00:00.000Z";
const currentRecord = {
  chargebackTermsVersion: CHARGEBACK_TERMS_VERSION,
  chargebackTermsAcceptedAt: ACCEPTED_AT,
};

describe("resolveServerChargebackTermsAcceptance", () => {
  it("reads a stored acceptance of the current version as current", () => {
    expect(resolveServerChargebackTermsAcceptance(currentRecord)).toEqual({
      status: "current",
      version: CHARGEBACK_TERMS_VERSION,
      acceptedAt: new Date(ACCEPTED_AT),
    });
  });

  it("reads an older version as required", () => {
    expect(
      resolveServerChargebackTermsAcceptance({
        chargebackTermsVersion: "2020-01-01",
        chargebackTermsAcceptedAt: ACCEPTED_AT,
      }),
    ).toEqual({ status: "required" });
  });

  it("reads never-accepted (both null) as required", () => {
    expect(
      resolveServerChargebackTermsAcceptance({
        chargebackTermsVersion: null,
        chargebackTermsAcceptedAt: null,
      }),
    ).toEqual({ status: "required" });
  });

  it("reads absent keys (non-finance member) as forbidden", () => {
    expect(resolveServerChargebackTermsAcceptance({ id: "org-1" })).toEqual({
      status: "forbidden",
    });
  });

  it("reads a missing payload (still loading) as unknown", () => {
    expect(resolveServerChargebackTermsAcceptance(undefined)).toEqual({
      status: "unknown",
    });
  });
});

describe("useStoredChargebackTermsAcceptance", () => {
  beforeEach(() => {
    testState.org = {};
    testState.human = {};
    testState.orgCalls = [];
    testState.humanCalls = [];
  });

  it("reads the org record for an org owner", () => {
    testState.org = { data: { id: "org-1", ...currentRecord } };
    const { result } = renderHook(() =>
      useStoredChargebackTermsAcceptance({ kind: "org", orgId: "org-1" }),
    );
    expect(result.current.status).toBe("current");
    expect(testState.orgCalls.at(-1)).toEqual({
      input: { orgId: "org-1" },
      enabled: true,
    });
    expect(testState.humanCalls.at(-1)?.enabled).toBe(false);
  });

  it("reads the signed-in human's profile for a human owner", () => {
    testState.human = { data: currentRecord };
    const { result } = renderHook(() =>
      useStoredChargebackTermsAcceptance({ kind: "human" }),
    );
    expect(result.current.status).toBe("current");
    expect(testState.orgCalls.at(-1)?.enabled).toBe(false);
  });

  it("is forbidden when the org record omits the fields", () => {
    testState.org = { data: { id: "org-1" } };
    const { result } = renderHook(() =>
      useStoredChargebackTermsAcceptance({ kind: "org", orgId: "org-1" }),
    );
    expect(result.current.status).toBe("forbidden");
  });

  it("is unknown when the read fails, even with stale cached data", () => {
    testState.org = { data: currentRecord, error: new Error("boom") };
    const { result } = renderHook(() =>
      useStoredChargebackTermsAcceptance({ kind: "org", orgId: "org-1" }),
    );
    expect(result.current.status).toBe("unknown");
  });

  it("fires no read and is unknown with no owner or when disabled", () => {
    testState.org = { data: currentRecord };
    const noOwner = renderHook(() => useStoredChargebackTermsAcceptance(null));
    expect(noOwner.result.current.status).toBe("unknown");

    const disabled = renderHook(() =>
      useStoredChargebackTermsAcceptance(
        { kind: "org", orgId: "org-1" },
        { enabled: false },
      ),
    );
    expect(disabled.result.current.status).toBe("unknown");
    expect(testState.orgCalls.every((call) => !call.enabled)).toBe(true);
    expect(testState.humanCalls.every((call) => !call.enabled)).toBe(true);
  });
});
