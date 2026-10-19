import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A gated event in the widget (owner ruling 2026-10-12, "Card + button to
 * apply"): title, date and hero, plus ONE link that opens the event on Ithas
 * Fire in a new tab. No tiers, no prices, no checkout, and the fee rates the
 * server refuses for it (403, which left "Calculating total…" up for good)
 * are never asked for.
 */

const ids = vi.hoisted(() => ({
  EVENT: "8c73f54c-0000-4000-8000-000000000001",
}));

const state = vi.hoisted(() => ({
  detail: undefined as unknown,
  feeRateOptions: [] as Array<{ enabled?: boolean }>,
}));

const gatedDetail = (
  gateType: "APPLICATION" | "PASSWORD",
  salesClosed = false,
) => ({
  event: {
    id: ids.EVENT,
    title: "Exclusive Masterclass Workshop",
    slug: "exclusive-masterclass-workshop",
    startsAt: new Date("2026-11-01T23:00:00Z"),
    endsAt: null,
    timezone: "America/Chicago",
    currency: "usd",
    heroImageUrl: "https://cdn.test/hero.jpg",
    addressText: null,
    locality: null,
    region: null,
    locationLabel: null,
    locationCoords: null,
    waitlistStatus: "DISABLED",
    waitlistDescription: null,
    gateType,
  },
  ticketTypes: [],
  salesClosed,
  body: null,
  imageMap: {},
  eventHumans: [],
  tags: [],
});

vi.mock("@/trpc", () => ({
  trpc: {
    embeds: {
      getEventDetail: {
        useQuery: () => ({ isLoading: false, data: state.detail }),
      },
    },
    events: {
      getCheckoutFeeRates: {
        useQuery: (_input: unknown, options: { enabled?: boolean }) => {
          state.feeRateOptions.push(options);
          return { data: undefined, refetch: vi.fn() };
        },
      },
    },
  },
}));
vi.mock("@th/ui", () => ({
  Spinner: () => <span />,
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}));
vi.mock("@/lib/embed-host-origin", () => ({
  getEmbedHostOrigin: () => "https://host.test",
}));
vi.mock("@/app/events/[...slug]/_components/EventDetail", () => ({
  EventDetail: () => <div data-testid="shared-event-detail" />,
}));
vi.mock("@/app/events/checkout/[...slug]/_components/CheckoutStepper", () => ({
  CheckoutStepper: () => <div data-testid="checkout-stepper" />,
}));
vi.mock("./EmbedSeatPicker", () => ({ EmbedSeatPicker: () => null }));
vi.mock("./EmbedSeriesDateSwitcher", () => ({
  EmbedSeriesDateSwitcher: () => <div data-testid="series-switcher" />,
}));
vi.mock("./EmbedTicketTypeList", () => ({
  EmbedTicketTypeList: () => <div data-testid="ticket-type-list" />,
}));
vi.mock("./EmbedMobileCTABar", () => ({
  EmbedMobileCTABar: () => <div data-testid="mobile-cta-bar" />,
}));
vi.mock("./useIsFramed", () => ({ useIsFramed: () => false }));

import { EmbedEventDetail } from "./EmbedEventDetail";
import type { CartItem, EmbedGateType } from "./embed-types";

beforeEach(() => {
  state.detail = undefined;
  state.feeRateOptions = [];
});

function renderDetail({
  cart = [],
  linkOut = false,
  gateTypeHint,
}: {
  cart?: CartItem[];
  linkOut?: boolean;
  gateTypeHint?: EmbedGateType;
} = {}) {
  return render(
    <EmbedEventDetail
      embedId="embed-1"
      eventId={ids.EVENT}
      cart={cart}
      onCartChange={() => {}}
      onBack={() => {}}
      onContinueToCheckout={() => {}}
      onSelectDate={() => {}}
      stepperStepId="tickets"
      completedStepIds={[]}
      linkOut={linkOut}
      buildEventUrl={(slugOrId) => `https://ithasfire.test/events/${slugOrId}`}
      gateTypeHint={gateTypeHint}
    />,
  );
}

describe("EmbedEventDetail — gated event", () => {
  it("APPLICATION: the card shows date and hero, and one link to apply on Ithas Fire in a new tab", () => {
    state.detail = gatedDetail("APPLICATION");
    renderDetail();

    expect(screen.getByTestId("embed-gated-event")).toBeInTheDocument();
    expect(screen.getByTestId("embed-gated-event-badge").textContent).toBe(
      "eventCard.gateApplication",
    );
    const cta = screen.getByTestId("embed-gated-event-cta");
    expect(cta.textContent).toBe("embed.gatedApplyCta");
    expect(cta.getAttribute("href")).toBe(
      "https://ithasfire.test/events/exclusive-masterclass-workshop",
    );
    expect(cta.getAttribute("target")).toBe("_blank");
    expect(cta.getAttribute("rel")).toBe("noopener noreferrer");
    expect(cta.getAttribute("aria-label")).toBe(
      "embed.gatedCtaAria:embed.gatedApplyCta",
    );
    expect(screen.getByText("embed.gatedOpensInNewTab")).toBeInTheDocument();
    // The date, on the event's own clock: 23:00Z is 5:00 PM in Chicago on
    // Nov 1 2026 (CST), never the test machine's zone.
    expect(screen.getByText(/November 1, 2026.*5:00\s?PM/)).toBeInTheDocument();
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.test/hero.jpg",
    );
    // Exactly one way forward.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("PASSWORD: the link says it is for entering the password", () => {
    state.detail = gatedDetail("PASSWORD");
    renderDetail();
    expect(screen.getByTestId("embed-gated-event-badge").textContent).toBe(
      "eventCard.gatePassword",
    );
    expect(screen.getByTestId("embed-gated-event-cta").textContent).toBe(
      "embed.gatedPasswordCta",
    );
  });

  it("mounts no tiers, checkout, stepper or Buy CTA, and never asks for fee rates", () => {
    state.detail = gatedDetail("APPLICATION");
    // A cart left over must not bring Continue back.
    renderDetail({ cart: [{ ticketTypeId: "tt-x", qty: 2 }] });

    expect(screen.queryByTestId("ticket-type-list")).toBeNull();
    expect(screen.queryByTestId("checkout-stepper")).toBeNull();
    expect(screen.queryByTestId("shared-event-detail")).toBeNull();
    expect(screen.queryByTestId("series-switcher")).toBeNull();
    expect(screen.queryByTestId("mobile-cta-bar")).toBeNull();
    expect(screen.queryByText("Continue")).toBeNull();
    expect(screen.queryByText("checkout.calculatingTotal")).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();

    expect(state.feeRateOptions.length).toBeGreaterThan(0);
    expect(state.feeRateOptions.every((o) => o.enabled === false)).toBe(true);
  });

  it("wins over link-out mode: one gate link, not 'Get tickets'", () => {
    state.detail = gatedDetail("PASSWORD");
    renderDetail({ linkOut: true });
    expect(screen.queryByText("checkout.getTicketsOnHearthfire")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("sales closed: the card keeps date and hero, drops the link, and the closed notice shows", () => {
    state.detail = gatedDetail("APPLICATION", true);
    renderDetail();
    expect(screen.getByTestId("embed-gated-event")).toBeInTheDocument();
    expect(screen.queryByTestId("embed-gated-event-cta")).toBeNull();
    expect(screen.getByText("Ticket sales have closed")).toBeInTheDocument();
  });

  it("while the detail loads, a gated hint keeps the fee-rate query off", () => {
    state.detail = undefined;
    renderDetail({ gateTypeHint: "APPLICATION" });
    expect(state.feeRateOptions.every((o) => o.enabled === false)).toBe(true);
  });

  it("an ungated hint asks for fee rates beside the detail read", () => {
    state.detail = undefined;
    renderDetail({ gateTypeHint: "NONE" });
    expect(state.feeRateOptions.at(-1)?.enabled).toBe(true);
  });

  it("an ungated event keeps the tiers and asks for fee rates", () => {
    state.detail = {
      ...gatedDetail("APPLICATION"),
      event: { ...gatedDetail("APPLICATION").event, gateType: "NONE" },
    };
    renderDetail();
    expect(screen.queryByTestId("embed-gated-event")).toBeNull();
    expect(screen.getByTestId("ticket-type-list")).toBeInTheDocument();
    expect(state.feeRateOptions.at(-1)?.enabled).toBe(true);
  });
});
