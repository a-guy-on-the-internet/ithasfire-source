import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  Button: ({ children, onPress, ...rest }: any) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (
        k === "data-testid" ||
        k === "disabled" ||
        k === "type" ||
        k.startsWith("aria-")
      )
        safe[k] = v;
    }
    return (
      <button onClick={onPress} {...safe}>
        {children}
      </button>
    );
  },
  Text: ({ children, ...rest }: any) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (k === "data-testid" || k === "id" || k.startsWith("aria-"))
        safe[k] = v;
    }
    return <span {...safe}>{children}</span>;
  },
  useTranslations: () => (key: string) => key,
}));

vi.mock("tamagui", () => {
  const passthrough = (props: any) => {
    const { children, testID: _testID, ...rest } = props;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (
        k === "data-testid" ||
        k === "id" ||
        k === "role" ||
        k.startsWith("aria-")
      ) {
        cleaned[k] = v;
      }
    }
    return <div {...cleaned}>{children}</div>;
  };
  return { YStack: passthrough, XStack: passthrough };
});

import { DesktopOnlyNotice } from "../DesktopOnlyNotice";

describe("DesktopOnlyNotice", () => {
  it("renders the default i18n title and body with no back button", () => {
    render(<DesktopOnlyNotice />);

    expect(screen.getByTestId("desktop-only-notice")).toBeInTheDocument();
    expect(screen.getByText("admin.desktopOnlyTitle")).toBeInTheDocument();
    expect(screen.getByText("admin.desktopOnlyBody")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders custom copy when title/body overrides are provided", () => {
    render(
      <DesktopOnlyNotice title="Desktop required" body="Use a bigger screen" />,
    );

    expect(screen.getByText("Desktop required")).toBeInTheDocument();
    expect(screen.getByText("Use a bigger screen")).toBeInTheDocument();
    expect(
      screen.queryByText("admin.desktopOnlyTitle"),
    ).not.toBeInTheDocument();
  });

  it("renders a back button when backLabel and onBack are provided", () => {
    const onBack = vi.fn();
    render(<DesktopOnlyNotice backLabel="Go back" onBack={onBack} />);

    const button = screen.getByRole("button", { name: /go back/i });
    fireEvent.click(button);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("does not render a back button when only onBack is provided", () => {
    render(<DesktopOnlyNotice onBack={() => {}} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
