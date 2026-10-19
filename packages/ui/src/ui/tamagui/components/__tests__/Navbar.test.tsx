import { fireEvent, screen } from "@testing-library/react";
import { Calendar, Menu } from "lucide-react";

import { renderWithProvider } from "../../../../../test/utils";
import { Button } from "../forms/Button";
import { Navbar } from "../navigation/Navbar";
import { NavbarMenuButton } from "../navigation/NavbarMenuButton";
import { Text } from "../typography/Text";
import { TextInput } from "../forms/TextInput";

describe("Navbar", () => {
  it("renders title and brand content", () => {
    renderWithProvider(
      <Navbar
        brand={
          <Text variant="body" weight="bold">
            TH
          </Text>
        }
        title="Ithas Fire"
        trailingAccessory={<Button size="$2">New</Button>}
      />,
    );

    expect(screen.getByText("Ithas Fire")).toBeInTheDocument();
    expect(screen.getByText("TH")).toBeInTheDocument();
  });

  it("exposes automation hooks for slots", () => {
    renderWithProvider(
      <Navbar
        brand={<Text variant="body">Brand</Text>}
        title="Schedule"
        leadingAccessory={<Menu size={18} strokeWidth={1.5} />}
        trailingAccessory={<Calendar size={18} strokeWidth={1.5} />}
        testIdBase="primary-navbar"
      />,
    );

    expect(screen.getByTestId("primary-navbar-leading")).toBeInTheDocument();
    expect(screen.getByTestId("primary-navbar-brand")).toBeInTheDocument();
    expect(screen.getByTestId("primary-navbar-title")).toBeInTheDocument();
    expect(screen.getByTestId("primary-navbar-trailing")).toBeInTheDocument();
  });

  it("renders nested children below the main row", () => {
    renderWithProvider(
      <Navbar title="Listings">
        <Text variant="bodySmall" tone="muted">
          Filter your venues by status.
        </Text>
      </Navbar>,
    );

    expect(
      screen.getByText("Filter your venues by status."),
    ).toBeInTheDocument();
  });

  it("omits the brand slot entirely when brand is not provided", () => {
    // The mobile shell navbar passes `brand={undefined}` — the slot (and its
    // gap contribution) must disappear rather than render an empty box.
    renderWithProvider(
      <Navbar
        title="Schedule"
        trailingAccessory={<Calendar size={18} strokeWidth={1.5} />}
        testIdBase="mobile-navbar"
      />,
    );

    expect(screen.queryByTestId("mobile-navbar-brand")).toBeNull();
    expect(screen.getByTestId("mobile-navbar-title")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-navbar-trailing")).toBeInTheDocument();
  });

  it("exposes a search slot when provided", () => {
    renderWithProvider(
      <Navbar
        brand={<Text variant="body">Brand</Text>}
        searchAccessory={<TextInput placeholder="Search" fullWidth />}
        testIdBase="dashboard-nav"
      />,
    );

    expect(screen.getByTestId("dashboard-nav-search")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();
  });
});

describe("NavbarMenuButton", () => {
  it("toggles state through onToggle callback", () => {
    const handleToggle = vi.fn();

    renderWithProvider(<NavbarMenuButton open onToggle={handleToggle} />);

    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));

    expect(handleToggle).toHaveBeenCalledWith(false);
  });

  it("maps expansion state to accessibility attributes", () => {
    renderWithProvider(<NavbarMenuButton open />);

    expect(
      screen.getByRole("button", { name: "Close navigation" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("flags glyph state for animation", () => {
    const { rerender } = renderWithProvider(<NavbarMenuButton />);

    expect(screen.getByTestId("navbar-menu-button-glyph")).toHaveAttribute(
      "data-state",
      "closed",
    );

    rerender(<NavbarMenuButton open />);

    expect(screen.getByTestId("navbar-menu-button-glyph")).toHaveAttribute(
      "data-state",
      "open",
    );
  });
});
