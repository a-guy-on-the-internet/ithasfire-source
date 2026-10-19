import { fireEvent, render, screen, within } from "@testing-library/react";
import type { CSSProperties, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Plain-DOM stand-ins. Every one spreads `pickDomProps`, so a component that
// stops emitting `role`, `aria-*`, `data-*` or `disabled` fails here instead
// of passing against a mock that dropped them.
vi.mock("tamagui", async () => {
  const React = await import("react");
  const { pickDomProps } = await import("@/test-support/pick-dom-props");
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => React.createElement("div", pickDomProps(rest), children);
  return {
    XStack: Stack,
    YStack: Stack,
    useTheme: () => ({}),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const { pickDomProps } = await import("@/test-support/pick-dom-props");
  return {
    Text: ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      [key: string]: unknown;
    }) => React.createElement("span", pickDomProps(rest), children),
    Button: ({
      children,
      onPress,
      style,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      style?: CSSProperties;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "button",
        { ...pickDomProps(rest), onClick: onPress, style },
        children,
      ),
    useTranslations: () => (key: string) => {
      const dictionary: Record<string, string> = {
        "admin.jobsDlqRerun": "Rerun",
        "admin.jobsDlqRerunning": "Rerunning…",
      };
      return dictionary[key] ?? key;
    },
  };
});

import { DlqRerunButton } from "../DlqRerunButton";
import { DlqRerunStatus } from "../DlqRerunStatus";

describe("DlqRerunStatus", () => {
  it("keeps an empty status region mounted when there is nothing to say", () => {
    render(<DlqRerunStatus notice={null} />);
    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();
  });

  it("puts the message inside the status region, with its tone", () => {
    render(
      <DlqRerunStatus
        notice={{
          tone: "warning",
          message: "This job is paused, so nothing ran.",
        }}
      />,
    );
    const region = screen.getByRole("status");
    const message = within(region).getByText(
      "This job is paused, so nothing ran.",
    );
    expect(message.closest("[data-tone]")).toHaveAttribute(
      "data-tone",
      "warning",
    );
  });

  it("shows the job's error code beside a failed rerun", () => {
    render(
      <DlqRerunStatus
        notice={{
          tone: "danger",
          message: "The rerun failed: boom. The entry is still here.",
          code: "dependency_failed",
        }}
      />,
    );
    const region = screen.getByRole("status");
    expect(within(region).getByText("dependency_failed")).toBeInTheDocument();
    expect(
      within(region).getByText(
        "The rerun failed: boom. The entry is still here.",
      ),
    ).toBeInTheDocument();
    // A live region is read as one run of text. The sentence and the code are
    // separate elements, so there must be whitespace between them: without it
    // a screen reader says "here.dependency_failed".
    expect(region.textContent).toBe(
      "The rerun failed: boom. The entry is still here. dependency_failed",
    );
  });

  it("adds no trailing space when there is no code line", () => {
    render(
      <DlqRerunStatus
        notice={{
          tone: "danger",
          message: "The rerun failed: boom. The entry is still here.",
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "The rerun failed: boom. The entry is still here.",
    );
  });

  it("reuses the same region when the message arrives, so it is announced", () => {
    const { rerender } = render(<DlqRerunStatus notice={null} />);
    const before = screen.getByRole("status");
    rerender(
      <DlqRerunStatus
        notice={{ tone: "success", message: "The job ran." }}
      />,
    );
    const after = screen.getByRole("status");
    // Same DOM node: content was injected into a live region that was
    // already there, not mounted along with it.
    expect(after).toBe(before);
    expect(within(after).getByText("The job ran.")).toBeInTheDocument();
  });
});

// What the REAL `@th/ui` Button emits is `aria-disabled="true"` and, for the
// `disabled` prop, `tabindex="-1"`; it never sets a native `disabled`. The
// stand-in above maps `disabled` onto the native attribute, so these tests do
// not assert `toBeDisabled()`: that would be a statement about the mock. They
// assert the props this component chooses (`aria-busy`, `aria-disabled`) and
// the behaviour that matters, which is that a press does not start a rerun.
describe("DlqRerunButton", () => {
  const visibleButton = () => {
    // The sizer is out of the accessibility tree, so exactly one button.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    return buttons[0]!;
  };

  it("idle: one reachable button named Rerun that fires the rerun", () => {
    const onRerun = vi.fn();
    render(<DlqRerunButton pending={false} onRerun={onRerun} />);

    const button = visibleButton();
    expect(button).toHaveTextContent("Rerun");
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button).not.toHaveAttribute("aria-disabled");

    fireEvent.click(button);
    expect(onRerun).toHaveBeenCalledTimes(1);
  });

  it("pending: busy, not disabled, reads the pending label, and a press does nothing", () => {
    const onRerun = vi.fn();
    render(<DlqRerunButton pending onRerun={onRerun} />);

    const button = visibleButton();
    expect(button).toHaveTextContent("Rerunning…");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    // NOT the `disabled` prop: that dims the label for the whole run and
    // takes the button out of the tab order while it holds focus.
    expect(button).not.toHaveAttribute("disabled");

    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRerun).not.toHaveBeenCalled();
  });

  it("blocked: keeps the idle label, is not busy, and a press does nothing", () => {
    const onRerun = vi.fn();
    render(<DlqRerunButton pending={false} blocked onRerun={onRerun} />);

    const button = visibleButton();
    expect(button).toHaveTextContent("Rerun");
    expect(button).not.toHaveTextContent("Rerunning…");
    expect(button).not.toHaveAttribute("aria-busy");
    // The `disabled` prop reached the Button (the real one turns it into
    // `aria-disabled` + `tabindex="-1"` and the dimmed look).
    expect(button).toHaveAttribute("disabled");

    fireEvent.click(button);
    expect(onRerun).not.toHaveBeenCalled();
  });

  it("pending wins over blocked: the running row still reads as busy", () => {
    const onRerun = vi.fn();
    render(<DlqRerunButton pending blocked onRerun={onRerun} />);

    const button = visibleButton();
    expect(button).toHaveTextContent("Rerunning…");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).not.toHaveAttribute("disabled");

    fireEvent.click(button);
    expect(onRerun).not.toHaveBeenCalled();
  });

  it("the sizer holds the label that is NOT showing, hidden from everyone", () => {
    const { rerender } = render(
      <DlqRerunButton pending={false} onRerun={vi.fn()} />,
    );
    const sizer = screen.getByTestId("dlq-rerun-sizer");
    expect(sizer).toHaveTextContent("Rerunning…");
    expect(sizer).toHaveAttribute("aria-hidden", "true");
    expect(sizer).toHaveStyle({ visibility: "hidden" });

    rerender(<DlqRerunButton pending onRerun={vi.fn()} />);
    expect(screen.getByTestId("dlq-rerun-sizer")).toHaveTextContent("Rerun");
    expect(screen.getByTestId("dlq-rerun-sizer")).not.toHaveTextContent(
      "Rerunning…",
    );
  });

  it("the wrapper cannot shrink, so the sizer keeps sizing it", () => {
    // Regression: as a shrinkable flex item the wrapper collapsed to 38.9px
    // in Chrome and the button rendered as a blank square. jsdom has no
    // layout, so this pins the declaration; the width itself is a browser
    // measurement.
    render(<DlqRerunButton pending={false} onRerun={vi.fn()} />);
    const wrapper = screen.getByTestId("dlq-rerun-sizer").parentElement!;
    expect(wrapper).toHaveStyle({ display: "grid", flexShrink: "0" });
  });

  it("a press on the hidden sizer never starts a rerun", () => {
    const onRerun = vi.fn();
    render(<DlqRerunButton pending={false} onRerun={onRerun} />);
    fireEvent.click(screen.getByTestId("dlq-rerun-sizer"));
    expect(onRerun).not.toHaveBeenCalled();
  });
});
