import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProvider } from "../../../../../test/utils";

import { Stepper, type StepperStepDefinition } from "../navigation/Stepper";

describe("Stepper a11y", () => {
  it("lets keyboard users activate a step on web", async () => {
    const user = userEvent.setup();
    const onStepPress = vi.fn();

    const steps: StepperStepDefinition[] = [
      { id: "one", title: "Step one" },
      { id: "two", title: "Step two" },
    ];

    renderWithProvider(
      <Stepper
        steps={steps}
        currentStepId="one"
        onStepPress={onStepPress}
        qaId="stepper"
      />,
    );

    const stepTwo = screen.getByTestId("stepper-step-two");

    expect(stepTwo).toHaveAttribute("role", "button");
    expect(stepTwo).toHaveAttribute("tabindex", "0");

    stepTwo.focus();
    await user.keyboard("{Enter}");
    expect(onStepPress).toHaveBeenCalledWith("two");

    await user.keyboard(" ");
    expect(onStepPress).toHaveBeenLastCalledWith("two");
  });

  it("marks the current step with aria-current=step", () => {
    const steps: StepperStepDefinition[] = [
      { id: "one", title: "Step one" },
      { id: "two", title: "Step two" },
    ];

    renderWithProvider(
      <Stepper steps={steps} currentStepId="two" qaId="stepper" />,
    );
    expect(screen.getByTestId("stepper-step-two")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("does not allow focusing disabled steps", async () => {
    const user = userEvent.setup();
    const onStepPress = vi.fn();

    const steps: StepperStepDefinition[] = [
      { id: "one", title: "Step one" },
      { id: "two", title: "Step two", disabled: true },
    ];

    renderWithProvider(
      <Stepper
        steps={steps}
        currentStepId="one"
        onStepPress={onStepPress}
        qaId="stepper"
      />,
    );

    const stepTwo = screen.getByTestId("stepper-step-two");
    expect(stepTwo).not.toHaveAttribute("tabindex");

    // Should not receive focus via .focus() if it's not focusable (no tabIndex)
    stepTwo.focus();
    await user.keyboard("{Enter}");

    expect(onStepPress).not.toHaveBeenCalled();
  });
});
