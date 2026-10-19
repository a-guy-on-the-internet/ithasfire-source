/**
 * The password gate's "Door" look. Presentational only — the unlock flow is
 * `EventPasswordGateWrapper`'s and is covered by its challenge suite.
 *
 * Contract under test:
 *   - ONE real password input (accessible name, `current-password`), with the
 *     typed characters painted as squares: one square per character, emoji
 *     included, paste included;
 *   - the reveal toggle shows the real text and drops the squares;
 *   - the challenge slot and its caption render inside the Door;
 *   - a wrong password nudges and clears the squares right to left, then
 *     empties the field through `onPasswordClear` — and under reduced motion
 *     does none of that (border + message only);
 *   - checking swaps the label for the stepped blocks and locks the field;
 *   - the kicker carries the date in the EVENT's zone, or no date at all.
 */
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/image", async () => {
  const React = await import("react");
  return {
    default: ({ src, alt }: { src: string; alt: string }) =>
      React.createElement("img", { src, alt, "data-testid": "door-photo" }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    // The DS PasswordInput, reduced to what the Door relies on: a controlled
    // `show`, a toggle that calls `onToggle`, and the DOM props it forwards.
    PasswordInput: ({
      value,
      onChangeText,
      onSubmitEditing,
      show,
      onToggle,
      toggleLabel,
      editable,
      autoComplete,
      ...rest
    }: {
      value: string;
      onChangeText: (v: string) => void;
      onSubmitEditing?: () => void;
      show?: boolean;
      onToggle?: () => void;
      toggleLabel?: string;
      editable?: boolean;
      autoComplete?: string;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "div",
        null,
        React.createElement("input", {
          type: show ? "text" : "password",
          value,
          readOnly: editable === false,
          autoComplete,
          onChange: (e: { target: { value: string } }) =>
            onChangeText(e.target.value),
          onKeyDown: (e: { key: string }) => {
            if (e.key === "Enter") onSubmitEditing?.();
          },
          "aria-label": rest["aria-label"],
          "aria-invalid": rest["aria-invalid"],
          "aria-describedby": rest["aria-describedby"],
        }),
        React.createElement(
          "button",
          {
            type: "button",
            "aria-label": toggleLabel,
            "aria-pressed": Boolean(show),
            onClick: onToggle,
          },
          "eye",
        ),
      ),
    Button: ({
      children,
      disabled,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onPress?: () => void;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          disabled,
          onClick: onPress,
          "aria-label": rest["aria-label"],
          "aria-busy": rest["aria-busy"],
          "aria-disabled": rest["aria-disabled"],
        },
        children,
      ),
    useTranslations: () => (key: string) => key,
    useLocale: () => "en",
  };
});

import {
  PasswordDoor,
  type PasswordDoorMessage,
  type PasswordDoorProps,
} from "../PasswordDoor";

const base: PasswordDoorProps = {
  title: "Secret Supper Club",
  heroImageUrl: null,
  password: "",
  onPasswordChange: () => {},
  onPasswordClear: () => {},
  onSubmit: () => {},
  submitting: false,
  submitDisabled: false,
  message: null,
};

const input = () =>
  screen.getByLabelText("eventDetail.pwAriaLabel") as HTMLInputElement;
const blocks = () =>
  screen
    .queryByTestId("password-door-blocks")
    ?.querySelectorAll(".th-door__block").length ?? null;
const toggle = () =>
  screen.getByRole("button", { name: "eventDetail.pwTogglePw" });

const setReducedMotion = (reduce: boolean) => {
  vi.mocked(window.matchMedia).mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes("reduce"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
};

beforeEach(() => setReducedMotion(false));
afterEach(() => {
  vi.useRealTimers();
});

describe("PasswordDoor — the field", () => {
  it("is one real password input with a name and current-password autocomplete", () => {
    render(<PasswordDoor {...base} />);
    expect(input()).toHaveAttribute("type", "password");
    expect(input()).toHaveAttribute("autocomplete", "current-password");
    expect(screen.queryAllByRole("textbox", { hidden: true }).length).toBe(0);
    expect(document.querySelectorAll("input").length).toBe(1);
  });

  it("paints one square per character, and mirrors every change", () => {
    const { rerender } = render(<PasswordDoor {...base} password="" />);
    expect(blocks()).toBe(0);
    rerender(<PasswordDoor {...base} password="d" />);
    expect(blocks()).toBe(1);
    // A paste lands as one change.
    rerender(<PasswordDoor {...base} password="demo1234" />);
    expect(blocks()).toBe(8);
    // An emoji is ONE character to the guest, not two UTF-16 units.
    rerender(<PasswordDoor {...base} password="ab🔥" />);
    expect(blocks()).toBe(3);
    rerender(<PasswordDoor {...base} password="" />);
    expect(blocks()).toBe(0);
  });

  it("hands every keystroke to onPasswordChange", () => {
    const onPasswordChange = vi.fn();
    render(<PasswordDoor {...base} onPasswordChange={onPasswordChange} />);
    fireEvent.change(input(), { target: { value: "dem" } });
    expect(onPasswordChange).toHaveBeenCalledWith("dem");
  });

  it("the reveal toggle shows the real text instead of the squares", () => {
    render(<PasswordDoor {...base} password="demo" />);
    expect(blocks()).toBe(4);
    expect(input().closest(".th-door__field")).toHaveAttribute(
      "data-blocks",
      "on",
    );

    fireEvent.click(toggle());
    expect(input()).toHaveAttribute("type", "text");
    expect(input()).toHaveValue("demo");
    expect(blocks()).toBeNull();
    expect(input().closest(".th-door__field")).toHaveAttribute(
      "data-blocks",
      "off",
    );

    fireEvent.click(toggle());
    expect(input()).toHaveAttribute("type", "password");
    expect(blocks()).toBe(4);
  });

  it("Enter in the field submits", () => {
    const onSubmit = vi.fn();
    render(<PasswordDoor {...base} password="demo" onSubmit={onSubmit} />);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("PasswordDoor — checking", () => {
  it("swaps the label for the stepped blocks, locks the field, ignores presses", () => {
    const onSubmit = vi.fn();
    render(
      <PasswordDoor {...base} password="demo" submitting onSubmit={onSubmit} />,
    );
    const button = screen.getByRole("button", {
      name: "eventDetail.pwChecking",
    });
    expect(screen.getByTestId("password-door-spinner")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-busy", "true");
    // Busy is not `disabled` (which would dim the blocks to 45%).
    expect(button).not.toBeDisabled();
    expect(input()).toHaveAttribute("readonly");

    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("at rest the button says Enter and is disabled with nothing to send", () => {
    render(<PasswordDoor {...base} submitDisabled />);
    const button = screen.getByRole("button", {
      name: "eventDetail.pwDoorEnter",
    });
    expect(button).toBeDisabled();
    expect(screen.queryByTestId("password-door-spinner")).toBeNull();
  });
});

describe("PasswordDoor — messages and the challenge slot", () => {
  it("an invalid message marks the field and prints in the error tone", () => {
    render(
      <PasswordDoor {...base} message={{ kind: "invalid", text: "Wrong" }} />,
    );
    const line = screen.getByRole("alert");
    expect(line).toHaveAttribute("id", "password-error");
    expect(line).toHaveAttribute("data-tone", "error");
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(input()).toHaveAttribute("aria-describedby", "password-error");
  });

  it("a challenge prompt is neutral and leaves the field valid", () => {
    render(
      <PasswordDoor
        {...base}
        message={{ kind: "challenge", text: "One more step" }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "default");
    expect(input()).toHaveAttribute("aria-invalid", "false");
  });

  it("renders the challenge widget and its caption inside the Door", () => {
    render(
      <PasswordDoor
        {...base}
        challenge={<div data-testid="turnstile" />}
        challengeCaption="Complete the check"
      />,
    );
    const slot = screen.getByTestId("password-gate-turnstile");
    expect(slot).toContainElement(screen.getByTestId("turnstile"));
    expect(slot).toHaveTextContent("Complete the check");
    expect(screen.getByTestId("password-door")).toContainElement(slot);
  });

  it("renders no challenge slot until there is a widget", () => {
    render(<PasswordDoor {...base} />);
    expect(screen.queryByTestId("password-gate-turnstile")).toBeNull();
  });
});

describe("PasswordDoor — a wrong password", () => {
  const wrong = (): PasswordDoorMessage => ({ kind: "invalid", text: "Wrong" });

  it("nudges, clears the squares right to left, then empties the field", () => {
    vi.useFakeTimers();
    const onPasswordClear = vi.fn();
    // Owns the value the way the wrapper does: the clear really empties it.
    function Harness({ message }: { message: PasswordDoorMessage | null }) {
      const [pw, setPw] = useState("demo");
      return (
        <PasswordDoor
          {...base}
          password={pw}
          onPasswordChange={setPw}
          onPasswordClear={() => {
            onPasswordClear();
            setPw("");
          }}
          message={message}
        />
      );
    }
    const { rerender } = render(<Harness message={null} />);
    rerender(<Harness message={wrong()} />);
    const form = document.querySelector(".th-door__form");
    expect(form).toHaveClass("is-nudging");
    expect(blocks()).toBe(4);

    // The nudge runs first; nothing clears during it.
    act(() => {
      vi.advanceTimersByTime(239);
    });
    expect(blocks()).toBe(4);

    const seen: number[] = [];
    for (let i = 0; i < 20 && onPasswordClear.mock.calls.length === 0; i += 1) {
      act(() => {
        vi.advanceTimersByTime(15);
      });
      const n = blocks();
      if (n !== null && seen[seen.length - 1] !== n) seen.push(n);
    }
    // One square at a time, never a jump, all inside the 240ms budget.
    expect(seen).toEqual([4, 3, 2, 1, 0]);
    expect(onPasswordClear).toHaveBeenCalledTimes(1);
    expect(input()).toHaveValue("");
    expect(blocks()).toBe(0);
    // The message stays up through the clear.
    expect(screen.getByRole("alert")).toHaveTextContent("Wrong");
    expect(input()).toHaveFocus();
  });

  it("a NEW message mid-clear resets the squares to the real value", () => {
    vi.useFakeTimers();
    const onPasswordClear = vi.fn();
    const props = {
      ...base,
      password: "abcdefgh",
      onPasswordClear,
    };
    const { rerender } = render(<PasswordDoor {...props} />);
    rerender(<PasswordDoor {...props} message={wrong()} />);
    // Past the nudge, part-way through the clear.
    act(() => {
      vi.advanceTimersByTime(240 + 90);
    });
    expect(blocks()).toBeLessThan(8);

    rerender(
      <PasswordDoor
        {...props}
        message={{ kind: "generic", text: "Something went wrong" }}
      />,
    );
    // Not 3 squares over an 8-character value.
    expect(blocks()).toBe(8);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(blocks()).toBe(8);
    expect(onPasswordClear).not.toHaveBeenCalled();
  });

  it("typing during the clear cancels it", () => {
    vi.useFakeTimers();
    const onPasswordClear = vi.fn();
    const onPasswordChange = vi.fn();
    const props = {
      ...base,
      password: "demo",
      onPasswordClear,
      onPasswordChange,
    };
    const { rerender } = render(<PasswordDoor {...props} />);
    rerender(<PasswordDoor {...props} message={wrong()} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.change(input(), { target: { value: "demo1" } });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onPasswordClear).not.toHaveBeenCalled();
    expect(onPasswordChange).toHaveBeenCalledWith("demo1");
  });

  it("under reduced motion: border + message only — no nudge, no clear", () => {
    setReducedMotion(true);
    vi.useFakeTimers();
    const onPasswordClear = vi.fn();
    const { rerender } = render(
      <PasswordDoor
        {...base}
        password="demo"
        onPasswordClear={onPasswordClear}
      />,
    );
    rerender(
      <PasswordDoor
        {...base}
        password="demo"
        onPasswordClear={onPasswordClear}
        message={wrong()}
      />,
    );
    expect(document.querySelector(".th-door__form")).not.toHaveClass(
      "is-nudging",
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onPasswordClear).not.toHaveBeenCalled();
    expect(blocks()).toBe(4);
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Wrong");
    // Focus returns with the text selected, so typing replaces it.
    expect(input()).toHaveFocus();
  });

  it("with the password revealed, nothing clears; the text is selected", () => {
    vi.useFakeTimers();
    const onPasswordClear = vi.fn();
    const props = { ...base, password: "demo", onPasswordClear };
    const { rerender } = render(<PasswordDoor {...props} />);
    fireEvent.click(toggle());
    rerender(<PasswordDoor {...props} message={wrong()} />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onPasswordClear).not.toHaveBeenCalled();
    expect(input()).toHaveFocus();
  });
});

describe("PasswordDoor — the kicker and the photo", () => {
  it("prints the server-resolved local day as is", () => {
    render(<PasswordDoor {...base} gateDate="2026-10-09" />);
    const date = screen.getByTestId("password-door-date");
    expect(date).toHaveTextContent("Fri, Oct 9");
    expect(date).toHaveAttribute("datetime", "2026-10-09");
    expect(date.parentElement).toHaveTextContent(
      "eventDetail.pwDoorKicker · Fri, Oct 9",
    );
  });

  it.each([
    ["no date", null],
    ["an instant instead of a day", "2026-10-10T00:00:00.000Z"],
    ["a day that does not exist", "2026-02-30"],
    ["garbage", "not-a-date"],
  ])("with %s the kicker is just 'Private event'", (_, gateDate) => {
    render(<PasswordDoor {...base} gateDate={gateDate} />);
    expect(screen.queryByTestId("password-door-date")).toBeNull();
    expect(screen.getByText("eventDetail.pwDoorKicker")).toBeInTheDocument();
  });

  it("the title is the page's h1", () => {
    render(<PasswordDoor {...base} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Secret Supper Club" }),
    ).toBeInTheDocument();
  });

  it("shows the photo under the scrim, or a plain colour field without one", () => {
    const { rerender } = render(
      <PasswordDoor {...base} heroImageUrl="https://img.example/p.jpg" />,
    );
    expect(screen.getByTestId("door-photo")).toHaveAttribute("alt", "");
    expect(document.querySelector('[data-gate-reveal="scrim"]')).not.toBeNull();

    rerender(<PasswordDoor {...base} heroImageUrl={null} />);
    expect(screen.queryByTestId("door-photo")).toBeNull();
    expect(document.querySelector('[data-gate-reveal="scrim"]')).toBeNull();
  });
});
