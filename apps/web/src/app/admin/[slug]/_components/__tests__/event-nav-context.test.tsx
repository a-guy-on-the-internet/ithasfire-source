import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import {
  EventNavProvider,
  useEventNavActions,
  useEventNavIdentity,
  useEventNavState,
  type EventNavActionsValue,
} from "../event-nav-context";

/**
 * The split-context contract (perf fix for the event-builder regroup):
 * scroll-spy state updates must re-render STATE consumers (the rail) but
 * never ACTIONS-only consumers (EventBuilder — whose own scroll-spy reports
 * previously re-rendered the entire ~4k-line builder per section crossing).
 */

type Probe = {
  renders: number;
  actions: EventNavActionsValue | null;
  actionIdentities: EventNavActionsValue[];
};

function ActionsOnlyConsumer({ probe }: { probe: Probe }) {
  const actions = useEventNavActions();
  probe.renders += 1;
  probe.actions = actions;
  if (actions) probe.actionIdentities.push(actions);
  return null;
}

function StateConsumer() {
  const state = useEventNavState();
  return (
    <div data-testid="active-section">{state?.activeSection ?? "none"}</div>
  );
}

function IdentityConsumer({ eventId }: { eventId: string }) {
  const identity = useEventNavIdentity(eventId);
  return (
    <div data-testid="identity">
      {identity ? `${identity.title}/${identity.stewardship}` : "none"}
    </div>
  );
}

/** Registers a jump handler for the provider's lifetime. */
function JumpHandlerRegistrar({
  handler,
}: {
  handler: (sectionId: string) => void;
}) {
  const actions = useEventNavActions();
  const registerJumpHandler = actions?.registerJumpHandler;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!registerJumpHandler) return;
    return registerJumpHandler((sectionId) => handlerRef.current(sectionId));
  }, [registerJumpHandler]);
  return null;
}

const makeProbe = (): Probe => ({
  renders: 0,
  actions: null,
  actionIdentities: [],
});

describe("event-nav split contexts", () => {
  it("re-renders state consumers on scroll-spy reports without re-rendering actions-only consumers", () => {
    const probe = makeProbe();

    render(
      <EventNavProvider>
        <ActionsOnlyConsumer probe={probe} />
        <StateConsumer />
      </EventNavProvider>,
    );

    expect(screen.getByTestId("active-section").textContent).toBe("none");
    const rendersAfterMount = probe.renders;
    const actionsAfterMount = probe.actions;
    expect(actionsAfterMount).not.toBeNull();

    act(() => {
      probe.actions?.setActiveSection("tickets");
    });
    expect(screen.getByTestId("active-section").textContent).toBe("tickets");

    act(() => {
      probe.actions?.setActiveSection("splits");
    });
    expect(screen.getByTestId("active-section").textContent).toBe("splits");

    // The actions consumer must NOT have re-rendered for either report…
    expect(probe.renders).toBe(rendersAfterMount);
    // …and the actions value identity is stable for the provider's lifetime.
    expect(probe.actions).toBe(actionsAfterMount);
    expect(
      probe.actionIdentities.every((v) => v === actionsAfterMount),
    ).toBe(true);
  });

  it("jumpToSection returns false with no registered handler, true (and delegates) with one", () => {
    const probe = makeProbe();
    const handler = vi.fn();

    const { rerender } = render(
      <EventNavProvider>
        <ActionsOnlyConsumer probe={probe} />
      </EventNavProvider>,
    );

    expect(probe.actions?.jumpToSection("lineup")).toBe(false);

    rerender(
      <EventNavProvider>
        <ActionsOnlyConsumer probe={probe} />
        <JumpHandlerRegistrar handler={handler} />
      </EventNavProvider>,
    );

    expect(probe.actions?.jumpToSection("lineup")).toBe(true);
    expect(handler).toHaveBeenCalledWith("lineup");
  });

  it("clears activeSection when the registered surface unmounts", () => {
    const probe = makeProbe();
    const handler = vi.fn();

    const { rerender } = render(
      <EventNavProvider>
        <ActionsOnlyConsumer probe={probe} />
        <StateConsumer />
        <JumpHandlerRegistrar handler={handler} />
      </EventNavProvider>,
    );

    act(() => {
      probe.actions?.setActiveSection("details");
    });
    expect(screen.getByTestId("active-section").textContent).toBe("details");

    // Unmount the surface (registrar) — the stale scroll-spy report resets.
    rerender(
      <EventNavProvider>
        <ActionsOnlyConsumer probe={probe} />
        <StateConsumer />
      </EventNavProvider>,
    );

    expect(screen.getByTestId("active-section").textContent).toBe("none");
    // Losing the handler makes jumps fall back to navigation again.
    expect(probe.actions?.jumpToSection("details")).toBe(false);
  });

  // The rail and the `[id]` layout each fetched the owner-gated
  // `events.getEventTitle` for facts the edit surface had already read. On an
  // ownerless COMMUNITY listing that was two FORBIDDEN per load, so the edit
  // surface publishes what it read and they consume it instead.
  describe("identity publishing", () => {
    it("carries the published facts to a consumer, and withdraws on null", () => {
      const probe = makeProbe();
      render(
        <EventNavProvider>
          <ActionsOnlyConsumer probe={probe} />
          <IdentityConsumer eventId="evt-1" />
        </EventNavProvider>,
      );
      expect(screen.getByTestId("identity").textContent).toBe("none");

      act(() => {
        probe.actions?.publishIdentity({
          eventId: "evt-1",
          title: "Wednesday Comedy Lab",
          status: "DRAFT",
          slug: "wednesday-comedy-lab",
          stewardship: "COMMUNITY",
        });
      });
      expect(screen.getByTestId("identity").textContent).toBe(
        "Wednesday Comedy Lab/COMMUNITY",
      );

      act(() => {
        probe.actions?.publishIdentity(null);
      });
      expect(screen.getByTestId("identity").textContent).toBe("none");
    });

    it("never hands one event's facts to another event's consumer", () => {
      // Route transitions commit the new surface before the old one unmounts,
      // so a consumer keyed to the NEW id must not read the old publish.
      const probe = makeProbe();
      render(
        <EventNavProvider>
          <ActionsOnlyConsumer probe={probe} />
          <IdentityConsumer eventId="evt-2" />
        </EventNavProvider>,
      );
      act(() => {
        probe.actions?.publishIdentity({
          eventId: "evt-1",
          title: "Old Event",
          status: "PUBLISHED",
          slug: "old",
          stewardship: "OWNED",
        });
      });
      expect(screen.getByTestId("identity").textContent).toBe("none");
    });

    it("drops a value-equal republish so a per-render publish cannot loop", () => {
      const probe = makeProbe();
      render(
        <EventNavProvider>
          <ActionsOnlyConsumer probe={probe} />
          <IdentityConsumer eventId="evt-1" />
        </EventNavProvider>,
      );
      const same = {
        eventId: "evt-1",
        title: "T",
        status: "DRAFT",
        slug: null,
        stewardship: "OWNED",
      };
      act(() => probe.actions?.publishIdentity({ ...same }));
      const first = screen.getByTestId("identity");
      act(() => probe.actions?.publishIdentity({ ...same }));
      // Same node instance ⇒ React did not re-render the consumer.
      expect(screen.getByTestId("identity")).toBe(first);
    });

    it("does not re-render actions-only consumers when identity changes", () => {
      const probe = makeProbe();
      render(
        <EventNavProvider>
          <ActionsOnlyConsumer probe={probe} />
          <IdentityConsumer eventId="evt-1" />
        </EventNavProvider>,
      );
      const rendersAfterMount = probe.renders;
      act(() => {
        probe.actions?.publishIdentity({
          eventId: "evt-1",
          title: "T",
          status: "DRAFT",
          slug: null,
          stewardship: "OWNED",
        });
      });
      expect(probe.renders).toBe(rendersAfterMount);
    });
  });

  it("returns null from both hooks outside the provider (null-safe consumers)", () => {
    const probe = makeProbe();
    render(
      <>
        <ActionsOnlyConsumer probe={probe} />
        <StateConsumer />
      </>,
    );
    expect(probe.actions).toBeNull();
    expect(screen.getByTestId("active-section").textContent).toBe("none");
  });
});
