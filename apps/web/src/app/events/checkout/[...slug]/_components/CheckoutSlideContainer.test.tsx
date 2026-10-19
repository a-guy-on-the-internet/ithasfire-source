import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CheckoutSlideContainer } from "./CheckoutSlideContainer";

// The three height-floor tests that used to live here went with the floor
// itself — it was measured to bridge nothing and to snap the taller details
// step down after the fade. See the component doc. What is left is the
// contract that survives: the animated child is KEYED on the step, which is
// what replays the entrance, and the class follows the direction.
describe("CheckoutSlideContainer", () => {
  it("keys the animated child on the step so the entrance replays", () => {
    const { container, rerender } = render(
      <CheckoutSlideContainer stepKey="details" direction="forward">
        <p>details</p>
      </CheckoutSlideContainer>,
    );
    const first = container.querySelector(".th-checkout-slide-forward");
    expect(first).not.toBeNull();

    rerender(
      <CheckoutSlideContainer stepKey="payment" direction="forward">
        <p>payment</p>
      </CheckoutSlideContainer>,
    );
    const second = container.querySelector(".th-checkout-slide-forward");
    expect(second).not.toBeNull();
    // A NEW node: same class, different element, so the CSS animation restarts
    // rather than being skipped as already-played.
    expect(second).not.toBe(first);
  });

  it("maps each direction to its animation class", () => {
    const { container, rerender } = render(
      <CheckoutSlideContainer stepKey="a" direction="forward">
        <p>a</p>
      </CheckoutSlideContainer>,
    );
    expect(container.querySelector(".th-checkout-slide-forward")).not.toBeNull();

    rerender(
      <CheckoutSlideContainer stepKey="b" direction="back">
        <p>b</p>
      </CheckoutSlideContainer>,
    );
    expect(container.querySelector(".th-checkout-slide-back")).not.toBeNull();

    rerender(
      <CheckoutSlideContainer stepKey="c" direction="fade">
        <p>c</p>
      </CheckoutSlideContainer>,
    );
    expect(container.querySelector(".th-checkout-fade-in")).not.toBeNull();
  });

  it("never pins a height — a late step reserves its own, the container does not", () => {
    // Regression guard for the floor that was removed. Holding the outgoing
    // height here snapped the taller details step down 64px at 320px, fully
    // opaque, 300ms after the fade finished.
    const { container, rerender } = render(
      <CheckoutSlideContainer stepKey="details" direction="forward">
        <p>details</p>
      </CheckoutSlideContainer>,
    );
    rerender(
      <CheckoutSlideContainer stepKey="payment" direction="forward">
        <p>payment</p>
      </CheckoutSlideContainer>,
    );

    for (const el of container.querySelectorAll<HTMLElement>("*")) {
      expect(el.style.minHeight).toBe("");
    }
  });
});
