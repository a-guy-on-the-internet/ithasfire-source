import { describe, expect, it } from "vitest";

import { deriveRsvpButtonState } from "../rsvp-button.helpers";

/**
 * Every case in this block is POST-hydration (`hydrated: true`) — the steady
 * state, where the client session store is the authority. The pre-hydration
 * contract is its own block at the bottom.
 */
describe("deriveRsvpButtonState", () => {
  it("is pressable (sign-in path) while the anon session is still resolving", () => {
    // Anon clickability must NEVER gate on session-resolution timing — a
    // slow/settling `isPending` is what made the button a dead-end (S1).
    expect(
      deriveRsvpButtonState({
        hydrated: true,
        isSignedIn: false,
        sessionPending: true,
        queryRsvped: undefined,
        initialRsvped: undefined,
        mutationPending: false,
      }),
    ).toEqual({ going: false, resolving: false, disabled: false });
  });

  it("is pressable (sign-in path) once resolved signed-out", () => {
    expect(
      deriveRsvpButtonState({
        hydrated: true,
        isSignedIn: false,
        sessionPending: false,
        queryRsvped: undefined,
        initialRsvped: undefined,
        mutationPending: false,
      }),
    ).toEqual({ going: false, resolving: false, disabled: false });
  });

  it("stays inert while a SSR-seeded signed-in session is still resolving", () => {
    // `initialRsvped` is only seeded by SSR for signed-in viewers, so its
    // presence means "was signed-in at request time; the client session is
    // catching up". Stay briefly inert so a fast press can't open the
    // sign-in overlay for an already-authenticated user. Bounded by
    // `sessionPending` — the moment the session settles we re-derive.
    expect(
      deriveRsvpButtonState({
        hydrated: true,
        isSignedIn: false,
        sessionPending: true,
        queryRsvped: undefined,
        initialRsvped: true,
        mutationPending: false,
      }),
    ).toEqual({ going: true, resolving: true, disabled: true });

    // Same guard when the SSR seed says the viewer had NOT RSVP'd.
    expect(
      deriveRsvpButtonState({
        hydrated: true,
        isSignedIn: false,
        sessionPending: true,
        queryRsvped: undefined,
        initialRsvped: false,
        mutationPending: false,
      }),
    ).toEqual({ going: false, resolving: true, disabled: true });
  });

  it("is pressable (sign-in path) when a SSR-seeded session settles signed-out", () => {
    // The session expired/was revoked between SSR and hydration (or a stale
    // client-nav payload carried a seed). The seed must NOT pin the button
    // disabled forever — that would recreate the S1 dead-end.
    expect(
      deriveRsvpButtonState({
        hydrated: true,
        isSignedIn: false,
        sessionPending: false,
        queryRsvped: undefined,
        initialRsvped: true,
        mutationPending: false,
      }),
    ).toEqual({ going: false, resolving: false, disabled: false });
  });

  it("uses the server seed before the client query lands", () => {
    const state = deriveRsvpButtonState({
      hydrated: true,
      isSignedIn: true,
      sessionPending: false,
      queryRsvped: undefined,
      initialRsvped: true,
      mutationPending: false,
    });
    expect(state.going).toBe(true);
    expect(state.resolving).toBe(false);
    expect(state.disabled).toBe(false);
  });

  it("prefers fresh query state over the server seed", () => {
    expect(
      deriveRsvpButtonState({
        hydrated: true,
        isSignedIn: true,
        sessionPending: false,
        queryRsvped: false,
        initialRsvped: true,
        mutationPending: false,
      }).going,
    ).toBe(false);
  });

  it("resolves as loading when signed in with no seed and no query yet", () => {
    const state = deriveRsvpButtonState({
      hydrated: true,
      isSignedIn: true,
      sessionPending: false,
      queryRsvped: undefined,
      initialRsvped: undefined,
      mutationPending: false,
    });
    expect(state.resolving).toBe(true);
    expect(state.disabled).toBe(true);
  });

  it("blocks presses while a mutation is in flight", () => {
    const state = deriveRsvpButtonState({
      hydrated: true,
      isSignedIn: true,
      sessionPending: false,
      queryRsvped: true,
      initialRsvped: undefined,
      mutationPending: true,
    });
    expect(state.disabled).toBe(true);
    expect(state.resolving).toBe(false);
    expect(state.going).toBe(true);
  });
});

/**
 * The first CLIENT render must reproduce the SERVER's render exactly, or React
 * logs "A tree hydrated but some attributes of the server rendered HTML didn't
 * match the client properties. This won't be patched up." and then leaves the
 * DOM holding whichever attributes the server happened to write.
 *
 * That was live on a single-date community listing, signed in, on 8 of 10
 * loads: `viewerRsvped` is stripped from the edge-cached document (it arrives
 * after first paint from the viewer-state POST), so `initialRsvped` is
 * `undefined` on BOTH sides — but `authClient.useSession()` never fetches
 * during SSR and often HAS resolved by the time this island hydrates. The
 * server took the signed-out branch (no `aria-disabled`, no `aria-busy`,
 * opacity 1) and the first client render took the signed-in one
 * (`aria-disabled="true"`, `aria-busy="true"`, opacity 0.55).
 *
 * The fix is a premise, not a guess: while `hydrated` is false the two session
 * inputs are forced to the only values a server render can have.
 */
describe("deriveRsvpButtonState — before hydration", () => {
  const CLIENT_SESSION_STATES = [
    // The bug: the client store resolved a session before this island hydrated.
    {
      name: "session already resolved signed-in",
      isSignedIn: true,
      sessionPending: false,
    },
    {
      name: "session still resolving",
      isSignedIn: false,
      sessionPending: true,
    },
    {
      name: "session resolved signed-out",
      isSignedIn: false,
      sessionPending: false,
    },
  ] as const;

  it("answers the SERVER's shape whatever the client session says (no seed)", () => {
    // What the server rendered: no session store, so no user and `isPending`
    // true, with no `viewerRsvped` seed on an edge-cached document.
    const serverShape = deriveRsvpButtonState({
      hydrated: true,
      isSignedIn: false,
      sessionPending: true,
      queryRsvped: undefined,
      initialRsvped: undefined,
      mutationPending: false,
    });
    expect(serverShape).toEqual({
      going: false,
      resolving: false,
      disabled: false,
    });

    for (const session of CLIENT_SESSION_STATES) {
      expect(
        deriveRsvpButtonState({
          hydrated: false,
          isSignedIn: session.isSignedIn,
          sessionPending: session.sessionPending,
          queryRsvped: undefined,
          initialRsvped: undefined,
          mutationPending: false,
        }),
        session.name,
      ).toEqual(serverShape);
    }
  });

  it("still answers the server's shape with an SSR seed present", () => {
    // A seeded render is the inert window (see the post-hydration block): the
    // server renders it that way too, because its `sessionPending` is true.
    const serverShape = deriveRsvpButtonState({
      hydrated: true,
      isSignedIn: false,
      sessionPending: true,
      queryRsvped: true,
      initialRsvped: true,
      mutationPending: false,
    });
    expect(serverShape).toEqual({
      going: true,
      resolving: true,
      disabled: true,
    });

    for (const session of CLIENT_SESSION_STATES) {
      expect(
        deriveRsvpButtonState({
          hydrated: false,
          isSignedIn: session.isSignedIn,
          sessionPending: session.sessionPending,
          queryRsvped: true,
          initialRsvped: true,
          mutationPending: false,
        }),
        session.name,
      ).toEqual(serverShape);
    }
  });

  it("keeps an anonymous viewer's CTA pressable before hydration", () => {
    // The S1 dead-end in its newest disguise: if the pre-hydration answer were
    // "inert until we know", an anonymous visitor would meet a button that does
    // nothing for as long as hydration takes. No seed means no reason to wait.
    expect(
      deriveRsvpButtonState({
        hydrated: false,
        isSignedIn: false,
        sessionPending: true,
        queryRsvped: undefined,
        initialRsvped: undefined,
        mutationPending: false,
      }).disabled,
    ).toBe(false);
  });

  it("hands the steady state back the moment it hydrates", () => {
    // The window is ONE commit — not a new state the viewer can get stuck in.
    const args = {
      isSignedIn: true,
      sessionPending: false,
      queryRsvped: true,
      initialRsvped: undefined,
      mutationPending: false,
    } as const;

    expect(deriveRsvpButtonState({ hydrated: false, ...args })).toEqual({
      going: false,
      resolving: false,
      disabled: false,
    });
    expect(deriveRsvpButtonState({ hydrated: true, ...args })).toEqual({
      going: true,
      resolving: false,
      disabled: false,
    });
  });
});
