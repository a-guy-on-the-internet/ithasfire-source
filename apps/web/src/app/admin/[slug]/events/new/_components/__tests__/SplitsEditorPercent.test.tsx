import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SplitsEditor } from "../SplitsEditor";

/**
 * The percent wiring, end to end through the real component.
 *
 * The pure reader is covered by `split-percent-field.test.ts`; what this file
 * pins is the SEAM it can't see — that a typed share reaches
 * `updateEventSplits` as the basis points the organiser meant, and that a
 * refusal never reaches it at all:
 *
 *  - `12,5`      → 1250 bps is SENT (was `NaN → 0`: payee paid NOTHING)
 *  - unreadable  → the mutation is NEVER called, Save is disabled, and the
 *    last good `percentBps` is left intact so the running total stays sane
 *  - blank       → 0 bps, exactly as before
 *
 * Mocks follow `TicketTypeEditorAmounts.test.tsx` in this directory, and are
 * ENUMERATED rather than a catch-all Proxy: a proxy that answers every
 * property also answers `then`, which makes the module namespace look like a
 * thenable and hangs `import()` forever.
 * `@/lib/money/parse-percent-input` is deliberately NOT mocked — it is the
 * thing under test.
 */

const updateMutate = vi.fn();
const toastDanger = vi.fn();
const toastSuccess = vi.fn();

/** See the Button mock — flipped by the test that exercises the save guard. */
let bypassDisabled = false;

// One stable object identity: `useEffect([splitsQuery.data])` re-seeds `lines`
// whenever it changes, so returning a fresh literal per render would loop.
const splitsData = {
  lines: [
    {
      id: "line_1",
      payeeKind: "human" as const,
      // A Payee ROW id, distinct from the subject it pays: a save must send
      // the subject, never this.
      payeeId: "pay_row_1",
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
  ],
  lineupSuggestions: [] as unknown[],
  publishGateBlockers: [] as string[],
};
/** What the splits read returns; a test swaps it to stand for a later read. */
let currentSplits: typeof splitsData = splitsData;
/** The deal read: its `dealFreeze` locks the lines. */
let termsData: unknown = undefined;
/** The save mutation's options, so a test can land a save's `onSuccess`. */
let saveOptions: {
  onSuccess?: (data: unknown, sent: unknown) => void;
} = {};

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
  return {
    XStack: passthrough,
    YStack: passthrough,
    styled: () => passthrough,
  };
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
  useFormatters: () => ({ number: (n: number) => String(n) }),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Spinner: () => <span />,
  RangeSlider: ({
    value,
    onValueChange,
  }: {
    value?: number;
    onValueChange?: (v: number) => void;
  }) => (
    <button
      type="button"
      data-testid="range-slider"
      data-value={value}
      onClick={() => onValueChange?.(40)}
    />
  ),
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
      // `bypassDisabled` lets one test reach the handler behind a disabled
      // button. Without it, clicking a disabled <button> fires no onClick, so
      // "the mutation wasn't called" would be proved by the `disabled` prop
      // alone and the in-handler guard would be untested dead weight.
      disabled={bypassDisabled ? undefined : disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  useNotify: () => ({
    toast: { success: toastSuccess, danger: toastDanger },
  }),
  // Echo the key so an assertion can tell i18n copy from a hardcoded literal.
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: { getEventSplits: { invalidate: vi.fn() } },
      deals: {
        getTermsDeal: { invalidate: vi.fn() },
        projectTermsDeal: { invalidate: vi.fn() },
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
        useQuery: () => ({
          data: currentSplits,
          isLoading: false,
          error: null,
        }),
      },
      updateEventSplits: {
        useMutation: (opts: typeof saveOptions) => {
          saveOptions = opts ?? {};
          return { mutate: updateMutate, isPending: false };
        },
      },
    },
  },
}));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
// "The deal" (A3) sits above the lines; it has its own tests. Here only the
// line-by-line editor under it is exercised.
vi.mock("@/components/deals", () => ({
  DealEditor: () => <div data-testid="deal-editor" />,
  ResaleClause: () => null,
  classifyDealReadError: () => ({ kind: "ERROR" }),
}));
vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({ ownersWithSlugs: [] }),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "acme" }) }));

// Resale ON here so the tab set is the full one; this file is about percent
// wiring, not gating. The gate itself is covered by SplitsEditorResaleGate.
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: { resale: true }, isLoading: false }),
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

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

const save = () => fireEvent.click(screen.getByTestId("splits-save"));

/** The one line the mocked query seeds, as the mutation would send it. */
const sentLine = () => {
  const input = updateMutate.mock.calls[0]![0] as {
    lines: { percentBps: number; payeeRef: { kind: string; id: string } }[];
  };
  return input.lines[0]!;
};

describe("SplitsEditor — percent wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bypassDisabled = false;
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      vi.stubGlobal("crypto", {
        randomUUID: () => "00000000-0000-4000-8000-000000000000",
      });
    }
    render(<SplitsEditor eventId="evt_1" />);
    // Ticket-sale lines are folded under "The deal" (A3): open them.
    fireEvent.click(screen.getByTestId("eb-deal-lines-toggle"));
  });

  it("seeds the box from the saved share", () => {
    expect(screen.getByTestId("splits-percent-0")).toHaveValue("10");
  });

  it("banks an es-typed whole percent, not the 0 bps that paid nothing", () => {
    // The headline bug: `Number("50,00")` is NaN, the editor fell back to
    // 0 bps, and that payee got NOTHING at settlement — silently.
    type("splits-percent-0", "50,00");
    save();

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(sentLine().percentBps).toBe(5000);
    expect(toastDanger).not.toHaveBeenCalled();
  });

  it("sends the payee's subject id back, not its Payee row id", () => {
    type("splits-percent-0", "20");
    save();

    expect(sentLine().payeeRef).toEqual({ kind: "human", id: "hum_1" });
  });

  it("banks a plain whole percent too", () => {
    type("splits-percent-0", "25");
    save();
    expect(sentLine().percentBps).toBe(2500);
  });

  it("only ever sends a multiple of 100 — the store holds whole percent", () => {
    // `PayoutTermsLine.percent` is an Int, and update-event-splits does
    // `Math.round(percentBps / 100)`. Anything not divisible by 100 would be
    // silently rounded into a different payout.
    for (const raw of ["50,00", "25", "0", "100"]) {
      updateMutate.mockClear();
      type("splits-percent-0", raw);
      save();
      expect(sentLine().percentBps % 100).toBe(0);
    }
  });

  it("keeps the typed text instead of wiping it mid-decimal", () => {
    // The box used to render `String(percentBps / 100)`, so `50,` came back as
    // `0` and `50.` came back as `50` — you could not type a decimal at all.
    type("splits-percent-0", "50,");
    expect(screen.getByTestId("splits-percent-0")).toHaveValue("50,");
    type("splits-percent-0", "50,00");
    expect(screen.getByTestId("splits-percent-0")).toHaveValue("50,00");
  });

  it("keeps blank meaning 0%", () => {
    type("splits-percent-0", "");
    save();
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(sentLine().percentBps).toBe(0);
  });

  it("REFUSES a fractional share instead of letting the server round it", () => {
    // `12,5` → 1250 bps → `Math.round(1250 / 100)` = 13. The payee would be
    // paid 13%, not 12.5%, and the audit log records the rounded 1300 — so
    // nothing downstream could ever reveal the discrepancy. On a $10k net
    // that is $50 an event moved off the owner's remainder.
    type("splits-percent-0", "12,5");

    expect(screen.getAllByText("admin.ebSplitsPercentWhole").length).toBe(1);
    expect(screen.getByTestId("splits-save")).toBeDisabled();
    save();
    expect(updateMutate).not.toHaveBeenCalled();

    // Crucially it is NOT back to the old silent zero: the committed share is
    // still the 10% that was loaded, and the message explains the real rule.
    expect(screen.getByTestId("range-slider")).toHaveAttribute(
      "data-value",
      "10",
    );
  });

  it.each([["12.5"], ["12,5"], ["33,33"], ["0,5"]])(
    "refuses fractional %p",
    (raw) => {
      type("splits-percent-0", raw);
      expect(screen.getAllByText("admin.ebSplitsPercentWhole").length).toBe(1);
      expect(screen.getByTestId("splits-save")).toBeDisabled();
      save();
      expect(updateMutate).not.toHaveBeenCalled();
    },
  );

  it.each([["nonsense"], ["12 5"], ["-12,5"], ["101"], ["1,500"]])(
    "refuses %p: no mutation, Save disabled, last good share untouched",
    (raw) => {
      type("splits-percent-0", raw);

      expect(screen.getByTestId("splits-save")).toBeDisabled();
      save();
      expect(updateMutate).not.toHaveBeenCalled();

      // The running total must not have absorbed a half-parsed number: the
      // committed share is still the 10% that was loaded.
      expect(screen.getByTestId("range-slider")).toHaveAttribute(
        "data-value",
        "10",
      );
      // And the refusal is visible, not silent.
      expect(
        screen.getAllByText(/ebSplitsPercent(Invalid|Range|Ambiguous|Whole)/)
          .length,
      ).toBeGreaterThan(0);
      expect(
        screen.getAllByText(/ebSplitsPercentBlocker/).length,
      ).toBeGreaterThan(0);
    },
  );

  it("names the reason: range, ambiguous and fractional are not 'invalid'", () => {
    type("splits-percent-0", "101");
    expect(screen.getAllByText("admin.ebSplitsPercentRange").length).toBe(1);
    type("splits-percent-0", "1,500");
    expect(screen.getAllByText("admin.ebSplitsPercentAmbiguous").length).toBe(
      1,
    );
    type("splits-percent-0", "12,5");
    expect(screen.getAllByText("admin.ebSplitsPercentWhole").length).toBe(1);
    type("splits-percent-0", "nonsense");
    expect(screen.getAllByText("admin.ebSplitsPercentInvalid").length).toBe(1);
  });

  it("recovers once the typo is fixed", () => {
    type("splits-percent-0", "nonsense");
    expect(screen.getByTestId("splits-save")).toBeDisabled();

    type("splits-percent-0", "50,00");
    expect(screen.getByTestId("splits-save")).not.toBeDisabled();
    save();
    expect(sentLine().percentBps).toBe(5000);
  });

  it("guards inside onSave, not just via the disabled button", () => {
    // The disabled prop is the first line of defence; this proves the SECOND
    // one. With the button's disabled state bypassed, the handler itself must
    // still refuse and say so — otherwise the guard is untested dead weight
    // and the comment next to it is a claim no test backs.
    bypassDisabled = true;
    type("splits-percent-0", "12,5");

    const btn = screen.getByTestId("splits-save");
    expect(btn).not.toBeDisabled(); // the bypass is in effect
    fireEvent.click(btn);

    expect(updateMutate).not.toHaveBeenCalled();
    expect(toastDanger).toHaveBeenCalledTimes(1);
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      id: "splits-percent-unreadable",
      title: "admin.ebSplitsSaveBlockedTitle",
    });
  });

  it("lets the slider override a refused draft", () => {
    // Dragging is an unambiguous statement of intent, so it clears the draft
    // and its error rather than leaving the form half-updated.
    type("splits-percent-0", "nonsense");
    expect(screen.getByTestId("splits-save")).toBeDisabled();

    fireEvent.click(screen.getByTestId("range-slider")); // emits 40
    expect(screen.getByTestId("splits-percent-0")).toHaveValue("40");
    expect(screen.getByTestId("splits-save")).not.toBeDisabled();
    save();
    expect(sentLine().percentBps).toBe(4000);
  });

  it("blocks the add-a-payee row on an unreadable share", async () => {
    type("splits-new-percent", "12,5x");
    await waitFor(() =>
      expect(
        screen.getAllByText("admin.ebSplitsPercentInvalid").length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByTestId("splits-add-from-search")).toBeDisabled();
  });

  it("blocks the add-a-payee row on a fractional share too", async () => {
    // The add row feeds the same `percentBps` to the same rounder, so it needs
    // the same rule — otherwise the defect just moves one control to the left.
    type("splits-new-percent", "12,5");
    await waitFor(() =>
      expect(
        screen.getAllByText("admin.ebSplitsPercentWhole").length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByTestId("splits-add-from-search")).toBeDisabled();
  });
});

describe("SplitsEditor — a read landing over unsaved lines", () => {
  /** The same terms after a deal save elsewhere: the share is now 30%. */
  const laterRead = {
    ...splitsData,
    lines: [{ ...splitsData.lines[0]!, percentBps: 3000 }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    currentSplits = splitsData;
  });

  it("re-seeds straight away when nothing is being edited", () => {
    const { rerender } = render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("eb-deal-lines-toggle"));
    currentSplits = laterRead;
    rerender(<SplitsEditor eventId="evt_1" />);

    expect(screen.getByTestId("splits-percent-0")).toHaveValue("30");
    expect(screen.queryByTestId("eb-splits-lines-changed")).toBeNull();
  });

  it("keeps the edits, says the lines changed, and loads the read on request", () => {
    const { rerender } = render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("eb-deal-lines-toggle"));
    type("splits-percent-0", "20");
    currentSplits = laterRead;
    rerender(<SplitsEditor eventId="evt_1" />);

    expect(screen.getByTestId("splits-percent-0")).toHaveValue("20");
    expect(screen.getByTestId("eb-splits-lines-changed")).toBeTruthy();

    fireEvent.click(screen.getByTestId("eb-splits-lines-reload"));
    expect(screen.getByTestId("splits-percent-0")).toHaveValue("30");
    expect(screen.queryByTestId("eb-splits-lines-changed")).toBeNull();
  });

  it("still holds a read after a save that changed nothing", () => {
    const { rerender } = render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("eb-deal-lines-toggle"));
    // A save with no edits lands; its re-read comes back as the same object,
    // so no new read runs the seed.
    save();
    saveOptions.onSuccess?.(undefined, updateMutate.mock.calls[0]![0]);
    rerender(<SplitsEditor eventId="evt_1" />);

    type("splits-percent-0", "20");
    currentSplits = laterRead;
    rerender(<SplitsEditor eventId="evt_1" />);

    expect(screen.getByTestId("splits-percent-0")).toHaveValue("20");
    expect(screen.getByTestId("eb-splits-lines-changed")).toBeTruthy();
  });
});

describe("SplitsEditor — a freeze lands over unsaved edits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    termsData = undefined;
    currentSplits = splitsData;
  });

  it("the locked lines show the deal as read, not the edit never saved", () => {
    const view = render(<SplitsEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("eb-deal-lines-toggle"));
    type("splits-percent-0", "30");
    expect(screen.getByTestId("splits-percent-0")).toHaveValue("30");

    // "Freeze the deal" above (or a publish elsewhere) lands.
    termsData = {
      dealFreeze: {
        eventId: "evt_1",
        dealFrozenAt: new Date("2026-10-14T19:00:00.000Z"),
        dealFrozenByHumanId: null,
      },
    };
    view.rerender(<SplitsEditor eventId="evt_1" />);

    expect(screen.queryByTestId("splits-percent-0")).toBeNull();
    const row = screen.getByTestId("splits-frozen-line-0");
    expect(row).toHaveTextContent("Sound Engineer");
    expect(row).toHaveTextContent("10%");
    expect(row).not.toHaveTextContent("30%");
    termsData = undefined;
  });
});
