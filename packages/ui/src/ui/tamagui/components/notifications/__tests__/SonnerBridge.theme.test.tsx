import { act } from "@testing-library/react";
import { toast as sonnerToast } from "sonner";
import { Theme } from "tamagui";

import { renderWithProvider } from "../../../../../../test/utils";
import { SonnerViewport, notifyWeb } from "../SonnerBridge";

afterEach(() => {
  act(() => {
    sonnerToast.dismiss();
  });
});

// The Toaster's light/dark base follows the ambient Tamagui theme (the app's
// mode), not the OS. Sonner only renders its [data-sonner-toaster] list once a
// toast exists, so each case raises one.
describe("SonnerViewport theme", () => {
  it.each([
    ["ember", "dark"],
    ["stub", "light"],
  ] as const)("renders the %s theme as Sonner %s", async (theme, expected) => {
    const { container, findByText } = renderWithProvider(
      <SonnerViewport position="top-right" durationMs={4000} />,
      { providerProps: { theme } },
    );

    act(() => {
      notifyWeb({ title: `Saved ${theme}` }, "same-key");
    });
    await findByText(`Saved ${theme}`);

    const toaster = container.ownerDocument.querySelector(
      "[data-sonner-toaster]",
    );
    expect(toaster?.getAttribute("data-sonner-theme")).toBe(expected);
  });

  // The app toggles light/dark by re-rendering <Theme name={appearance}> with
  // the same children, so the viewport must follow a change after mount.
  it("follows a theme switch after mount", async () => {
    const viewport = <SonnerViewport position="top-right" durationMs={4000} />;
    const { container, findByText, rerender } = renderWithProvider(
      <Theme name="stub">{viewport}</Theme>,
    );

    act(() => {
      notifyWeb({ title: "Saved toggle" }, "same-key");
    });
    await findByText("Saved toggle");
    const toaster = () =>
      container.ownerDocument.querySelector("[data-sonner-toaster]");
    expect(toaster()?.getAttribute("data-sonner-theme")).toBe("light");

    rerender(<Theme name="ember">{viewport}</Theme>);
    await vi.waitFor(() =>
      expect(toaster()?.getAttribute("data-sonner-theme")).toBe("dark"),
    );
  });
});
