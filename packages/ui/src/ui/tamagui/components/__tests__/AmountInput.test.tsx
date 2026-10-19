import { fireEvent, screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { AmountInput } from "../forms/AmountInput";

describe("AmountInput", () => {
  it("renders a plain input identically to TextInput when no prefix/suffix given", () => {
    renderWithProvider(<AmountInput placeholder="Amount" />);

    expect(screen.getByPlaceholderText("Amount")).toBeInTheDocument();
    expect(screen.queryByText("$")).not.toBeInTheDocument();
    expect(screen.queryByText("%")).not.toBeInTheDocument();
  });

  it("renders a leading currency symbol without a separate floating element", () => {
    renderWithProvider(<AmountInput placeholder="10.00" prefix="$" />);

    expect(screen.getByText("$")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("10.00")).toBeInTheDocument();
  });

  it("renders a trailing symbol (e.g. percent) independent of prefix", () => {
    renderWithProvider(<AmountInput placeholder="20" suffix="%" />);

    expect(screen.getByText("%")).toBeInTheDocument();
    expect(screen.queryByText("$")).not.toBeInTheDocument();
  });

  it("can render both a leading and trailing symbol at once", () => {
    renderWithProvider(<AmountInput placeholder="10.00" prefix="$" suffix="USD" />);

    expect(screen.getByText("$")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
  });

  it("pads the input to clear the prefix glyph instead of leaving it as a sibling gap", () => {
    renderWithProvider(<AmountInput placeholder="10.00" prefix="$" />);

    const input = screen.getByPlaceholderText("10.00");
    // Tamagui compiles space tokens into atomic classes rather than inline
    // styles, so assert on the class (same technique TextInput.test.tsx uses
    // for border tokens). "$6" (32px) is the same clearance TextInput's own
    // right-side status icon uses — so typed text never sits under the glyph.
    expect(input.className).toMatch(/_paddingLeft-\S*space-6/);
  });

  it("leaves the input's own default padding untouched when no prefix/suffix is given", () => {
    renderWithProvider(<AmountInput placeholder="Amount" />);

    const input = screen.getByPlaceholderText("Amount");
    // TextInput's own base `paddingHorizontal: "$3"` — unaffected by the
    // affix-clearance override, which only applies when prefix/suffix is set.
    expect(input.className).toMatch(/_paddingLeft-\S*space-3/);
    // And no imperative override should have been written either.
    expect(input.style.paddingLeft).toBe("");
  });

  // Regression test for a real (browser-only, not jsdom-visible) bug: a
  // global `apps/web/src/app/globals.css` reset —
  // `input:not([type=...])... { padding: 10px 14px; }` — has higher CSS
  // specificity (0,6,1) than Tamagui's atomic padding classes (0,2,0), so the
  // Tamagui `paddingLeft="$6"` prop above silently LOST the cascade in a real
  // browser (confirmed via `getComputedStyle`: 14px, not 32px) and the "$"
  // visually overlapped the input's placeholder/value. The imperative
  // `!important` inline-style patch is what actually wins.
  it("writes an !important inline padding-left so it beats the global input reset in a real browser", () => {
    renderWithProvider(<AmountInput placeholder="10.00" prefix="$" />);

    const input = screen.getByPlaceholderText("10.00") as HTMLInputElement;
    expect(input.style.paddingLeft).toBe("32px");
    expect(input.style.getPropertyPriority("padding-left")).toBe("important");
  });

  it("writes an !important inline padding-right for a trailing symbol", () => {
    renderWithProvider(<AmountInput placeholder="20" suffix="%" />);

    const input = screen.getByPlaceholderText("20") as HTMLInputElement;
    expect(input.style.paddingRight).toBe("32px");
    expect(input.style.getPropertyPriority("padding-right")).toBe(
      "important",
    );
  });

  // Regression test for PromoFormDialog's AMOUNT↔PERCENT kind toggle, which
  // re-renders a live-mounted AmountInput from prefix="$" to suffix="%" (not
  // a fresh mount) — exercising patchAffixClearance's cleanup path
  // (removeProperty) alongside its apply path (setProperty), not just the
  // apply path in isolation like the tests above.
  it("clears the old side's !important padding and applies the new side's when prefix/suffix swap on an existing instance", () => {
    const { rerender } = renderWithProvider(
      <AmountInput placeholder="amount" prefix="$" />,
    );

    const input = screen.getByPlaceholderText("amount") as HTMLInputElement;
    expect(input.style.paddingLeft).toBe("32px");
    expect(input.style.getPropertyPriority("padding-left")).toBe("important");
    expect(input.style.paddingRight).toBe("");

    rerender(<AmountInput placeholder="amount" suffix="%" />);

    expect(input.style.paddingLeft).toBe("");
    expect(input.style.paddingRight).toBe("32px");
    expect(input.style.getPropertyPriority("padding-right")).toBe(
      "important",
    );
  });

  // The default clearance is sized for ONE glyph. A multi-character affix — the
  // entity-page slug's "/p/" stem is the live call site — needs more, or the
  // typed value starts underneath the prefix. These three branches shipped with
  // no coverage; the `status` one below is the dangerous one.
  it("reserves a wider clearance for a multi-character prefix", () => {
    renderWithProvider(
      <AmountInput placeholder="my-page" prefix="/p/" prefixClearance={46} />,
    );

    const input = screen.getByPlaceholderText("my-page") as HTMLInputElement;
    expect(input.style.paddingLeft).toBe("46px");
    expect(input.style.getPropertyPriority("padding-left")).toBe("important");
  });

  it("reserves a wider clearance for a multi-character suffix", () => {
    renderWithProvider(
      <AmountInput placeholder="10.00" suffix="USD" suffixClearance={52} />,
    );

    const input = screen.getByPlaceholderText("10.00") as HTMLInputElement;
    expect(input.style.paddingRight).toBe("52px");
    expect(input.style.getPropertyPriority("padding-right")).toBe("important");
  });

  // `status` puts TextInput's own 16px icon in the right inset, and TextInput
  // asks for the clearance via a Tamagui class the global `input:not([type=…])`
  // reset outranks. Since this component is already patching padding
  // imperatively, it has to patch the right side too — otherwise the typed
  // value slides under the status icon. Pinned here because the branch is
  // currently INERT (no call site passes `status` with a prefix yet), so the
  // next money field that adds validation feedback would otherwise gain — or
  // silently lose — 32px of right padding with nothing to catch it.
  it("clears TextInput's status icon on the right when a status is set without a suffix", () => {
    renderWithProvider(
      <AmountInput placeholder="my-page" prefix="/p/" status="success" />,
    );

    const input = screen.getByPlaceholderText("my-page") as HTMLInputElement;
    expect(input.style.paddingRight).toBe("32px");
    expect(input.style.getPropertyPriority("padding-right")).toBe("important");
  });

  it("writes no right padding when there is neither a suffix nor a status", () => {
    renderWithProvider(<AmountInput placeholder="10.00" prefix="$" />);

    const input = screen.getByPlaceholderText("10.00") as HTMLInputElement;
    expect(input.style.paddingRight).toBe("");
  });

  it("forwards value/onChangeText like a plain TextInput", () => {
    const onChangeText = vi.fn();
    renderWithProvider(
      <AmountInput placeholder="10.00" prefix="$" value="5" onChangeText={onChangeText} />,
    );

    const input = screen.getByPlaceholderText("10.00") as HTMLInputElement;
    expect(input.value).toBe("5");
    fireEvent.change(input, { target: { value: "5.50" } });
    expect(onChangeText).toHaveBeenCalledWith("5.50");
  });

  it("forwards disabled to the underlying input", () => {
    renderWithProvider(<AmountInput placeholder="10.00" prefix="$" disabled />);

    expect(screen.getByPlaceholderText("10.00")).toBeDisabled();
  });

  it("expands to full width like TextInput when requested", () => {
    renderWithProvider(<AmountInput placeholder="10.00" prefix="$" fullWidth />);

    expect(screen.getByPlaceholderText("10.00")).toHaveStyle({
      width: "100%",
    });
  });
});
