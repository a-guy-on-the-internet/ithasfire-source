import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../../test/utils";
import { LabeledPasswordInput } from "../LabeledPasswordInput";
import { LabeledTextInput } from "../labeledtextinput";

/**
 * Field errors have to reach a screen reader, not just the eye.
 *
 * Both atoms already set `aria-invalid` (the auth flow passes it), so a
 * non-sighted reader was told the field was invalid and never told WHY: the
 * message rendered as a bare span with no id, no role, and nothing on the
 * input pointing at it. These lock the wiring, because every form in the
 * product renders through these two components.
 */
describe("labeled input helper text accessibility", () => {
  it("points the text input at its helper text and announces the error state", () => {
    renderWithProvider(
      <LabeledTextInput
        label="Email or username"
        id="email"
        placeholder="you@example.com"
        status="error"
        aria-invalid
        helperText="This field is required."
      />,
    );

    const input = screen.getByPlaceholderText("you@example.com");
    const helper = screen.getByRole("alert");

    expect(helper).toHaveTextContent("This field is required.");
    expect(helper.id).toBeTruthy();
    expect(input).toHaveAttribute("aria-describedby", helper.id);
  });

  it("does not make a non-error hint assertive, but still describes the input", () => {
    renderWithProvider(
      <LabeledTextInput
        label="Display name"
        id="display-name"
        placeholder="Ada"
        helperText="Shown on your public profile."
      />,
    );

    const input = screen.getByPlaceholderText("Ada");
    const helper = screen.getByText("Shown on your public profile.");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(input).toHaveAttribute("aria-describedby", helper.id);
  });

  it("leaves the input undescribed when there is no helper text", () => {
    renderWithProvider(
      <LabeledTextInput label="Email" id="bare" placeholder="Bare" />,
    );

    expect(screen.getByPlaceholderText("Bare")).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("wires the password input the same way", () => {
    renderWithProvider(
      <LabeledPasswordInput
        label="Password"
        id="password"
        placeholder="••••••••"
        status="error"
        aria-invalid
        helperText="Password is required."
      />,
    );

    const input = screen.getByPlaceholderText("••••••••");
    const helper = screen.getByRole("alert");

    expect(helper).toHaveTextContent("Password is required.");
    // The eye toggle carries its OWN `aria-describedby` (the visible/hidden
    // live region), so this asserts the id landed on the input rather than
    // anywhere in the subtree.
    expect(input).toHaveAttribute("aria-describedby", helper.id);
  });
});
