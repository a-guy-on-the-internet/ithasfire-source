import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DealEditor } from "../DealEditor";
import type { DealRead } from "../deal-model";

/**
 * The frozen deal in the editor (freeze-the-deal FR-010, board option A).
 *
 * Pinned: the Freeze action and its notice before the freeze (never on an
 * org default); a frozen deal has no Edit, no presets, and shows its change
 * history; "Change the frozen terms" collects row edits locally (no write per
 * row), marks them "Not saved", names who will be told, and sends ONE
 * `setTermsDeal` with `frozenChange: true` and the opening fingerprint;
 * "Discard changes" writes nothing.
 *
 * Mocks are enumerated, not a catch-all Proxy (a proxy answers `then` and
 * hangs the module import).
 */

const EVENT_ID = "44444444-4444-4444-8444-444444444444";
const PLACE_ORG = "11111111-1111-4111-8111-111111111111";
const ACT_ORG = "22222222-2222-4222-8222-222222222222";
const SUPPORT_HUMAN = "33333333-3333-4333-8333-333333333333";
const FROZEN_AT = new Date("2026-10-14T23:30:00.000Z");

function dealRead(overrides: Partial<DealRead> = {}): DealRead {
  return {
    target: { kind: "EVENT", eventId: EVENT_ID },
    agreementId: null,
    payoutTermsId: "55555555-5555-4555-8555-555555555555",
    visibility: "FULL",
    mayEdit: true,
    notEditableReason: null,
    dealFingerprint: "fp-1",
    resaleTerms: null,
    dealFreeze: { eventId: EVENT_ID, dealFrozenAt: null, dealFrozenByHumanId: null },
    remainder: { payeeId: "p-place", source: "STORED" },
    clauses: [
      {
        id: "c-act",
        payeeId: "p-act",
        amountType: "PERCENT",
        amountCents: null,
        percent: 30,
        basis: "NET_POOL",
        resolution: null,
        displayLabel: null,
        stage1: "SETTLED_DIRECTLY",
        role: "CLAUSE",
        requiresConfirmation: true,
        confirmationStatus: "CONFIRMED",
      },
      {
        id: "c-support",
        payeeId: "p-support",
        amountType: "PERCENT",
        amountCents: null,
        percent: 10,
        basis: "GROSS",
        resolution: null,
        displayLabel: null,
        stage1: "PAID_PER_ORDER",
        role: "CLAUSE",
        requiresConfirmation: true,
        confirmationStatus: "CONFIRMED",
      },
    ],
    deductions: [],
    perOrderPercentTotal: null,
    payees: [
      { payeeId: "p-place", subjectType: "organization", subjectId: PLACE_ORG, displayName: "Marrow Hall" },
      { payeeId: "p-act", subjectType: "organization", subjectId: ACT_ORG, displayName: "June Bug" },
      { payeeId: "p-support", subjectType: "human", subjectId: SUPPORT_HUMAN, displayName: "Paper Moth" },
    ],
    ...overrides,
  } as unknown as DealRead;
}

const frozenRead = () =>
  dealRead({
    dealFreeze: { eventId: EVENT_ID, dealFrozenAt: FROZEN_AT, dealFrozenByHumanId: null },
  } as Partial<DealRead>);

const changesPage = (items: unknown[] = []) => ({
  eventId: EVENT_ID,
  event: {
    title: "Lowlight at Marrow Hall",
    startsAt: new Date("2026-10-25T01:00:00.000Z"),
    timezone: "America/Chicago",
    dealFrozenAt: FROZEN_AT,
    frozenBy: null,
  },
  items,
  nextCursor: null,
});

let read: DealRead = dealRead();
let changes: ReturnType<typeof changesPage> | null = null;
const mutate = vi.fn();
const mutateAsync = vi.fn(async (_input: unknown) => ({ dealFingerprint: "fp-2" }));
const toastSuccess = vi.fn();
let viewer: { humanId: string | null; name: string | null } | null = null;
const freezeMutate = vi.fn();
const resolved = () => Promise.resolve();

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      deals: {
        getTermsDeal: { invalidate: vi.fn(resolved) },
        projectTermsDeal: { invalidate: vi.fn(resolved) },
        listDealChanges: { invalidate: vi.fn(resolved) },
        getResaleClause: { invalidate: vi.fn(resolved) },
      },
    }),
    deals: {
      getTermsDeal: {
        useQuery: () => ({
          data: read,
          isLoading: false,
          error: null,
          isFetching: false,
          refetch: vi.fn(),
        }),
      },
      setTermsDeal: {
        useMutation: () => ({ mutate, mutateAsync, isPending: false }),
      },
      freezeEventDeal: {
        useMutation: () => ({ mutate: freezeMutate, isPending: false }),
      },
      listDealChanges: {
        useQuery: (input: { eventId: string }) => ({
          data: input.eventId && changes ? changes : undefined,
          isLoading: false,
          error: null,
        }),
      },
    },
  },
}));

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
    "aria-label": ariaLabel,
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
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  DateTime: { format: (d: Date) => d.toISOString().slice(0, 10) },
  Money: { format: (cents: number) => `$${(cents / 100).toFixed(2)}` },
  NextLinkAnchor: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  SegmentedControl: ({
    options,
    value,
    onChange,
    testIdBase,
  }: {
    options: { value: string; label: string }[];
    value: string;
    onChange: (v: string) => void;
    testIdBase?: string;
  }) => (
    <div role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-testid={`${testIdBase}-${o.value}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  ),
  Spinner: () => <span />,
  useLocale: () => "en",
  useNotify: () => ({ toast: { success: toastSuccess, danger: vi.fn() } }),
  // Echo the key and its values, so assertions can read both.
  useTranslations:
    () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return {
    ArrowRight: Icon,
    Info: Icon,
    Lock: Icon,
    Pencil: Icon,
    Plus: Icon,
    Trash2: Icon,
  };
});
vi.mock("../use-viewer-human", () => ({
  useViewerHuman: () => viewer,
}));
vi.mock("../DealCalculator", () => ({
  DealCalculator: () => <div data-testid="calculator" />,
}));
vi.mock("../PresetPicker", () => ({
  PresetPicker: () => <div data-testid="preset-picker" />,
}));
const RAE = "66666666-6666-4666-8666-666666666666";
vi.mock("../PayeePicker", () => ({
  PayeePicker: ({
    onPick,
  }: {
    onPick: (p: { ref: { kind: "human"; id: string }; name: string }) => void;
  }) => (
    <button
      type="button"
      data-testid="payee-picker"
      onClick={() => onPick({ ref: { kind: "human", id: RAE }, name: "Rae Lin" })}
    />
  ),
}));
vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (e: unknown) => String(e),
}));

const PARTIES = [
  { ref: { kind: "org" as const, id: PLACE_ORG }, name: "Marrow Hall" },
];

const renderEditor = (target = { kind: "EVENT" as const, eventId: EVENT_ID }) =>
  render(<DealEditor target={target} parties={PARTIES} testIdBase="deal" />);

describe("DealEditor: not frozen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    read = dealRead();
    changes = null;
  });
  afterEach(cleanup);

  it("offers Freeze the deal with its notice, and freezes the event", () => {
    renderEditor();
    expect(screen.getByTestId("deal-freeze-notice").textContent).toContain(
      "deals.freeze.notice",
    );
    fireEvent.click(screen.getByTestId("deal-freeze"));
    expect(freezeMutate).toHaveBeenCalledTimes(1);
    expect(freezeMutate.mock.calls[0]![0]).toEqual({ eventId: EVENT_ID });
    // Rows still edit as before.
    expect(screen.getByTestId("deal-clause-c-act-edit")).toBeTruthy();
    expect(screen.getByTestId("preset-picker")).toBeTruthy();
  });

  it("never offers it on an org default, or to someone who may not edit", () => {
    read = dealRead({ dealFreeze: null } as Partial<DealRead>);
    renderEditor({ kind: "ORG_DEFAULT", orgId: PLACE_ORG } as never);
    expect(screen.queryByTestId("deal-freeze")).toBeNull();
    expect(screen.queryByTestId("deal-freeze-notice")).toBeNull();
    cleanup();
    read = dealRead({ mayEdit: false, notEditableReason: "not_payout_editor" });
    renderEditor();
    expect(screen.queryByTestId("deal-freeze")).toBeNull();
  });
});

describe("DealEditor: frozen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    viewer = null;
    mutateAsync.mockImplementation(async () => ({ dealFingerprint: "fp-2" }));
    read = frozenRead();
    changes = changesPage([
      {
        id: "dc-1",
        eventId: EVENT_ID,
        createdAt: new Date("2026-10-16T02:04:00.000Z"),
        actor: { humanId: "h-sam", name: "Sam Ortiz" },
        lines: [
          {
            section: "TICKETS",
            payeeName: "June Bug",
            label: null,
            before: null,
            after: null,
            text: {
              subject: "Ticket sales, June Bug",
              before: "30% of what's left after costs",
              after: "25% of what's left after costs",
            },
          },
        ],
      },
    ]);
  });
  afterEach(cleanup);

  it("reads frozen: the band, no Edit, no presets, no freeze action", () => {
    renderEditor();
    const band = screen.getByTestId("deal-frozen");
    expect(band.textContent).toContain("deals.freeze.frozenSinceAuto");
    expect(band.textContent).toContain("June Bug");
    expect(screen.queryByTestId("deal-clause-c-act-edit")).toBeNull();
    expect(screen.queryByTestId("deal-clause-c-support-edit")).toBeNull();
    expect(screen.queryByTestId("preset-picker")).toBeNull();
    expect(screen.queryByTestId("payee-picker")).toBeNull();
    expect(screen.queryByTestId("deal-freeze")).toBeNull();
  });

  it("shows the changes since it froze, struck before → after, and the freeze last", () => {
    renderEditor();
    const history = screen.getByTestId("deal-changes");
    expect(history.textContent).toContain("deals.history.title");
    const item = screen.getByTestId("deal-changes-item");
    expect(item.textContent).toContain("Sam Ortiz");
    expect(item.querySelector("s")?.textContent).toContain("30% of what's left after costs");
    expect(item.textContent).toContain("25% of what's left after costs");
    expect(screen.getByTestId("deal-changes-frozen").textContent).toContain(
      "deals.history.frozenAuto",
    );
    expect(history.textContent).toContain("deals.history.resaleNote");
  });

  it("collects edits without writing, then sends ONE frozen change", async () => {
    renderEditor();
    fireEvent.click(screen.getByTestId("deal-frozen-change"));
    expect(screen.getByTestId("deal-frozen").textContent).toContain(
      "deals.freeze.changingTitle",
    );

    // Edit Paper Moth 10% → 15% and the act 30% → 25%: two row saves.
    fireEvent.click(screen.getByTestId("deal-clause-c-support-edit"));
    fireEvent.change(screen.getByTestId("deal-clause-c-support-percent"), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByTestId("deal-clause-c-support-save"));
    fireEvent.click(screen.getByTestId("deal-clause-c-act-edit"));
    fireEvent.change(screen.getByTestId("deal-clause-c-act-percent"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByTestId("deal-clause-c-act-save"));

    // Nothing was sent per row.
    expect(mutate).not.toHaveBeenCalled();
    expect(mutateAsync).not.toHaveBeenCalled();
    // Each changed row: the old value struck, "Not saved".
    expect(screen.getByTestId("deal-clause-c-support-not-saved")).toBeTruthy();
    expect(
      screen.getByTestId("deal-clause-c-support").querySelector("s")?.textContent,
    ).toContain('"percent":10');
    // The footer: two changes, and who is told.
    const footer = screen.getByTestId("deal-change-footer");
    expect(footer.textContent).toContain('deals.freeze.footerMany {"count":2}');
    expect(footer.textContent).toContain("June Bug");
    expect(footer.textContent).toContain("Paper Moth");
    expect(footer.textContent).toContain("Marrow Hall");

    await act(async () => {
      fireEvent.click(screen.getByTestId("deal-change-footer-save"));
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const sent = mutateAsync.mock.calls[0]![0] as unknown as {
      frozenChange: boolean;
      expectedDealFingerprint: string;
      deal: { source: string; clauses: { id?: string; percent: number | null }[] };
    };
    expect(sent.frozenChange).toBe(true);
    expect(sent.expectedDealFingerprint).toBe("fp-1");
    expect(sent.deal.source).toBe("CLAUSES");
    expect(sent.deal.clauses.map((c) => [c.id, c.percent])).toEqual([
      ["c-act", 25],
      ["c-support", 15],
    ]);
    // The change closed: frozen again.
    expect(screen.getByTestId("deal-frozen").getAttribute("data-phase")).toBe(
      "frozen",
    );
  });

  it("Discard changes leaves without writing", () => {
    renderEditor();
    fireEvent.click(screen.getByTestId("deal-frozen-change"));
    fireEvent.click(screen.getByTestId("deal-clause-c-support-edit"));
    fireEvent.change(screen.getByTestId("deal-clause-c-support-percent"), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByTestId("deal-clause-c-support-save"));
    expect(screen.getByTestId("deal-clause-c-support-not-saved")).toBeTruthy();

    fireEvent.click(screen.getByTestId("deal-change-footer-discard"));
    expect(mutate).not.toHaveBeenCalled();
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByTestId("deal-clause-c-support-not-saved")).toBeNull();
    expect(screen.getByTestId("deal-frozen").getAttribute("data-phase")).toBe(
      "frozen",
    );
  });

  it("Save waits for a change, and the history hides while changing", () => {
    renderEditor();
    fireEvent.click(screen.getByTestId("deal-frozen-change"));
    expect(
      (screen.getByTestId("deal-change-footer-save") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId("deal-change-footer").textContent).toContain(
      "deals.freeze.footerNone",
    );
    expect(screen.queryByTestId("deal-changes")).toBeNull();
  });

  it("never names the person making the change: the notice skips them", () => {
    // The signed-in person is Paper Moth, a payee on the deal.
    viewer = { humanId: SUPPORT_HUMAN, name: "Paper Moth" };
    renderEditor();
    expect(screen.getByTestId("deal-frozen").textContent).not.toContain(
      "Paper Moth",
    );
    fireEvent.click(screen.getByTestId("deal-frozen-change"));
    fireEvent.click(screen.getByTestId("deal-clause-c-act-edit"));
    fireEvent.change(screen.getByTestId("deal-clause-c-act-percent"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByTestId("deal-clause-c-act-save"));
    const footer = screen.getByTestId("deal-change-footer").textContent ?? "";
    expect(footer).not.toContain("Paper Moth");
    // A group stays: its other members are told.
    expect(footer).toContain("June Bug");
    expect(footer).toContain("Marrow Hall");
  });

  it("a cost added in the change edits in place, and is sent once without a client id", async () => {
    renderEditor();
    fireEvent.click(screen.getByTestId("deal-frozen-change"));
    fireEvent.click(screen.getByTestId("deal-costs-add"));
    fireEvent.change(screen.getByTestId("deal-costs-new-label"), {
      target: { value: "Sound" },
    });
    fireEvent.change(screen.getByTestId("deal-costs-new-value"), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByTestId("deal-costs-new-save"));
    expect(screen.getByTestId("deal-costs-0").textContent).toContain("Sound");
    expect(screen.getByTestId("deal-costs-0-not-saved")).toBeTruthy();

    // Its pencil opens THIS cost, not a blank Add form.
    fireEvent.click(screen.getByTestId("deal-costs-0-edit"));
    expect(screen.queryByTestId("deal-costs-new-form")).toBeNull();
    const label = screen.getByTestId("deal-costs-0-label") as HTMLInputElement;
    expect(label.value).toBe("Sound");
    fireEvent.change(screen.getByTestId("deal-costs-0-value"), {
      target: { value: "60" },
    });
    fireEvent.click(screen.getByTestId("deal-costs-0-save"));
    expect(screen.queryByTestId("deal-costs-1")).toBeNull();
    expect(screen.getByTestId("deal-costs-0-not-saved")).toBeTruthy();
    expect(screen.getByTestId("deal-change-footer").textContent).toContain(
      "deals.freeze.footerOne",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("deal-change-footer-save"));
    });
    const sent = mutateAsync.mock.calls[0]![0] as unknown as {
      deal: { deductions: Record<string, unknown>[] };
    };
    expect(sent.deal.deductions).toHaveLength(1);
    expect(sent.deal.deductions[0]!.amountCents).toBe(6000);
    expect("id" in sent.deal.deductions[0]!).toBe(false);
  });

  it("a conflict re-bases on theirs, says an edit to a line they took off is dropped, and saves against theirs", async () => {
    mutateAsync.mockImplementationOnce(async () => {
      throw new Error("deal_terms_changed");
    });
    const view = renderEditor();
    fireEvent.click(screen.getByTestId("deal-frozen-change"));
    fireEvent.click(screen.getByTestId("deal-clause-c-support-edit"));
    fireEvent.change(screen.getByTestId("deal-clause-c-support-percent"), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByTestId("deal-clause-c-support-save"));
    fireEvent.click(screen.getByTestId("deal-clause-c-act-edit"));
    fireEvent.change(screen.getByTestId("deal-clause-c-act-percent"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByTestId("deal-clause-c-act-save"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("deal-change-footer-save"));
    });
    // Refused: still changing, nothing lost yet.
    expect(screen.getByTestId("deal-frozen").getAttribute("data-phase")).toBe(
      "changing",
    );

    // Their save lands: Paper Moth's line is gone, the fingerprint moved.
    const base = frozenRead();
    read = {
      ...base,
      dealFingerprint: "fp-9",
      clauses: base.clauses.filter((c) => c.id !== "c-support"),
    } as DealRead;
    view.rerender(
      <DealEditor
        target={{ kind: "EVENT", eventId: EVENT_ID }}
        parties={PARTIES}
        testIdBase="deal"
      />,
    );
    expect(screen.getByTestId("deal-changed-under").textContent).toContain(
      "deals.freeze.changedUnderDroppedOne",
    );
    expect(screen.getByTestId("deal-change-footer").textContent).toContain(
      "deals.freeze.footerOne",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("deal-change-footer-save"));
    });
    expect(mutateAsync).toHaveBeenCalledTimes(2);
    const retry = mutateAsync.mock.calls[1]![0] as unknown as {
      expectedDealFingerprint: string;
      deal: { clauses: { id?: string; percent: number | null }[] };
    };
    expect(retry.expectedDealFingerprint).toBe("fp-9");
    expect(retry.deal.clauses.map((c) => [c.id, c.percent])).toEqual([
      ["c-act", 25],
    ]);
  });

  it("a save that moved nothing says nobody was told", async () => {
    // The server hands back the fingerprint it was checked against.
    mutateAsync.mockImplementationOnce(async () => ({ dealFingerprint: "fp-1" }));
    renderEditor();
    fireEvent.click(screen.getByTestId("deal-frozen-change"));
    fireEvent.click(screen.getByTestId("deal-clause-c-act-edit"));
    fireEvent.change(screen.getByTestId("deal-clause-c-act-percent"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByTestId("deal-clause-c-act-save"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("deal-change-footer-save"));
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ title: "deals.freeze.savedNothingToast" }),
    );
  });

  it("when the actor is the only one on the deal, it says nobody is told", async () => {
    viewer = { humanId: SUPPORT_HUMAN, name: "Paper Moth" };
    const base = frozenRead();
    read = {
      ...base,
      remainder: { payeeId: "p-support", source: "STORED" },
      clauses: base.clauses.filter((c) => c.id === "c-support"),
    } as DealRead;
    renderEditor();
    expect(screen.getByTestId("deal-frozen").textContent).toContain(
      "deals.freeze.frozenBodyNobody",
    );
    fireEvent.click(screen.getByTestId("deal-frozen-change"));
    fireEvent.click(screen.getByTestId("deal-clause-c-support-edit"));
    fireEvent.change(screen.getByTestId("deal-clause-c-support-percent"), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByTestId("deal-clause-c-support-save"));
    expect(screen.getByTestId("deal-change-footer").textContent).toContain(
      "deals.freeze.footerTellsNobody",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("deal-change-footer-save"));
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ title: "deals.freeze.savedToastNobody" }),
    );
  });

  it("focus: into the first row's Edit on entering, back to the way in on leaving", async () => {
    const frames = async () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    renderEditor();
    fireEvent.click(screen.getByTestId("deal-frozen-change"));
    await frames();
    expect(document.activeElement).toBe(
      screen.getByTestId("deal-clause-c-act-edit"),
    );
    fireEvent.click(screen.getByTestId("deal-change-footer-discard"));
    await frames();
    expect(document.activeElement).toBe(
      screen.getByTestId("deal-frozen-change"),
    );
  });

  it("a payee added in the change keeps their name, and is not told when it is the actor", () => {
    viewer = { humanId: RAE, name: "Rae Lin" };
    renderEditor();
    fireEvent.click(screen.getByTestId("deal-frozen-change"));
    fireEvent.click(screen.getByTestId("payee-picker"));
    const form = screen.getByRole("form", { name: /Rae Lin|newClauseFor/ });
    const percent = form.querySelector<HTMLInputElement>('input[data-testid$="-percent"]')!;
    fireEvent.change(percent, { target: { value: "5" } });
    fireEvent.click(form.querySelector<HTMLButtonElement>('[data-testid$="-save"]')!);
    expect(screen.getByTestId("deal-clause-list").textContent).toContain("Rae Lin");
    expect(screen.getByTestId("deal-clause-list").textContent).not.toContain(
      "deals.unnamed",
    );
    expect(screen.getByTestId("deal-change-footer").textContent).not.toContain(
      "Rae Lin",
    );
  });
});
