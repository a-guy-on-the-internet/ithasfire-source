import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PromoFormDialog } from "../PromoFormDialog";

/**
 * A half-typed schedule date must block the save. Chrome fires no input event
 * while some segments are blank, so `value` stays "" and, unguarded, the promo
 * saved with no start or no expiry. Mocks are copied from
 * `PromoFormDialogAmounts.test.tsx`, with a working Checkbox and a Text that
 * keeps `role`.
 */

const createMutate = vi.fn();
const updateMutate = vi.fn();

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: passthrough, YStack: passthrough };
});

vi.mock("@th/ui", () => {
  const Panel = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Header = ({ title }: { title?: string }) => <h2>{title}</h2>;
  const Body = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Footer = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Modal = Object.assign(
    ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    { Panel, Header, Body, Footer },
  );
  return {
    Modal,
    Text: ({
      children,
      id,
      role,
    }: {
      children?: ReactNode;
      id?: string;
      role?: string;
    }) => (
      <span id={id} role={role}>
        {children}
      </span>
    ),
    TextInput: ({
      id,
      value,
      onChangeText,
      placeholder,
      disabled,
    }: {
      id?: string;
      value?: string;
      onChangeText?: (v: string) => void;
      placeholder?: string;
      disabled?: boolean;
    }) => (
      <input
        id={id}
        placeholder={placeholder}
        disabled={disabled}
        value={value ?? ""}
        onChange={(e) => onChangeText?.(e.target.value)}
      />
    ),
    // Same shape as TextInput above — the promo money fields (value/min
    // order/max discount) swapped to AmountInput for the "$"/"%" inset
    // (design-system fix); prefix/suffix are rendering-only and not asserted
    // here, so the mock ignores them.
    AmountInput: ({
      id,
      value,
      onChangeText,
      placeholder,
      disabled,
    }: {
      id?: string;
      value?: string;
      onChangeText?: (v: string) => void;
      placeholder?: string;
      disabled?: boolean;
    }) => (
      <input
        id={id}
        placeholder={placeholder}
        disabled={disabled}
        value={value ?? ""}
        onChange={(e) => onChangeText?.(e.target.value)}
      />
    ),
    Button: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={onPress}>
        {children}
      </button>
    ),
    StyledSelect: ({
      options,
      value,
      onChange,
    }: {
      options: { value: string; label: string }[];
      value?: string;
      onChange?: (v: string) => void;
    }) => (
      <select
        data-testid="promo-kind"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ),
    Checkbox: ({
      label,
      checked,
      onCheckedChange,
    }: {
      label?: string;
      checked?: boolean;
      onCheckedChange?: (v: boolean) => void;
    }) => (
      <label>
        <input
          type="checkbox"
          checked={checked ?? false}
          onChange={(e) => onCheckedChange?.(e.target.checked)}
        />
        {label}
      </label>
    ),
    FormErrorBanner: ({ message }: { message?: string | null }) =>
      message ? <div role="alert">{message}</div> : null,
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    // Echo the key so an assertion can tell i18n copy from a hardcoded literal.
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    promos: {
      create: {
        useMutation: () => ({ mutate: createMutate, isPending: false }),
      },
      update: {
        useMutation: () => ({ mutate: updateMutate, isPending: false }),
      },
    },
  },
}));

vi.mock("@/hooks/useFormErrors", () => ({
  useFormErrors: () => ({
    fieldErrors: {},
    formError: null,
    setError: vi.fn(),
    setFieldError: vi.fn(),
    clearField: vi.fn(),
    clearAll: vi.fn(),
    hasErrors: false,
  }),
}));

/** Chrome's half-typed state: `value` stays "" while `badInput` is true. */
function stubBadInput(el: HTMLInputElement, read: () => boolean) {
  Object.defineProperty(el, "validity", {
    configurable: true,
    get: () => ({ badInput: read() }),
  });
}

const submitButton = () =>
  screen.getByRole("button", { name: "admin.cpCreatePromo" });

describe("PromoFormDialog — half-typed schedule dates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    render(
      <PromoFormDialog
        ownerType="ORGANIZATION"
        ownerId="org_1"
        editingPromo={null}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("SUMMER2026"), {
      target: { value: "SUMMER" },
    });
    fireEvent.change(screen.getByPlaceholderText("20"), {
      target: { value: "10" },
    });
  });

  it("disables save and shows an alert while the start is half-typed", () => {
    expect(submitButton()).not.toBeDisabled();
    fireEvent.click(screen.getByLabelText("admin.cpStartsImmediately"));
    const starts = screen.getByTestId("promo-starts-at") as HTMLInputElement;
    stubBadInput(starts, () => true);
    fireEvent.keyUp(starts, { key: "1" });

    expect(submitButton()).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(starts).not.toHaveAttribute("aria-invalid");
    fireEvent.blur(starts);

    expect(screen.getByRole("alert").textContent).toBe(
      "common.dateTimeStartIncomplete",
    );
    expect(starts).toHaveAttribute("aria-invalid", "true");
    expect(submitButton()).toBeDisabled();
    fireEvent.click(submitButton());
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("disables save while the end is half-typed, and lifts when 'No expiry' is ticked", () => {
    fireEvent.click(screen.getByLabelText("admin.cpNoExpiry"));
    const ends = screen.getByTestId("promo-ends-at") as HTMLInputElement;
    stubBadInput(ends, () => true);
    fireEvent.keyUp(ends, { key: "1" });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(ends);
    expect(screen.getByRole("alert").textContent).toBe(
      "common.dateTimeEndIncomplete",
    );
    expect(submitButton()).toBeDisabled();

    fireEvent.click(screen.getByLabelText("admin.cpNoExpiry"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submitButton()).not.toBeDisabled();
  });
});
