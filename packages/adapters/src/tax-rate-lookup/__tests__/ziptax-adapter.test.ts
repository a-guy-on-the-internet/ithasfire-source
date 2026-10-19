import { describe, expect, it, vi } from "vitest";

import {
  isTaxRateLookupError,
  type TaxRateLookupError,
} from "@th/ports/tax-rate-lookup";

import { createZiptaxAdapter } from "../ziptax-adapter";

/**
 * The adapter's three outcomes (port contract): a rate (a real 0 included),
 * `null` = ZipTax cannot place the location, and a THROWN TaxRateLookupError
 * for a failed lookup. The real API is never called: `fetchImpl` is a stub
 * that answers with the bodies ZipTax documents (and, for v6.0 success, the
 * shape of a real 2026-10-05 dev-key response).
 */

type Reply = { status?: number; body: unknown } | Error;

function stubFetch(...replies: Reply[]) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected fetch ${url}`);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const v50 = (rCode: number, taxSales?: number) => ({
  body: {
    version: "v50",
    rCode,
    results:
      taxSales === undefined
        ? []
        : [
            {
              geoPostalCode: "78701",
              geoCity: "AUSTIN",
              geoCounty: "TRAVIS",
              geoState: "TX",
              taxSales,
              taxUse: taxSales,
            },
          ],
  },
});

const v60 = (code: number, salesRate?: number, status = 200) => ({
  status,
  body: {
    metadata: {
      version: "v60",
      response: { code, name: code === 100 ? "RESPONSE_CODE_SUCCESS" : "X" },
    },
    ...(salesRate === undefined
      ? {}
      : {
          taxSummaries: [
            { rate: salesRate, taxType: "SALES_TAX", summaryName: "Total" },
            { rate: salesRate, taxType: "USE_TAX", summaryName: "Total" },
          ],
          addressDetail: { incorporated: "true" },
        }),
  },
});

async function lookupError(
  promise: Promise<unknown>,
): Promise<TaxRateLookupError> {
  try {
    await promise;
  } catch (err) {
    expect(isTaxRateLookupError(err)).toBe(true);
    return err as TaxRateLookupError;
  }
  throw new Error("expected the lookup to throw");
}

describe("createZiptaxAdapter — postal code (v50)", () => {
  it("rCode 100 with a rate → the rate in bps", async () => {
    const { fetchImpl, calls } = stubFetch(v50(100, 0.0825));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    await expect(
      adapter.lookupByPostalCode({ postalCode: "78701-1234", countryCode: "US" }),
    ).resolves.toEqual({ rateBps: 825, source: "ziptax" });
    expect(calls[0]).toContain("/request/v50");
    expect(calls[0]).toContain("postalcode=78701");
  });

  it("rCode 100 with a 0 rate → a REAL 0, not null", async () => {
    const { fetchImpl } = stubFetch(v50(100, 0));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    await expect(
      adapter.lookupByPostalCode({ postalCode: "97201", countryCode: "US" }),
    ).resolves.toEqual({ rateBps: 0, source: "ziptax" });
  });

  it("rCode 100 with no results → null (no rate for this place)", async () => {
    const { fetchImpl } = stubFetch(v50(100));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    await expect(
      adapter.lookupByPostalCode({ postalCode: "00000", countryCode: "US" }),
    ).resolves.toBeNull();
  });

  it("rCode 104 (invalid postal code) → null", async () => {
    const { fetchImpl } = stubFetch(v50(104));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    await expect(
      adapter.lookupByPostalCode({ postalCode: "99999", countryCode: "US" }),
    ).resolves.toBeNull();
  });

  it("rCode 101 (invalid key) → throws with the code", async () => {
    const { fetchImpl } = stubFetch(v50(101));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    const err = await lookupError(
      adapter.lookupByPostalCode({ postalCode: "78701", countryCode: "US" }),
    );
    expect(err.providerCode).toBe(101);
  });

  it("rCode 108 (rate limit) → throws with the code — never null", async () => {
    const { fetchImpl } = stubFetch(v50(108));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    const err = await lookupError(
      adapter.lookupByPostalCode({ postalCode: "78701", countryCode: "US" }),
    );
    expect(err.providerCode).toBe(108);
  });

  it("HTTP 503 with a non-JSON body → throws with the status", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>bad gateway</html>", { status: 503 }),
    ) as unknown as typeof fetch;
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    const err = await lookupError(
      adapter.lookupByPostalCode({ postalCode: "78701", countryCode: "US" }),
    );
    expect(err.httpStatus).toBe(503);
    expect(err.providerCode).toBeNull();
  });

  it("a network error / timeout → throws", async () => {
    const { fetchImpl } = stubFetch(new Error("The operation was aborted"));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    const err = await lookupError(
      adapter.lookupByPostalCode({ postalCode: "78701", countryCode: "US" }),
    );
    expect(err.providerCode).toBeNull();
    expect(err.httpStatus).toBeNull();
  });

  it("non-US → null without calling the API", async () => {
    const { fetchImpl } = stubFetch();
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    await expect(
      adapter.lookupByPostalCode({ postalCode: "SW1A 1AA", countryCode: "GB" }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("malformed zip without a street → null without calling the API", async () => {
    const { fetchImpl } = stubFetch();
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    await expect(
      adapter.lookupByPostalCode({ postalCode: "ABCDE", countryCode: "US" }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createZiptaxAdapter — street address (v60 first)", () => {
  const target = {
    postalCode: "55403",
    countryCode: "US",
    street: "600 N 1st Ave",
    city: "Minneapolis",
    region: "MN",
  };

  it("uses the v60 address lookup and its SALES_TAX summary", async () => {
    const { fetchImpl, calls } = stubFetch(v60(100, 0.09025));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    await expect(adapter.lookupByPostalCode(target)).resolves.toEqual({
      rateBps: 903,
      source: "ziptax",
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe("/request/v60");
    expect(url.searchParams.get("address")).toBe(
      "600 N 1st Ave, Minneapolis, MN 55403",
    );
  });

  it("a free-text street that already holds the zip is sent as typed", async () => {
    const { fetchImpl, calls } = stubFetch(v60(100, 0.0825));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    await adapter.lookupByPostalCode({
      postalCode: "78701",
      countryCode: "US",
      street: "301 Congress Ave, Austin, TX 78701",
      city: "Austin",
      region: "TX",
    });
    expect(new URL(calls[0]!).searchParams.get("address")).toBe(
      "301 Congress Ave, Austin, TX 78701",
    );
  });

  it("address not resolvable (109) → falls back to the postal code", async () => {
    const { fetchImpl, calls } = stubFetch(v60(109, undefined, 422), v50(100, 0.08025));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    await expect(adapter.lookupByPostalCode(target)).resolves.toEqual({
      rateBps: 803,
      source: "ziptax",
    });
    expect(calls[1]).toContain("/request/v50");
  });

  it("address rate-limited (108, HTTP 429) but postal answers → the postal rate", async () => {
    const { fetchImpl } = stubFetch(v60(108, undefined, 429), v50(100, 0.08025));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    await expect(adapter.lookupByPostalCode(target)).resolves.toEqual({
      rateBps: 803,
      source: "ziptax",
    });
  });

  it("address failed but postal answered → reports the address failure (code + status, no key)", async () => {
    const { fetchImpl } = stubFetch(v60(108, undefined, 429), v50(100, 0.08025));
    const reportError = vi.fn();
    const adapter = createZiptaxAdapter("secret-key-123", {
      fetchImpl,
      reportError,
    });

    await expect(adapter.lookupByPostalCode(target)).resolves.toEqual({
      rateBps: 803,
      source: "ziptax",
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, context] = reportError.mock.calls[0]!;
    expect(isTaxRateLookupError(err)).toBe(true);
    expect(context.extra).toEqual({ providerCode: 108, httpStatus: 429 });
    expect(context.tags.op).toBe("ziptax_address_lookup_fallback");
    // Never the key, never the keyed URL.
    const serialized = JSON.stringify([String(err), err.message, context]);
    expect(serialized).not.toContain("secret-key-123");
    expect(serialized).not.toContain("api.zip-tax.com");
  });

  it("a timed-out address lookup with a postal answer is reported too", async () => {
    const { fetchImpl } = stubFetch(
      new Error("The operation was aborted due to timeout"),
      v50(100, 0.08025),
    );
    const reportError = vi.fn();
    const adapter = createZiptaxAdapter("k", { fetchImpl, reportError });

    await expect(adapter.lookupByPostalCode(target)).resolves.toMatchObject({
      rateBps: 803,
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1].extra).toEqual({
      providerCode: null,
      httpStatus: null,
    });
  });

  it("a THROWING reporter does not change the result", async () => {
    const { fetchImpl } = stubFetch(v60(113, undefined, 403), v50(100, 0.08025));
    const adapter = createZiptaxAdapter("k", {
      fetchImpl,
      reportError: () => {
        throw new Error("sentry down");
      },
    });

    await expect(adapter.lookupByPostalCode(target)).resolves.toEqual({
      rateBps: 803,
      source: "ziptax",
    });
  });

  it("a not-found address (109) with a postal answer is NOT reported (not a failure)", async () => {
    const { fetchImpl } = stubFetch(v60(109, undefined, 422), v50(100, 0.08025));
    const reportError = vi.fn();
    const adapter = createZiptaxAdapter("k", { fetchImpl, reportError });

    await adapter.lookupByPostalCode(target);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("both failed → throws and does NOT also report (the caller owns that failure)", async () => {
    const { fetchImpl } = stubFetch(v60(108, undefined, 429), v50(108));
    const reportError = vi.fn();
    const adapter = createZiptaxAdapter("k", { fetchImpl, reportError });

    await lookupError(adapter.lookupByPostalCode(target));
    expect(reportError).not.toHaveBeenCalled();
  });

  it("both rate-limited → throws the ADDRESS failure (108)", async () => {
    const { fetchImpl } = stubFetch(v60(108, undefined, 429), v50(108));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    const err = await lookupError(adapter.lookupByPostalCode(target));
    expect(err.providerCode).toBe(108);
    expect(err.httpStatus).toBe(429);
  });

  it("address failed and postal has no rate → throws (unknown, not 0)", async () => {
    const { fetchImpl } = stubFetch(v60(106, undefined, 500), v50(100));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    const err = await lookupError(adapter.lookupByPostalCode(target));
    expect(err.providerCode).toBe(106);
  });

  it("v60 success with a 0 sales rate → a real 0", async () => {
    const { fetchImpl } = stubFetch(v60(100, 0));
    const adapter = createZiptaxAdapter("k", { fetchImpl });

    await expect(adapter.lookupByPostalCode(target)).resolves.toEqual({
      rateBps: 0,
      source: "ziptax",
    });
  });
});
