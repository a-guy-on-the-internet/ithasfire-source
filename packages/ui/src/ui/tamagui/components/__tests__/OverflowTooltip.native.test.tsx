import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// `OverflowTooltip.tsx` resolves `const isWeb = Platform.OS === "web"` at
// module-load time, so to exercise the NATIVE branch we must fix `Platform.OS`
// to a non-web value BEFORE the module loads. `vi.mock` is hoisted above the
// imports below, so every `react-native` consumer in this file's graph sees
// `OS: "ios"`. We keep the real (aliased jsdom stub) module otherwise.
vi.mock("react-native", async () => {
  const actual =
    await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    Platform: { ...actual.Platform, OS: "ios" },
  };
});

// Stub the `Text` primitive to a trivial element. This focuses the test on
// OverflowTooltip's own branching (native = a single truncated Text, no overlay,
// no Tooltip) and sidesteps needing a full `TamaguiProvider` — which, under
// `OS: "ios"`, would load the react-native animation driver + reanimated.
vi.mock("../typography/Text", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Text: ({
      children,
      truncate,
    }: {
      children?: React.ReactNode;
      truncate?: boolean;
    }) =>
      React.createElement(
        "span",
        { "data-truncate": truncate ? "true" : "false" },
        children,
      ),
  };
});

import { OverflowTooltip } from "../feedback/OverflowTooltip";

const ID_VALUE = "0f3c9a1e-8b2d-4c7a-9e51-7d6f2b4a1c88";

describe("OverflowTooltip (native)", () => {
  it("renders a single truncated Text with no measurement overlay or tooltip", () => {
    const { container, queryByRole } = render(
      <OverflowTooltip text={ID_VALUE} tooltipText={ID_VALUE} />,
    );

    // Full value renders on one truncated line...
    expect(container.textContent).toBe(ID_VALUE);
    expect(container.querySelector("[data-truncate='true']")).not.toBeNull();
    // ...and the native branch wires up NO web measurement container and NO
    // tooltip overlay.
    expect(container.querySelector("[data-overflowing]")).toBeNull();
    expect(queryByRole("tooltip")).toBeNull();
  });
});
