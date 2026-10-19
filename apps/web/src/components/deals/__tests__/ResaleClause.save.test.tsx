import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DealFreezeProvider, type DealFreezeContextValue } from "../DealFreeze";
import { ResaleClause } from "../ResaleClause";

/**
 * The resale clause block's save, against a stand-in query cache.
 *
 * Pinned: after a save the form shows what was saved while the refetch is
 * still in flight (the result is written into the cache first, and the form
 * re-seeds only when the read's version moves), and the next save sends the
 * new version. Also: no Save without recipients, and "Change who gets it"
 * waits while the form has unsaved edits.
 *
 * Mocks are enumerated, not a catch-all Proxy (a proxy answers `then` and
 * hangs the module import).
 */

type Read = {
  target: unknown;
  payoutTermsId: string | null;
  version: number | null;
  clause: {
    type: "PERCENT" | "FLAT";
    bps: number | null;
    cents: number | null;
    payer: "SELLER" | "BUYER";
  } | null;
  mayEdit: boolean;
  notEditableReason: string | null;
  agreementId: string | null;
  recipients: {
    lineId: string;
    payeeId: string;
    kind: "org" | "human" | null;
    name: string | null;
    percent: number;
    capPercent: number | null;
    priority: number;
    rounding: "FLOOR";
    ticketTypeId: string | null;
  }[] | null;
  resaleOnTicketTypes: number | null;
};

const TARGET = { kind: "EVENT" as const, eventId: "evt_1" };
const BOOKING = { kind: "BOOKING_AGREEMENT" as const, agreementId: "agr_1" };

const base = (): Read => ({
  target: TARGET,
  payoutTermsId: "terms_1",
  version: 1,
  clause: { type: "PERCENT", bps: 1000, cents: null, payer: "SELLER" },
  mayEdit: true,
  notEditableReason: null,
  agreementId: null,
  recipients: [
    {
      lineId: "line_1",
      payeeId: "payee_1",
      kind: "org",
      name: "The Room",
      percent: 100,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR",
      ticketTypeId: null,
    },
  ],
  resaleOnTicketTypes: 0,
});

// A one-entry query cache the component subscribes to.
let cache: Read = base();
const listeners = new Set<() => void>();
const setCache = (next: Read) => {
  cache = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const mutate = vi.fn();
const mutateAsync = vi.fn();
/** The refetch an invalidate starts: left pending, as on a slow network. */
const pending = () => new Promise<void>(() => undefined);
const invalidate = vi.fn(pending);

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      deals: {
        getResaleClause: {
          invalidate,
          getData: () => cache,
          setData: (_input: unknown, updater: (d: Read | undefined) => Read | undefined) => {
            const next = updater(cache);
            if (next) setCache(next);
          },
        },
        getTermsDeal: { invalidate: vi.fn(() => Promise.resolve()) },
      },
    }),
    deals: {
      getResaleClause: {
        useQuery: () => {
          const data = useSyncExternalStore(subscribe, () => cache);
          return {
            data,
            isLoading: false,
            error: null,
            isFetching: false,
            refetch: vi.fn(),
          };
        },
      },
      setResaleClause: {
        useMutation: () => ({ mutate, mutateAsync, isPending: false }),
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
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
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
  useFormatters: () => ({ number: (n: number) => String(n) }),
  useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
  // Echo the key and its values, so assertions can read both.
  useTranslations:
    () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("lucide-react", () => ({ ArrowRight: () => <span />, Info: () => <span /> }));
vi.mock("../ClauseRow", () => ({
  DealTag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: { resale: true }, isLoading: false }),
}));
vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (e: unknown) => String(e),
}));

const amount = () => screen.getByTestId("eb-deal-resale-amount") as HTMLInputElement;
const save = () => screen.getByTestId("eb-deal-resale-save") as HTMLButtonElement;
const change = () =>
  screen.getByTestId("eb-deal-resale-change-recipients") as HTMLButtonElement;

const renderBlock = (onChangeRecipients = vi.fn()) =>
  render(
    <ResaleClause
      target={TARGET}
      onChangeRecipients={onChangeRecipients}
      testIdBase="eb-deal"
    />,
  );

const noRecipientsYet = (): Read => ({
  ...base(),
  clause: null,
  mayEdit: false,
  notEditableReason: "no_recipients_yet",
  recipients: [],
});

describe("ResaleClause save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidate.mockImplementation(pending);
    cache = base();
  });
  afterEach(cleanup);

  it("shows the saved values straight after a save, while the refetch is in flight", () => {
    mutate.mockImplementation(
      (_input: unknown, opts: { onSuccess: (out: unknown) => void }) =>
        opts.onSuccess({
          payoutTermsId: "terms_1",
          version: 2,
          clause: { type: "PERCENT", bps: 500, cents: null, payer: "SELLER" },
        }),
    );
    renderBlock();
    expect(amount().value).toBe("10");

    fireEvent.change(amount(), { target: { value: "5" } });
    act(() => {
      fireEvent.click(save());
    });

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 1 }),
      expect.anything(),
    );
    // The refetch never lands in this test: what shows is the saved clause,
    // not the old 10% snapping back.
    expect(amount().value).toBe("5");
    expect(screen.getByText(/deals\.resale\.sentencePercent/).textContent).toContain(
      '"percent":"5"',
    );
    expect(cache.version).toBe(2);
  });

  it("the next save sends the new version", async () => {
    // The refetch lands this time (the block takes no second save while one
    // is still settling).
    invalidate.mockImplementation(() => Promise.resolve());
    let version = 1;
    mutate.mockImplementation(
      (input: { clause: { bps: number } }, opts: { onSuccess: (out: unknown) => void }) => {
        version += 1;
        opts.onSuccess({
          payoutTermsId: "terms_1",
          version,
          clause: { type: "PERCENT", bps: input.clause.bps, cents: null, payer: "SELLER" },
        });
      },
    );
    renderBlock();
    fireEvent.change(amount(), { target: { value: "5" } });
    await act(async () => {
      fireEvent.click(save());
      await Promise.resolve();
    });
    fireEvent.change(amount(), { target: { value: "7" } });
    await act(async () => {
      fireEvent.click(save());
      await Promise.resolve();
    });

    expect(mutate.mock.calls[1]?.[0]).toMatchObject({ expectedVersion: 2 });
  });

  it("a read whose version has not moved does not re-seed the form", () => {
    renderBlock();
    expect(amount().value).toBe("10");
    // Untouched form, new read object, SAME version. Only the version ref
    // decides here: the form isn't dirty, so without it any new data object
    // would pour in. (A different clause under one version can't come from
    // the server; it is what makes a re-seed visible.)
    act(() =>
      setCache({
        ...base(),
        clause: { type: "PERCENT", bps: 500, cents: null, payer: "SELLER" },
      }),
    );
    expect(amount().value).toBe("10");
    // The version moves: now it re-seeds.
    act(() =>
      setCache({
        ...base(),
        version: 2,
        clause: { type: "PERCENT", bps: 500, cents: null, payer: "SELLER" },
      }),
    );
    expect(amount().value).toBe("5");
  });

  it("no Save without recipients: the server refuses a clause nobody receives", () => {
    cache = noRecipientsYet();
    const onChange = vi.fn();
    renderBlock(onChange);

    expect(screen.queryByTestId("eb-deal-resale-save")).toBeNull();
    expect(screen.queryByTestId("eb-deal-resale-read-only")).toBeNull();
    expect(screen.getByText("deals.resale.noRecipients")).toBeTruthy();
    // The way out is right there.
    fireEvent.click(change());
    expect(onChange).toHaveBeenCalled();
  });

  it("'Change who gets it' waits while the clause has unsaved edits", () => {
    const onChange = vi.fn();
    renderBlock(onChange);
    expect(change().disabled).toBe(false);

    fireEvent.change(amount(), { target: { value: "5" } });

    expect(change().disabled).toBe(true);
    expect(screen.getByTestId("eb-deal-resale-change-blocked")).toBeTruthy();
    fireEvent.click(change());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the booking page, which has no way to the lines, says where they are set", () => {
    cache = { ...noRecipientsYet(), target: BOOKING };
    render(<ResaleClause target={BOOKING} testIdBase="ba-deal" />);

    expect(screen.getByTestId("ba-deal-resale-no-recipients")).toHaveTextContent(
      "deals.resale.noRecipientsBooking",
    );
    // No "choose who does" with nothing to choose with.
    expect(screen.queryByText("deals.resale.noRecipients")).toBeNull();
    expect(screen.queryByTestId("ba-deal-resale-change-recipients")).toBeNull();
  });

  it("an event host without the lines link reads as read-only", () => {
    cache = noRecipientsYet();
    render(<ResaleClause target={TARGET} testIdBase="eb-deal" />);

    expect(screen.getByTestId("eb-deal-resale-no-recipients")).toHaveTextContent(
      "deals.resale.noRecipientsReadOnly",
    );
  });

  it("a frozen change refused as a conflict re-bases on the share as it is now; the retry sends that version", async () => {
    invalidate.mockImplementation(() => Promise.resolve());
    const resaleSend: DealFreezeContextValue["resaleSend"] = { current: null };
    const freeze: DealFreezeContextValue = {
      phase: "changing",
      saving: false,
      setResalePending: vi.fn(),
      setResaleRecipients: vi.fn(),
      resaleSend,
    };
    render(
      <DealFreezeProvider value={freeze}>
        <ResaleClause target={TARGET} testIdBase="eb-deal" />
      </DealFreezeProvider>,
    );
    fireEvent.change(amount(), { target: { value: "5" } });

    // Someone else saved the share (version 7) before this change was sent.
    mutateAsync.mockImplementationOnce(async () => {
      setCache({ ...cache, version: 7 });
      throw new Error("resale_clause_changed");
    });
    await act(async () => {
      await expect(resaleSend.current!()).rejects.toThrow("resale_clause_changed");
    });
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({
      expectedVersion: 1,
      frozenChange: true,
    });
    // What was typed stays.
    expect(amount().value).toBe("5");

    mutateAsync.mockImplementationOnce(async () => ({
      payoutTermsId: "terms_1",
      version: 8,
      clause: { type: "PERCENT", bps: 500, cents: null, payer: "SELLER" },
    }));
    await act(async () => {
      await resaleSend.current!();
    });
    // Checked against the share as it is now, not the stale one forever.
    expect(mutateAsync.mock.calls[1]![0]).toMatchObject({
      expectedVersion: 7,
      frozenChange: true,
    });
  });
});
