import { act } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The RSVP button's SSR → hydration contract, driven the way the browser drives
 * it: render the component to HTML with the session store in its SERVER state,
 * then hydrate that HTML with the session store ALREADY RESOLVED.
 *
 * That ordering is the bug, not a contrivance. `authClient.useSession()` is a
 * client store that never fetches during SSR (`better-auth/client/query`
 * early-returns on `isServer()`), so every server render is
 * `{ data: null, isPending: true }`. By the time this island hydrates the real
 * store often HAS resolved — measured at 8 of 10 signed-in loads of
 * `/events/community-neighborhood-jam` — and the first client render then took
 * the signed-in branch while the HTML underneath it was signed-out:
 *
 *   server:  <button aria-pressed="false">                    opacity 1
 *   client:  <button aria-pressed="false" aria-disabled="true"
 *                    aria-busy="true">                        opacity 0.55
 *
 * React reports that as "A tree hydrated but some attributes of the server
 * rendered HTML didn't match the client properties. This won't be patched up."
 * — and it means it: the DOM keeps the server's attributes, so the divergence
 * outlives the message.
 *
 * The helper's own unit tests pin the derivation. This one pins the WIRING:
 * that `useRsvpToggle` actually feeds `hydrated` in, which no test of a pure
 * function can see.
 */

const h = vi.hoisted(() => ({
  /** Flipped between the server render and the hydration. */
  session: {
    data: null as { user?: { id: string } } | null,
    isPending: true,
  },
  queryRsvped: undefined as boolean | undefined,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      community: {
        myRsvpForEvent: { setData: vi.fn(), invalidate: vi.fn() },
        myRsvps: { invalidate: vi.fn() },
      },
    }),
    community: {
      myRsvpForEvent: {
        useQuery: () => ({
          data:
            h.queryRsvped === undefined ? undefined : { rsvped: h.queryRsvped },
        }),
      },
      rsvp: { useMutation: () => ({ mutate: vi.fn() }) },
      cancelRsvp: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

vi.mock("@tanstack/react-query", () => ({ useIsMutating: () => 0 }));
vi.mock("@trpc/react-query", () => ({ getMutationKey: () => ["mutation"] }));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => h.session },
}));

vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: vi.fn() }),
}));

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    useTranslations: () => (key: string) => key,
    useNotify: () => ({ toast: { danger: vi.fn() } }),
    Text: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
  };
});

import { RsvpButton } from "../RsvpButton";

const SERVER_SESSION = { data: null, isPending: true } as const;
const RESOLVED_SIGNED_IN = {
  data: { user: { id: "human-1" } },
  isPending: false,
} as const;
const RESOLVED_ANONYMOUS = { data: null, isPending: false } as const;

/** React reports hydration divergence through `console.error`. */
let logged: string[];
let restoreConsole: () => void;

beforeEach(() => {
  logged = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
    logged.push(args.map(String).join(" "));
  });
  restoreConsole = () => {
    spy.mockRestore();
  };
});

afterEach(() => {
  restoreConsole();
});

/** Renders on the "server", then hydrates with whatever session is set. */
async function ssrThenHydrate(
  props: { initialRsvped?: boolean },
  opts: { settlesTo?: "signed-in" | null } = {},
) {
  h.session = { ...SERVER_SESSION };
  // The real hook seeds the query with `initialData: { rsvped: initialRsvped }`
  // when the prop is present, so the query answers the same on BOTH sides.
  // Without a prop it answers `undefined` on both — a fetch cannot land inside
  // a first render.
  h.queryRsvped = props.initialRsvped;
  const html = renderToString(<RsvpButton eventId="event-1" {...props} />);

  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const before = attributesOf(container);

  // The race, made deterministic: the store settled before this island got its
  // turn.
  h.session =
    opts.settlesTo === null
      ? { ...RESOLVED_ANONYMOUS }
      : { ...RESOLVED_SIGNED_IN };

  let root: ReturnType<typeof hydrateRoot> | undefined;
  await act(async () => {
    root = hydrateRoot(container, <RsvpButton eventId="event-1" {...props} />);
    // Inside the act scope on purpose: the `hydrated` effect and the re-render
    // it schedules must be part of the same flush, so `after` below is the
    // settled state rather than a half-committed one.
    await Promise.resolve();
  });

  const after = attributesOf(container);
  root?.unmount();
  container.remove();
  return { before, after };
}

function attributesOf(container: HTMLElement) {
  const button = container.querySelector("button");
  if (!button) throw new Error("no button rendered");
  return {
    ariaPressed: button.getAttribute("aria-pressed"),
    ariaDisabled: button.getAttribute("aria-disabled"),
    ariaBusy: button.getAttribute("aria-busy"),
    opacity: button.style.opacity,
  };
}

const hydrationComplaints = (messages: string[]) =>
  messages.filter((m) => /hydrat|didn't match|did not match/i.test(m));

describe("RsvpButton — hydration", () => {
  it("hydrates clean with no SSR seed and a session that resolved first", async () => {
    // The exact production shape: `viewerRsvped` is stripped from the
    // edge-cached document, so `initialRsvped` is undefined on both sides.
    const { before, after } = await ssrThenHydrate({});

    expect(hydrationComplaints(logged)).toEqual([]);
    // The server's shape is the signed-out one, and it is PRESSABLE.
    expect(before).toEqual({
      ariaPressed: "false",
      ariaDisabled: null,
      ariaBusy: null,
      opacity: "1",
    });
    // …and the flag releases on the very next commit: a signed-in viewer with
    // no seed and no query yet is the genuine loading state.
    expect(after).toEqual({
      ariaPressed: "false",
      ariaDisabled: "true",
      ariaBusy: "true",
      opacity: "0.55",
    });
  });

  it("hydrates clean with an SSR seed present, then hands back the steady state", async () => {
    const { before, after } = await ssrThenHydrate({ initialRsvped: true });

    expect(hydrationComplaints(logged)).toEqual([]);
    // A seeded render is the inert window — the server renders it inert too,
    // because its own `isPending` is true — so the fast-press guard survives
    // the fix rather than being papered over by it.
    expect(before).toEqual({
      ariaPressed: "true",
      ariaDisabled: "true",
      ariaBusy: "true",
      opacity: "0.55",
    });
    // One commit later the real session is in charge again: going, pressable.
    expect(after).toEqual({
      ariaPressed: "true",
      ariaDisabled: null,
      ariaBusy: null,
      opacity: "1",
    });
  });

  it("hydrates clean for a genuinely anonymous viewer, and stays pressable", async () => {
    // Same render, but the store settles to NO session. The button must never
    // go inert here — an anonymous visitor pressing it is how the sign-in
    // overlay opens, and gating that on session timing was the S1 dead-end.
    const { before, after } = await ssrThenHydrate({}, { settlesTo: null });

    expect(hydrationComplaints(logged)).toEqual([]);
    expect(before.ariaDisabled).toBeNull();
    expect(after).toEqual({
      ariaPressed: "false",
      ariaDisabled: null,
      ariaBusy: null,
      opacity: "1",
    });
  });
});
