import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { YStack: passthrough, XStack: passthrough };
});

vi.mock("@th/ui", () => {
  const Modal = Object.assign(
    ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    {
      Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Header: ({ title }: { title?: string }) => <h2>{title}</h2>,
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
        onClick={() => onPress?.()}
      >
        {children}
      </button>
    ),
    StyledSelect: () => <select />,
    Switch: () => <input type="checkbox" />,
    Text: ({
      children,
      role,
      id,
    }: {
      children?: ReactNode;
      role?: string;
      id?: string;
    }) => (
      <span role={role} id={id}>
        {children}
      </span>
    ),
    TextInput: ({
      value,
      onChangeText,
      testId,
    }: {
      value: string;
      onChangeText?: (value: string) => void;
      testId?: string;
    }) => (
      <input
        data-testid={testId}
        value={value}
        onChange={(event) => onChangeText?.(event.target.value)}
      />
    ),
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      asks: {
        create: {
          useMutation: () => ({ mutate: mockCreate, isPending: false }),
        },
        update: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
      },
    },
  },
}));

let mockGates: { sms?: boolean } | undefined;

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: mockGates, isLoading: false }),
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

import { VolunteerAskForm } from "../VolunteerAskForm";

/** Chrome's half-typed state: `value` stays "" while `badInput` is true. */
function stubBadInput(el: HTMLInputElement, read: () => boolean) {
  Object.defineProperty(el, "validity", {
    configurable: true,
    get: () => ({ badInput: read() }),
  });
}

function renderCreate() {
  render(
    <VolunteerAskForm
      mode="create"
      subject={{ subjectType: "ORG", subjectId: "org1" }}
      onClose={vi.fn()}
      onSuccess={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByTestId("volunteer-ask-title"), {
    target: { value: "Door crew" },
  });
}

describe("VolunteerAskForm — half-typed dates", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("disables CREATE and shows an alert while the start is half-typed", () => {
    renderCreate();
    const submit = screen.getByTestId("volunteer-ask-submit");
    expect(submit).not.toBeDisabled();

    const starts = screen.getByTestId(
      "volunteer-ask-starts-at",
    ) as HTMLInputElement;
    let bad = true;
    stubBadInput(starts, () => bad);
    // No input event fires while half-typed; only keyup sees it.
    fireEvent.keyUp(starts, { key: "1" });

    // Submit is gated at once, but nothing is announced while typing.
    expect(submit).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(starts).not.toHaveAttribute("aria-invalid");

    fireEvent.blur(starts);
    expect(screen.getByRole("alert").textContent).toBe(
      "volunteering.askStartsIncomplete",
    );
    expect(starts).toHaveAttribute("aria-invalid", "true");
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(mockCreate).not.toHaveBeenCalled();

    // The last segment lands: the value commits and the guard lifts.
    bad = false;
    fireEvent.change(starts, { target: { value: "2026-10-24T18:00" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0].startsAt).toEqual(
      new Date("2026-10-24T18:00"),
    );
  });

  it("keeps CREATE enabled for an empty title: only a half-typed date disables it", () => {
    render(
      <VolunteerAskForm
        mode="create"
        subject={{ subjectType: "ORG", subjectId: "org1" }}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    const submit = screen.getByTestId("volunteer-ask-submit");
    expect(submit).not.toBeDisabled();
    const starts = screen.getByTestId(
      "volunteer-ask-starts-at",
    ) as HTMLInputElement;
    stubBadInput(starts, () => true);
    fireEvent.keyUp(starts, { key: "1" });
    expect(submit).toBeDisabled();
  });

  it("shows the end alert while the end is half-typed", () => {
    renderCreate();
    const ends = screen.getByTestId("volunteer-ask-ends-at") as HTMLInputElement;
    stubBadInput(ends, () => true);
    fireEvent.keyUp(ends, { key: "1" });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(ends);
    expect(screen.getByRole("alert").textContent).toBe(
      "volunteering.askEndsIncomplete",
    );
    expect(screen.getByTestId("volunteer-ask-submit")).toBeDisabled();
  });

  it("refuses at submit when a field is half-typed but no keyup was seen", () => {
    renderCreate();
    const starts = screen.getByTestId(
      "volunteer-ask-starts-at",
    ) as HTMLInputElement;
    stubBadInput(starts, () => true);
    fireEvent.click(screen.getByTestId("volunteer-ask-submit"));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "volunteering.askStartsIncomplete",
    );
  });

  it("recovers after a submit-time refusal: completing the date re-enables submit", () => {
    renderCreate();
    const submit = screen.getByTestId("volunteer-ask-submit");
    const starts = screen.getByTestId(
      "volunteer-ask-starts-at",
    ) as HTMLInputElement;
    let bad = true;
    stubBadInput(starts, () => bad);
    // No keyup or blur was seen, so the field never reported on its own.
    fireEvent.click(submit);
    expect(submit).toBeDisabled();
    expect(screen.getByRole("alert")).toBeTruthy();

    // The picker completes the value: a single change event must clear it.
    bad = false;
    fireEvent.change(starts, { target: { value: "2026-10-24T18:00" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submit).not.toBeDisabled();
  });
});
