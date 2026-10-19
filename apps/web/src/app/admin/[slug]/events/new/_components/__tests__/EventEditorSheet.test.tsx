import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Branch toggle the @th/ui mock reads so a single render exercises either path.
const mobileState = { value: false };

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => mobileState.value,
}));

// Lightweight tamagui stand-ins so the custom mobile header renders to real DOM
// (the 44px close control is built here, not in the primitives).
vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    onPress,
    onKeyDown,
    role,
    tabIndex,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    onKeyDown?: (e: unknown) => void;
    role?: string;
    tabIndex?: number;
    [k: string]: unknown;
  }) =>
    React.createElement(
      "div",
      {
        onClick: onPress,
        onKeyDown,
        role,
        tabIndex,
        "aria-label": rest["aria-label"],
      },
      children,
    );
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

// BottomSheet / Modal test doubles: render their parts and expose onClose so we
// can assert the dismissal callback wiring without the real portal/animation.
vi.mock("@th/ui", async () => {
  const React = await import("react");

  const makeOverlay = (testId: string) => {
    const Root = ({
      open,
      onClose,
      children,
    }: {
      open: boolean;
      onClose: () => void;
      children?: ReactNode;
    }) =>
      open
        ? React.createElement(
            "div",
            { "data-testid": testId },
            React.createElement(
              "button",
              { "data-testid": `${testId}-onclose`, onClick: onClose },
              "x",
            ),
            children,
          )
        : null;
    const Panel = ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children);
    const Header = ({
      title,
      onClose,
    }: {
      title: string;
      onClose?: () => void;
    }) =>
      React.createElement(
        "div",
        null,
        React.createElement("span", null, title),
        onClose
          ? React.createElement(
              "button",
              { "aria-label": "Close", onClick: onClose },
              "x",
            )
          : null,
      );
    const Body = ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children);
    const Footer = ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children);
    return Object.assign(Root, { Panel, Header, Body, Footer });
  };

  // Real translator behaviour: resolve dotted keys against the actual en
  // catalog and FALL BACK to returning the key when missing — so a missing
  // `common.close` would surface as the literal "common.close" and fail the
  // close-label assertions (the old hard-coded "Close" mock hid that bug).
  const { default: enMessages } = await import("@/i18n/messages/en");
  const resolve = (key: string): string => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object"
            ? (node as Record<string, unknown>)[part]
            : undefined,
        enMessages,
      );
    return typeof value === "string" ? value : key;
  };

  return {
    BottomSheet: makeOverlay("bottom-sheet"),
    Modal: makeOverlay("modal"),
    Text: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
    useTranslations: () => resolve,
  };
});

import { EventEditorSheet } from "../EventEditorSheet";

afterEach(() => {
  mobileState.value = false;
  vi.clearAllMocks();
});

describe("EventEditorSheet", () => {
  it("renders title, children, and footer", () => {
    render(
      <EventEditorSheet
        open
        onClose={() => {}}
        title="Edit ticket type"
        footer={<button>Save</button>}
      >
        <p>Body content</p>
      </EventEditorSheet>,
    );

    expect(screen.getByText("Edit ticket type")).toBeInTheDocument();
    expect(screen.getByText("Body content")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("renders the desktop Modal branch by default", () => {
    render(
      <EventEditorSheet open onClose={() => {}} title="Desktop editor">
        <p>Body</p>
      </EventEditorSheet>,
    );

    expect(screen.getByTestId("modal")).toBeInTheDocument();
    expect(screen.queryByTestId("bottom-sheet")).not.toBeInTheDocument();
  });

  it("renders the mobile BottomSheet branch when useIsMobile is true", () => {
    mobileState.value = true;
    render(
      <EventEditorSheet open onClose={() => {}} title="Mobile editor">
        <p>Body</p>
      </EventEditorSheet>,
    );

    expect(screen.getByTestId("bottom-sheet")).toBeInTheDocument();
    expect(screen.queryByTestId("modal")).not.toBeInTheDocument();
  });

  it("fires onClose from the desktop header close control", () => {
    const onClose = vi.fn();
    render(
      <EventEditorSheet open onClose={onClose} title="Desktop editor">
        <p>Body</p>
      </EventEditorSheet>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fires onClose from the mobile 44px close control via click and keyboard", () => {
    mobileState.value = true;
    const onClose = vi.fn();
    render(
      <EventEditorSheet open onClose={onClose} title="Mobile editor">
        <p>Body</p>
      </EventEditorSheet>,
    );

    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.click(close);
    fireEvent.keyDown(close, { key: "Enter" });
    fireEvent.keyDown(close, { key: " " });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("injects the scoped 44px / 16px input style only on the mobile body", () => {
    mobileState.value = true;
    const { container } = render(
      <EventEditorSheet open onClose={() => {}} title="Mobile editor">
        <input data-testid="field" />
      </EventEditorSheet>,
    );

    // The body content is wrapped in the scoped class so the tag-targeted
    // <style> can enlarge native inputs without touching the shared TextInput.
    const scoped = container.querySelector(".event-editor-sheet-body");
    expect(scoped).toBeInTheDocument();
    expect(scoped).toContainElement(screen.getByTestId("field"));

    // The scoped style rule is present and targets the touch + no-zoom values.
    const styleEl = container.querySelector("style");
    expect(styleEl?.textContent).toContain(".event-editor-sheet-body input");
    expect(styleEl?.textContent).toContain("min-height: 44px");
    expect(styleEl?.textContent).toContain("font-size: 16px");
  });

  it("does not inject the mobile input style on the desktop branch", () => {
    const { container } = render(
      <EventEditorSheet open onClose={() => {}} title="Desktop editor">
        <input data-testid="field" />
      </EventEditorSheet>,
    );

    expect(
      container.querySelector(".event-editor-sheet-body"),
    ).not.toBeInTheDocument();
    expect(container.querySelector("style")).not.toBeInTheDocument();
  });

  it("omits the footer region when no footer is passed", () => {
    render(
      <EventEditorSheet open onClose={() => {}} title="No footer">
        <p>Body</p>
      </EventEditorSheet>,
    );

    expect(screen.queryByText("Save")).not.toBeInTheDocument();
  });

  it("resolves the default close label from common.close (not the literal key)", () => {
    // Exercise the MOBILE branch: it owns the custom 44px close control whose
    // aria-label comes from `t("common.close")`. (The desktop Modal.Header's
    // label is fixed by the primitive, so it can't surface this bug.) The real
    // translator falls back to the key, so a missing `common.close` would render
    // the literal "common.close" here and fail this assertion.
    mobileState.value = true;
    render(
      <EventEditorSheet open onClose={() => {}} title="Default label">
        <p>Body</p>
      </EventEditorSheet>,
    );

    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "common.close" }),
    ).not.toBeInTheDocument();
  });

  it("moves focus into the dialog on open and restores it on close", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <EventEditorSheet open onClose={() => {}} title="Focus me">
        <p>Body</p>
      </EventEditorSheet>,
    );

    // Focus lands on the first focusable in the panel (the header close button).
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Close" }),
      );
    });

    // Closing the dialog restores focus to the opener.
    rerender(
      <EventEditorSheet open={false} onClose={() => {}} title="Focus me">
        <p>Body</p>
      </EventEditorSheet>,
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });

    document.body.removeChild(opener);
  });

  it("wraps Tab focus within the dialog panel", async () => {
    render(
      <EventEditorSheet
        open
        onClose={() => {}}
        title="Trap"
        footer={<button>Save</button>}
      >
        <p>Body</p>
      </EventEditorSheet>,
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Close" }),
      );
    });

    const close = screen.getByRole("button", { name: "Close" });
    const save = screen.getByRole("button", { name: "Save" });

    // Shift+Tab from the first focusable wraps to the last.
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);

    // Tab from the last focusable wraps back to the first.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });
});
