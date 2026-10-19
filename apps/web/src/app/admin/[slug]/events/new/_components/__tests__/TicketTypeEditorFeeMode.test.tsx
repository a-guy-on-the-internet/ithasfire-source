import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TicketTypeEditor } from "../TicketTypeEditor";

/**
 * The builder's ticket section after the Fee Handling switch was dropped
 * (docs/decisions/fee-mode-switch-dropped.md).
 *
 *  - No toggle, for anyone: fees are always itemised on top of the price.
 *  - The fee PREVIEW still renders from `getEventFeePreview`.
 *  - ABSORB is removed (docs/decisions/absorb-removed.md): the server prices
 *    every event fees-on-top, and the legacy read-only badge is gone.
 */
const previewState = vi.hoisted(() => ({
  feeMode: "PASS_THROUGH" as "PASS_THROUGH" | "ABSORB",
  mobile: false,
}));

const PAID_ROW = {
  id: "tt_1",
  name: "General",
  priceCents: 1000,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
  capacity: 100,
  status: "ACTIVE",
  seatSectionId: null,
  layoutSectionId: null,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
  scheduledPriceCents: null,
  scheduledPriceAt: null,
  effectivePriceCents: 1000,
};

const upsertMutate = vi.fn();
const toastDanger = vi.fn();
const toastSuccess = vi.fn();

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
    useTheme: () => ({}),
  };
});

// Enumerated, NOT a catch-all Proxy: a proxy that answers every property also
// answers `then`, which makes the module namespace look like a thenable and
// hangs `import()` forever.
vi.mock("lucide-react", () => {
  const icon = () => <span />;
  return {
    Plus: icon,
    Ticket: icon,
    Edit3: icon,
    Trash2: icon,
    X: icon,
    Check: icon,
    Info: icon,
    Repeat: icon,
    CreditCard: icon,
    ExternalLink: icon,
    // Scheduled price change (FR-005). Enumerated like the rest — a catch-all
    // Proxy would answer `then` and hang the dynamic import.
    CalendarClock: icon,
    CalendarRange: icon,
    AlertTriangle: icon,
  };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  NextLinkAnchor: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
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
  useNotify: () => ({
    toast: { success: toastSuccess, danger: toastDanger },
  }),
  // Echo the key so an assertion can tell i18n copy from a hardcoded literal.
  useTranslations: () => (key: string) => key,
  useFormatters: () => ({
    currency: (n: number) => `$${n.toFixed(2)}`,
    dateTime: (value: Date, options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", options).format(value),
  }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: {
        listTicketTypesForEdit: { invalidate: vi.fn(), cancel: vi.fn() },
        getEventFeePreview: {
          invalidate: vi.fn(),
          cancel: vi.fn(),
          getData: vi.fn(),
          setData: vi.fn(),
        },
      },
    }),
    events: {
      listTicketTypesForEdit: {
        useQuery: () => ({
          data: { ticketTypes: [PAID_ROW] },
          isPending: false,
        }),
      },
      // Supplies `Event.timezone` to the scheduled-price control (FR-007).
      // The schedule assertions live in `TicketTypeEditorSchedule.test.tsx`;
      // this file only needs the query to exist so the editor renders.
      getEventForEdit: {
        useQuery: () => ({
          data: { timezone: "America/Chicago", currency: "usd" },
        }),
      },
      getEventFeePreview: {
        useQuery: () => ({
          data: {
            feeMode: previewState.feeMode,
            feePolicy: null,
            agreement: { id: null, feeMode: previewState.feeMode },
            lines: [],
            ticketBreakdowns: [
              {
                ticketTypeId: "tt_1",
                platformFeeCents: 33,
                processorFeeCents:
                  previewState.feeMode === "PASS_THROUGH" ? 64 : 0,
                taxEstimateCents: 0,
                buyerTotalCents:
                  previewState.feeMode === "PASS_THROUGH" ? 1097 : 1000,
              },
            ],
          },
        }),
      },
    },
    ticketTypes: {
      upsertTicketType: {
        useMutation: () => ({ mutateAsync: upsertMutate, isPending: false }),
      },
      updateTicketType: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
      deleteTicketType: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
    },
  },
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: { resale: true } }),
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => previewState.mobile }));
vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "org" }) }));

vi.mock("../EventEditorSheet", () => ({ EventEditorSheet: () => null }));
vi.mock("../TicketTypeTemplateControls", () => ({
  TicketTypeTemplateControls: () => null,
}));
vi.mock("../TicketTypePresetPicker", () => ({
  TicketTypePresetPicker: () => null,
}));
vi.mock("../_form-bits", () => ({
  FieldLabel: ({ children }: { children?: ReactNode }) => <>{children}</>,
  NativeDateTimeInput: ({
    value,
    onChange,
    "data-testid": testId,
  }: {
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    "data-testid"?: string;
  }) => (
    <input
      type="datetime-local"
      data-testid={testId}
      value={value ?? ""}
      onChange={onChange}
    />
  ),
}));
vi.mock("../_mobile-bits", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    EditorCard: ({
      children,
      actions,
    }: {
      children?: ReactNode;
      actions?: ReactNode;
    }) => (
      <div>
        {children}
        {actions}
      </div>
    ),
    EditorCardActions: passthrough,
    EditorCardMeta: passthrough,
    EditorCardTitle: passthrough,
  };
});

describe("TicketTypeEditor — no Fee Handling switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewState.feeMode = "PASS_THROUGH";
    previewState.mobile = false;
  });

  it("offers no toggle and no mode label on a pass-through event", () => {
    render(<TicketTypeEditor eventId="evt_1" />);

    expect(screen.queryByTestId("fee-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("fee-mode-pass-through")).toBeNull();
    expect(screen.queryByTestId("fee-mode-absorb")).toBeNull();
    expect(screen.queryByText("admin.ttFeeHandling")).toBeNull();
    expect(screen.queryByTestId("fee-mode-badge")).toBeNull();
    // The owner-only note belonged to the toggle; it went with it.
    expect(screen.queryByText("admin.ebPayoutsOwnerOnly")).toBeNull();
  });

  it("still renders the fee preview, processor line included, under pass-through", () => {
    render(<TicketTypeEditor eventId="evt_1" />);

    expect(screen.getAllByText(/admin\.ttFeePlatform/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(/admin\.ttFeeProcessor/).length).toBeGreaterThan(
      0,
    );
  });

  it("never shows the legacy ABSORB badge or the organiser-cost fee line, even on a stale ABSORB response", () => {
    // The server no longer sends ABSORB (SALE_FEE_MODE). Should an old
    // response carry it, the builder still offers no absorb wording.
    previewState.feeMode = "ABSORB";
    render(<TicketTypeEditor eventId="evt_1" />);

    expect(screen.queryByTestId("fee-mode-badge")).toBeNull();
    expect(screen.queryByText("admin.ttFeeModeAbsorb")).toBeNull();
    expect(screen.queryByTestId("tt-fee-you-get")).toBeNull();
    expect(screen.queryByText(/admin\.ttFeePlatformFeeYourCost/)).toBeNull();
    expect(screen.queryByTestId("fee-mode-toggle")).toBeNull();
  });
});

describe("TicketTypeEditor — locked once tickets are sold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewState.feeMode = "PASS_THROUGH";
    previewState.mobile = false;
  });

  for (const mobile of [false, true]) {
    const layout = mobile ? "mobile cards" : "desktop rows";

    it(`renders no Edit, Delete or Add control, only the lock caption (${layout})`, () => {
      previewState.mobile = mobile;
      render(<TicketTypeEditor eventId="evt_1" disabled />);

      expect(screen.getByText("admin.ttLocked")).toBeTruthy();
      expect(screen.queryByTestId("ticket-type-edit-btn")).toBeNull();
      expect(screen.queryByTestId("ticket-type-delete-btn")).toBeNull();
      expect(screen.queryByTestId("ticket-type-add-btn")).toBeNull();
    });

    it(`renders the Edit button when not locked (${layout})`, () => {
      previewState.mobile = mobile;
      render(<TicketTypeEditor eventId="evt_1" />);

      expect(screen.getByTestId("ticket-type-edit-btn")).toBeTruthy();
      expect(screen.queryByText("admin.ttLocked")).toBeNull();
    });
  }

  it("ignores a click on the row when locked, and opens the edit form when not", () => {
    const { unmount } = render(<TicketTypeEditor eventId="evt_1" disabled />);
    fireEvent.click(screen.getByTestId("ticket-type-row"));
    expect(screen.queryByTestId("ticket-type-edit-form")).toBeNull();
    unmount();

    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-row"));
    expect(screen.getByTestId("ticket-type-edit-form")).toBeTruthy();
  });

  it("closes an open edit form when the lock flips on mid-session", () => {
    const { rerender } = render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    expect(screen.getByTestId("ticket-type-edit-form")).toBeTruthy();

    rerender(<TicketTypeEditor eventId="evt_1" disabled />);
    expect(screen.queryByTestId("ticket-type-edit-form")).toBeNull();
    expect(screen.queryByTestId("ticket-type-edit-save")).toBeNull();
  });
});
