import React, { act, createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  CheckoutContactForm,
  type CheckoutContactFormRef,
  type ContactDraft,
} from "./CheckoutContactForm";

// ── Lightweight mocks ─────────────────────────────────────────────────────
// Translate passthrough so labels/placeholders are stable lookup keys, with an
// ICU-aware stand-in for ONLY the two summary keys (so existing getByLabelText
// lookups by key keep working).
vi.mock("@th/ui", () => ({
  useTranslations:
    () =>
    (key: string, vals?: Record<string, unknown>): string => {
      if (key === "checkout.fieldsNeedAttention") {
        const count = Number(vals?.count ?? 0);
        return count === 1
          ? "1 field still needs your attention"
          : `${count} fields still need your attention`;
      }
      if (key === "checkout.nextField") return "Next field";
      return key;
    },
}));

// The geocode autocomplete hook hits the network — stub it to a quiet shape.
const geoMocks = vi.hoisted(() => ({
  inputRef: { current: null as HTMLInputElement | null },
  dropdownRef: { current: null as HTMLDivElement | null },
}));
vi.mock("@/hooks/use-geocode-suggestions", () => ({
  useGeocodeSuggestions: () => ({
    suggestions: [],
    isFetching: false,
    showDropdown: false,
    activeIdx: -1,
    setActiveIdx: vi.fn(),
    feed: vi.fn(),
    close: vi.fn(),
    reopen: vi.fn(),
    inputRef: geoMocks.inputRef,
    dropdownRef: geoMocks.dropdownRef,
    handleKeyDown: () => false,
  }),
}));
vi.mock("@/components/maps/GeocodeSuggestionDropdown", () => ({
  GeocodeSuggestionDropdown: () => null,
}));

// jsdom doesn't implement scrollIntoView, which showValidationErrors() calls.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// ── Helpers ───────────────────────────────────────────────────────────────
const fillRequiredBilling = () => {
  fireEvent.change(screen.getByLabelText("checkout.fullName"), {
    target: { value: "Jane Doe" },
  });
  fireEvent.change(screen.getByLabelText("checkout.emailAddress"), {
    target: { value: "jane@example.com" },
  });
  fireEvent.change(screen.getByLabelText("checkout.addressLine1"), {
    target: { value: "123 Main St" },
  });
  fireEvent.change(screen.getByLabelText("checkout.city"), {
    target: { value: "San Francisco" },
  });
  // Country must be picked first so the State control becomes a <select>.
  fireEvent.change(screen.getByLabelText("checkout.country"), {
    target: { value: "US" },
  });
  fireEvent.change(screen.getByLabelText("checkout.state"), {
    target: { value: "CA" },
  });
  fireEvent.change(screen.getByLabelText("checkout.postalCode"), {
    target: { value: "94103" },
  });
};

describe("CheckoutContactForm", () => {
  it("commits every field — including the country/state dropdowns — into getBillingAddress()", () => {
    const ref = createRef<CheckoutContactFormRef>();
    render(
      <CheckoutContactForm ref={ref} isSignedIn onSignIn={() => {}} />,
    );

    // Incomplete → null (guards the create-checkout billing requirement).
    expect(ref.current?.getBillingAddress()).toBeNull();

    fillRequiredBilling();

    // The native <select> selections must land in form state, not get dropped.
    expect(ref.current?.getBillingAddress()).toEqual({
      line1: "123 Main St",
      city: "San Francisco",
      state: "CA",
      postalCode: "94103",
      country: "US",
    });
  });

  it("lifts a live draft (with the dropdown selections) on every change", () => {
    const drafts: ContactDraft[] = [];
    render(
      <CheckoutContactForm
        isSignedIn
        onSignIn={() => {}}
        onDraftChange={(d) => drafts.push(d)}
      />,
    );

    fillRequiredBilling();

    const last = drafts.at(-1);
    expect(last).toMatchObject({
      name: "Jane Doe",
      email: "jane@example.com",
      billing: {
        line1: "123 Main St",
        city: "San Francisco",
        state: "CA",
        postalCode: "94103",
        country: "US",
      },
    });
  });

  it("restores a persisted draft on remount (survives step back-and-forward)", () => {
    // Simulate the parent capturing the draft, the details step unmounting,
    // then remounting with that draft fed back through the default* props.
    const ref = createRef<CheckoutContactFormRef>();
    const { unmount } = render(
      <CheckoutContactForm ref={ref} isSignedIn onSignIn={() => {}} />,
    );
    fillRequiredBilling();
    const captured = ref.current?.getBillingAddress();
    expect(captured).not.toBeNull();
    unmount();

    const ref2 = createRef<CheckoutContactFormRef>();
    render(
      <CheckoutContactForm
        ref={ref2}
        isSignedIn
        onSignIn={() => {}}
        defaultName="Jane Doe"
        defaultEmail="jane@example.com"
        defaultBillingAddress={captured!}
      />,
    );

    // Fields come back populated — not a blank form.
    expect(
      (screen.getByLabelText("checkout.addressLine1") as HTMLInputElement)
        .value,
    ).toBe("123 Main St");
    expect(
      (screen.getByLabelText("checkout.country") as HTMLSelectElement).value,
    ).toBe("US");
    expect(
      (screen.getByLabelText("checkout.state") as HTMLSelectElement).value,
    ).toBe("CA");
    expect(ref2.current?.getBillingAddress()).toEqual(captured);
  });

  it("showValidationErrors() reveals inline errors instead of silently failing", () => {
    const ref = createRef<CheckoutContactFormRef>();
    render(
      <CheckoutContactForm ref={ref} isSignedIn onSignIn={() => {}} />,
    );

    // Nothing filled, nothing blurred → no errors shown yet.
    expect(
      screen.getByLabelText("checkout.addressLine1"),
    ).not.toHaveAttribute("aria-invalid", "true");

    act(() => {
      ref.current?.showValidationErrors();
    });

    expect(screen.getByLabelText("checkout.addressLine1")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    // Field-specific copy now renders (not the generic "fieldRequired").
    expect(screen.getByText("checkout.enterFullName")).toBeTruthy();
    expect(screen.getByText("checkout.enterStreetAddress")).toBeTruthy();
  });

  it("reports submitAttempted + the invalid-field count via onValidationStateChange", () => {
    const ref = createRef<CheckoutContactFormRef>();
    const states: { submitAttempted: boolean; invalidCount: number }[] = [];
    render(
      <CheckoutContactForm
        ref={ref}
        isSignedIn
        onSignIn={() => {}}
        onValidationStateChange={(s) => states.push(s)}
      />,
    );

    // Before any submit: not attempted, but the blank signed-in form already
    // has all 7 contact/billing fields invalid.
    expect(states.at(-1)).toEqual({ submitAttempted: false, invalidCount: 7 });

    act(() => {
      ref.current?.showValidationErrors();
    });

    // After submit the flag flips; count is still the full 7 (nothing filled).
    expect(states.at(-1)).toEqual({ submitAttempted: true, invalidCount: 7 });
  });

  it("lowers the reported invalidCount as fields are filled, reaching 0 when valid", () => {
    const states: { submitAttempted: boolean; invalidCount: number }[] = [];
    render(
      <CheckoutContactForm
        isSignedIn
        onSignIn={() => {}}
        onValidationStateChange={(s) => states.push(s)}
      />,
    );

    expect(states.at(-1)?.invalidCount).toBe(7);

    fillRequiredBilling();

    // All required contact + billing fields valid → nothing left to flag.
    expect(states.at(-1)?.invalidCount).toBe(0);
  });

  it("focusNextInvalid() cycles document.activeElement through invalid fields top-to-bottom and wraps", () => {
    vi.useFakeTimers();
    try {
      const ref = createRef<CheckoutContactFormRef>();
      render(<CheckoutContactForm ref={ref} isSignedIn onSignIn={() => {}} />);

      // Reveal errors + seed lastNav/focus on the FIRST invalid field (name).
      act(() => {
        ref.current?.showValidationErrors();
      });
      act(() => {
        vi.advanceTimersByTime(320);
      });
      expect(document.activeElement?.id).toBe("checkout-name");

      // Top-to-bottom order across all 7 fields, then wrap back to the first.
      const order = [
        "checkout-email",
        "checkout-address1",
        "checkout-city",
        "checkout-state",
        "checkout-postal",
        "checkout-country",
        "checkout-name",
      ];
      for (const expected of order) {
        act(() => {
          ref.current?.focusNextInvalid();
        });
        act(() => {
          vi.advanceTimersByTime(320);
        });
        expect(document.activeElement?.id).toBe(expected);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CheckoutContactForm — a field going invalid → valid logs no React style warning", () => {
  it("regression: the State <select> (and the other fields) mix no border shorthand with longhands", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ref = createRef<CheckoutContactFormRef>();
      render(<CheckoutContactForm ref={ref} isSignedIn onSignIn={() => {}} />);
      // Country first, so State is the <select> (id="checkout-state").
      fireEvent.change(screen.getByLabelText("checkout.country"), {
        target: { value: "US" },
      });
      act(() => {
        ref.current?.showValidationErrors();
      });
      const select = screen.getByLabelText("checkout.state");
      expect(select.tagName).toBe("SELECT");
      expect(select).toHaveAttribute("aria-invalid", "true");

      // Invalid → valid: React drops the error longhands from the style.
      fireEvent.change(select, { target: { value: "CA" } });
      expect(select).toHaveAttribute("aria-invalid", "false");
      fireEvent.change(screen.getByLabelText("checkout.city"), {
        target: { value: "San Francisco" },
      });

      // React logs a FORMAT string: "%s a style property during rerender
      // (%s) when a conflicting property is set (%s)…" — "%s" is "Removing".
      const styleWarnings = errorSpy.mock.calls
        .filter((call) =>
          String(call[0]).includes("a style property during rerender"),
        )
        .map((call) => call.slice(1, 4).join(" "));
      expect(styleWarnings).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// A saved profile: the form arrives complete, so mobile auto-collapses it.
const renderArrivedComplete = () =>
  render(
    <CheckoutContactForm
      isSignedIn
      onSignIn={() => {}}
      defaultName="Jane Doe"
      defaultEmail="jane@example.com"
      defaultBillingAddress={{
        line1: "123 Main St",
        city: "San Francisco",
        state: "CA",
        postalCode: "94103",
        country: "US",
      }}
    />,
  );

describe("CheckoutContactForm — the mobile summary never collapses the form under the buyer", () => {
  // The collapse is gated on a ≤720px viewport; jsdom defaults to 1024.
  const realInnerWidth = window.innerWidth;
  const setInnerWidth = (w: number) =>
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: w,
    });
  // The summary toggle is the only element with this class. Once shown it stays
  // mounted (a disclosure button); "collapsed" is its aria-expanded="false".
  // jsdom ignores the media query that hides the full form.
  const summaryToggle = () =>
    document.querySelector<HTMLButtonElement>(".billing-collapsed-summary");
  const collapsedSummary = () =>
    document.querySelector('.billing-collapsed-summary[aria-expanded="false"]');

  // Focus each field before changing it, as a real tap-and-type does.
  const typeInto = (label: string, value: string) => {
    const el = screen.getByLabelText(label) as HTMLInputElement;
    act(() => el.focus());
    fireEvent.change(el, { target: { value } });
    return el;
  };

  it("typing the last field's final character keeps the form open and the focus in that field", () => {
    setInnerWidth(390);
    try {
      render(<CheckoutContactForm isSignedIn onSignIn={() => {}} />);
      typeInto("checkout.fullName", "Jane Doe");
      typeInto("checkout.emailAddress", "jane@example.com");
      typeInto("checkout.addressLine1", "123 Main St");
      typeInto("checkout.city", "San Francisco");
      typeInto("checkout.country", "US");
      typeInto("checkout.state", "CA");
      typeInto("checkout.postalCode", "9410");
      expect(summaryToggle()).toBeNull();

      // The keystroke that completes the form.
      const zip = typeInto("checkout.postalCode", "94103");
      expect(summaryToggle()).toBeNull();
      expect(document.activeElement).toBe(zip);
    } finally {
      setInnerWidth(realInnerWidth);
    }
  });

  it("a form that arrives complete (saved profile) still shows the summary; re-typing a field after expanding does not re-collapse it", () => {
    setInnerWidth(390);
    try {
      renderArrivedComplete();
      const summary = collapsedSummary();
      expect(summary).not.toBeNull();

      // Explicit action: tapping the summary expands the form.
      fireEvent.click(summary!);
      expect(collapsedSummary()).toBeNull();

      // Clear the ZIP (form incomplete), then type the first character back:
      // the form is "complete" again mid-entry and must stay open.
      typeInto("checkout.postalCode", "");
      const zip = typeInto("checkout.postalCode", "9");
      expect(collapsedSummary()).toBeNull();
      expect(document.activeElement).toBe(zip);
    } finally {
      setInnerWidth(realInnerWidth);
    }
  });
});

describe("CheckoutContactForm — the mobile summary is a disclosure toggle", () => {
  const realInnerWidth = window.innerWidth;
  const setInnerWidth = (w: number) =>
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: w,
    });

  const toggle = () =>
    document.querySelector<HTMLButtonElement>(".billing-collapsed-summary")!;

  it("flips aria-expanded and keeps the same focused button across expand and collapse", () => {
    setInnerWidth(390);
    try {
      renderArrivedComplete();
      const btn = toggle();
      expect(btn).not.toBeNull();
      expect(btn).toHaveAttribute("aria-expanded", "false");

      act(() => btn.focus());
      fireEvent.click(btn);
      expect(toggle()).toBe(btn);
      expect(btn).toHaveAttribute("aria-expanded", "true");
      expect(document.activeElement).toBe(btn);

      fireEvent.click(btn);
      expect(toggle()).toBe(btn);
      expect(btn).toHaveAttribute("aria-expanded", "false");
      expect(document.activeElement).toBe(btn);
    } finally {
      setInnerWidth(realInnerWidth);
    }
  });

  it("aria-controls resolves to the billing form region, which carries the collapsed flag", () => {
    setInnerWidth(390);
    try {
      renderArrivedComplete();
      const btn = toggle();
      const id = btn.getAttribute("aria-controls");
      expect(id).toBeTruthy();
      const region = document.getElementById(id!);
      expect(region).not.toBeNull();
      expect(region).toContainElement(screen.getByLabelText("checkout.city"));
      expect(region).toHaveAttribute("data-collapsed", "true");

      fireEvent.click(btn);
      expect(region).not.toHaveAttribute("data-collapsed");
    } finally {
      setInnerWidth(realInnerWidth);
    }
  });
});

describe("CheckoutContactForm — the summary text shows only the parts present", () => {
  it("a cleared city leaves no empty ', ,' slot in the address line", () => {
    const realInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 390,
    });
    try {
      renderArrivedComplete();
      const btn = document.querySelector<HTMLButtonElement>(
        ".billing-collapsed-summary",
      )!;
      fireEvent.click(btn);
      fireEvent.change(screen.getByLabelText("checkout.city"), {
        target: { value: "" },
      });
      expect(btn.textContent).not.toMatch(/,\s*,/);
      expect(btn.textContent).toContain("123 Main St, CA 94103");

      fireEvent.change(screen.getByLabelText("checkout.emailAddress"), {
        target: { value: "" },
      });
      expect(btn.textContent).not.toContain("·");
      expect(btn.textContent).toContain("Jane Doe");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: realInnerWidth,
      });
    }
  });
});
