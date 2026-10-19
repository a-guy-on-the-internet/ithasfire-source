import { screen, waitFor } from "@testing-library/react";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProvider } from "../../../../../test/utils";
import { Popover } from "../overlay/Popover";

describe("Popover", () => {
  let platformGetter: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    platformGetter = vi.spyOn(Platform, "OS", "get").mockReturnValue("web");
  });

  afterEach(() => {
    platformGetter?.mockRestore();
  });

  it("portals floating content outside overflow-clipped containers", async () => {
    renderWithProvider(
      <div
        data-testid="shell"
        style={{ overflow: "hidden", position: "relative" }}
      >
        <Popover open anchor={<button type="button">Open</button>}>
          <div>Portaled content</div>
        </Popover>
      </div>,
    );

    const shell = screen.getByTestId("shell");
    const content = await screen.findByText("Portaled content");

    await waitFor(() => expect(content).toBeVisible());
    expect(document.body.contains(content)).toBe(true);
    expect(shell.contains(content)).toBe(false);
  });

  it("keeps Floating UI's positioning when the caller passes contentProps.style", async () => {
    // `{...contentProps}` used to be spread AFTER `style={floatingStyles}`, so a
    // caller-supplied `style` replaced it wholesale: the panel lost
    // `position: fixed` and the translate, and dropped into normal flow at the
    // end of the portal node — the bottom of the document, not its anchor.
    renderWithProvider(
      <Popover
        open
        anchor={<button type="button">Open</button>}
        matchAnchorWidth={false}
        contentProps={{ style: { boxShadow: "6px 6px 0 0 #211c16" } }}
      >
        <div>Styled content</div>
      </Popover>,
    );

    const panel = (await screen.findByText("Styled content"))
      .parentElement as HTMLElement;
    await waitFor(() => expect(panel.style.position).toBe("fixed"));
    expect(panel.style.transform).toContain("translate(");
    expect(panel.style.boxShadow).toContain("6px 6px");
  });

  it("positions against `anchorElement` without cloning (or re-parenting) a trigger", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    try {
      renderWithProvider(
        <Popover open anchorElement={trigger} matchAnchorWidth={false}>
          <div>External anchor content</div>
        </Popover>,
      );

      const panel = (await screen.findByText("External anchor content"))
        .parentElement as HTMLElement;
      await waitFor(() => expect(panel.style.position).toBe("fixed"));
      // Nothing was rendered in the popover's own slot — the trigger stays put.
      expect(trigger.isConnected).toBe(true);
      expect(trigger.parentElement).toBe(document.body);
    } finally {
      trigger.remove();
    }
  });
});
