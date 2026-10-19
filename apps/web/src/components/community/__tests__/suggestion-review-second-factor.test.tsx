import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the SECOND_FACTOR_REQUIRED handling on the
 * `eventSuggestions.review` mutation in BOTH review surfaces:
 *
 *   1. The mutation must pass `meta: { silent: true }` — otherwise
 *      GlobalMutationErrorNotifier (MutationCache subscriber) double-processes
 *      every failure: a second generic "action failed" danger toast PLUS a
 *      `formatErrorMessage` console warn for internal-tier codes like
 *      SECOND_FACTOR_REQUIRED (deliberately absent from the errors.* catalog).
 *   2. The local onError must fully handle the SECOND_FACTOR_REQUIRED branch
 *      itself (enrollment warning toast, no danger toast, no
 *      formatErrorMessage call).
 */

const {
  pushMock,
  toastMock,
  formatErrorMessageMock,
  capturedMutationOptions,
} = vi.hoisted(() => ({
  pushMock: vi.fn(),
  toastMock: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    danger: vi.fn(),
    neutral: vi.fn(),
  },
  formatErrorMessageMock: vi.fn(() => "formatted"),
  capturedMutationOptions: [] as Array<Record<string, any>>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/admin/test-org/dashboard",
}));

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: passthrough, YStack: passthrough };
});

vi.mock("@th/ui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Badge: passthrough,
    Button: passthrough,
    CharCountTextarea: passthrough,
    Checkbox: passthrough,
    NextLinkAnchor: passthrough,
    Popover: passthrough,
    Spinner: () => <div data-testid="spinner" />,
    Text: passthrough,
    TextInput: passthrough,
    useFormatters: () => ({ dateTime: (d: Date) => d.toISOString() }),
    useNotify: () => ({ toast: toastMock }),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("lucide-react", () => {
  const icon = () => null;
  return { Check: icon, ClipboardList: icon, ExternalLink: icon, X: icon };
});

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: formatErrorMessageMock,
}));

vi.mock("@/components/community/SuggestionDiffCard", () => ({
  SuggestionDiffCard: () => null,
}));
// SuggestionInbox imports the same module via its relative path — one factory
// covers both because vitest resolves them to the same file.

vi.mock("@/trpc", () => {
  const loadingInfiniteQuery = () => ({
    isLoading: true,
    isError: false,
    data: undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  });
  return {
    trpc: {
      useUtils: () => ({
        eventSuggestions: {
          listForOwner: { invalidate: vi.fn() },
          listForModeration: { invalidate: vi.fn() },
        },
      }),
      eventSuggestions: {
        review: {
          useMutation: (opts: Record<string, any>) => {
            capturedMutationOptions.push(opts);
            return { mutate: vi.fn(), isPending: false };
          },
        },
        listForOwner: { useInfiniteQuery: loadingInfiniteQuery },
        listForModeration: { useInfiniteQuery: loadingInfiniteQuery },
      },
    },
  };
});

import { SuggestionInbox } from "../SuggestionInbox";
import { ModerationQueue } from "@/app/moderate/suggestions/_components/ModerationQueue";

/** Exact client-visible wire shape (see use-second-factor-required-toast.test). */
const secondFactorError = {
  message: "SECOND_FACTOR_REQUIRED",
  data: {
    code: "FORBIDDEN",
    httpStatus: 403,
    appCode: "SECOND_FACTOR_REQUIRED",
    meta: { appCode: "SECOND_FACTOR_REQUIRED" },
  },
};

const cases = [
  {
    name: "SuggestionInbox (org dashboard)",
    renderIt: () =>
      render(<SuggestionInbox scope={{ kind: "org", orgId: "org_1" }} />),
  },
  {
    name: "ModerationQueue (/moderate/suggestions)",
    renderIt: () => render(<ModerationQueue />),
  },
] as const;

/**
 * The SINGLE-review mutation instance — the one that owns the per-decision
 * callbacks. SuggestionInbox registers a second, callback-less instance for
 * the bulk path (its runner owns every failure branch itself and toasts once
 * at the end), so "the instance with an onError" is the discriminator, not
 * the array index.
 */
const singleReviewOptions = () => {
  const withCallbacks = capturedMutationOptions.filter(
    (opts) => typeof opts.onError === "function",
  );
  expect(withCallbacks).toHaveLength(1);
  return withCallbacks[0];
};

describe.each(cases)("$name review mutation", ({ renderIt }) => {
  beforeEach(() => {
    capturedMutationOptions.length = 0;
    pushMock.mockClear();
    formatErrorMessageMock.mockClear();
    for (const fn of Object.values(toastMock)) fn.mockClear();
  });

  it("opts out of the global mutation error notifier (meta.silent)", () => {
    renderIt();
    expect(capturedMutationOptions.length).toBeGreaterThanOrEqual(1);
    // EVERY registered review mutation must be silent — a bulk instance that
    // forgot `meta.silent` would re-open the double-toast hole per item.
    for (const opts of capturedMutationOptions) {
      expect(opts.meta).toEqual({ silent: true });
    }
    // Guard against silencing a branch that then shows nothing: the local
    // onError must exist to own every failure.
    expect(typeof singleReviewOptions().onError).toBe("function");
  });

  it("SECOND_FACTOR_REQUIRED: enrollment toast only — no danger toast, no formatErrorMessage", () => {
    renderIt();
    const onError = singleReviewOptions().onError as (e: unknown) => void;

    onError(secondFactorError);

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    const options = toastMock.warning.mock.calls[0][0];
    expect(options.title).toBe("moderation.secondFactorRequiredToast");
    options.action.onPress();
    expect(pushMock).toHaveBeenCalledWith(
      "/enroll-2fa?redirect_url=%2Fadmin%2Ftest-org%2Fdashboard",
    );

    // No double-processing: neither the local generic branch nor any copy
    // lookup ran for the handled code.
    expect(toastMock.danger).not.toHaveBeenCalled();
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(formatErrorMessageMock).not.toHaveBeenCalled();
  });

  it("still falls through to the local generic danger toast for unknown errors", () => {
    renderIt();
    const onError = singleReviewOptions().onError as (e: unknown) => void;

    onError({ message: "boom", data: { code: "INTERNAL_SERVER_ERROR" } });

    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(toastMock.danger).toHaveBeenCalledTimes(1);
    expect(formatErrorMessageMock).toHaveBeenCalledTimes(1);
  });
});
