import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Render tamagui stacks to real DOM, forwarding interaction props + role/tabIndex
// so keyboard activation and button semantics are testable. `styled()` returns a
// component that drops the style config but keeps prop pass-through (incl. the
// variant `interactive` prop, which we simply ignore at render time).
vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    onPress,
    onKeyDown,
    role,
    tabIndex,
    // swallow style-only props that aren't valid DOM attributes
    interactive: _interactive,
    minWidth: _minWidth,
    flex: _flex,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    onKeyDown?: (e: unknown) => void;
    role?: string;
    tabIndex?: number;
    interactive?: boolean;
    minWidth?: unknown;
    flex?: unknown;
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
        "data-testid": rest["data-testid"],
      },
      children,
    );
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    // styled(Base) -> a component; our usage only ever renders <Stack>-like divs
    styled: () => Stack,
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
  };
});

vi.mock("lucide-react", () => ({
  ChevronRight: (props: Record<string, unknown>) => (
    <svg data-testid="chevron" {...props} />
  ),
}));

import {
  EditorCard,
  EditorCardActions,
  EditorCardMeta,
  EditorCardTitle,
} from "../_mobile-bits";

describe("EditorCard", () => {
  it("renders title and meta content", () => {
    render(
      <EditorCard>
        <EditorCardTitle>General Admission</EditorCardTitle>
        <EditorCardMeta>$25.00 · 100 available</EditorCardMeta>
      </EditorCard>,
    );

    expect(screen.getByText("General Admission")).toBeInTheDocument();
    expect(screen.getByText("$25.00 · 100 available")).toBeInTheDocument();
  });

  it("fires onPress on click and on Enter / Space", () => {
    const onPress = vi.fn();
    render(
      <EditorCard onPress={onPress}>
        <EditorCardTitle>Row</EditorCardTitle>
      </EditorCard>,
    );

    const card = screen.getByRole("button");
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    expect(onPress).toHaveBeenCalledTimes(3);
  });

  it("shows the chevron only when interactive", () => {
    const { rerender } = render(
      <EditorCard>
        <EditorCardTitle>Static</EditorCardTitle>
      </EditorCard>,
    );
    expect(screen.queryByTestId("chevron")).not.toBeInTheDocument();

    rerender(
      <EditorCard onPress={() => {}}>
        <EditorCardTitle>Pressable</EditorCardTitle>
      </EditorCard>,
    );
    expect(screen.getByTestId("chevron")).toBeInTheDocument();
  });

  it("keeps action buttons out of the card's button role (no nested interactive)", () => {
    render(
      <EditorCard
        actions={
          <EditorCardActions>
            <button aria-label="Delete">x</button>
          </EditorCardActions>
        }
      >
        <EditorCardTitle>With actions</EditorCardTitle>
      </EditorCard>,
    );

    // Static card => no button role on the card itself, only the action button.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute("aria-label", "Delete");
  });

  it("renders the actions slot as a sibling of the title/meta column, not inside it", () => {
    render(
      <EditorCard
        actions={
          <EditorCardActions>
            <button aria-label="Delete">x</button>
          </EditorCardActions>
        }
      >
        <EditorCardTitle>General Admission</EditorCardTitle>
        <EditorCardMeta>$25.00</EditorCardMeta>
      </EditorCard>,
    );

    const content = screen.getByTestId("editor-card-content");
    const actions = screen.getByTestId("editor-card-actions");

    // Title/meta live in the content column.
    expect(content).toHaveTextContent("General Admission");
    expect(content).toHaveTextContent("$25.00");

    // The actions slot is a SIBLING of the content column, never nested in it —
    // this is what makes the right-hand alignment possible.
    expect(content).not.toContainElement(actions);
    expect(actions).not.toContainElement(content);
    expect(actions.parentElement).toBe(content.parentElement);

    // The delete button lives in the actions slot, not the title column.
    const del = screen.getByRole("button", { name: "Delete" });
    expect(actions).toContainElement(del);
    expect(content).not.toContainElement(del);
  });
});
