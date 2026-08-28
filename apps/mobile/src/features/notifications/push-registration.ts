/**
 * Push-device registration state machine — pure, dependency-injected logic
 * shared by the lifecycle hook (`use-push-registration.ts`) and the sign-out
 * path (`use-auth-session.ts`).
 *
 * No React / Expo imports here so the whole lifecycle is unit-testable under
 * plain Vitest (mirrors the checkout-eligibility/-selection pattern).
 *
 * Server contract (commit 108ec87d):
 *   - `notifications.registerPushDevice`   — idempotent upsert on
 *     `(provider, token)`; the authed human is inferred server-side.
 *   - `notifications.unregisterPushDevice` — idempotent disable by token.
 *
 * Because the server upsert is idempotent, re-registering the same token is
 * free — but we still guard client-side ((token, humanId) equality + an
 * in-flight flag) so the AppState foreground listener doesn't spam the API
 * on every focus.
 */

export type PushPermissionStatus = "granted" | "denied" | "undetermined";

export type PushPermissionState = {
  status: PushPermissionStatus;
  /** false once the OS will no longer show the prompt — UI should deep-link
   * to system settings instead of re-asking. */
  canAskAgain: boolean;
};

export type PushPlatform = "ios" | "android" | "web" | "unknown";

export type RegisterPushDeviceInput = {
  provider: "expo";
  token: string;
  platform: PushPlatform;
  appId?: string;
};

/**
 * Mutable session-scoped registration state. A module singleton (below) is
 * shared between the hook and sign-out so "which token did we register, and
 * for whom?" survives across hook instances without persisting anything —
 * after a cold start the first authenticated sync simply re-registers
 * (idempotent).
 *
 * `registeredHumanId` exists because the token alone is NOT a sufficient
 * identity for the "unchanged" short-circuit: the Expo token is per-device,
 * so if user A's session dies without the explicit sign-out path (expiry,
 * server-side revocation) and user B signs in on the same device, the token
 * is identical but the server row still maps it to A. The guard compares
 * (token, humanId) pairs so B's first sync re-registers and reassigns the
 * device server-side.
 */
export type PushTokenStore = {
  registeredToken: string | null;
  registeredHumanId: string | null;
  inFlight: boolean;
};

export const createPushTokenStore = (): PushTokenStore => ({
  registeredToken: null,
  registeredHumanId: null,
  inFlight: false,
});

/** App-wide singleton. Tests construct their own via `createPushTokenStore`. */
export const pushTokenStore = createPushTokenStore();

/**
 * Drops local registration state (NOT the in-flight flag — a concurrent sync
 * owns that). Called by the hook whenever the session is observed signed-out,
 * covering teardown paths that bypass `signOut()` entirely (session expiry,
 * server-side revocation) so the next sign-in always re-registers instead of
 * tripping the "unchanged" guard with a token the server maps to the
 * previous account. NOTE: in practice RootNavigator unmounts SignedInTabs in
 * the same commit that the session dies, so this branch rarely runs — the
 * PRIMARY defense against cross-user token reuse is the (token, humanId)
 * pair guard in syncPushRegistration; this clear is belt-and-braces.
 */
export const clearPushTokenStore = (
  store: PushTokenStore = pushTokenStore,
): void => {
  store.registeredToken = null;
  store.registeredHumanId = null;
};

export type SyncPushResult =
  | "registered"
  | "unchanged"
  | "skipped-signed-out"
  | "skipped-permission"
  | "skipped-no-token"
  | "skipped-in-flight"
  | "failed";

export type SyncPushDeps = {
  /** Authenticated actor's humanId, or null when signed out. Part of the
   * "unchanged" guard identity — see `PushTokenStore` docs. */
  humanId: string | null;
  /** Read-only permission check — must NEVER trigger the OS prompt. */
  getPermission: () => Promise<PushPermissionState>;
  /** Returns the current Expo push token, or null when unavailable
   * (no projectId, simulator without push support, transient failure). */
  fetchToken: () => Promise<string | null>;
  register: (input: RegisterPushDeviceInput) => Promise<unknown>;
  platform: PushPlatform;
  appId?: string | null;
  store?: PushTokenStore;
  /** Best-effort error sink (Sentry). Never rethrown. */
  onError?: (error: unknown) => void;
};

/**
 * Registers the device token with the API when (and only when) the session
 * is authenticated AND notification permission is already granted. Silent
 * no-op in every other state — permission prompting is a separate, explicit
 * user action (`requestPushPermission` in the hook).
 */
export async function syncPushRegistration(
  deps: SyncPushDeps,
): Promise<SyncPushResult> {
  const store = deps.store ?? pushTokenStore;

  if (!deps.humanId) return "skipped-signed-out";
  if (store.inFlight) return "skipped-in-flight";

  store.inFlight = true;
  try {
    const permission = await deps.getPermission();
    if (permission.status !== "granted") return "skipped-permission";

    const token = await deps.fetchToken();
    if (!token) return "skipped-no-token";

    // Rotation/reassignment guard: short-circuit ONLY when both the token
    // and the actor match what we already registered this app session. The
    // humanId half matters when an account switch happens on one device —
    // the token is unchanged but the server row must be reassigned. Same-
    // (token, human) re-registration is server-idempotent anyway, so a lost
    // in-memory store (cold start) costs one cheap upsert.
    if (
      store.registeredToken === token &&
      store.registeredHumanId === deps.humanId
    ) {
      return "unchanged";
    }

    await deps.register({
      provider: "expo",
      token,
      platform: deps.platform,
      ...(deps.appId ? { appId: deps.appId } : {}),
    });
    store.registeredToken = token;
    store.registeredHumanId = deps.humanId;
    return "registered";
  } catch (error) {
    deps.onError?.(error);
    return "failed";
  } finally {
    store.inFlight = false;
  }
}

export type UnregisterPushResult = "unregistered" | "skipped-no-token" | "failed";

export type UnregisterPushDeps = {
  unregister: (input: { token: string }) => Promise<unknown>;
  store?: PushTokenStore;
  /** Hard cap so sign-out never hangs on a dead network. */
  timeoutMs?: number;
  onError?: (error: unknown) => void;
};

const DEFAULT_UNREGISTER_TIMEOUT_MS = 2_500;

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`push_unregister_timeout_${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Best-effort unregistration of the token registered this app session.
 * Called BEFORE the session is torn down (the mutation needs the auth
 * header), but it must never block or fail sign-out — errors are swallowed
 * into `onError` and the local token state is cleared eagerly so the next
 * sign-in always re-registers instead of tripping the "unchanged" guard.
 */
export async function unregisterCurrentPushDevice(
  deps: UnregisterPushDeps,
): Promise<UnregisterPushResult> {
  const store = deps.store ?? pushTokenStore;
  const token = store.registeredToken;
  if (!token) return "skipped-no-token";

  // Clear eagerly — the session is going away either way.
  clearPushTokenStore(store);

  try {
    await withTimeout(
      deps.unregister({ token }),
      deps.timeoutMs ?? DEFAULT_UNREGISTER_TIMEOUT_MS,
    );
    return "unregistered";
  } catch (error) {
    deps.onError?.(error);
    return "failed";
  }
}
