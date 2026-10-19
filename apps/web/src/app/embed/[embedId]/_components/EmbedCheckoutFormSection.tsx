"use client";

import type { CSSProperties } from "react";
import { ChevronDown, ChevronRight, User } from "lucide-react";
import { Turnstile } from "@marsidev/react-turnstile";
import { FormErrorBanner, Spinner, useTranslations } from "@th/ui";

import type { EmbedCheckoutFormSectionProps } from "./embed-checkout-types";
import { TURNSTILE_SITE_KEY } from "./embed-helpers";
import {
  BORDER_SUBTLE,
  DANGER,
  DANGER_BG,
  STEEL_BLUE,
  SURFACE_MUTED,
  TEXT,
  TEXT_CAPTION,
  TEXT_MUTED,
  TEXT_ON_BRAND,
  inputStyle,
  primaryButtonDisabledStyle,
  primaryButtonStyle,
  sectionLabelStyle,
} from "./embed-theme";
import { useGeocodeSuggestions } from "@/hooks/use-geocode-suggestions";
import { GeocodeSuggestionDropdown } from "@/components/maps/GeocodeSuggestionDropdown";
import { GeocodeStatusHint } from "@/components/maps/GeocodeStatusHint";
import type { GeocodingResult } from "@/lib/maps/geocoding";
import { EmbedPromoCodeInput } from "./EmbedPromoCodeInput";
import { CURRENT_TERMS_VERSION } from "@/lib/legal-constants";
import { RefundDisclosure } from "@/app/events/checkout/[...slug]/_components/RefundDisclosure";
import {
  COUNTRIES,
  getRegionsForCountry,
} from "@/app/events/checkout/[...slug]/_components/address-data";

export function EmbedCheckoutFormSection({
  guestName,
  guestEmail,
  onGuestNameChange,
  onGuestEmailChange,
  promoCodes,
  handleApplyPromoCode,
  handleRemovePromoCode,
  isCreating,
  billingLine1,
  billingLine2,
  billingCity,
  billingState,
  billingPostalCode,
  billingCountry,
  onBillingLine1Change,
  onBillingLine2Change,
  onBillingCityChange,
  onBillingStateChange,
  onBillingPostalCodeChange,
  onBillingCountryChange,
  requiresWaiver,
  waiverBody,
  waiverAccepted,
  onWaiverAcceptedChange,
  termsAccepted,
  onTermsAcceptedChange,
  refundPolicyAccepted,
  onRefundPolicyAcceptedChange,
  refundDisclosureCart,
  checkoutError,
  checkoutErrorNote,
  turnstileRef,
  turnstileToken,
  onTurnstileSuccess,
  onTurnstileExpire,
  onTurnstileError,
  handleCreateCheckout,
  isFormValid: _isFormValid,
  isFreeOrder,
  fieldErrors,
  onFieldBlur,
  submitAttempted,
  waiverError,
  acceptanceError,
  invalidFieldCount,
  onFocusNextInvalid,
  submitHiddenBehindFixedBar = false,
}: EmbedCheckoutFormSectionProps) {
  const t = useTranslations();
  const regionOptions = getRegionsForCountry(billingCountry);

  // ── Inline address autocomplete (shared hook, parity with the main
  //    checkout's CheckoutContactForm) ─────────────────────────────────
  const geo = useGeocodeSuggestions({ minQueryLength: 3 });

  // Autofill billing fields from a picked suggestion. ORDER MATTERS:
  // country is committed BEFORE state because the parent's
  // onBillingCountryChange (EmbedCheckout) clears billingState whenever the
  // country changes — committing state first would see the fresh region code
  // wiped by that clear. Committed in this order, React batches
  // setCountry → setState("") → setState(regionCode), so the region survives,
  // and the parent's stale-region reconcile effect validates it against the
  // new country's region list.
  const handlePlaceSelect = (result: GeocodingResult) => {
    // Street-level line when available, else the full formatted address.
    onBillingLine1Change(result.streetLine ?? result.formattedAddress);
    if (result.locality) onBillingCityChange(result.locality);
    if (result.countryCode) onBillingCountryChange(result.countryCode);
    // Uppercase ISO subdivision code (e.g. "TN") — matches the <select>
    // option codes from getRegionsForCountry; free-text region name as a
    // fallback for countries without a region list.
    if (result.regionCode) onBillingStateChange(result.regionCode);
    else if (result.region) onBillingStateChange(result.region);
    if (result.postalCode) onBillingPostalCodeChange(result.postalCode);
    geo.close();
  };

  // Merge the base input well with an error ring when the field is invalid,
  // mirroring the main checkout's `errorInputStyle` (danger colour, width 2).
  // The ring is the `border` shorthand, as `inputStyle`'s border is: React
  // logs an error when a longhand is removed while the shorthand stays set.
  const inputStyleFor = (
    error: string | null,
    overrides?: CSSProperties,
  ): CSSProperties =>
    error
      ? { ...inputStyle, ...overrides, border: `2px solid ${DANGER}` }
      : { ...inputStyle, ...overrides };

  const errorTextStyle: CSSProperties = {
    fontSize: 12,
    color: DANGER,
    margin: 0,
    marginTop: 2,
  };

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <User size={14} style={{ color: STEEL_BLUE }} aria-hidden />
          <h3 style={sectionLabelStyle}>Your information</h3>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label
            htmlFor="embed-guest-name"
            style={{
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: TEXT_MUTED,
            }}
          >
            Full name
          </label>
          <input
            id="embed-guest-name"
            type="text"
            required
            value={guestName}
            onChange={(e) => onGuestNameChange(e.target.value)}
            onBlur={() => onFieldBlur("name")}
            placeholder="Jane Doe"
            autoComplete="name"
            aria-invalid={!!fieldErrors.name}
            style={inputStyleFor(fieldErrors.name)}
          />
          {fieldErrors.name && <p style={errorTextStyle}>{fieldErrors.name}</p>}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label
            htmlFor="embed-guest-email"
            style={{
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: TEXT_MUTED,
            }}
          >
            Email address
          </label>
          <input
            id="embed-guest-email"
            type="email"
            required
            value={guestEmail}
            // The order being created is for the email it was sent with, and
            // a change here gives the page a new checkout key: the order would
            // land behind it, left with its tickets reserved. Locked from the
            // press, not from the request (see `isCreating` in the props): a
            // press that is waiting on the bot check goes out with what the
            // field holds when the token arrives. Read-only (not disabled)
            // keeps the field focusable and its value readable.
            readOnly={isCreating}
            aria-readonly={isCreating || undefined}
            onChange={(e) => {
              if (!isCreating) onGuestEmailChange(e.target.value);
            }}
            onBlur={() => onFieldBlur("email")}
            placeholder="jane@example.com"
            autoComplete="email"
            aria-invalid={!!fieldErrors.email}
            style={inputStyleFor(fieldErrors.email)}
          />
          {fieldErrors.email && (
            <p style={errorTextStyle}>{fieldErrors.email}</p>
          )}
        </div>
      </div>

      {/* Guest account disclosure */}
      <p
        style={{
          margin: 0,
          fontSize: 11,
          lineHeight: 1.5,
          color: TEXT_CAPTION,
        }}
      >
        By continuing, an account will be created with your email so we can
        deliver your tickets and keep your order history. You can claim it
        anytime by setting a password.{" "}
        <a
          href="/privacy"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: STEEL_BLUE,
            textDecoration: "underline",
            textUnderlineOffset: 2,
          }}
        >
          Privacy Policy
        </a>
      </p>

      {/* Promo code input */}
      <EmbedPromoCodeInput
        appliedCodes={promoCodes}
        onApply={handleApplyPromoCode}
        onRemove={handleRemovePromoCode}
        disabled={isCreating}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={sectionLabelStyle}>Billing address</h3>
        </div>

        {/* Address line 1 — inline autocomplete with autofill. The wrapper is
            position:relative (the dropdown is absolutely positioned). The
            SHARED GeocodeSuggestionDropdown themes itself from the platform
            `--foreground`/`--background` vars, which on /embed/* are always
            the light theme's (lib/route-context.ts), with host overrides
            bridged at the widget root — so no re-declaration here. (One here
            would now be a self-reference: `--background: var(--background)`
            is a CSS cycle, which invalidates the property.) */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            position: "relative",
          }}
        >
          <label
            htmlFor="embed-billing-line1"
            style={{
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: TEXT_MUTED,
            }}
          >
            Address line 1
          </label>
          {/* Anchor for the popup: wraps ONLY the input, so the in-flow hint
              below never moves where `top: 100%` lands. */}
          <div style={{ position: "relative" }}>
          <input
            ref={geo.inputRef}
            id="embed-billing-line1"
            type="text"
            required
            value={billingLine1}
            onChange={(e) => {
              onBillingLine1Change(e.target.value);
              geo.feed(e.target.value);
            }}
            onKeyDown={(e) => geo.handleKeyDown(e, handlePlaceSelect)}
            onFocus={geo.reopen}
            onBlur={() => onFieldBlur("line1")}
            placeholder="123 Main St"
            // The suggestion dropdown replaces native autofill on this field.
            autoComplete="off"
            role="combobox"
            aria-expanded={geo.showDropdown && geo.suggestions.length > 0}
            aria-autocomplete="list"
            aria-controls="embed-billing-line1-listbox"
            aria-activedescendant={
              geo.activeIdx >= 0
                ? `embed-billing-line1-option-${geo.activeIdx}`
                : undefined
            }
            aria-invalid={!!fieldErrors.line1}
            style={inputStyleFor(fieldErrors.line1)}
          />
          {geo.showDropdown && (
            <GeocodeSuggestionDropdown
              suggestions={geo.suggestions}
              isFetching={geo.isFetching}
              activeIdx={geo.activeIdx}
              onSelect={handlePlaceSelect}
              onHover={geo.setActiveIdx}
              dropdownRef={geo.dropdownRef}
              idPrefix="embed-billing-line1"
              hideRowIcon
              showPoiName={false}
              searchingText={String(t("admin.placeEditAddressSearchSearching"))}
            />
          )}
          </div>
          <GeocodeStatusHint
            status={geo.showDropdown ? geo.status : null}
            noResultsText={String(t("admin.placeEditAddressSearchNoResults"))}
            errorText={String(t("admin.placeEditAddressSearchError"))}
            idPrefix="embed-billing-line1"
          />
          {fieldErrors.line1 && (
            <p style={errorTextStyle}>{fieldErrors.line1}</p>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label
            htmlFor="embed-billing-line2"
            style={{
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: TEXT_MUTED,
            }}
          >
            Address line 2 (optional)
          </label>
          <input
            id="embed-billing-line2"
            type="text"
            value={billingLine2}
            onChange={(e) => onBillingLine2Change(e.target.value)}
            placeholder="Apt 4B"
            autoComplete="address-line2"
            style={inputStyle}
          />
        </div>

        {/* Column sizing lives in .th-embed-checkout-field-row (globals.css):
            bare `1fr` floors at the selects' min-content width and pushes the
            right cell off-screen at phone widths. */}
        <div className="th-embed-checkout-field-row">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              htmlFor="embed-billing-city"
              style={{
                fontSize: 12,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: TEXT_MUTED,
              }}
            >
              City
            </label>
            <input
              id="embed-billing-city"
              type="text"
              required
              value={billingCity}
              onChange={(e) => onBillingCityChange(e.target.value)}
              onBlur={() => onFieldBlur("city")}
              placeholder="San Francisco"
              autoComplete="address-level2"
              aria-invalid={!!fieldErrors.city}
              style={inputStyleFor(fieldErrors.city)}
            />
            {fieldErrors.city && (
              <p style={errorTextStyle}>{fieldErrors.city}</p>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              htmlFor="embed-billing-state"
              style={{
                fontSize: 12,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: TEXT_MUTED,
              }}
            >
              State / Region
            </label>
            {regionOptions.length > 0 ? (
              <div style={{ position: "relative" }}>
                <select
                  id="embed-billing-state"
                  required
                  value={billingState}
                  onChange={(e) => onBillingStateChange(e.target.value)}
                  onBlur={() => onFieldBlur("state")}
                  autoComplete="address-level1"
                  aria-invalid={!!fieldErrors.state}
                  style={{
                    ...inputStyleFor(fieldErrors.state, { paddingRight: 32 }),
                    // Fill the cell, never size to the widest option — a
                    // select's intrinsic width would overflow the phone
                    // viewport behind overflow-x:hidden.
                    width: "100%",
                    minWidth: 0,
                    appearance: "none",
                    cursor: "pointer",
                  }}
                >
                  <option value="" disabled>
                    Select state
                  </option>
                  {regionOptions.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.name}
                    </option>
                  ))}
                </select>
                {/* The ONLY chevron: the inline `background:` shorthand resets
                    any stylesheet background-image, and globals.css no longer
                    carries an embed select chevron. Verified 2026-08-05:
                    removing this left the select with no affordance at all. */}
                <ChevronDown
                  size={14}
                  style={{
                    pointerEvents: "none",
                    position: "absolute",
                    right: 12,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: TEXT_MUTED,
                  }}
                />
              </div>
            ) : (
              <input
                id="embed-billing-state"
                type="text"
                required
                value={billingState}
                onChange={(e) => onBillingStateChange(e.target.value)}
                onBlur={() => onFieldBlur("state")}
                placeholder="Region"
                autoComplete="address-level1"
                aria-invalid={!!fieldErrors.state}
                style={inputStyleFor(fieldErrors.state)}
              />
            )}
            {fieldErrors.state && (
              <p style={errorTextStyle}>{fieldErrors.state}</p>
            )}
          </div>
        </div>

        <div className="th-embed-checkout-field-row">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              htmlFor="embed-billing-postal"
              style={{
                fontSize: 12,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: TEXT_MUTED,
              }}
            >
              Postal code
            </label>
            <input
              id="embed-billing-postal"
              type="text"
              required
              value={billingPostalCode}
              onChange={(e) => onBillingPostalCodeChange(e.target.value)}
              onBlur={() => onFieldBlur("postalCode")}
              placeholder="94103"
              autoComplete="postal-code"
              aria-invalid={!!fieldErrors.postalCode}
              style={inputStyleFor(fieldErrors.postalCode)}
            />
            {fieldErrors.postalCode && (
              <p style={errorTextStyle}>{fieldErrors.postalCode}</p>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              htmlFor="embed-billing-country"
              style={{
                fontSize: 12,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: TEXT_MUTED,
              }}
            >
              Country
            </label>
            {/* Same treatment as the State select above — the two sit
                side-by-side, so a native arrow next to a custom chevron
                reads as two different controls. `paddingRight` also keeps
                a long value ("United States") off the field border once the
                cell is width-clamped at phone widths. */}
            <div style={{ position: "relative" }}>
              <select
                id="embed-billing-country"
                required
                value={billingCountry}
                onChange={(e) => onBillingCountryChange(e.target.value)}
                onBlur={() => onFieldBlur("country")}
                autoComplete="country"
                aria-invalid={!!fieldErrors.country}
                style={{
                  ...inputStyleFor(fieldErrors.country, { paddingRight: 32 }),
                  // Same overflow guard as the state select above.
                  width: "100%",
                  minWidth: 0,
                  appearance: "none",
                  cursor: "pointer",
                }}
              >
                {COUNTRIES.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                style={{
                  pointerEvents: "none",
                  position: "absolute",
                  right: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: TEXT_MUTED,
                }}
              />
            </div>
            {fieldErrors.country && (
              <p style={errorTextStyle}>{fieldErrors.country}</p>
            )}
          </div>
        </div>
      </div>

      {requiresWaiver && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            border: waiverError
              ? `2px solid ${DANGER}`
              : `1px solid ${BORDER_SUBTLE}`,
            padding: 12,
            background: SURFACE_MUTED,
          }}
        >
          <h3 style={sectionLabelStyle}>Event waiver</h3>
          <div
            style={{
              maxHeight: 160,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              fontSize: 12,
              lineHeight: 1.6,
              color: TEXT_MUTED,
            }}
          >
            {waiverBody}
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontSize: 12,
              color: TEXT,
            }}
          >
            <input
              type="checkbox"
              checked={waiverAccepted}
              onChange={(e) => onWaiverAcceptedChange(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>I have read and agree to the waiver terms above.</span>
          </label>
          {waiverError && (
            <p role="alert" style={errorTextStyle}>
              {waiverError}
            </p>
          )}
        </div>
      )}

      {/* Terms + refund acceptance gate. RefundDisclosure is a shared
          component with no error/invalid prop, so surface the gate as an
          inline DANGER note above it rather than forking the shared component. */}
      {acceptanceError && (
        <p role="alert" style={{ ...errorTextStyle, marginTop: 0 }}>
          {acceptanceError}
        </p>
      )}

      <RefundDisclosure
        id="embed-refund-policy-accept"
        cart={refundDisclosureCart}
        refundPolicyHref="/help/buying-tickets/refunds-and-cancellations"
        checked={refundPolicyAccepted}
        onCheckedChange={onRefundPolicyAcceptedChange}
        termsChecked={termsAccepted}
        onTermsCheckedChange={onTermsAcceptedChange}
        termsHref={`/terms?v=${CURRENT_TERMS_VERSION}`}
        textColor={TEXT}
        borderColor={BORDER_SUBTLE}
        backgroundColor={SURFACE_MUTED}
        iconColor={TEXT_MUTED}
        linkColor={STEEL_BLUE}
      />

      <FormErrorBanner message={checkoutError} />
      {checkoutError ? checkoutErrorNote : null}

      {/* Cloudflare Turnstile — bot verification */}
      {TURNSTILE_SITE_KEY && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Turnstile
            ref={turnstileRef}
            siteKey={TURNSTILE_SITE_KEY}
            options={{ theme: "light", size: "normal" }}
            onSuccess={onTurnstileSuccess}
            onExpire={onTurnstileExpire}
            onError={onTurnstileError}
          />
          {!turnstileToken &&
            // After a Continue that the missing verification stopped, the
            // caption is the reason, said as one.
            (submitAttempted && !isCreating ? (
              <p role="alert" style={errorTextStyle}>
                Complete the verification to continue
              </p>
            ) : (
              <p style={{ fontSize: 10, color: TEXT_CAPTION, margin: 0 }}>
                Complete the verification to continue
              </p>
            ))}
        </div>
      )}

      {/* Validation summary — appears once the buyer has tried to submit and
          fields are still missing. Consolidates the count and, when more than
          one field is outstanding, offers a "Next field" jump that walks focus
          through every offender. preventDefault on mousedown keeps focus on the
          current field so the jump anchors off where the buyer actually is. */}
      {submitAttempted && invalidFieldCount > 0 && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 12px",
            background: DANGER_BG,
            border: `1px solid ${DANGER}`,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: DANGER }}>
            {String(
              t("checkout.fieldsNeedAttention", { count: invalidFieldCount }),
            )}
          </span>
          {invalidFieldCount > 1 && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onFocusNextInvalid}
              style={{
                flexShrink: 0,
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 700,
                color: DANGER,
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              {String(t("checkout.nextField"))} →
            </button>
          )}
        </div>
      )}

      {/* Disabled ONLY while creating. An invalid form still receives the
          click so handleCreateCheckout can reveal what's missing (red fields +
          focus) instead of presenting a dead button. On standalone pages the
          fixed mobile CTA bar carries this action at phone widths (and would
          cover this button at max scroll), so it hides there — same collision
          fix as the event-detail step's inline CTA. */}
      <button
        type="button"
        className={
          submitHiddenBehindFixedBar
            ? "th-embed-inline-cta--with-fixed-bar"
            : undefined
        }
        onClick={handleCreateCheckout}
        disabled={isCreating}
        style={{
          ...primaryButtonStyle,
          ...(isCreating ? primaryButtonDisabledStyle : {}),
        }}
      >
        {isCreating ? (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
          >
            <Spinner size="sm" indicatorColor={TEXT_ON_BRAND} />
            Processing...
          </span>
        ) : isFreeOrder ? (
          "Complete order"
        ) : (
          <>
            Continue to payment
            <ChevronRight size={16} />
          </>
        )}
      </button>
    </>
  );
}
