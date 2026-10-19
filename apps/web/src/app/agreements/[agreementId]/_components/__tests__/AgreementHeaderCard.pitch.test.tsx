import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Pitch-provenance marking on the agreement header (see
 * `PitchProvenanceMarker.tsx`). What is pinned here:
 *
 *  - a seeded field carries the marker, and the marker is ASSOCIATED with the
 *    control via `aria-describedby` (a marker a screen reader can't reach is
 *    the whole failure mode this feature has to avoid);
 *  - a field the venue has changed — server-side (`false`) or locally, before
 *    the save round-trip — carries nothing;
 *  - `pitchProvenance: null` (an agreement with no originating request)
 *    renders no marker anywhere and leaves the guarantee hint untouched;
 *  - the money field additionally swaps its hint for the pitch sentence.
 *
 * The design system is mocked away here, so this proves WIRING, not looks —
 * layout/contrast were checked in the browser.
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

/** The id `aria-describedby` must resolve to, and the text it announces. */
function describedTexts(control: HTMLElement, container: HTMLElement) {
  const ids = (control.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  return ids.map((id) => {
    const el = container.querySelector(`#${CSS.escape(id)}`);
    if (!el) throw new Error(`aria-describedby points at missing id "${id}"`);
    return el.textContent ?? "";
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe("AgreementHeaderCard — pitch provenance", () => {
  it("marks every seeded field and associates the marker with its control", () => {
    const { container } = renderCard();

    for (const id of [
      "ba-pitch-date",
      "ba-pitch-end-date",
      "ba-pitch-guarantee",
      "ba-pitch-description",
    ]) {
      expect(screen.getByTestId(id)).toHaveTextContent(
        "admin.baPitchFromRequest",
      );
    }

    // The association is the load-bearing part: each control's
    // `aria-describedby` must actually resolve to the marker's text.
    expect(
      describedTexts(screen.getByTestId("ba-header-date"), container),
    ).toEqual(["admin.baPitchFromRequest"]);
    expect(
      describedTexts(screen.getByTestId("ba-header-end-date"), container),
    ).toEqual(["admin.baPitchFromRequest"]);
    expect(
      describedTexts(
        screen.getByTestId("ba-header-description-textarea"),
        container,
      ),
    ).toEqual(["admin.baPitchFromRequest"]);

    // Money carries the most weight: marker FIRST, then the pitch-specific
    // hint that replaces the generic "what a guarantee is" line.
    expect(
      describedTexts(screen.getByTestId("ba-header-guarantee"), container),
    ).toEqual(["admin.baPitchFromRequest", "admin.baPitchGuaranteeHint"]);
    expect(screen.getByTestId("ba-pitch-guarantee-hint")).toBeInTheDocument();
    expect(screen.queryByText("admin.baGuaranteeHint")).toBeNull();
  });

  it("labels the notes textarea so the description marker has something to describe", () => {
    renderCard();
    const textarea = screen.getByTestId("ba-header-description-textarea");
    expect(textarea.id).toBeTruthy();
    const label = document.querySelector(`label[for="${textarea.id}"]`);
    expect(label).toHaveTextContent("admin.baDescriptionLabel");
  });

  it("renders nothing anywhere when pitchProvenance is null", () => {
    const { container } = renderCard({ pitchProvenance: null });

    expect(screen.queryByText("admin.baPitchFromRequest")).toBeNull();
    expect(screen.queryByText("admin.baPitchGuaranteeHint")).toBeNull();
    for (const id of [
      "ba-pitch-date",
      "ba-pitch-end-date",
      "ba-pitch-guarantee",
      "ba-pitch-description",
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }

    // The guarantee keeps exactly its pre-existing description — no empty slot
    // and no dangling id.
    expect(
      describedTexts(screen.getByTestId("ba-header-guarantee"), container),
    ).toEqual(["admin.baGuaranteeHint"]);
    expect(
      screen.getByTestId("ba-header-date").getAttribute("aria-describedby"),
    ).toBeNull();
  });

  it("omits the marker on a field the venue has already changed (flag false)", () => {
    const { container } = renderCard({
      pitchProvenance: { ...ALL_SEEDED, guaranteeCents: false },
    });

    expect(screen.queryByTestId("ba-pitch-guarantee")).toBeNull();
    expect(screen.getByTestId("ba-pitch-date")).toBeInTheDocument();
    expect(
      describedTexts(screen.getByTestId("ba-header-guarantee"), container),
    ).toEqual(["admin.baGuaranteeHint"]);
  });

  it("drops the marker as soon as the field is edited, before any save", () => {
    const { container } = renderCard();
    const guarantee = screen.getByTestId("ba-header-guarantee");

    expect(screen.getByTestId("ba-pitch-guarantee")).toBeInTheDocument();
    fireEvent.change(guarantee, { target: { value: "700.00" } });

    expect(screen.queryByTestId("ba-pitch-guarantee")).toBeNull();
    expect(describedTexts(guarantee, container)).toEqual([
      "admin.baGuaranteeHint",
    ]);
    // Untouched siblings keep theirs.
    expect(screen.getByTestId("ba-pitch-date")).toBeInTheDocument();
  });

  it("drops the marker while the guarantee holds unparseable text", () => {
    renderCard();
    fireEvent.change(screen.getByTestId("ba-header-guarantee"), {
      target: { value: "5oo" },
    });
    expect(screen.queryByTestId("ba-pitch-guarantee")).toBeNull();
  });

  it("renders no inputs and no save button when the viewer may not edit terms (act side)", () => {
    renderCard({ mayEdit: false });

    for (const id of [
      "ba-header-title",
      "ba-header-date",
      "ba-header-end-date",
      "ba-header-guarantee",
      "ba-header-description-textarea",
      "ba-header-save",
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(document.querySelector("input, textarea")).toBeNull();
    // The values are still readable as text.
    expect(screen.getByText(/Set length: 45 minutes/)).toBeInTheDocument();
  });

  it("marks the read-only rendering too, beside the label", () => {
    renderCard({ mayEdit: false });

    const marker = screen.getByTestId("ba-pitch-guarantee");
    expect(marker).toHaveTextContent("admin.baPitchFromRequest");
    // No control to describe in read-only, so no dangling association.
    expect(marker.querySelector("[id]")).toBeNull();

    const labelRow = marker.parentElement as HTMLElement;
    expect(within(labelRow).getByText("admin.baGuaranteeLabel")).toBeTruthy();
  });
});

describe("AgreementHeaderCard — a guarantee The deal sets", () => {
  it("shows the deal's guarantee read-only, says where it comes from, and links to The deal", () => {
    renderCard({ guaranteeFromDeal: true });

    expect(screen.queryByTestId("ba-header-guarantee")).toBeNull();
    expect(screen.getByTestId("ba-header-guarantee-deal")).toHaveTextContent(
      "$500",
    );
    expect(screen.getByText("admin.baGuaranteeFromDeal")).toBeTruthy();
    expect(
      screen.getByTestId("ba-header-guarantee-deal-link").getAttribute("href"),
    ).toBe("#the-deal");
    // The request's pitch marker belongs to a typed guarantee, not The deal's.
    expect(screen.queryByTestId("ba-pitch-guarantee")).toBeNull();
  });

  it("never sends guaranteeCents with a header save", () => {
    h.mutate.mockClear();
    renderCard({ guaranteeFromDeal: true });

    fireEvent.change(screen.getByTestId("ba-header-title"), {
      target: { value: "A new title" },
    });
    fireEvent.click(screen.getByTestId("ba-header-save"));

    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate.mock.calls[0]![0]).not.toHaveProperty("guaranteeCents");
  });

  it("turns a guarantee_set_by_deal refusal into a plain warning and a refetch", () => {
    h.mutate.mockReset();
    h.toastWarning.mockClear();
    const onRefresh = vi.fn();
    const onActionError = vi.fn();
    renderCard({ onRefresh, onActionError });

    fireEvent.change(screen.getByTestId("ba-header-guarantee"), {
      target: { value: "650" },
    });
    fireEvent.click(screen.getByTestId("ba-header-save"));
    const { onError } = h.mutate.mock.calls[0]![1] as {
      onError: (e: unknown) => void;
    };
    // A TRPCClientError as the router sends it (data.appCode + data.meta).
    onError({
      message: "AGREEMENT_NOT_EDITABLE",
      data: {
        appCode: "AGREEMENT_NOT_EDITABLE",
        meta: { reason: "guarantee_set_by_deal" },
      },
    });

    expect(h.toastWarning).toHaveBeenCalledWith(
      expect.objectContaining({ title: "admin.baGuaranteeSetByDeal" }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onActionError).not.toHaveBeenCalled();
  });
});
