import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { TextInput } from "../forms/TextInput";

const expectBorderToken = (className: string, token: string) => {
  expect(className).toMatch(
    new RegExp(`_(?:btc|borderTopColor)-${token}(?:\\s|$)`),
  );
};

describe("TextInput", () => {
  it("uses surface tokens from the active theme", () => {
    renderWithProvider(<TextInput placeholder="Name" />);

    const input = screen.getByPlaceholderText("Name");
    expect(input.className).toContain("_bg-surface");
    expectBorderToken(input.className, "borderColor");
  });

  it("supports dark theme via provider override", () => {
    renderWithProvider(<TextInput placeholder="Email" />, {
      providerProps: { theme: "ember" },
    });

    expect(document.body.classList.contains("t_ember")).toBe(true);
  });

  it("expands to full width when requested", () => {
    renderWithProvider(<TextInput placeholder="Company" fullWidth />, {
      providerProps: { theme: "swiss" },
    });

    const input = screen.getByPlaceholderText("Company");
    expect(input).toHaveStyle({ width: "100%" });
  });

  it("renders a status icon and applies status border colors", () => {
    renderWithProvider(<TextInput placeholder="Status" status="error" />);

    expect(screen.getByTestId("text-input-status-error")).toBeInTheDocument();
    const input = screen.getByPlaceholderText("Status");
    // Error borders are orange ($brandSecondary) per the Swiss design spec
    // (commit 504003a3), not red ($danger). Tamagui hashes long token names
    // in compiled class names (e.g. _btc-brandSecond96872), so match the
    // stable prefix.
    expectBorderToken(input.className, "brandSecond\\w*");
  });

  it("falls back to no status styling when unset", () => {
    renderWithProvider(<TextInput placeholder="No status" />);

    expect(
      screen.queryByTestId("text-input-status-error"),
    ).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText("No status");
    expectBorderToken(input.className, "borderColor");
  });
});

describe("TextInput DOM attribute patching", () => {
  it("sets the name attribute on the underlying <input> element", () => {
    renderWithProvider(<TextInput placeholder="Password" name="password" />);

    const input = screen.getByPlaceholderText("Password") as HTMLInputElement;
    expect(input.getAttribute("name")).toBe("password");
  });

  it("sets the type attribute on the underlying <input> element", () => {
    renderWithProvider(<TextInput placeholder="Password" type="password" />);

    const input = screen.getByPlaceholderText("Password") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("password");
  });

  it("sets both name and type together (login form scenario)", () => {
    renderWithProvider(
      <TextInput
        placeholder="Enter password"
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        secureTextEntry
      />,
    );

    const input = screen.getByPlaceholderText(
      "Enter password",
    ) as HTMLInputElement;
    expect(input.getAttribute("name")).toBe("password");
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("id")).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("current-password");
  });

  it("sets name, type=email, and autocomplete for email inputs", () => {
    renderWithProvider(
      <TextInput
        placeholder="Email"
        id="email"
        name="email"
        type="email"
        autoComplete="email"
      />,
    );

    const input = screen.getByPlaceholderText("Email") as HTMLInputElement;
    expect(input.getAttribute("name")).toBe("email");
    expect(input.getAttribute("type")).toBe("email");
    expect(input.getAttribute("autocomplete")).toBe("email");
  });

  it("removes name attribute when name prop is undefined", () => {
    renderWithProvider(<TextInput placeholder="No name" />);

    const input = screen.getByPlaceholderText("No name") as HTMLInputElement;
    expect(input.getAttribute("name")).toBeNull();
  });

  // React 19's updateInput calls `removeAttribute("type")` on every commit of
  // the host <input> whose `type` prop is null, and RNW always nulls it. Before
  // the pin, each keystroke flipped `datetime-local` to text and back (the
  // re-assert effect), which resets the native picker's active segment, and
  // commits the wrapper never saw (Tamagui focus state) left it a text box
  // showing the raw string: the hold Challenge form bug, 2026-09-28.
  it("never flips a native type while its value changes", () => {
    const { rerender } = renderWithProvider(
      <TextInput
        placeholder="Deadline"
        type="datetime-local"
        value="2026-09-30T19:30"
        onChangeText={() => {}}
      />,
    );
    const input = screen.getByPlaceholderText("Deadline") as HTMLInputElement;
    const observer = new MutationObserver(() => {});
    observer.observe(input, { attributes: true, attributeFilter: ["type"] });

    rerender(
      <TextInput
        placeholder="Deadline"
        type="datetime-local"
        value="2026-10-01T08:15"
        onChangeText={() => {}}
      />,
    );

    const flips = observer.takeRecords();
    observer.disconnect();
    expect(flips).toHaveLength(0);
    expect(input.getAttribute("type")).toBe("datetime-local");
    expect(input.value).toBe("2026-10-01T08:15");
  });

  it("refuses only the removal of a pinned type, and drops it with the prop", () => {
    const { rerender } = renderWithProvider(
      <TextInput placeholder="Pinned" type="datetime-local" />,
    );
    const input = screen.getByPlaceholderText("Pinned") as HTMLInputElement;

    input.removeAttribute("type");
    expect(input.getAttribute("type")).toBe("datetime-local");
    // Every other attribute still removes natively.
    input.setAttribute("data-extra", "1");
    input.removeAttribute("data-extra");
    expect(input.hasAttribute("data-extra")).toBe(false);

    // set → unset: React's own removal ran while the pin held, so the release
    // must finish it. No manual removal here.
    rerender(<TextInput placeholder="Pinned" />);
    expect(input.hasAttribute("type")).toBe(false);
  });

  // Same React path blanks `element.name` then removes it on every commit;
  // password managers read `name` while the field is focused.
  it("keeps a caller's name through React's per-commit blanking", () => {
    const { rerender } = renderWithProvider(
      <TextInput placeholder="Email" name="email" value="a" onChangeText={() => {}} />,
    );
    const input = screen.getByPlaceholderText("Email") as HTMLInputElement;
    const observer = new MutationObserver(() => {});
    observer.observe(input, { attributes: true, attributeFilter: ["name"] });

    rerender(<TextInput placeholder="Email" name="email" value="ab" onChangeText={() => {}} />);
    const blanks = observer.takeRecords();
    observer.disconnect();
    expect(blanks).toHaveLength(0);
    expect(input.getAttribute("name")).toBe("email");

    input.name = "";
    input.removeAttribute("name");
    expect(input.getAttribute("name")).toBe("email");
    expect(input.name).toBe("email");

    // Only the blanking is refused: a real programmatic write lands.
    input.name = "other";
    expect(input.getAttribute("name")).toBe("other");
  });

  it("follows a name prop change A → B", () => {
    const { rerender } = renderWithProvider(<TextInput placeholder="Renamed" name="a" />);
    const input = screen.getByPlaceholderText("Renamed") as HTMLInputElement;
    expect(input.getAttribute("name")).toBe("a");
    rerender(<TextInput placeholder="Renamed" name="b" />);
    expect(input.getAttribute("name")).toBe("b");
    expect(input.name).toBe("b");
  });

  it("releases a pinned name with the prop", () => {
    const { rerender } = renderWithProvider(<TextInput placeholder="Named" name="email" />);
    const input = screen.getByPlaceholderText("Named") as HTMLInputElement;
    rerender(<TextInput placeholder="Named" />);
    expect(input.hasAttribute("name")).toBe(false);
    input.name = "later";
    expect(input.getAttribute("name")).toBe("later");
  });
});
