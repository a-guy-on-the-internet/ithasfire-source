import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * ReportEntityDialog (entity-report-intake FR-001/FR-002/FR-008, NFR-004).
 *
 * The tamagui/@th/ui mocks deliberately pass through role / aria-* / id /
 * tabIndex / onKeyDown (memory: a narrow DS mock lets tests pass on an
 * inaccessible tree — the radiogroup assertions below are only meaningful
 * because the mock is widened).
 */

type MutationOptions = {
  meta?: { silent?: boolean };
  onSuccess?: (data: unknown) => void;
  onError?: (err: unknown) => void;
};

const testState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  mutationOptions: null as MutationOptions | null,
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    danger: vi.fn(),
    warning: vi.fn(),
  },
  showSignInOverlay: vi.fn(),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = React.forwardRef<
    HTMLDivElement,
    { children?: ReactNode; onPress?: () => void }
  >(({ children, onPress, ...props }, ref) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (
        key === "role" ||
        key === "id" ||
        key === "tabIndex" ||
        key === "onKeyDown" ||
        key === "data-testid" ||
        key.startsWith("aria-")
      )
        safe[key] = value;
    }
    return React.createElement(
      "div",
      { ...safe, ref, onClick: onPress },
      children,
    );
  });
  return { XStack: Stack, YStack: Stack, Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");

  const ModalRoot = ({
    open,
    children,
  }: {
    open: boolean;
    onClose: () => void;
    children?: ReactNode;
  }) => (open ? <div data-testid="modal">{children}</div> : null);
  const Panel = ({ children }: { children?: ReactNode }) => (
    <div role="dialog" aria-modal="true">
      {children}
    </div>
  );
  const Header = ({
    title,
    subtitle,
    onClose,
  }: {
    title: string;
    subtitle?: string;
    onClose?: () => void;
  }) => (
    <div>
      <h2>{title}</h2>
      {subtitle ? <p>{subtitle}</p> : null}
      {onClose ? (
        <button type="button" onClick={onClose}>
          modal-close
        </button>
      ) : null}
    </div>
  );
  const Body = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Footer = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Modal = Object.assign(ModalRoot, {
    Panel,
    Header,
    Body,
    Footer,
  });

  return {
    Modal,
    Button: React.forwardRef<
      HTMLButtonElement,
      { children?: ReactNode; onPress?: () => void; disabled?: boolean }
    >(({ children, onPress, disabled }, ref) => (
      <button type="button" ref={ref} onClick={onPress} disabled={disabled}>
        {children}
      </button>
    )),
    // Mirrors the REAL component's a11y contract (error → aria-invalid,
    // ariaDescribedBy → aria-describedby) so the wiring assertions below
    // can't pass against a mock that swallows them.
    CharCountTextarea: ({
      value,
      onChange,
      testIdBase,
      disabled,
      error,
      ariaDescribedBy,
    }: {
      value: string;
      onChange: (next: string) => void;
      testIdBase?: string;
      disabled?: boolean;
      error?: boolean;
      ariaDescribedBy?: string;
    }) => (
      <textarea
        data-testid={testIdBase}
        aria-invalid={error ? true : undefined}
        aria-describedby={ariaDescribedBy}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    ),
    // Forwards ref + tabIndex so the phase-transition focus path is
    // exercisable (jsdom only honours focus() on focusable elements).
    Text: React.forwardRef<HTMLSpanElement, Record<string, unknown>>(
      ({ children, tabIndex, ...props }, ref) => {
        const safe: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(props)) {
          if (key === "id" || key === "role" || key.startsWith("aria-"))
            safe[key] = value;
        }
        return (
          <span
            {...safe}
            ref={ref}
            tabIndex={tabIndex as number | undefined}
          >
            {children as ReactNode}
          </span>
        );
      },
    ),
    useNotify: () => ({ toast: testState.toast }),
    useTranslations:
      () =>
      (key: string, params?: Record<string, unknown>) =>
        params ? `${key} ${Object.values(params).join(" ")}` : key,
  };
});

vi.mock("lucide-react", () => ({
  CheckCircle2: () => null,
  Flag: () => null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/p/velvet-room",
}));

vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: testState.showSignInOverlay }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    entityReports: {
      submit: {
        useMutation: (options: MutationOptions) => {
          testState.mutationOptions = options;
          return {
            mutate: testState.mutate,
            isPending: testState.isPending,
          };
        },
      },
    },
  },
}));

import { ReportEntityDialog } from "../ReportEntityDialog";

const SUBJECT_ID = "11111111-1111-4111-8111-111111111111";

const baseProps = {
  subjectType: "PLACE" as const,
  subjectId: SUBJECT_ID,
  subjectName: "The Velvet Room",
  open: true,
  onOpenChange: vi.fn(),
};

const reasonRow = (reason: string) =>
  document.getElementById(`report-entity-reason-${reason}`) as HTMLElement;

const flushRaf = async () => {
  await act(async () => {
    await new Promise((resolve) =>
      requestAnimationFrame(() => resolve(null)),
    );
  });
};

describe("ReportEntityDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.mutationOptions = null;
    testState.isPending = false;
  });

  it("renders the PLACE reason set in canonical order", () => {
    render(<ReportEntityDialog {...baseProps} />);
    const radios = document.querySelectorAll('[role="radio"]');
    expect([...radios].map((el) => el.id)).toEqual([
      "report-entity-reason-CLOSED_OR_GONE",
      "report-entity-reason-INCORRECT_INFO",
      "report-entity-reason-DUPLICATE",
      "report-entity-reason-INAPPROPRIATE",
      "report-entity-reason-SPAM",
      "report-entity-reason-OTHER",
    ]);
    // Moderator vocabulary reused for the labels.
    expect(
      screen.getByText("moderation.reportsReasonClosedOrGone"),
    ).toBeTruthy();
  });

  it.each([
    ["HUMAN" as const],
    ["ORGANIZATION" as const],
  ])("renders the %s reason set (IMPERSONATION, no place-only reasons)", (subjectType) => {
    render(<ReportEntityDialog {...baseProps} subjectType={subjectType} />);
    const ids = [...document.querySelectorAll('[role="radio"]')].map(
      (el) => el.id,
    );
    expect(ids).toEqual([
      "report-entity-reason-IMPERSONATION",
      "report-entity-reason-INCORRECT_INFO",
      "report-entity-reason-INAPPROPRIATE",
      "report-entity-reason-SPAM",
      "report-entity-reason-OTHER",
    ]);
  });

  it("shows the subject name and moves focus to the first reason row on open", async () => {
    render(<ReportEntityDialog {...baseProps} />);
    expect(screen.getByText("The Velvet Room")).toBeTruthy();
    await flushRaf();
    expect(document.activeElement).toBe(reasonRow("CLOSED_OR_GONE"));
  });

  it("requires a reason before submitting, announced via role=alert", () => {
    render(<ReportEntityDialog {...baseProps} />);
    fireEvent.click(screen.getByText("reportEntity.submit"));
    expect(testState.mutate).not.toHaveBeenCalled();
    const error = screen.getByText("reportEntity.reasonRequiredError");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.id).toBe("report-entity-reason-error");
    // The radiogroup points at the error while it is shown.
    expect(
      document
        .querySelector('[role="radiogroup"]')
        ?.getAttribute("aria-describedby"),
    ).toBe("report-entity-reason-error");
  });

  it("blocks OTHER without details client-side: inline alert + textarea invalid wiring", () => {
    render(<ReportEntityDialog {...baseProps} />);
    fireEvent.click(reasonRow("OTHER"));
    expect(screen.getByText("reportEntity.detailsLabelRequired")).toBeTruthy();

    fireEvent.click(screen.getByText("reportEntity.submit"));
    expect(testState.mutate).not.toHaveBeenCalled();

    const error = screen.getByText("reportEntity.detailsRequiredError");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.id).toBe("report-entity-details-error");
    const textarea = screen.getByTestId("report-entity-details");
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(textarea.getAttribute("aria-describedby")).toBe(
      "report-entity-details-error",
    );

    // Typing clears the error AND the invalid state together.
    fireEvent.change(textarea, { target: { value: "context" } });
    expect(
      screen.queryByText("reportEntity.detailsRequiredError"),
    ).toBeNull();
    expect(textarea.getAttribute("aria-invalid")).toBeNull();
    expect(textarea.getAttribute("aria-describedby")).toBeNull();
  });

  it("submits the trimmed payload (details omitted when empty)", () => {
    render(<ReportEntityDialog {...baseProps} />);
    fireEvent.click(reasonRow("SPAM"));
    fireEvent.click(screen.getByText("reportEntity.submit"));
    expect(testState.mutate).toHaveBeenCalledWith({
      subjectType: "PLACE",
      subjectId: SUBJECT_ID,
      reason: "SPAM",
    });

    fireEvent.change(screen.getByTestId("report-entity-details"), {
      target: { value: "  fake listing  " },
    });
    fireEvent.click(screen.getByText("reportEntity.submit"));
    expect(testState.mutate).toHaveBeenLastCalledWith({
      subjectType: "PLACE",
      subjectId: SUBJECT_ID,
      reason: "SPAM",
      details: "fake listing",
    });
  });

  it("opts out of the global mutation toast (all branches handled here)", () => {
    render(<ReportEntityDialog {...baseProps} />);
    expect(testState.mutationOptions?.meta).toEqual({ silent: true });
  });

  it("renders the FR-008 success state, and reset-on-close yields a fresh form", () => {
    const onOpenChange = vi.fn();
    const view = render(
      <ReportEntityDialog {...baseProps} onOpenChange={onOpenChange} />,
    );
    fireEvent.click(reasonRow("SPAM"));
    fireEvent.click(screen.getByText("reportEntity.submit"));

    act(() => {
      testState.mutationOptions?.onSuccess?.({ reportId: "r1" });
    });
    expect(screen.getByText("reportEntity.successTitle")).toBeTruthy();
    expect(screen.getByText("reportEntity.successBody")).toBeTruthy();

    // Done closes...
    fireEvent.click(screen.getByText("reportEntity.doneCta"));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // ...and the next open is a clean form: no success state, no selection.
    view.rerender(
      <ReportEntityDialog
        {...baseProps}
        onOpenChange={onOpenChange}
        open={false}
      />,
    );
    view.rerender(
      <ReportEntityDialog {...baseProps} onOpenChange={onOpenChange} open />,
    );
    expect(screen.queryByText("reportEntity.successTitle")).toBeNull();
    expect(reasonRow("SPAM").getAttribute("aria-checked")).toBe("false");
  });

  it("moves focus to the success title on the phase transition (footer unmounts)", () => {
    render(<ReportEntityDialog {...baseProps} />);
    fireEvent.click(reasonRow("SPAM"));
    fireEvent.click(screen.getByText("reportEntity.submit"));

    act(() => {
      testState.mutationOptions?.onSuccess?.({ reportId: "r1" });
    });
    // The Submit button the keyboard user activated is gone; focus must land
    // on the outcome title (tabIndex -1) so it's announced, not on <body>.
    expect(document.activeElement).toBe(
      screen.getByText("reportEntity.successTitle"),
    );
  });

  it("moves focus to the already-open title on the phase transition", () => {
    render(<ReportEntityDialog {...baseProps} />);
    fireEvent.click(reasonRow("SPAM"));
    fireEvent.click(screen.getByText("reportEntity.submit"));

    act(() => {
      testState.mutationOptions?.onError?.(new Error("report_already_open"));
    });
    expect(document.activeElement).toBe(
      screen.getByText("reportEntity.alreadyOpenTitle"),
    );
  });

  it("shows the friendly already-open state for the dedupe CONFLICT", () => {
    render(<ReportEntityDialog {...baseProps} />);
    fireEvent.click(reasonRow("SPAM"));
    fireEvent.click(screen.getByText("reportEntity.submit"));

    act(() => {
      testState.mutationOptions?.onError?.(new Error("report_already_open"));
    });
    expect(screen.getByText("reportEntity.alreadyOpenTitle")).toBeTruthy();
    expect(screen.getByText("reportEntity.alreadyOpenBody")).toBeTruthy();
    expect(testState.toast.danger).not.toHaveBeenCalled();
  });

  it("shows the rate-limit warning and keeps the form open", () => {
    render(<ReportEntityDialog {...baseProps} />);
    fireEvent.click(reasonRow("SPAM"));
    fireEvent.click(screen.getByText("reportEntity.submit"));

    act(() => {
      testState.mutationOptions?.onError?.({
        message: "Rate limit exceeded for submitting reports. Try again in 60s.",
        data: { code: "TOO_MANY_REQUESTS" },
      });
    });
    expect(testState.toast.warning).toHaveBeenCalledWith({
      title: "reportEntity.rateLimitedToast",
      message: "reportEntity.rateLimitedHint",
    });
    // Still on the form (not a terminal state).
    expect(screen.getByText("reportEntity.submit")).toBeTruthy();
  });

  it("closes and opens the sign-in overlay when the session expired mid-dialog", () => {
    const onOpenChange = vi.fn();
    render(
      <ReportEntityDialog {...baseProps} onOpenChange={onOpenChange} />,
    );
    fireEvent.click(reasonRow("SPAM"));
    fireEvent.click(screen.getByText("reportEntity.submit"));

    act(() => {
      testState.mutationOptions?.onError?.({
        message: "UNAUTHORIZED",
        data: { code: "UNAUTHORIZED" },
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(testState.showSignInOverlay).toHaveBeenCalledWith({
      redirect: "/p/velvet-room",
    });
  });

  it("anchors server-side rejections inline via data.meta.reason", () => {
    render(<ReportEntityDialog {...baseProps} />);
    fireEvent.click(reasonRow("SPAM"));
    fireEvent.click(screen.getByText("reportEntity.submit"));

    act(() => {
      testState.mutationOptions?.onError?.({
        message: "INVALID_INPUT",
        data: {
          appCode: "INVALID_INPUT",
          meta: { reason: "details_required", fields: ["details"] },
        },
      });
    });
    // The server-backstop path renders through the same element as the
    // client-side rejection — same alert + textarea wiring.
    const serverError = screen.getByText("reportEntity.detailsRequiredError");
    expect(serverError.getAttribute("role")).toBe("alert");
    expect(
      screen
        .getByTestId("report-entity-details")
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("report-entity-details")
        .getAttribute("aria-describedby"),
    ).toBe("report-entity-details-error");

    act(() => {
      testState.mutationOptions?.onError?.({
        message: "INVALID_INPUT",
        data: {
          appCode: "INVALID_INPUT",
          meta: { reason: "invalid_reason_for_subject", fields: ["reason"] },
        },
      });
    });
    expect(screen.getByText("reportEntity.invalidReasonError")).toBeTruthy();
  });

  it("radiogroup: roving tabindex with a single tab stop", () => {
    render(<ReportEntityDialog {...baseProps} />);
    // Nothing selected: first row is the entry point.
    expect(reasonRow("CLOSED_OR_GONE").tabIndex).toBe(0);
    expect(reasonRow("SPAM").tabIndex).toBe(-1);

    fireEvent.click(reasonRow("SPAM"));
    expect(reasonRow("SPAM").tabIndex).toBe(0);
    expect(reasonRow("CLOSED_OR_GONE").tabIndex).toBe(-1);
  });

  it("radiogroup: arrows move selection AND focus, wrapping circularly", () => {
    render(<ReportEntityDialog {...baseProps} />);
    fireEvent.click(reasonRow("SPAM"));

    fireEvent.keyDown(reasonRow("SPAM"), { key: "ArrowDown" });
    expect(reasonRow("OTHER").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(reasonRow("OTHER"));

    // Wrap: last -> first.
    fireEvent.keyDown(reasonRow("OTHER"), { key: "ArrowDown" });
    expect(reasonRow("CLOSED_OR_GONE").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(reasonRow("CLOSED_OR_GONE"));

    fireEvent.keyDown(reasonRow("CLOSED_OR_GONE"), { key: "ArrowUp" });
    expect(reasonRow("OTHER").getAttribute("aria-checked")).toBe("true");
  });

  it("radiogroup: unhandled keys leave selection alone (Tab is not trapped)", () => {
    render(<ReportEntityDialog {...baseProps} />);
    fireEvent.click(reasonRow("SPAM"));

    fireEvent.keyDown(reasonRow("SPAM"), { key: "Tab" });
    expect(reasonRow("SPAM").getAttribute("aria-checked")).toBe("true");
    // No other row got selected or focused by the Tab press.
    expect(
      document.querySelectorAll('[role="radio"][aria-checked="true"]').length,
    ).toBe(1);
  });

  it("radiogroup: Space selects the focused row", () => {
    render(<ReportEntityDialog {...baseProps} />);
    fireEvent.keyDown(reasonRow("DUPLICATE"), { key: " " });
    expect(reasonRow("DUPLICATE").getAttribute("aria-checked")).toBe("true");
  });
});
