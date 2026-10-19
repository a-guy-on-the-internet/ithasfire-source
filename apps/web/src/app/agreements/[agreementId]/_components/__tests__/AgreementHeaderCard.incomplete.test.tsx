import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * A half-typed proposed date must block the save. Chrome reports "" while some
 * segments are blank, which unguarded saved `proposedDate: null`: clearing one
 * segment of a set date erased the date. Mocks are copied from
 * `AgreementHeaderCard.pitch.test.tsx`.
 */

// ── Minimal DOM stand-ins (pattern: CreateEventOutcomeNotice.test.tsx) ───────
const KEEP = (k: string) =>
  k === "id" || k === "role" || k === "disabled" || k.startsWith("aria-");

function domProps(rest: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (KEEP(k)) safe[k] = v;
    else if (k === "testID" || k === "testId") safe["data-testid"] = v;
  }
  return safe;
}

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  useFormatters: () => ({
    dateTime: (d: Date) => d.toISOString(),
    currency: (v: number) => `$${v}`,
  }),
  useNotify: () => ({
    toast: {
      success: vi.fn(),
      danger: vi.fn(),
      warning: h.toastWarning,
      info: vi.fn(),
    },
  }),
  Spinner: () => <span data-testid="spinner" />,
  Button: ({ children, onPress, ...rest }: any) => (
    <button onClick={onPress} {...domProps(rest)}>
      {children}
    </button>
  ),
  // `tag`/`htmlFor` are honoured (the real Text forwards both to Tamagui's
  // Paragraph) so label→control association stays visible to the test.
  Text: ({ children, tag, htmlFor, ...rest }: any) =>
    tag === "label" ? (
      <label htmlFor={htmlFor} {...domProps(rest)}>
        {children}
      </label>
    ) : (
      <span {...domProps(rest)}>{children}</span>
    ),
  TextInput: ({ value, onChangeText, ...rest }: any) => (
    <input
      value={value}
      onChange={(e) => onChangeText?.(e.target.value)}
      {...domProps(rest)}
    />
  ),
  CharCountTextarea: ({
    value,
    onChange,
    ariaDescribedBy,
    id,
    testIdBase,
  }: any) => (
    <textarea
      id={id}
      value={value}
      aria-describedby={ariaDescribedBy}
      data-testid={testIdBase ? `${testIdBase}-textarea` : undefined}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

vi.mock("tamagui", () => {
  const passthrough = () => (props: any) => {
    const { children, ...rest } = props;
    return <div {...domProps(rest)}>{children}</div>;
  };
  return { XStack: passthrough(), YStack: passthrough() };
});

vi.mock("lucide-react", () => {
  const icon = () => <span aria-hidden="true" />;
  return { ExternalLink: icon, MapPin: icon, Save: icon, Users: icon };
});

vi.mock("@/trpc", () => ({
  trpc: {
    bookingAgreements: {
      updateHeader: {
        useMutation: () => ({ mutate: h.mutate, isPending: false }),
      },
    },
  },
}));

import { AgreementHeaderCard } from "../AgreementHeaderCard";

// ── Fixtures ────────────────────────────────────────────────────────────────
const AGREEMENT = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "BOOKING",
  status: "DRAFT" as const,
  proposerType: "organization" as const,
  proposerId: "22222222-2222-4222-8222-222222222222",
  proposerDisplayName: "The Velvet Room",
  counterpartyType: "human" as const,
  counterpartyId: "33333333-3333-4333-8333-333333333333",
  counterpartyDisplayName: "Nyx Quartet",
  placeId: "44444444-4444-4444-8444-444444444444",
  eventId: null,
  payoutTermsId: "55555555-5555-4555-8555-555555555555",
  title: "Nyx Quartet at The Velvet Room",
  description: "From the booking request:\n\n- Set length: 45 minutes",
  proposedDate: new Date("2026-09-15T00:00:00.000Z"),
  proposedEndDate: new Date("2026-09-15T00:45:00.000Z"),
  guaranteeCents: 50_000,
  proposedAt: null,
  acceptedAt: null,
  declinedAt: null,
  declinedReason: null,
  expiresAt: null,
  fulfilledAt: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

const ALL_SEEDED = {
  proposedDate: true,
  proposedEndDate: true,
  guaranteeCents: true,
  description: true,
};

function renderCard(
  overrides: Partial<React.ComponentProps<typeof AgreementHeaderCard>> = {},
) {
  return render(
    <AgreementHeaderCard
      agreementId={AGREEMENT.id}
      agreement={AGREEMENT}
      bookingRequest={null}
      pitchProvenance={ALL_SEEDED}
      guaranteeFromDeal={false}
      dealAnchorId="the-deal"
      mayEdit
      placeName="The Velvet Room"
      onRefresh={vi.fn()}
      onActionError={vi.fn()}
      {...overrides}
    />,
  );
}

/** Chrome's half-typed state: `value` stays "" while `badInput` is true. */
function stubBadInput(el: HTMLInputElement, read: () => boolean) {
  Object.defineProperty(el, "validity", {
    configurable: true,
    get: () => ({ badInput: read() }),
  });
}

describe("AgreementHeaderCard — half-typed dates", () => {
  it("disables save and shows an alert while the proposed date is half-typed", () => {
    renderCard();
    const date = screen.getByTestId("ba-header-date") as HTMLInputElement;
    let bad = true;
    stubBadInput(date, () => bad);
    // Clearing one segment of a set date: Chrome reports "".
    fireEvent.change(date, { target: { value: "" } });

    // Typing: submit is gated but nothing is announced yet.
    expect(screen.getByTestId("ba-header-save")).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(date).not.toHaveAttribute("aria-invalid");
    fireEvent.blur(date);

    expect(screen.getByRole("alert").textContent).toBe(
      "common.dateTimeStartIncomplete",
    );
    expect(date).toHaveAttribute("aria-invalid", "true");
    expect(
      (date.getAttribute("aria-describedby") ?? "").split(" "),
    ).toContain(screen.getByRole("alert").id);
    const save = screen.getByTestId("ba-header-save");
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(h.mutate).not.toHaveBeenCalled();

    // The last segment lands: a full value (before the end) commits and save
    // comes back.
    bad = false;
    fireEvent.change(date, { target: { value: "2026-09-14T08:00" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("ba-header-save")).not.toBeDisabled();
  });

  it("disables save while the end date is half-typed", () => {
    renderCard();
    const end = screen.getByTestId("ba-header-end-date") as HTMLInputElement;
    stubBadInput(end, () => true);
    fireEvent.change(end, { target: { value: "" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(end);
    expect(screen.getByRole("alert").textContent).toBe(
      "common.dateTimeEndIncomplete",
    );
    expect(screen.getByTestId("ba-header-save")).toBeDisabled();
  });
});
