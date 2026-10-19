import { fireEvent } from "@testing-library/react";
import { simpleHash } from "tamagui";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Button,
  BUTTON_SIZE_HEIGHTS,
  BUTTON_VARIANT_STYLES,
  type ButtonSize,
  type ButtonVariant,
} from "../forms/Button";
import { NextLinkAnchor } from "../navigation/NextLinkAnchor";
import { renderWithProvider } from "../../../../../test/utils";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * `<Button asChild>` must hand the button's variant styling to its child and
 * render ONE interactive element: the child itself.
 *
 * Regression: the DS Button is `styled(TamaguiButton)`, a styled HOC. Tamagui's
 * outer `createComponent` short-circuits `asChild` straight to `Slot`, so the
 * inner Button that resolves variant / size / frame styles never rendered. The
 * child got the raw inline `style` only: no classes, no border, no height. A
 * MANAGE link rendered as 19.5px plain text on /admin/<org>/volunteers.
 */
describe("Button asChild", () => {
  it("styles a link child as the button and keeps it a link", () => {
    const { container } = renderWithProvider(
      <Button variant="outlined" size="$2" minHeight={44} asChild>
        <a href="/admin/org/volunteers/asks/1">Manage</a>
      </Button>,
    );

    // One interactive element: the <a> itself, no <button> anywhere.
    expect(container.querySelectorAll("button")).toHaveLength(0);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.getAttribute("href")).toBe("/admin/org/volunteers/asks/1");
    expect(link.textContent).toBe("Manage");
    // A link must stay a link to assistive tech.
    expect(link.getAttribute("role")).toBeNull();

    // The frame's atomic classes reach the child (they carry border, height,
    // padding, colours and the hover/press/focus pseudo rules).
    expect(link.className).toMatch(/_bw-2px|_btw-2px|_borderTopWidth-2px/);
    expect(link.className).toMatch(/_minHeight-44px/);
    expect(link.className).toMatch(/_h-34px|_height-34px/);
    expect(link.className).toMatch(/_btlr-0px|_borderTopLeftRadius-0px/);
    // Tamagui's View reset never reaches a slotted child; without an explicit
    // flex display the <a> is `display: block` and the label sits at the top.
    // (Tamagui strips a default-valued display under asChild, so it is inline.)
    expect(link.getAttribute("style") ?? "").toMatch(/display:\s*flex/);
    expect(link.className).toMatch(/_alignItems-center/);
    // Text styles the label needs (no ButtonText wraps a slotted child).
    expect(link.className).toMatch(/_fw-700|_fontWeight-700/);
    expect(link.className).toMatch(/_ls-|_letterSpacing-/);
    expect(link.getAttribute("style") ?? "").toMatch(
      /text-transform:\s*uppercase/,
    );
    // Tamagui attaches no runtime hover/press listeners under asChild, so the
    // interaction states must exist as compiled pseudo-class rules.
    expect(link.className).toMatch(/-0hover-/);
    expect(link.className).toMatch(/-0active-/);
    expect(link.className).toMatch(/-0focus-/);
  });

  it("forwards the requested variant, not a default", () => {
    const { container } = renderWithProvider(
      <>
        <Button variant="outlined" asChild>
          <a href="/a">A</a>
        </Button>
        <Button variant="ghost" asChild>
          <a href="/b">B</a>
        </Button>
      </>,
    );
    const [outlined, ghost] = Array.from(container.querySelectorAll("a"));
    // ghost sets borderWidth 0; outlined keeps the base 2px.
    expect(outlined!.className).toMatch(/_bw-2px|_btw-2px|_borderTopWidth-2px/);
    expect(ghost!.className).toMatch(/_bw-0px|_btw-0px|_borderTopWidth-0px/);
    expect(outlined!.className).not.toBe(ghost!.className);
  });

  it("keeps a native submit button's type and onClick, unnested", () => {
    const onClick = vi.fn();
    const { container } = renderWithProvider(
      <form onSubmit={(e) => e.preventDefault()}>
        <Button size="$4" asChild>
          <button type="submit" onClick={onClick}>
            Save
          </button>
        </Button>
      </form>,
    );

    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    const button = buttons[0]!;
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.querySelector("button")).toBeNull();
    expect(button.className).toMatch(/_h-44px|_height-44px/);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disables a native button child for real", () => {
    const onClick = vi.fn();
    const { container } = renderWithProvider(
      <Button variant="ghost" disabled asChild>
        <button type="button" onClick={onClick}>
          Cancel
        </button>
      </Button>,
    );
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("lets the variant colour win over NextLinkAnchor's inherit default", () => {
    // NextLinkAnchor falls back to Tamagui's Anchor when next/link is absent,
    // so this also covers that branch: one <a>, styled, with href.
    const { container } = renderWithProvider(
      <Button variant="outlined" asChild>
        <NextLinkAnchor href="/">Return home</NextLinkAnchor>
      </Button>,
    );
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.getAttribute("href")).toBe("/");
    expect(link.getAttribute("style") ?? "").not.toMatch(/color:\s*inherit/);
    expect(link.className).toMatch(/_bw-2px|_btw-2px|_borderTopWidth-2px/);
  });

  it("passes href and onClick from a legacyBehavior Link parent to the <a>", () => {
    // `<Link href passHref legacyBehavior><Button asChild><a>` clones the
    // Button with href + onClick; they must land on the anchor.
    const onClick = vi.fn((event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    const legacyLinkProps = { href: "/my-tickets", onClick } as Record<
      string,
      unknown
    >;
    const { container } = renderWithProvider(
      <Button variant="secondary" size="$3" asChild {...legacyLinkProps}>
        <a style={{ textDecoration: "none" }}>Back to tickets</a>
      </Button>,
    );
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.getAttribute("href")).toBe("/my-tickets");
    expect(link.getAttribute("role")).toBeNull();
    expect(link.className).toMatch(/_h-36px|_height-36px/);
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("blocks a disabled link: no handler runs and the default is cancelled", () => {
    const legacyOnClick = vi.fn();
    const childOnClick = vi.fn();
    const legacyLinkProps = { href: "/my-tickets", onClick: legacyOnClick };
    const { container } = renderWithProvider(
      <Button variant="secondary" disabled asChild {...legacyLinkProps}>
        <a onClick={childOnClick}>Back to tickets</a>
      </Button>,
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("aria-disabled")).toBe("true");
    expect(link.getAttribute("tabindex")).toBe("-1");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(legacyOnClick).not.toHaveBeenCalled();
    expect(childOnClick).not.toHaveBeenCalled();
  });

  it("blocks a disabled bare <a href> from following its href", () => {
    const { container } = renderWithProvider(
      <Button variant="outlined" disabled asChild>
        <a href="/somewhere">Somewhere</a>
      </Button>,
    );
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    container.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("cancels a middle-click (auxclick) on a disabled bare <a href>", () => {
    const { container } = renderWithProvider(
      <Button variant="outlined" disabled asChild>
        <a href="/somewhere">Somewhere</a>
      </Button>,
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/somewhere");
    const event = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("maps onPressIn / onPressOut to mouse down / up on an HTML child", () => {
    const pressIn = vi.fn();
    const pressOut = vi.fn();
    const { container } = renderWithProvider(
      <Button variant="outlined" asChild onPressIn={pressIn} onPressOut={pressOut}>
        <a href="/somewhere">Somewhere</a>
      </Button>,
    );
    const link = container.querySelector("a")!;
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(pressIn).toHaveBeenCalledTimes(1);
    expect(pressOut).toHaveBeenCalledTimes(1);
  });

  // React already skips mouse handlers on a disabled <button>, but not touch
  // ones: onPressIn also arrives as onTouchStart, so the native `disabled`
  // alone did not stop it.
  it("runs onPressIn on touchstart for an enabled native <button> child", () => {
    const pressIn = vi.fn();
    const { container } = renderWithProvider(
      <Button variant="secondary" asChild onPressIn={pressIn}>
        <button type="button">Save</button>
      </Button>,
    );
    container
      .querySelector("button")!
      .dispatchEvent(new Event("touchstart", { bubbles: true }));
    expect(pressIn).toHaveBeenCalledTimes(1);
  });

  it("drops onPressIn / onPressOut on a disabled native <button> child", () => {
    const pressIn = vi.fn();
    const pressOut = vi.fn();
    const { container } = renderWithProvider(
      <Button
        variant="secondary"
        asChild
        disabled
        onPressIn={pressIn}
        onPressOut={pressOut}
      >
        <button type="button">Save</button>
      </Button>,
    );
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    for (const type of ["mousedown", "mouseup"]) {
      button.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    for (const type of ["touchstart", "touchend"]) {
      button.dispatchEvent(new Event(type, { bubbles: true }));
    }
    expect(pressIn).not.toHaveBeenCalled();
    expect(pressOut).not.toHaveBeenCalled();
  });

  it("leaves display to a caller's media prop instead of forcing it inline", () => {
    const mediaProps = { $sm: { display: "none" } } as Record<string, unknown>;
    const { container } = renderWithProvider(
      <>
        <Button variant="outlined" asChild {...mediaProps}>
          <a href="/media">Media</a>
        </Button>
        <Button variant="outlined" asChild>
          <a href="/plain">Plain</a>
        </Button>
      </>,
    );
    const [media, plain] = Array.from(container.querySelectorAll("a"));
    expect(media!.getAttribute("style") ?? "").not.toMatch(/display:/);
    expect(media!.className).toMatch(/_dsp-_sm_none|_dsp-sm-none|sm_none/);
    expect(plain!.getAttribute("style") ?? "").toMatch(/display:\s*flex/);
  });

  it("does not leak Button-only props onto the child DOM node", () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { container } = renderWithProvider(
      <Button variant="secondary" size="$3" asChild>
        <button type="button">Refresh</button>
      </Button>,
    );
    const button = container.querySelector("button")!;
    for (const attr of ["variant", "size", "textprops", "locked", "icon"]) {
      expect(button.hasAttribute(attr)).toBe(false);
    }
    const unknownPropWarnings = consoleErrorSpy.mock.calls.filter((call) =>
      String(call[0]).includes("React does not recognize"),
    );
    expect(unknownPropWarnings).toEqual([]);
  });
});

/**
 * The asChild frame (SlottedButtonFrame) is a second styled component built
 * from the same config as the normal Button. This pins that every variant x
 * size resolves to the same atomic classes on both: border, background,
 * colour, height, padding, radius and the hover / active / focus rules. A
 * variant or size edited in one frame and not the other fails here.
 *
 * Allowed differences, and only these (NORMAL_ONLY / SLOT_ONLY below). There
 * is deliberately no theme fill-in entry: every variant states its own hover
 * and press background + border (see button-variants.ts, THEME FILL-IN), so
 * Tamagui ButtonFrame's hoverTheme / pressTheme never reach the normal Button.
 */
// The class Tamagui emits for a theme fill-in, built the way Tamagui builds it
// (`_<shortProp>-0<pseudo>-<simpleHash(value)>`, getCSSStylesAtomic.ts).
const pseudoClass = (prop: string, pseudo: string, token: string) =>
  `_${prop}-0${pseudo}-${simpleHash(`var(--${token})`)}`;
const BORDER_COLOR_PROPS = ["btc", "brc", "borderBottomColor", "borderLeftColor"];
const THEME_FALLBACK_CLASSES = new Set([
  ...BORDER_COLOR_PROPS.map((prop) =>
    pseudoClass(prop, "hover", "borderColorHover"),
  ),
  ...BORDER_COLOR_PROPS.map((prop) =>
    pseudoClass(prop, "active", "borderColorPress"),
  ),
  pseudoClass("bg", "hover", "backgroundHover"),
  pseudoClass("bg", "active", "backgroundPress"),
]);

type ClassMatcher = RegExp | Set<string>;

const NORMAL_ONLY: ClassMatcher[] = [
  // Tamagui's web View reset. Under asChild Tamagui strips default-valued
  // styles, so the slot gets display:flex inline instead (asserted above).
  /^is_Button$/,
  /^_dsp-flex$/,
  /^_fb-auto$/,
  /^_bxs-border-box$/,
  /^_pos-relative$/,
  /^_minHeight-0px$/,
  /^_minWidth-0px$/,
  /^_flexShrink-0$/,
  // Tamagui's own ButtonFrame focusVisibleStyle (and its built-in `outlined`
  // variant's), which are not part of our config.
  /-0focus-visible-/,
];
const SLOT_ONLY: ClassMatcher[] = [
  // Label text styles: on a normal Button they live on ButtonText; a slotted
  // child has no ButtonText, so the frame carries them.
  /^_fs-/,
  /^_ls-/,
  /^_ff-/,
  /^_td-none$/,
];

const matches = (cls: string, matcher: ClassMatcher) =>
  matcher instanceof Set ? matcher.has(cls) : matcher.test(cls);

const classSet = (el: Element, allowed: ClassMatcher[]) =>
  el.className
    .split(/\s+/)
    .filter(Boolean)
    .filter((cls) => !allowed.some((matcher) => matches(cls, matcher)))
    .sort();

describe("Button asChild frame stays in sync with the normal Button", () => {
  const variants = Object.keys(BUTTON_VARIANT_STYLES) as ButtonVariant[];
  const sizes = Object.keys(BUTTON_SIZE_HEIGHTS) as ButtonSize[];
  // The two boolean variants ride on top of every variant x size: `locked`
  // (applied after `variant`, so its styles win) and `icon` (square,
  // paddingHorizontal 0, minWidth mirrored from the size).
  const modifiers = {
    plain: {},
    locked: { locked: true },
    icon: { icon: true, "aria-label": "Label" },
  } as const;

  it("covers every variant, size and modifier", () => {
    expect(variants.length).toBeGreaterThan(5);
    expect(sizes).toEqual(["$1", "$2", "$3", "$4", "$5"]);
    expect(Object.keys(modifiers)).toEqual(["plain", "locked", "icon"]);
  });

  it("builds the theme fill-in classes the way Tamagui names them", () => {
    // Pins the helper's output to the identifiers the fill-in emitted before
    // every variant restated its hover / press fill and border (they were the
    // old allowlist). This only checks the helper against that list; it does
    // not render anything. What proves `pseudoClass` names classes the way
    // Tamagui does is the destructive test below, which finds its
    // `$danger` classes on a rendered Button.
    expect([...THEME_FALLBACK_CLASSES].sort()).toEqual(
      [
        "_bg-0active-backgroundP3496915",
        "_bg-0hover-backgroundH3423444",
        "_borderBottomColor-0active-borderColor77378595",
        "_borderBottomColor-0hover-borderColor69916956",
        "_borderLeftColor-0active-borderColor77378595",
        "_borderLeftColor-0hover-borderColor69916956",
        "_brc-0active-borderColor77378595",
        "_brc-0hover-borderColor69916956",
        "_btc-0active-borderColor77378595",
        "_btc-0hover-borderColor69916956",
      ].sort(),
    );
  });

  it("no variant lets the theme fill in its hover or press colours", () => {
    for (const variant of variants) {
      const { container, unmount } = renderWithProvider(
        <Button variant={variant}>Label</Button>,
      );
      const classes = container.querySelector("button")!.className.split(/\s+/);
      expect({
        variant,
        fillIns: classes.filter((cls) => THEME_FALLBACK_CLASSES.has(cls)),
      }).toEqual({ variant, fillIns: [] });
      unmount();
    }
  });

  it("keeps a destructive Button red on hover and press", () => {
    const { container } = renderWithProvider(
      <Button variant="destructive">Delete</Button>,
    );
    const classes = container.querySelector("button")!.className.split(/\s+/);
    for (const pseudo of ["hover", "active"]) {
      expect(classes).toContain(pseudoClass("bg", pseudo, "danger"));
      for (const prop of BORDER_COLOR_PROPS) {
        expect(classes).toContain(pseudoClass(prop, pseudo, "danger"));
      }
    }
  });

  it("gives a subtle Button's hover a border the colour of its fill", () => {
    const { container } = renderWithProvider(
      <Button variant="subtle">Skip</Button>,
    );
    const classes = container.querySelector("button")!.className.split(/\s+/);
    expect(classes).toContain(pseudoClass("bg", "hover", "backgroundStrong"));
    for (const prop of BORDER_COLOR_PROPS) {
      expect(classes).toContain(pseudoClass(prop, "hover", "backgroundStrong"));
    }
  });

  for (const [modifierName, modifierProps] of Object.entries(modifiers)) {
    for (const variant of variants) {
      for (const size of sizes) {
        it(`${variant} ${size} ${modifierName}`, () => {
          const { container } = renderWithProvider(
            <>
              <Button variant={variant} size={size} {...modifierProps}>
                Label
              </Button>
              <Button variant={variant} size={size} {...modifierProps} asChild>
                <a href="/x">Label</a>
              </Button>
            </>,
          );
          const normal = container.querySelector("button")!;
          const slotted = container.querySelector("a")!;
          expect(classSet(slotted, SLOT_ONLY)).toEqual(
            classSet(normal, NORMAL_ONLY),
          );
        });
      }
    }
  }
});
