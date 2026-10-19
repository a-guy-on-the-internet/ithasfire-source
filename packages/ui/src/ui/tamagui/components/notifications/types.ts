import type { ReactNode } from "react";

export type ToastVariant =
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "neutral";

export type ToastIntent = "system" | "user" | "network" | "payment" | "success";

export type ToastPosition =
  | "top-right"
  | "top-left"
  | "top-center"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type ToastDedupeStrategy = "same-message" | "same-key" | "none";

export interface ToastActionConfig {
  label: string;
  onPress: () => void;
}

export interface ToastDataAttributes {
  [key: string]: string | undefined;
}

export interface NotifyOptions {
  id?: string;
  title?: string;
  message?: string;
  variant?: ToastVariant;
  intent?: ToastIntent;
  durationMs?: number;
  action?: ToastActionConfig;
  iconName?: string;
  haptic?: boolean;
  dataAttrs?: ToastDataAttributes;
  /**
   * Override the global Toaster position for a single toast — useful when
   * a specific form / surface needs the toast anchored differently from
   * the app default (e.g. anchored under a long form rather than the
   * top-right edge). Falls back to the provider's `position` when omitted.
   *
   * **Web only.** Honored by SonnerBridge → sonner. The native bridge
   * (Burnt) currently ignores this field; native toasts always use the
   * provider position. If/when per-toast positioning is needed on native,
   * extend the native bridge to map this through.
   */
  position?: ToastPosition;
}

export interface ToastInternal extends Required<
  Omit<NotifyOptions, "action" | "dataAttrs" | "iconName" | "title" | "message">
> {
  id: string;
  title?: string;
  message?: string;
  action?: ToastActionConfig;
  iconName?: string;
  dataAttrs?: ToastDataAttributes;
  createdAt: number;
  count: number;
  expiresAt: number | null;
}

export interface AlertConfig {
  id: string;
  title?: string;
  message?: string;
  variant?: ToastVariant;
  dismissible?: boolean;
  onClose?: () => void;
  role?: "status" | "alert";
  dismissLabel?: string;
  dataAttrs?: ToastDataAttributes;
}

export interface PushAlertOptions extends Omit<AlertConfig, "id"> {
  id?: string;
}

export interface NotificationProviderProps {
  children: ReactNode;
  maxVisible?: number;
  position?: ToastPosition;
  durationMs?: number;
  pauseOnHover?: boolean;
  dedupeStrategy?: ToastDedupeStrategy;
  renderContainer?: (children: ReactNode) => ReactNode;
}

export interface NotificationState {
  visibleToasts: ToastInternal[];
  toastQueue: ToastInternal[];
  alerts: AlertConfig[];
}

export interface NotificationTimers {
  timeout: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
}

export interface NotificationContextValue {
  state: NotificationState;
  config: Required<
    Omit<NotificationProviderProps, "children" | "renderContainer">
  > & {
    renderContainer?: NotificationProviderProps["renderContainer"];
  };
  notify: (options: NotifyOptions) => string;
  dismiss: (id?: string) => void;
  clear: () => void;
  promise: <T>(
    promise: Promise<T> | (() => Promise<T>),
    messages: {
      loading: string;
      success: string | ((data: T) => string);
      error: string | ((err: unknown) => string);
    },
  ) => Promise<T>;
  pushAlert: (options: PushAlertOptions) => string;
  removeAlert: (id: string) => void;
  reorderAlerts: (order: string[]) => void;
  pauseToast: (id: string) => void;
  resumeToast: (id: string) => void;
}

export const DEFAULT_MAX_VISIBLE = 3;
export const DEFAULT_POSITION: ToastPosition = "top-right";
export const DEFAULT_DURATION_MS = 4000;
export const DEFAULT_PAUSE_ON_HOVER = true;
export const DEFAULT_DEDUPE_STRATEGY: ToastDedupeStrategy = "same-key";
export const MIN_DURATION_MS = 500;

export const TOAST_DATA_ATTRIBUTE = "notify.toast";
export const ALERT_DATA_ATTRIBUTE = "notify.alert";
export const PROVIDER_DATA_ATTRIBUTE = "notify.container";
export const TOAST_CLOSE_ATTRIBUTE = "notify.toast.close";
export const TOAST_ACTION_ATTRIBUTE = "notify.toast.action";
export const ALERT_CLOSE_ATTRIBUTE = "notify.alert.close";
