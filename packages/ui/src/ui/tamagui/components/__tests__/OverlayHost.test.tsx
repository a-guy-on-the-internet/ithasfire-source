import { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProvider } from "../../../../../test/utils";
import { OverlayHost } from "../overlay/OverlayHost";
import { OverlayMount } from "../overlay/OverlayMount";

const OverlayToggle = () => {
  const [visible, setVisible] = useState(true);
  return (
    <OverlayHost>
      {visible ? (
        <OverlayMount id="hero">
          <div data-testid="overlay-child">Sign in</div>
        </OverlayMount>
      ) : null}
      <button type="button" onClick={() => setVisible(false)}>
        Hide
      </button>
    </OverlayHost>
  );
};

describe("OverlayHost", () => {
  it("renders overlay content above the host children", () => {
    renderWithProvider(
      <OverlayHost>
        <OverlayMount id="hero">
          <div data-testid="overlay-child">Hello overlay</div>
        </OverlayMount>
        <div data-testid="host-body">Body</div>
      </OverlayHost>,
    );

    expect(screen.getByTestId("overlay-child")).toBeInTheDocument();
    expect(screen.getByTestId("host-body")).toBeInTheDocument();
  });

  it("only renders the most recent overlay in single mode", () => {
    renderWithProvider(
      <OverlayHost>
        <OverlayMount id="alpha">
          <div data-testid="alpha">Alpha</div>
        </OverlayMount>
        <OverlayMount id="beta">
          <div data-testid="beta">Beta</div>
        </OverlayMount>
      </OverlayHost>,
    );

    expect(screen.queryByTestId("alpha")).not.toBeInTheDocument();
    expect(screen.getByTestId("beta")).toBeInTheDocument();
  });

  it("removes overlays when the mount unmounts", async () => {
    const user = userEvent.setup();
    renderWithProvider(<OverlayToggle />);

    expect(screen.getByTestId("overlay-child")).toBeInTheDocument();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Hide" }));
    });
    expect(screen.queryByTestId("overlay-child")).not.toBeInTheDocument();
  });

  it("enables pointer events when marked interactive", () => {
    renderWithProvider(
      <OverlayHost>
        <OverlayMount
          id="interactive"
          options={{ interactive: true, testID: "hero-overlay" }}
        >
          <div>Interactive</div>
        </OverlayMount>
      </OverlayHost>,
    );

    expect(screen.getByTestId("hero-overlay")).toHaveStyle({
      pointerEvents: "auto",
    });
  });
});
