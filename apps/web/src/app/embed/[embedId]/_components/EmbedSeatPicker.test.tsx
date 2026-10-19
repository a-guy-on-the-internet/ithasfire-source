import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Re-opened with seats already picked, the seat picker's Confirm must wait
 * for the seat data: confirming before it loaded stored the seats with no
 * shown prices, so a $50 override seat read at the tier and was charged
 * unquoted (seat-price-overrides D-007).
 */

const { seatsQuery } = vi.hoisted(() => ({
  seatsQuery: {
    current: { data: undefined, isLoading: true, error: null } as {
      data: unknown;
      isLoading: boolean;
      error: unknown;
    },
  },
}));

vi.mock("@th/ui", () => ({
  Spinner: () => <span />,
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/trpc", () => ({
  trpc: {
    embeds: {
      listAvailableSeats: { useQuery: () => seatsQuery.current },
      getEventDetail: { useQuery: () => ({ data: undefined }) },
    },
    events: {
      getCheckoutFeeRates: { useQuery: () => ({ data: undefined }) },
    },
  },
}));

import { EmbedSeatPicker } from "./EmbedSeatPicker";

const SEATS = [
  {
    id: "s1",
    seatSectionId: "sec-a",
    label: "A1",
    row: "A",
    number: 1,
    status: "AVAILABLE",
    priceOverride: { priceCents: 5000, buyerTotalCents: 5600 },
  },
];

function renderPicker(onConfirm = vi.fn()) {
  render(
    <EmbedSeatPicker
      embedId="embed-1"
      eventId="event-1"
      seatSectionId="sec-a"
      seatSectionName="Orchestra"
      ticketTypeId="tt-res"
      selectedSeatIds={["s1"]}
      onConfirm={onConfirm}
      onBack={() => {}}
    />,
  );
  return {
    onConfirm,
    confirm: () => screen.getByRole("button", { name: /confirm 1 seat/i }),
  };
}

afterEach(() => cleanup());

describe("EmbedSeatPicker — Confirm waits for the seat data", () => {
  it("regression: re-opened with a picked seat, Confirm is disabled until the seats load", () => {
    seatsQuery.current = { data: undefined, isLoading: true, error: null };
    const { confirm, onConfirm } = renderPicker();
    expect(confirm()).toBeDisabled();
    fireEvent.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("once loaded, Confirm hands back the picked seats with the data they were shown from", () => {
    seatsQuery.current = {
      data: { seats: SEATS },
      isLoading: false,
      error: null,
    };
    const { confirm, onConfirm } = renderPicker();
    expect(confirm()).toBeEnabled();
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith(["s1"], SEATS);
  });

  it("a failed seat read keeps Confirm disabled", () => {
    seatsQuery.current = {
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
    };
    const { confirm } = renderPicker();
    expect(confirm()).toBeDisabled();
  });
});
