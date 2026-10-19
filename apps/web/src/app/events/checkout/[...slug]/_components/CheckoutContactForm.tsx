"use client";

import React, {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  useMemo,
} from "react";
import {
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Mail,
  Phone,
  User,
  LogIn,
} from "lucide-react";
import { Button, useTranslations } from "@th/ui";

import type { GeocodingResult } from "@/lib/maps/geocoding";
import { useGeocodeSuggestions } from "@/hooks/use-geocode-suggestions";
import { GeocodeSuggestionDropdown } from "@/components/maps/GeocodeSuggestionDropdown";
import { GeocodeStatusHint } from "@/components/maps/GeocodeStatusHint";
import {
  FG as fg,
  BG as bg,
  fgAlpha,
  FS_BODY,
  FS_CAP,
  FS_SM,
} from "./checkout-tokens";
import { ACCENT } from "@/lib/design-tokens";
import { COUNTRIES, getRegionsForCountry } from "./address-data";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Single source of truth for "is this required field's value blocking?" —
// shared by the invalid-field count/navigation and showValidationErrors'
// first-invalid pick, so the email regex isn't duplicated inline.
function isFieldValueInvalid(key: string, value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (key === "email") return !EMAIL_RE.test(v);
  return false;
}

export type BillingAddress = {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

/**
 * Live snapshot of every contact + billing field, including partials. Emitted
 * upward on every change so the parent can persist it across the details step
 * unmounting (back to tickets / hold re-acquisition / payment ↔ details) and
 * feed it back as defaults — otherwise the form remounts blank and the buyer
 * loses everything they typed within the held session.
 */
export type ContactDraft = {
  name: string;
  email: string;
  phone: string;
  billing: Partial<BillingAddress>;
};

export type CheckoutContactFormRef = {
  getBillingAddress: () => BillingAddress | null;
  getPhone: () => string;
  /** Focus the first billing field (address line 1) and scroll it into
   *  view. Used by the parent when checkout validation rejects an
   *  incomplete billing address — paired with a toast explaining why. */
  focusBillingAddress: () => void;
  /** Mark every required field as touched — revealing inline error text +
   *  aria-invalid on all empty/invalid required fields — then scroll to
   *  and focus the FIRST invalid one. Called when "Continue to payment"
   *  is blocked so the rejection is never silent. */
  showValidationErrors: () => void;
  /** Move focus to the next invalid contact/billing field, cycling
   *  top-to-bottom and wrapping. Drives the validation summary's
   *  "Next field" control rendered by the parent step. */
  focusNextInvalid: () => void;
};

export type CheckoutContactFormProps = {
  /** Pre-filled from the user's account when signed in */
  defaultName?: string;
  defaultEmail?: string;
  /** Pre-filled from saved profile contact details */
  defaultPhone?: string;
  defaultBillingAddress?: BillingAddress;
  isSignedIn: boolean;
  onSignIn: () => void;
  /** Fires when all required billing fields are non-empty. */
  onBillingAddressComplete?: (address: BillingAddress) => void;
  /**
   * Fires on every contact/billing field change with the full current draft
   * (including partials). The parent persists this so the form survives
   * unmounting when the buyer steps back to tickets or forward to payment.
   */
  onDraftChange?: (draft: ContactDraft) => void;
  /**
   * Reactive validation snapshot, emitted whenever the submit-attempt flag or
   * the count of invalid required fields changes. The parent step renders the
   * consolidated validation summary (count + "Next field") above its CTA from
   * this — refs aren't reactive, so the count can't be read off the ref.
   */
  onValidationStateChange?: (state: {
    submitAttempted: boolean;
    invalidCount: number;
  }) => void;
  /**
   * When true, the billing-address fields are not rendered and
   * `getBillingAddress()` always returns null. Used by free orders
   * (subtotal $0) where no card is charged and no tax is computed —
   * asking for an address would be pointless friction.
   */
  hideBillingAddress?: boolean;
};

export const CheckoutContactForm = React.forwardRef<
  CheckoutContactFormRef,
  CheckoutContactFormProps
>(function CheckoutContactForm(
  {
    defaultName,
    defaultEmail,
    defaultPhone,
    defaultBillingAddress,
    isSignedIn,
    onSignIn,
    onBillingAddressComplete,
    onDraftChange,
    onValidationStateChange,
    hideBillingAddress = false,
  },
  ref,
) {
  const t = useTranslations();

  const [name, setName] = useState(defaultName ?? "");
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [phone, setPhone] = useState(defaultPhone ?? "");

  // Billing address
  const [addressLine1, setAddressLine1] = useState(
    defaultBillingAddress?.line1 ?? "",
  );
  const [addressLine2, setAddressLine2] = useState(
    defaultBillingAddress?.line2 ?? "",
  );
  const [city, setCity] = useState(defaultBillingAddress?.city ?? "");
  const [state, setState] = useState(defaultBillingAddress?.state ?? "");
  const [postalCode, setPostalCode] = useState(
    defaultBillingAddress?.postalCode ?? "",
  );
  const [country, setCountry] = useState(defaultBillingAddress?.country ?? "");

  // ── Inline validation (field touched = blurred at least once) ────────
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // `submitAttempted` flips once "Continue to payment" is clicked with an
  // invalid form — the parent step's validation summary only renders after it.
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const markTouched = useCallback(
    (field: string) => setTouched((prev) => ({ ...prev, [field]: true })),
    [],
  );

  /**
   * Returns an error string if the required field is empty and was touched,
   * otherwise null. Empty fields get specific, action-oriented copy ("Enter
   * your city") rather than a uniform "This field is required." so the buyer
   * knows exactly what to fix — matching the embed checkout. The state prompt
   * adapts to whether that field renders as a <select> (known region list) or
   * a free-text input.
   */
  const fieldError = useCallback(
    (field: string, value: string) => {
      if (!touched[field]) return null;
      if (!value.trim()) {
        switch (field) {
          case "name":
            return String(t("checkout.enterFullName"));
          case "email":
            return String(t("checkout.enterEmail"));
          case "addressLine1":
            return String(t("checkout.enterStreetAddress"));
          case "city":
            return String(t("checkout.enterCity"));
          case "state":
            return getRegionsForCountry(country).length > 0
              ? String(t("checkout.selectState"))
              : String(t("checkout.enterStateOrRegion"));
          case "postalCode":
            return String(t("checkout.enterPostalCode"));
          case "country":
            return String(t("checkout.selectCountry"));
          default:
            return String(t("checkout.fieldRequired"));
        }
      }
      // Basic email shape check
      if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))
        return String(t("checkout.invalidEmail"));
      return null;
    },
    [touched, t, country],
  );

  // Pre-compute errors for each required field so we don't recompute in JSX
  const errors = useMemo(
    () => ({
      name: fieldError("name", name),
      email: fieldError("email", email),
      addressLine1: fieldError("addressLine1", addressLine1),
      city: fieldError("city", city),
      state: fieldError("state", state),
      postalCode: fieldError("postalCode", postalCode),
      country: fieldError("country", country),
    }),
    [fieldError, name, email, addressLine1, city, state, postalCode, country],
  );

  // Ordered top-to-bottom as rendered, with the DOM id on each input. The
  // single source of truth for BOTH the first/next-invalid focus navigation
  // and the invalid-field count surfaced in the parent's validation summary.
  // Respects `hideBillingAddress` (free orders show only name + email).
  const orderedFields = useMemo(
    () => [
      { key: "name", value: name, id: "checkout-name" },
      { key: "email", value: email, id: "checkout-email" },
      ...(hideBillingAddress
        ? []
        : [
            { key: "addressLine1", value: addressLine1, id: "checkout-address1" },
            { key: "city", value: city, id: "checkout-city" },
            { key: "state", value: state, id: "checkout-state" },
            { key: "postalCode", value: postalCode, id: "checkout-postal" },
            { key: "country", value: country, id: "checkout-country" },
          ]),
    ],
    [name, email, addressLine1, city, state, postalCode, country, hideBillingAddress],
  );

  // Ordered DOM ids of the required fields whose raw current value is still
  // blocking — drives the parent summary's count and "Next field" navigation.
  // Not gated by `touched`: the summary only renders after submitAttempted, by
  // which point every required field is touched (matching the embed).
  const invalidFieldIds = useMemo(
    () =>
      orderedFields
        .filter(({ key, value }) => isFieldValueInvalid(key, value))
        .map(({ id }) => id),
    [orderedFields],
  );

  // Regions for the currently-selected country (e.g. US states).
  // When the list is empty (non-US), the state field degrades to a text input.
  const regionOptions = useMemo(() => getRegionsForCountry(country), [country]);

  // Reconcile a stale region code: when the selected country has a known
  // region list but `state` isn't one of its codes (e.g. a restored
  // default address whose country/state don't match, or a code left over
  // from a prior country), clear it so the blank <select> and the value
  // stay in sync and an invalid ISO region can't pass validation.
  useEffect(() => {
    if (
      regionOptions.length > 0 &&
      state &&
      !regionOptions.some((r) => r.code === state)
    ) {
      setState("");
    }
  }, [regionOptions, state]);

  // ── Inline address autocomplete (shared hook) ────────────────────────
  // Declared here (above the imperative handle) so the closure can reference
  // `geo` without tripping `noUseBeforeDefine`.
  const geo = useGeocodeSuggestions({ minQueryLength: 3 });

  // ── Mobile collapsible state ─────────────────────────────────────────
  // Declared above the imperative handle (showValidationErrors expands the
  // collapsed summary before focusing). Once all required fields are filled,
  // mobile users see a compact summary they can tap to re-expand instead of
  // scrolling past a long form — see the auto-collapse effect below.
  const [mobileCollapsed, setMobileCollapsed] = useState(false);
  // Once the summary has been shown, its toggle stays mounted in both states
  // (a disclosure button), so expanding or collapsing keeps focus on it
  // instead of unmounting the focused button and dropping focus to <body>.
  const [summaryEnabled, setSummaryEnabled] = useState(false);
  const billingRegionId = useId();

  // Last field the buyer was *navigated* to (via submit or "Next field"), so
  // the Next control can advance from there even when clicking it would
  // otherwise move focus. The Next button preventDefaults its mousedown, so in
  // practice focus stays on the field and document.activeElement is the primary
  // source; this ref is the keyboard/edge-case fallback.
  const lastNavRef = useRef<string | null>(null);
  const focusFieldById = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Focus after the smooth-scroll settles so the page doesn't snap.
    window.setTimeout(() => el.focus({ preventScroll: true }), 320);
  }, []);

  // Move focus to the next invalid field, cycling top-to-bottom (wraps to the
  // first). Anchors off the currently-focused field when it's one of the
  // invalid ones, else off the last field we navigated to — so repeated "Next
  // field" clicks walk through every offender without getting stuck.
  const focusNextInvalid = useCallback(() => {
    if (invalidFieldIds.length === 0) return;
    const activeId =
      typeof document !== "undefined"
        ? (document.activeElement?.id ?? null)
        : null;
    const fromId =
      activeId && invalidFieldIds.includes(activeId)
        ? activeId
        : lastNavRef.current;
    const fromIdx = fromId ? invalidFieldIds.indexOf(fromId) : -1;
    const nextId = invalidFieldIds[(fromIdx + 1) % invalidFieldIds.length];
    lastNavRef.current = nextId;
    focusFieldById(nextId);
  }, [invalidFieldIds, focusFieldById]);

  // Emit the reactive validation snapshot the parent step renders its summary
  // from (count + Next control). Refs aren't reactive, so this can't ride on
  // the imperative handle.
  useEffect(() => {
    onValidationStateChange?.({
      submitAttempted,
      invalidCount: invalidFieldIds.length,
    });
  }, [submitAttempted, invalidFieldIds.length, onValidationStateChange]);

  // Expose billing address and phone to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      getBillingAddress(): BillingAddress | null {
        // Free-order flows hide the billing section entirely; the form
        // has no state to surface, and the caller's gate (`subtotalCents
        // > 0`) already skips the address requirement.
        if (hideBillingAddress) return null;
        // Only return if we have the minimum required fields
        if (!addressLine1 || !city || !state || !postalCode || !country)
          return null;
        return {
          line1: addressLine1,
          ...(addressLine2 ? { line2: addressLine2 } : {}),
          city,
          state,
          postalCode,
          country,
        };
      },
      getPhone(): string {
        return phone;
      },
      focusBillingAddress() {
        const el = geo.inputRef.current;
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        // Match the terms-checkbox pattern in Checkout.tsx: focus after the
        // smooth-scroll has settled so the page doesn't snap.
        window.setTimeout(() => el.focus({ preventScroll: true }), 320);
      },
      showValidationErrors() {
        // Touch every required field so `errors` computes for all of them —
        // inline error text + aria-invalid render on the next paint.
        setTouched((prev) => ({
          ...prev,
          ...Object.fromEntries(orderedFields.map((f) => [f.key, true])),
        }));
        // Flips the parent's validation summary on (count + Next control).
        setSubmitAttempted(true);
        // The mobile collapsed summary only shows when the form is complete,
        // but expand defensively before focusing a field inside it.
        setMobileCollapsed(false);

        // Pick the first offender from the raw values via the shared predicate
        // (not `invalidFieldIds`, which is current here but kept consistent).
        const firstInvalid = orderedFields.find((f) =>
          isFieldValueInvalid(f.key, f.value),
        );
        if (!firstInvalid) return;
        // Seed lastNavRef so the first "Next field" click advances correctly.
        lastNavRef.current = firstInvalid.id;
        focusFieldById(firstInvalid.id);
      },
      focusNextInvalid,
    }),
    [
      orderedFields,
      addressLine2,
      phone,
      geo.inputRef,
      hideBillingAddress,
      focusFieldById,
      focusNextInvalid,
    ],
  );

  // Lift a live draft of every field (partials included) so the parent can
  // persist it across the details step unmounting and re-seed it on remount.
  useEffect(() => {
    if (!onDraftChange) return;
    onDraftChange({
      name,
      email,
      phone,
      billing: {
        line1: addressLine1,
        ...(addressLine2 ? { line2: addressLine2 } : {}),
        city,
        state,
        postalCode,
        country,
      },
    });
  }, [
    name,
    email,
    phone,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    country,
    onDraftChange,
  ]);

  // Notify parent when all required billing fields are filled
  useEffect(() => {
    if (!onBillingAddressComplete) return;
    if (!addressLine1 || !city || !state || !postalCode || !country) return;
    onBillingAddressComplete({
      line1: addressLine1,
      ...(addressLine2 ? { line2: addressLine2 } : {}),
      city,
      state,
      postalCode,
      country,
    });
  }, [
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    country,
    onBillingAddressComplete,
  ]);

  // Sync defaults when session / saved profile loads
  useEffect(() => {
    if (defaultName && !name) setName(defaultName);
    if (defaultEmail && !email) setEmail(defaultEmail);
    if (defaultPhone && !phone) setPhone(defaultPhone);
    if (defaultBillingAddress && !addressLine1) {
      setAddressLine1(defaultBillingAddress.line1);
      if (defaultBillingAddress.line2)
        setAddressLine2(defaultBillingAddress.line2);
      if (defaultBillingAddress.city) setCity(defaultBillingAddress.city);
      if (defaultBillingAddress.state) setState(defaultBillingAddress.state);
      if (defaultBillingAddress.postalCode)
        setPostalCode(defaultBillingAddress.postalCode);
      if (defaultBillingAddress.country)
        setCountry(defaultBillingAddress.country);
    }
  }, [defaultName, defaultEmail, defaultPhone, defaultBillingAddress]);

  // Autofill billing fields from location autocomplete
  const handlePlaceSelect = useCallback((result: GeocodingResult) => {
    // Use street-level address when available, fall back to full formatted address
    setAddressLine1(result.streetLine ?? result.formattedAddress);
    if (result.locality) setCity(result.locality);
    if (result.regionCode) setState(result.regionCode);
    else if (result.region) setState(result.region);
    if (result.postalCode) setPostalCode(result.postalCode);
    if (result.countryCode) setCountry(result.countryCode);
    geo.close();
  }, []);

  const handleAddressChange = useCallback(
    (value: string) => {
      setAddressLine1(value);
      geo.feed(value);
    },
    [geo.feed],
  );

  const iconStyle: React.CSSProperties = {
    pointerEvents: "none",
    position: "absolute",
    left: 14,
    top: "50%",
    transform: "translateY(-50%)",
    color: fgAlpha(70),
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    minWidth: 0,
    borderRadius: 0,
    // Longhands, never the `border` shorthand: the error ring overrides
    // `borderColor` / `borderWidth`, and dropping those (invalid → valid)
    // beside a shorthand made React warn "Removing a style property during
    // rerender" on every field — the State <select> most visibly.
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: "var(--borderColorSoft, rgba(33,28,22,0.3))",
    background: bg,
    padding: "10px 14px 10px 40px",
    fontSize: FS_SM,
    color: fg,
    transition: "border-color 0.15s",
  };

  const FOCUS_GLOW_CLASS = "checkout-input-focus-glow";

  const labelStyle: React.CSSProperties = {
    fontSize: FS_CAP,
    fontWeight: 500,
    color: fgAlpha(85),
  };

  const fieldGap: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 0,
  };

  const errorInputStyle: React.CSSProperties = {
    borderColor: "var(--danger, #B91C1C)",
    borderWidth: 2,
  };

  const errorTextStyle: React.CSSProperties = {
    fontSize: FS_CAP,
    color: "var(--danger, #B91C1C)",
    margin: 0,
    marginTop: 2,
  };

  /** Merge base input style with error ring when the field has a validation error. */
  const inputStyleFor = (
    error: string | null,
    baseOverrides?: React.CSSProperties,
  ): React.CSSProperties =>
    error
      ? { ...inputStyle, ...baseOverrides, ...errorInputStyle }
      : { ...inputStyle, ...baseOverrides };

  // ── Mobile collapse trigger ──────────────────────────────────────────
  // The summary toggle stays mounted while the form is open, so its text (its
  // accessible name) is built from the parts present: no ", ," or dangling "·"
  // while a field is half-typed.
  const summaryName = name.trim();
  const summaryEmail = email.trim();
  const summaryAddress = [
    addressLine1.trim(),
    city.trim(),
    `${state.trim()} ${postalCode.trim()}`.trim(),
  ]
    .filter(Boolean)
    .join(", ");

  const isFormComplete = Boolean(
    name.trim() &&
    email.trim() &&
    addressLine1.trim() &&
    city.trim() &&
    state.trim() &&
    postalCode.trim() &&
    country.trim(),
  );

  // Auto-collapse on mobile only when the form ARRIVES complete (saved
  // profile, restored draft) before the buyer has touched it. Once a field
  // in the form has had focus, completeness never collapses it again:
  // `isFormComplete` is only "every field non-empty", so it flips on the
  // first keystroke of a re-typed field (or on browser autofill), and
  // collapsing then hid the focused input, dropped focus to <body>, closed
  // the on-screen keyboard and jumped the page. A ref, not state: focusing a
  // field must not re-render the form.
  const buyerTouchedFormRef = useRef(false);
  const markBuyerTouchedForm = useCallback(() => {
    buyerTouchedFormRef.current = true;
  }, []);
  useEffect(() => {
    if (!isFormComplete) {
      setMobileCollapsed(false);
      return;
    }
    if (buyerTouchedFormRef.current) return;
    // Only auto-collapse if the viewport is narrow (mobile)
    if (typeof window !== "undefined" && window.innerWidth <= 720) {
      setMobileCollapsed(true);
      setSummaryEnabled(true);
    }
  }, [isFormComplete]);

  // ── Sign-in gate when not authenticated ──────────────────────────────
  if (!isSignedIn) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          padding: "16px 0",
          textAlign: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            height: 48,
            width: 48,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 0,
            background: fgAlpha(6),
          }}
        >
          <LogIn size={22} style={{ color: fgAlpha(80) }} />
        </div>
        <div>
          <p style={{ margin: 0, fontSize: FS_BODY, fontWeight: 700, color: fg }}>
            {String(t("checkout.accountRequired"))}
          </p>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: FS_SM,
              color: fgAlpha(80),
            }}
          >
            {String(t("checkout.accountRequiredDescription"))}
          </p>
        </div>
        <Button
          variant="primary"
          size="$4"
          onPress={onSignIn}
          borderRadius="$0"
        >
          <LogIn size={16} />
          {String(t("checkout.signInOrCreateAccount"))}
        </Button>
      </div>
    );
  }

  // ── Contact form fields ──────────────────────────────────────────────
  return (
    <>
      {/* Mobile billing summary: a disclosure toggle (≤720px only). It stays
          mounted once shown, so expanding/collapsing keeps focus on it. */}
      {summaryEnabled && (
        <>
          <style>{`
            .billing-collapsed-summary { display: none !important; }
            .billing-collapsed-summary:focus-visible {
              outline: 2px solid var(--accent, ${ACCENT}) !important;
              outline-offset: 2px !important;
            }
            @media (max-width: 720px) {
              .billing-collapsed-summary { display: flex !important; }
              .billing-full-form[data-collapsed="true"] { display: none !important; }
            }
          `}</style>
          <button
            type="button"
            className="billing-collapsed-summary"
            aria-expanded={!mobileCollapsed}
            aria-controls={billingRegionId}
            onClick={() => setMobileCollapsed((c) => !c)}
            style={{
              all: "unset",
              cursor: "pointer",
              alignItems: "center",
              gap: 12,
              padding: "14px 16px",
              borderRadius: 0,
              border: `1px solid var(--borderColorSoft, rgba(33,28,22,0.3))`,
              background: fgAlpha(2),
              width: "100%",
              boxSizing: "border-box",
              // Expanded, the toggle sits directly above the first field label.
              marginBottom: mobileCollapsed ? 0 : 16,
            }}
          >
            <CheckCircle
              size={18}
              aria-hidden
              style={{
                color: "var(--success, #166534)",
                flexShrink: 0,
                visibility: isFormComplete ? "visible" : "hidden",
              }}
            />
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span
                style={{
                  fontSize: FS_SM,
                  fontWeight: 500,
                  color: fg,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {summaryName}
                {summaryName && summaryEmail ? (
                  <span aria-hidden="true"> &middot; </span>
                ) : null}
                {summaryEmail}
              </span>
              <span
                style={{
                  fontSize: FS_CAP,
                  color: fgAlpha(60),
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {summaryAddress}
              </span>
            </div>
            {mobileCollapsed ? (
              <ChevronDown
                size={16}
                aria-hidden
                style={{ color: fgAlpha(50), flexShrink: 0 }}
              />
            ) : (
              <ChevronUp
                size={16}
                aria-hidden
                style={{ color: fgAlpha(50), flexShrink: 0 }}
              />
            )}
          </button>
        </>
      )}

      <div
        id={billingRegionId}
        className="billing-full-form"
        data-collapsed={summaryEnabled && mobileCollapsed ? "true" : undefined}
        onFocusCapture={markBuyerTouchedForm}
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        {/* Focus glow for all inputs & selects */}
        <style>{`
        .${FOCUS_GLOW_CLASS}:focus {
          border-color: var(--accent, ${ACCENT});
          border-width: 2px;
        }
      `}</style>

        {/* Name + Email row */}
        <div
          className="checkout-name-email-row"
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
        >
          <div style={fieldGap}>
            <label htmlFor="checkout-name" style={labelStyle}>
              {String(t("checkout.fullName"))}
            </label>
            <div style={{ position: "relative" }}>
              <User size={16} style={iconStyle} />
              <input
                id="checkout-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => markTouched("name")}
                placeholder="Jane Doe"
                className={FOCUS_GLOW_CLASS}
                style={inputStyleFor(errors.name)}
                aria-invalid={!!errors.name}
              />
            </div>
            {errors.name && <p style={errorTextStyle}>{errors.name}</p>}
          </div>

          <div style={fieldGap}>
            <label htmlFor="checkout-email" style={labelStyle}>
              {String(t("checkout.emailAddress"))}
            </label>
            <div style={{ position: "relative" }}>
              <Mail size={16} style={iconStyle} />
              <input
                id="checkout-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => markTouched("email")}
                placeholder="jane@example.com"
                className={FOCUS_GLOW_CLASS}
                style={inputStyleFor(errors.email)}
                aria-invalid={!!errors.email}
              />
            </div>
            {errors.email && <p style={errorTextStyle}>{errors.email}</p>}
          </div>
        </div>

        {/* Phone */}
        <div style={fieldGap}>
          <label
            htmlFor="checkout-phone"
            style={{
              ...labelStyle,
              display: "flex",
              alignItems: "baseline",
              gap: 4,
            }}
          >
            {String(t("checkout.phoneNumber"))}
            <span style={{ color: fgAlpha(65) }}>
              ({String(t("checkout.optional"))})
            </span>
          </label>
          <div style={{ position: "relative" }}>
            <Phone size={16} style={iconStyle} />
            <input
              id="checkout-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 (555) 000-0000"
              className={FOCUS_GLOW_CLASS}
              style={inputStyle}
            />
          </div>
        </div>

        {/* ── Billing address ────────────────────────────────────────── */}
        {!hideBillingAddress && (
        <div
          style={{
            borderTop: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
            paddingTop: 16,
          }}
        >
          <p
            style={{
              ...labelStyle,
              marginBottom: 12,
              fontSize: FS_SM,
              fontWeight: 700,
            }}
          >
            {String(t("checkout.billingAddress"))}
          </p>

          {/* Address line 1 — inline autocomplete with autofill */}
          <div style={{ ...fieldGap, marginBottom: 12, position: "relative" }}>
            <label htmlFor="checkout-address1" style={labelStyle}>
              {String(t("checkout.addressLine1"))}
            </label>
            {/* Anchor for the popup: wraps ONLY the input, so the in-flow hint
                below never moves where `top: 100%` lands. */}
            <div style={{ position: "relative" }}>
            <input
              ref={geo.inputRef}
              id="checkout-address1"
              type="text"
              required
              value={addressLine1}
              onChange={(e) => handleAddressChange(e.target.value)}
              onKeyDown={(e) => geo.handleKeyDown(e, handlePlaceSelect)}
              onFocus={geo.reopen}
              onBlur={() => markTouched("addressLine1")}
              placeholder="123 Main St"
              autoComplete="off"
              role="combobox"
              aria-expanded={geo.showDropdown && geo.suggestions.length > 0}
              aria-autocomplete="list"
              aria-controls="checkout-address1-listbox"
              aria-activedescendant={
                geo.activeIdx >= 0
                  ? `checkout-address1-option-${geo.activeIdx}`
                  : undefined
              }
              aria-invalid={!!errors.addressLine1}
              className={FOCUS_GLOW_CLASS}
              style={inputStyleFor(errors.addressLine1, { paddingLeft: 14 })}
            />
            {geo.showDropdown && (
              <GeocodeSuggestionDropdown
                suggestions={geo.suggestions}
                isFetching={geo.isFetching}
                activeIdx={geo.activeIdx}
                onSelect={(result) => {
                  handlePlaceSelect(result);
                }}
                onHover={geo.setActiveIdx}
                dropdownRef={geo.dropdownRef}
                idPrefix="checkout-address1"
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
              idPrefix="checkout-address1"
            />
            {errors.addressLine1 && (
              <p style={errorTextStyle}>{errors.addressLine1}</p>
            )}
          </div>

          {/* Address line 2 */}
          <div style={{ ...fieldGap, marginBottom: 12 }}>
            <label
              htmlFor="checkout-address2"
              style={{
                ...labelStyle,
                display: "flex",
                alignItems: "baseline",
                gap: 4,
              }}
            >
              {String(t("checkout.addressLine2"))}
              <span style={{ color: fgAlpha(65) }}>
                ({String(t("checkout.optional"))})
              </span>
            </label>
            <input
              id="checkout-address2"
              type="text"
              value={addressLine2}
              onChange={(e) => setAddressLine2(e.target.value)}
              placeholder="Apt 4B"
              autoComplete="address-line2"
              className={FOCUS_GLOW_CLASS}
              style={{ ...inputStyle, paddingLeft: 14 }}
            />
          </div>

          {/* City + State row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div style={fieldGap}>
              <label htmlFor="checkout-city" style={labelStyle}>
                {String(t("checkout.city"))}
              </label>
              <input
                id="checkout-city"
                type="text"
                required
                value={city}
                onChange={(e) => setCity(e.target.value)}
                onBlur={() => markTouched("city")}
                placeholder="San Francisco"
                autoComplete="address-level2"
                aria-invalid={!!errors.city}
                className={FOCUS_GLOW_CLASS}
                style={inputStyleFor(errors.city, { paddingLeft: 14 })}
              />
              {errors.city && <p style={errorTextStyle}>{errors.city}</p>}
            </div>
            <div style={fieldGap}>
              <label htmlFor="checkout-state" style={labelStyle}>
                {String(t("checkout.state"))}
              </label>
              {regionOptions.length > 0 ? (
                <div style={{ position: "relative" }}>
                  <select
                    id="checkout-state"
                    required
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    onBlur={() => markTouched("state")}
                    aria-invalid={!!errors.state}
                    className={FOCUS_GLOW_CLASS}
                    style={{
                      ...inputStyleFor(errors.state, {
                        paddingLeft: 14,
                        paddingRight: 32,
                      }),
                      appearance: "none",
                      cursor: "pointer",
                    }}
                  >
                    <option value="" disabled>
                      {String(t("checkout.selectState"))}
                    </option>
                    {regionOptions.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.name}
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
                      color: fgAlpha(60),
                    }}
                  />
                </div>
              ) : (
                <input
                  id="checkout-state"
                  type="text"
                  required
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  onBlur={() => markTouched("state")}
                  placeholder="CA"
                  autoComplete="address-level1"
                  aria-invalid={!!errors.state}
                  className={FOCUS_GLOW_CLASS}
                  style={inputStyleFor(errors.state, { paddingLeft: 14 })}
                />
              )}
              {errors.state && <p style={errorTextStyle}>{errors.state}</p>}
            </div>
          </div>

          {/* Postal code + Country row */}
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            <div style={fieldGap}>
              <label htmlFor="checkout-postal" style={labelStyle}>
                {String(t("checkout.postalCode"))}
              </label>
              <input
                id="checkout-postal"
                type="text"
                required
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                onBlur={() => markTouched("postalCode")}
                placeholder="94103"
                autoComplete="postal-code"
                aria-invalid={!!errors.postalCode}
                className={FOCUS_GLOW_CLASS}
                style={inputStyleFor(errors.postalCode, { paddingLeft: 14 })}
              />
              {errors.postalCode && (
                <p style={errorTextStyle}>{errors.postalCode}</p>
              )}
            </div>
            <div style={fieldGap}>
              <label htmlFor="checkout-country" style={labelStyle}>
                {String(t("checkout.country"))}
              </label>
              <div style={{ position: "relative" }}>
                <select
                  id="checkout-country"
                  required
                  value={country}
                  onChange={(e) => {
                    const newCountry = e.target.value;
                    setCountry(newCountry);
                    // Clear state when switching countries since region lists differ
                    if (newCountry !== country) setState("");
                  }}
                  onBlur={() => markTouched("country")}
                  aria-invalid={!!errors.country}
                  className={FOCUS_GLOW_CLASS}
                  style={{
                    ...inputStyleFor(errors.country, {
                      paddingLeft: 14,
                      paddingRight: 32,
                    }),
                    appearance: "none",
                    cursor: "pointer",
                  }}
                >
                  <option value="" disabled>
                    {String(t("checkout.selectCountry"))}
                  </option>
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
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
                    color: fgAlpha(60),
                  }}
                />
              </div>
              {errors.country && <p style={errorTextStyle}>{errors.country}</p>}
            </div>
          </div>
        </div>
        )}
      </div>
    </>
  );
});
