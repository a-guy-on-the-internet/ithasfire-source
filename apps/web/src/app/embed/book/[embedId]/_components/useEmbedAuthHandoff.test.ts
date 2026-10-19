import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMBED_AUTH_MESSAGE_TYPE } from "@/lib/embed-auth-handoff";

import { useEmbedAuthHandoff } from "./useEmbedAuthHandoff";

/**
 * Security-invariant tests for the popup handoff receiver
 * (booking-request-embed-button FR-010): the token is accepted ONLY from the
 * exact popup window the hook opened, on the page's exact origin, with a
 * shape-valid payload — everything else is ignored silently.
 */

type FakePopup = { closed: boolean; close: () => void };

const makeFakePopup = (): FakePopup => ({
  closed: false,
  close: vi.fn(),
});

/**
 * Dispatch a message event with a controlled origin/source. jsdom's
 * MessageEvent constructor webidl-validates `source`, so build a plain event
 * and pin the fields the handler reads.
 */
function dispatchMessage({
  data,
  origin,
  source,
}: {
  data: unknown;
  origin: string;
  source: unknown;
}) {
  const event = new Event("message") as MessageEvent;
  Object.defineProperties(event, {
    data: { value: data },
    origin: { value: origin },
    source: { value: source },
  });
  act(() => {
    window.dispatchEvent(event);
  });
}

const OWN_ORIGIN = window.location.origin;
const validPayload = { type: EMBED_AUTH_MESSAGE_TYPE, token: "jwt.token.value" };

/** Precisely-typed window.open spy (bare ReturnType<typeof vi.spyOn> widens). */
const spyOnWindowOpen = () => vi.spyOn(window, "open");

describe("useEmbedAuthHandoff", () => {
  let fakePopup: FakePopup;
  let openSpy: ReturnType<typeof spyOnWindowOpen>;

  beforeEach(() => {
    fakePopup = makeFakePopup();
    openSpy = spyOnWindowOpen().mockReturnValue(
      fakePopup as unknown as Window,
    );
  });

  afterEach(() => {
    openSpy.mockRestore();
    vi.useRealTimers();
  });

  it("opens the handoff popup on our own origin and enters the waiting state", () => {
    const { result } = renderHook(() => useEmbedAuthHandoff());
    act(() => result.current.login());

    expect(openSpy).toHaveBeenCalledWith(
      `${OWN_ORIGIN}/embed/auth-handoff`,
      "hf-auth",
      "popup,width=480,height=640",
    );
    expect(result.current.status).toBe("waiting");
    expect(result.current.token).toBeNull();
  });

  it("flags a blocked popup instead of waiting", () => {
    openSpy.mockReturnValue(null);
    const { result } = renderHook(() => useEmbedAuthHandoff());
    act(() => result.current.login());

    expect(result.current.popupBlocked).toBe(true);
    expect(result.current.status).toBe("idle");
  });

  it("ignores a valid-looking message from a foreign origin", () => {
    const { result } = renderHook(() => useEmbedAuthHandoff());
    act(() => result.current.login());

    dispatchMessage({
      data: validPayload,
      origin: "https://evil.example",
      source: fakePopup,
    });

    expect(result.current.token).toBeNull();
    expect(result.current.status).toBe("waiting");
  });

  it("ignores a message from our origin but a different source window", () => {
    const { result } = renderHook(() => useEmbedAuthHandoff());
    act(() => result.current.login());

    dispatchMessage({
      data: validPayload,
      origin: OWN_ORIGIN,
      source: makeFakePopup(), // not the popup we opened
    });

    expect(result.current.token).toBeNull();
    expect(result.current.status).toBe("waiting");
  });

  it("ignores a shape-invalid payload from the right origin and source", () => {
    const { result } = renderHook(() => useEmbedAuthHandoff());
    act(() => result.current.login());

    for (const data of [
      null,
      "jwt.token.value",
      { type: EMBED_AUTH_MESSAGE_TYPE, token: "" },
      { type: "hf:other", token: "jwt.token.value" },
    ]) {
      dispatchMessage({ data, origin: OWN_ORIGIN, source: fakePopup });
    }

    expect(result.current.token).toBeNull();
    expect(result.current.status).toBe("waiting");
  });

  it("accepts the token from the exact popup on the exact origin", () => {
    const { result } = renderHook(() => useEmbedAuthHandoff());
    act(() => result.current.login());

    dispatchMessage({
      data: validPayload,
      origin: OWN_ORIGIN,
      source: fakePopup,
    });

    expect(result.current.token).toBe("jwt.token.value");
    expect(result.current.status).toBe("authed");
    expect(result.current.loginCount).toBe(1);
  });

  it("stops accepting after cancelLogin (listener torn down, popup closed)", () => {
    const { result } = renderHook(() => useEmbedAuthHandoff());
    act(() => result.current.login());
    act(() => result.current.cancelLogin());

    expect(fakePopup.close).toHaveBeenCalled();
    expect(result.current.status).toBe("idle");

    dispatchMessage({
      data: validPayload,
      origin: OWN_ORIGIN,
      source: fakePopup,
    });

    expect(result.current.token).toBeNull();
    expect(result.current.status).toBe("idle");
  });

  it("times out after the cap: closes the popup, resets, and flags timedOut", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useEmbedAuthHandoff());
    act(() => result.current.login());

    act(() => {
      vi.advanceTimersByTime(5 * 60_000 + 1);
    });

    expect(fakePopup.close).toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
    expect(result.current.timedOut).toBe(true);
    expect(result.current.token).toBeNull();

    // A late message after the timeout is ignored.
    dispatchMessage({
      data: validPayload,
      origin: OWN_ORIGIN,
      source: fakePopup,
    });
    expect(result.current.token).toBeNull();
  });

  it("drops the token on markSessionExpired and flags the expiry", () => {
    const { result } = renderHook(() => useEmbedAuthHandoff());
    act(() => result.current.login());
    dispatchMessage({
      data: validPayload,
      origin: OWN_ORIGIN,
      source: fakePopup,
    });
    expect(result.current.token).toBe("jwt.token.value");

    act(() => result.current.markSessionExpired());
    expect(result.current.token).toBeNull();
    expect(result.current.sessionExpired).toBe(true);
    expect(result.current.status).toBe("idle");
  });
});
