import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  type QueryKey,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommunityEventDate } from "@/server/events";

/**
 * The seed → cache contract of the per-date RSVP list, tested against REAL
 * react-query.
 *
 * That is the whole point: the bug this pins lives in react-query's semantics,
 * not in this hook's arithmetic. `initialData` is consumed only while the cache
 * entry has no data, so the SECOND seed — the one carrying the viewer's own
 * RSVPs, which arrive after first paint because the event-page document is
 * edge-cached and `viewerRsvped` is stripped out of it — was dropped on the
 * floor. With `staleTime: 30_000`, `refetchOnWindowFocus: false` and no
 * interval, nothing refetched it either, so a signed-in viewer who had already
 * said yes to a date saw every chip unpressed until they toggled one.
 *
 * A stubbed `useQuery` could not tell the two apart, so `@/trpc` is shimmed over
 * the real `useQuery` / `useMutation` / `QueryClient` instead. Swap
 * `placeholderData` back to `initialData` in the hook and the first test here
 * goes red.
 */

// ── The tRPC shim ───────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  /** Set per test — the shim's `utils` read it lazily. */
  client: null as unknown,
  /** The query function. Tests hand it a deferred or a resolved payload. */
  fetchDates: vi.fn(),
  rsvpToDate: vi.fn(),
  cancelDateRsvp: vi.fn(),
  session: { data: null as { user?: { id: string } } | null, isPending: false },
  showSignInOverlay: vi.fn(),
  danger: vi.fn(),
  /** Ordered log of the cache operations the toggle performs. */
  calls: [] as string[],
}));

const keyOf = (input: { eventId: string }): QueryKey => [
  "community.listEventDates",
  input,
];

vi.mock("@/trpc", () => {
  const client = () => h.client as QueryClient;
  return {
    trpc: {
      useUtils: () => ({
        community: {
          listEventDates: {
            setData: (
              input: { eventId: string },
              updater: (prev: unknown) => unknown,
            ) => {
              h.calls.push("setData");
              client().setQueryData(keyOf(input), updater);
            },
            invalidate: (input: { eventId: string }) => {
              h.calls.push("invalidate");
              return client().invalidateQueries({ queryKey: keyOf(input) });
            },
            cancel: (input: { eventId: string }) => {
              h.calls.push("cancel");
              return client().cancelQueries({ queryKey: keyOf(input) });
            },
          },
        },
      }),
      community: {
        listEventDates: {
          useQuery: (
            input: { eventId: string },
            opts: Record<string, unknown>,
          ) =>
            useQuery({
              queryKey: keyOf(input),
              queryFn: () => h.fetchDates(),
              ...opts,
            }),
        },
        rsvpToDate: {
          useMutation: () => useMutation({ mutationFn: h.rsvpToDate }),
        },
        cancelDateRsvp: {
          useMutation: () => useMutation({ mutationFn: h.cancelDateRsvp }),
        },
      },
    },
  };
});

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => h.session },
}));

vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: h.showSignInOverlay }),
}));

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  useNotify: () => ({ toast: { danger: h.danger } }),
}));

import { useDateRsvpList } from "../use-date-rsvp-list";

// ── Fixtures ────────────────────────────────────────────────────────────────

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

/** ISO seed dates, as the RSC → island boundary hands them over. */
function seedDates(flags: boolean[]): CommunityEventDate[] {
  return flags.map((viewerRsvped, i) => ({
    eventDateId: `date-${i}`,
    startsAt: new Date(Date.UTC(2026, 8, 17 + 7 * i, 1, 0, 0)).toISOString(),
    endsAt: null,
    viewerRsvped,
    status: "SCHEDULED" as const,
  }));
}

/** A `listEventDates` payload — `Date` instants, as superjson revives them. */
function payload(
  flags: boolean[],
  extra: {
    truncated?: boolean;
    interval?: number;
    /** Ids of the dates that are CANCELLED (`date-0`, `date-1`, …). */
    cancelled?: string[];
    nextScheduledEventDateId?: string | null;
    hasRecurrenceRule?: boolean;
  } = {},
) {
  const cancelled = new Set(extra.cancelled ?? []);
  const dates = flags.map((viewerRsvped, i) => ({
    eventDateId: `date-${i}`,
    startsAt: new Date(Date.UTC(2026, 8, 17 + 7 * i, 1, 0, 0)),
    endsAt: null,
    viewerRsvped,
    status: (cancelled.has(`date-${i}`) ? "CANCELLED" : "SCHEDULED") as
      | "SCHEDULED"
      | "CANCELLED",
  }));
  return {
    dates,
    recurrence: {
      freq: "WEEKLY" as const,
      interval: extra.interval ?? 1,
      byday: ["WE"],
      until: null,
    },
    truncated: extra.truncated ?? false,
    // The server answers this; `dates[0]` is not a substitute once cancelled
    // rows are in the list.
    nextScheduledEventDateId:
      extra.nextScheduledEventDateId !== undefined
        ? extra.nextScheduledEventDateId
        : (dates.find((d) => d.status === "SCHEDULED")?.eventDateId ?? null),
    hasRecurrenceRule: extra.hasRecurrenceRule ?? true,
  };
}

const WEEKLY_SEED = {
  freq: "WEEKLY" as const,
  interval: 1,
  byday: ["WE"],
  until: null,
};

/**
 * One macrotask. query-core notifies its observers through
 * `setTimeout(…, 0)`, so a write that has already landed in the cache needs a
 * turn of the event loop before it can land in a render — and an assertion that
 * something did NOT change needs the same turn to be worth anything.
 */
const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={h.client as QueryClient}>
      {children}
    </QueryClientProvider>
  );
}

type MountArgs = {
  dates: CommunityEventDate[];
  truncated?: boolean;
  recurrence?: typeof WEEKLY_SEED | null;
  nextScheduledEventDateId?: string | null;
  hasRecurrenceRule?: boolean;
};

function mount(args: MountArgs) {
  return renderHook(
    (props: MountArgs) =>
      useDateRsvpList({
        eventId: EVENT_ID,
        initialDates: props.dates,
        initialRecurrence:
          props.recurrence === undefined ? WEEKLY_SEED : props.recurrence,
        initialTruncated: props.truncated ?? false,
        initialNextScheduledEventDateId:
          props.nextScheduledEventDateId === undefined
            ? (props.dates[0]?.eventDateId ?? null)
            : props.nextScheduledEventDateId,
        initialHasRecurrenceRule: props.hasRecurrenceRule ?? true,
      }),
    { wrapper, initialProps: args },
  );
}

const signedIn = () => {
  h.session = { data: { user: { id: "human-1" } }, isPending: false };
};

beforeEach(() => {
  h.client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  h.fetchDates = vi.fn(() => new Promise(() => {}));
  h.rsvpToDate = vi.fn(() => new Promise(() => {}));
  h.cancelDateRsvp = vi.fn(() => new Promise(() => {}));
  h.session = { data: null, isPending: false };
  h.showSignInOverlay = vi.fn();
  h.danger = vi.fn();
  h.calls = [];
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("useDateRsvpList — the seed is a placeholder, not initialData", () => {
  it("renders the SECOND seed's viewer flags", async () => {
    // Signed in, with the query still on the wire — so the only thing that can
    // answer is the seed, and which seed it picks is the whole question.
    signedIn();
    const { result, rerender } = mount({ dates: seedDates([false, false]) });

    expect(result.current.rows.map((r) => r.viewerRsvped)).toEqual([
      false,
      false,
    ]);

    // `POST /api/events/[id]/viewer-state` has landed and EventPageBody
    // recomputed `communityDates`: a NEW seed, and the ONLY copy of this
    // viewer's own RSVPs — the cached document could not carry them.
    await act(async () => {
      rerender({ dates: seedDates([true, false]) });
      await tick();
    });

    // Under `initialData` this stays [false, false] for 30 seconds: the first
    // seed was written to the cache and the second is ignored.
    expect(result.current.rows.map((r) => r.viewerRsvped)).toEqual([
      true,
      false,
    ]);
  });

  it("does not fetch at all while signed out", async () => {
    const { result } = mount({ dates: seedDates([false, false]) });

    // A signed-out reader's flags cannot differ from the seed's (there is no
    // viewer to have RSVPs), so `enabled` keeps the round trip off the wire —
    // and with it any flash.
    expect(h.fetchDates).not.toHaveBeenCalled();
    expect(result.current.rows).toHaveLength(2);
    expect(result.current.isSignedIn).toBe(false);

    // Still nothing once the event loop has had a turn.
    await act(async () => {
      await tick();
    });
    expect(h.fetchDates).not.toHaveBeenCalled();
  });

  it("fetches exactly once for a signed-in viewer", async () => {
    signedIn();
    mount({ dates: seedDates([false]) });

    await waitFor(() => expect(h.fetchDates).toHaveBeenCalledTimes(1));
  });
});

/**
 * `truncated` and `recurrence` describe the SAME list as `rows`, and the seed
 * rides an edge-cached document while the payload does not. Reading one from
 * each is how "60 dates through Sep 2027" gets printed over an open-ended night.
 */
describe("useDateRsvpList — seed vs payload precedence", () => {
  it("answers with the SEED while the data is still the placeholder", () => {
    signedIn(); // fetch is pending (never resolves)
    const { result } = mount({
      dates: seedDates([false]),
      truncated: false,
    });

    expect(result.current.truncated).toBe(false);
    expect(result.current.recurrence?.interval).toBe(1);
  });

  it("answers with the PAYLOAD once real data lands", async () => {
    signedIn();
    h.fetchDates = vi.fn(() =>
      Promise.resolve(
        payload([false, false], { truncated: true, interval: 2 }),
      ),
    );

    // The stale edge-cached document: bounded series, weekly rule.
    const { result } = mount({
      dates: seedDates([false, false]),
      truncated: false,
    });

    await waitFor(() => expect(result.current.truncated).toBe(true));
    expect(result.current.recurrence?.interval).toBe(2);
  });

  it("answers with the payload's NULL rule rather than the seed's", async () => {
    signedIn();
    h.fetchDates = vi.fn(() =>
      Promise.resolve({ ...payload([false]), recurrence: null }),
    );

    const { result } = mount({ dates: seedDates([false]) });

    await waitFor(() => expect(result.current.recurrence).toBeNull());
  });
});

describe("useDateRsvpList — optimistic toggle", () => {
  it("cancels the in-flight fetch before writing, so a stale response cannot revert the flip", async () => {
    signedIn();
    const inFlight = deferred<ReturnType<typeof payload>>();
    h.fetchDates = vi.fn(() => inFlight.promise);

    const { result } = mount({ dates: seedDates([false]) });
    await waitFor(() => expect(h.fetchDates).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.toggle(result.current.rows[0]!);
      // `toggle` cancels the in-flight fetch before it writes, so the flip lands
      // a microtask later, and the notification a macrotask after that.
      await tick();
    });
    // query-core delivers observer notifications on a `setTimeout(0)`, so the
    // flip is in the cache before it is in a render.
    await waitFor(() =>
      expect(result.current.rows[0]!.viewerRsvped).toBe(true),
    );
    // Cancelled BEFORE the write: a cancelled query reverts to its pre-fetch
    // state, and that revert must not land on top of the flip.
    expect(h.calls).toEqual(["cancel", "setData"]);

    // The fetch that was already on the wire now answers with the PRE-press
    // server view. Without the cancel it overwrites the flip, and the viewer
    // watches their chip fill, empty, then fill again when the invalidate
    // lands.
    await act(async () => {
      inFlight.resolve(payload([false]));
      // Twice: the first turn runs query-core's own resolution, the second runs
      // the observer notification it schedules. One is not enough — the render
      // would still be holding the pre-resolution snapshot and this assertion
      // would pass whatever the cache says.
      await tick();
      await tick();
    });

    // The CACHE first — that is what the cancel protects, and the render only
    // follows it.
    expect(
      (h.client as QueryClient).getQueryData<ReturnType<typeof payload>>(
        keyOf({ eventId: EVENT_ID }),
      )?.dates[0]?.viewerRsvped,
    ).toBe(true);
    expect(result.current.rows[0]!.viewerRsvped).toBe(true);
    expect(result.current.pendingIds.has("date-0")).toBe(true);
  });

  it("routes a signed-out press through sign-in instead of the cache", async () => {
    const { result } = mount({ dates: seedDates([false]) });

    await act(async () => {
      result.current.toggle(result.current.rows[0]!);
      // `toggle` cancels the in-flight fetch before it writes, so the flip lands
      // a microtask later, and the notification a macrotask after that.
      await tick();
    });

    expect(h.showSignInOverlay).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual([]);
    expect(h.rsvpToDate).not.toHaveBeenCalled();
  });

  it("rolls the flip back and reports the failure", async () => {
    signedIn();
    h.fetchDates = vi.fn(() => Promise.resolve(payload([false])));
    h.rsvpToDate = vi.fn(() => Promise.reject(new Error("nope")));

    const { result } = mount({ dates: seedDates([false]) });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    await act(async () => {
      result.current.toggle(result.current.rows[0]!);
      // `toggle` cancels the in-flight fetch before it writes, so the flip lands
      // a microtask later, and the notification a macrotask after that.
      await tick();
    });

    await waitFor(() =>
      expect(result.current.rows[0]!.viewerRsvped).toBe(false),
    );
    expect(h.danger).toHaveBeenCalledTimes(1);
    expect(result.current.pendingIds.has("date-0")).toBe(false);
  });
});

/**
 * The three event-intrinsic fields the zero-dates ruling and the called-off
 * marker are built on. Same seed-vs-payload precedence as `truncated`, and for
 * the same reason: the seed rides an edge-cached document, the payload does
 * not, so reading the lead date from one and the rows from the other points
 * the NEXT card at a night that is no longer on.
 */
describe("useDateRsvpList — the lead date and the rule flag", () => {
  it("answers with the SEED while the data is still the placeholder", () => {
    signedIn(); // the fetch never resolves
    const { result } = mount({
      dates: seedDates([false, false]),
      nextScheduledEventDateId: "date-1",
      hasRecurrenceRule: true,
    });

    expect(result.current.nextScheduledEventDateId).toBe("date-1");
    expect(result.current.hasRecurrenceRule).toBe(true);
  });

  it("answers with the PAYLOAD's lead date once real data lands", async () => {
    signedIn();
    h.fetchDates = vi.fn(() =>
      Promise.resolve(payload([false, false], { cancelled: ["date-0"] })),
    );

    // The stale cached document still leads with a night since called off.
    const { result } = mount({
      dates: seedDates([false, false]),
      nextScheduledEventDateId: "date-0",
    });

    await waitFor(() =>
      expect(result.current.nextScheduledEventDateId).toBe("date-1"),
    );
    expect(result.current.rows[0]?.status).toBe("CANCELLED");
    expect(result.current.rows[1]?.status).toBe("SCHEDULED");
  });

  it("carries a null lead date through — it is the drained state, not a gap", async () => {
    signedIn();
    h.fetchDates = vi.fn(() =>
      Promise.resolve(
        payload([false], { cancelled: ["date-0"], truncated: true }),
      ),
    );

    const { result } = mount({
      dates: seedDates([false]),
      nextScheduledEventDateId: "date-0",
    });

    await waitFor(() =>
      expect(result.current.nextScheduledEventDateId).toBeNull(),
    );
    expect(result.current.hasRecurrenceRule).toBe(true);
    expect(result.current.truncated).toBe(true);
  });
});

describe("useDateRsvpList — a called-off night cannot be RSVP'd", () => {
  it("refuses the toggle instead of painting a flip the server will reject", async () => {
    signedIn();
    h.fetchDates = vi.fn(() =>
      Promise.resolve(payload([false, false], { cancelled: ["date-0"] })),
    );

    const { result } = mount({ dates: seedDates([false, false]) });
    await waitFor(() =>
      expect(result.current.rows[0]?.status).toBe("CANCELLED"),
    );

    await act(async () => {
      result.current.toggle(result.current.rows[0]!);
      await tick();
    });

    // `rsvpToEventDate` answers EVENT_DATE_NOT_RSVPABLE for a non-SCHEDULED
    // date, so an optimistic flip here would fill the chip and empty it again.
    expect(h.rsvpToDate).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(result.current.rows[0]?.viewerRsvped).toBe(false);
  });
});
