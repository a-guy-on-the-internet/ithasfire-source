import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Pinned blocks in the LIVE editor's per-block chrome
 * (venue-track-record-and-review-switch R6/FR-012). `EditableBlock` is the
 * toolbar `PageBlocksEditor` injects around every block on the canvas, so
 * this is the surface an owner actually meets: for `track_record` the
 * hide/show and delete controls are withheld and a "Pinned" note stands in;
 * the drag handle, span controls and settings stay. An ordinary kind keeps
 * everything.
 *
 * WHAT THIS CANNOT SEE: the fixed-navy chrome's hover reveal and the note's
 * fit beside the span buttons — checked in the real editor.
 */

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type)$/;
  const makeStack =
    (tag: string) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  const Stack = makeStack("div");
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: (_base: unknown, config?: { tag?: string }) =>
      makeStack(config?.tag === "button" ? "button" : "div"),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)/;
  const pick = (rest: Record<string, unknown>) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (PASS_PROP.test(key)) domProps[key] = value;
    }
    return domProps;
  };
  return {
    Text: ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      [key: string]: unknown;
    }) => React.createElement("span", pick(rest), children),
    Badge: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("../BlockSettingsPanel", () => ({
  BlockSettingsPanel: () => <div data-testid="settings-panel" />,
}));

import { EditableBlock } from "../EditableBlock";

function renderBlock(kind: string, handlers: {
  onToggleVisibility: () => void;
  onDelete: () => void;
}) {
  return render(
    <EditableBlock
      id={`b-${kind}`}
      kind={kind}
      kindLabel={kind}
      visible
      isPending={false}
      onToggleVisibility={handlers.onToggleVisibility}
      onDelete={handlers.onDelete}
      dragHandleProps={{ "aria-roledescription": "sortable" }}
      canResize
      columnSpan={2}
      onColumnSpanChange={() => {}}
    >
      <p>content</p>
    </EditableBlock>,
  );
}

describe("EditableBlock — pinned kinds", () => {
  it("withholds hide/show and delete for track_record, keeps drag, span and the note", () => {
    const onToggleVisibility = vi.fn();
    const onDelete = vi.fn();
    renderBlock("track_record", { onToggleVisibility, onDelete });

    expect(
      screen.queryByRole("button", { name: "Hide track_record" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete track_record" }),
    ).not.toBeInTheDocument();

    // The controls that remain.
    expect(
      screen.getByRole("button", { name: "Drag to reorder track_record" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set track_record to one column" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("entity-page-block-pinned-b-track_record"))
      .toHaveTextContent("admin.peBlockPinned");
  });

  it("keeps hide/show and delete on an ordinary kind, and they fire", () => {
    const onToggleVisibility = vi.fn();
    const onDelete = vi.fn();
    renderBlock("about", { onToggleVisibility, onDelete });

    fireEvent.click(screen.getByRole("button", { name: "Hide about" }));
    expect(onToggleVisibility).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete about" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId("entity-page-block-pinned-b-about"),
    ).not.toBeInTheDocument();
  });
});
