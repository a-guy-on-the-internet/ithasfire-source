import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The issue form after its move out of the page and into a dialog.
 *
 * These tests exist to prove the RELOCATION was a move, not a rewrite: the
 * same validity rule, the same mutation payload, the same toast pair, the same
 * success banner. Plus the one thing the move adds — `comp.list` invalidation,
 * so the row shows up in the ledger behind the dialog without a refresh.
 */

const testState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  handlers: {} as {
    onSuccess?: (data: { orderId: string; recipientHumanId: string }) => void;
    onError?: (err: unknown) => void;
  },
  invalidate: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
  ticketTypes: [{ id: "tt-1", name: "General" }] as Array<{
    id: string;
    name: string;
  }>,
  ticketTypesLoading: false,
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    tag,
    onChange,
    value,
    ...props
  }: {
    children?: ReactNode;
    tag?: string;
    onChange?: (e: unknown) => void;
    value?: string;
  }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-"))
        safe[key] = val;
    }
    // The ticket-type control is a native <select> smuggled through Tamagui's
    // `tag` prop; keep it a real select so its accessible name is testable.
    if (tag === "select") {
      return React.createElement(
        "select",
        { ...safe, value, onChange },
        children,
      );
    }
    return React.createElement("div", safe, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Modal = Object.assign(
    ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div data-testid="modal">{children}</div> : null,
    {
      Panel: ({ children }: { children?: ReactNode }) => (
        <div role="dialog" aria-modal="true">
          {children}
        </div>
      ),
      Header: ({ title, onClose }: { title: string; onClose?: () => void }) => (
        <div>
          <h2>{title}</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      ),
      Body: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
  );

  return {
    Modal,
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
      <button
        type="button"
        onClick={onPress}
        disabled={disabled}
        data-testid={testID}
      >
        {children}
      </button>
    ),
    Spinner: () => <span>Loading</span>,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    TextInput: ({
      value,
      onChangeText,
      testId,
      ...rest
    }: {
      value?: string;
      onChangeText?: (next: string) => void;
      testId?: string;
      [key: string]: unknown;
    }) =>
      React.createElement("input", {
        value: value ?? "",
        "data-testid": testId,
        "aria-label": rest["aria-label"] as string | undefined,
        onChange: (e: { target: { value: string } }) =>
          onChangeText?.(e.target.value),
      }),
    useNotify: () => ({
      toast: {
        success: testState.toastSuccess,
        danger: testState.toastDanger,
        warning: vi.fn(),
      },
    }),
    // Serialises ICU values so a test can assert an interpolated argument
    // (the success banner's {email}) actually reached the message.
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    comp: {
      issue: {
        useMutation: (opts: {
          onSuccess?: (data: {
            orderId: string;
            recipientHumanId: string;
          }) => void;
          onError?: (err: unknown) => void;
        }) => {
          testState.handlers = opts;
          return { mutate: testState.mutate, isPending: testState.isPending };
        },
      },
    },
    events: {
      listTicketTypesForEdit: {
        useQuery: () => ({
          data: { ticketTypes: testState.ticketTypes },
          isLoading: testState.ticketTypesLoading,
        }),
      },
    },
    useUtils: () => ({
      comp: { list: { invalidate: testState.invalidate } },
    }),
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => `formatted:${String(err)}`,
}));

import { IssueCompDialog } from "../IssueCompDialog";

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  testState.isPending = false;
  testState.ticketTypes = [{ id: "tt-1", name: "General" }];
  testState.ticketTypesLoading = false;
});

function renderOpen(onClose = vi.fn()) {
  render(
    <IssueCompDialog eventId={EVENT_ID} open onClose={onClose} />,
  );
  return onClose;
}

describe("IssueCompDialog", () => {
  it("renders nothing until it is opened", () => {
    render(
      <IssueCompDialog eventId={EVENT_ID} open={false} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a labelled dialog with named fields", () => {
    renderOpen();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // The hand-rolled <select> had no accessible name at all before the move.
    expect(
      screen.getByLabelText("admin.compIssueTicketTypeLabel"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("admin.compIssueRecipientEmailLabel"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("admin.compIssueQuantityLabel"),
    ).toBeInTheDocument();
  });

  // Relocated verbatim: an address needs an "@", a ticket type must resolve,
  // and quantity must parse to >= 1.
  it("keeps submit disabled until the form is valid", () => {
    renderOpen();
    const submit = screen.getByTestId("comp-issue-submit");
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId("comp-recipient-email"), {
      target: { value: "guest@example.com" },
    });
    expect(submit).not.toBeDisabled();
  });

  it.each(["0", "-1", "abc", ""])(
    "keeps submit disabled for invalid quantity %j",
    (badQuantity) => {
      renderOpen();
      fireEvent.change(screen.getByTestId("comp-recipient-email"), {
        target: { value: "guest@example.com" },
      });
      fireEvent.change(screen.getByTestId("comp-quantity"), {
        target: { value: badQuantity },
      });

      const submit = screen.getByTestId("comp-issue-submit");
      expect(submit).toBeDisabled();
      // …and even a programmatic click cannot fire the mutation.
      fireEvent.click(submit);
      expect(testState.mutate).not.toHaveBeenCalled();
    },
  );

  it("blocks submission when no ticket type exists", () => {
    testState.ticketTypes = [];
    renderOpen();

    fireEvent.change(screen.getByTestId("comp-recipient-email"), {
      target: { value: "guest@example.com" },
    });
    expect(screen.getByTestId("comp-issue-submit")).toBeDisabled();
  });

  it("sends the same payload the page form did", () => {
    renderOpen();

    fireEvent.change(screen.getByTestId("comp-recipient-email"), {
      target: { value: "guest@example.com" },
    });
    fireEvent.change(screen.getByTestId("comp-recipient-name"), {
      target: { value: "Guest" },
    });
    fireEvent.change(screen.getByTestId("comp-quantity"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByTestId("comp-reason"), {
      target: { value: "Sound engineer" },
    });
    fireEvent.click(screen.getByTestId("comp-issue-submit"));

    expect(testState.mutate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      ticketTypeId: "tt-1",
      quantity: 3,
      recipientEmail: "guest@example.com",
      recipientName: "Guest",
      reason: "Sound engineer",
    });
  });

  it("omits the optional fields rather than sending empty strings", () => {
    renderOpen();
    fireEvent.change(screen.getByTestId("comp-recipient-email"), {
      target: { value: "guest@example.com" },
    });
    fireEvent.click(screen.getByTestId("comp-issue-submit"));

    expect(testState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientName: undefined,
        reason: undefined,
      }),
    );
  });

  it("shows a spinner instead of the label while issuing", () => {
    testState.isPending = true;
    renderOpen();
    expect(screen.getByTestId("comp-issue-submit")).toBeDisabled();
    expect(screen.getByTestId("comp-issue-submit").textContent).toContain(
      "Loading",
    );
  });

  // The move's one addition: without this the organizer issues a comp and the
  // ledger behind the dialog still says it does not exist.
  it("refreshes the ledger, banners the result and stays open on success", async () => {
    renderOpen();
    fireEvent.change(screen.getByTestId("comp-recipient-email"), {
      target: { value: "guest@example.com" },
    });
    fireEvent.change(screen.getByTestId("comp-quantity"), {
      target: { value: "2" },
    });

    act(() => {
      testState.handlers.onSuccess?.({
        orderId: "order-1",
        recipientHumanId: "human-1",
      });
    });

    await waitFor(() => {
      expect(testState.invalidate).toHaveBeenCalledTimes(1);
    });
    expect(testState.toastSuccess).toHaveBeenCalledWith(
      "admin.compIssuedToast",
    );
    // Still open, with the banner and a reset form — issuing a run of comps in
    // one sitting is the normal case.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toContain(
      "guest@example.com",
    );
    expect(screen.getByTestId("comp-recipient-email")).toHaveValue("");
  });

  it("toasts a formatted error and leaves the draft alone on failure", () => {
    renderOpen();
    fireEvent.change(screen.getByTestId("comp-recipient-email"), {
      target: { value: "guest@example.com" },
    });

    act(() => {
      testState.handlers.onError?.(new Error("nope"));
    });

    expect(testState.toastDanger).toHaveBeenCalledWith(
      "formatted:Error: nope",
    );
    expect(screen.getByTestId("comp-recipient-email")).toHaveValue(
      "guest@example.com",
    );
  });

  it("closes through the footer cancel", () => {
    const onClose = renderOpen();
    fireEvent.click(screen.getByText("common.cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // A stale "issued to …" banner must not greet the NEXT open — the next
  // recipient hasn't been issued anything.
  it("clears the success banner when the dialog closes", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <IssueCompDialog eventId={EVENT_ID} open onClose={onClose} />,
    );

    fireEvent.change(screen.getByTestId("comp-recipient-email"), {
      target: { value: "guest@example.com" },
    });
    act(() => {
      testState.handlers.onSuccess?.({
        orderId: "order-1",
        recipientHumanId: "human-1",
      });
    });
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    rerender(
      <IssueCompDialog eventId={EVENT_ID} open={false} onClose={onClose} />,
    );
    rerender(<IssueCompDialog eventId={EVENT_ID} open onClose={onClose} />);

    expect(screen.queryByRole("status")).toBeNull();
  });
});
