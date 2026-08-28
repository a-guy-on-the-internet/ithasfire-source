import { useCallback, useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import * as Sentry from "@sentry/react-native";

import { trpc } from "@/lib/trpc";
import { useAuthSession } from "@/features/auth/use-auth-session";

import {
  fetchExpoPushToken,
  getPushAppId,
  getPushPermission,
  getPushPlatform,
  initPushNotifications,
  requestPushPermission,
} from "./expo-push";
import {
  clearPushTokenStore,
  syncPushRegistration,
  type PushPermissionState,
} from "./push-registration";

/**
 * Push-device registration lifecycle.
 *
 * Mounted once in `SignedInTabs` for the background lifecycle (register on
 * auth + permission, re-check on foreground for token rotation) and again in
 * `SettingsScreen` for the opt-in UI. Multiple instances are safe: the
 * shared module store in `push-registration.ts` guards with (token, humanId)
 * equality + an in-flight flag, and the server upsert is idempotent
 * regardless.
 *
 * Deliberately NEVER prompts on its own — `requestPermission` is only wired
 * to an explicit user tap (Settings → Notifications). When the OS won't
 * re-prompt (`canAskAgain === false`), the UI deep-links to system settings
 * via `openSystemSettings` instead of nagging.
 */
export const usePushRegistration = () => {
  const { humanId } = useAuthSession();
  const registerMutation = trpc.notifications.registerPushDevice.useMutation({
    retry: 1,
  });
  const registerAsync = registerMutation.mutateAsync;

  const [permission, setPermission] = useState<PushPermissionState | null>(
    null,
  );

  const sync = useCallback(async () => {
    await initPushNotifications();
    // Read (never prompt) so denied users are never nagged; keep local UI
    // state fresh — e.g. after the user flips the toggle in OS settings and
    // foregrounds the app.
    const current = await getPushPermission();
    setPermission(current);

    return syncPushRegistration({
      humanId,
      getPermission: async () => current,
      fetchToken: fetchExpoPushToken,
      register: (input) => registerAsync(input),
      platform: getPushPlatform(),
      appId: getPushAppId(),
      onError: (error) => Sentry.captureException(error),
    });
  }, [humanId, registerAsync]);

  // Register when the session becomes authenticated, and re-check on every
  // return to foreground to catch Expo push token rotation. The state
  // machine no-ops unless the (token, human) pair actually changed.
  useEffect(() => {
    if (!humanId) {
      // Session ended WITHOUT the explicit signOut() path (expiry, server-
      // side revocation): drop local registration state so the next sign-in
      // — possibly a different account on the same device — re-registers
      // instead of hitting the "unchanged" guard. Belt-and-braces alongside
      // the (token, humanId) guard in the state machine.
      clearPushTokenStore();
      return;
    }

    void sync();

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    return () => subscription.remove();
  }, [humanId, sync]);

  /** Explicit opt-in: OS prompt, then immediate registration on grant. */
  const requestPermission = useCallback(async () => {
    await initPushNotifications();
    const state = await requestPushPermission();
    setPermission(state);
    if (state.status === "granted") await sync();
    return state;
  }, [sync]);

  /** For the denied state — platform-normed jump to the app's OS settings. */
  const openSystemSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  return {
    /** null until the first permission read resolves. */
    permission,
    requestPermission,
    openSystemSettings,
  };
};
