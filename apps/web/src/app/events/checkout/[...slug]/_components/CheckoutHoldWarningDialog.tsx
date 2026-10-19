"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, Ref } from "react";

import { useTranslations } from "@th/ui";

import {
  FG,
  FG_MUTED,
  SURFACE,
  FS_SM,
} from "./checkout-tokens";

export type CheckoutHoldWarningDialogProps = {
  dialogRef: Ref<HTMLDivElement | null>;
  cancelButtonRef: Ref<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  /**
   * The way back is locked (createCheckout running, a Stripe confirm
   * submitting, payment confirming): "Release" would release the order being
   * paid. The hook refuses it anyway; the button says so.
   */
  confirmDisabled?: boolean;
};

export const CheckoutHoldWarningDialog = ({
  dialogRef,
  cancelButtonRef,
  onCancel,
  onConfirm,
  onKeyDown,
  confirmDisabled = false,
}: CheckoutHoldWarningDialogProps) => {
  const t = useTranslations();
  const releaseRef = useRef<HTMLButtonElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const releaseHadFocusRef = useRef(false);
  // Our own handle on "Keep my tickets" as well as the parent's.
  const setKeepRef = useCallback(
    (node: HTMLButtonElement | null) => {
      keepRef.current = node;
      if (typeof cancelButtonRef === "function") cancelButtonRef(node);
      else if (cancelButtonRef) {
        (cancelButtonRef as { current: HTMLButtonElement | null }).current =
          node;
      }
    },
    [cancelButtonRef],
  );
  // Release had focus when it became disabled: a disabled button drops focus
  // to <body>, where Escape and the dialog's tab trap no longer work. Hand it
  // to "Keep my tickets" — the one action still available.
  useLayoutEffect(() => {
    if (!confirmDisabled) return;
    if (
      releaseHadFocusRef.current ||
      document.activeElement === releaseRef.current
    ) {
      releaseHadFocusRef.current = false;
      keepRef.current?.focus();
    }
  }, [confirmDisabled]);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)",
        animation: "fadeIn 0.15s ease",
      }}
      onClick={onCancel}
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="hold-warning-title"
        aria-describedby="hold-warning-desc"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: SURFACE,
          border: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
          borderRadius: 0,
          padding: "28px 24px 20px",
          maxWidth: 400,
          width: "calc(100% - 32px)",
          animation: "slideUp 0.2s ease",
        }}
      >
        <h3
          id="hold-warning-title"
          style={{
            margin: "0 0 8px",
            fontSize: 18,
            fontWeight: 700,
            color: FG,
          }}
        >
          {String(t("checkout.holdWarningTitle"))}
        </h3>
        <p
          id="hold-warning-desc"
          style={{
            margin: "0 0 24px",
            fontSize: FS_SM,
            lineHeight: 1.6,
            color: FG_MUTED,
          }}
        >
          {String(t("checkout.holdWarningDescription"))}
        </p>
        {confirmDisabled && (
          <p
            id="hold-warning-locked-reason"
            data-testid="hold-warning-locked-reason"
            style={{
              margin: "-12px 0 16px",
              fontSize: FS_SM,
              lineHeight: 1.5,
              color: FG,
            }}
          >
            {String(t("checkout.holdWarningPaymentInProgress"))}
          </p>
        )}
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button
            ref={setKeepRef}
            type="button"
            onClick={onCancel}
            style={{
              padding: "10px 20px",
              fontSize: FS_SM,
              fontWeight: 700,
              fontFamily: "inherit",
              color: FG_MUTED,
              background: "transparent",
              border: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
              borderRadius: 0,
              cursor: "pointer",
            }}
          >
            {String(t("checkout.holdWarningCancel"))}
          </button>
          <button
            ref={releaseRef}
            type="button"
            onClick={confirmDisabled ? undefined : onConfirm}
            disabled={confirmDisabled}
            // Why it is disabled, read with it.
            aria-describedby={
              confirmDisabled ? "hold-warning-locked-reason" : undefined
            }
            onFocus={() => {
              releaseHadFocusRef.current = true;
            }}
            onBlur={() => {
              releaseHadFocusRef.current = false;
            }}
            style={{
              padding: "10px 20px",
              fontSize: FS_SM,
              fontWeight: 700,
              fontFamily: "inherit",
              color: "#FFFFFF",
              background: "rgba(220,38,38,0.8)",
              border: "1px solid rgba(220,38,38,0.6)",
              borderRadius: 0,
              cursor: confirmDisabled ? "not-allowed" : "pointer",
              opacity: confirmDisabled ? 0.45 : 1,
            }}
          >
            {String(t("checkout.holdWarningConfirm"))}
          </button>
        </div>
      </div>
    </div>
  );
};

CheckoutHoldWarningDialog.displayName = "CheckoutHoldWarningDialog";
