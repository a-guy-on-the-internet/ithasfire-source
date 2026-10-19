import React from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureException, toastDanger } = vi.hoisted(() => ({
  captureException: vi.fn(),
  toastDanger: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException }));
vi.mock("@th/ui", () => ({
  useNotify: () => ({ toast: { danger: toastDanger } }),
  useTranslations: () => (key: string) => key,
}));

import { GlobalQueryErrorLogger } from "../GlobalQueryErrorLogger";

/** A query that fails with `error`, carrying `meta`. */
function Failing({ error, meta }: { error: Error; meta?: Record<string, unknown> }) {
  useQuery({
    queryKey: [["promos", "preview"], { input: { n: Math.random() } }],
    queryFn: () => Promise.reject(error),
    retry: false,
    meta,
  });
  return null;
}

const renderFailing = async (
  error: Error,
  meta?: Record<string, unknown>,
) => {
  const client = new QueryClient();
  await act(async () => {
    render(
    <QueryClientProvider client={client}>
      <GlobalQueryErrorLogger />
      <Failing error={error} meta={meta} />
    </QueryClientProvider>,
    );
  });
};

beforeEach(() => {
  captureException.mockReset();
  toastDanger.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const promoOnly = (error: unknown) =>
  (error as { message?: string }).message?.startsWith("promo_") ?? false;

describe("GlobalQueryErrorLogger — narrow opt-outs", () => {
  it("silentWhen: a claimed error (a promo rejection) is fully silent", async () => {
    await renderFailing(new Error("promo_min_order_not_met"), {
      silentWhen: promoOnly,
      noToast: true,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(captureException).not.toHaveBeenCalled();
    expect(toastDanger).not.toHaveBeenCalled();
  });

  it("regression: an UNCLAIMED error (a 5xx) still reaches Sentry — `silent` used to drop it", async () => {
    await renderFailing(new Error("Internal server error"), {
      silentWhen: promoOnly,
      noToast: true,
    });
    await waitFor(() => expect(captureException).toHaveBeenCalledTimes(1));
    // …but no toast: the surface explains it inline.
    expect(toastDanger).not.toHaveBeenCalled();
  });

  it("no meta: reported AND toasted, as before", async () => {
    await renderFailing(new Error("Internal server error"));
    await waitFor(() => expect(captureException).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
  });

  it("the blanket `silent` still skips everything (unchanged)", async () => {
    await renderFailing(new Error("Internal server error"), { silent: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(captureException).not.toHaveBeenCalled();
    expect(toastDanger).not.toHaveBeenCalled();
  });
});
