import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PromoFormDialog } from "../PromoFormDialog";

/**
 * The promo dialog's money wiring, end to end through the real component.
 *
 * The pure readers are covered by `promo-numeric-fields.test.ts`; what this
 * file pins is the SEAM they can't see — that the keystroke filter no longer
 * destroys the decimal comma, and that a refusal stops the submit:
 *
 *  - `15,50` (AMOUNT) → 1550 cents is SENT (was: the field visibly became
 *    `1550` and a $1,550 discount was saved — a silent 100x overcharge)
 *  - unreadable min-order / max-discount → the mutation is NEVER called
 *    (was: coerced to `null`, which silently meant "no minimum" / "no cap")
 *  - blank min-order / max-discount → still omitted, i.e. still "not set"
 *
 * Mocks follow `TicketTypeEditorAmounts.test.tsx` and are ENUMERATED rather
 * than a catch-all Proxy: a proxy that answers every property also answers
 * `then`, which makes the module namespace look like a thenable and hangs
 * `import()` forever. `@/lib/money/*` is deliberately NOT mocked.
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
    Text: ({ children, id }: { children?: ReactNode; id?: string }) => (
      <span id={id}>{children}</span>
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
    Checkbox: ({ label }: { label?: string }) => <span>{label}</span>,
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

const typeIn = (placeholder: string, value: string) =>
  fireEvent.change(screen.getByPlaceholderText(placeholder), {
    target: { value },
  });

const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "admin.cpCreatePromo" }));

const submitButton = () =>
  screen.getByRole("button", { name: "admin.cpCreatePromo" });

/** Flip the discount type; note the component clears `value` on every switch. */
const chooseKind = (kind: "PERCENT" | "AMOUNT") =>
  fireEvent.change(screen.getByTestId("promo-kind"), {
    target: { value: kind },
  });

const sent = () => createMutate.mock.calls[0]![0] as Record<string, unknown>;

describe("PromoFormDialog — fixed-amount (AMOUNT) value", () => {
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
    typeIn("SUMMER2026", "SUMMER");
    chooseKind("AMOUNT");
  });

  it("keeps the comma the organiser typed instead of eating it", () => {
    // The bug in one assertion: the old keystroke filter turned this field
    // into "1550" while the organiser watched.
    typeIn("5.00", "15,50");
    expect(screen.getByPlaceholderText("5.00")).toHaveValue("15,50");
  });

  it("banks 15,50 as $15.50, not as a $1,550 discount", () => {
    typeIn("5.00", "15,50");
    submit();

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({ kind: "AMOUNT", value: 1550 });
  });

  it("still reads a plain en amount, and 1550 still means $1,550", () => {
    typeIn("5.00", "15.50");
    submit();
    expect(sent()).toMatchObject({ value: 1550 });

    createMutate.mockClear();
    typeIn("5.00", "1550");
    submit();
    expect(createMutate.mock.calls[0]![0]).toMatchObject({ value: 155000 });
  });

  it("refuses an unreadable amount without calling the mutation", () => {
    // "15 50" — someone reaching for the space bar on a phone keyboard. The
    // keystroke filter deliberately KEEPS the space (swallowing it would read
    // this as $15.50 → 1550 → a $1,550 discount) so the submit can refuse it.
    typeIn("5.00", "15 50");

    expect(submitButton()).toBeDisabled();
    submit();
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByText("admin.cpAmountInvalid")).toBeInTheDocument();
  });

  it("still filters letters at the keystroke, so they read as blank", () => {
    // The field remains a number field: letters never land. That makes
    // "required" — not "invalid" — the honest message for typed-in prose.
    typeIn("5.00", "nonsense");
    expect(screen.getByPlaceholderText("5.00")).toHaveValue("");
    expect(screen.getByText("admin.cpValueRequired")).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it("explains an ambiguous amount instead of guessing at it", () => {
    typeIn("5.00", "1,500");
    expect(screen.getByText("admin.cpAmountAmbiguous")).toBeInTheDocument();
    submit();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("sends no cap for an AMOUNT promo", () => {
    typeIn("5.00", "15,50");
    submit();
    expect(sent().maxDiscountCents).toBeUndefined();
  });
});

describe("PromoFormDialog — percent value", () => {
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
    typeIn("SUMMER2026", "SUMMER");
  });

  it("sends a whole percent", () => {
    typeIn("20", "25");
    submit();
    expect(sent()).toMatchObject({ kind: "PERCENT", value: 25 });
  });

  it("refuses a fractional percent instead of the old 12,5 → 125% mangling", () => {
    typeIn("20", "12,5");
    // The comma survives the keystroke now…
    expect(screen.getByPlaceholderText("20")).toHaveValue("12,5");
    // …and the refusal names the real problem.
    expect(screen.getByText("admin.cpValuePercentWhole")).toBeInTheDocument();
    submit();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("calls a negative percent unreadable, not badly-rounded", () => {
    // The message ladder's fallback used to be the whole-number message, so
    // "-20" told the organiser to drop a decimal they never typed.
    typeIn("20", "-20");
    expect(screen.getByPlaceholderText("20")).toHaveValue("-20");
    expect(screen.getByText("admin.cpAmountInvalid")).toBeInTheDocument();
    expect(screen.queryByText("admin.cpValuePercentWhole")).toBeNull();
    submit();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("range-checks the percent", () => {
    typeIn("20", "125");
    expect(screen.getByText("admin.cpValuePercentRange")).toBeInTheDocument();
    submit();
    expect(createMutate).not.toHaveBeenCalled();
  });
});

describe("PromoFormDialog — min order / max discount can no longer go silently null", () => {
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
    typeIn("SUMMER2026", "SUMMER");
    typeIn("20", "25");
  });

  it("keeps blank meaning 'no minimum' / 'no cap'", () => {
    submit();
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(sent().minOrderCents).toBeUndefined();
    expect(sent().maxDiscountCents).toBeUndefined();
  });

  it("reads an es min order", () => {
    typeIn("0.00", "15,50");
    submit();
    expect(sent().minOrderCents).toBe(1550);
  });

  it("reads an es max discount", () => {
    typeIn("admin.cpNoLimit", "15,50");
    submit();
    expect(sent().maxDiscountCents).toBe(1550);
  });

  it("still sends an explicit $0 minimum — 0 and blank are different", () => {
    // A $0 floor is a real (if redundant) setting, and the wire accepts it.
    // Only the CAP treats 0 as an error, so pin that they diverge on purpose.
    typeIn("0.00", "0");
    submit();
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(sent().minOrderCents).toBe(0);
  });

  it("REFUSES a $0 cap inline instead of letting the wire reject it", () => {
    // `maxDiscountCents` is `.int().min(1)` on the wire, and `0 ?? undefined`
    // is 0 — so a typed 0 used to sail through and come back as a raw server
    // error in the banner. In a dialog whose whole point is that blank / 0 /
    // unreadable are three different things, that is the wrong answer.
    typeIn("admin.cpNoLimit", "0");

    expect(screen.getByText("admin.cpMaxDiscountPositive")).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    submit();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("REFUSES an unreadable min order rather than silently dropping it", () => {
    // The second silent failure: `dollarsInputToCents` returned null for a
    // typo, and null means "no minimum" — the promo shipped with no floor.
    typeIn("0.00", "1,5,0");

    expect(submitButton()).toBeDisabled();
    submit();
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByText("admin.cpAmountInvalid")).toBeInTheDocument();
  });

  it("REFUSES an unreadable max discount rather than silently uncapping", () => {
    typeIn("admin.cpNoLimit", "15 50");

    expect(submitButton()).toBeDisabled();
    submit();
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByText("admin.cpAmountInvalid")).toBeInTheDocument();
  });

  it("does not refuse over a cap that the submit discards", () => {
    // Switching to AMOUNT clears the cap and sends null for it, so the field
    // must not be able to block a submit that never looks at it.
    typeIn("admin.cpNoLimit", "15 50");
    expect(submitButton()).toBeDisabled();

    chooseKind("AMOUNT");
    typeIn("5.00", "15,50");

    expect(submitButton()).not.toBeDisabled();
    submit();
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(sent().maxDiscountCents).toBeUndefined();
  });

  it("recovers once the typo is fixed", () => {
    typeIn("0.00", "15 50");
    expect(submitButton()).toBeDisabled();

    typeIn("0.00", "10,00");
    expect(submitButton()).not.toBeDisabled();
    submit();
    expect(sent().minOrderCents).toBe(1000);
  });
});
