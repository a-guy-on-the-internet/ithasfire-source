import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// Inline stand-in for the shared @th/ui Popover (Floating UI needs a real
// layout engine): render the anchor plus — when open — the content.
vi.mock("@th/ui", () => ({
  Popover: ({
    anchor,
    open,
    children,
  }: {
    anchor?: ReactNode;
    open?: boolean;
    children?: ReactNode;
  }) => (
    <>
      {anchor}
      {open ? children : null}
    </>
  ),
}));

import { RowActionMenu } from "../RowActionMenu";

function setup() {
  const rowKeyDown = vi.fn();
  const onFirst = vi.fn();
  const onSecond = vi.fn();
  render(
    // Stand-in for a table row with its own keyboard handling — the menu
    // must not leak handled keys up to it.
    <div onKeyDown={rowKeyDown}>
      <RowActionMenu
        items={[
          { key: "first", label: "First action", onPress: onFirst },
          { key: "second", label: "Second action", onPress: onSecond },
        ]}
        ariaLabel="Row actions"
      />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Row actions" }));
  return { rowKeyDown, onFirst, onSecond };
}

describe("RowActionMenu keyboard behavior", () => {
  it("hides items until the trigger is opened", () => {
    render(
      <RowActionMenu
        items={[{ key: "a", label: "Only action", onPress: () => {} }]}
      />,
    );
    expect(
      screen.queryByRole("menuitem", { name: "Only action" }),
    ).not.toBeInTheDocument();
  });

  it("focuses the first item on open", async () => {
    setup();
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: "First action" }),
      ).toHaveFocus(),
    );
  });

  it("moves focus with arrows WITHOUT leaking the keydown to the row", async () => {
    const { rowKeyDown } = setup();
    const first = screen.getByRole("menuitem", { name: "First action" });
    const second = screen.getByRole("menuitem", { name: "Second action" });
    await waitFor(() => expect(first).toHaveFocus());

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();

    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(first).toHaveFocus();

    expect(rowKeyDown).not.toHaveBeenCalled();
  });

  it("stops Enter/Space propagation but leaves native activation intact", async () => {
    const { rowKeyDown } = setup();
    const first = screen.getByRole("menuitem", { name: "First action" });
    await waitFor(() => expect(first).toHaveFocus());

    // fireEvent returns false when preventDefault was called — native
    // button activation must remain allowed (jsdom does not itself
    // synthesize the click, so activation is asserted via defaultPrevented).
    expect(fireEvent.keyDown(first, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(first, { key: " " })).toBe(true);
    expect(rowKeyDown).not.toHaveBeenCalled();
  });

  it("lets unhandled keys propagate to the row", async () => {
    const { rowKeyDown } = setup();
    const first = screen.getByRole("menuitem", { name: "First action" });
    await waitFor(() => expect(first).toHaveFocus());

    fireEvent.keyDown(first, { key: "a" });
    expect(rowKeyDown).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and refocuses the trigger", async () => {
    setup();
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: "First action" }),
      ).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(
      screen.queryByRole("menuitem", { name: "First action" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Row actions" })).toHaveFocus();
  });

  it("keeps the Escape it consumed from reaching window listeners", async () => {
    // A page-level Escape handler (the event builder's "leave the page")
    // that checks the DOM for an open menu finds it already closed by the
    // time the window phase runs, so the menu has to stop the keystroke
    // itself. Unconsumed keys still reach window.
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      setup();
      const first = screen.getByRole("menuitem", { name: "First action" });
      await waitFor(() => expect(first).toHaveFocus());

      fireEvent.keyDown(first, { key: "Escape" });
      expect(onWindowKey).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("menuitem", { name: "First action" }),
      ).not.toBeInTheDocument();

      // Menu closed: Escape is nobody's here, so it must propagate.
      fireEvent.keyDown(
        screen.getByRole("button", { name: "Row actions" }),
        { key: "Escape" },
      );
      expect(onWindowKey).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("invokes the item's onPress via click and closes the menu", () => {
    const { onFirst } = setup();

    fireEvent.click(screen.getByRole("menuitem", { name: "First action" }));

    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("menuitem", { name: "First action" }),
    ).not.toBeInTheDocument();
  });

  // ── Focus hand-off to whatever the item opens ────────────────────────────
  //
  // `setOpen(false)` + `item.onPress()` batch into ONE commit and the Popover
  // has no exit animation, so the activated menuitem is detached in that same
  // commit and `document.activeElement` falls back to <body>. Any dialog the
  // handler opens captures its "opener" from `document.activeElement`, so
  // unless the trigger is refocused FIRST, closing that dialog returns focus
  // to <body> and the next Tab restarts at the top of the document.
  //
  // Both assertions below fail if the `buttonRef.current?.focus()` call is
  // removed or moved after `item.onPress()`.

  it("has already refocused the trigger by the time onPress runs", () => {
    let activeAtPress: Element | null = null;
    render(
      <RowActionMenu
        items={[
          {
            key: "open-dialog",
            label: "Open dialog",
            onPress: () => {
              activeAtPress = document.activeElement;
            },
          },
        ]}
        ariaLabel="Row actions"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Row actions" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open dialog" }));

    // Identity, NOT text: asserting on `activeElement.textContent` passes
    // trivially when focus is on <body> (whose textContent contains every
    // label on the page).
    expect(activeAtPress).toBe(trigger);
    expect(activeAtPress).not.toBe(document.body);
  });

  it("returns focus to the trigger after a dialog opened from the menu closes", async () => {
    // Mirrors @th/ui Modal's real focus contract: capture activeElement when
    // it opens, restore it when it closes.
    function OpenerCapturingDialog({
      open,
      onClose,
    }: {
      open: boolean;
      onClose: () => void;
    }) {
      const openerRef = useRef<HTMLElement | null>(null);
      useEffect(() => {
        if (open) {
          openerRef.current = document.activeElement as HTMLElement | null;
        } else if (openerRef.current) {
          const opener = openerRef.current;
          openerRef.current = null;
          opener.focus();
        }
      }, [open]);
      if (!open) return null;
      return (
        <div role="dialog">
          <button type="button" onClick={onClose}>
            Close dialog
          </button>
        </div>
      );
    }

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <RowActionMenu
            items={[
              {
                key: "open-dialog",
                label: "Open dialog",
                onPress: () => setOpen(true),
              },
            ]}
            ariaLabel="Row actions"
          />
          <OpenerCapturingDialog open={open} onClose={() => setOpen(false)} />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Row actions" });

    fireEvent.click(trigger);
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: "Open dialog" }),
      ).toHaveFocus(),
    );

    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Open dialog" }));
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    expect(document.activeElement).toBe(trigger);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("RowActionMenu trigger variants", () => {
  const items = [{ key: "a", label: "Only action", onPress: () => {} }];

  it("defaults to the borderless 36px ghost trigger (table rows)", () => {
    render(<RowActionMenu items={items} ariaLabel="Row actions" />);
    const trigger = screen.getByRole("button", { name: "Row actions" });
    expect(trigger.style.width).toBe("36px");
    expect(trigger.style.height).toBe("36px");
    // A transparent 1px border is reserved at rest so the hover frame
    // shifts nothing; border-box keeps the outer size at 36px.
    expect(trigger.style.borderWidth).toBe("1px");
    expect(trigger.style.borderColor).toBe("transparent");
    expect(trigger.style.boxSizing).toBe("border-box");
  });

  it("keeps the 32px 1px-bordered square when framed is passed", () => {
    render(
      <RowActionMenu
        items={items}
        ariaLabel="Row actions"
        triggerVariant="framed"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Row actions" });
    expect(trigger.style.width).toBe("32px");
    expect(trigger.style.border).toContain("1px solid");
  });

  it("gives the ghost trigger a decisive hover (fill + ink frame) and clears it on leave", () => {
    render(<RowActionMenu items={items} ariaLabel="Row actions" />);
    const trigger = screen.getByRole("button", { name: "Row actions" });
    fireEvent.mouseEnter(trigger);
    expect(trigger.style.backgroundColor).not.toBe("transparent");
    expect(trigger.style.backgroundColor).not.toBe("");
    expect(trigger.style.borderColor).toContain("--borderColor");
    expect(trigger.style.borderWidth).toBe("1px");
    fireEvent.mouseLeave(trigger);
    expect(trigger.style.backgroundColor).toBe("transparent");
    expect(trigger.style.borderColor).toBe("transparent");
  });

  it("leaves the framed trigger's border alone on hover", () => {
    render(
      <RowActionMenu
        items={items}
        ariaLabel="Row actions"
        triggerVariant="framed"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Row actions" });
    const before = trigger.style.border;
    fireEvent.mouseEnter(trigger);
    fireEvent.mouseLeave(trigger);
    expect(trigger.style.border).toBe(before);
  });
});
