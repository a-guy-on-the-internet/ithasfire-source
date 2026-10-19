import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SplitsEditor } from "../SplitsEditor";

/**
 * The `resale` feature gate on the splits editor's RESALE tab.
 *
 * Resale is off by default until it is vetted (see `/sell`, which route-gates
 * on the same flag). The per-ticket "Allow resale" controls in
 * TicketTypeEditor were already gated; this tab was not, so an organiser could
 * open it and configure resale revenue splits for a feature nobody can use.
 *
 * What is pinned here is not just "the button is hidden". Hiding a tab is
 * cosmetic if the component still reads and writes that kind — so these also
 * assert the QUERY and the MUTATION fall back to PRIMARY when the gate is off
 * and the tab is somehow still selected (gates load async and can refetch
 * under a session already sitting on the tab).
 *
 * Mock block mirrors SplitsEditorPercent.test.tsx in this directory, and is
 * ENUMERATED rather than a catch-all Proxy: a proxy that answers every
 * property also answers `then`, which makes the module namespace look like a
 * thenable and hangs `import()` forever.
 */

const updateMutate = vi.fn();
const invalidate = vi.fn();
const queryArgs = vi.fn();
const resaleClauseInvalidate = vi.fn();
const termsDealInvalidate = vi.fn();
/** The options `updateEventSplits.useMutation` was last given (its onSuccess). */
let mutationOpts:
  | {
      onSuccess?: (
        data: unknown,
        sent: { kind: string; lines: unknown[]; frozenChange?: boolean },
      ) => void;
      onError?: (err: unknown) => void;
    }
  | undefined;

/** Flipped per test before rendering. */
let resaleGate: boolean | undefined = false;

type ReadLine = {
  id: string;
  payeeKind: "human" | "org";
  payeeId: string;
  payeeSubjectId: string | null;
  ticketTypeId: string | null;
  percentBps: number;
  floorCents: number;
  capPercent?: number | null;
  priority: number;
  payeeDisplayName: string | null;
  source: "owner" | "lineup-picker" | "manual";
  requiresConfirmation: boolean;
  confirmationStatus: null;
  payeeStatus: "active";
};

const defaultLines = (): ReadLine[] => [
    {
      id: "line_1",
      payeeKind: "human" as const,
      payeeId: "hum_1",
      payeeSubjectId: "hum_1",
      ticketTypeId: null,
      percentBps: 1000,
      floorCents: 0,
      priority: 0,
      payeeDisplayName: "Sound Engineer",
      source: "manual" as const,
      requiresConfirmation: false,
      confirmationStatus: null,
      payeeStatus: "active" as const,
    },
];

const splitsData = {
  lines: defaultLines(),
  lineupSuggestions: [] as unknown[],
  publishGateBlockers: [] as string[],
};

vi.mock("tamagui", () => {
  const passthrough = ({
    children,
    onPress,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    "data-testid"?: string;
  }) => (
    <div data-testid={testId} onClick={onPress}>
      {children}
    </div>
  );
  return { XStack: passthrough, YStack: passthrough, styled: () => passthrough };
});

vi.mock("lucide-react", () => {
  const icon = () => <span />;
  return {
    Lock: icon,
    Plus: icon,
    Save: icon,
    Sparkles: icon,
    Trash2: icon,
    Users: icon,
    ChevronDown: icon,
  };
});

vi.mock("@th/ui", () => ({
  useLocale: () => "en",
  Text: ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={testId}>{children}</span>,
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Spinner: () => <span />,
  RangeSlider: () => <button type="button" data-testid="range-slider" />,
  TextInput: ({
    value,
    onChangeText,
    testId,
  }: {
    value?: string;
    onChangeText?: (v: string) => void;
    testId?: string;
  }) => (
    <input
      data-testid={testId}
      value={value ?? ""}
      onChange={(e) => onChangeText?.(e.target.value)}
    />
  ),
  Button: ({
    children,
    onPress,
    disabled,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
  useFormatters: () => ({ number: (n: number) => String(n) }),
  // Echo the key (and any values) so an assertion can tell i18n copy from a
  // hardcoded literal.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

/** The deal read the lines frame follows (freeze state). */
let termsData: unknown = undefined;
/** False: the lines read has not landed yet. */
let splitsReady = true;

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: { getEventSplits: { invalidate } },
      deals: {
        getTermsDeal: { invalidate: termsDealInvalidate },
        projectTermsDeal: { invalidate: vi.fn() },
        getResaleClause: { invalidate: resaleClauseInvalidate },
        listDealChanges: { invalidate: vi.fn() },
      },
    }),
    deals: {
      getTermsDeal: {
        useQuery: () => ({ data: termsData, isLoading: false, error: null }),
      },
    },
    events: {
      getEventForEdit: {
        useQuery: () => ({ data: { orgId: "org_1", humanId: null } }),
      },
      getEventSplits: {
        useQuery: (input: unknown) => {
          queryArgs(input);
          return splitsReady
            ? { data: splitsData, isLoading: false, error: null }
            : { data: undefined, isLoading: true, error: null };
        },
      },
      updateEventSplits: {
        useMutation: (opts: typeof mutationOpts) => {
          mutationOpts = opts;
          return { mutate: updateMutate, isPending: false };
        },
      },
    },
  },
}));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
// "The deal" (A3) sits above the lines; it has its own tests.
// The real portion split: the RESALE tab must show what the clause block shows.
vi.mock("@/components/deals", async () => {
  const model = await vi.importActual<
    typeof import("@/components/deals/resale-clause-model")
  >("@/components/deals/resale-clause-model");
  return {
    DealEditor: () => <div data-testid="deal-editor" />,
    ResaleClause: () => null,
    classifyDealReadError: () => ({ kind: "ERROR" }),
    recipientPortions: model.recipientPortions,
  };
});
vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({ ownersWithSlugs: [] }),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "acme" }) }));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({
    gates: resaleGate === undefined ? undefined : { resale: resaleGate },
    isLoading: resaleGate === undefined,
  }),
}));
vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (e: unknown) => String(e),
}));
vi.mock("../HumanSearchCombobox", () => ({
  HumanSearchCombobox: () => <div data-testid="human-search" />,
}));
vi.mock("../_mobile-bits", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    EditorCard: passthrough,
    EditorCardActions: passthrough,
    EditorCardMeta: passthrough,
    EditorCardTitle: passthrough,
  };
});

const RESALE_TAB = "admin.ebSplitsTabResale";
const TICKETS_TAB = "admin.ebSplitsTabTickets";

/** The `kind` the read query was last called with. */
const lastQueriedKind = () => {
  const calls = queryArgs.mock.calls;
  return (calls[calls.length - 1]?.[0] as { kind: string } | undefined)?.kind;
};

describe("SplitsEditor — resale feature gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resaleGate = false;
    splitsData.lines = defaultLines();
  });
  afterEach(cleanup);

  it("a RESALE lines save re-reads the resale clause (its recipients and version moved)", () => {
    // Without this the clause block remounts from a cached read with the old
    // version and no recipients, and its next save is refused as a conflict.
    resaleGate = true;
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));

    mutationOpts?.onSuccess?.({}, { kind: "RESALE", lines: [] });

    expect(resaleClauseInvalidate).toHaveBeenCalledWith({
      target: { kind: "EVENT", eventId: "evt_1" },
    });
  });

  it("a ticket-sales lines save leaves the resale clause read alone", () => {
    render(<SplitsEditor eventId="evt_1" />);

    mutationOpts?.onSuccess?.({}, { kind: "PRIMARY", lines: [] });

    expect(resaleClauseInvalidate).not.toHaveBeenCalled();
    expect(termsDealInvalidate).toHaveBeenCalled();
  });

  it("hides the RESALE tab when the gate is off", () => {
    render(<SplitsEditor eventId="evt_1" />);

    expect(screen.queryByText(RESALE_TAB)).toBeNull();
    // The other tabs are untouched — this is a gate, not a redesign.
    expect(screen.getByText(TICKETS_TAB)).toBeInTheDocument();
  });

  it("shows the RESALE tab when the gate is on", () => {
    resaleGate = true;
    render(<SplitsEditor eventId="evt_1" />);

    expect(screen.getByText(RESALE_TAB)).toBeInTheDocument();
  });

  it("keeps the tab hidden while gates are still loading", () => {
    // `gates` is undefined mid-flight. Reading that as "on" would flash the
    // tab in and rip it away; the gate must fail CLOSED.
    resaleGate = undefined;
    render(<SplitsEditor eventId="evt_1" />);

    expect(screen.queryByText(RESALE_TAB)).toBeNull();
  });

  it("never reads RESALE splits while the gate is off", () => {
    render(<SplitsEditor eventId="evt_1" />);

    expect(lastQueriedKind()).toBe("PRIMARY");
    expect(
      queryArgs.mock.calls.some(
        (c) => (c[0] as { kind: string }).kind === "RESALE",
      ),
    ).toBe(false);
  });

  it("falls back to PRIMARY when the gate turns off under a selected RESALE tab", () => {
    // Open the tab legitimately, then revoke the gate — what happens when
    // staff flips it in /platform while an organiser has the tab open.
    resaleGate = true;
    const { rerender } = render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));
    expect(lastQueriedKind()).toBe("RESALE");

    resaleGate = false;
    rerender(<SplitsEditor eventId="evt_1" />);

    expect(screen.queryByText(RESALE_TAB)).toBeNull();
    expect(lastQueriedKind()).toBe("PRIMARY");
  });

  it("saves PRIMARY, not RESALE, if the gate drops while the tab is selected", () => {
    resaleGate = true;
    const { rerender } = render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));

    resaleGate = false;
    rerender(<SplitsEditor eventId="evt_1" />);
    // Back on ticket sales, whose lines are folded under "The deal" (A3).
    fireEvent.click(screen.getByTestId("eb-deal-lines-toggle"));
    fireEvent.click(screen.getByTestId("splits-save"));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect((updateMutate.mock.calls[0]![0] as { kind: string }).kind).toBe(
      "PRIMARY",
    );
  });
});

// ── The RESALE lines: no owner remainder ────────────────────────────────
// Finalize splits the whole resale share over the stored RESALE lines
// (`computeOrderSplits`): each its percentage, the rest handed round them
// evenly. Nothing is left for an owner, so a line whose payee is the event's
// organiser is an ordinary recipient there.

/** The organiser at 40% and a sound engineer at 10%. */
const ownerAndEngineer = (): ReadLine[] => [
  {
    id: "line_owner",
    payeeKind: "org",
    payeeId: "pay_org",
    payeeSubjectId: "org_1",
    ticketTypeId: null,
    percentBps: 4000,
    floorCents: 0,
    capPercent: null,
    priority: 0,
    payeeDisplayName: "The Room",
    source: "owner",
    requiresConfirmation: false,
    confirmationStatus: null,
    payeeStatus: "active",
  },
  {
    id: "line_eng",
    payeeKind: "human",
    payeeId: "pay_eng",
    payeeSubjectId: "hum_eng",
    ticketTypeId: null,
    percentBps: 1000,
    floorCents: 0,
    capPercent: null,
    priority: 0,
    payeeDisplayName: "Sound Engineer",
    source: "manual",
    requiresConfirmation: true,
    confirmationStatus: null,
    payeeStatus: "active",
  },
];

const sentLines = () =>
  (updateMutate.mock.calls[0]![0] as {
    lines: { id?: string; payeeRef: { kind: string; id: string } }[];
  }).lines;

describe("SplitsEditor — RESALE lines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resaleGate = true;
    splitsData.lines = ownerAndEngineer();
  });
  afterEach(cleanup);

  it("shows no owner remainder, and says how the share is really split", () => {
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));

    expect(screen.queryByText(/admin\.ebSplitsOwnerLegend/)).toBeNull();
    expect(screen.queryByText("admin.ebSplitsOwnerDesc")).toBeNull();
    expect(screen.queryByText("Auto")).toBeNull();
    expect(screen.queryByText("admin.ebSplitsBalanced")).toBeNull();
    expect(screen.getByTestId("eb-splits-resale-caption")).toHaveTextContent(
      "deals.resale.lines.caption",
    );
    // The organiser's own line reads as theirs, not as "gets the rest".
    expect(screen.getByText("deals.resale.lines.ownerSource")).toBeInTheDocument();
  });

  it("shows each line's real portion: its percentage plus an even part of what is left", () => {
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));

    // 40% + half of the 50% left over = 65%; 10% + 25% = 35%.
    expect(screen.getByTestId("splits-portion-0")).toHaveTextContent(
      'deals.resale.percentOfShare {"percent":"65"}',
    );
    expect(screen.getByTestId("splits-portion-1")).toHaveTextContent(
      'deals.resale.percentOfShare {"percent":"35"}',
    );
  });

  it("a lone line gets all of the share, whatever its percentage", () => {
    splitsData.lines = ownerAndEngineer().slice(1);
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));

    expect(screen.getByTestId("splits-portion-0")).toHaveTextContent(
      "deals.resale.portionAll",
    );
  });

  it("the organiser's RESALE line survives a save", () => {
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));
    fireEvent.click(screen.getByTestId("splits-save"));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(sentLines()).toEqual([
      expect.objectContaining({
        id: "line_owner",
        payeeRef: { kind: "org", id: "org_1" },
      }),
      expect.objectContaining({
        id: "line_eng",
        payeeRef: { kind: "human", id: "hum_eng" },
      }),
    ]);
  });

  it("blocks a RESALE save over 100%, in its own words", () => {
    // 70% + 70%: finalize would take 40 points back from the last line, so
    // someone who agreed to 70% would be paid 30%.
    splitsData.lines = ownerAndEngineer().map((l) => ({ ...l, percentBps: 7000 }));
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));

    // Under the SAVE heading, not "Before you can publish".
    const saveBlockers = screen.getByTestId("eb-splits-save-blockers");
    expect(saveBlockers).toHaveTextContent("deals.splits.saveBlockersTitle");
    expect(saveBlockers).toHaveTextContent(/deals\.resale\.lines\.overTotal/);
    expect(screen.queryByTestId("eb-splits-publish-blockers")).toBeNull();
    // The header can't say "Ready" over lines that can't be saved.
    expect(screen.queryByText("admin.ebSplitsReady")).toBeNull();
    expect(screen.getByText("admin.ebSplitsNeedsAttention")).toBeInTheDocument();
    // No owner-remainder wording on RESALE.
    expect(screen.queryByText(/admin\.ebSplitsBlockerOverAllocated/)).toBeNull();
    expect(screen.queryByText(/admin\.ebSplitsOverBy/)).toBeNull();

    fireEvent.click(screen.getByTestId("splits-save"));
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("saves a RESALE total of exactly 100%", () => {
    splitsData.lines = ownerAndEngineer().map((l, i) => ({
      ...l,
      percentBps: i === 0 ? 6000 : 4000,
    }));
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));
    fireEvent.click(screen.getByTestId("splits-save"));

    expect(updateMutate).toHaveBeenCalledTimes(1);
  });

  it("sends a stored cap back unchanged (the server stores what it is sent)", () => {
    splitsData.lines = ownerAndEngineer().map((l, i) =>
      i === 1 ? { ...l, capPercent: 5 } : l,
    );
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));
    fireEvent.click(screen.getByTestId("splits-save"));

    expect(sentLines()[1]).toMatchObject({ id: "line_eng", capPercent: 5 });
    expect(sentLines()[0]).toMatchObject({ id: "line_owner", capPercent: null });
  });

  it("a line whose payee can't be named blocks Save; no other id is sent", () => {
    splitsData.lines = ownerAndEngineer().map((l, i) =>
      i === 1 ? { ...l, payeeSubjectId: null } : l,
    );
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));

    expect(screen.getByTestId("eb-splits-save-blockers")).toHaveTextContent(
      /deals\.splits\.payeeUnknown/,
    );
    fireEvent.click(screen.getByTestId("splits-save"));
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("names a line whose payee is gone, so the blocker's row can be found", () => {
    splitsData.lines = ownerAndEngineer().map((l, i) =>
      i === 1 ? { ...l, payeeSubjectId: null, payeeDisplayName: null } : l,
    );
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));

    expect(screen.getByText("deals.splits.payeeNotFound")).toBeInTheDocument();
  });
});

describe("SplitsEditor — ticket-sales lines keep the owner remainder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resaleGate = true;
    splitsData.lines = ownerAndEngineer();
  });
  afterEach(cleanup);

  it("shows the owner's derived remainder and leaves it out of the save", () => {
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("eb-deal-lines-toggle"));

    expect(screen.getByText(/admin\.ebSplitsOwnerLegend/)).toBeInTheDocument();
    expect(screen.getAllByText("admin.ebSplitsOwnerDesc").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("eb-splits-resale-caption")).toBeNull();
    expect(screen.queryByTestId("splits-portion-0")).toBeNull();

    fireEvent.click(screen.getByTestId("splits-save"));
    // The remainder is derived, never stored from here; the other line goes
    // back under its SUBJECT id, not its Payee row id.
    expect(sentLines()).toEqual([
      expect.objectContaining({
        id: "line_eng",
        payeeRef: { kind: "human", id: "hum_eng" },
      }),
    ]);
  });

  it("a ticket-sales line whose payee can't be named blocks Save too", () => {
    splitsData.lines = ownerAndEngineer().map((l, i) =>
      i === 1 ? { ...l, payeeSubjectId: null } : l,
    );
    render(<SplitsEditor eventId="evt_1" />);
    // The blocker opens the lines on its own.
    expect(screen.getByText(/deals\.splits\.payeeUnknown/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("splits-save"));
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("still flags over-allocation on ticket sales", () => {
    splitsData.lines = ownerAndEngineer().map((l) => ({ ...l, percentBps: 7000 }));
    splitsData.lines[0]!.source = "manual";
    render(<SplitsEditor eventId="evt_1" />);
    // A blocker opens the lines on its own; no toggle press.

    expect(
      screen.getAllByText(/admin\.ebSplitsBlockerOverAllocated/).length,
    ).toBeGreaterThan(0);
  });
});

describe("SplitsEditor — a frozen deal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resaleGate = true;
    splitsData.lines = ownerAndEngineer();
    termsData = {
      dealFreeze: {
        eventId: "evt_1",
        dealFrozenAt: new Date("2026-10-14T19:00:00.000Z"),
        dealFrozenByHumanId: null,
      },
    };
  });
  afterEach(() => {
    cleanup();
    termsData = undefined;
  });

  it("ticket sales: the lines are read-only and point at the deal's one way in", () => {
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("eb-deal-lines-toggle"));
    expect(screen.getByTestId("eb-splits-frozen-body")).toHaveTextContent(
      "deals.freeze.linesBody",
    );
    // No second "Change the frozen terms", no Save, no footer of its own.
    expect(screen.queryByTestId("eb-splits-change-frozen")).toBeNull();
    expect(screen.queryByTestId("splits-save")).toBeNull();
    expect(screen.queryByTestId("eb-splits-frozen-footer")).toBeNull();
    expect(
      screen.getByTestId("eb-splits-lines-body").getAttribute("data-locked"),
    ).toBe("true");
  });

  it("ticket sales: the locked lines are text, with nothing to press or type", () => {
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("eb-deal-lines-toggle"));
    const body = screen.getByTestId("eb-splits-lines-body");
    expect(body.querySelector("input, button")).toBeNull();
    expect(screen.queryByTestId("splits-add-from-search")).toBeNull();
    expect(screen.queryByTestId("splits-new-percent")).toBeNull();
    expect(screen.queryByTestId("splits-remove-0")).toBeNull();
    expect(screen.queryByTestId("splits-remove-1")).toBeNull();
    // Owner remainder 90%, engineer 10%: names and shares read as text.
    expect(screen.getByTestId("splits-frozen-line-0")).toHaveTextContent(
      "The Room",
    );
    expect(screen.getByTestId("splits-frozen-line-0")).toHaveTextContent("90%");
    expect(screen.getByTestId("splits-frozen-line-1")).toHaveTextContent(
      "Sound Engineer",
    );
    expect(screen.getByTestId("splits-frozen-line-1")).toHaveTextContent("10%");
    // Frozen, the frame's "a change here shows in the deal above" is gone.
    expect(screen.queryByText("deals.splits.linesHint")).toBeNull();
  });

  it("resale, before the change opens: the lines are readable text too", () => {
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));
    const body = screen.getByTestId("eb-splits-lines-body");
    expect(body.querySelector("input, button")).toBeNull();
    expect(screen.getByTestId("splits-frozen-line-0")).toHaveTextContent(
      "The Room",
    );
    expect(screen.getByTestId("splits-frozen-line-0")).toHaveTextContent("40%");
    expect(screen.getByTestId("splits-portion-0")).toHaveTextContent(
      'deals.resale.percentOfShare {"percent":"65"}',
    );
  });

  it("resale: Save turns on after an edit, and off again when the edit is undone", () => {
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));
    fireEvent.click(screen.getByTestId("eb-splits-change-frozen"));
    expect(screen.getByTestId("splits-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("splits-percent-1"), {
      target: { value: "20" },
    });
    expect(screen.getByTestId("splits-save")).not.toBeDisabled();
    fireEvent.change(screen.getByTestId("splits-percent-1"), {
      target: { value: "10" },
    });
    expect(screen.getByTestId("splits-save")).toBeDisabled();
  });

  it("ticket sales: a freeze over unsaved edits shows the read, and re-reads it", () => {
    termsData = undefined;
    const view = render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("eb-deal-lines-toggle"));
    fireEvent.change(screen.getByTestId("splits-percent-1"), {
      target: { value: "30" },
    });
    invalidate.mockClear();
    termsData = {
      dealFreeze: {
        eventId: "evt_1",
        dealFrozenAt: new Date("2026-10-14T19:00:00.000Z"),
        dealFrozenByHumanId: null,
      },
    };
    view.rerender(<SplitsEditor eventId="evt_1" />);
    const row = screen.getByTestId("splits-frozen-line-1");
    expect(row).toHaveTextContent("10%");
    expect(row).not.toHaveTextContent("30%");
    expect(invalidate).toHaveBeenCalledWith({ eventId: "evt_1", kind: "PRIMARY" });
  });

  it("a fresh load where the freeze lands before the lines asks for no extra re-read", () => {
    termsData = undefined;
    splitsReady = false;
    try {
      const view = render(<SplitsEditor eventId="evt_1" />);
      termsData = {
        dealFreeze: {
          eventId: "evt_1",
          dealFrozenAt: new Date("2026-10-14T19:00:00.000Z"),
          dealFrozenByHumanId: null,
        },
      };
      view.rerender(<SplitsEditor eventId="evt_1" />);
      splitsReady = true;
      view.rerender(<SplitsEditor eventId="evt_1" />);
      expect(invalidate).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("eb-deal-lines-toggle"));
      expect(screen.getByTestId("splits-frozen-line-1")).toHaveTextContent("10%");
    } finally {
      splitsReady = true;
    }
  });

  it("ticket sales, locked: publish blockers show inside the locked lines, fold open", () => {
    splitsData.publishGateBlockers = ["payee_not_active"];
    try {
      render(<SplitsEditor eventId="evt_1" />);
      // No toggle press: a publish blocker opens the fold by itself.
      const body = screen.getByTestId("eb-splits-lines-body");
      expect(body.getAttribute("data-locked")).toBe("true");
      expect(
        within(body).getByTestId("eb-splits-publish-blockers"),
      ).toBeTruthy();
    } finally {
      splitsData.publishGateBlockers = [];
    }
  });

  it("resale: a frozen save that lands closes the change and keeps what was saved", () => {
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));
    fireEvent.click(screen.getByTestId("eb-splits-change-frozen"));
    fireEvent.change(screen.getByTestId("splits-percent-1"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByTestId("splits-save"));
    const sent = updateMutate.mock.calls[0]![0] as {
      kind: string;
      lines: unknown[];
      frozenChange?: boolean;
    };
    expect(sent.frozenChange).toBe(true);
    act(() => mutationOpts?.onSuccess?.({}, sent));
    // Locked again, showing the saved 20%, not the old read's 10%.
    expect(screen.queryByTestId("eb-splits-frozen-footer")).toBeNull();
    const row = screen.getByTestId("splits-frozen-line-1");
    expect(row).toHaveTextContent("20%");
    expect(row).not.toHaveTextContent("10%");
  });

  it("resale on a booked event: a save refused as frozen keeps the edits and opens the change", () => {
    // The deal read can't say (owned by a booking): the lines edit as usual.
    termsData = undefined;
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));
    fireEvent.change(screen.getByTestId("splits-percent-1"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByTestId("splits-save"));
    expect(updateMutate.mock.calls[0]![0]).not.toHaveProperty("frozenChange");
    act(() =>
      mutationOpts?.onError?.({
        data: { appCode: "DEAL_FROZEN" },
        message: "DEAL_FROZEN",
      }),
    );
    expect(screen.getByTestId("splits-percent-1")).toHaveValue("20");
    expect(screen.getByTestId("eb-splits-frozen-footer")).toBeTruthy();
    fireEvent.click(screen.getByTestId("splits-save"));
    expect(updateMutate.mock.calls[1]![0]).toMatchObject({
      kind: "RESALE",
      frozenChange: true,
    });
  });

  it("resale (no deal editor above): its lines open their own frozen change", () => {
    render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByText(RESALE_TAB));
    fireEvent.click(screen.getByTestId("eb-splits-change-frozen"));
    expect(screen.getByTestId("eb-splits-frozen-footer")).toBeTruthy();
    fireEvent.change(screen.getByTestId("splits-percent-1"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByTestId("splits-save"));
    expect(updateMutate.mock.calls[0]![0]).toMatchObject({
      kind: "RESALE",
      frozenChange: true,
    });
  });
});

