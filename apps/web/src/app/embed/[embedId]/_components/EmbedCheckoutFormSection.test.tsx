import React, { act, createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Heavy / external deps stubbed so the presentational contract is what's under
// test, not Turnstile / Stripe / the shared design-system primitives.
vi.mock("@marsidev/react-turnstile", () => ({
  Turnstile: () => <div data-testid="turnstile" />,
}));
vi.mock("@th/ui", () => ({
  FormErrorBanner: ({ message }: { message: string | null }) =>
    message ? <div role="alert">{message}</div> : null,
  Spinner: () => <span data-testid="spinner" />,
  // Minimal ICU-aware stand-in for the keys this component renders, so the
  // tests assert real copy rather than raw keys.
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
vi.mock("./EmbedPromoCodeInput", () => ({
  EmbedPromoCodeInput: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="promo" data-disabled={String(Boolean(disabled))} />
  ),
}));
vi.mock(
  "@/app/events/checkout/[...slug]/_components/RefundDisclosure",
  () => ({
    RefundDisclosure: () => <div data-testid="refund-disclosure" />,
  }),
);
// The address autocomplete goes through the REAL useGeocodeSuggestions hook
// and GeocodeSuggestionDropdown — only the network layer (Geoapify fetch) is
// stubbed, so the tests exercise the debounce → suggest → select wiring.
const geocodeMocks = vi.hoisted(() => ({
  forwardGeocode: vi.fn(),
}));
vi.mock("@/lib/maps/geocoding", () => ({
  forwardGeocode: geocodeMocks.forwardGeocode,
}));

// The bot check is off unless a test turns it on (as with no site key).
const botCheck = vi.hoisted(() => ({ siteKey: "" }));
vi.mock("./embed-helpers", async (original) => {
  const real = await original<typeof import("./embed-helpers")>();
  return {
    ...real,
    get TURNSTILE_SITE_KEY() {
      return botCheck.siteKey;
    },
  };
});

import { EmbedCheckoutFormSection } from "./EmbedCheckoutFormSection";
import type {
  EmbedCheckoutFieldErrors,
  EmbedCheckoutFormSectionProps,
} from "./embed-checkout-types";

const NO_ERRORS: EmbedCheckoutFieldErrors = {
  name: null,
  email: null,
  line1: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
};

function buildProps(
  overrides: Partial<EmbedCheckoutFormSectionProps> = {},
): EmbedCheckoutFormSectionProps {
  return {
    guestName: "",
    guestEmail: "",
    onGuestNameChange: vi.fn(),
    onGuestEmailChange: vi.fn(),
    promoCodes: [],
    handleApplyPromoCode: vi.fn(),
    handleRemovePromoCode: vi.fn(),
    isCreating: false,
    billingLine1: "",
    billingLine2: "",
    billingCity: "",
    billingState: "",
    billingPostalCode: "",
    billingCountry: "US",
    onBillingLine1Change: vi.fn(),
    onBillingLine2Change: vi.fn(),
    onBillingCityChange: vi.fn(),
    onBillingStateChange: vi.fn(),
    onBillingPostalCodeChange: vi.fn(),
    onBillingCountryChange: vi.fn(),
    requiresWaiver: false,
    waiverBody: null,
    waiverAccepted: false,
    onWaiverAcceptedChange: vi.fn(),
    termsAccepted: false,
    onTermsAcceptedChange: vi.fn(),
    refundPolicyAccepted: false,
    onRefundPolicyAcceptedChange: vi.fn(),
    refundDisclosureCart: [],
    checkoutError: null,
    turnstileRef: createRef(),
    turnstileToken: null,
    onTurnstileSuccess: vi.fn(),
    onTurnstileExpire: vi.fn(),
    onTurnstileError: vi.fn(),
    handleCreateCheckout: vi.fn(),
    isFormValid: false,
    isFreeOrder: false,
    fieldErrors: NO_ERRORS,
    onFieldBlur: vi.fn(),
    submitAttempted: false,
    waiverError: null,
    acceptanceError: null,
    invalidFieldCount: 0,
    onFocusNextInvalid: vi.fn(),
    ...overrides,
  };
}

describe("EmbedCheckoutFormSection — inline validation", () => {
  it("renders no field error text and no aria-invalid when there are no errors", () => {
    render(<EmbedCheckoutFormSection {...buildProps()} />);
    expect(screen.queryByText("This field is required.")).toBeNull();
    expect(
      document.querySelector('input[aria-invalid="true"]'),
    ).toBeNull();
  });

  it("shows the per-field message and sets aria-invalid when a field has an error", () => {
    render(
      <EmbedCheckoutFormSection
        {...buildProps({
          fieldErrors: {
            ...NO_ERRORS,
            name: "This field is required.",
            email: "Please enter a valid email address.",
            city: "This field is required.",
          },
        })}
      />,
    );
    expect(screen.getAllByText("This field is required.").length).toBe(2);
    expect(
      screen.getByText("Please enter a valid email address."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Email address")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Full name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("keeps the submit button CLICKABLE (not disabled) when the form is invalid, so the click can reveal errors", () => {
    const handleCreateCheckout = vi.fn();
    render(
      <EmbedCheckoutFormSection
        {...buildProps({ isFormValid: false, handleCreateCheckout })}
      />,
    );
    const button = screen.getByRole("button", { name: /continue to payment/i });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(handleCreateCheckout).toHaveBeenCalledTimes(1);
  });

  it("disables the button and shows the processing state only while creating", () => {
    render(<EmbedCheckoutFormSection {...buildProps({ isCreating: true })} />);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(screen.getByText("Processing...")).toBeTruthy();
  });

  it("fires onFieldBlur with the field key when a required field is blurred", () => {
    const onFieldBlur = vi.fn();
    render(<EmbedCheckoutFormSection {...buildProps({ onFieldBlur })} />);
    fireEvent.blur(screen.getByLabelText("Full name"));
    expect(onFieldBlur).toHaveBeenCalledWith("name");
    fireEvent.blur(screen.getByLabelText("Postal code"));
    expect(onFieldBlur).toHaveBeenCalledWith("postalCode");
  });

  it("surfaces the waiver gate as a role=alert note and rings the block", () => {
    render(
      <EmbedCheckoutFormSection
        {...buildProps({
          requiresWaiver: true,
          waiverBody: "You waive everything.",
          waiverError: "Please accept the waiver to continue.",
        })}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Please accept the waiver to continue.");
  });

  it("surfaces the terms/refund gate as a role=alert note above the disclosure", () => {
    render(
      <EmbedCheckoutFormSection
        {...buildProps({
          acceptanceError:
            "Please accept the terms and refund policy to continue.",
        })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Please accept the terms and refund policy to continue.",
    );
  });
});

describe("EmbedCheckoutFormSection — while the order is being created", () => {
  const email = () =>
    screen.getByLabelText("Email address") as HTMLInputElement;

  it("D2 regression: the email is read-only and a change to it is not reported (the page's checkout key follows the email)", () => {
    const onGuestEmailChange = vi.fn();
    render(
      <EmbedCheckoutFormSection
        {...buildProps({
          isCreating: true,
          guestEmail: "buyer@example.com",
          onGuestEmailChange,
        })}
      />,
    );

    expect(email().readOnly).toBe(true);
    // Readable and focusable, unlike a disabled field.
    expect(email().disabled).toBe(false);
    expect(email().value).toBe("buyer@example.com");
    // A change event that gets through anyway (autofill, a script).
    fireEvent.change(email(), { target: { value: "other@example.com" } });
    expect(onGuestEmailChange).not.toHaveBeenCalled();
  });

  it("the email takes edits again once the request has ended", () => {
    const onGuestEmailChange = vi.fn();
    render(
      <EmbedCheckoutFormSection
        {...buildProps({ guestEmail: "buyer@example.com", onGuestEmailChange })}
      />,
    );

    expect(email().readOnly).toBe(false);
    fireEvent.change(email(), { target: { value: "other@example.com" } });
    expect(onGuestEmailChange).toHaveBeenCalledWith("other@example.com");
  });
});

describe("EmbedCheckoutFormSection — a Continue that waits on the bot check", () => {
  const CAPTION = "Complete the verification to continue";
  beforeEach(() => {
    botCheck.siteKey = "site-key";
  });
  afterEach(() => {
    botCheck.siteKey = "";
  });

  // The form is "submitting" from the press (`isCreating`, which the checkout
  // sets for the wait and for the request alike): the order goes out with
  // what the email and promo inputs hold when the token arrives, so they
  // lock at the press. EmbedCheckout.test.tsx drives the wait itself.
  it("submitting, token still to come: the button shows as working, the email and the promo input are locked, and the name still takes edits", () => {
    const onGuestEmailChange = vi.fn();
    const onGuestNameChange = vi.fn();
    render(
      <EmbedCheckoutFormSection
        {...buildProps({
          isCreating: true,
          guestEmail: "jane@gmial.com",
          onGuestEmailChange,
          onGuestNameChange,
        })}
      />,
    );

    expect(screen.getByRole("button", { name: /Processing/ })).toBeDisabled();
    const email = screen.getByLabelText("Email address") as HTMLInputElement;
    expect(email.readOnly).toBe(true);
    fireEvent.change(email, { target: { value: "jane@gmail.co" } });
    expect(onGuestEmailChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("promo").getAttribute("data-disabled")).toBe(
      "true",
    );
    // Not in the checkout key, and not what the order is priced from.
    fireEvent.change(screen.getByLabelText("Full name"), {
      target: { value: "Jane D" },
    });
    expect(onGuestNameChange).toHaveBeenCalledWith("Jane D");
    // Still only a caption while the wait is on.
    expect(screen.getByText(CAPTION).getAttribute("role")).toBeNull();
  });

  it("the wait ended with no token: the email and the promo input take edits again, beside the alert", () => {
    const onGuestEmailChange = vi.fn();
    render(
      <EmbedCheckoutFormSection
        {...buildProps({
          isCreating: false,
          submitAttempted: true,
          guestEmail: "jane@gmial.com",
          onGuestEmailChange,
        })}
      />,
    );

    const email = screen.getByLabelText("Email address") as HTMLInputElement;
    expect(email.readOnly).toBe(false);
    fireEvent.change(email, { target: { value: "jane@gmail.com" } });
    expect(onGuestEmailChange).toHaveBeenCalledWith("jane@gmail.com");
    expect(screen.getByTestId("promo").getAttribute("data-disabled")).toBe(
      "false",
    );
    expect(screen.getByRole("alert").textContent).toBe(CAPTION);
  });

  it("before any Continue the caption is a caption; after one that the missing verification stopped, it is the reason, as an alert", () => {
    const { rerender } = render(
      <EmbedCheckoutFormSection {...buildProps()} />,
    );
    expect(screen.getByText(CAPTION).getAttribute("role")).toBeNull();

    rerender(
      <EmbedCheckoutFormSection {...buildProps({ submitAttempted: true })} />,
    );
    expect(screen.getByRole("alert").textContent).toBe(CAPTION);

    // Verified: nothing left to say.
    rerender(
      <EmbedCheckoutFormSection
        {...buildProps({ submitAttempted: true, turnstileToken: "token" })}
      />,
    );
    expect(screen.queryByText(CAPTION)).toBeNull();
  });
});

describe("EmbedCheckoutFormSection — billing address autocomplete", () => {
  const SUGGESTION = {
    lat: 36.1512,
    lng: -86.7837,
    formattedAddress: "123 Main St, Nashville, TN 37203, United States",
    streetLine: "123 Main St",
    locality: "Nashville",
    region: "Tennessee",
    regionCode: "TN",
    countryCode: "US",
    postalCode: "37203",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    geocodeMocks.forwardGeocode.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Type into line1 and let the debounce + geocode promise settle. */
  const typeAndSettle = async (value: string) => {
    fireEvent.change(screen.getByLabelText("Address line 1"), {
      target: { value },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  };

  it("surfaces geocode suggestions after typing 3+ characters", async () => {
    geocodeMocks.forwardGeocode.mockResolvedValue([SUGGESTION]);
    render(<EmbedCheckoutFormSection {...buildProps()} />);

    await typeAndSettle("123 Main");

    // `useGeocodeSuggestions` now passes an AbortSignal so a superseded
    // lookup is cancelled, not merely ignored — the query is still arg 0.
    expect(geocodeMocks.forwardGeocode).toHaveBeenCalledWith(
      "123 Main",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(
      screen.getByTestId("embed-billing-line1-suggestion-0"),
    ).toHaveTextContent("123 Main St");
    expect(screen.getByLabelText("Address line 1")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("does not open the dropdown or hit the geocoder below 3 characters", async () => {
    geocodeMocks.forwardGeocode.mockResolvedValue([SUGGESTION]);
    render(<EmbedCheckoutFormSection {...buildProps()} />);

    await typeAndSettle("12");

    expect(geocodeMocks.forwardGeocode).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("autofills line1/city/state/postal/country from a clicked suggestion — country BEFORE state so the parent's country-change clear can't wipe the region", async () => {
    geocodeMocks.forwardGeocode.mockResolvedValue([SUGGESTION]);
    const onBillingLine1Change = vi.fn();
    const onBillingCityChange = vi.fn();
    const onBillingStateChange = vi.fn();
    const onBillingPostalCodeChange = vi.fn();
    const onBillingCountryChange = vi.fn();
    render(
      <EmbedCheckoutFormSection
        {...buildProps({
          onBillingLine1Change,
          onBillingCityChange,
          onBillingStateChange,
          onBillingPostalCodeChange,
          onBillingCountryChange,
        })}
      />,
    );

    await typeAndSettle("123 Main");
    fireEvent.click(screen.getByTestId("embed-billing-line1-suggestion-0"));

    expect(onBillingLine1Change).toHaveBeenLastCalledWith("123 Main St");
    expect(onBillingCityChange).toHaveBeenCalledWith("Nashville");
    expect(onBillingStateChange).toHaveBeenCalledWith("TN");
    expect(onBillingPostalCodeChange).toHaveBeenCalledWith("37203");
    expect(onBillingCountryChange).toHaveBeenCalledWith("US");
    // The parent (EmbedCheckout) clears billingState whenever the country
    // changes — committing country first keeps the fresh region code.
    expect(onBillingCountryChange.mock.invocationCallOrder[0]).toBeLessThan(
      onBillingStateChange.mock.invocationCallOrder[0]!,
    );
  });

  it("falls back to formattedAddress + region name when street/regionCode are missing", async () => {
    geocodeMocks.forwardGeocode.mockResolvedValue([
      {
        ...SUGGESTION,
        streetLine: null,
        regionCode: null,
        region: "Ontario",
        countryCode: null,
        postalCode: null,
        locality: null,
      },
    ]);
    const onBillingLine1Change = vi.fn();
    const onBillingCityChange = vi.fn();
    const onBillingStateChange = vi.fn();
    const onBillingPostalCodeChange = vi.fn();
    const onBillingCountryChange = vi.fn();
    render(
      <EmbedCheckoutFormSection
        {...buildProps({
          onBillingLine1Change,
          onBillingCityChange,
          onBillingStateChange,
          onBillingPostalCodeChange,
          onBillingCountryChange,
        })}
      />,
    );

    await typeAndSettle("123 Main");
    fireEvent.click(screen.getByTestId("embed-billing-line1-suggestion-0"));

    expect(onBillingLine1Change).toHaveBeenLastCalledWith(
      SUGGESTION.formattedAddress,
    );
    expect(onBillingStateChange).toHaveBeenCalledWith("Ontario");
    expect(onBillingCityChange).not.toHaveBeenCalled();
    expect(onBillingPostalCodeChange).not.toHaveBeenCalled();
    expect(onBillingCountryChange).not.toHaveBeenCalled();
  });

  it("closes the dropdown after a suggestion is selected", async () => {
    geocodeMocks.forwardGeocode.mockResolvedValue([SUGGESTION]);
    render(<EmbedCheckoutFormSection {...buildProps()} />);

    await typeAndSettle("123 Main");
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.click(screen.getByTestId("embed-billing-line1-suggestion-0"));

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByLabelText("Address line 1")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

describe("EmbedCheckoutFormSection — validation summary", () => {
  it("does not render the summary before a submit attempt, even with invalid fields", () => {
    render(
      <EmbedCheckoutFormSection
        {...buildProps({ submitAttempted: false, invalidFieldCount: 3 })}
      />,
    );
    expect(screen.queryByText(/need(s)? your attention/)).toBeNull();
    expect(screen.queryByRole("button", { name: /next field/i })).toBeNull();
  });

  it("shows a singular summary with NO Next control for a single invalid field", () => {
    render(
      <EmbedCheckoutFormSection
        {...buildProps({ submitAttempted: true, invalidFieldCount: 1 })}
      />,
    );
    expect(
      screen.getByText("1 field still needs your attention"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /next field/i })).toBeNull();
  });

  it("offers a Next control for multiple invalid fields and fires onFocusNextInvalid", () => {
    const onFocusNextInvalid = vi.fn();
    render(
      <EmbedCheckoutFormSection
        {...buildProps({
          submitAttempted: true,
          invalidFieldCount: 3,
          onFocusNextInvalid,
        })}
      />,
    );
    expect(
      screen.getByText("3 fields still need your attention"),
    ).toBeTruthy();
    const next = screen.getByRole("button", { name: /next field/i });
    fireEvent.click(next);
    expect(onFocusNextInvalid).toHaveBeenCalledTimes(1);
  });
});

describe("EmbedCheckoutFormSection — a note under the checkout error", () => {
  const note = <p data-testid="error-note">also true</p>;

  it("prints the note right under the error, while there is an error", () => {
    render(
      <EmbedCheckoutFormSection
        {...buildProps({
          checkoutError: "Those seats are no longer available.",
          checkoutErrorNote: note,
        })}
      />,
    );
    const error = screen.getByRole("alert");
    expect(error.textContent).toBe("Those seats are no longer available.");
    // The server's error as it came, and the note as its next sibling.
    expect(error.nextElementSibling).toBe(screen.getByTestId("error-note"));
  });

  it("no error: no note (it explains an error, it is not a banner of its own)", () => {
    render(
      <EmbedCheckoutFormSection
        {...buildProps({ checkoutError: null, checkoutErrorNote: note })}
      />,
    );
    expect(screen.queryByTestId("error-note")).toBeNull();
  });
});
