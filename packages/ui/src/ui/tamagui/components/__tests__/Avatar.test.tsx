import { renderWithProvider } from "../../../../../test/utils";
import { screen } from "@testing-library/react";

import type { AvatarProps } from "../display/Avatar";

import { Avatar } from "../display/Avatar";

describe("Avatar", () => {
  it("renders fallback initials when no image", () => {
    renderWithProvider(<Avatar initials="TH" alt="Ticket Hunter" />);

    expect(screen.getByText("TH")).toBeVisible();
  });

  it("renders provided image", () => {
    renderWithProvider(
      <Avatar alt="Ticket Hunter" src="https://example.com/avatar.png" />,
    );

    expect(
      screen.getByRole("img", { name: "Ticket Hunter" }),
    ).toBeInTheDocument();
  });

  // Regression: the base Tamagui `Avatar`'s own `size` variant defaults to
  // `true`, emitting min/max width+height at `var(--t-size-true)` = 14px
  // (`tokens/size.ts`). `max-width` beats `width`, so every avatar collapsed to
  // 14x14 and clipped its monogram until `frameSize` pinned all six box
  // properties.
  //
  // Caveat: jsdom does NO layout, so this CANNOT prove the rendered box, and it
  // cannot resolve `var(--t-size-true)` either. What it DOES do is cascade
  // Tamagui's injected stylesheet, so a resolved `max-width: 56px` proves the
  // frameSize variant emitted its own min/max rules and they survived the
  // atomic-class merge — the exact mechanism the bug rode. Verified to fail
  // when the min/max pairs are removed (they come back as *absent*, not 14px).
  // Only a real browser can confirm the painted size.
  it.each([
    ["sm", 40],
    ["md", 56],
    ["lg", 72],
  ] satisfies Array<[AvatarProps["size"], number]>)(
    "pins every %s frame box property so the base size clamp cannot collapse it",
    (size, expected) => {
      const { container } = renderWithProvider(
        <Avatar size={size} initials="TH" alt="Ticket Hunter" />,
      );

      const frame = container.querySelector(
        "div.is_Avatar",
      ) as HTMLElement | null;

      expect(frame).not.toBeNull();

      const px = `${expected}px`;

      expect(frame!).toHaveStyle({
        width: px,
        height: px,
        minWidth: px,
        maxWidth: px,
        minHeight: px,
        maxHeight: px,
      });
    },
  );

  // Regression: `borderRadius: 0` used to be enforced by a `shape` variant whose
  // `circle` and `square` branches BOTH set 0, applied via `defaultVariants`.
  // Deleting that dead prop silently removed the only radius declaration, and
  // the base Tamagui Avatar is circular by default — so every avatar in the
  // product would have gone round. `radius: 0` is locked for content
  // (design-system-v2 §4), so it now sits on the frame's base style.
  // NOTE: assert the LONGHANDS. Tamagui writes radius as four corner properties,
  // and jsdom does not synthesise the `borderRadius` shorthand from them — a
  // `toHaveStyle({ borderRadius: "0px" })` here reads `""` and fails even when
  // the radius is correctly applied, which makes it a gate that is always red
  // and proves nothing.
  it("stays square — radius 0 is locked for content", () => {
    const { container } = renderWithProvider(
      <Avatar size="lg" initials="TH" alt="Ticket Hunter" />,
    );

    const frame = container.querySelector("div.is_Avatar") as HTMLElement;

    expect(frame).toHaveStyle({
      borderTopLeftRadius: "0px",
      borderTopRightRadius: "0px",
      borderBottomRightRadius: "0px",
      borderBottomLeftRadius: "0px",
    });
  });

  it("sizes the default (no size prop) avatar as md, not the 14px token clamp", () => {
    const { container } = renderWithProvider(
      <Avatar initials="TH" alt="Ticket Hunter" />,
    );

    const frame = container.querySelector("div.is_Avatar") as HTMLElement;

    expect(frame).toHaveStyle({ width: "56px", maxWidth: "56px" });
  });
});
