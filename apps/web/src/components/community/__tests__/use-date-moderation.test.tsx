import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The moderator half of the "Upcoming dates" section.
 *
 * Two things here are load-bearing and neither is arithmetic:
 *
 *  1. **Moderator status never rides the cached document.** The public event
 *     page is edge-cached (`s-maxage=120, stale-while-revalidate=300`) with no
 *     `Cookie` in its `Vary`, so if "may this reader call a night off" were
 *     resolved server-side, the first moderator to warm a colo would hand
 *     "Call off" buttons to every anonymous reader served from it. The probe is
 *     a client query, gated by the caller's hydrated+signed-in flag.
 *  2. **The step-up 2FA refusal is not a generic failure.** These mutations are
 *     gated at the transport because this page has no `/moderate` edge gate to
 *     inherit one from, so `SECOND_FACTOR_REQUIRED` is the ONLY signal telling
 *     a moderator what to do about it. It must route into the enrollment flow,
 *     not into "something went wrong".
 */

const h = vi.hoisted(() => ({
  access: {
    data: undefined as { allowed: boolean } | undefined,
  },
  /** Ordered log of what the hook did, so the settle order is assertable. */
  calls: [] as string[],
  cancelEventDate: vi.fn(),
  restoreEventDate: vi.fn(),
  danger: vi.fn(),
  /** The shared step-up handler. Returns true when it swallowed the error. */
  handleSecondFactor: vi.fn(() => false),
  /** Options the access query was mounted with. */
  accessOpts: undefined as Record<string, unknown> | undefined,
}));

/**
 * A mutation shim shaped like tRPC's: `mutate(input, { onError, onSettled })`.
 * The mutationFn is a plain vi.fn so a test can resolve or reject it.
 */
function mutationShim(fn: ReturnType<typeof vi.fn>) {
  return {
    mutate: (
      input: unknown,
      opts?: {
        onError?: (err: unknown) => void;
        onSettled?: () => void;
      },
    ) => {
      void Promise.resolve()
        .then(() => fn(input))
        .catch((err: unknown) => opts?.onError?.(err))
        .finally(() => opts?.onSettled?.());
    },
  };
}

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      community: {
        listEventDates: {
          invalidate: (input: { eventId: string }) => {
            h.calls.push(`invalidate:${input.eventId}`);
            return Promise.resolve();
          },
        },
      },
    }),
    community: {
      checkModeratorAccess: {
        useQuery: (_input: unknown, opts: Record<string, unknown>) => {
          h.accessOpts = opts;
          // The real query returns nothing while disabled; mirror that, because
          // "disabled keeps its last value" is exactly the hazard the hook
          // folds `enabled` back in to defend against.
          return opts.enabled ? h.access : { data: undefined };
        },
      },
      cancelEventDate: { useMutation: () => mutationShim(h.cancelEventDate) },
      restoreEventDate: { useMutation: () => mutationShim(h.restoreEventDate) },
    },
  },
}));

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  useNotify: () => ({ toast: { danger: h.danger } }),
}));

vi.mock("../use-second-factor-required-toast", () => ({
  useSecondFactorRequiredToast: () => h.handleSecondFactor,
}));

import { useDateModeration } from "../use-date-moderation";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DATE_ID = "22222222-2222-4222-8222-222222222222";

const tick = () => new Promise((r) => setTimeout(r, 0));

function mount(enabled: boolean) {
  return renderHook(
    (props: { enabled: boolean }) =>
      useDateModeration({ eventId: EVENT_ID, enabled: props.enabled }),
    { initialProps: { enabled } },
  );
}

beforeEach(() => {
  h.access = { data: { allowed: true } };
  h.calls = [];
  h.cancelEventDate = vi.fn(() => Promise.resolve({ changed: true }));
  h.restoreEventDate = vi.fn(() => Promise.resolve({ changed: true }));
  h.danger = vi.fn();
  h.handleSecondFactor = vi.fn(() => false);
  h.accessOpts = undefined;
});

describe("useDateModeration — who gets the controls", () => {
  it("is never a moderator while the caller's gate is closed", () => {
    // `enabled` is false on the server render and on the first client render,
    // always — which is what keeps moderator chrome out of the bytes the edge
    // hands to strangers.
    const { result } = mount(false);

    expect(result.current.isModerator).toBe(false);
    expect(h.accessOpts?.enabled).toBe(false);
  });

  it("is a moderator only when the probe says allowed", () => {
    const { result } = mount(true);
    expect(result.current.isModerator).toBe(true);
  });

  it("shows nothing to a signed-in non-moderator", () => {
    h.access = { data: { allowed: false } };
    const { result } = mount(true);
    expect(result.current.isModerator).toBe(false);
  });

  it("shows nothing while the probe is still in flight, or after it fails", () => {
    // `retry: false` plus "only allowed === true" means every uncertain answer
    // fails CLOSED: the plain public schedule, never a half-rendered toolbar.
    h.access = { data: undefined };
    const { result } = mount(true);

    expect(result.current.isModerator).toBe(false);
    expect(h.accessOpts?.retry).toBe(false);
  });

  it("drops the previous viewer's answer when the gate closes again", () => {
    const { result, rerender } = mount(true);
    expect(result.current.isModerator).toBe(true);

    // A disabled react-query keeps whatever it last resolved, so the hook folds
    // `enabled` back in rather than trusting the query's own gating.
    rerender({ enabled: false });
    expect(result.current.isModerator).toBe(false);
  });
});

describe("useDateModeration — the two writes", () => {
  it("calls a night off, then re-reads the list", async () => {
    const { result } = mount(true);

    await act(async () => {
      result.current.callOff(DATE_ID);
      await tick();
      await tick();
    });

    expect(h.cancelEventDate).toHaveBeenCalledWith({ eventDateId: DATE_ID });
    // NOT optimistic, deliberately: the write moves the night's status, which
    // date the section leads with, and possibly the whole zero-dates state —
    // `Event.startsAt` is re-pinned in the same transaction. Guessing that
    // locally is how the NEXT card ends up advertising a night that is off.
    expect(h.calls).toEqual([`invalidate:${EVENT_ID}`]);
  });

  it("holds that one date busy while the write is on the wire", async () => {
    let release!: () => void;
    h.cancelEventDate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const { result } = mount(true);

    await act(async () => {
      result.current.callOff(DATE_ID);
      await tick();
    });
    expect(result.current.pendingIds.has(DATE_ID)).toBe(true);

    await act(async () => {
      release();
      await tick();
      await tick();
    });
    await waitFor(() =>
      expect(result.current.pendingIds.has(DATE_ID)).toBe(false),
    );
  });

  it("ignores a second press on a date already in flight", async () => {
    h.cancelEventDate = vi.fn(() => new Promise<void>(() => {}));
    const { result } = mount(true);

    await act(async () => {
      result.current.callOff(DATE_ID);
      await tick();
    });
    await act(async () => {
      result.current.callOff(DATE_ID);
      await tick();
    });

    // A double press must not send the cancellation mail twice — the server is
    // idempotent, but the guard keeps the round trip off the wire at all.
    expect(h.cancelEventDate).toHaveBeenCalledTimes(1);
  });

  it("puts a night back through the restore path", async () => {
    const { result } = mount(true);

    await act(async () => {
      result.current.putBack(DATE_ID);
      await tick();
      await tick();
    });

    expect(h.restoreEventDate).toHaveBeenCalledWith({ eventDateId: DATE_ID });
    expect(h.cancelEventDate).not.toHaveBeenCalled();
  });
});

describe("useDateModeration — the step-up 2FA gate", () => {
  it("routes SECOND_FACTOR_REQUIRED into the enrollment flow, not a failure toast", async () => {
    h.handleSecondFactor = vi.fn(() => true); // it recognised the code
    h.cancelEventDate = vi.fn(() => Promise.reject(new Error("FORBIDDEN")));

    const { result } = mount(true);

    await act(async () => {
      result.current.callOff(DATE_ID);
      await tick();
      await tick();
    });

    expect(h.handleSecondFactor).toHaveBeenCalledTimes(1);
    // This page has no `/moderate` edge gate to have redirected them, so the
    // step-up toast is the only thing that tells a moderator what to do.
    // Reporting it as "something went wrong" strands them.
    expect(h.danger).not.toHaveBeenCalled();
    // The list is still re-read: the gate may have flipped under a write that
    // partially applied, and a stale list is its own bug.
    expect(h.calls).toEqual([`invalidate:${EVENT_ID}`]);
  });

  it("falls through to a plain failure toast for anything else", async () => {
    h.handleSecondFactor = vi.fn(() => false);
    h.cancelEventDate = vi.fn(() => Promise.reject(new Error("boom")));

    const { result } = mount(true);

    await act(async () => {
      result.current.callOff(DATE_ID);
      await tick();
      await tick();
    });

    expect(h.danger).toHaveBeenCalledTimes(1);
    expect(h.danger).toHaveBeenCalledWith({ title: "rsvp.errCallOffFailed" });
  });

  it("uses the restore copy when it is the restore that failed", async () => {
    h.restoreEventDate = vi.fn(() => Promise.reject(new Error("boom")));

    const { result } = mount(true);

    await act(async () => {
      result.current.putBack(DATE_ID);
      await tick();
      await tick();
    });

    expect(h.danger).toHaveBeenCalledWith({ title: "rsvp.errPutBackFailed" });
  });

  it.each(["EVENT_ALREADY_CANCELLED", "EVENT_ARCHIVED"])(
    "says the listing is taken down when the restore is refused with %s",
    async (appCode) => {
      h.restoreEventDate = vi.fn(() =>
        Promise.reject(Object.assign(new Error("CONFLICT"), { data: { appCode } })),
      );

      const { result } = mount(true);

      await act(async () => {
        result.current.putBack(DATE_ID);
        await tick();
        await tick();
      });

      expect(h.danger).toHaveBeenCalledWith({
        title: "rsvp.errPutBackListingTakenDown",
      });
    },
  );

  it("says the listing has ended when the restore is refused with EVENT_ALREADY_COMPLETED", async () => {
    h.restoreEventDate = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("CONFLICT"), {
          data: { appCode: "EVENT_ALREADY_COMPLETED" },
        }),
      ),
    );

    const { result } = mount(true);

    await act(async () => {
      result.current.putBack(DATE_ID);
      await tick();
      await tick();
    });

    expect(h.danger).toHaveBeenCalledWith({ title: "rsvp.errPutBackListingEnded" });
  });

  it("keeps the generic call-off toast for those codes on a call-off", async () => {
    h.cancelEventDate = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("CONFLICT"), {
          data: { appCode: "EVENT_ARCHIVED" },
        }),
      ),
    );

    const { result } = mount(true);

    await act(async () => {
      result.current.callOff(DATE_ID);
      await tick();
      await tick();
    });

    expect(h.danger).toHaveBeenCalledWith({ title: "rsvp.errCallOffFailed" });
  });
});
