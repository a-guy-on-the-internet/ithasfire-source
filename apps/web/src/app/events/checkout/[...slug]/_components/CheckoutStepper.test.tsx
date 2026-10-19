import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CheckoutStepper } from "./CheckoutStepper";

// ICU-aware for the two keys that interpolate; everything else returns the key
// so copy assertions stay key-stable.
vi.mock("@th/ui", () => ({
  useTranslations:
    () =>
    (key: string, vals?: Record<string, unknown>): string => {
      if (key === "checkout.stepProgress")
        return `Step ${String(vals?.current)} of ${String(vals?.total)}`;
      if (key === "checkout.stepGoBack")
        return `Go back to ${String(vals?.step)}`;
      if (key === "checkout.stepperProgressLabel")
        return `[label] ${String(vals?.current)}/${String(vals?.total)}`;
      if (key === "checkout.stepperProgressValue")
        return `[value] ${String(vals?.current)}/${String(vals?.total)} ${String(vals?.step)}`;
      return key;
    },
}));

const stepEl = (id: string) => screen.getByTestId(`checkout-step-${id}`);

describe("CheckoutStepper", () => {
  it("fills the current step and leaves the rest un-filled", () => {
    render(
      <CheckoutStepper currentStepId="payment" completedStepIds={[]} />,
    );

    // The current marker is the only one carrying the ink fill. `background`
    // is the thing that makes it the loudest mark in the row — a weight-only
    // difference is what made the old strip read as decoration.
    const current = stepEl("payment").querySelector("span");
    expect(current?.style.background).toContain("--color");
    expect(stepEl("payment")).toHaveAttribute("data-current", "true");

    const remaining = stepEl("confirmed").querySelector("span");
    expect(remaining?.style.background).toBe("transparent");
    expect(stepEl("confirmed")).not.toHaveAttribute("data-current");
    // The current step is announced by the progressbar, not by an
    // `aria-current` on a marker whose only content is aria-hidden.
    expect(stepEl("payment")).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "[value] 3/4 checkout.stepPayment",
    );
  });

  it("makes completed steps buttons and leaves remaining ones inert", () => {
    render(
      <CheckoutStepper
        currentStepId="payment"
        completedStepIds={["tickets", "details"]}
        onStepClick={vi.fn()}
      />,
    );

    expect(stepEl("tickets").tagName).toBe("BUTTON");
    expect(stepEl("details").tagName).toBe("BUTTON");
    // The step you are ON is not a way back to itself.
    expect(stepEl("payment").tagName).not.toBe("BUTTON");
    // Nor is one you have not reached.
    expect(stepEl("confirmed").tagName).not.toBe("BUTTON");
  });

  it("names the way back for a screen reader", () => {
    render(
      <CheckoutStepper
        currentStepId="details"
        completedStepIds={["tickets"]}
        onStepClick={vi.fn()}
      />,
    );

    expect(stepEl("tickets")).toHaveAttribute(
      "aria-label",
      "Go back to checkout.stepTickets",
    );
  });

  it("calls back with the step that was tapped", () => {
    const onStepClick = vi.fn();
    render(
      <CheckoutStepper
        currentStepId="payment"
        completedStepIds={["tickets", "details"]}
        onStepClick={onStepClick}
      />,
    );

    fireEvent.click(stepEl("tickets"));
    expect(onStepClick).toHaveBeenCalledWith("tickets");
  });

  it("regression: once payment is confirming or confirmed, no step is a way back (it released a PAID order's hold)", () => {
    const onStepClick = vi.fn();
    render(
      <CheckoutStepper
        currentStepId="confirmed"
        completedStepIds={["tickets", "details", "payment"]}
        onStepClick={onStepClick}
        backNavigationLocked
      />,
    );
    for (const id of ["tickets", "details", "payment"]) {
      expect(stepEl(id).tagName).not.toBe("BUTTON");
    }
    fireEvent.click(stepEl("tickets"));
    expect(onStepClick).not.toHaveBeenCalled();
  });

  it("does nothing when a completed step has no handler", () => {
    render(
      <CheckoutStepper currentStepId="payment" completedStepIds={["tickets"]} />,
    );
    // No handler → no button → nothing to tap. Guards against a marker that
    // looks tappable and is not.
    expect(stepEl("tickets").tagName).not.toBe("BUTTON");
  });

  it("states the count and names only the current step", () => {
    render(
      <CheckoutStepper currentStepId="payment" completedStepIds={["tickets"]} />,
    );

    expect(screen.getByText("Step 3 of 4")).toBeInTheDocument();
    expect(screen.getByText("checkout.stepPayment")).toBeInTheDocument();
    // The other three names are deliberately absent: four labels do not fit
    // 320px, and shrinking them below the smallest rung is what the rebuild
    // removed.
    expect(screen.queryByText("checkout.stepConfirmed")).toBeNull();
  });

  it("exposes progress to assistive tech", () => {
    render(
      <CheckoutStepper currentStepId="details" completedStepIds={["tickets"]} />,
    );

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemin", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "4");
  });

  it("regression: the way back is reachable by role and name — not inside the progressbar, whose children are presentational", () => {
    render(
      <CheckoutStepper
        currentStepId="details"
        completedStepIds={["tickets"]}
        onStepClick={vi.fn()}
      />,
    );

    const back = screen.getByRole("button", {
      name: "Go back to checkout.stepTickets",
    });
    expect(back).toBe(stepEl("tickets"));
    // `progressbar` makes its subtree presentational: a button inside it is
    // absent from the a11y tree (jsdom's role query does not model that, so
    // assert the structure the real tree depends on).
    expect(back.closest('[role="progressbar"]')).toBeNull();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "[value] 2/4 checkout.stepDetails",
    );
  });

  it("the default progress label and value text come from the catalog (the embed uses the default)", () => {
    render(
      <CheckoutStepper currentStepId="details" completedStepIds={["tickets"]} />,
    );
    const bar = screen.getByRole("progressbar", { name: "[label] 2/4" });
    expect(bar).toHaveAttribute("aria-valuetext", "[value] 2/4 checkout.stepDetails");
  });

  it("a bank payment still processing: step 4 reads 'Payment processing', not 'Confirmed'", () => {
    render(
      <CheckoutStepper
        currentStepId="confirmed"
        completedStepIds={["tickets", "details", "payment"]}
        payment="processing"
      />,
    );
    expect(screen.getByText("checkout.stepPaymentProcessing")).toBeInTheDocument();
    expect(screen.queryByText("checkout.stepConfirmed")).toBeNull();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "[value] 4/4 checkout.stepPaymentProcessing",
    );
  });

  it("nothing says the money moved: step 4 reads 'Not confirmed', never 'Confirmed'", () => {
    render(
      <CheckoutStepper
        currentStepId="confirmed"
        completedStepIds={["tickets", "details", "payment"]}
        payment="unknown"
      />,
    );
    expect(screen.getByText("checkout.stepPaymentUnconfirmed")).toBeInTheDocument();
    expect(screen.queryByText("checkout.stepConfirmed")).toBeNull();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "[value] 4/4 checkout.stepPaymentUnconfirmed",
    );
  });

  it("a restored confirmation still being read: step 4 reads 'Checking payment', neither Confirmed nor Not confirmed", () => {
    render(
      <CheckoutStepper
        currentStepId="confirmed"
        completedStepIds={["tickets", "details", "payment"]}
        payment="checking"
      />,
    );
    expect(screen.getByText("checkout.stepPaymentChecking")).toBeInTheDocument();
    expect(screen.queryByText("checkout.stepConfirmed")).toBeNull();
    expect(screen.queryByText("checkout.stepPaymentUnconfirmed")).toBeNull();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "[value] 4/4 checkout.stepPaymentChecking",
    );
  });

  it.each(["paid", undefined] as const)(
    "payment %s: step 4 still reads 'Confirmed'",
    (payment) => {
      render(
        <CheckoutStepper
          currentStepId="confirmed"
          completedStepIds={["tickets", "details", "payment"]}
          payment={payment}
        />,
      );
      expect(screen.getByText("checkout.stepConfirmed")).toBeInTheDocument();
    },
  );
});
