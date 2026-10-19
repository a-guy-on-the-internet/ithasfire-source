import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSetMutate = vi.fn();

vi.mock("tamagui", () => {
  const passthrough = ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <div data-testid={testId}>{children}</div>;
  return { YStack: passthrough, XStack: passthrough };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  Radio: ({ value, label }: { value: string; label?: ReactNode }) => (
    <label>
      <input type="radio" value={value} readOnly />
      {label}
    </label>
  ),
  RadioGroupField: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  StyledSelect: ({
    value,
    options,
    onChange,
    placeholder,
    testId,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    placeholder?: string;
    testId?: string;
  }) => (
    <select
      data-testid={testId}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  useFormatters: () => ({ currency: (v: number) => `$${v}` }),
  useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      rewards: {
        set: {
          useMutation: () => ({ mutate: mockSetMutate, isPending: false }),
        },
      },
    },
  },
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number) => `$${(cents / 100).toFixed(2)}`,
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

import { VolunteerRewardForm } from "../VolunteerRewardForm";

const ticketTypes = [
  { id: "tt1", name: "GA", priceCents: 1000 },
  { id: "tt2", name: "VIP", priceCents: 5000 },
];

function renderForm(overrides?: {
  roles?: { id: string; name: string }[];
  rewards?: Parameters<typeof VolunteerRewardForm>[0]["rewards"];
}) {
  return render(
    <VolunteerRewardForm
      askId="ask1"
      ticketTypes={ticketTypes}
      currency="usd"
      roles={overrides?.roles ?? []}
      rewards={overrides?.rewards ?? []}
      onSaved={vi.fn()}
    />,
  );
}

describe("VolunteerRewardForm", () => {
  beforeEach(() => {
    mockSetMutate.mockReset();
  });

  it("renders each ticket type as an option", () => {
    renderForm();
    const select = screen.getByTestId(
      "volunteer-reward-ticket-type",
    ) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("GA"))).toBe(true);
    expect(labels.some((l) => l?.includes("VIP"))).toBe(true);
  });

  it("submits rewards.set with the COMP-only shape (roleId null, default trigger, no cap)", () => {
    renderForm();
    fireEvent.change(screen.getByTestId("volunteer-reward-ticket-type"), {
      target: { value: "tt1" },
    });
    fireEvent.click(screen.getByTestId("volunteer-reward-submit"));
    expect(mockSetMutate).toHaveBeenCalledTimes(1);
    expect(mockSetMutate).toHaveBeenCalledWith({
      askId: "ask1",
      roleId: null,
      ticketTypeId: "tt1",
      trigger: "ON_CHECK_IN",
      maxGrants: null,
    });
  });

  it("passes a valid budget cap through as an integer", () => {
    renderForm();
    fireEvent.change(screen.getByTestId("volunteer-reward-ticket-type"), {
      target: { value: "tt2" },
    });
    fireEvent.change(screen.getByTestId("volunteer-reward-max-grants"), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByTestId("volunteer-reward-submit"));
    expect(mockSetMutate).toHaveBeenCalledWith({
      askId: "ask1",
      roleId: null,
      ticketTypeId: "tt2",
      trigger: "ON_CHECK_IN",
      maxGrants: 50,
    });
  });

  it("blocks submit with an inline error on an invalid budget cap", () => {
    renderForm();
    fireEvent.change(screen.getByTestId("volunteer-reward-ticket-type"), {
      target: { value: "tt1" },
    });
    fireEvent.change(screen.getByTestId("volunteer-reward-max-grants"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByTestId("volunteer-reward-submit"));
    expect(mockSetMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText("volunteering.rewardMaxGrantsInvalid"),
    ).toBeTruthy();
  });

  it("requires a ticket type before submitting", () => {
    renderForm();
    fireEvent.click(screen.getByTestId("volunteer-reward-submit"));
    expect(mockSetMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText("volunteering.rewardTicketTypeRequired"),
    ).toBeTruthy();
  });
});
