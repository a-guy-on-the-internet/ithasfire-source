// @vitest-environment jsdom
/**
 * The event pin under a door sale: held while a sale is at risk, let go only
 * when the till is idle, and never taken from an event the operator picked.
 */
import { useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useSaleEventPin } from "./use-sale-event-pin";

const DEFAULT = "11111111-1111-4111-8111-111111111111";
const NEXT_DEFAULT = "22222222-2222-4222-8222-222222222222";
const PICKED = "33333333-3333-4333-8333-333333333333";

/** The app's event state: a pick, else the (movable) default. */
function renderPin(initialDefault: string | null = DEFAULT) {
  return renderHook(
    ({ defaultEventId }: { defaultEventId: string | null }) => {
      const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
      const eventId = selectedEventId ?? defaultEventId;
      const pin = useSaleEventPin({ eventId, selectedEventId, setSelectedEventId });
      return { eventId, selectedEventId, ...pin };
    },
    { initialProps: { defaultEventId: initialDefault } },
  );
}

afterEach(() => cleanup());

describe("useSaleEventPin", () => {
  it("a pin holds the event when the default moves on", () => {
    const h = renderPin();
    act(() => h.result.current.pin());
    expect(h.result.current.selectedEventId).toBe(DEFAULT);
    h.rerender({ defaultEventId: NEXT_DEFAULT });
    expect(h.result.current.eventId).toBe(DEFAULT);
  });

  it("release lets go of the guard's pin: the default rules again", () => {
    const h = renderPin();
    act(() => h.result.current.pin());
    h.rerender({ defaultEventId: NEXT_DEFAULT });
    act(() => h.result.current.release());
    expect(h.result.current.selectedEventId).toBeNull();
    expect(h.result.current.eventId).toBe(NEXT_DEFAULT);
  });

  it("release without a pin does nothing", () => {
    const h = renderPin();
    act(() => h.result.current.release());
    expect(h.result.current.selectedEventId).toBeNull();
    expect(h.result.current.eventId).toBe(DEFAULT);
  });

  it("an event the operator picked is never released", () => {
    const h = renderPin();
    act(() => h.result.current.pick(PICKED));
    act(() => h.result.current.pin());
    act(() => h.result.current.release());
    expect(h.result.current.selectedEventId).toBe(PICKED);
  });

  it("a pick replaces the guard's pin, and release then keeps the pick", () => {
    const h = renderPin();
    act(() => h.result.current.pin());
    act(() => h.result.current.pick(PICKED));
    act(() => h.result.current.release());
    expect(h.result.current.selectedEventId).toBe(PICKED);
  });

  it("pin twice, release once: one pin, gone", () => {
    const h = renderPin();
    act(() => {
      h.result.current.pin();
      h.result.current.pin();
    });
    act(() => h.result.current.release());
    expect(h.result.current.selectedEventId).toBeNull();
  });

  it("no event at all: nothing to pin", () => {
    const h = renderPin(null);
    act(() => h.result.current.pin());
    expect(h.result.current.selectedEventId).toBeNull();
  });
});
