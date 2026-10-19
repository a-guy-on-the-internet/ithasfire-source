import type { ReactNode } from "react";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const { toastDanger } = vi.hoisted(() => ({ toastDanger: vi.fn() }));

vi.mock("@th/ui", () => ({
  useNotify: () => ({ toast: { danger: toastDanger } }),
  useTranslations: () => (key: string) => key,
}));

import { GlobalMutationErrorNotifier } from "../GlobalMutationErrorNotifier";

/**
 * `meta.silentWhen` mirrors the query logger's opt-out: only the errors the
 * predicate claims skip the toast (the call site shows them inline, e.g. the
 * B2 verify prompt on resale checkout). Every other failure still toasts.
 */
const setup = () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children?: ReactNode }) => (
    <QueryClientProvider client={client}>
      <GlobalMutationErrorNotifier />
      {children}
    </QueryClientProvider>
  );
  render(<div />, { wrapper });
  const fail = (error: Error) =>
    client
      .getMutationCache()
      .build(client, {
        mutationFn: async () => {
          throw error;
        },
        meta: {
          silentWhen: (e: unknown) =>
            (e as Error).message === "email_verification_required",
        },
      })
      .execute(undefined)
      .catch(() => undefined);
  return { fail };
};

describe("GlobalMutationErrorNotifier meta.silentWhen", () => {
  it("skips the toast for an error the predicate claims", async () => {
    toastDanger.mockClear();
    const { fail } = setup();
    await fail(new Error("email_verification_required"));
    await new Promise((r) => setTimeout(r, 0));
    expect(toastDanger).not.toHaveBeenCalled();
  });

  it("still toasts every other failure", async () => {
    toastDanger.mockClear();
    const { fail } = setup();
    await fail(new Error("LISTING_ALREADY_HELD"));
    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
  });
});
