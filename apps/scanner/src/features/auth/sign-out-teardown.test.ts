import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  notifyAuthInvalidated,
  subscribeAuthInvalidated,
} from "./auth-invalidation-bus";
import {
  createAuthInvalidatedHandler,
  runSignOutTeardown,
  SERVER_SIGN_OUT_TIMEOUT_MS,
  trackSessionUser,
  type SignOutTeardownDeps,
} from "./sign-out-teardown";

/**
 * The previous operator's data, as the scanner caches it: a check-in search
 * with attendee PII under the same key the next operator's screen will use.
 */
const SEARCH_KEY = [
  ["volunteer", "signups", "searchForCheckIn"],
  { input: { eventId: "evt-a", query: "jo" }, type: "query" },
] as const;
const OPERATOR_A_RESULTS = [{ name: "Jo Attendee", email: "jo@example.com" }];

const seededClient = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(SEARCH_KEY, OPERATOR_A_RESULTS);
  return queryClient;
};

/** Every local step, the second SQLite wipe, and only then the server. */
const LOCAL_FIRST_THEN_SERVER = [
  "clearLocalDb",
  "releaseFeedbackAudio",
  "clearAuthToken",
  "markSignedOut",
  "resetPreferences",
  "clearLocalDb",
  "signOutServer",
];

/** Records the order the teardown steps ran in. */
const makeDeps = (
  queryClient: QueryClient,
  overrides: Partial<SignOutTeardownDeps> = {},
) => {
  const calls: string[] = [];
  const deps: SignOutTeardownDeps = {
    queryClient,
    clearLocalDb: vi.fn(() => {
      calls.push("clearLocalDb");
    }),
    releaseFeedbackAudio: vi.fn(() => {
      calls.push("releaseFeedbackAudio");
    }),
    getSessionToken: vi.fn(() => "token-a"),
    signOutServer: vi.fn(async () => {
      calls.push("signOutServer");
    }),
    clearAuthToken: vi.fn(async () => {
      calls.push("clearAuthToken");
    }),
    markSignedOut: vi.fn(() => {
      calls.push("markSignedOut");
    }),
    resetPreferences: vi.fn(async () => {
      calls.push("resetPreferences");
    }),
    reportError: vi.fn(),
    ...overrides,
  };
  return { deps, calls };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSignOutTeardown", () => {
  it("leaves no cached query data from the departing operator", async () => {
    const queryClient = seededClient();
    expect(queryClient.getQueryData(SEARCH_KEY)).toEqual(OPERATOR_A_RESULTS);

    const { deps } = makeDeps(queryClient);
    await runSignOutTeardown(deps);

    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("drops the mutation cache too", async () => {
    const queryClient = seededClient();
    await queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: async (v: string) => v })
      .execute("sale for jo@example.com");
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

    const { deps } = makeDeps(queryClient);
    await runSignOutTeardown(deps);

    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it("purges only after the token is cleared, and starts no fetch of its own", async () => {
    const queryClient = seededClient();
    // A still-mounted, still-enabled observer (the session hook's own query
    // before the session store reports "no user"). A purge that refetched
    // here would go out before or without the bearer.
    const queryFn = vi.fn(async () => OPERATOR_A_RESULTS);
    const observer = new QueryObserver(queryClient, {
      queryKey: SEARCH_KEY,
      queryFn,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});

    const { deps, calls } = makeDeps(queryClient, {
      clearAuthToken: vi.fn(async () => {
        calls.push("clearAuthToken");
        // Still cached at the moment the token goes: the purge comes after.
        expect(queryClient.getQueryData(SEARCH_KEY)).toEqual(
          OPERATOR_A_RESULTS,
        );
      }),
    });
    await runSignOutTeardown(deps);
    unsubscribe();

    expect(calls).toEqual(LOCAL_FIRST_THEN_SERVER);
    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("cancels an in-flight fetch so its result never lands for the next operator", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let resolveFetch: (v: typeof OPERATOR_A_RESULTS) => void = () => {};
    const inFlight = queryClient.fetchQuery({
      queryKey: SEARCH_KEY,
      queryFn: () =>
        new Promise<typeof OPERATOR_A_RESULTS>((resolve) => {
          resolveFetch = resolve;
        }),
    });
    const settled = inFlight.then(
      () => "resolved",
      () => "rejected",
    );

    const { deps, calls } = makeDeps(queryClient, {
      // The response lands AFTER the first SQLite wipe, which is exactly when
      // a manifest upsert would put the departing operator's people back.
      releaseFeedbackAudio: vi.fn(() => {
        calls.push("releaseFeedbackAudio");
        resolveFetch(OPERATOR_A_RESULTS);
      }),
    });
    await runSignOutTeardown(deps);

    // The caller (e.g. use-local-sync's manifest upsert) never gets the data.
    await expect(settled).resolves.toBe("rejected");
    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
  });

  it("a throwing purge still clears the token, wipes SQLite and resets preferences", async () => {
    const queryClient = seededClient();
    vi.spyOn(queryClient, "removeQueries").mockImplementation(() => {
      throw new Error("purge boom");
    });
    const { deps } = makeDeps(queryClient);

    await expect(runSignOutTeardown(deps)).resolves.toBeUndefined();

    expect(deps.clearLocalDb).toHaveBeenCalledTimes(2);
    expect(deps.clearAuthToken).toHaveBeenCalledTimes(1);
    expect(deps.markSignedOut).toHaveBeenCalledTimes(1);
    expect(deps.resetPreferences).toHaveBeenCalledTimes(1);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "purge boom" }),
      "purge_query_cache",
      "error",
    );
  });

  it("a throwing cancel still purges and finishes the teardown", async () => {
    const queryClient = seededClient();
    vi.spyOn(queryClient, "cancelQueries").mockRejectedValue(
      new Error("cancel boom"),
    );
    const { deps } = makeDeps(queryClient);

    await runSignOutTeardown(deps);

    // Every cancel rejects, the purge's own included: removal runs anyway.
    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
    expect(deps.clearAuthToken).toHaveBeenCalledTimes(1);
    expect(deps.resetPreferences).toHaveBeenCalledTimes(1);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      "cancel_queries",
      "error",
    );
  });

  it("a throwing SQLite wipe is reported and still purges the cache", async () => {
    const queryClient = seededClient();
    const { deps } = makeDeps(queryClient, {
      clearLocalDb: vi.fn(() => {
        throw new Error("sqlite boom");
      }),
    });

    await runSignOutTeardown(deps);

    expect(deps.clearAuthToken).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "sqlite boom" }),
      "clear_local_db",
      "error",
    );
  });

  it("a rejecting server sign-out (no signal) still tears everything down, and is reported", async () => {
    const queryClient = seededClient();
    const { deps, calls } = makeDeps(queryClient, {
      signOutServer: vi.fn(async () => {
        calls.push("signOutServer");
        throw new TypeError("Network request failed");
      }),
    });

    await expect(runSignOutTeardown(deps)).resolves.toBeUndefined();

    expect(calls).toEqual(LOCAL_FIRST_THEN_SERVER);
    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Network request failed" }),
      "server_sign_out",
      "warning",
    );
  });

  it("a server sign-out that resolves with { error } still tears everything down, and is reported", async () => {
    const queryClient = seededClient();
    const { deps, calls } = makeDeps(queryClient, {
      signOutServer: vi.fn(async () => {
        calls.push("signOutServer");
        return {
          data: null,
          error: { status: 500, statusText: "Internal Server Error" },
        };
      }),
    });

    await runSignOutTeardown(deps);

    expect(calls).toEqual(LOCAL_FIRST_THEN_SERVER);
    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "server sign-out failed (500)" }),
      "server_sign_out",
      "warning",
    );
  });

  it("a server sign-out answered 401 (session already revoked) reports nothing", async () => {
    const queryClient = seededClient();
    const { deps, calls } = makeDeps(queryClient, {
      signOutServer: vi.fn(async () => {
        calls.push("signOutServer");
        return { data: null, error: { status: 401, statusText: "Unauthorized" } };
      }),
    });

    await runSignOutTeardown(deps);

    expect(calls).toEqual(LOCAL_FIRST_THEN_SERVER);
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("a 4xx other than 401 from the server sign-out is still reported", async () => {
    const queryClient = seededClient();
    const { deps } = makeDeps(queryClient, {
      signOutServer: vi.fn(async () => ({
        data: null,
        error: { status: 403, statusText: "Forbidden" },
      })),
    });

    await runSignOutTeardown(deps);

    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "server sign-out failed (403)" }),
      "server_sign_out",
      "warning",
    );
  });

  it("a successful server sign-out reports nothing", async () => {
    const queryClient = seededClient();
    const { deps } = makeDeps(queryClient, {
      signOutServer: vi.fn(async () => ({
        data: { success: true },
        error: null,
      })),
    });

    await runSignOutTeardown(deps);

    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("a hanging server sign-out: the local teardown is already done, and sign-out returns at the timeout", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = seededClient();
      const { deps } = makeDeps(queryClient, {
        signOutServer: vi.fn(() => new Promise<never>(() => {})),
      });

      let returned = false;
      const done = runSignOutTeardown(deps).then(() => {
        returned = true;
      });
      await vi.advanceTimersByTimeAsync(SERVER_SIGN_OUT_TIMEOUT_MS - 1);
      expect(deps.clearAuthToken).toHaveBeenCalledTimes(1);
      expect(deps.resetPreferences).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
      expect(returned).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await done;

      expect(returned).toBe(true);
      expect(deps.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        "server_sign_out",
        "warning",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("every local step is guarded: a throwing token clear still purges, resets and wipes", async () => {
    const queryClient = seededClient();
    const { deps, calls } = makeDeps(queryClient, {
      releaseFeedbackAudio: vi.fn(() => {
        throw new Error("audio boom");
      }),
      clearAuthToken: vi.fn(async () => {
        throw new Error("token boom");
      }),
      markSignedOut: vi.fn(() => {
        throw new Error("mark boom");
      }),
      resetPreferences: vi.fn(async () => {
        throw new Error("prefs boom");
      }),
    });

    await runSignOutTeardown(deps);

    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
    expect(calls).toEqual(["clearLocalDb", "clearLocalDb", "signOutServer"]);
    const steps = vi.mocked(deps.reportError!).mock.calls.map((c) => c[1]);
    expect(steps).toEqual([
      "release_audio",
      "clear_auth_token",
      "mark_signed_out",
      "reset_preferences",
    ]);
  });

  it("a manifest fetch cancelled WITH prior data still resolves, and its upsert is wiped by the second SQLite pass", async () => {
    const MANIFEST_KEY = [
      ["scanner", "getEventManifest"],
      { input: { eventId: "evt-a" }, type: "query" },
    ] as const;
    const manifestA = { people: [{ name: "Jo Attendee" }] };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // The realistic case: last minute's manifest is cached.
    queryClient.setQueryData(MANIFEST_KEY, manifestA);
    const device: unknown[] = []; // stands in for SQLite's people table
    let upserted = false;
    // use-local-sync's interval: `getEventManifest.fetch(...).then(upsert)`.
    // tRPC and React Query wrap the fetch in an unknown number of promise
    // layers; 50 of them stands in for "any depth" (the second wipe waits a
    // macrotask, so depth cannot outrun it).
    const syncTick = () => {
      let chain: Promise<typeof manifestA> = queryClient.fetchQuery({
        queryKey: MANIFEST_KEY,
        queryFn: () => new Promise<typeof manifestA>(() => {}),
        staleTime: 0,
      });
      for (let i = 0; i < 50; i++) chain = chain.then((m) => m);
      void chain
        .then((m) => {
          upserted = true;
          device.push(...m.people);
        })
        .catch(() => {});
    };

    let wipes = 0;
    const { deps } = makeDeps(queryClient, {
      clearLocalDb: vi.fn(() => {
        device.length = 0;
        // The sync interval fires right after the first wipe, before the
        // session store has reported "no user": a fetch the first cancel
        // never saw.
        if (++wipes === 1) syncTick();
      }),
    });
    await runSignOutTeardown(deps);

    // The purge cancels it, and query-core resolves a cancelled fetch with
    // the data it already had, so the upsert still runs…
    expect(upserted).toBe(true);
    // …and only the second wipe keeps it off the device.
    expect(device).toEqual([]);
  });

  it("the next operator signing in during the server wait keeps their token, 401 guard, cache and prefs", async () => {
    const B_KEY = [["scanner", "listAccessibleEvents"], { type: "query" }];
    const B_EVENTS = { events: [{ eventId: "evt-b" }] };
    const queryClient = seededClient();
    const token = { current: "token-a" as string | null };
    const refs = {
      signedOut: { current: false },
      lastHumanId: { current: "human-a" as string | undefined },
    };
    let finishServer: () => void = () => {};
    const { deps } = makeDeps(queryClient, {
      getSessionToken: () => token.current,
      clearAuthToken: vi.fn(async () => {
        token.current = null;
      }),
      markSignedOut: vi.fn(() => {
        refs.signedOut.current = true;
      }),
      signOutServer: vi.fn(() => {
        // The Expo plugin has just nulled the session atom: the sign-in
        // screen is up, and operator B signs in while this request hangs.
        trackSessionUser(refs, undefined);
        token.current = "token-b";
        trackSessionUser(refs, "human-b");
        queryClient.setQueryData(B_KEY, B_EVENTS);
        return new Promise((resolve) => {
          finishServer = () => resolve({ data: null, error: null });
        });
      }),
    });

    const done = runSignOutTeardown(deps);
    await vi.waitFor(() => expect(deps.signOutServer).toHaveBeenCalled());
    finishServer();
    await done;

    // The server is told about A, with A's captured bearer.
    expect(deps.signOutServer).toHaveBeenCalledWith("token-a");
    // Nothing of B's was touched.
    expect(token.current).toBe("token-b");
    expect(refs.signedOut.current).toBe(false);
    expect(queryClient.getQueryData(B_KEY)).toEqual(B_EVENTS);
    expect(deps.resetPreferences).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(deps.resetPreferences).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(deps.signOutServer).mock.invocationCallOrder[0]!);

    // And a revocation of B's session still wipes the device.
    const signOutB = vi.fn(async () => {});
    createAuthInvalidatedHandler({
      signedOut: refs.signedOut,
      notifyOperator: vi.fn(),
      signOut: signOutB,
    })();
    expect(signOutB).toHaveBeenCalledTimes(1);
  });

  it("a throwing reporter does not stop the teardown", async () => {
    const queryClient = seededClient();
    vi.spyOn(queryClient, "removeQueries").mockImplementation(() => {
      throw new Error("purge boom");
    });
    const { deps } = makeDeps(queryClient, {
      reportError: () => {
        throw new Error("reporter boom");
      },
    });

    await runSignOutTeardown(deps);

    expect(deps.resetPreferences).toHaveBeenCalledTimes(1);
  });
});

describe("remote wipe (401 → auth-invalidation bus)", () => {
  it("purges the query cache once, however many 401s arrive", async () => {
    const queryClient = seededClient();
    const signedOut = { current: false };
    const notifyOperator = vi.fn();
    const { deps } = makeDeps(queryClient, {
      markSignedOut: vi.fn(() => {
        signedOut.current = true;
      }),
    });
    let teardown: Promise<void> | undefined;
    const signOut = vi.fn(() => {
      teardown = runSignOutTeardown(deps);
      return teardown;
    });

    const unsubscribe = subscribeAuthInvalidated(
      createAuthInvalidatedHandler({ signedOut, notifyOperator, signOut }),
    );
    try {
      notifyAuthInvalidated();
      // Straggling 401s from the same revocation.
      notifyAuthInvalidated();
      await teardown;
      notifyAuthInvalidated();
    } finally {
      unsubscribe();
    }

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(notifyOperator).toHaveBeenCalledTimes(1);
    expect(deps.clearLocalDb).toHaveBeenCalledTimes(2);
    expect(deps.clearAuthToken).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
  });

  it("the revoked session's 401 from the server sign-out is not reported", async () => {
    const queryClient = seededClient();
    const signedOut = { current: false };
    const { deps } = makeDeps(queryClient, {
      markSignedOut: () => {
        signedOut.current = true;
      },
      // The admin revoked the session: /sign-out with its bearer answers 401.
      signOutServer: vi.fn(async () => ({
        data: null,
        error: { status: 401, statusText: "Unauthorized" },
      })),
    });
    let teardown: Promise<void> | undefined;
    const unsubscribe = subscribeAuthInvalidated(
      createAuthInvalidatedHandler({
        signedOut,
        notifyOperator: vi.fn(),
        signOut: () => {
          teardown = runSignOutTeardown(deps);
          return teardown;
        },
      }),
    );
    try {
      notifyAuthInvalidated();
      await teardown;
    } finally {
      unsubscribe();
    }

    expect(deps.signOutServer).toHaveBeenCalledWith("token-a");
    expect(deps.reportError).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(SEARCH_KEY)).toBeUndefined();
  });

  it("an explicit sign-out absorbs the 401s that follow it", async () => {
    const queryClient = seededClient();
    const signedOut = { current: false };
    const { deps } = makeDeps(queryClient, {
      markSignedOut: () => {
        signedOut.current = true;
      },
    });
    const signOut = vi.fn(() => runSignOutTeardown(deps));
    const unsubscribe = subscribeAuthInvalidated(
      createAuthInvalidatedHandler({
        signedOut,
        notifyOperator: vi.fn(),
        signOut,
      }),
    );
    try {
      await runSignOutTeardown(deps);
      // A query re-created after the purge fetches without a bearer → 401.
      notifyAuthInvalidated();
    } finally {
      unsubscribe();
    }

    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("trackSessionUser (re-arming the remote wipe)", () => {
  const refsAfterSignOut = () => ({
    signedOut: { current: true },
    lastHumanId: { current: "human-a" as string | undefined },
  });

  it("a fresh sign-in after a sign-out re-arms it", () => {
    const refs = refsAfterSignOut();
    trackSessionUser(refs, undefined);
    expect(refs.signedOut.current).toBe(true);
    trackSessionUser(refs, "human-b");
    expect(refs.signedOut.current).toBe(false);
    expect(refs.lastHumanId.current).toBe("human-b");
  });

  it("a cold start straight into a session arms it", () => {
    const refs = {
      signedOut: { current: true },
      lastHumanId: { current: undefined as string | undefined },
    };
    trackSessionUser(refs, "human-a");
    expect(refs.signedOut.current).toBe(false);
  });

  it("re-renders of the same signed-in user do not re-arm a sign-out in progress", () => {
    const refs = refsAfterSignOut();
    trackSessionUser(refs, "human-a");
    expect(refs.signedOut.current).toBe(true);
  });
});
