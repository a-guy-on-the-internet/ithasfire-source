import { StrictMode } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the provider's REAL wiring of the sign-out signal: `TrpcProvider`'s
 * effect must null its token cache when `notifySignedOut()` fires. The
 * resolver tests in `trpc.test.ts` call `bindTokenCacheToSignOut` by hand, so
 * they stay green if the provider stops calling it; this one does not.
 */

const mocks = vi.hoisted(() => ({
  token: vi.fn<[], Promise<{ data: { token?: string } | null; error: unknown }>>(),
  notify: vi.fn<[string], void>(),
  session: {
    current: { data: { user: { id: "u1" } }, isPending: false } as {
      data: { user: { id: string } } | null;
      isPending: boolean;
      /** Better Auth's `useSession().error`; absent means null. */
      error?: unknown;
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    token: mocks.token,
    useSession: () => mocks.session.current,
    $store: { notify: mocks.notify },
  },
}));

import { notifySignedOut } from "@/lib/auth/auth-epoch";

import { TrpcProvider, trpc } from "../trpc";

type VanillaClient = ReturnType<typeof trpc.useUtils>["client"];

function Probe({ onClient }: { onClient: (client: VanillaClient) => void }) {
  onClient(trpc.useUtils().client);
  return null;
}

function CacheProbe({ onCache }: { onCache: (qc: QueryClient) => void }) {
  onCache(useQueryClient());
  return null;
}

/** A mounted (active) query, like the page the signer-out was looking at. */
function ActiveThemeQuery() {
  trpc.platform.getActiveTheme.useQuery();
  return null;
}

const batchResponse = () =>
  new Response(
    JSON.stringify([
      { result: { data: { json: { presets: [], activeSlug: null } } } },
    ]),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("TrpcProvider — sign-out signal", () => {
  const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => batchResponse());
    vi.stubGlobal("fetch", fetchMock);
    mocks.token.mockReset();
    mocks.token.mockResolvedValue({ data: { token: "jwt-1" }, error: null });
    mocks.session.current = { data: { user: { id: "u1" } }, isPending: false };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const authHeaderOf = (call: number) =>
    new Headers(fetchMock.mock.calls[call]?.[1]?.headers).get("Authorization");

  it("the batch after a sign-out carries no Authorization header", async () => {
    let client!: VanillaClient;
    const tree = () => (
      <TrpcProvider>
        <Probe onClient={(c) => (client = c)} />
      </TrpcProvider>
    );
    const { rerender } = render(tree());

    await client.platform.getActiveTheme.query();
    expect(authHeaderOf(0)).toBe("Bearer jwt-1");

    // A navbar sign-out: the plugin fires the signal, then the atom settles
    // signed-out. The cached token is still well inside its 55s TTL.
    act(() => {
      notifySignedOut();
    });
    mocks.session.current = { data: null, isPending: false };
    rerender(tree());

    await client.platform.getActiveTheme.query();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authHeaderOf(1)).toBeNull();
    expect(mocks.token).toHaveBeenCalledTimes(1);
  });
});

/**
 * The provider's REAL wiring of the query reset: a deliberate sign-out drops
 * the previous user's cached data. Before it, a client-side sign-in as a
 * second user rendered the first user's `/my-tickets` order until the second
 * user's refetch landed.
 */
describe("TrpcProvider — sign-out resets the query cache", () => {
  const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => batchResponse());
    vi.stubGlobal("fetch", fetchMock);
    mocks.token.mockReset();
    mocks.token.mockResolvedValue({ data: { token: "jwt-1" }, error: null });
    mocks.session.current = { data: { user: { id: "u1" } }, isPending: false };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const ORDERS_KEY = ["orders", "listMyOrders"];
  const authHeaderOf = (call: number) =>
    new Headers(fetchMock.mock.calls[call]?.[1]?.headers).get("Authorization");
  const mintsToken = (token: string) =>
    mocks.token.mockResolvedValue({ data: { token }, error: null });
  /** What the mint answers once the sign-out cleared the session cookie. */
  const mintIsRevoked = () =>
    mocks.token.mockResolvedValue({ data: null, error: { status: 401 } });

  function renderProvider(options?: { strict?: boolean }) {
    let queryClient!: QueryClient;
    const tree = () => {
      const inner = (
        <TrpcProvider>
          <CacheProbe onCache={(qc) => (queryClient = qc)} />
          <ActiveThemeQuery />
        </TrpcProvider>
      );
      return options?.strict ? <StrictMode>{inner}</StrictMode> : inner;
    };
    const { rerender } = render(tree());
    return {
      queryClient: () => queryClient,
      rerender: () => rerender(tree()),
    };
  }

  it("drops an inactive query's data and refetches the active one without the cached bearer", async () => {
    const { queryClient } = renderProvider();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(authHeaderOf(0)).toBe("Bearer jwt-1");
    queryClient().setQueryData(ORDERS_KEY, { orders: ["user-a-order"] });
    mintsToken("jwt-2");

    act(() => {
      notifySignedOut();
    });

    expect(queryClient().getQueryData(ORDERS_KEY)).toBeUndefined();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The token cache was dropped too: the refetch minted again rather than
    // reuse jwt-1, which was still well inside its TTL.
    expect(mocks.token).toHaveBeenCalledTimes(2);
    expect(authHeaderOf(1)).toBe("Bearer jwt-2");
  });

  it("a signed-in reading arms the reset even when no token has gone out", async () => {
    // The mint blips (5xx), so every batch so far went out anonymous and
    // nothing but the session reading says a user is here.
    mocks.token.mockResolvedValue({ data: null, error: { status: 500 } });
    const { queryClient } = renderProvider();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(authHeaderOf(0)).toBeNull();
    queryClient().setQueryData(ORDERS_KEY, { orders: ["user-a-order"] });

    act(() => {
      notifySignedOut();
    });

    expect(queryClient().getQueryData(ORDERS_KEY)).toBeUndefined();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("a cold start that mints from the cookie without ever settling signed-in still resets", async () => {
    // get-session hangs: the reading never carries a user. Past the 3s settle
    // bound the resolver mints from the cookie, and per-user data can land.
    vi.useFakeTimers();
    mocks.session.current = { data: null, isPending: true };
    const { queryClient } = renderProvider();
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeaderOf(0)).toBe("Bearer jwt-1");
    queryClient().setQueryData(ORDERS_KEY, { orders: ["user-a-order"] });
    mintIsRevoked();

    act(() => {
      notifySignedOut();
    });

    expect(queryClient().getQueryData(ORDERS_KEY)).toBeUndefined();
    // Let the reset's refetch (another settle wait, then a 401 mint) land here.
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authHeaderOf(1)).toBeNull();
  });

  it("A signs out, B signs in, B signs out: each sign-out resets", async () => {
    const { queryClient, rerender } = renderProvider();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    queryClient().setQueryData(ORDERS_KEY, { orders: ["user-a-order"] });

    mintIsRevoked();
    act(() => {
      notifySignedOut();
    });
    expect(queryClient().getQueryData(ORDERS_KEY)).toBeUndefined();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(authHeaderOf(1)).toBeNull();
    mocks.session.current = { data: null, isPending: false };
    rerender();

    // B signs in: a fresh reading through the provider's own effect.
    mintsToken("jwt-b");
    mocks.session.current = { data: { user: { id: "u2" } }, isPending: false };
    rerender();
    queryClient().setQueryData(ORDERS_KEY, { orders: ["user-b-order"] });

    act(() => {
      notifySignedOut();
    });
    expect(queryClient().getQueryData(ORDERS_KEY)).toBeUndefined();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("a transient null session reading before the signal does not prevent the reset", async () => {
    const { queryClient, rerender } = renderProvider();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    queryClient().setQueryData(ORDERS_KEY, { orders: ["user-a-order"] });

    // Better Auth's get-session blips null for a signed-in user.
    mocks.session.current = { data: null, isPending: false };
    rerender();
    act(() => {
      notifySignedOut();
    });

    expect(queryClient().getQueryData(ORDERS_KEY)).toBeUndefined();
    // Let the active query's refetch land here, not in the next test.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("an anonymous visitor's sign-out signal (the defensive one before a password sign-in) resets nothing", async () => {
    mocks.session.current = { data: null, isPending: false };
    const { queryClient } = renderProvider();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    queryClient().setQueryData(ORDERS_KEY, { orders: ["kept"] });

    act(() => {
      notifySignedOut();
    });

    expect(queryClient().getQueryData(ORDERS_KEY)).toEqual({ orders: ["kept"] });
    // No reset means no refetch flashing under the sign-in overlay.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("under StrictMode one signal resets exactly once", async () => {
    const reset = vi.spyOn(QueryClient.prototype, "resetQueries");
    renderProvider({ strict: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const fetchesBefore = fetchMock.mock.calls.length;

    act(() => {
      notifySignedOut();
    });

    expect(reset).toHaveBeenCalledTimes(1);
    // Let the reset's refetch land here, not in a later test.
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(fetchesBefore),
    );
  });
});

/**
 * The provider's REAL wiring of the failed-session-read recovery. Reproduced
 * live (route interception): a focus refetch of get-session failed during a
 * DB outage, Better Auth set the atom's `data` to null with `error` set, a
 * `/token` 401 emptied the bearer cache, and after the DB came back every
 * batch went out anonymous and the navbar showed the user signed out until a
 * focus event. The provider now re-reads the session with backoff, and
 * treats the failed read as unknown (cookie mint) rather than signed-out.
 */
describe("TrpcProvider — failed session read recovery", () => {
  const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => batchResponse());
    vi.stubGlobal("fetch", fetchMock);
    mocks.notify.mockReset();
    mocks.token.mockReset();
    mocks.token.mockResolvedValue({ data: { token: "jwt-1" }, error: null });
    mocks.session.current = { data: { user: { id: "u1" } }, isPending: false };
    // The retry's jitter at its midpoint (factor 1), so the delays are exact.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const authHeaderOf = (call: number) =>
    new Headers(fetchMock.mock.calls[call]?.[1]?.headers).get("Authorization");
  /** Session re-reads the provider asked Better Auth for. */
  const sessionRereads = () =>
    mocks.notify.mock.calls.filter(([signal]) => signal === "$sessionSignal")
      .length;
  const SIGNED_IN = () => ({ data: { user: { id: "u1" } }, isPending: false });
  /** What Better Auth's atom holds after get-session answered 500. */
  const READ_FAILED = () => ({
    data: null,
    isPending: false,
    error: { status: 500, statusText: "Internal Server Error" },
  });
  /** A re-read in flight with no user in the atom (`isPending: data === null`). */
  const REREADING = () => ({ data: null, isPending: true });

  function renderProvider(options?: { strict?: boolean }) {
    let client!: VanillaClient;
    const tree = () => {
      const inner = (
        <TrpcProvider>
          <Probe onClient={(c) => (client = c)} />
        </TrpcProvider>
      );
      return options?.strict ? <StrictMode>{inner}</StrictMode> : inner;
    };
    const { rerender, unmount } = render(tree());
    return {
      client: () => client,
      reading: (next: typeof mocks.session.current) => {
        mocks.session.current = next;
        rerender(tree());
      },
      unmount,
    };
  }

  /** Run one batch to completion; the batch link dispatches on a timer. */
  async function batch(client: VanillaClient) {
    let done = false;
    const query = client.platform.getActiveTheme.query().finally(() => {
      done = true;
    });
    for (let i = 0; i < 50 && !done; i += 1) {
      await act(() => vi.advanceTimersByTimeAsync(1));
    }
    return query;
  }

  it("re-reads with backoff after a failed read; once a read succeeds the next batch mints and carries a bearer", async () => {
    const { client, reading } = renderProvider();
    await batch(client());
    expect(authHeaderOf(0)).toBe("Bearer jwt-1");
    // The cached token ages past its 55s TTL.
    await act(() => vi.advanceTimersByTimeAsync(56_000));

    // DB outage: get-session 500, /token 401.
    mocks.token.mockResolvedValue({ data: null, error: { status: 401 } });
    reading(READ_FAILED());
    await batch(client());
    expect(authHeaderOf(1)).toBeNull();
    const afterOutageBatch = sessionRereads(); // the 401's own re-read

    // No batch, no focus event: the provider re-reads on its own at 2s.
    await act(() => vi.advanceTimersByTimeAsync(1_900));
    expect(sessionRereads()).toBe(afterOutageBatch);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(sessionRereads()).toBe(afterOutageBatch + 1);

    // That re-read fails too; the next one waits 4s.
    reading(REREADING());
    reading(READ_FAILED());
    await act(() => vi.advanceTimersByTimeAsync(3_900));
    expect(sessionRereads()).toBe(afterOutageBatch + 1);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(sessionRereads()).toBe(afterOutageBatch + 2);

    // The DB is back and this re-read succeeds.
    mocks.token.mockResolvedValue({ data: { token: "jwt-2" }, error: null });
    reading(REREADING());
    reading(SIGNED_IN());
    await batch(client());
    expect(authHeaderOf(2)).toBe("Bearer jwt-2");

    // Recovered: no more re-reads, the backoff is cancelled.
    const recovered = sessionRereads();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(sessionRereads()).toBe(recovered);
  });

  it("a failed read on a cold start still sends the first batch with a bearer from the cookie", async () => {
    mocks.session.current = READ_FAILED();
    const { client } = renderProvider();
    await batch(client());
    expect(mocks.token).toHaveBeenCalledTimes(1);
    expect(authHeaderOf(0)).toBe("Bearer jwt-1");
  });

  it("an anonymous visitor (get-session 200 with no session) never re-reads and never mints", async () => {
    mocks.session.current = { data: null, isPending: true };
    const { client, reading } = renderProvider();
    reading({ data: null, isPending: false, error: null });
    await batch(client());
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    await batch(client());

    expect(authHeaderOf(0)).toBeNull();
    expect(authHeaderOf(1)).toBeNull();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(sessionRereads()).toBe(0);
  });

  it("unmount cancels an armed re-read", async () => {
    mocks.session.current = READ_FAILED();
    const { unmount } = renderProvider();
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(sessionRereads()).toBe(0);
  });

  it("under StrictMode a failed read runs exactly one retry loop", async () => {
    mocks.session.current = READ_FAILED();
    renderProvider({ strict: true });
    await act(() => vi.advanceTimersByTimeAsync(1_999));
    expect(sessionRereads()).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(sessionRereads()).toBe(1);
    // A doubled loop would re-read twice per step.
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(sessionRereads()).toBe(2);
  });

  /**
   * Review finding: Better Auth sets the atom twice per attempt (pending,
   * then failed); batched into one render the provider sees unchanged inputs
   * and its effect does not run. The mock atom never changes after a re-read,
   * which is exactly that case: the loop must keep going on its own.
   */
  it("keeps re-reading on the backoff when a re-read's pending and failed readings land in one render", async () => {
    mocks.session.current = READ_FAILED();
    const { reading } = renderProvider();
    const expected = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [i, delay] of expected.entries()) {
      await act(() => vi.advanceTimersByTimeAsync(delay - 1));
      expect(sessionRereads()).toBe(i);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(sessionRereads()).toBe(i + 1);
      // The re-read failed again with a fresh error object: same inputs.
      reading(READ_FAILED());
    }

    // The server is back: one render carries the signed-in settle, and the
    // armed next attempt is cancelled.
    reading(SIGNED_IN());
    const recovered = sessionRereads();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(sessionRereads()).toBe(recovered);
  });

  it("a permanent 4xx from get-session (403) does not re-read on a timer", async () => {
    mocks.session.current = {
      data: null,
      isPending: false,
      error: { status: 403, statusText: "Forbidden" },
    };
    renderProvider();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(sessionRereads()).toBe(0);
  });

  it("a hidden tab pauses the re-reads; visible again resumes them", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    const setVisibility = (next: DocumentVisibilityState) => {
      visibility = next;
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };
    mocks.session.current = READ_FAILED();
    const { unmount } = renderProvider();
    setVisibility("hidden");
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(sessionRereads()).toBe(0);

    setVisibility("visible");
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(sessionRereads()).toBe(1);

    // Unmount clears the armed timer.
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(sessionRereads()).toBe(1);
  });
});
