import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IthasFireProvider, themes } from "../..";
import { Button, BUTTON_VARIANT_STYLES } from "../forms/Button";
import { renderWithProvider } from "../../../../../test/utils";
import { Text } from "../typography/Text";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Button theming", () => {
  it("applies a different theme to the tree when the theme prop changes", () => {
    // Themes are class-only (`.t_swiss` / `.t_ember`) — neither key is prefixed
    // "light"/"dark", so Tamagui never emits a prefers-color-scheme :root rule.
    // jsdom's getComputedStyle can't resolve stylesheet-injected custom
    // properties, so we assert the applied theme class swaps and that the two
    // themes genuinely resolve different page backgrounds (a meaningful swap).
    const { rerender } = render(
      <IthasFireProvider theme="swiss">
        <Button>Primary</Button>
      </IthasFireProvider>,
    );

    expect(document.body.classList.contains("t_swiss")).toBe(true);

    rerender(
      <IthasFireProvider theme="ember">
        <Button>Primary</Button>
      </IthasFireProvider>,
    );

    expect(document.body.classList.contains("t_ember")).toBe(true);
    expect(document.body.classList.contains("t_swiss")).toBe(false);
    expect(themes.swiss.background).not.toBe(themes.ember.background);
  });

  it("does not emit the React textTransform DOM warning and keeps labels uppercase", () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    renderWithProvider(
      <>
        <Button>Sign in</Button>
        <Button>
          <Text tag="span">Manage account</Text>
        </Button>
      </>,
    );

    const buttons = document.querySelectorAll("button");
    const nestedLabel = document.querySelector("button:last-of-type span");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.getAttribute("textTransform")).toBeNull();
    }
    expect(buttons[0]?.textContent).toBe("Sign in");
    expect(nestedLabel).not.toBeNull();
    expect((nestedLabel as HTMLElement | null)?.textContent).toBe(
      "Manage account",
    );

    const matchedWarning = consoleErrorSpy.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" &&
          /does not recognize the `textTransform` prop on a DOM element/i.test(
            arg,
          ),
      ),
    );
    expect(matchedWarning).toBe(false);
  });

  it("renders the destructiveGhost variant on the legible danger token", () => {
    renderWithProvider(
      <Button variant="destructiveGhost">Remove</Button>,
    );
    const button = document.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Remove");

    // Grammar: transparent frame in the AA-legible $dangerSoft text color,
    // filling with $dangerSoft + an inverted (AA) label on interaction.
    const v = BUTTON_VARIANT_STYLES.destructiveGhost;
    expect(v.backgroundColor).toBe("transparent");
    expect(v.color).toBe("$dangerSoft");
    expect(v.borderColor).toBe("$dangerSoft");
    expect(v.hoverStyle.backgroundColor).toBe("$dangerSoft");
    expect(v.hoverStyle.color).toBe("$colorInverted");
    expect(v.pressStyle.color).toBe("$colorInverted");
  });

  it("renders the ghostInverted variant with ink that survives its fill", () => {
    renderWithProvider(<Button variant="ghostInverted">Exit</Button>);
    const button = document.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Exit");

    // Grammar: ghost for an inverted/filled surface — inverted ink at rest.
    // Hover paints the OPAQUE $surfaceRaised fill, so the ink flips to $color.
    // Press keeps the inverted ink: $accentSoft is translucent, so the filled
    // surface still shows through ($color there fails AA on the $accent pill).
    const v = BUTTON_VARIANT_STYLES.ghostInverted;
    expect(v.backgroundColor).toBe("transparent");
    expect(v.color).toBe("$colorInverted");
    expect(v.hoverStyle.backgroundColor).toBe("$surfaceRaised");
    expect(v.hoverStyle.color).toBe("$color");
    expect(v.pressStyle.color).toBe("$colorInverted");
  });

  it("forwards aria-disabled when `locked` is set so onPress is suppressed", () => {
    const onPress = vi.fn();
    renderWithProvider(
      <Button locked onPress={onPress}>
        Locked
      </Button>,
    );
    // Tamagui maps the `disabled` prop to `aria-disabled` on the
    // underlying Pressable and short-circuits onPress internally;
    // `aria-disabled="true"` is the canonical a11y signal we assert
    // against (Tamagui doesn't emit the native HTML `disabled` attr).
    const button = document.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps a caller's aria-disabled/aria-busy on a NOT-disabled button", () => {
    // The in-flight-but-still-readable pattern: a pending action needs to say
    // "busy, don't press" WITHOUT the `disabled` prop, because `disabled` also
    // applies disabledStyle's 0.45 opacity — which paints the only progress
    // feedback (spinner + "Saving…") at roughly 2:1.
    //
    // This used to be impossible: the internal prop bag is spread LAST and
    // carried an unconditional `"aria-disabled": effectiveDisabled || undefined`,
    // and an explicit `undefined` OVERWRITES in an object spread. So a caller's
    // value was silently erased on exactly the buttons that needed it.
    renderWithProvider(
      <Button aria-busy aria-disabled>
        <Text tone="inherit">Saving</Text>
      </Button>,
    );

    const button = document.querySelector("button");
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.getAttribute("aria-disabled")).toBe("true");
  });

  it("omits aria-disabled entirely when neither the caller nor `locked` asks for it", () => {
    renderWithProvider(
      <Button>
        <Text tone="inherit">Go</Text>
      </Button>,
    );

    const button = document.querySelector("button");
    expect(button?.hasAttribute("aria-disabled")).toBe(false);
  });
  // Tab order. The real atom never emits a native `disabled` (it renders
  // `aria-disabled="true" tabindex="0"`), so a disabled Button used to stay a
  // Tab stop that did nothing on Enter. These run against the REAL component —
  // most apps/web suites mock Button and cannot see this either way.
  describe("tab order", () => {
    it("takes a caller-disabled button out of the Tab order and keeps aria-disabled", () => {
      renderWithProvider(<Button disabled>Confirm</Button>);
      const button = document.querySelector("button");
      expect(button?.getAttribute("tabindex")).toBe("-1");
      expect(button?.getAttribute("aria-disabled")).toBe("true");
      // Still NOT a native disabled: that could drop focus to <body> mid-submit.
      expect(button?.hasAttribute("disabled")).toBe(false);
    });

    it("takes a locked button out of the Tab order too", () => {
      renderWithProvider(<Button locked>Locked</Button>);
      const button = document.querySelector("button");
      expect(button?.getAttribute("tabindex")).toBe("-1");
      expect(button?.getAttribute("aria-disabled")).toBe("true");
    });

    it("leaves an enabled button tabbable with no aria-disabled", () => {
      renderWithProvider(<Button>Confirm</Button>);
      const button = document.querySelector("button");
      expect(button?.getAttribute("tabindex")).toBe("0");
      expect(button?.hasAttribute("aria-disabled")).toBe(false);
    });

    it("leaves an aria-disabled-only (aria-busy) caller tabbable", () => {
      // The pending-action pattern: the pressed button keeps focus and stays
      // reachable while its spinner shows. Only the `disabled` prop is inert.
      renderWithProvider(
        <Button aria-busy aria-disabled>
          <Text tone="inherit">Saving</Text>
        </Button>,
      );
      const button = document.querySelector("button");
      expect(button?.getAttribute("tabindex")).toBe("0");
      expect(button?.getAttribute("aria-disabled")).toBe("true");
    });

    it("still removes a disabled button when the caller passes tabIndex={undefined}", () => {
      // The rule is `tabIndex == null`, not "was the key passed": AppNavbar's
      // `reserved ? -1 : undefined` hands over an explicit undefined, and that
      // must not count as the caller choosing to keep a dead button reachable.
      renderWithProvider(
        <Button disabled tabIndex={undefined}>
          Confirm
        </Button>,
      );
      const button = document.querySelector("button");
      expect(button?.getAttribute("tabindex")).toBe("-1");
    });

    it("lets a caller-supplied tabIndex win over the disabled default", () => {
      renderWithProvider(
        <Button disabled tabIndex={0}>
          Confirm
        </Button>,
      );
      const button = document.querySelector("button");
      expect(button?.getAttribute("tabindex")).toBe("0");
      expect(button?.getAttribute("aria-disabled")).toBe("true");
    });

    it("keeps focus on a button that becomes disabled while it holds focus", () => {
      // `disabled={busy}` flips on right after the press. A -1 element keeps
      // focus it already has. NOTE: jsdom never blurs on native `disabled`
      // either, so this cannot tell -1 from native disabled; the browser
      // check is the real proof. It does catch a remount or a focus() steal.
      const { rerender } = renderWithProvider(<Button>Save</Button>);
      const button = document.querySelector("button") as HTMLElement;
      button.focus();
      expect(document.activeElement).toBe(button);
      rerender(<Button disabled>Save</Button>);
      expect(document.querySelector("button")).toBe(button);
      expect(document.activeElement).toBe(button);
    });
  });
});
