import { useCallback } from "react";
import * as Sentry from "@sentry/react-native";

import { trpc } from "@/lib/trpc";
import { unregisterCurrentPushDevice } from "@/features/notifications/push-registration";
import { clearAllOrderTickets } from "@/features/tickets/ticket-cache";

import { authClient } from "./better-auth-client";
import { clearAuthToken } from "./auth-token-store";

/**
 * Consumer-facing auth surface. Thin wrapper over better-auth that
 * exposes the data the navigation root needs and the actions the
 * sign-in screens call.
 *
 * Distinct from apps/scanner's `use-scanner-session` because:
 *   - No org/role/event resolution (consumer doesn't need scanner RBAC)
 *   - No bootstrap telemetry (handled in scanner because operator
 *     bootstrap is a notable ops event; consumer sign-in isn't)
 */
export const useAuthSession = () => {
  const session = authClient.useSession();
  const user = session.data?.user;
  const humanId = user?.id ?? null;

  const isLoading = session.isPending;
  const isSignedIn = !!user;

  const sendMagicLink = useCallback(async (email: string) => {
    const normalized = email.trim().toLowerCase();
    if (normalized.length < 3) {
      throw new Error("Enter a valid email address.");
    }
    const result = await authClient.signIn.magicLink({
      email: normalized,
      callbackURL: "ithasfire://auth-callback",
      errorCallbackURL: "ithasfire://auth-error",
    });
    if (result.error) {
      throw new Error(result.error.message ?? "Sign-in failed.");
    }
  }, []);

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      const normalized = email.trim().toLowerCase();
      if (normalized.length < 3) {
        throw new Error("Enter a valid email address.");
      }
      if (password.length < 1) {
        throw new Error("Enter your password.");
      }
      const result = await authClient.signIn.email({
        email: normalized,
        password,
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Sign-in failed.");
      }
      // Deliberately does NOT call clearAuthToken() here.
      //
      // It used to, back when clearAuthToken only reset a JWT memo and the
      // session token was never stored at all — harmless then. Now that the
      // store is real, clearing here deletes the session token that
      // better-auth's `onSuccess` hook just persisted, so every sign-in
      // destroyed its own credential and every authed call 401'd.
      //
      // `setSessionToken` already nulls the cached JWT, so a fresh session
      // never reuses the previous one.
    },
    [],
  );

  const unregisterPushMutation =
    trpc.notifications.unregisterPushDevice.useMutation({ retry: 0 });
  const unregisterPushAsync = unregisterPushMutation.mutateAsync;

  const signOut = useCallback(async () => {
    // Best-effort push cleanup BEFORE the session is torn down (the mutation
    // needs the auth header). Internally time-boxed and error-swallowing —
    // sign-out must never block or fail on it.
    await unregisterCurrentPushDevice({
      unregister: (input) => unregisterPushAsync(input),
      onError: (error) => Sentry.captureException(error),
    });
    try {
      await authClient.signOut();
    } finally {
      // Local credential teardown runs even if the remote sign-out threw.
      // Someone with no signal tapping "Sign out" before handing their phone
      // over must still end up with nothing admittable on the device — a
      // failed network round trip cannot be allowed to veto that.
      await clearAuthToken();
      // Ticket codes are bearer credentials: whoever can read one can walk in.
      await clearAllOrderTickets();
    }
  }, [unregisterPushAsync]);

  return {
    user,
    humanId,
    isLoading,
    isSignedIn,
    sendMagicLink,
    signInWithPassword,
    signOut,
  };
};
