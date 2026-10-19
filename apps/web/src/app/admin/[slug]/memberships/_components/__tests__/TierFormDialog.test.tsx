import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TierFormDialog, resolveTierPriceField } from "../TierFormDialog";
import type { TierRow } from "../tier-row";

/**
 * The tier dialog's two load-bearing behaviours:
 *
 *  1. Money wiring — the price field is text + one submit-time read through
 *     `parseMoneyInputToCents` (the promo-dialog pattern): `10,50` submits
 *     1050 cents, and an ambiguous `1,500` REFUSES instead of guessing.
 *  2. The server locks surfaced client-side — a `priceLocked` tier renders a
 *     disabled price input with the archive-and-replace hint and the update
 *     mutation NEVER carries `priceCents`; a tier with live members disables
 *     the tax-category select the same way.
 *
 * Mocks are ENUMERATED (PromoFormDialogAmounts pattern), never a Proxy.
 * `@/lib/money/parse-money-input` is deliberately NOT mocked.
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
    // Same shape as TextInput above — the tier price field swapped to
    // AmountInput for the "$" prefix (design-system fix); prefix/suffix are
    // rendering-only and not asserted here, so the mock ignores them.
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
    StyledSelect: ({
      options,
      value,
      onChange,
      disabled,
    }: {
      options: { value: string; label: string }[];
      value?: string;
      onChange?: (v: string) => void;
      disabled?: boolean;
    }) => (
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ),
    FormErrorBanner: ({ message }: { message?: string | null }) =>
      message ? <div role="alert">{message}</div> : null,
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
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    // Echo the key so assertions can tell i18n copy from hardcoded literals.
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    memberships: {
      tiers: {
        create: {
          useMutation: () => ({ mutate: createMutate, isPending: false }),
        },
        update: {
          useMutation: () => ({ mutate: updateMutate, isPending: false }),
        },
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

const TIER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const baseTier: TierRow = {
  id: TIER_ID,
  name: "Sustaining Member",
  description: "Keeps the lights on.",
  benefitsDescription: null,
  priceCents: 1000,
  currency: "usd",
  interval: "MONTH",
  status: "ACTIVE",
  sortOrder: 0,
  memberCount: 0,
  priceLocked: false,
  benefits: [],
  createdAt: new Date("2026-08-01T00:00:00Z"),
};

const typeName = (value: string) =>
  fireEvent.change(
    screen.getByPlaceholderText("adminMemberships.namePlaceholder"),
    { target: { value } },
  );

const typePrice = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText("10.00"), {
    target: { value },
  });

describe("resolveTierPriceField", () => {
  it("reads plain dollars, comma decimals, and refuses ambiguity", () => {
    expect(resolveTierPriceField("10.00")).toEqual({
      kind: "value",
      cents: 1000,
    });
    expect(resolveTierPriceField("10,50")).toEqual({
      kind: "value",
      cents: 1050,
    });
    expect(resolveTierPriceField("1,500")).toEqual({
      kind: "error",
      messageKey: "adminMemberships.priceAmbiguous",
    });
    expect(resolveTierPriceField("")).toEqual({
      kind: "error",
      messageKey: "adminMemberships.priceRequired",
    });
    expect(resolveTierPriceField("0")).toEqual({
      kind: "error",
      messageKey: "adminMemberships.pricePositive",
    });
    expect(resolveTierPriceField("nonsense")).toEqual({
      kind: "error",
      messageKey: "adminMemberships.priceInvalid",
    });
    expect(resolveTierPriceField("100001")).toEqual({
      kind: "error",
      messageKey: "adminMemberships.priceTooHigh",
    });
  });
});

describe("TierFormDialog — create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    render(
      <TierFormDialog
        ownerType="ORGANIZATION"
        ownerId={ORG_ID}
        editingTier={null}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
  });

  it("submits a comma-decimal price as exact cents with defaults", () => {
    typeName("Sustaining Member");
    typePrice("10,50");
    fireEvent.click(
      screen.getByRole("button", { name: "adminMemberships.createTier" }),
    );

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0]![0]).toEqual({
      ownerOrgId: ORG_ID,
      name: "Sustaining Member",
      priceCents: 1050,
      currency: "usd",
      interval: "MONTH",
    });
  });

  it("refuses an ambiguous price instead of guessing", () => {
    typeName("Sustaining Member");
    typePrice("1,500");

    expect(
      screen.getByText("adminMemberships.priceAmbiguous"),
    ).toBeInTheDocument();
    const submit = screen.getByRole("button", {
      name: "adminMemberships.createTier",
    });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(createMutate).not.toHaveBeenCalled();
  });
});

describe("TierFormDialog — server locks surfaced in the form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("price-locked tier: disabled input, archive-and-replace hint, and priceCents never sent", () => {
    render(
      <TierFormDialog
        ownerType="ORGANIZATION"
        ownerId={ORG_ID}
        editingTier={{ ...baseTier, priceLocked: true, memberCount: 3 }}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText("10.00")).toBeDisabled();
    expect(
      screen.getByText("adminMemberships.priceLockedHint"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "adminMemberships.save" }),
    );
    expect(updateMutate).toHaveBeenCalledTimes(1);
    const sent = updateMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.tierId).toBe(TIER_ID);
    expect(sent).not.toHaveProperty("priceCents");
    // The tax category is not merely locked, it is GONE from this form and
    // from the update schema (which is `.strict()`, so sending it would 400).
    expect(sent).not.toHaveProperty("taxCategory");
    expect(
      screen.queryByText("adminMemberships.taxCategoryLabel"),
    ).not.toBeInTheDocument();
    // What replaced it is freely editable even here, with live members —
    // a benefit statement has nothing immutable behind it.
    expect(
      screen.getByPlaceholderText(
        "adminMemberships.benefitsDescriptionPlaceholder",
      ),
    ).not.toBeDisabled();
    expect(sent).toHaveProperty("benefitsDescription");
  });

  it("unlocked draft: a changed price IS sent in cents", () => {
    render(
      <TierFormDialog
        ownerType="ORGANIZATION"
        ownerId={ORG_ID}
        editingTier={{ ...baseTier, status: "DRAFT" }}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    typePrice("12.34");
    fireEvent.click(
      screen.getByRole("button", { name: "adminMemberships.save" }),
    );
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]![0]).toMatchObject({
      tierId: TIER_ID,
      priceCents: 1234,
    });
  });
});
