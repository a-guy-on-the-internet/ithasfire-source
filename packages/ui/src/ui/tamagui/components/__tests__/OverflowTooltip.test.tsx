import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderWithProvider } from "../../../../../test/utils";
// NOTE: `OverflowTooltip.tsx` resolves `const isWeb = Platform.OS === "web"` at
// module-load time, so the branch is fixed when this module is first imported.
// In the Vitest env `react-native` is aliased to a jsdom stub whose `Platform.OS`
// defaults to "web", so this static import exercises the WEB branch honestly —
// no runtime Platform spy is needed (and one would be a no-op here). The native
// branch is covered separately in `OverflowTooltip.native.test.tsx`, where
// `react-native` is mocked to a non-web `Platform.OS` before the module loads.
import { OverflowTooltip } from "../feedback/OverflowTooltip";

const ID_VALUE = "0f3c9a1e-8b2d-4c7a-9e51-7d6f2b4a1c88";

/**
 * Force `scrollWidth`/`clientWidth` on every HTMLElement so the overflow
 * measurement is deterministic in jsdom (which reports 0 for both).
 */
function mockClipping(scrollWidth: number, clientWidth: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return scrollWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return clientWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 20;
    },
  });
}

function restoreClipping() {
  for (const prop of ["scrollWidth", "clientWidth", "clientHeight"]) {
    if (Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)) {
      // biome-ignore lint/performance/noDelete: test-only cleanup of a mocked getter
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
        prop
      ];
    }
  }
}

describe("OverflowTooltip (web)", () => {
  afterEach(() => {
    restoreClipping();
  });

  it("renders the full text value", () => {
    mockClipping(50, 100);
    renderWithProvider(<OverflowTooltip text={ID_VALUE} />);

    expect(screen.getByText(ID_VALUE)).toBeInTheDocument();
  });

  it("does not offer a tooltip when the text is not clipped", async () => {
    mockClipping(50, 100);
    const { container } = renderWithProvider(<OverflowTooltip text="Doe" />);

    await waitFor(() => {
      expect(container.querySelector("[data-overflowing]")).toHaveAttribute(
        "data-overflowing",
        "false",
      );
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("marks the value as overflowing when it is clipped", async () => {
    mockClipping(240, 100);
    const { container } = renderWithProvider(
      <OverflowTooltip text={ID_VALUE} tooltipText={ID_VALUE} />,
    );

    await waitFor(() => {
      expect(container.querySelector("[data-overflowing]")).toHaveAttribute(
        "data-overflowing",
        "true",
      );
    });
  });
});
