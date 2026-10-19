import { act, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdminPageSectionsProvider,
  computeActiveSection,
  sectionTargetFromHref,
  useAdminPageSectionsActions,
  useAdminPageSectionsState,
  useInPageSections,
} from "../admin-page-sections";

const wrapper = ({ children }: { children: ReactNode }) => (
  <AdminPageSectionsProvider>{children}</AdminPageSectionsProvider>
);

describe("sectionTargetFromHref", () => {
  const base = "/admin/acme-co";

  it("splits a workspace anchor into route id and section", () => {
    expect(sectionTargetFromHref("/admin/acme-co/payouts#ledger", base)).toEqual({
      routeId: "payouts",
      sectionId: "ledger",
    });
  });

  it("ignores hrefs without a usable fragment", () => {
    expect(sectionTargetFromHref("/admin/acme-co/payouts", base)).toBeNull();
    expect(sectionTargetFromHref("/admin/acme-co/payouts#", base)).toBeNull();
    // Never decoded, never thrown on.
    expect(sectionTargetFromHref("/admin/acme-co/payouts#%", base)).toBeNull();
    expect(sectionTargetFromHref("/admin/acme-co/payouts#Ledger", base)).toBeNull();
  });

  it("does not resolve an href outside this workspace", () => {
    expect(sectionTargetFromHref("/admin/other/payouts#ledger", base)).toBeNull();
    // Slug-prefix trap: acme-co-2 is not under acme-co.
    expect(sectionTargetFromHref("/admin/acme-co-2/payouts#ledger", base)).toBeNull();
  });

  it("reads the event builder's query-style anchor as no section at all", () => {
    expect(
      sectionTargetFromHref("/admin/acme-co/events/e1/edit?section=tickets", base),
    ).toBeNull();
  });
});

describe("computeActiveSection", () => {
  const ids = ["balance", "ledger", "schedule", "stripe"];
  const tops = (map: Record<string, number | null>) => (id: string) =>
    map[id] ?? null;
  const viewport = { innerHeight: 1000, scrollY: 400, scrollHeight: 5000 };

  it("is the last heading above the reading line (35% down)", () => {
    expect(
      computeActiveSection(
        ids,
        tops({ balance: -900, ledger: 200, schedule: 600, stripe: 1400 }),
        viewport,
      ),
    ).toBe("ledger");
  });

  it("defaults to the first rendered section above everything", () => {
    expect(
      computeActiveSection(
        ids,
        tops({ balance: 500, ledger: 1500, schedule: 2500, stripe: 3500 }),
        { ...viewport, scrollY: 0 },
      ),
    ).toBe("balance");
  });

  it("at the bottom of a scrolled page the last section wins", () => {
    expect(
      computeActiveSection(
        ids,
        tops({ balance: -2000, ledger: -800, schedule: 100, stripe: 600 }),
        { innerHeight: 1000, scrollY: 4000, scrollHeight: 5000 },
      ),
    ).toBe("stripe");
  });

  it("an unscrolled page that fits the viewport is NOT 'at the bottom'", () => {
    expect(
      computeActiveSection(
        ids,
        tops({ balance: 100, ledger: 500, schedule: 600, stripe: 700 }),
        { innerHeight: 1000, scrollY: 0, scrollHeight: 1000 },
      ),
    ).toBe("balance");
  });
});

describe("AdminPageSectionsProvider", () => {
  it("routes a jump to the registered page, and refuses once it unregisters", () => {
    const { result } = renderHook(
      () => ({
        actions: useAdminPageSectionsActions()!,
        state: useAdminPageSectionsState()!,
      }),
      { wrapper },
    );
    const jump = vi.fn(() => true);
    let unregister: () => void = () => {};
    act(() => {
      unregister = result.current.actions.register("payouts", jump);
    });
    expect(result.current.actions.jumpToSection("payouts", "ledger")).toBe(true);
    expect(jump).toHaveBeenCalledWith("ledger");
    expect(result.current.actions.jumpToSection("orders", "x")).toBe(false);

    act(() => result.current.actions.setActiveSection("payouts", "ledger"));
    expect(result.current.state.activeSection).toEqual({
      routeId: "payouts",
      sectionId: "ledger",
    });

    act(() => unregister());
    expect(result.current.actions.jumpToSection("payouts", "ledger")).toBe(false);
    // The unmounted page's scroll-spy report is withdrawn.
    expect(result.current.state.activeSection).toBeNull();
  });

  it("the actions value is stable across scroll-spy reports", () => {
    const { result } = renderHook(() => useAdminPageSectionsActions(), {
      wrapper,
    });
    const first = result.current;
    act(() => first!.setActiveSection("payouts", "ledger"));
    expect(result.current).toBe(first);
  });
});

describe("useInPageSections", () => {
  const SECTION_IDS = ["balance", "ledger"] as const;
  let reduceMotion = false;

  let onJump: ((sectionId: string) => void) | undefined;
  function Page({
    ready = true,
    landingReady,
  }: {
    ready?: boolean;
    landingReady?: boolean;
  }) {
    return (
      <>
        <h2 id="balance" tabIndex={-1}>
          Balance
        </h2>
        <h2 id="ledger" tabIndex={-1}>
          Ledger
        </h2>
        <Probe ready={ready} landingReady={landingReady} />
      </>
    );
  }
  let latest: ReturnType<typeof useInPageSections> | null = null;
  let rail: ReturnType<typeof useAdminPageSectionsActions> = null;
  function Probe({
    ready,
    landingReady,
  }: {
    ready: boolean;
    landingReady?: boolean;
  }) {
    latest = useInPageSections({
      routeId: "payouts",
      sectionIds: SECTION_IDS,
      ready,
      landingReady,
      onJump,
    });
    rail = useAdminPageSectionsActions();
    return null;
  }

  beforeEach(() => {
    reduceMotion = false;
    latest = null;
    rail = null;
    onJump = undefined;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("reduce") ? reduceMotion : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState(null, "", "/admin/acme-co/payouts");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a rail jump scrolls smoothly, focuses the heading, writes the fragment and reports it", () => {
    render(<Page />, { wrapper });
    let handled = false;
    act(() => {
      handled = rail!.jumpToSection("payouts", "ledger");
    });
    expect(handled).toBe(true);
    const ledger = document.getElementById("ledger")!;
    expect(ledger.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "smooth",
    });
    expect(document.activeElement).toBe(ledger);
    expect(window.location.hash).toBe("#ledger");
    expect(latest!.activeSectionId).toBe("ledger");
  });

  it("honours reduced motion with an instant jump", () => {
    reduceMotion = true;
    render(<Page />, { wrapper });
    act(() => {
      latest!.jumpTo("ledger");
    });
    expect(document.getElementById("ledger")!.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "auto",
    });
  });

  it("an unknown section is declined so the caller can navigate instead", () => {
    render(<Page />, { wrapper });
    let handled = true;
    act(() => {
      handled = rail!.jumpToSection("payouts", "nope");
    });
    expect(handled).toBe(false);
  });

  it("onJump hears every landed jump — the landing and the rail — and no refused one", () => {
    const heard: string[] = [];
    onJump = (id) => heard.push(id);
    window.history.replaceState(null, "", "/admin/acme-co/payouts#ledger");
    render(<Page />, { wrapper });
    expect(heard).toEqual(["ledger"]);
    act(() => {
      rail!.jumpToSection("payouts", "balance");
    });
    act(() => {
      rail!.jumpToSection("payouts", "nope");
    });
    expect(heard).toEqual(["ledger", "balance"]);
  });

  it("registers nothing until the sections exist", () => {
    render(<Page ready={false} />, { wrapper });
    expect(rail!.jumpToSection("payouts", "ledger")).toBe(false);
  });

  it("lands once on a #section fragment when the sections first render", () => {
    window.history.replaceState(null, "", "/admin/acme-co/payouts#ledger");
    const { rerender } = render(<Page ready={false} />, { wrapper });
    expect(document.getElementById("ledger")!.scrollIntoView).not.toHaveBeenCalled();
    rerender(<Page ready />);
    expect(document.getElementById("ledger")!.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.getElementById("ledger")!.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "auto",
    });
    rerender(<Page ready />);
    expect(document.getElementById("ledger")!.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("holds ONLY the landing jump until late content settles; rail jumps stay immediate", () => {
    window.history.replaceState(null, "", "/admin/acme-co/payouts#ledger");
    const { rerender } = render(<Page landingReady={false} />, { wrapper });
    const ledger = document.getElementById("ledger")!;
    const balance = document.getElementById("balance")!;
    // scrollIntoView is ONE prototype mock: count calls per element.
    const scroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    const scrolledOn = (el: Element) =>
      scroll.mock.instances.filter((ctx: unknown) => ctx === el).length;

    // Sections exist but a card may still appear above: no landing yet.
    expect(scroll).not.toHaveBeenCalled();
    // The rail is live meanwhile.
    let handled = false;
    act(() => {
      handled = rail!.jumpToSection("payouts", "balance");
    });
    expect(handled).toBe(true);
    expect(scrolledOn(balance)).toBe(1);
    // That rail jump rewrote the fragment; restore the landing URL to prove
    // the landing fires on settle and reads the hash then.
    window.history.replaceState(null, "", "/admin/acme-co/payouts#ledger");
    rerender(<Page landingReady />);
    expect(scrolledOn(ledger)).toBe(1);
    expect(scroll).toHaveBeenLastCalledWith({ block: "start", behavior: "auto" });
    // Once only: a refetch that flips the gate again does not re-land.
    rerender(<Page landingReady={false} />);
    rerender(<Page landingReady />);
    expect(scrolledOn(ledger)).toBe(1);
  });

  it("a hand-typed malformed fragment is ignored, not thrown", () => {
    window.history.replaceState(null, "", "/admin/acme-co/payouts#%");
    expect(() => render(<Page />, { wrapper })).not.toThrow();
    expect(document.getElementById("balance")!.scrollIntoView).not.toHaveBeenCalled();
  });
});
