import { Platform } from "react-native";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Sentry from "@sentry/react-native";

import type {
  PushPermissionState,
  PushPlatform,
} from "./push-registration";

/**
 * Thin, side-effectful wrappers around `expo-notifications` — everything the
 * pure state machine in `push-registration.ts` can't touch directly. Kept
 * separate so the lifecycle logic stays unit-testable without native mocks.
 */

const toPermissionState = (
  permissions: Notifications.NotificationPermissionsStatus,
): PushPermissionState => ({
  // `granted` covers iOS provisional grants too; anything else collapses to
  // denied/undetermined based on whether the OS prompt has been shown.
  status: permissions.granted
    ? "granted"
    : permissions.status === "undetermined"
      ? "undetermined"
      : "denied",
  canAskAgain: permissions.canAskAgain,
});

/** Read-only permission check — never triggers the OS prompt. */
export const getPushPermission = async (): Promise<PushPermissionState> =>
  toPermissionState(await Notifications.getPermissionsAsync());

/** Shows the OS prompt (or resolves immediately if already determined). */
export const requestPushPermission = async (): Promise<PushPermissionState> =>
  toPermissionState(await Notifications.requestPermissionsAsync());

let initialized = false;

/**
 * One-time notification init:
 *   - Foreground presentation handler (SDK 53+ shape: banner + list).
 *   - Android default channel — required before any push can display on
 *     Android 8+; safe to call repeatedly but guarded anyway.
 *
 * Idempotent; called lazily from the registration hook rather than at cold
 * start so the module stays out of the critical launch path.
 */
export const initPushNotifications = async (): Promise<void> => {
  if (initialized) return;
  initialized = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  if (Platform.OS === "android") {
    // HIGH (peek/banner) — reveal, cancellation, and reschedule notices are
    // attention-relevant, and iOS shows banners; keep the asymmetry closed.
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
};

/**
 * Current Expo push token, or null when unavailable. Token fetch failures
 * are EXPECTED in some environments (iOS Simulator on older Xcode, missing
 * projectId in bare `expo start` without EAS config), so they're recorded
 * as breadcrumbs — not captured exceptions — and surface as a silent no-op.
 */
export const fetchExpoPushToken = async (): Promise<string | null> => {
  const projectId: string | undefined =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

  if (!projectId) {
    Sentry.addBreadcrumb({
      category: "push",
      level: "warning",
      message: "push_token_skipped_no_project_id",
    });
    return null;
  }

  try {
    const result = await Notifications.getExpoPushTokenAsync({ projectId });
    return result.data || null;
  } catch (error) {
    Sentry.addBreadcrumb({
      category: "push",
      level: "warning",
      message: "push_token_fetch_failed",
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
};

export const getPushPlatform = (): PushPlatform => {
  switch (Platform.OS) {
    case "ios":
      return "ios";
    case "android":
      return "android";
    case "web":
      return "web";
    default:
      return "unknown";
  }
};

/** Native bundle id / package name (`com.ithasfire.app` / `com.ithasfire`). */
export const getPushAppId = (): string | null => Application.applicationId;
