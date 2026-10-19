import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * The per-block toolbar's buttons are 44px tap targets (design rule: the
 * minimum practical tap target), and the actions group wraps so five of them
 * fit a one-column block at 320px.
 *
 * `styled` is mocked to record each styled component's config by name, so the
 * sizes asserted here are the ones Tamagui receives.
 *
 * WHAT THIS CANNOT SEE: the rendered box size and the wrap itself — checked
 * in the real editor (e2e/moderator-place-page.spec.ts measures the buttons).
 */

const configs = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP =
    /^(data-|aria-)|^(id|role|style|title|tabIndex|type|onMouseEnter|onMouseLeave|onFocus|onBlur)$/;
  const makeStack =
    (tag: string, extra: Record<string, unknown> = {}) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = { ...extra };
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
        // Layout props the test reads, kept as data attributes.
        if (key === "flexWrap") domProps["data-flex-wrap"] = String(value);
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  const Stack = makeStack("div");
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: (
      _base: unknown,
      config?: { tag?: string; name?: string } & Record<string, unknown>,
    ) => {
      if (config?.name) configs.set(config.name, config);
      return makeStack(config?.tag === "button" ? "button" : "div");
    },
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
    Badge: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("../BlockSettingsPanel", () => ({
  BlockSettingsPanel: () => <div data-testid="settings-panel" />,
}));

import { BLOCK_ACTION_TARGET, EditableBlock } from "../EditableBlock";

describe("EditableBlock toolbar tap targets", () => {
  it("sizes the icon buttons 44 x 44", () => {
    expect(BLOCK_ACTION_TARGET).toBeGreaterThanOrEqual(44);
    const action = configs.get("EditableBlockAction");
    expect(action).toBeDefined();
    expect(action?.width).toBe(BLOCK_ACTION_TARGET);
    expect(action?.height).toBe(BLOCK_ACTION_TARGET);
  });

  it("gives the column-span buttons a 44px minimum box", () => {
    const span = configs.get("EditableBlockSpanAction");
    expect(span).toBeDefined();
    expect(span?.minWidth).toBe(BLOCK_ACTION_TARGET);
    expect(span?.height).toBe(BLOCK_ACTION_TARGET);
  });

  it("keeps the toolbar wrapping", () => {
    expect(configs.get("EditableBlockChrome")?.flexWrap).toBe("wrap");
    render(
      <EditableBlock
        id="b1"
        kind="text"
        kindLabel="Text"
        visible
        isPending={false}
        onToggleVisibility={() => undefined}
        onDelete={() => undefined}
        hasSettings
        canResize
        onColumnSpanChange={() => undefined}
      >
        <p>body</p>
      </EditableBlock>,
    );
    const actions = screen.getByTestId("entity-page-block-actions-b1");
    expect(actions.getAttribute("data-flex-wrap")).toBe("wrap");
    // Span 1, span 2, settings, hide, delete: all in the wrapping group.
    expect(actions.querySelectorAll("button")).toHaveLength(5);
  });
});

describe("EditableBlock hidden toolbar", () => {
  function renderBlock() {
    render(
      <EditableBlock
        id="b2"
        kind="text"
        kindLabel="Text"
        visible
        isPending={false}
        onToggleVisibility={() => undefined}
        onDelete={() => undefined}
      >
        <p>body</p>
      </EditableBlock>,
    );
    return {
      wrapper: screen.getByTestId("entity-page-editable-block-b2"),
      chrome: screen.getByTestId("entity-page-block-chrome-b2"),
    };
  }

  it("takes no pointer events while hidden, so a tap can't hit Delete", () => {
    const { chrome } = renderBlock();
    expect(chrome.style.opacity).toBe("0");
    expect(chrome.style.pointerEvents).toBe("none");
  });

  it("hover reveals it and makes it pressable; leaving hides it again", () => {
    const { wrapper, chrome } = renderBlock();
    fireEvent.mouseEnter(wrapper);
    expect(chrome.style.opacity).toBe("1");
    expect(chrome.style.pointerEvents).toBe("auto");
    fireEvent.mouseLeave(wrapper);
    expect(chrome.style.pointerEvents).toBe("none");
  });

  it("keyboard focus on a toolbar button reveals it", () => {
    const { chrome } = renderBlock();
    const del = screen.getByRole("button", { name: "Delete Text" });
    act(() => del.focus());
    expect(chrome.style.opacity).toBe("1");
    expect(chrome.style.pointerEvents).toBe("auto");
  });
});
