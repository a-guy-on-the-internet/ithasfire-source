import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HumanJob } from "@th/core/lib/human-jobs";

const testMocks = vi.hoisted(() => ({
  setData: vi.fn(),
  invalidate: vi.fn(),
  mutate: vi.fn(),
  useQuery: vi.fn(),
  useSession: vi.fn(),
}));

/**
 * `useUtils()` and `useMutation()` return a BRAND NEW object on every call —
 * which is what react-query and the tRPC recursive proxy actually do in
 * production.
 *
 * The previous version of this mock handed back hoisted singletons and
 * commented that the component "MUST" receive stable references. That made the
 * suite green for a property the MOCK supplied rather than one the code had:
 * the real component had both objects in its debounce effect's dependency
 * array, so in the browser the 800ms timer re-armed on every commit and a save
 * slower than the debounce re-fired itself indefinitely. Handing out fresh
 * objects here is what makes "the deps are stable" a testable claim.
 */
vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      humans: {
        getMyProfile: {
          setData: testMocks.setData,
          invalidate: testMocks.invalidate,
        },
      },
    }),
    humans: {
      getMyProfile: { useQuery: testMocks.useQuery },
      updateJobs: { useMutation: () => ({ mutate: testMocks.mutate }) },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: testMocks.useSession },
}));

vi.mock("lucide-react", () => ({
  Briefcase: () => null,
}));

// Stacks forward `role`, `aria-*` and `data-*` to the DOM. Without this the
// mock silently swallows exactly the attributes the live-region tests assert,
// which is the "unit tests mock the design system away" failure mode: the
// status text rendered fine in the browser while being announced to nobody,
// and a prop-dropping mock could never have caught it.
vi.mock("tamagui", () => {
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key === "role" || key.startsWith("aria-") || key.startsWith("data-")) {
        domProps[key] = value;
      }
    }
    return <div {...domProps}>{children}</div>;
  };
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("../settings-primitives", () => ({
  SectionCard: ({ children }: { children?: ReactNode }) => (
    <section>{children}</section>
  ),
}));

vi.mock("@th/ui", () => ({
  Spinner: () => <span>Loading</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TagMultiSelect: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
    placeholder?: string;
  }) => (
    <div>
      <span data-testid="genre-tags">{value.join(",")}</span>
      <button
        type="button"
        onClick={() => onChange([...value, "Jazz"])}
        aria-label={placeholder}
      >
        add-genre
      </button>
    </div>
  ),
  useTranslations: () => (key: string) => key,
}));

vi.mock("../../../../_components/place-review/_primitives/HumanJobsPicker", () => ({
  HumanJobsPicker: ({
    jobs,
    otherJobDescription,
    onJobsChange,
    onOtherDescriptionChange,
    otherInputAriaLabel,
  }: {
    jobs: HumanJob[];
    otherJobDescription: string;
    onJobsChange: (next: HumanJob[]) => void;
    onOtherDescriptionChange: (next: string) => void;
    otherInputAriaLabel: string;
  }) => (
    <div>
      <span data-testid="jobs">{jobs.join(",")}</span>
      <button type="button" onClick={() => onJobsChange(["MUSICIAN"])}>
        pick-musician
      </button>
      <button type="button" onClick={() => onJobsChange(["SOUND_ENGINEER"])}>
        pick-sound-engineer
      </button>
      <input
        aria-label={otherInputAriaLabel}
        value={otherJobDescription}
        onChange={(event) => onOtherDescriptionChange(event.target.value)}
      />
    </div>
  ),
}));

import { trpc } from "@/trpc";

import { RolesCraftSection } from "../RolesCraftSection";

const DEBOUNCE_MS = 800;
const SAVED_STATUS_MS = 1800;

function mockProfile(
  data: {
    jobs?: string[];
    genreTags?: string[];
    otherJobDescription?: string | null;
  } | null,
) {
  testMocks.useQuery.mockReturnValue({
    data:
      data === null
        ? undefined
        : {
            jobs: data.jobs ?? [],
            genreTags: data.genreTags ?? [],
            otherJobDescription: data.otherJobDescription ?? "",
          },
    isLoading: false,
  });
}

/** Last `mutate(payload, callbacks)` call's option bag. */
function lastMutateCallbacks() {
  const call = testMocks.mutate.mock.calls.at(-1);
  return call?.[1] as {
    onSuccess: () => void;
    onError: () => void;
  };
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("RolesCraftSection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    testMocks.setData.mockReset();
    testMocks.invalidate.mockReset();
    testMocks.mutate.mockReset();
    testMocks.useQuery.mockReset();
    testMocks.useSession.mockReset();
    testMocks.useSession.mockReturnValue({ data: { user: { id: "u1" } } });
    mockProfile({ jobs: ["MUSICIAN"], genreTags: ["Rock"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds jobs and genres from the profile without auto-saving", () => {
    render(<RolesCraftSection />);

    expect(screen.getByTestId("jobs")).toHaveTextContent("MUSICIAN");
    expect(screen.getByTestId("genre-tags")).toHaveTextContent("Rock");

    // Seeding is not an edit — nothing should be queued or sent.
    advance(DEBOUNCE_MS);
    expect(testMocks.mutate).not.toHaveBeenCalled();
    expect(screen.queryByText("account.sWorkSaving")).toBeNull();
  });

  it("debounces the save and reports saving → saved → idle", () => {
    render(<RolesCraftSection />);

    fireEvent.click(screen.getByText("pick-sound-engineer"));

    // Status flips immediately, but the request waits out the debounce.
    expect(screen.getByText("account.sWorkSaving")).toBeInTheDocument();
    advance(DEBOUNCE_MS - 1);
    expect(testMocks.mutate).not.toHaveBeenCalled();

    advance(1);
    expect(testMocks.mutate).toHaveBeenCalledTimes(1);
    expect(testMocks.mutate.mock.calls[0]?.[0]).toEqual({
      jobs: ["SOUND_ENGINEER"],
      // Dropping the only genre-bearing job clears the genre tags.
      genreTags: [],
      otherJobDescription: undefined,
    });

    act(() => lastMutateCallbacks().onSuccess());
    expect(screen.getByText("account.sWorkSaved")).toBeInTheDocument();
    expect(testMocks.setData).toHaveBeenCalledTimes(1);

    advance(SAVED_STATUS_MS);
    expect(screen.queryByText("account.sWorkSaved")).toBeNull();
  });

  it("collapses rapid edits into a single request", () => {
    render(<RolesCraftSection />);

    fireEvent.click(screen.getByText("pick-sound-engineer"));
    advance(DEBOUNCE_MS - 100);
    fireEvent.click(screen.getByText("pick-musician"));
    advance(DEBOUNCE_MS - 100);
    expect(testMocks.mutate).not.toHaveBeenCalled();

    advance(100);
    expect(testMocks.mutate).toHaveBeenCalledTimes(1);
    expect(testMocks.mutate.mock.calls[0]?.[0]).toMatchObject({
      jobs: ["MUSICIAN"],
    });
  });

  it("surfaces a failed save", () => {
    render(<RolesCraftSection />);

    fireEvent.click(screen.getByText("pick-sound-engineer"));
    advance(DEBOUNCE_MS);

    act(() => lastMutateCallbacks().onError());
    expect(screen.getByText("account.sWorkSaveFailed")).toBeInTheDocument();
    expect(testMocks.setData).not.toHaveBeenCalled();
  });

  it("ignores a stale response so it cannot clobber newer state", () => {
    render(<RolesCraftSection />);

    fireEvent.click(screen.getByText("pick-sound-engineer"));
    advance(DEBOUNCE_MS);
    const stale = lastMutateCallbacks();

    fireEvent.click(screen.getByText("pick-musician"));
    advance(DEBOUNCE_MS);
    const current = lastMutateCallbacks();
    expect(testMocks.mutate).toHaveBeenCalledTimes(2);
    expect(current).not.toBe(stale);

    // The first request resolves last. Its success must be discarded.
    act(() => stale.onSuccess());
    expect(screen.queryByText("account.sWorkSaved")).toBeNull();
    expect(screen.getByText("account.sWorkSaving")).toBeInTheDocument();
    expect(testMocks.setData).not.toHaveBeenCalled();

    act(() => current.onSuccess());
    expect(screen.getByText("account.sWorkSaved")).toBeInTheDocument();
    expect(testMocks.setData).toHaveBeenCalledTimes(1);
  });

  // ── Unmount is now routine, so it must not lose the edit ──────────────────
  // Settings is one route per section: clicking any nav row unmounts this
  // card. The status line already says "Saving changes…" the instant a chip is
  // toggled, so cancelling the pending request told the user it saved while
  // dropping it. These pin the flush.

  it("flushes a pending save when unmounted mid-debounce", () => {
    const { unmount } = render(<RolesCraftSection />);

    fireEvent.click(screen.getByText("pick-sound-engineer"));
    // The claim the component has already made to the user.
    expect(screen.getByText("account.sWorkSaving")).toBeInTheDocument();

    unmount();

    expect(testMocks.mutate).toHaveBeenCalledTimes(1);
    expect(testMocks.mutate.mock.calls[0]?.[0]).toMatchObject({
      jobs: ["SOUND_ENGINEER"],
    });

    // The dead timer's deadline must not produce a second request.
    advance(DEBOUNCE_MS + SAVED_STATUS_MS);
    expect(testMocks.mutate).toHaveBeenCalledTimes(1);
  });

  it("marks the profile stale on an unmount flush", () => {
    const { unmount } = render(<RolesCraftSection />);

    fireEvent.click(screen.getByText("pick-sound-engineer"));
    unmount();

    // react-query may never deliver onSuccess to a torn-down observer, so the
    // optimistic cache write can't be relied on. Stale-without-refetch makes
    // the next mount read truth instead of pre-edit chips.
    expect(testMocks.invalidate).toHaveBeenCalledWith(undefined, {
      refetchType: "none",
    });
  });

  it("does not flush on unmount when nothing is pending", () => {
    const { unmount } = render(<RolesCraftSection />);

    unmount();

    expect(testMocks.mutate).not.toHaveBeenCalled();
    expect(testMocks.invalidate).not.toHaveBeenCalled();
  });

  it("does not schedule the saved-status timer after an unmount flush", () => {
    const { unmount } = render(<RolesCraftSection />);

    fireEvent.click(screen.getByText("pick-sound-engineer"));
    unmount();

    // Resolving after teardown still writes the cache (real data) but must not
    // touch component state on a dead component.
    act(() => lastMutateCallbacks().onSuccess());
    expect(testMocks.setData).toHaveBeenCalledTimes(1);
    advance(SAVED_STATUS_MS);
  });

  // ── The debounce must not re-arm on every commit ──────────────────────────

  it("keeps the debounce armed across renders that hand it fresh trpc objects", () => {
    const { rerender } = render(<RolesCraftSection />);

    fireEvent.click(screen.getByText("pick-sound-engineer"));

    // Every render gives the component a NEW mutation result and a NEW utils
    // proxy (see the @/trpc mock). If either were in the debounce effect's
    // dependency array, these re-renders would clear and re-arm the 800ms
    // timer and nothing would have fired at the original deadline.
    advance(DEBOUNCE_MS - 200);
    rerender(<RolesCraftSection />);
    rerender(<RolesCraftSection />);
    advance(200);

    expect(testMocks.mutate).toHaveBeenCalledTimes(1);

    // A render while the save is in flight — which is exactly what the
    // mutation's own state transitions cause — must not duplicate it.
    rerender(<RolesCraftSection />);
    advance(DEBOUNCE_MS);
    expect(testMocks.mutate).toHaveBeenCalledTimes(1);
  });

  // ── The save confirmation has to reach the user ───────────────────────────
  // This card auto-saves; its own description promises "we save changes
  // automatically". A status the user never perceives is the same as no status.

  it("announces the save cycle in a live region that is always mounted", () => {
    render(<RolesCraftSection />);

    // The region must EXIST before its content changes — a live region that is
    // inserted along with its text is not announced.
    const region = screen.getByTestId("work-save-status");
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();

    fireEvent.click(screen.getByText("pick-sound-engineer"));

    // Rendered INSIDE the region, not merely set in state.
    expect(region).toHaveTextContent("account.sWorkSaving");

    advance(DEBOUNCE_MS);
    act(() => lastMutateCallbacks().onSuccess());
    expect(region).toHaveTextContent("account.sWorkSaved");

    advance(SAVED_STATUS_MS);
    expect(region).toBeEmptyDOMElement();
  });

  it("renders a failed save inside the same region", () => {
    render(<RolesCraftSection />);

    fireEvent.click(screen.getByText("pick-sound-engineer"));
    advance(DEBOUNCE_MS);
    act(() => lastMutateCallbacks().onError());

    expect(screen.getByTestId("work-save-status")).toHaveTextContent(
      "account.sWorkSaveFailed",
    );
  });

  it("guards the guard: the trpc mock really is unstable per call", () => {
    // If this mock ever reverts to hoisted singletons, the test above would
    // pass for the wrong reason — it would be asserting a property the mock
    // supplies rather than one the component has.
    expect(trpc.useUtils()).not.toBe(trpc.useUtils());
    expect(trpc.humans.updateJobs.useMutation()).not.toBe(
      trpc.humans.updateJobs.useMutation(),
    );
  });

  it("saves the free-text role description", () => {
    render(<RolesCraftSection />);

    fireEvent.change(screen.getByLabelText("account.sWorkOtherLabel"), {
      target: { value: "  Tour manager  " },
    });
    advance(DEBOUNCE_MS);

    expect(testMocks.mutate.mock.calls[0]?.[0]).toMatchObject({
      otherJobDescription: "Tour manager",
    });
  });
});
