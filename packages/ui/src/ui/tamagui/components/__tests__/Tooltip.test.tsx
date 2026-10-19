import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProvider } from "../../../../../test/utils";
import {
  Tooltip,
  TOOLTIP_CLOSE_DELAY_MS,
  __tooltipInternals,
} from "../feedback/Tooltip";

describe("Tooltip", () => {
  let platformGetter: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    platformGetter = vi.spyOn(Platform, "OS", "get").mockReturnValue("web");
  });

  afterEach(() => {
    platformGetter?.mockRestore();
  });

  it("associates tooltip content with the anchor", async () => {
    renderWithProvider(
      <Tooltip anchor={<button type="button">Details</button>} open>
        Helpful copy
      </Tooltip>,
    );

    const tooltip = screen.getByRole("tooltip");
    const anchorWrapper = screen.getByText("Details").parentElement;

    await waitFor(() => expect(tooltip).toBeVisible());
    expect(anchorWrapper).toHaveAttribute("aria-describedby", tooltip.id);
  });

  it("makes the bubble pointer-interactive and selectable so it can be copied", () => {
    renderWithProvider(
      <Tooltip anchor={<button type="button">Details</button>} open>
        Copyable copy
      </Tooltip>,
    );

    const bubble = screen.getByRole("tooltip");

    // Only the bubble re-enables pointer events over the `none` portal wrappers.
    expect(window.getComputedStyle(bubble).pointerEvents).toBe("auto");
    // …and it is styled for text selection/copy.
    expect(window.getComputedStyle(bubble).cursor).toBe("text");
    expect((bubble.getAttribute("style") ?? "").toLowerCase()).toContain(
      "user-select",
    );
  });

  it("stays open when the pointer moves from the anchor into the bubble", () => {
    vi.useFakeTimers();
    try {
      renderWithProvider(
        <Tooltip anchor={<button type="button">Details</button>}>
          Copyable copy
        </Tooltip>,
      );

      const anchorFrame = screen.getByText("Details").parentElement as HTMLElement;
      const root = anchorFrame.parentElement as HTMLElement;

      // Hover the anchor → tooltip opens.
      fireEvent.pointerEnter(root);
      const bubble = screen.getByRole("tooltip");
      expect(bubble).not.toBeNull();

      // Leave the anchor toward the bubble → close is only SCHEDULED…
      fireEvent.pointerLeave(root);
      // …and entering the bubble before the delay cancels it, so the pointer
      // can reach the bubble to select/copy the text instead of it vanishing.
      fireEvent.pointerEnter(bubble);
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_CLOSE_DELAY_MS + 50);
      });

      expect(screen.queryByRole("tooltip")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes (and stops intercepting pointers) after the pointer leaves the bubble", () => {
    vi.useFakeTimers();
    try {
      renderWithProvider(
        <Tooltip anchor={<button type="button">Details</button>}>
          Copyable copy
        </Tooltip>,
      );

      const anchorFrame = screen.getByText("Details")
        .parentElement as HTMLElement;
      const root = anchorFrame.parentElement as HTMLElement;

      fireEvent.pointerEnter(root);
      const bubble = screen.getByRole("tooltip");
      // Open: anchor is described by the bubble and the bubble is interactive.
      expect(anchorFrame).toHaveAttribute("aria-describedby", bubble.id);
      expect(window.getComputedStyle(bubble).pointerEvents).toBe("auto");

      // Leave anchor, then leave the bubble with nothing to catch it → close.
      fireEvent.pointerLeave(root);
      fireEvent.pointerLeave(bubble);
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_CLOSE_DELAY_MS + 50);
      });

      // `aria-describedby` is a reliable open===false proxy (AnimatePresence
      // keeps the node mounted through its fade-out, so queryByRole would lie).
      expect(anchorFrame).not.toHaveAttribute("aria-describedby");
      // …and while it fades out the bubble no longer intercepts pointer events,
      // so a click meant for a control underneath it passes through.
      expect(window.getComputedStyle(bubble).pointerEvents).toBe("none");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not describe the anchor when closed", () => {
    renderWithProvider(
      <Tooltip anchor={<button type="button">Details</button>}>
        Helpful copy
      </Tooltip>,
    );

    const anchorWrapper = screen.getByText("Details").parentElement;

    expect(anchorWrapper).not.toHaveAttribute("aria-describedby");
  });

  it("uses column-reverse flex direction for bottom placement", () => {
    renderWithProvider(
      <Tooltip anchor={<span>Trigger</span>} placement="bottom" open>
        Content
      </Tooltip>,
    );

    const floatingContent = screen.getByRole("tooltip")
      .parentElement as HTMLElement;

    expect(window.getComputedStyle(floatingContent).flexDirection).toBe(
      "column-reverse",
    );
    expect(floatingContent.children.length).toBe(2);
  });

  it("layers the bubble above the pointer for bottom placement", () => {
    renderWithProvider(
      <Tooltip anchor={<span>Trigger</span>} placement="bottom" open>
        Content
      </Tooltip>,
    );

    const pointer = screen.getByRole("tooltip").parentElement
      ?.lastElementChild as HTMLElement | null;
    const bubble = screen.getByRole("tooltip");

    expect(pointer).not.toBeNull();
    expect(window.getComputedStyle(pointer!).zIndex).toBe("0");
    expect(window.getComputedStyle(bubble).zIndex).toBe("1");
  });

  it("points the bottom pointer toward the anchor", () => {
    renderWithProvider(
      <Tooltip anchor={<span>Trigger</span>} placement="bottom" open>
        Content
      </Tooltip>,
    );

    const triangle = screen.getByRole("tooltip").parentElement?.lastElementChild
      ?.firstElementChild as HTMLElement | null;

    expect(triangle).not.toBeNull();
    const computed = window.getComputedStyle(triangle!);

    expect(parseFloat(computed.borderBottomWidth)).toBeGreaterThan(0);
    expect(parseFloat(computed.borderTopWidth)).toBe(0);
  });

  it("points the right pointer toward the anchor", () => {
    renderWithProvider(
      <Tooltip anchor={<span>Trigger</span>} placement="right" open>
        Content
      </Tooltip>,
    );

    const triangle = screen.getByRole("tooltip").parentElement?.lastElementChild
      ?.firstElementChild as HTMLElement | null;

    expect(triangle).not.toBeNull();
    const computed = window.getComputedStyle(triangle!);

    expect(parseFloat(computed.borderRightWidth)).toBeGreaterThan(0);
    expect(parseFloat(computed.borderLeftWidth)).toBe(0);
  });

  it("offsets the bubble based on pointer thickness when align is not centered", () => {
    renderWithProvider(
      <Tooltip
        anchor={<span>Info</span>}
        placement="top"
        align="start"
        pointerThickness={12}
        open
      >
        Content
      </Tooltip>,
    );

    const tooltip = screen.getByRole("tooltip");
    const floatingContent = tooltip.parentElement as HTMLElement;
    const floatingFrame = floatingContent?.parentElement as HTMLElement;

    expect(floatingFrame?.style.marginBottom).toBe("11px");
    expect(floatingFrame?.style.left).toBe("0px");
    expect(window.getComputedStyle(floatingContent).alignItems).toBe(
      "flex-start",
    );
  });

  it("centers the bubble over the anchor when align is center", () => {
    renderWithProvider(
      <Tooltip anchor={<span>Info</span>} placement="top" align="center" open>
        Content
      </Tooltip>,
    );

    const tooltip = screen.getByRole("tooltip");
    const floatingContent = tooltip.parentElement as HTMLElement;
    const floatingFrame = floatingContent?.parentElement as HTMLElement;

    expect(floatingFrame?.style.bottom).toBe("100%");
    expect(floatingFrame?.style.left).toBe("50%");
    expect(floatingFrame?.style.transform).toContain("translateX(-50%)");
  });

  it("uses column layout for top placement", () => {
    renderWithProvider(
      <Tooltip anchor={<span>Trigger</span>} placement="top" open>
        Content
      </Tooltip>,
    );

    const floatingContent = screen.getByRole("tooltip")
      .parentElement as HTMLElement;

    expect(window.getComputedStyle(floatingContent).flexDirection).toBe(
      "column",
    );
  });

  it("hides the pointer when showPointer is false", () => {
    renderWithProvider(
      <Tooltip
        anchor={<span>Trigger</span>}
        placement="top"
        open
        showPointer={false}
      >
        Content
      </Tooltip>,
    );

    const floatingContent = screen.getByRole("tooltip")
      .parentElement as HTMLElement;

    expect(floatingContent.children.length).toBe(1);
  });

  it("supports custom role descriptions", () => {
    renderWithProvider(
      <Tooltip
        anchor={<span>Trigger</span>}
        open
        roleDescription="Helpful hint"
      >
        Content
      </Tooltip>,
    );

    expect(screen.getByRole("tooltip")).toHaveAttribute(
      "aria-roledescription",
      "Helpful hint",
    );
  });

  it("caps horizontal alignment shift by anchor width for right placement", () => {
    const { resolveLayout } = __tooltipInternals;

    const withoutAnchorMeasurement = resolveLayout(
      "right",
      "start",
      16,
      8,
      true,
    );
    const withAnchorMeasurement = resolveLayout(
      "right",
      "start",
      16,
      8,
      true,
      10,
    );

    expect(withoutAnchorMeasurement.frameStyle.transform).toBe(
      "translateY(-8px)",
    );
    expect(withoutAnchorMeasurement.pointerTransform).toBe("translateY(4px)");
    expect(withAnchorMeasurement.frameStyle.transform).toBe("translateY(-5px)");
    expect(withAnchorMeasurement.pointerTransform).toBe("translateY(4px)");
  });

  it("derives floating motion offsets from placement", () => {
    const { createFloatingMotionStyle } = __tooltipInternals;

    expect(createFloatingMotionStyle("top")).toEqual({
      opacity: 0,
      scale: 0.96,
      y: 4,
    });
    expect(createFloatingMotionStyle("bottom")).toEqual({
      opacity: 0,
      scale: 0.96,
      y: -4,
    });
    expect(createFloatingMotionStyle("left")).toEqual({
      opacity: 0,
      scale: 0.96,
      x: 4,
    });
    expect(createFloatingMotionStyle("right")).toEqual({
      opacity: 0,
      scale: 0.96,
      x: -4,
    });
  });
});
