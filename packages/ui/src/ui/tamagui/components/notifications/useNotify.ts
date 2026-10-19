import { useCallback, useMemo } from "react";

import { useNotificationContext } from "./NotificationProvider";
import {
  type NotifyOptions,
  type PushAlertOptions,
  type ToastVariant,
} from "./types";

type ToastInput = string | NotifyOptions;
type AlertInput = string | PushAlertOptions;

const normalizeToastOptions = (
  input: ToastInput,
  overrides?: Partial<NotifyOptions>,
) => {
  if (typeof input === "string") {
    return { message: input, ...overrides } satisfies Partial<NotifyOptions>;
  }
  return { ...input, ...overrides } satisfies Partial<NotifyOptions>;
};

const normalizeAlertOptions = (
  input: AlertInput,
  overrides?: Partial<PushAlertOptions>,
) => {
  if (typeof input === "string") {
    return { message: input, ...overrides } satisfies Partial<PushAlertOptions>;
  }
  return { ...input, ...overrides } satisfies Partial<PushAlertOptions>;
};

const createToastShortcut =
  (variant: ToastVariant, notify: (options: NotifyOptions) => string) =>
  (input: ToastInput, overrides?: Partial<NotifyOptions>) =>
    notify({
      variant,
      ...normalizeToastOptions(input, overrides),
    });

const createAlertShortcut =
  (variant: ToastVariant, pushAlert: (options: PushAlertOptions) => string) =>
  (input: AlertInput, overrides?: Partial<PushAlertOptions>) =>
    pushAlert({
      variant,
      ...normalizeAlertOptions(input, overrides),
    });

export const useNotify = () => {
  const context = useNotificationContext();

  const toastShortcutFactory = useCallback(
    (variant: ToastVariant) => createToastShortcut(variant, context.notify),
    [context.notify],
  );

  const alertShortcutFactory = useCallback(
    (variant: ToastVariant) => createAlertShortcut(variant, context.pushAlert),
    [context.pushAlert],
  );

  const toast = useMemo(
    () => ({
      info: toastShortcutFactory("info"),
      success: toastShortcutFactory("success"),
      warning: toastShortcutFactory("warning"),
      danger: toastShortcutFactory("danger"),
      neutral: toastShortcutFactory("neutral"),
      /**
       * Wrap a promise in a toast that morphs through loading → success/error.
       * Sonner-style. Returns the original promise so callers can `await` it.
       */
      promise: context.promise,
    }),
    [toastShortcutFactory, context.promise],
  );

  const alert = useMemo(
    () => ({
      push: context.pushAlert,
      remove: context.removeAlert,
      info: alertShortcutFactory("info"),
      success: alertShortcutFactory("success"),
      warning: alertShortcutFactory("warning"),
      danger: alertShortcutFactory("danger"),
      neutral: alertShortcutFactory("neutral"),
    }),
    [alertShortcutFactory, context.pushAlert, context.removeAlert],
  );

  return {
    /** Current notification config (maxVisible, position, etc.) */
    config: context.config,
    /** Current notification state (visible toasts, queue, alerts) */
    state: context.state,
    /** Low-level toast notification trigger */
    notify: context.notify,
    /** Dismiss a toast by ID, or all toasts if no ID provided */
    dismiss: context.dismiss,
    /** Clear all toasts immediately */
    clear: context.clear,
    /** Pause auto-dismiss timer for a toast */
    pause: context.pauseToast,
    /** Resume auto-dismiss timer for a toast */
    resume: context.resumeToast,
    /**
     * Toast shortcuts: `toast.info()`, `toast.success()`, `toast.warning()`, `toast.danger()`, `toast.neutral()`
     * Each accepts a string message or full NotifyOptions object.
     */
    toast,
    /**
     * Alert shortcuts: `alert.info()`, `alert.success()`, `alert.warning()`, `alert.danger()`, `alert.neutral()`
     * Plus `alert.push()` for raw PushAlertOptions, and `alert.remove(id)` to dismiss.
     */
    alert,
    /** @deprecated Use `alert.remove` instead */
    removeAlert: context.removeAlert,
    /** @deprecated Use `alert.push` instead */
    pushAlert: context.pushAlert,
  };
};

export type UseNotifyReturn = ReturnType<typeof useNotify>;
