import { act, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fallbackCatalog from "@th/locale/messages/en.json" with { type: "json" };

import { renderWithProvider } from "../../../../../test/utils";
import { TranslationProvider, type Messages } from "../../../../locale";
import {
  EventCard,
  TicketTierRevealProvider,
  type EventCardTier,
  type EventCardTiersResult,
  type EventSummary,
  type UseEventCardTiers,
} from "../event-grid";
import { LEDGER_MOTION_MS } from "../event-grid/EventCardPriceReveal";

const baseEvent: EventSummary = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Sample Event",
  date: "2025-12-31",
  venue: "Harbor Hall",
  priceLabel: "$45",
  media: {
    url: "https://static.ithasfire.test/sample.jpg",
    alt: "Sample Event image",
    aspectRatio: 16 / 9,
  },
};

const tier = (over: Partial<EventCardTier>): EventCardTier => ({
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  name: "General Admission",
  buyerTotalCents: 4500,
  faceCents: 4500,
  soldOut: false,
  ...over,
});

/**
 * A mock of the app-injected tiers hook. Simulates lazy fetch: it only "returns
 * data" once `enabled` is true, and records every `enabled` it is called with so
 * a test can prove the query never fires on grid render.
 */
function makeSource(tiers: EventCardTier[] | undefined): {
  hook: UseEventCardTiers;
  enabledCalls: boolean[];
} {
  const enabledCalls: boolean[] = [];
  const hook: UseEventCardTiers = (_eventId, enabled) => {
    enabledCalls.push(enabled);
    const result: EventCardTiersResult = enabled
      ? { tiers, isPending: false, isError: false }
      : { tiers: undefined, isPending: false, isError: false };
    return result;
  };
  return { hook, enabledCalls };
}

/**
 * A tiers hook that behaves like react-query with a WARM CACHE: `enabled:
 * false` stops the fetch, not the data, so cached tiers come back before any
 * intent. `makeSource` above returns `undefined` while disabled, which is
 * exactly what hid a ledger mounting on grid render.
 *
 * The tiers can also be swapped mid-test (`setTiers`) to stand in for a
 * refetch; the store notifies the hook so the card re-renders as it would.
 */
function makeCachedSource(initial: EventCardTier[] | undefined): {
  hook: UseEventCardTiers;
  enabledCalls: boolean[];
  setTiers: (next: EventCardTier[] | undefined) => void;
} {
  const enabledCalls: boolean[] = [];
  let current = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const hook: UseEventCardTiers = (_eventId, enabled) => {
    enabledCalls.push(enabled);
    const tiers = useSyncExternalStore(subscribe, () => current);
    return { tiers, isPending: false, isError: false };
  };
  const setTiers = (next: EventCardTier[] | undefined) => {
    act(() => {
      current = next;
      listeners.forEach((listener) => listener());
    });
  };
  return { hook, enabledCalls, setTiers };
}

/**
 * The package catalog plus the one key the reveal adds. `eventCard.moreTiers`
 * lives in the WEB app's catalog (`apps/web/src/i18n/messages/{en,es}.ts`,
 * deep-merged over the package JSON by the app's locale provider), so the
 * package fallback alone does not have it — this stands in for that merge.
 * Spanish on purpose: a hard-coded English literal cannot pass against it.
 */
const testMessages = {
  ...(fallbackCatalog as unknown as Messages),
  eventCard: {
    ...((fallbackCatalog as unknown as { eventCard: Messages }).eventCard ??
      {}),
    moreTiers: "+{count} más",
  },
} as Messages;

/**
 * Renders the DEFAULT card, which is the poster: `variant` is unset, so
 * `isFeature` is true, the art carries a `FeatureScrim`, and the reveal is the
 * LEDGER. Most of the suite below runs through this path.
 */
const renderCard = (hook: UseEventCardTiers, event: EventSummary = baseEvent) =>
  renderWithProvider(
    <TranslationProvider locale="en" messages={testMessages}>
      <TicketTierRevealProvider useEventCardTiers={hook}>
        <EventCard event={event} testIdBase="spec-card" onPress={() => {}} />
      </TicketTierRevealProvider>
    </TranslationProvider>,
  );

/**
 * The TICKET variant — no scrim, so no ledger. It keeps the original
 * absolutely-positioned drawer, and the shared hover/focus/Escape/latch
 * behaviour has to hold there identically.
 */
const renderTicketCard = (
  hook: UseEventCardTiers,
  event: EventSummary = baseEvent,
) =>
  renderWithProvider(
    <TranslationProvider locale="en" messages={testMessages}>
      <TicketTierRevealProvider useEventCardTiers={hook}>
        <EventCard
          event={event}
          variant="ticket"
          testIdBase="spec-card"
          onPress={() => {}}
        />
      </TicketTierRevealProvider>
    </TranslationProvider>,
  );

const getCard = () => screen.getByTestId("spec-card") as HTMLElement;

/** The reveal's node, open OR closed — i.e. "is anything mounted at all". */
const queryRevealNode = () => screen.queryByTestId("spec-card-tier-reveal");

/**
 * The reveal, ONLY while it is open — `null` otherwise.
 *
 * The panel (ticket) still mounts on open and unmounts on close, so for it this
 * is plain presence. The LEDGER (poster) stays mounted once it has data and
 * opens and closes by state, so that it can animate both ways; for it "open"
 * means `data-state="open"` AND not `aria-hidden`. Every assertion below that
 * used to mean "the panel is showing" keeps meaning exactly that — a closed
 * ledger that is still in the DOM does NOT count as showing, and the closed
 * state's own guarantees are pinned separately ("a CLOSED ledger is
 * genuinely closed").
 */
const queryPanel = () => {
  const node = queryRevealNode();
  if (!node) return null;
  if (!node.classList.contains("evt-tier-ledger")) return node;
  const open =
    node.getAttribute("data-state") === "open" &&
    node.getAttribute("aria-hidden") !== "true";
  return open ? node : null;
};
const queryTitle = () => screen.queryByTestId("spec-card-title");
const twoTiers = (): EventCardTier[] => [
  tier({ id: "t1" }),
  tier({ id: "t2", name: "VIP", buyerTotalCents: 9000, faceCents: 9000 }),
];

/**
 * Flush React's passive effects.
 *
 * `doOpen` fires from a raw `setTimeout` outside `act()`, so the render is
 * scheduled concurrently: `waitFor` resolves the moment the reveal is in the
 * DOM, but the effect that attaches the DOCUMENT-level Escape listener is
 * passive and may not have run yet. An Escape dispatched in that window is
 * simply lost — which made the Escape spec flake (observed: 1 failure in 6
 * runs) on the exact behaviour that has broken here before. Not a product
 * defect; in a browser that window is under a frame. But a gate that fails
 * one run in six is not a gate.
 */
const flushEffects = async () => {
  await act(async () => {});
};

const enterCard = () => {
  const card = getCard();
  act(() => {
    card.dispatchEvent(new MouseEvent("mouseenter"));
  });
};

const leaveCard = () => {
  const card = getCard();
  act(() => {
    card.dispatchEvent(new MouseEvent("mouseleave"));
  });
};

describe("EventCardPriceReveal", () => {
  beforeEach(() => {
    // The panel is a pointer-fine / hover enhancement. The shared jsdom
    // matchMedia mock returns `matches: false`; force it true here so the
    // hover/focus path runs.
    window.matchMedia = ((query: string) => ({
      matches: /hover|pointer/.test(query),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fetch or render the panel on grid render (lazy)", () => {
    const { hook, enabledCalls } = makeSource([
      tier({ id: "t1" }),
      tier({ id: "t2", name: "VIP", buyerTotalCents: 9000, faceCents: 9000 }),
    ]);
    renderCard(hook);

    // Every render before intent must have asked with enabled=false — the query
    // is never enabled on mount, so nothing fetches.
    expect(enabledCalls.length).toBeGreaterThan(0);
    expect(enabledCalls.some((enabled) => enabled === true)).toBe(false);
    // Not merely closed — not mounted. No data has been asked for, so there is
    // nothing to print and no node for a closed ledger to be.
    expect(queryRevealNode()).toBeNull();
  });

  it("reveals the panel on hover-intent after the delay", async () => {
    const { hook } = makeSource([
      tier({ id: "t1" }),
      tier({ id: "t2", name: "VIP", buyerTotalCents: 9000, faceCents: 9000 }),
    ]);
    renderCard(hook);

    expect(queryPanel()).toBeNull();
    enterCard();
    // Nothing yet — hover-intent delay hasn't elapsed.
    expect(queryPanel()).toBeNull();

    await waitFor(() => expect(queryPanel()).not.toBeNull());
    expect(screen.getByText("General Admission")).toBeTruthy();
    expect(screen.getByText("VIP")).toBeTruthy();
  });

  it("opens on real keyboard focus of the card (no pointer required)", async () => {
    const { hook } = makeSource([
      tier({ id: "t1" }),
      tier({ id: "t2", name: "VIP", buyerTotalCents: 9000, faceCents: 9000 }),
    ]);
    renderCard(hook);

    // A REAL focus of the focusable root (as a Tab would produce) — not a
    // synthetic focusin — must open the panel. The card is the pointer-fine
    // gate's blind spot: a keyboard user is not a pointer.
    const card = getCard();
    expect(card.getAttribute("tabindex")).toBe("0");
    act(() => {
      card.focus();
    });
    expect(document.activeElement).toBe(card);
    await waitFor(() => expect(queryPanel()).not.toBeNull());
  });

  it("closes when focus leaves the card (Tab away)", async () => {
    const { hook } = makeSource([
      tier({ id: "t1" }),
      tier({ id: "t2", name: "VIP", buyerTotalCents: 9000, faceCents: 9000 }),
    ]);
    renderCard(hook);

    const card = getCard();
    act(() => {
      card.focus();
    });
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    act(() => {
      card.blur();
    });
    await waitFor(() => expect(queryPanel()).toBeNull());
  });

  it("caps at 4 tiers and shows a +N MORE line for a 12-tier event", async () => {
    const tiers = Array.from({ length: 12 }, (_v, i) =>
      tier({
        id: `t${i}`,
        name: `Tier ${i}`,
        buyerTotalCents: 1000 + i * 100,
        faceCents: 1000 + i * 100,
      }),
    );
    const { hook } = makeSource(tiers);
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());

    expect(screen.getByText("Tier 0")).toBeTruthy();
    expect(screen.getByText("Tier 3")).toBeTruthy();
    expect(screen.queryByText("Tier 4")).toBeNull();
    // Through the translator, with the count as an ICU argument — the test
    // catalog is Spanish, so the old English literal cannot satisfy this.
    expect(screen.getByText("+8 más")).toBeTruthy();
    expect(screen.queryByText(/more/i)).toBeNull();
  });

  it("renders a sold-out tier struck through", async () => {
    const { hook } = makeSource([
      tier({ id: "t1" }),
      tier({
        id: "t2",
        name: "VIP",
        buyerTotalCents: 9000,
        faceCents: 9000,
        soldOut: true,
      }),
    ]);
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());

    const soldOutName = screen.getByText("VIP");
    expect(soldOutName).toHaveStyle({ textDecorationLine: "line-through" });
  });

  it("keeps an out-of-window tier VISIBLE and un-struck (dimmed ≠ gone)", async () => {
    // FR-010. The badge stopped quoting this tier when `summarizePricing`
    // gained the window filter; the panel must agree without deleting the row,
    // and must NOT strike it through — struck text reads as "gone", which is
    // the wrong tense for a tier that opens on Friday.
    const { hook } = makeSource([
      tier({ id: "t1" }),
      tier({
        id: "t2",
        name: "Late release",
        buyerTotalCents: 3000,
        faceCents: 3000,
        onSale: false,
      }),
    ]);
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());

    const name = screen.getByText("Late release");
    expect(name).toBeTruthy();
    expect(name).not.toHaveStyle({ textDecorationLine: "line-through" });
  });

  it("reveals for a single tier that is outside its sales window", async () => {
    // The badge quotes no price at all in this case, so the panel is the only
    // place the buyer learns the tier exists.
    const { hook } = makeSource([
      tier({ id: "t1", name: "Late release", onSale: false }),
    ]);
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    expect(screen.getByText("Late release")).toBeTruthy();
  });

  it("renders face value (not a fabricated total) when buyerTotalCents is null", async () => {
    const { hook } = makeSource([
      tier({ id: "t1", buyerTotalCents: null, faceCents: 4500 }),
      tier({
        id: "t2",
        name: "VIP",
        buyerTotalCents: null,
        faceCents: 9000,
      }),
    ]);
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());

    // Scope to the panel — "$45" also appears on the price badge.
    const panel = within(queryPanel() as HTMLElement);
    expect(panel.getByText("$45")).toBeTruthy();
    expect(panel.getByText("$90")).toBeTruthy();
  });

  it("renders 'Free' for a $0 tier", async () => {
    const { hook } = makeSource([
      tier({ id: "t1", name: "RSVP", buyerTotalCents: 0, faceCents: 0 }),
      tier({ id: "t2", name: "VIP", buyerTotalCents: 9000, faceCents: 9000 }),
    ]);
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    expect(screen.getByText("Free")).toBeTruthy();
  });

  it("does not reveal a panel for a single available tier (nothing to add)", async () => {
    const { hook } = makeSource([tier({ id: "t1", soldOut: false })]);
    renderCard(hook);

    enterCard();
    // Give the intent timer time to fire; the panel still must not appear.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(queryRevealNode()).toBeNull();
  });

  it("does reveal for a single SOLD-OUT tier (decision-relevant scarcity)", async () => {
    const { hook } = makeSource([tier({ id: "t1", soldOut: true })]);
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());
  });

  it("dismisses on Escape from the HOVER path (keydown routes via document)", async () => {
    const { hook } = makeSource([
      tier({ id: "t1" }),
      tier({ id: "t2", name: "VIP", buyerTotalCents: 9000, faceCents: 9000 }),
    ]);
    renderCard(hook);

    // Open via hover — focus stays on <body>, NOT the card. This is the exact
    // path where a card-bound keydown listener never sees the keystroke.
    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    await flushEffects();
    expect(document.activeElement).not.toBe(getCard());

    // Escape is delivered to document.activeElement (body) and bubbles to
    // document — the document-level listener must catch it.
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitFor(() => expect(queryPanel()).toBeNull());
  });

  it("latches the fetch so re-hover never re-enables the query (no refetch)", async () => {
    const { hook, enabledCalls } = makeSource([
      tier({ id: "t1" }),
      tier({ id: "t2", name: "VIP", buyerTotalCents: 9000, faceCents: 9000 }),
    ]);
    renderCard(hook);

    // Open → close → re-open the same card.
    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    leaveCard();
    await waitFor(() => expect(queryPanel()).toBeNull());
    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());

    // The query's `enabled` must go false→true EXACTLY once. A second
    // transition is what makes react-query refetch on re-hover; the latch
    // prevents it, so a re-hover within staleTime serves cache with no request.
    let transitions = 0;
    for (let i = 1; i < enabledCalls.length; i++) {
      if (!enabledCalls[i - 1] && enabledCalls[i]) transitions += 1;
    }
    expect(transitions).toBe(1);
    // And once latched, `enabled` never returns to false.
    const firstTrue = enabledCalls.indexOf(true);
    expect(enabledCalls.slice(firstTrue).every(Boolean)).toBe(true);
  });

  it("stays open when the pointer moves into the panel (hoverable)", async () => {
    const { hook } = makeSource([
      tier({ id: "t1" }),
      tier({ id: "t2", name: "VIP", buyerTotalCents: 9000, faceCents: 9000 }),
    ]);
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());

    // Moving the pointer onto the panel (a descendant of the card) fires no
    // `mouseleave` on the card, so the panel persists.
    const panel = queryPanel() as HTMLElement;
    act(() => {
      panel.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    expect(queryPanel()).not.toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The ledger (poster) vs the panel (ticket)
  // ───────────────────────────────────────────────────────────────────────────

  it("prints the poster's tiers INSIDE the scrim, not as an absolute panel", async () => {
    const { hook } = makeSource(twoTiers());
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());

    const reveal = queryPanel() as HTMLElement;
    // The ledger's marker class — the CSS that deepens the scrim and un-clamps
    // the title keys off it via :has(), so losing it silently kills both.
    expect(reveal.className).toContain("evt-tier-ledger");
    expect(reveal.className).not.toContain("evt-price-panel");
    // In normal flow inside the scrim, which is what makes the scrim grow to
    // take it instead of the rows being painted over the title.
    expect(reveal.closest(".is_EventCardFeatureScrim")).not.toBeNull();
    // And the rows are really in there.
    const rows = within(reveal);
    expect(rows.getByText("General Admission")).toBeTruthy();
    expect(rows.getByText("VIP")).toBeTruthy();
  });

  it("KEEPS THE TITLE while the ledger is open (the regression that matters)", async () => {
    // The drawer this replaced could only fit by blanking the whole scrim —
    // a CSS rule took `.is_EventCardFeatureScrim > *` to `opacity: 0` — so
    // hovering a card made it forget its own name at the moment you were
    // reading it. The title must survive the open state, in the tree and
    // visible.
    const { hook } = makeSource(twoTiers());
    renderCard(hook);

    const titleBefore = queryTitle();
    expect(titleBefore).not.toBeNull();
    expect(titleBefore).toHaveTextContent("Sample Event");

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());

    const title = queryTitle() as HTMLElement;
    expect(title).toBeTruthy();
    expect(title).toHaveTextContent("Sample Event");
    // SCOPE: this covers the title being unmounted, emptied, or hidden by an
    // INLINE style. It does NOT cover the actual historical bug, which was a
    // stylesheet `:has()` rule — jsdom does not evaluate `:has()`, and a
    // stylesheet never shows up in `node.style`. That half is guarded by
    // "ships no stylesheet rule that hides the poster's own content" below,
    // and the two are only meaningful together.
    expect(title.style.opacity).not.toBe("0");
    expect(title.style.visibility).not.toBe("hidden");
    expect(title.style.display).toBe("-webkit-box");
  });

  it("ships no stylesheet rule that hides the poster's own content", () => {
    // The bug: `.is_EventCardImageContainer:has(.evt-price-panel)
    // .is_EventCardFeatureScrim > * { opacity: 0 }` — the card blanked its own
    // title to make room for the drawer.
    //
    // Matching that one literal string is not a guard: `… .is_EventCardFeatureScrim *`,
    // `visibility: hidden`, or a rule aimed straight at `.evt-poster-title`
    // would all sail past it. So parse the injected CSS into rules and assert
    // on any rule whose SELECTOR reaches the poster's content, whatever shape
    // it takes.
    //
    // Exempt: `::before` / `::after` on the scrim. The hover deepen layer is a
    // pseudo-element that legitimately rests at `opacity: 0` — it is a layer,
    // not content, and hiding it hides nothing anyone is reading.
    type Rule = { selector: string; body: string };
    const parseRules = (css: string): Rule[] => {
      const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
      const rules: Rule[] = [];
      const walk = (chunk: string) => {
        let i = 0;
        while (i < chunk.length) {
          const open = chunk.indexOf("{", i);
          if (open === -1) return;
          const prelude = chunk.slice(i, open).trim();
          let depth = 1;
          let j = open + 1;
          while (j < chunk.length && depth > 0) {
            if (chunk[j] === "{") depth += 1;
            else if (chunk[j] === "}") depth -= 1;
            j += 1;
          }
          const body = chunk.slice(open + 1, j - 1);
          if (prelude.startsWith("@keyframes")) {
            // Its "selectors" are from/to/percentages — not element rules.
          } else if (prelude.startsWith("@")) {
            walk(body); // @media and friends: the real rules are inside.
          } else {
            rules.push({ selector: prelude, body });
          }
          i = j;
        }
      };
      walk(text);
      return rules;
    };

    const css = Array.from(document.querySelectorAll("style"))
      .map((tag) => tag.innerHTML)
      .join("\n");
    const rules = parseRules(css);
    // The parser has to be looking at the right thing, or "no violations" is
    // vacuous.
    expect(
      rules.some((r) => /is_EventCardFeatureScrim/.test(r.selector)),
      "parsed no rules mentioning the scrim — the parser or the tag id moved",
    ).toBe(true);

    const REACHES_CONTENT =
      /is_EventCardFeatureScrim|evt-poster-title|evt-tier-ledger/;
    const HIDES: Array<[string, RegExp]> = [
      ["opacity: 0", /(^|[;{\s])opacity\s*:\s*0(\s*!important)?\s*(;|$)/],
      ["visibility: hidden", /visibility\s*:\s*hidden/],
      ["display: none", /display\s*:\s*none/],
      // The title has a stylesheet `max-height` now, so a zero one aimed at it
      // would hide it just as surely. Anchored on the LEFT (`[;{\s]`) so the
      // ledger clip's `min-height: 0` — the thing that lets the `0fr` track
      // collapse it — is not read as `height: 0`; the lookahead keeps
      // `0.5em` / `0fr`-style values out. `0px` and `0%` still count.
      ["max-height: 0", /(^|[;{\s])max-height\s*:\s*0(?![.\d])/],
      ["height: 0", /(^|[;{\s])height\s*:\s*0(?![.\d])/],
    ];
    // The ledger's CLOSED state: collapsed to zero height and aria-hidden, so
    // hiding what is INSIDE it hides nothing anyone can read. Exempt only a
    // selector that starts at that anchor and then walks DOWN with descendant
    // or child combinators — which can only ever reach the ledger's own rows.
    // A sibling combinator (`+`, `~`) or a `:has()` could reach back out to
    // the title, so either one voids the exemption.
    const CLOSED_LEDGER_INTERIOR =
      /^\.evt-tier-ledger\[data-state="closed"\](?![^\s>]*:has)[^+~]*$/;

    const findOffenders = (ruleList: Rule[]): string[] => {
      const found: string[] = [];
      for (const rule of ruleList) {
        for (const selector of rule.selector.split(",")) {
          const sel = selector.trim();
          if (!REACHES_CONTENT.test(sel)) continue;
          // The subject is the LAST compound, after ANY combinator — space,
          // `>`, `+` or `~`. Splitting on whitespace and `>` alone made
          // `.x::before~.evt-poster-title` a single "compound" ending in the
          // title, whose `::before` then exempted it as a pseudo-element.
          const subject =
            sel
              .split(/\s*[\s>+~]\s*/)
              .filter(Boolean)
              .pop() ?? "";
          // Subject is a pseudo-element ⇒ a layer, not content.
          if (/::(before|after)/.test(subject)) continue;
          if (CLOSED_LEDGER_INTERIOR.test(sel)) continue;
          for (const [label, pattern] of HIDES) {
            if (pattern.test(rule.body)) found.push(`${sel} { ${label} }`);
          }
        }
      }
      return found;
    };

    // The guard has to bite, or a clean result means nothing. Each of these
    // hides the poster's own content and must be caught — including the two
    // sibling-combinator shapes the old whitespace-and-`>` split exempted, and
    // a closed-anchor rule that escapes the ledger to reach the title.
    const planted = parseRules(`
      .x::before~.evt-poster-title { opacity: 0; }
      .x::before + .evt-poster-title { visibility: hidden; }
      .evt-tier-ledger[data-state="closed"] ~ .evt-poster-title { opacity: 0; }
      .is_EventCardImageContainer:has(.evt-tier-ledger[data-state="closed"]) .evt-poster-title { display: none; }
      .is_EventCardFeatureScrim > * { opacity: 0; }
      .evt-poster-title { max-height: 0 }
      .is_EventCardFeatureScrim .evt-poster-title { max-height: 0px; }
      .evt-poster-title { height: 0; }
    `);
    expect(findOffenders(planted)).toHaveLength(planted.length);
    // ...while the two legitimate shapes stay exempt.
    expect(
      findOffenders(
        parseRules(`
          .is_EventCardFeatureScrim::before { opacity: 0; }
          .evt-tier-ledger[data-state="closed"] .evt-tier-ledger__rows > * { opacity: 0; }
          .evt-tier-ledger { display: grid; grid-template-rows: 0fr; }
          .evt-tier-ledger__clip { min-height: 0; overflow: hidden; }
          .is_EventCardFeatureScrim .evt-poster-title { max-height: 3lh; }
          .evt-tier-ledger[data-state="closed"] .evt-tier-ledger__clip { max-height: 0; }
        `),
      ),
    ).toEqual([]);

    const offenders = findOffenders(rules);
    expect(
      offenders,
      `a stylesheet rule hides the poster's content:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("dims an unavailable ledger row with the INVERTED muted rung", async () => {
    // `$colorMuted` is tuned for the paper canvas and measures 2.06:1 on ink —
    // invisible rather than dim. Reversed-out rows take the inverted rung.
    const { hook } = makeSource([
      tier({ id: "t1" }),
      tier({
        id: "t2",
        name: "Late release",
        buyerTotalCents: 3000,
        faceCents: 3000,
        onSale: false,
      }),
    ]);
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());

    const dimmed = screen.getByText("Late release");
    const live = screen.getByText("General Admission");
    expect(getComputedStyle(dimmed).color).not.toBe(
      getComputedStyle(live).color,
    );
    expect(dimmed).not.toHaveStyle({ textDecorationLine: "line-through" });
  });

  it("resolves the scrim trio — the poster's ground and both type rungs", async () => {
    // The trio is new theme surface (`$scrim` / `$onScrim` / `$onScrimMuted`),
    // and an unknown Tamagui token does not error — it silently falls through,
    // which on an ink ground means a transparent panel and ink-on-photograph
    // type. So assert the RESOLVED values, not the prop strings.
    const { hook } = makeSource([
      tier({ id: "t1" }),
      tier({ id: "t2", name: "Late release", onSale: false }),
    ]);
    renderCard(hook);

    const ground = document.querySelector(
      ".is_EventCardImageContainer",
    ) as HTMLElement;
    expect(ground.className).toContain("_bg-scrim");

    const title = queryTitle() as HTMLElement;
    // EXACT, like the row assertions below: `toContain("_col-onScrim")` also
    // matches `_col-onScrimMute…`, so it would pass on the muted rung.
    const titleColor = title.className
      .split(/\s+/)
      .find((c) => c.startsWith("_col-"));
    expect(titleColor).toBe("_col-onScrim");

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    const colorClass = (el: HTMLElement) =>
      el.className.split(/\s+/).find((c) => c.startsWith("_col-"));
    const live = colorClass(screen.getByText("General Admission"));
    const dimmed = colorClass(screen.getByText("Late release"));
    // Tamagui shortens long token names in its atomic class names, so the
    // dimmed rung lands as `_col-onScrimMute100` rather than the full key.
    // Match on the prefix, and — the part that actually matters — assert the
    // two rungs are DIFFERENT classes. When a token does not resolve, both
    // fall through to `_col-color` and the distinction silently disappears.
    expect(live).toBe("_col-onScrim");
    expect(dimmed).toMatch(/^_col-onScrimMute/);
    expect(dimmed).not.toBe(live);
  });

  it("clears the corner price block VERTICALLY, and only when there is one", () => {
    // The deviation this pins. The reservation used to be 108px of
    // `paddingRight` on the whole scrim, which cost the title a third of its
    // track; dropping it outright put every title's last line under the block
    // (measured: 15 of 15 boxes overlapping by 80x22px). The scrim's content
    // column stops ABOVE the block instead — one rule, no per-line exceptions.
    const { hook } = makeSource(twoTiers());
    const { unmount } = renderCard(hook);
    const scrim = () =>
      document.querySelector(".is_EventCardFeatureScrim") as HTMLElement;

    // `priceLabel: "$45"` ⇒ a corner block ⇒ the block's height plus a gap.
    expect(screen.queryByTestId("spec-card-price")).not.toBeNull();
    expect(scrim().className).toContain("_paddingBottom-68px");
    // ...and NOT the horizontal reservation, which is what regressed the title.
    expect(scrim().className).not.toContain("_paddingRight-108px");
    unmount();

    // No block ⇒ nothing to clear ⇒ the scrim keeps its own padding.
    renderCard(hook, { ...baseEvent, priceLabel: undefined });
    expect(screen.queryByTestId("spec-card-price")).toBeNull();
    expect(scrim().className).not.toContain("_paddingBottom-68px");
  });

  it("renders the absolute PANEL for the ticket variant (unchanged)", async () => {
    const { hook } = makeSource(twoTiers());
    renderTicketCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());

    const reveal = queryPanel() as HTMLElement;
    expect(reveal.className).toContain("evt-price-panel");
    expect(reveal.className).not.toContain("evt-tier-ledger");
    // No scrim on a ticket, so there is nothing for a ledger to print on.
    expect(document.querySelector(".is_EventCardFeatureScrim")).toBeNull();
    expect(within(reveal).getByText("VIP")).toBeTruthy();
  });

  it("keeps the lazy-fetch latch, focus and Escape on the TICKET variant too", async () => {
    // The two variants share one behaviour block; only the markup forks. Prove
    // the fork did not take the behaviour with it.
    const { hook, enabledCalls } = makeSource(twoTiers());
    renderTicketCard(hook);

    expect(enabledCalls.some((enabled) => enabled === true)).toBe(false);
    expect(queryPanel()).toBeNull();

    const card = getCard();
    act(() => {
      card.focus();
    });
    expect(document.activeElement).toBe(card);
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    await flushEffects();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitFor(() => expect(queryPanel()).toBeNull());

    // Re-open: `enabled` went false→true exactly once across the whole run.
    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    let transitions = 0;
    for (let i = 1; i < enabledCalls.length; i++) {
      if (!enabledCalls[i - 1] && enabledCalls[i]) transitions += 1;
    }
    expect(transitions).toBe(1);
  });

  it("a CLOSED ledger is genuinely closed — hidden, inert, unfocusable", async () => {
    // The ledger now stays mounted after its first open so it can animate
    // shut. That must not leave anything behind that the unmounted ledger did
    // not: it has to be out of the accessibility tree, carry nothing
    // focusable, and not take pointer events.
    const { hook } = makeSource(twoTiers());
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    leaveCard();
    await waitFor(() => expect(queryPanel()).toBeNull());

    const node = queryRevealNode() as HTMLElement;
    expect(node).not.toBeNull();
    expect(node.getAttribute("data-state")).toBe("closed");
    expect(node.getAttribute("aria-hidden")).toBe("true");
    // Inside an aria-hidden subtree, so no row is reachable by role or name.
    expect(screen.queryByText("VIP")?.closest('[aria-hidden="true"]')).toBe(
      node,
    );
    expect(
      node.querySelectorAll(
        "a, button, input, select, textarea, [tabindex], [contenteditable]",
      ),
    ).toHaveLength(0);
    // The stylesheet collapses it and takes it off the pointer; jsdom does not
    // lay out, so pin the rules that do it rather than a measured height.
    const css = Array.from(document.querySelectorAll("style"))
      .map((tag) => tag.innerHTML)
      .join("\n");
    expect(css).toMatch(
      /\.evt-tier-ledger\s*\{[^}]*grid-template-rows:\s*0fr[^}]*pointer-events:\s*none/,
    );
    expect(css).toMatch(
      /\.evt-tier-ledger\[data-state="closed"\] \.evt-tier-ledger__clip\s*\{[^}]*visibility:\s*hidden/,
    );
  });

  it("mounts CLOSED when the tiers land, then opens — so first hover animates from zero", async () => {
    // On the first hover the tiers arrive after `open` is already true. If the
    // ledger mounted straight into `data-state="open"` there would be no
    // collapsed state for the grid track to transition from and it would pop
    // in at full height. Record the state of the node the moment it appears.
    const { hook } = makeSource(twoTiers());
    renderCard(hook);

    const seen: Array<string | null> = [];
    const observer = new MutationObserver(() => {
      const node = queryRevealNode();
      const state = node?.getAttribute("data-state") ?? null;
      if (seen[seen.length - 1] !== state) seen.push(state);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    observer.disconnect();

    expect(seen.filter(Boolean)).toEqual(["closed", "open"]);
  });

  it("holds the title's raised clamp through the collapse, then drops it", async () => {
    // The clamp cannot interpolate; the title's max-height does. Dropping the
    // clamp back to three lines at the START of the collapse would snap a long
    // title short in one frame, so the `--raised` hook outlives the open state
    // by the collapse's duration.
    const { hook } = makeSource(twoTiers());
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    const node = queryRevealNode() as HTMLElement;
    expect(node.className).toContain("evt-tier-ledger--raised");

    leaveCard();
    expect(node.getAttribute("data-state")).toBe("closed");
    expect(node.className).toContain("evt-tier-ledger--raised");
    await waitFor(() =>
      expect(node.className).not.toContain("evt-tier-ledger--raised"),
    );
  });

  it("closes when the pointer leaves the card (persistent until leave)", async () => {
    const { hook } = makeSource([
      tier({ id: "t1" }),
      tier({ id: "t2", name: "VIP", buyerTotalCents: 9000, faceCents: 9000 }),
    ]);
    renderCard(hook);

    enterCard();
    await waitFor(() => expect(queryPanel()).not.toBeNull());
    leaveCard();
    await waitFor(() => expect(queryPanel()).toBeNull());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mount gate and motion timing — on fake timers, so the 120ms intent delay,
// the two-frame arm and the 220ms clamp hold are stepped exactly rather than
// raced with `waitFor`.
// ─────────────────────────────────────────────────────────────────────────────

const HOVER_INTENT_MS = 120;
/** Comfortably past the two `requestAnimationFrame`s (or the 32ms fallback). */
const ARM_MS = 50;

const setMatchMedia = ({ reducedMotion }: { reducedMotion: boolean }) => {
  window.matchMedia = ((query: string) => ({
    matches:
      /hover|pointer/.test(query) ||
      (reducedMotion && /prefers-reduced-motion/.test(query)),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const isRaised = (node: Element) =>
  node.classList.contains("evt-tier-ledger--raised");

/** Hover, wait out the intent delay and the arm: the ledger is fully open. */
const openFully = () => {
  enterCard();
  advance(HOVER_INTENT_MS);
  advance(ARM_MS);
  const node = queryRevealNode() as HTMLElement;
  expect(node.getAttribute("data-state")).toBe("open");
  return node;
};

describe("EventCardPriceReveal — mount gate and motion timing", () => {
  beforeEach(() => {
    setMatchMedia({ reducedMotion: false });
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("mounts NOTHING on grid render even when the query cache already has tiers", () => {
    // react-query with `enabled: false` still returns cached data: the same
    // event twice on a page, or a grid revisited inside the cache window.
    const { hook, enabledCalls } = makeCachedSource(twoTiers());
    renderCard(hook);

    expect(enabledCalls.every((enabled) => enabled === false)).toBe(true);
    expect(queryRevealNode()).toBeNull();
    // Still nothing after a long idle: only intent mounts it.
    advance(1000);
    expect(queryRevealNode()).toBeNull();

    // With intent, the cached tiers print — mounting CLOSED first, so even
    // a cache hit animates from zero rather than popping in.
    enterCard();
    advance(HOVER_INTENT_MS);
    expect(queryRevealNode()?.getAttribute("data-state")).toBe("closed");
    advance(ARM_MS);
    expect(queryRevealNode()?.getAttribute("data-state")).toBe("open");
  });

  it("re-arms after a refetch unmounts the ledger, so the remount animates from 0fr", () => {
    const { hook, setTiers } = makeCachedSource(twoTiers());
    renderCard(hook);
    openFully();

    // A refetch leaves one plain tier: nothing to add, so the ledger goes.
    setTiers([tier({ id: "t1" })]);
    expect(queryRevealNode()).toBeNull();

    // A later refetch brings the second tier back while the card is still
    // hovered. The first commit must be CLOSED — an armed ledger would
    // remount straight into "open" with no track to grow from.
    setTiers(twoTiers());
    expect(queryRevealNode()?.getAttribute("data-state")).toBe("closed");
    advance(ARM_MS);
    expect(queryRevealNode()?.getAttribute("data-state")).toBe("open");
  });

  it("under reduced motion, drops the raised clamp in the SAME commit as the close", () => {
    // Nothing is collapsing, so there is nothing to hold the clamp for.
    setMatchMedia({ reducedMotion: true });
    const { hook } = makeSource(twoTiers());
    renderCard(hook);
    const node = openFully();
    expect(isRaised(node)).toBe(true);

    leaveCard();
    expect(node.getAttribute("data-state")).toBe("closed");
    expect(isRaised(node)).toBe(false);
  });

  it("a mouseleave inside the two-frame arm window never produces data-state=open", () => {
    const { hook } = makeSource(twoTiers());
    renderCard(hook);

    enterCard();
    advance(HOVER_INTENT_MS);
    const node = queryRevealNode() as HTMLElement;
    expect(node.getAttribute("data-state")).toBe("closed");

    // Every value `data-state` ever holds from here on: the old value of each
    // attribute mutation, plus whatever it ends on. `takeRecords` is
    // synchronous, so microtask timing under fake timers cannot drop one.
    const observer = new MutationObserver(() => undefined);
    observer.observe(node, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["data-state"],
    });

    leaveCard();
    // Let both frames of the arm land, and then some.
    advance(ARM_MS * 4);

    const seen = observer
      .takeRecords()
      .map((record) => record.oldValue)
      .concat(queryRevealNode()?.getAttribute("data-state") ?? null);
    observer.disconnect();
    expect(seen).not.toContain("open");
    expect(queryRevealNode()?.getAttribute("data-state")).toBe("closed");
  });

  it("a re-hover mid-collapse keeps the raised clamp past the OLD timer's deadline", () => {
    const { hook } = makeSource(twoTiers());
    renderCard(hook);
    const node = openFully();

    // First collapse starts at t=0; its hold would expire at t=220.
    leaveCard();
    expect(isRaised(node)).toBe(true);
    advance(50);
    expect(isRaised(node)).toBe(true);

    // Re-hover mid-collapse: open again at t=170, before the old deadline.
    enterCard();
    advance(HOVER_INTENT_MS);
    expect(node.getAttribute("data-state")).toBe("open");
    expect(isRaised(node)).toBe(true);

    // And close again straight away — a SECOND collapse, starting at t=170,
    // whose hold runs to t=390. The first collapse's timer must not reach in
    // at t=220 and drop the clamp while this one is still shrinking.
    leaveCard();
    advance(LEDGER_MOTION_MS - 170 + 10); // t=230, past the old deadline
    expect(node.getAttribute("data-state")).toBe("closed");
    expect(isRaised(node)).toBe(true);

    // It does drop once THIS collapse has run its course.
    advance(LEDGER_MOTION_MS); // t=450
    expect(isRaised(node)).toBe(false);
  });

  it("holds the raised clamp for exactly LEDGER_MOTION_MS after a close", () => {
    const { hook } = makeSource(twoTiers());
    renderCard(hook);
    const node = openFully();

    leaveCard();
    advance(LEDGER_MOTION_MS - 1);
    expect(isRaised(node)).toBe(true);
    advance(1);
    expect(isRaised(node)).toBe(false);
  });

  it.each([
    [
      "mid-arm",
      () => {
        enterCard();
        advance(HOVER_INTENT_MS);
      },
    ],
    [
      "mid-settle",
      () => {
        openFully();
        leaveCard();
        advance(50);
      },
    ],
  ])(
    "unmounting %s leaves no pending timer and no React warning",
    (_label, reach) => {
      const errors = vi.spyOn(console, "error");
      const { hook } = makeSource(twoTiers());
      const { unmount } = renderCard(hook);
      reach();
      // The ledger is mounted, with its arm frame or its hold timer pending.
      expect(queryRevealNode()).not.toBeNull();

      unmount();
      // React 19 no longer warns on a set-state after unmount, so the spy
      // alone would be vacuous; a leaked rAF or timeout is what actually
      // proves the effects failed to clean up.
      expect(vi.getTimerCount()).toBe(0);
      advance(1000);
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it("falls back to +N when the catalog has no eventCard.moreTiers (no app provider)", () => {
    // `@th/ui` alone falls back to `packages/locale/messages/en.json`, which
    // lacks the key; the translator then returns the KEY. Never print that.
    const tiers = Array.from({ length: 7 }, (_v, i) =>
      tier({ id: `t${i}`, name: `Tier ${i}` }),
    );
    const { hook } = makeSource(tiers);
    renderWithProvider(
      <TicketTierRevealProvider useEventCardTiers={hook}>
        <EventCard event={baseEvent} testIdBase="spec-card" onPress={() => {}} />
      </TicketTierRevealProvider>,
    );
    enterCard();
    advance(HOVER_INTENT_MS + ARM_MS);

    const reveal = within(queryRevealNode() as HTMLElement);
    expect(reveal.getByText("+3")).toBeTruthy();
    expect(reveal.queryByText(/eventCard\.moreTiers/)).toBeNull();
  });

  it("LEDGER_MOTION_MS agrees with every --motion-base fallback in the injected CSS", () => {
    // The constant restates `--motion-base` (apps/web globals.css), which
    // this package cannot read. The stylesheets carry the same number as
    // their fallback; if one moves without the other, fail here.
    const css = Array.from(document.querySelectorAll("style"))
      .map((tag) => tag.innerHTML)
      .join("\n");
    const fallbacks = Array.from(
      css.matchAll(/var\(--motion-base,\s*(\d+)ms\)/g),
      (match) => Number(match[1]),
    );
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(new Set(fallbacks)).toEqual(new Set([LEDGER_MOTION_MS]));
  });
});
