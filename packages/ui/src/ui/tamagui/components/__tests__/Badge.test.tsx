import { lucideIcons } from "../../../../../test/fixtures";
import { renderWithProvider } from "../../../../../test/utils";
import { screen } from "@testing-library/react";

import { Badge } from "../feedback/Badge";

describe("Badge", () => {
  it("renders label text", () => {
    renderWithProvider(<Badge>Pending</Badge>);

    expect(screen.getByText("Pending")).toBeVisible();
  });

  it("supports leading and trailing icons", () => {
    renderWithProvider(
      <Badge leadingIcon={lucideIcons.check} trailingIcon={lucideIcons.alert}>
        Paid
      </Badge>,
    );

    expect(screen.getByTestId("lucide-check")).toBeInTheDocument();
    expect(screen.getByTestId("lucide-alert")).toBeInTheDocument();
  });

  it("can render a dot indicator", () => {
    renderWithProvider(<Badge dot tone="success" />);

    expect(screen.getByTestId("badge-dot")).toBeVisible();
  });

  // PIN — do not delete. Badge spreads `{...rest}` onto a Tamagui XStack, and
  // callers rely on that spread reaching the real DOM to give an icon+count
  // chip a single atomic accessible name (see the web app's
  // `UnreadMessagesBadge`, whose own suite mocks Badge and therefore cannot
  // observe this). If Tamagui ever stopped forwarding these, every one of
  // those consumer tests would stay green while the accessible name silently
  // degraded to the bare number.
  it("forwards role, aria-label and data-testid through to the DOM", () => {
    renderWithProvider(
      <Badge
        role="img"
        aria-label="2 unread messages"
        data-testid="pass-through-badge"
      >
        2
      </Badge>,
    );

    const badge = screen.getByRole("img", { name: "2 unread messages" });
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("data-testid", "pass-through-badge");
  });
});
