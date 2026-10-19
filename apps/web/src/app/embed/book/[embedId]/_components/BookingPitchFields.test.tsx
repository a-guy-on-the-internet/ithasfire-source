import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BookingPitchFields } from "./BookingPitchFields";
import {
  EMPTY_PITCH_VALUES,
  type EmbedPitchError,
  type EmbedPitchValues,
} from "./booking-widget-helpers";

/** Stateful harness so field edits and the details toggle behave like the real forms. */
function Harness({
  error = null,
  requireActName = true,
}: {
  error?: EmbedPitchError | null;
  requireActName?: boolean;
}) {
  const [values, setValues] = useState<EmbedPitchValues>(EMPTY_PITCH_VALUES);
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <BookingPitchFields
      idBase="t"
      values={values}
      onChange={(field, value) =>
        setValues((prev) => ({ ...prev, [field]: value }))
      }
      requireActName={requireActName}
      error={error}
      disabled={false}
      detailsOpen={detailsOpen}
      onDetailsOpenChange={setDetailsOpen}
    />
  );
}

describe("BookingPitchFields", () => {
  it("renders the required trio and hides the optional details by default", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Act or band name")).toBeTruthy();
    expect(screen.getByLabelText("Preferred date 1")).toBeTruthy();
    expect(screen.getByLabelText("Your pitch")).toBeTruthy();
    // Collapsed: optional fields not in the DOM.
    expect(screen.queryByLabelText("Genre")).toBeNull();
    expect(
      screen.getByRole("button", { name: /more details/i }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("marks the act name optional for signed-in senders", () => {
    render(<Harness requireActName={false} />);
    expect(screen.getByLabelText(/act or band name · optional/i)).toBeTruthy();
  });

  it("expands the details section with the optional fields", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /more details/i }));
    expect(screen.getByLabelText("Genre")).toBeTruthy();
    expect(screen.getByLabelText("Set length")).toBeTruthy();
    expect(screen.getByLabelText("Tech or backline needs")).toBeTruthy();
    expect(screen.getByLabelText("Music link")).toBeTruthy();
  });

  it("caps preferred dates at three", () => {
    render(<Harness />);
    const add = () =>
      fireEvent.click(screen.getByRole("button", { name: /add another date/i }));
    add();
    add();
    expect(screen.getByLabelText("Preferred date 3")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /add another date/i }),
    ).toBeNull();
  });

  it("only shows the fee amount for a paying fee type", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /more details/i }));
    expect(screen.queryByLabelText(/amount · usd/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Fee ask"), {
      target: { value: "GUARANTEE" },
    });
    expect(screen.getByLabelText(/amount · usd/i)).toBeTruthy();
  });

  it("wires an inline error to its field via aria-describedby", () => {
    render(
      <Harness
        error={{ field: "message", message: "Your pitch needs at least 10 characters." }}
      />,
    );
    const textarea = screen.getByLabelText("Your pitch");
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    const describedBy = textarea.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const errorNode = document.getElementById(describedBy!);
    expect(errorNode?.textContent).toMatch(/at least 10 characters/i);
  });
});
