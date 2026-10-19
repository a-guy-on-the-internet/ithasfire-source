"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslations } from "@th/ui";
import { normalizeError } from "@/lib/errors/normalize-error";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";

export type UseFormErrorsReturn<F extends string = string> = {
  fieldErrors: Partial<Record<F, string>>;
  formError: string | null;
  setError: (error: unknown) => void;
  setFieldError: (field: F, msg: string) => void;
  clearField: (field: F) => void;
  clearAll: () => void;
  hasErrors: boolean;
};

export function useFormErrors<
  F extends string = string,
>(): UseFormErrorsReturn<F> {
  const t = useTranslations();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<F, string>>>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);

  const setError = useCallback(
    (error: unknown) => {
      // The B2 gate (`email_verification_required`) rides tRPC FORBIDDEN, and
      // the wire `appCode` for it is the generic `FORBIDDEN`, which
      // `normalizeError` resolves first to "You don't have permission". Say
      // what the account has to do instead.
      if (isEmailVerificationRequired(error)) {
        setFieldErrors({});
        setFormError(String(t("errors.emailVerificationRequired")));
        return;
      }
      const normalized = normalizeError(error, t);
      setFieldErrors(normalized.fieldErrors as Partial<Record<F, string>>);
      setFormError(normalized.formError);
    },
    [t],
  );

  const setFieldError = useCallback((field: F, msg: string) => {
    setFieldErrors((prev) => ({ ...prev, [field]: msg }));
  }, []);

  const clearField = useCallback((field: F) => {
    setFieldErrors((prev) => {
      // Bail out when the field has no error: forms call clearField on every
      // keystroke, and returning a fresh object each time re-rendered the whole
      // form (and churned `fieldErrors` identity for memoized children) for
      // nothing.
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setFieldErrors({});
    setFormError(null);
  }, []);

  const hasErrors = useMemo(
    () => formError !== null || Object.keys(fieldErrors).length > 0,
    [formError, fieldErrors],
  );

  return {
    fieldErrors,
    formError,
    setError,
    setFieldError,
    clearField,
    clearAll,
    hasErrors,
  };
}
