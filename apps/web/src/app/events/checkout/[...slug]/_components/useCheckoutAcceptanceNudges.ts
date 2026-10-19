import { useCallback, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { useNotify, useTranslations } from "@th/ui";

import type { CheckoutContactFormRef } from "./CheckoutContactForm";

// Keep in sync with TERMS_PULSE_MS in Checkout.tsx — CSS keyframes run for
// 1.6s; we leave the highlight class on for 1.8s so it's removed after the
// animation completes rather than mid-flight.
const PULSE_MS = 1800;

export type UseCheckoutAcceptanceNudgesResult = {
  // Acceptance state — three independent checkboxes (waiver / terms /
  // refund). Terms + refund are wired to the same node via
  // setAgreementCheckboxRef because RefundDisclosure renders them as a
  // single combined checkbox.
  waiverAccepted: boolean;
  setWaiverAccepted: (value: boolean) => void;
  waiverCheckboxRef: RefObject<HTMLInputElement | null>;
  /** True for ~1.8s after handleWaiverRequired fires — drives a pulse animation. */
  waiverHighlight: boolean;

  termsAccepted: boolean;
  setTermsAccepted: (value: boolean) => void;
  refundPolicyAccepted: boolean;
  setRefundPolicyAccepted: (value: boolean) => void;
  /** Ref-setter wired to the combined Terms+Refund checkbox node. */
  setAgreementCheckboxRef: (node: HTMLElement | null) => void;

  // Validation nudges — each one shows a toast, scrolls the offending
  // element into view, then focuses it. The buyer learns to look at the
  // same spot every time.
  handleTermsRequired: () => void;
  handleSelectionRequired: () => void;
  handleBillingAddressRequired: () => void;
  handleWaiverRequired: () => void;
  handleRefundPolicyRequired: () => void;
};

type NudgeKind = "warning";

type NudgeSpec = {
  title: string;
  message: string;
  target: HTMLElement | null;
  /** Optional side-effect (e.g. flip a highlight flag for an animation). */
  onAfter?: () => void;
};

export function useCheckoutAcceptanceNudges(
  contactFormRef: RefObject<CheckoutContactFormRef | null>,
): UseCheckoutAcceptanceNudgesResult {
  const t = useTranslations();
  const { toast } = useNotify();

  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const waiverCheckboxRef = useRef<HTMLInputElement | null>(null);
  const [waiverHighlight, setWaiverHighlight] = useState(false);

  const [termsAccepted, setTermsAccepted] = useState(false);
  const termsCheckboxRef = useRef<HTMLElement | null>(null);
  const [refundPolicyAccepted, setRefundPolicyAccepted] = useState(false);
  const refundPolicyCheckboxRef = useRef<HTMLElement | null>(null);

  const setAgreementCheckboxRef = useCallback((node: HTMLElement | null) => {
    termsCheckboxRef.current = node;
    refundPolicyCheckboxRef.current = node;
  }, []);

  // Common toast options for "fix this and try again" nudges anchored under
  // the form. All validators share the same tone so the buyer learns to
  // look at the same spot every time.
  const nudgeToast = useMemo(
    () => ({
      durationMs: 4000,
      position: "bottom-center" as const,
    }),
    [],
  );

  const fireNudge = useCallback(
    (kind: NudgeKind, spec: NudgeSpec) => {
      toast[kind](spec.message, { title: spec.title, ...nudgeToast });
      const el = spec.target;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        // Small delay so focus lands after the smooth scroll settles —
        // focusing mid-scroll snaps the page and feels jarring.
        window.setTimeout(() => el.focus({ preventScroll: true }), 320);
      }
      spec.onAfter?.();
    },
    [toast, nudgeToast],
  );

  const handleTermsRequired = useCallback(() => {
    fireNudge("warning", {
      title: String(t("checkout.oneMoreThing")),
      message: String(t("checkout.termsRequiredToast")),
      target: termsCheckboxRef.current,
    });
  }, [fireNudge, t]);

  const handleSelectionRequired = useCallback(() => {
    toast.warning("Pick at least one ticket to continue.", {
      title: "NO TICKETS YET",
      ...nudgeToast,
    });
    // Scroll back to the top of the page so the ticket selector is in view.
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [toast, nudgeToast]);

  const handleBillingAddressRequired = useCallback(() => {
    toast.warning(String(t("checkout.billingAddressRequiredToast")), {
      title: String(t("checkout.billingAddressRequiredTitle")),
      ...nudgeToast,
    });
    // Reveal inline errors (error text + aria-invalid) on every empty
    // required field and scroll/focus the first one — the toast alone was
    // easy to miss, which made a blocked Continue look like a no-op.
    const form = contactFormRef.current;
    if (form?.showValidationErrors) {
      form.showValidationErrors();
    } else {
      form?.focusBillingAddress();
    }
  }, [toast, nudgeToast, contactFormRef, t]);

  const handleWaiverRequired = useCallback(() => {
    fireNudge("warning", {
      title: "ONE MORE THING",
      message: "Accept the event waiver to continue.",
      target: waiverCheckboxRef.current,
      onAfter: () => {
        setWaiverHighlight(true);
        window.setTimeout(() => setWaiverHighlight(false), PULSE_MS);
      },
    });
  }, [fireNudge]);

  const handleRefundPolicyRequired = useCallback(() => {
    fireNudge("warning", {
      title: String(t("checkout.oneMoreThing")),
      message: String(t("checkout.refundPolicyRequiredToast")),
      target: refundPolicyCheckboxRef.current,
    });
  }, [fireNudge, t]);

  return {
    waiverAccepted,
    setWaiverAccepted,
    waiverCheckboxRef,
    waiverHighlight,
    termsAccepted,
    setTermsAccepted,
    refundPolicyAccepted,
    setRefundPolicyAccepted,
    setAgreementCheckboxRef,
    handleTermsRequired,
    handleSelectionRequired,
    handleBillingAddressRequired,
    handleWaiverRequired,
    handleRefundPolicyRequired,
  };
}
