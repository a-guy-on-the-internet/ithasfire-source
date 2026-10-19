"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";

import { Platform } from "react-native";

import { Stack } from "tamagui";

import {
  DEFAULT_DEDUPE_STRATEGY,
  DEFAULT_DURATION_MS,
  DEFAULT_MAX_VISIBLE,
  DEFAULT_PAUSE_ON_HOVER,
  DEFAULT_POSITION,
  MIN_DURATION_MS,
  PROVIDER_DATA_ATTRIBUTE,
  type AlertConfig,
  type NotificationContextValue,
  type NotificationProviderProps,
  type NotificationState,
  type NotificationTimers,
  type NotifyOptions,
  type PushAlertOptions,
  type ToastDedupeStrategy,
  type ToastInternal,
} from "./types";
import { ToastViewport } from "./Toast";
import {
  notifyWeb,
  dismissWeb,
  clearWeb,
  promiseWeb,
  SonnerViewport,
} from "./SonnerBridge";

const NotificationContext = createContext<NotificationContextValue | undefined>(
  undefined,
);

const createInitialState = (): NotificationState => ({
  visibleToasts: [],
  toastQueue: [],
  alerts: [],
});

type NotificationAction =
  | { type: "SHOW_TOAST"; toast: ToastInternal }
  | { type: "QUEUE_TOAST"; toast: ToastInternal }
  | { type: "UPDATE_TOAST"; toast: ToastInternal }
  | { type: "INCREMENT_TOAST"; id: string }
  | { type: "DISMISS_TOAST"; id: string }
  | { type: "DEQUEUE_TOAST" }
  | { type: "CLEAR_TOASTS" }
  | { type: "PUSH_ALERT"; alert: AlertConfig }
  | { type: "REMOVE_ALERT"; id: string }
  | { type: "SET_ALERT_ORDER"; order: string[] };

const notificationReducer = (
  state: NotificationState,
  action: NotificationAction,
): NotificationState => {
  switch (action.type) {
    case "SHOW_TOAST":
      return {
        ...state,
        visibleToasts: [...state.visibleToasts, action.toast],
      };
    case "QUEUE_TOAST":
      return {
        ...state,
        toastQueue: [...state.toastQueue, action.toast],
      };
    case "UPDATE_TOAST":
      return {
        ...state,
        visibleToasts: state.visibleToasts.map((toast) =>
          toast.id === action.toast.id ? action.toast : toast,
        ),
        toastQueue: state.toastQueue.map((toast) =>
          toast.id === action.toast.id ? action.toast : toast,
        ),
      };
    case "INCREMENT_TOAST":
      return {
        ...state,
        visibleToasts: state.visibleToasts.map((toast) =>
          toast.id === action.id ? { ...toast, count: toast.count + 1 } : toast,
        ),
        toastQueue: state.toastQueue.map((toast) =>
          toast.id === action.id ? { ...toast, count: toast.count + 1 } : toast,
        ),
      };
    case "DISMISS_TOAST":
      return {
        ...state,
        visibleToasts: state.visibleToasts.filter(
          (toast) => toast.id !== action.id,
        ),
      };
    case "DEQUEUE_TOAST": {
      if (state.toastQueue.length === 0) {
        return state;
      }
      const [next, ...rest] = state.toastQueue;
      if (!next) {
        return state;
      }
      return {
        ...state,
        toastQueue: rest,
        visibleToasts: [...state.visibleToasts, next],
      };
    }
    case "CLEAR_TOASTS":
      return {
        ...state,
        visibleToasts: [],
        toastQueue: [],
      };
    case "PUSH_ALERT":
      return {
        ...state,
        alerts: [
          ...state.alerts.filter((alert) => alert.id !== action.alert.id),
          action.alert,
        ],
      };
    case "REMOVE_ALERT":
      return {
        ...state,
        alerts: state.alerts.filter((alert) => alert.id !== action.id),
      };
    case "SET_ALERT_ORDER": {
      if (state.alerts.length <= 1) {
        return state;
      }
      const lookup = new Map(
        state.alerts.map((alert) => [alert.id, alert] as const),
      );
      const nextAlerts: AlertConfig[] = [];
      action.order.forEach((id) => {
        const found = lookup.get(id);
        if (found) {
          nextAlerts.push(found);
          lookup.delete(id);
        }
      });
      if (lookup.size === state.alerts.length) {
        return state;
      }
      lookup.forEach((remaining) => {
        nextAlerts.push(remaining);
      });
      return {
        ...state,
        alerts: nextAlerts,
      };
    }
    default:
      return state;
  }
};

const createToastId = () =>
  `th-toast-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const DEV = process.env.NODE_ENV !== "production";

const prefersReducedMotion = (): boolean => {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

const createConfig = ({
  maxVisible = DEFAULT_MAX_VISIBLE,
  position = DEFAULT_POSITION,
  durationMs = DEFAULT_DURATION_MS,
  pauseOnHover = DEFAULT_PAUSE_ON_HOVER,
  dedupeStrategy = DEFAULT_DEDUPE_STRATEGY,
  renderContainer,
}: Omit<
  NotificationProviderProps,
  "children"
>): NotificationContextValue["config"] => {
  const safeMaxVisible = Math.max(1, maxVisible ?? DEFAULT_MAX_VISIBLE);
  const safeDuration = Math.max(
    MIN_DURATION_MS,
    durationMs ?? DEFAULT_DURATION_MS,
  );
  if (DEV) {
    if ((maxVisible ?? DEFAULT_MAX_VISIBLE) < 1) {
      // eslint-disable-next-line no-console
      console.warn(
        "[NotificationProvider] maxVisible should be at least 1. Using minimum of 1.",
      );
    }
    if ((durationMs ?? DEFAULT_DURATION_MS) < MIN_DURATION_MS) {
      // eslint-disable-next-line no-console
      console.warn(
        `[NotificationProvider] durationMs should be >= ${MIN_DURATION_MS}. Using minimum instead.`,
      );
    }
  }
  return {
    maxVisible: safeMaxVisible,
    position,
    durationMs: safeDuration,
    pauseOnHover,
    dedupeStrategy,
    renderContainer,
  };
};

const useStateRef = <T,>(value: T) => {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
};

const useHaptics = () => {
  return useCallback((enabled: boolean) => {
    if (!enabled) {
      return;
    }
    try {
      const { Vibration } = require("react-native");
      Vibration?.vibrate(35);
    } catch {
      // no-op
    }
  }, []);
};

const useVisibilityLifecycle = (
  pauseAll: () => void,
  resumeAll: () => void,
) => {
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const handleVisibility = () => {
      if (document.hidden) {
        pauseAll();
      } else {
        resumeAll();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [pauseAll, resumeAll]);
};

const useAppStateLifecycle = (pauseAll: () => void, resumeAll: () => void) => {
  useEffect(() => {
    if (Platform.OS === "web") {
      return;
    }

    let subscription: { remove: () => void } | undefined;
    try {
      const { AppState } = require("react-native");
      subscription = AppState.addEventListener(
        "change",
        (nextState: string) => {
          if (nextState === "active") {
            resumeAll();
          } else {
            pauseAll();
          }
        },
      );
    } catch {
      // no-op
    }

    return () => {
      subscription?.remove?.();
    };
  }, [pauseAll, resumeAll]);
};

export const NotificationProvider = ({
  children,
  ...props
}: NotificationProviderProps) => {
  const config = useMemo(() => createConfig(props), [props]);
  const [state, dispatch] = useReducer(
    notificationReducer,
    undefined,
    createInitialState,
  );
  const stateRef = useStateRef(state);
  const configRef = useStateRef(config);
  const timersRef = useRef<Map<string, NotificationTimers>>(new Map());
  const reducedMotionRef = useRef<boolean>(prefersReducedMotion());
  const haptics = useHaptics();

  const clearTimer = useCallback((id: string) => {
    const entry = timersRef.current.get(id);
    if (!entry) {
      return;
    }
    if (entry.timeout) {
      clearTimeout(entry.timeout);
    }
    timersRef.current.delete(id);
  }, []);

  const startTimer = useCallback(
    (id: string, duration: number) => {
      if (duration === Infinity) {
        return;
      }
      const handleTimeout = () => {
        dismiss(id);
      };
      const timeout = setTimeout(handleTimeout, duration);
      timersRef.current.set(id, {
        timeout,
        remaining: duration,
        startedAt: Date.now(),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const restartTimer = useCallback(
    (id: string, duration: number) => {
      clearTimer(id);
      startTimer(id, duration);
    },
    [clearTimer, startTimer],
  );

  const pauseToast = useCallback((id: string) => {
    const entry = timersRef.current.get(id);
    if (!entry || entry.timeout === null) {
      return;
    }
    const elapsed = Date.now() - entry.startedAt;
    const remaining = Math.max(entry.remaining - elapsed, 0);
    clearTimeout(entry.timeout);
    timersRef.current.set(id, {
      ...entry,
      timeout: null,
      remaining,
    });
  }, []);

  const resumeToast = useCallback((id: string) => {
    const entry = timersRef.current.get(id);
    if (!entry || entry.remaining === Infinity || entry.timeout) {
      return;
    }
    const timeout = setTimeout(() => {
      dismiss(id);
    }, entry.remaining);
    timersRef.current.set(id, {
      ...entry,
      timeout,
      startedAt: Date.now(),
    });
  }, []);

  const pauseAll = useCallback(() => {
    timersRef.current.forEach((_, id) => pauseToast(id));
  }, [pauseToast]);

  const resumeAll = useCallback(() => {
    timersRef.current.forEach((entry, id) => {
      if (!entry.timeout) {
        resumeToast(id);
      }
    });
  }, [resumeToast]);

  useVisibilityLifecycle(pauseAll, resumeAll);
  useAppStateLifecycle(pauseAll, resumeAll);

  const dedupeByKey = (
    id: string,
    snapshot: NotificationState,
    dedupeStrategy: ToastDedupeStrategy,
  ): ToastInternal | undefined => {
    if (dedupeStrategy !== "same-key") {
      return undefined;
    }
    return [...snapshot.visibleToasts, ...snapshot.toastQueue].find(
      (toast) => toast.id === id,
    );
  };

  const dedupeByMessage = (
    options: NotifyOptions,
    snapshot: NotificationState,
    dedupeStrategy: ToastDedupeStrategy,
  ): ToastInternal | undefined => {
    if (dedupeStrategy !== "same-message") {
      return undefined;
    }
    const variant = options.variant ?? "info";
    return [...snapshot.visibleToasts, ...snapshot.toastQueue].find(
      (toast) =>
        toast.variant === variant &&
        toast.title === options.title &&
        toast.message === options.message,
    );
  };

  const notify = useCallback(
    (options: NotifyOptions) => {
      if (Platform.OS === "web") {
        return notifyWeb(options, configRef.current.dedupeStrategy);
      }

      // Native fallback — kept for parity, currently unused (0 native call sites).
      const snapshot = stateRef.current;
      const dedupeStrategy = configRef.current.dedupeStrategy;
      const id = options.id ?? createToastId();
      const existingByKey = options.id
        ? dedupeByKey(options.id, snapshot, dedupeStrategy)
        : undefined;
      const existingByMessage = dedupeByMessage(
        options,
        snapshot,
        dedupeStrategy,
      );

      const baseDuration = options.durationMs ?? configRef.current.durationMs;
      const nextDuration = Math.max(baseDuration, MIN_DURATION_MS);
      const nextToast: ToastInternal = {
        id,
        title: options.title,
        message: options.message,
        variant: options.variant ?? "info",
        intent: options.intent ?? "system",
        durationMs: nextDuration,
        action: options.action,
        iconName: options.iconName,
        haptic: options.haptic ?? false,
        dataAttrs: options.dataAttrs,
        position: options.position ?? configRef.current.position,
        createdAt: existingByKey?.createdAt ?? Date.now(),
        count: existingByMessage
          ? existingByMessage.count + 1
          : (existingByKey?.count ?? 1),
        expiresAt: nextDuration === Infinity ? null : Date.now() + nextDuration,
      };

      if (existingByKey) {
        dispatch({ type: "UPDATE_TOAST", toast: nextToast });
        restartTimer(id, nextDuration);
        return id;
      }

      if (existingByMessage) {
        dispatch({
          type: "INCREMENT_TOAST",
          id: existingByMessage.id,
        });
        if (options.durationMs) {
          restartTimer(existingByMessage.id, nextDuration);
        }
        return existingByMessage.id;
      }

      const target = stateRef.current;
      const visibleCount = target.visibleToasts.length;
      if (visibleCount < configRef.current.maxVisible) {
        dispatch({ type: "SHOW_TOAST", toast: nextToast });
        startTimer(id, nextDuration);
      } else {
        dispatch({ type: "QUEUE_TOAST", toast: nextToast });
      }

      if (options.haptic) {
        haptics(true);
      }

      return id;
    },
    [restartTimer, startTimer, haptics, stateRef, configRef],
  );

  const shiftQueueIfNeeded = useCallback(() => {
    const snapshot = stateRef.current;
    if (snapshot.visibleToasts.length >= configRef.current.maxVisible) {
      return;
    }
    const [next] = snapshot.toastQueue;
    if (!next) {
      return;
    }
    dispatch({ type: "DEQUEUE_TOAST" });
    startTimer(next.id, next.durationMs);
  }, [configRef, startTimer, stateRef]);

  const dismiss = useCallback(
    (id?: string) => {
      if (Platform.OS === "web") {
        dismissWeb(id);
        return;
      }
      const snapshot = stateRef.current;
      const fallback =
        snapshot.visibleToasts[snapshot.visibleToasts.length - 1]?.id;
      const targetId = id ?? fallback;
      if (!targetId) {
        return;
      }
      dispatch({ type: "DISMISS_TOAST", id: targetId });
      clearTimer(targetId);
      shiftQueueIfNeeded();
    },
    [clearTimer, shiftQueueIfNeeded, stateRef],
  );

  const clear = useCallback(() => {
    if (Platform.OS === "web") {
      clearWeb();
      return;
    }
    timersRef.current.forEach((_, toastId) => clearTimer(toastId));
    timersRef.current.clear();
    dispatch({ type: "CLEAR_TOASTS" });
  }, [clearTimer]);

  const promise = useCallback<NotificationContextValue["promise"]>(
    (p, messages) => {
      return promiseWeb(p, messages);
    },
    [],
  );

  const pushAlert = useCallback((options: PushAlertOptions) => {
    const id =
      options.id ??
      `th-alert-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const alert: AlertConfig = {
      id,
      title: options.title,
      message: options.message,
      variant: options.variant ?? "info",
      dismissible: options.dismissible ?? true,
      onClose: options.onClose,
      role: options.role,
      dismissLabel: options.dismissLabel,
      dataAttrs: options.dataAttrs,
    };
    dispatch({ type: "PUSH_ALERT", alert });
    return id;
  }, []);

  const removeAlert = useCallback(
    (id: string) => {
      const existing = stateRef.current.alerts.find((alert) => alert.id === id);
      dispatch({ type: "REMOVE_ALERT", id });
      existing?.onClose?.();
    },
    [stateRef],
  );

  const reorderAlerts = useCallback((order: string[]) => {
    dispatch({ type: "SET_ALERT_ORDER", order });
  }, []);

  const contextValue = useMemo<NotificationContextValue>(
    () => ({
      state,
      config,
      notify,
      dismiss,
      clear,
      promise,
      pushAlert,
      removeAlert,
      reorderAlerts,
      pauseToast,
      resumeToast,
    }),
    [
      state,
      config,
      notify,
      dismiss,
      clear,
      promise,
      pushAlert,
      removeAlert,
      reorderAlerts,
      pauseToast,
      resumeToast,
    ],
  );

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
      {Platform.OS === "web" ? (
        <SonnerViewport
          position={config.position}
          durationMs={config.durationMs}
        />
      ) : (
        <Stack data-th={PROVIDER_DATA_ATTRIBUTE} pointerEvents="box-none">
          <ToastViewport
            toasts={state.visibleToasts}
            position={config.position}
            onDismiss={dismiss}
            pauseOnHover={config.pauseOnHover}
            reducedMotion={reducedMotionRef.current}
            pauseToast={pauseToast}
            resumeToast={resumeToast}
            renderContainer={config.renderContainer}
          />
        </Stack>
      )}
    </NotificationContext.Provider>
  );
};

export const useNotificationContext = () => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error(
      "useNotificationContext must be used within a NotificationProvider",
    );
  }
  return context;
};
