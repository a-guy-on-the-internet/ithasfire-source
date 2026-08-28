import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  authClient,
  magicLinkCallbackUrl,
  magicLinkErrorUrl,
} from "./better-auth-client";
import { clearAuthToken, loadSessionToken } from "./auth-token-store";
import { subscribeAuthInvalidated } from "./auth-invalidation-bus";
import {
  loadScannerPreferences,
  saveScannerPreferences,
  type ScannerPreferences,
} from "../../lib/storage";
import { getAppVersion, getRecordedChannel } from "../../lib/app-info";
import { friendlyError } from "../../lib/error-messages";
import { releaseFeedbackAudio } from "../../lib/feedback";
import { clearAll as clearLocalDb } from "../../lib/local-db";
import { showErrorToast } from "../../lib/toast";
import { trpc, type RouterOutputs } from "../../trpc";

export type AccessibleEvent = {
  eventId: string;
  orgId: string;
  orgName: string;
  eventName: string;
  startAt: Date | string | null;
  endAt: Date | string | null;
  status: string;
  role: string;
  lat?: number | null;
  lng?: number | null;
};

const isAccessibleEvent = (x: unknown): x is AccessibleEvent =>
  !!x &&
  typeof x === "object" &&
  typeof (x as { eventId?: unknown }).eventId === "string" &&
  typeof (x as { orgId?: unknown }).orgId === "string" &&
  typeof (x as { eventName?: unknown }).eventName === "string";

/**
 * Narrow `RouterOutputs["scanner"]["listAccessibleEvents"]` (which resolves to
 * `unknown` for the scanner tsconfig) to a typed array. Returns [] for any
 * shape mismatch — never throws into the render path.
 */
export const narrowAccessibleEvents = (data: unknown): AccessibleEvent[] => {
  if (!data || typeof data !== "object") return [];
  const events = (data as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  return events.filter(isAccessibleEvent);
};

const emptyPreferences: ScannerPreferences = {
  eventId: null,
  soundEnabled: true,
  hapticsEnabled: true,
  // Reset on sign-out so the next operator gets nudged to enrol their
  // own passkey. (The previous operator's dismissal doesn't apply.)
  passkeyPromptDismissed: false,
  /**
   * NFR-005 — express mode resets to OFF on sign-out, explicitly.
   *
   * It would be OFF anyway on a fresh install, but this is a shared-device
   * app: the next operator on this phone must not inherit a mode that admits
   * people with zero taps from an operator who has left. Opting in is a
   * decision, and it does not survive the person who made it.
   */
  expressModeEnabled: false,
};

export type ScannerSessionContext =
  RouterOutputs["scanner"]["getSessionContext"];

/**
 * Concrete session-context shape used at call sites.
 *
 * `ScannerSessionContext` resolves to `unknown` because the scanner tsconfig
 * cannot follow transitive @th/core type dependencies. We declare the fields
 * we actually read so consumers get real type safety without relying on the
 * upstream router output.
 */
export type TypedSessionContext = {
  operator: {
    humanId: string;
    displayName: string;
    email: string;
    /**
     * Scanner POS terms acknowledgement pointers. Optional because the
     * runtime narrower only validates `humanId` — a stale server build may
     * omit them, in which case the POS gate fails closed (shows the modal).
     */
    scannerTermsAckAt?: Date | string | null;
    scannerTermsAckVersion?: string | null;
  };
  orgs: Array<{ orgId: string; orgName: string; role: string }>;
  currentEvent?: {
    eventId: string;
    orgId: string;
    eventName: string;
    role: string;
    startAt: Date | null;
    endAt: Date | null;
    status: string;
  };
};

/**
 * Runtime narrower for {@link ScannerSessionContext} → {@link TypedSessionContext}.
 * Returns null on shape mismatch so callers can fall back gracefully without
 * a try/catch around every property access.
 */
export const narrowSessionContext = (
  ctx: ScannerSessionContext | null,
): TypedSessionContext | null => {
  if (!ctx || typeof ctx !== "object") return null;
  const operator = (ctx as { operator?: unknown }).operator;
  if (
    !operator ||
    typeof operator !== "object" ||
    typeof (operator as { humanId?: unknown }).humanId !== "string"
  ) {
    return null;
  }
  return ctx as TypedSessionContext;
};

const bootstrapReportedFor = new Set<string>();

const logBootstrapFailure = (message: string): void => {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn("[scanner] recordBootstrap failed", message);
  }
};

function pickNearestEvent(events: AccessibleEvent[]): AccessibleEvent | null {
  if (events.length === 0) return null;
  if (events.length === 1) return events[0]!;
  const now = Date.now();
  let best = events[0]!;
  let bestDist = Infinity;
  for (const ev of events) {
    if (!ev.startAt) continue;
    const t = (
      ev.startAt instanceof Date ? ev.startAt : new Date(ev.startAt)
    ).getTime();
    const dist = Math.abs(t - now);
    if (dist < bestDist) {
      bestDist = dist;
      best = ev;
    }
  }
  return best;
}

export const useScannerSession = () => {
  const sessionQuery = authClient.useSession();
  const user = sessionQuery.data?.user;
  const humanId = user?.id;

  const [preferences, setPreferences] = useState<ScannerPreferences | null>(
    null,
  );

  // Hydrate the in-memory session token from SecureStore before any auth or
  // tRPC call can fire — without this, on every cold start `getSessionTokenSync`
  // returns null, the bearer header is empty, and every request 401s back to
  // the sign-in screen even though the persisted token is still valid. Refetch
  // the session query once hydration completes so `useSession()` re-reads now
  // that the bearer header will actually be attached.
  const [tokenHydrated, setTokenHydrated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadSessionToken().then(() => {
      if (cancelled) return;
      setTokenHydrated(true);
      void sessionQuery.refetch();
    });
    return () => {
      cancelled = true;
    };
    // sessionQuery.refetch identity is stable enough; we only want this once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadScannerPreferences().then((loaded) => {
      setPreferences(loaded);
    });
  }, []);

  const updatePreferences = useCallback(async (next: ScannerPreferences) => {
    setPreferences(next);
    await saveScannerPreferences(next);
  }, []);

  const sessionContextQuery = trpc.scanner.getSessionContext.useQuery(
    {},
    {
      enabled: !!humanId,
      retry: false,
      staleTime: 60_000,
    },
  );

  const sessionContext: ScannerSessionContext | null =
    sessionContextQuery.data ?? null;

  const accessDenied = !!(
    humanId &&
    sessionContextQuery.error &&
    sessionContextQuery.error.data?.code === "FORBIDDEN"
  );

  const eventsQuery = trpc.scanner.listAccessibleEvents.useQuery(
    {},
    { enabled: !!humanId && !accessDenied, staleTime: 60_000 },
  );
  const accessibleEvents = useMemo(
    () => narrowAccessibleEvents(eventsQuery.data),
    [eventsQuery.data],
  );

  const resolvedEvent = useMemo(() => {
    if (accessibleEvents.length === 0) return null;
    if (preferences?.eventId) {
      const cached = accessibleEvents.find(
        (e) => e.eventId === preferences.eventId,
      );
      if (cached) return cached;
    }
    return pickNearestEvent(accessibleEvents);
  }, [accessibleEvents, preferences?.eventId]);

  useEffect(() => {
    if (!resolvedEvent || !preferences) return;
    if (preferences.eventId === resolvedEvent.eventId) return;
    void updatePreferences({ ...preferences, eventId: resolvedEvent.eventId });
  }, [resolvedEvent, preferences, updatePreferences]);

  const recordBootstrap = trpc.scanner.recordBootstrap.useMutation();

  useEffect(() => {
    if (!humanId) return;
    if (bootstrapReportedFor.has(humanId)) return;
    // Wait for preferences to load before reporting — otherwise we miss
    // capturing the operator's saved eventId in success telemetry.
    if (!preferences) return;

    if (sessionContext) {
      bootstrapReportedFor.add(humanId);
      recordBootstrap.mutate(
        {
          appVersion: getAppVersion(),
          channel: getRecordedChannel(),
          eventId: preferences.eventId ?? undefined,
          outcome: "success",
        },
        {
          onError: (err) => {
            logBootstrapFailure(err.message);
          },
        },
      );
      return;
    }

    if (accessDenied) {
      bootstrapReportedFor.add(humanId);
      recordBootstrap.mutate(
        {
          appVersion: getAppVersion(),
          channel: getRecordedChannel(),
          outcome: "failure",
          failureReason: "no_scanner_role",
        },
        {
          onError: (err) => {
            logBootstrapFailure(err.message);
          },
        },
      );
    }
    // `recordBootstrap` is intentionally omitted — its identity is unstable
    // across renders and the bootstrapReportedFor guard prevents double-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [humanId, sessionContext, accessDenied, preferences]);

  const signInWithPassword = useCallback(
    async (identifier: string, password: string) => {
      const normalized = identifier.trim().toLowerCase();
      if (normalized.length < 3) {
        throw new Error("Enter your email or username.");
      }
      if (password.length < 1) {
        throw new Error("Enter your password.");
      }

      // The same input field accepts both — if it contains `@` we treat
      // it as an email, otherwise a username. Better Auth exposes the
      // two paths as separate endpoints (`signIn.email`, `signIn.username`)
      // and the server-side username plugin is already wired in
      // apps/api/src/auth/better-auth.ts.
      const looksLikeEmail = normalized.includes("@");

      let result:
        | Awaited<ReturnType<typeof authClient.signIn.email>>
        | Awaited<ReturnType<typeof authClient.signIn.username>>;
      try {
        result = looksLikeEmail
          ? await authClient.signIn.email({ email: normalized, password })
          : await authClient.signIn.username({
              username: normalized,
              password,
            });
      } catch (thrown) {
        throw thrown instanceof Error ? thrown : new Error(String(thrown));
      }

      if (result.error) {
        throw new Error(
          result.error.message ??
            `Sign-in failed (${result.error.status ?? "unknown"}).`,
        );
      }
      await sessionQuery.refetch();
    },
    [sessionQuery],
  );

  /**
   * Email + password sign-up. Symmetric with the web /sign-up form — same
   * Better Auth endpoint, same validation, same auto-sign-in-on-success
   * behaviour. The scanner's role-gated home screen will route the new
   * account to `AccessDeniedScreen` if no SCANNER role has been granted
   * yet, with a "ask your org admin for access" prompt; the operator can
   * still enroll a passkey from settings before that role lands.
   */
  const signUpWithPassword = useCallback(
    async (email: string, password: string, name: string) => {
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedName = name.trim();
      if (normalizedEmail.length < 3) {
        throw new Error("Enter a valid email address.");
      }
      if (password.length < 8) {
        throw new Error("Pick a password at least 8 characters long.");
      }
      if (normalizedName.length < 1) {
        throw new Error("Enter your name.");
      }

      const result = await authClient.signUp.email({
        email: normalizedEmail,
        password,
        name: normalizedName,
      });

      if (result.error) {
        throw new Error(result.error.message ?? "Sign-up failed.");
      }
      // Better Auth returns a session on successful sign-up — refetch so
      // `useSession()` flips to authed without a second round trip.
      await sessionQuery.refetch();
    },
    [sessionQuery],
  );

  const signInWithPasskey = useCallback(async () => {
    const { signInWithPasskey: passkeySignIn } =
      await import("./passkey-client");
    const result = await passkeySignIn();
    if (result.error) {
      // Preserve the structured `code` (e.g. "user_cancelled") through the
      // re-throw so screen-level detection can branch on the code rather than
      // regexing the message (see @th/errors `normalizeError`/`isWebAuthnCancel`).
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code,
      });
    }
    // Force the session query to re-read so `useSession()` flips to authed.
    await sessionQuery.refetch();
  }, [sessionQuery]);

  const signInWithOAuth = useCallback(
    async (provider: "google" | "apple") => {
      // expoClient + better-auth's `signIn.social` opens the OAuth flow in
      // an in-app browser, then redirects back to our `ithasfire-scanner://`
      // scheme with the session token. The expo plugin captures the token
      // and the bearer-token onSuccess hook in better-auth-client.ts persists
      // it. We then refetch the session so the UI flips to authed.
      const result = await authClient.signIn.social({
        provider,
        callbackURL: magicLinkCallbackUrl,
        errorCallbackURL: magicLinkErrorUrl,
      });
      if (result.error) {
        // Carry the structured `code` through the re-throw (see passkey path).
        throw Object.assign(
          new Error(result.error.message ?? `${provider} sign-in failed.`),
          { code: result.error.code },
        );
      }
      await sessionQuery.refetch();
    },
    [sessionQuery],
  );

  const sendMagicLink = useCallback(async (email: string) => {
    const normalized = email.trim().toLowerCase();
    if (normalized.length < 3) {
      throw new Error("Enter a valid email address.");
    }

    const result = await authClient.signIn.magicLink({
      email: normalized,
      callbackURL: magicLinkCallbackUrl,
      errorCallbackURL: magicLinkErrorUrl,
    });

    if (result.error) {
      throw new Error(result.error.message);
    }
  }, []);

  const signOut = useCallback(async () => {
    const previousHumanId = humanId;
    // Wipe the local SQLite cache (people PII, tickets, events, scan queue,
    // recent scans) BEFORE clearing the auth session. Sign-out is the one
    // operation that must always purge cached operator data — centralising
    // it here covers every call site (home screen, access-denied screen,
    // any future surface) without each one needing to remember.
    try {
      clearLocalDb();
    } catch (err) {
      if (__DEV__) {
        console.warn("[scanner] clearLocalDb on sign-out failed", err);
      }
    }
    // Release the cached feedback-tone players alongside the data purge —
    // nothing should hold decoded audio for a session that has ended.
    releaseFeedbackAudio();
    await authClient.signOut();
    await clearAuthToken();
    await updatePreferences(emptyPreferences);
    if (previousHumanId) {
      bootstrapReportedFor.delete(previousHumanId);
    }
  }, [humanId, updatePreferences]);

  // Server-side session revocation → 401 from any tRPC call → forced sign-out.
  // This is the "remote wipe" mechanism: an admin revokes the operator's auth
  // session, the device picks it up on its next request, and `signOut` wipes
  // the local SQLite cache. `signedOutRef` is only reset on a *fresh* sign-in
  // (a previously-empty humanId becoming defined), so straggling 401s after
  // sign-out completes don't trigger a redundant second sign-out.
  const signedOutRef = useRef(false);
  const lastHumanIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (humanId && !lastHumanIdRef.current) {
      signedOutRef.current = false;
    }
    lastHumanIdRef.current = humanId;
  }, [humanId]);
  useEffect(() => {
    return subscribeAuthInvalidated(() => {
      if (signedOutRef.current) return;
      signedOutRef.current = true;
      const friendly = friendlyError({ data: { code: "UNAUTHORIZED" } });
      showErrorToast(friendly.title, friendly.message);
      return signOut();
    });
  }, [signOut]);

  const isBootstrapping =
    !tokenHydrated ||
    !preferences ||
    sessionQuery.isPending ||
    (!!humanId && sessionContextQuery.isPending);

  return {
    user,
    isBootstrapping,
    preferences,
    resolvedEvent,
    updatePreferences,
    signInWithPassword,
    signUpWithPassword,
    signInWithPasskey,
    signInWithOAuth,
    sendMagicLink,
    signOut,
    sessionContext,
    accessDenied,
  };
};
