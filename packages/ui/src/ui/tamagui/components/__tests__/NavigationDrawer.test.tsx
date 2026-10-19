import { fireEvent, screen } from "@testing-library/react";

vi.mock("react-native", async () => {
  const actual =
    await vi.importActual<typeof import("react-native")>("react-native");
  const easing = { ...(actual.Easing ?? {}) };

  if (typeof easing.bezier !== "function") {
    easing.bezier = () => (value: number) => value;
  }

  return {
    ...actual,
    Easing: easing,
    useWindowDimensions: () => ({ width: 1280, height: 720 }),
  };
});

import { renderWithProvider } from "../../../../../test/utils";
import { Button } from "../forms/Button";
import { NavigationDrawer } from "../navigation/NavigationDrawer";

describe("NavigationDrawer", () => {
  it("renders header content and children when open", () => {
    renderWithProvider(
      <NavigationDrawer open title="Menu" description="Choose a destination">
        <Button variant="ghost">Dashboard</Button>
      </NavigationDrawer>,
    );

    expect(screen.getByText("Menu")).toBeInTheDocument();
    expect(screen.getByText("Choose a destination")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dashboard" }),
    ).toBeInTheDocument();
  });

  it("invokes onOpenChange when overlay or close button are activated", () => {
    const handleOpenChange = vi.fn();

    renderWithProvider(
      <NavigationDrawer
        open
        onOpenChange={handleOpenChange}
        testIdBase="drawer"
      >
        <Button variant="ghost">Billing</Button>
      </NavigationDrawer>,
    );

    fireEvent.click(screen.getByTestId("drawer-overlay"));
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));

    expect(handleOpenChange).toHaveBeenCalledTimes(2);
    expect(handleOpenChange).toHaveBeenLastCalledWith(false);
  });
});
