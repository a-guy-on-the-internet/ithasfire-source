import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bulk approve/reject in the owner-side SuggestionInbox.
 *
 * Three things here are only true by construction and would regress silently:
 *
 *  1. The row-selection checkbox is a SIBLING of the row's `role="button"`,
 *     not a child of it. Nested, it would be an ARIA violation AND its label
 *     would be folded into the button's computed accessible name — the row
 *     would announce "Select the suggestion for X … button" while Enter
 *     actually expands it.
 *  2. The server has no bulk procedure: the run is N SEQUENTIAL per-row
 *     mutations. Asserting call ORDER does not pin sequencing (`Promise.all`
 *     produces the same order), so the test below pins one-in-flight-at-a-time
 *     with deferred promises.
 *  3. Partial failure is the normal case. The aggregate toast must never
 *     report "N approved" when some rows silently failed or were already
 *     reviewed by someone else.
 */

const { toastMock, mutateAsyncMock, invalidateMock, queryState } = vi.hoisted(
  () => ({
    toastMock: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      danger: vi.fn(),
      neutral: vi.fn(),
    },
    mutateAsyncMock: vi.fn(),
    invalidateMock: vi.fn(),
    // Stable object identity across renders: SuggestionInbox memoises `items`
    // off `data`, and a fresh object every render would re-run the prune
    // effect on every commit.
    queryState: { data: { pages: [{ items: [] as unknown[] }] } },
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
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
    Button: ({
      children,
      onPress,
      disabled,
      testID,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      testID?: string;
      "aria-label"?: string;
    }) => (
      <button
        type="button"
        data-testid={testID}
        aria-label={rest["aria-label"]}
        disabled={disabled}
        onClick={onPress}
      >
        {children}
      </button>
    ),
    CharCountTextarea: passthrough,
    /**
     * Shaped like the real DS Checkbox, verified against its RENDERED markup
     * rather than its source: `testIdBase` on the container, `${base}-frame`
     * on a `<button role="checkbox">`, a sibling `<label for>` — and, the
     * part that is invisible in `forms/Checkbox.tsx`, an `aria-labelledby` on
     * the frame pointing at that label (Tamagui's Label↔control wiring adds
     * it at runtime). Reproducing it here is what makes the accessible-name
     * assertions below mean anything: without it the select-all's outer
     * `<label for>` would concatenate and the name would silently double.
     */
    Checkbox: ({
      id,
      label,
      checked,
      disabled,
      onCheckedChange,
      testIdBase,
    }: {
      id?: string;
      label?: ReactNode;
      checked?: boolean | "indeterminate";
      disabled?: boolean;
      onCheckedChange?: (v: boolean | "indeterminate") => void;
      testIdBase?: string;
    }) => {
      const labelId = `${testIdBase ?? id ?? "cb"}-label`;
      return (
        <div data-testid={testIdBase}>
          <button
            type="button"
            role="checkbox"
            id={id}
            aria-labelledby={labelId}
            data-testid={testIdBase ? `${testIdBase}-frame` : undefined}
            aria-checked={
              checked === "indeterminate" ? "mixed" : checked === true
            }
            disabled={disabled}
            onClick={() => onCheckedChange?.(checked !== true)}
          />
          <label id={labelId} htmlFor={id}>
            {label}
          </label>
        </div>
      );
    },
    NextLinkAnchor: passthrough,
    Spinner: () => <div data-testid="spinner" />,
    Text: passthrough,
    useFormatters: () => ({ dateTime: (d: Date) => d.toISOString() }),
    useNotify: () => ({ toast: toastMock }),
    // Keys + their ICU arguments, so assertions can read the reported counts.
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  };
});

vi.mock("lucide-react", () => {
  const icon = () => null;
  return { Check: icon, ClipboardList: icon, ExternalLink: icon, X: icon };
});

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: vi.fn(() => "formatted"),
}));

vi.mock("@/components/community/SuggestionDiffCard", () => ({
  SuggestionDiffCard: () => null,
}));

// The shared ink-inverted bar is exercised by AdminTableParts' own tests;
// here it only needs to expose the count and the action slot.
vi.mock("@/components/AdminTableParts", () => ({
  BulkActionBar: ({
    count,
    onClear,
    children,
  }: {
    count: number;
    onClear: () => void;
    children?: ReactNode;
  }) =>
    count > 0 ? (
      <div data-testid="bulk-bar">
        <span data-testid="bulk-count">{count}</span>
        {children}
        <button type="button" onClick={onClear}>
          clear
        </button>
      </div>
    ) : null,
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    onCancel,
    title,
  }: {
    open: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    title: string;
  }) =>
    open ? (
      <div role="dialog" aria-modal="true">
        <span data-testid="confirm-title">{title}</span>
        <button type="button" data-testid="confirm-ok" onClick={onConfirm}>
          ok
        </button>
        <button type="button" data-testid="confirm-cancel" onClick={onCancel}>
          cancel
        </button>
      </div>
    ) : null,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      eventSuggestions: { listForOwner: { invalidate: invalidateMock } },
    }),
    eventSuggestions: {
      review: {
        useMutation: () => ({
          mutate: vi.fn(),
          mutateAsync: mutateAsyncMock,
          isPending: false,
        }),
      },
      listForOwner: {
        useInfiniteQuery: () => ({
          isLoading: false,
          isError: false,
          data: queryState.data,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          refetch: vi.fn(),
        }),
      },
    },
  },
}));

import { SuggestionInbox } from "../SuggestionInbox";

const makeItem = (id: string, title: string) => ({
  suggestion: {
    id,
    createdAt: "2026-08-01T12:00:00.000Z",
    submitterHumanId: null,
    note: null,
    fields: { title: `${title} (new)` },
    baseVersion: { title },
  },
  event: { title, slug: `slug-${id}` },
  submitterName: "Ana",
});

const renderInbox = (ids: string[]) => {
  queryState.data = {
    pages: [{ items: ids.map((id) => makeItem(id, `Event ${id}`)) }],
  };
  return render(<SuggestionInbox scope={{ kind: "org", orgId: "org_1" }} />);
};

/** The `<button role="checkbox">`, mirroring the DS component's `-frame`. */
const rowCheckbox = (id: string) =>
  screen.getByTestId(`owner-suggestion-select-${id}-frame`);
const selectAllBox = () =>
  screen.getByTestId("owner-suggestions-select-all-frame");
const clickSelectAll = () => fireEvent.click(selectAllBox());

const tick = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

/** Bulk approve is confirmed; reject is immediate. */
const approveSelected = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId("owner-suggestions-bulk-approve"));
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("confirm-ok"));
    await Promise.resolve();
  });
};

const rejectSelected = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId("owner-suggestions-bulk-reject"));
    await Promise.resolve();
  });
};

/**
 * Client-visible wire shape of a tRPC failure: an Error whose `data.appCode`
 * carries the canonical code (see `getAppErrorCode`), or — for transport-tier
 * failures like the rate-limit floor — only `data.code`.
 */
const trpcError = (appCode: string, code = "FORBIDDEN") =>
  Object.assign(new Error(appCode), { data: { code, appCode } });
const wireOnlyError = (code: string) =>
  Object.assign(new Error(code), { data: { code } });

const alreadyReviewed = trpcError(
  "EDIT_SUGGESTION_ALREADY_REVIEWED",
  "CONFLICT",
);
const secondFactorError = trpcError("SECOND_FACTOR_REQUIRED");
/** No recognized appCode — falls through to the generic "failed" bucket. */
const unknownError = wireOnlyError("INTERNAL_SERVER_ERROR");

const ok = { appliedFields: ["title"], conflictedFields: [] as string[] };

beforeEach(() => {
  mutateAsyncMock.mockReset();
  invalidateMock.mockReset();
  for (const fn of Object.values(toastMock)) fn.mockClear();
});

describe("SuggestionInbox row structure", () => {
  it("keeps the checkbox OUT of the row button, and out of its accessible name", () => {
    const { container } = renderInbox(["a"]);
    const row = container.querySelector("[aria-expanded]")!;
    const box = rowCheckbox("a");

    // Nested interactive controls: the checkbox must not be a descendant.
    expect(row.contains(box)).toBe(false);
    // …and its label must not leak into the row button's computed name.
    expect(row.textContent).not.toContain("bulkSelectRow");
    // The name itself disambiguates rows that share an event title.
    const name = screen.getByTestId("owner-suggestion-select-a").textContent!;
    expect(name).toContain('"submitter":"Ana"');
    expect(name).toContain('"when"');
  });

  it("names the select-all exactly once", () => {
    renderInbox(["a", "b"]);
    // The visible "SELECT ALL" text is a SECOND <label for> on the same
    // control. Two native labels concatenate ("… …"), and only the DS
    // component's runtime aria-labelledby prevents it — so assert the
    // resolved NAME, not just that a checkbox exists. An exact match fails
    // the moment it doubles.
    expect(
      screen.getByRole("checkbox", {
        name: "ownerSuggestions.bulkSelectAll",
      }),
    ).toBe(screen.getByTestId("owner-suggestions-select-all-frame"));
  });

  it("gives each inbox instance its own select-all id", () => {
    queryState.data = { pages: [{ items: [makeItem("a", "Event a")] }] };
    const { container } = render(
      <>
        <SuggestionInbox scope={{ kind: "org", orgId: "org_1" }} />
        <SuggestionInbox scope={{ kind: "org", orgId: "org_2" }} />
      </>,
    );
    // Duplicate DOM ids would cross-wire the two headers' <label for>.
    const ids = Array.from(
      container.querySelectorAll('[role="checkbox"][id]'),
    ).map((n) => n.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("selecting a row does not expand it — click or keypress", () => {
    const { container } = renderInbox(["a", "b"]);
    const rows = () =>
      Array.from(container.querySelectorAll("[aria-expanded]"));

    expect(rows()).toHaveLength(2);
    expect(rows().map((r) => r.getAttribute("aria-expanded"))).toEqual([
      "false",
      "false",
    ]);

    fireEvent.click(rowCheckbox("a"));
    expect(screen.getByTestId("bulk-count")).toHaveTextContent("1");
    expect(rows().map((r) => r.getAttribute("aria-expanded"))).toEqual([
      "false",
      "false",
    ]);

    // Asserted one key at a time ON PURPOSE: two leaked keypresses toggle the
    // row twice and land back on "false", which hides the bug.
    fireEvent.keyDown(rowCheckbox("a"), { key: " " });
    expect(rows().map((r) => r.getAttribute("aria-expanded"))).toEqual([
      "false",
      "false",
    ]);
    fireEvent.keyDown(rowCheckbox("a"), { key: "Enter" });
    expect(rows().map((r) => r.getAttribute("aria-expanded"))).toEqual([
      "false",
      "false",
    ]);

    // The 44px touch-target ring around the 20px frame selects too.
    const hit = container.querySelectorAll(".th-suggestion-select-hit");
    // One per row + one on the select-all header.
    expect(hit).toHaveLength(3);
    fireEvent.click(hit[2]!);
    expect(screen.getByTestId("bulk-count")).toHaveTextContent("2");
    expect(rows().map((r) => r.getAttribute("aria-expanded"))).toEqual([
      "false",
      "false",
    ]);

    // Sanity: the row itself still toggles the review panel.
    fireEvent.click(rows()[0]!);
    expect(rows()[0]!.getAttribute("aria-expanded")).toBe("true");
  });

  it("select-all covers the loaded rows and reads mixed when partial", () => {
    renderInbox(["a", "b"]);

    fireEvent.click(rowCheckbox("a"));
    expect(selectAllBox()).toHaveAttribute("aria-checked", "mixed");

    clickSelectAll();
    expect(screen.getByTestId("bulk-count")).toHaveTextContent("2");
    expect(selectAllBox()).toHaveAttribute("aria-checked", "true");
  });
});

describe("SuggestionInbox bulk run", () => {
  it("runs SEQUENTIALLY — never more than one call in flight", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    mutateAsyncMock.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );

    renderInbox(["a", "b", "c"]);
    clickSelectAll();
    await approveSelected();

    // Under `Promise.all` this would already be 3.
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0]!(ok);
      await Promise.resolve();
    });
    expect(mutateAsyncMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvers[1]!(ok);
      await Promise.resolve();
    });
    expect(mutateAsyncMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolvers[2]!(ok);
      await Promise.resolve();
    });
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    expect(invalidateMock).toHaveBeenCalledTimes(1);
  });

  it("a second press during a run does not start a second run", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    mutateAsyncMock.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );

    renderInbox(["a", "b"]);
    clickSelectAll();
    await rejectSelected();
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);

    // Whether the disabled button or `bulkRunningRef` catches it, the
    // user-visible property is the same: still one run, still one call.
    await rejectSelected();
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0]!(ok);
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[1]!(ok);
      await Promise.resolve();
    });
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
  });

  it("bulk approve is confirmed first, and cancelling runs nothing", async () => {
    mutateAsyncMock.mockResolvedValue(ok);
    renderInbox(["a", "b"]);
    clickSelectAll();

    await act(async () => {
      fireEvent.click(screen.getByTestId("owner-suggestions-bulk-approve"));
      await Promise.resolve();
    });
    // The count is named in the confirm.
    expect(screen.getByTestId("confirm-title")).toHaveTextContent('"count":2');
    expect(mutateAsyncMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-cancel"));
      await Promise.resolve();
    });
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    // Selection survives a cancel.
    expect(screen.getByTestId("bulk-count")).toHaveTextContent("2");
  });

  it("confirming moves focus to the bulk bar, not to <body>", async () => {
    // `Modal` restores focus to its opener on close, but that opener — the
    // approve button — is disabled by the same render, so the restore is a
    // no-op and focus would land on <body>.
    const resolvers: Array<(v: unknown) => void> = [];
    mutateAsyncMock.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const { container } = renderInbox(["a"]);
    clickSelectAll();
    await approveSelected();

    const parkingSpot = container.querySelector('[tabindex="-1"]');
    expect(parkingSpot).not.toBeNull();
    expect(document.activeElement).toBe(parkingSpot);
    expect(document.activeElement).not.toBe(document.body);

    await act(async () => {
      resolvers[0]!(ok);
      await Promise.resolve();
    });
  });

  it("closes the confirm when the selection empties underneath it", async () => {
    mutateAsyncMock.mockResolvedValue(ok);
    renderInbox(["a", "b"]);
    clickSelectAll();

    await act(async () => {
      fireEvent.click(screen.getByTestId("owner-suggestions-bulk-approve"));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("confirm-ok")).not.toBeNull();

    // Selection drops to zero (here via Clear; in production a background
    // refetch does it). Leaving the dialog open would ask "Approve 0
    // suggestions?" and confirming would be a silent no-op.
    await act(async () => {
      fireEvent.click(screen.getByText("clear"));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("confirm-ok")).toBeNull();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it("reports already-reviewed rows honestly", async () => {
    mutateAsyncMock.mockImplementation(
      ({ suggestionId }: { suggestionId: string }) =>
        suggestionId === "b"
          ? Promise.reject(alreadyReviewed)
          : Promise.resolve(ok),
    );

    renderInbox(["a", "b", "c"]);
    clickSelectAll();
    await approveSelected();

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));

    expect(mutateAsyncMock.mock.calls.map((c) => c[0].suggestionId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // NOT "3 approved": the aggregate names what actually happened.
    expect(toastMock.success).not.toHaveBeenCalled();
    const options = toastMock.warning.mock.calls[0][0];
    expect(options.title).toBe("ownerSuggestions.bulkPartialToast");
    expect(options.message).toContain('"decided":2');
    expect(options.message).toContain('"already":1');
    expect(options.message).toContain('"failed":0');
    expect(options.message).toContain('"conflicted":0');

    // Nothing is retryable, so the whole selection is pruned; one invalidate.
    expect(screen.queryByTestId("bulk-bar")).toBeNull();
    expect(invalidateMock).toHaveBeenCalledTimes(1);
  });

  it("reports a clean run with a single success toast", async () => {
    mutateAsyncMock.mockResolvedValue(ok);
    renderInbox(["a", "b"]);
    clickSelectAll();
    await rejectSelected();

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    expect(toastMock.success.mock.calls[0][0].title).toContain(
      "ownerSuggestions.bulkRejectedToast",
    );
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("counts a partial apply as conflicted, not as a clean approval", async () => {
    mutateAsyncMock.mockResolvedValue({
      appliedFields: ["title"],
      conflictedFields: ["startsAt"],
    });
    renderInbox(["a"]);
    fireEvent.click(rowCheckbox("a"));
    await approveSelected();

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.warning.mock.calls[0][0].message).toContain(
      '"conflicted":1',
    );
  });

  it("closes the open review panel when its row is decided", async () => {
    mutateAsyncMock.mockResolvedValue(ok);
    const { container } = renderInbox(["a", "b"]);

    // Open a's panel, then bulk-reject everything.
    fireEvent.click(container.querySelector("[aria-expanded]")!);
    expect(screen.queryByText("moderation.reviewTitle")).not.toBeNull();

    clickSelectAll();
    await rejectSelected();
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));

    expect(screen.queryByText("moderation.reviewTitle")).toBeNull();
    expect(container.querySelector("[aria-expanded='true']")).toBeNull();
  });

  it("SECOND_FACTOR_REQUIRED aborts the run and keeps the rest selected", async () => {
    mutateAsyncMock.mockImplementation(
      ({ suggestionId }: { suggestionId: string }) =>
        suggestionId === "a"
          ? Promise.reject(secondFactorError)
          : Promise.resolve(ok),
    );

    renderInbox(["a", "b", "c"]);
    clickSelectAll();
    await approveSelected();

    // Only the enrollment toast, and only the first row was attempted.
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    expect(toastMock.warning.mock.calls[0][0].title).toBe(
      "moderation.secondFactorRequiredToast",
    );
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(toastMock.success).not.toHaveBeenCalled();
    // Selection survives so the user can retry after enrolling.
    expect(screen.getByTestId("bulk-count")).toHaveTextContent("3");
  });

  it("TOO_MANY_REQUESTS aborts instead of firing the rest at a closed door", async () => {
    mutateAsyncMock.mockImplementation(
      ({ suggestionId }: { suggestionId: string }) =>
        suggestionId === "b"
          ? Promise.reject(wireOnlyError("TOO_MANY_REQUESTS"))
          : Promise.resolve(ok),
    );

    renderInbox(["a", "b", "c"]);
    clickSelectAll();
    await approveSelected();

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    // a succeeded, b tripped the limit, c was never attempted.
    expect(mutateAsyncMock).toHaveBeenCalledTimes(2);
    const options = toastMock.warning.mock.calls[0][0];
    expect(options.title).toBe("ownerSuggestions.bulkStoppedToast");
    expect(options.message).toContain(
      "ownerSuggestions.bulkStoppedRateLimited",
    );
    expect(options.message).toContain('"decided":1');
    // b and c stay selected for the retry; a is gone.
    expect(screen.getByTestId("bulk-count")).toHaveTextContent("2");
  });

  it("UNAUTHORIZED aborts the run too", async () => {
    mutateAsyncMock.mockRejectedValue(wireOnlyError("UNAUTHORIZED"));

    renderInbox(["a", "b"]);
    clickSelectAll();
    await rejectSelected();

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(toastMock.warning.mock.calls[0][0].message).toContain(
      "ownerSuggestions.bulkStoppedUnauthorized",
    );
    expect(screen.getByTestId("bulk-count")).toHaveTextContent("2");
  });

  it("keeps only the failed rows selected after a mixed run", async () => {
    mutateAsyncMock.mockImplementation(
      ({ suggestionId }: { suggestionId: string }) =>
        suggestionId === "b"
          ? Promise.reject(unknownError)
          : Promise.resolve(ok),
    );

    renderInbox(["a", "b", "c"]);
    clickSelectAll();
    await approveSelected();

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    expect(toastMock.warning.mock.calls[0][0].message).toContain('"failed":1');
    expect(screen.getByTestId("bulk-count")).toHaveTextContent("1");
  });
});

/** Silences an unused-helper lint if the suite is trimmed. */
void tick;
