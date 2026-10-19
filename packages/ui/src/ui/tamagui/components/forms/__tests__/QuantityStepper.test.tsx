import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProvider } from "../../../../../../test/utils";
import { QuantityStepper } from "../QuantityStepper";

// Accessible-name composition: with two ticket types on one screen, bare
// "Increase"/"Decrease" buttons are ambiguous to screen-reader users — the
// per-button names must carry the ticket-type context.
describe("QuantityStepper accessible names", () => {
  it("composes ticket-type context into the button names from aria-label", () => {
    renderWithProvider(
      <QuantityStepper
        value={1}
        onStep={vi.fn()}
        aria-label="General Admission"
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Increase quantity — General Admission",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Decrease quantity — General Admission",
      }),
    ).toBeInTheDocument();
  });

  it("prefers explicit (translated) incrementLabel/decrementLabel", () => {
    renderWithProvider(
      <QuantityStepper
        value={1}
        onStep={vi.fn()}
        aria-label="VIP"
        incrementLabel="Aumentar cantidad — VIP"
        decrementLabel="Reducir cantidad — VIP"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Aumentar cantidad — VIP" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reducir cantidad — VIP" }),
    ).toBeInTheDocument();
  });

  it("falls back to bare labels only when no context exists", () => {
    renderWithProvider(<QuantityStepper value={0} onStep={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Increase" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrease" })).toBeInTheDocument();
  });

  it("keeps distinct names for two steppers side by side", () => {
    renderWithProvider(
      <>
        <QuantityStepper value={0} onStep={vi.fn()} aria-label="GA" />
        <QuantityStepper value={0} onStep={vi.fn()} aria-label="VIP" />
      </>,
    );

    const increases = screen.getAllByRole("button", { name: /^Increase/ });
    const names = increases.map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
  });
});
