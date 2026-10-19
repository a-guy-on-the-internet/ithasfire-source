import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

/**
 * EventContent — lineup "Listen" chips + inline players
 * (docs/specs/2026-07-21/completed/lineup-listen-embeds.spec.md)
 *
 * Covers the UI acceptance criteria:
 * - chip renders ONLY for entries whose `listenUrl` re-parses client-side to
 *   an iframe embed (EpkEmbed discipline — `parseEmbedUrl` is NOT mocked, the
 *   real parser runs);
 * - LAZY MOUNT: zero player iframes in the DOM pre-expansion;
 * - expanding mounts the real `MediaEmbed` iframe; collapsing hides it (the
 *   iframe stays mounted after first open so a re-expand never reloads it);
 * - desktop auto-expands exactly the FIRST listenable entry; mobile
 *   auto-expands nothing;
 * - `aria-expanded` / `aria-controls` / region labelling wiring.
 *
 * Mock scaffolding mirrors EventContent.test.tsx: Tamagui/`@th/ui` render as
 * plain DOM so no TamaguiProvider is needed in jsdom. `MediaEmbed` and
 * `@th/core/lib/embeds` are deliberately REAL.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith("data-") || key.startsWith("aria-") || key === "role") {
        domProps[key] = value;
      }
    }
    return <div {...domProps}>{children}</div>;
  };
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => ({}),
  };
});

const MESSAGES: Record<string, string> = {
  "eventDetail.lineupSection": "Lineup",
  "eventDetail.listenChip": "Listen",
  "eventDetail.listenChipLabel": "Listen to {name}",
};

const fakeTranslate = (key: string, values?: Record<string, unknown>) => {
  const template = MESSAGES[key] ?? key;
  if (!values) return template;
  return Object.entries(values).reduce(
    (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
    template,
  );
};

vi.mock("@th/ui", () => ({
  Link: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  useTranslations: () => fakeTranslate,
  /**
   * The Date Stub is the hero's no-poster artwork. Stood in as a marker that
   * records what it was FED — the artifact itself is covered against the real
   * design system in `packages/ui/.../__tests__/DateStub.test.tsx`, and a
   * plain-DOM re-render of it here would only prove the mock works.
   */
  DateStub: ({
    title,
    date,
    venueLine,
    layout,
    size,
    testId,
  }: Record<string, unknown>) => (
    <div
      data-testid={testId as string}
      data-stub-size={size as string}
      data-stub-layout={(layout as string) ?? "split"}
      data-stub-date={date ? JSON.stringify(date) : "none"}
      data-stub-title={(title as string) ?? "<unset>"}
      data-stub-venue-line={(venueLine as string) ?? "<unset>"}
    />
  ),
  formatStubDateParts: (
    startsAt: Date | string | number | null | undefined,
    timezone?: string | null,
  ) => {
    if (!startsAt) return null;
    const d = startsAt instanceof Date ? startsAt : new Date(startsAt);
    if (Number.isNaN(d.getTime())) return null;
    const at = (opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", {
        ...opts,
        timeZone: timezone || "UTC",
      }).format(d);
    return {
      weekday: at({ weekday: "short" }).toUpperCase(),
      day: at({ day: "numeric" }),
      month: at({ month: "short" }).toUpperCase(),
    };
  },
  useFormatters: () => ({ dateTime: () => "Sat, Jan 1, 2027" }),
}));

const { dynamicComponentSpy } = vi.hoisted(() => ({
  dynamicComponentSpy: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: () => (props: Record<string, unknown>) => {
    dynamicComponentSpy(props);
    return null;
  },
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: undefined }),
}));

import { EventContent } from "../EventContent";

/**
 * The headliner auto-expand is decided AFTER mount against the real viewport
 * (`window.matchMedia("(min-width: 768px)")`) because the public event page
 * never passes the `mobile` prop — see EventContent. The vitest.setup.ts
 * polyfill hardcodes `matches: false` (narrow), so desktop scenarios stub a
 * wide viewport explicitly.
 */
const stubViewport = (wide: boolean) => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: wide,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
};

beforeEach(() => {
  dynamicComponentSpy.mockClear();
  // Default every test to the narrow viewport; desktop tests opt in.
  stubViewport(false);
});

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Valid 22-char Spotify artist ids → real `parseEmbedUrl` iframe embeds. */
const SPOTIFY_ARTIST_A = "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb";
const SPOTIFY_ARTIST_B = "https://open.spotify.com/artist/1Xyo4u8uXC1ZmMpatF05PJ";
/** Parses to a provider embed but with `renderMode: "link"` — NOT playable inline. */
const BANDCAMP_PAGE = "https://myband.bandcamp.com/album/cool-record";
/** Not a media provider at all. */
const RANDOM_URL = "https://example.com/music";

const human = (
  id: string,
  name: string,
  listenUrl: string | null,
): {
  id: string;
  name: string;
  role: string;
  listenUrl: string | null;
} => ({ id, name, role: "ARTIST", listenUrl });

const playerIframes = () =>
  Array.from(document.querySelectorAll('[data-testid="media-embed"] iframe'));

// ── Tests ───────────────────────────────────────────────────────────────────

describe("EventContent — lineup Listen chip visibility", () => {
  it("renders a chip only for entries whose listenUrl parses to an iframe embed", () => {
    render(
      <EventContent
        title="Test Event"
        mobile
        eventHumans={[
          human("h1", "Iframe Act", SPOTIFY_ARTIST_A),
          human("h2", "No URL Act", null),
          human("h3", "Link-Only Act", BANDCAMP_PAGE),
          human("h4", "Random URL Act", RANDOM_URL),
        ]}
      />,
    );

    const chips = screen.getAllByTestId("lineup-listen-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveAccessibleName("Listen to Iframe Act");
    // Every act still renders as a lineup row, chip or not.
    for (const name of [
      "Iframe Act",
      "No URL Act",
      "Link-Only Act",
      "Random URL Act",
    ]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it("renders no chips when listenUrl is absent from the payload (backend not yet shipped)", () => {
    render(
      <EventContent
        title="Test Event"
        eventHumans={[
          // No `listenUrl` key at all — the field is optional; missing must
          // behave exactly like null.
          { id: "h1", name: "Legacy Act", role: "ARTIST" },
        ]}
      />,
    );

    expect(screen.queryByTestId("lineup-listen-chip")).not.toBeInTheDocument();
    expect(playerIframes()).toHaveLength(0);
  });
});

describe("EventContent — lazy mount (hard requirement)", () => {
  it("mounts ZERO player iframes pre-expansion (mobile: all collapsed)", () => {
    render(
      <EventContent
        title="Test Event"
        mobile
        eventHumans={[
          human("h1", "Act One", SPOTIFY_ARTIST_A),
          human("h2", "Act Two", SPOTIFY_ARTIST_B),
        ]}
      />,
    );

    expect(playerIframes()).toHaveLength(0);
    expect(document.querySelector('[data-testid="media-embed"]')).toBeNull();
    // The (empty) aria-controls target exists but is hidden and playerless.
    for (const panel of screen.getAllByTestId("lineup-listen-panel")) {
      expect(panel).not.toBeVisible();
      expect(panel).toBeEmptyDOMElement();
    }
  });

  it("expands on click (iframe mounts), collapses on second click (hidden, not reloaded)", () => {
    render(
      <EventContent
        title="Test Event"
        mobile
        eventHumans={[human("h1", "Baby Ghost", SPOTIFY_ARTIST_A)]}
      />,
    );

    const chip = screen.getByTestId("lineup-listen-chip");
    const panel = screen.getByTestId("lineup-listen-panel");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(playerIframes()).toHaveLength(0);

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(panel).toBeVisible();
    expect(playerIframes()).toHaveLength(1);
    const iframe = within(panel).getByTitle("Baby Ghost");
    // Provider-derived src — never the pasted URL reflected verbatim.
    expect(iframe).toHaveAttribute(
      "src",
      expect.stringContaining("open.spotify.com/embed/artist/4Z8W4fKeB5YxbusRsdQVPb"),
    );

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(panel).not.toBeVisible();
    // Kept mounted after first open — a re-expand must not reload the iframe.
    expect(playerIframes()).toHaveLength(1);

    fireEvent.click(chip);
    expect(panel).toBeVisible();
    expect(playerIframes()).toHaveLength(1);
  });

  it("supports multiple rows open at once (no accordion coupling)", () => {
    render(
      <EventContent
        title="Test Event"
        mobile
        eventHumans={[
          human("h1", "Act One", SPOTIFY_ARTIST_A),
          human("h2", "Act Two", SPOTIFY_ARTIST_B),
        ]}
      />,
    );

    const [chipA, chipB] = screen.getAllByTestId("lineup-listen-chip");
    fireEvent.click(chipA);
    fireEvent.click(chipB);
    expect(chipA).toHaveAttribute("aria-expanded", "true");
    expect(chipB).toHaveAttribute("aria-expanded", "true");
    expect(playerIframes()).toHaveLength(2);
  });
});

describe("EventContent — headliner auto-expand", () => {
  it("desktop: auto-expands exactly the FIRST listenable entry in lineup order", () => {
    stubViewport(true);
    render(
      <EventContent
        title="Test Event"
        eventHumans={[
          // First row has no listenable URL — auto-expand must SKIP it and
          // pick the first row that actually parses to an iframe embed.
          human("h1", "Opener No Music", null),
          human("h2", "Headliner", SPOTIFY_ARTIST_A),
          human("h3", "Support Act", SPOTIFY_ARTIST_B),
        ]}
      />,
    );

    const chips = screen.getAllByTestId("lineup-listen-chip");
    expect(chips).toHaveLength(2);

    const headlinerChip = screen.getByRole("button", {
      name: "Listen to Headliner",
    });
    const supportChip = screen.getByRole("button", {
      name: "Listen to Support Act",
    });
    expect(headlinerChip).toHaveAttribute("aria-expanded", "true");
    expect(supportChip).toHaveAttribute("aria-expanded", "false");

    // Exactly ONE player iframe on initial render — the headliner's.
    expect(playerIframes()).toHaveLength(1);
    expect(screen.getByTitle("Headliner")).toBeInTheDocument();
  });

  it("narrow viewport WITHOUT the mobile prop: auto-expands nothing (public-page regression)", () => {
    // The public event page never passes `mobile` — the live-QA bug was the
    // headliner auto-expanding on phones because the gate only looked at the
    // prop. Narrow matchMedia (beforeEach default) must keep everything
    // collapsed even with mobile unset.
    render(
      <EventContent
        title="Test Event"
        eventHumans={[
          human("h1", "Headliner", SPOTIFY_ARTIST_A),
          human("h2", "Support Act", SPOTIFY_ARTIST_B),
        ]}
      />,
    );

    for (const chip of screen.getAllByTestId("lineup-listen-chip")) {
      expect(chip).toHaveAttribute("aria-expanded", "false");
    }
    expect(playerIframes()).toHaveLength(0);
  });

  it("mobile prop hard-disables auto-expand even on a wide viewport", () => {
    stubViewport(true);
    render(
      <EventContent
        title="Test Event"
        mobile
        eventHumans={[
          human("h1", "Headliner", SPOTIFY_ARTIST_A),
          human("h2", "Support Act", SPOTIFY_ARTIST_B),
        ]}
      />,
    );

    for (const chip of screen.getAllByTestId("lineup-listen-chip")) {
      expect(chip).toHaveAttribute("aria-expanded", "false");
    }
    expect(playerIframes()).toHaveLength(0);
  });
});

describe("EventContent — listen chip accessibility wiring", () => {
  it("chip is a button with aria-expanded + aria-controls pointing at the act-labelled panel", () => {
    render(
      <EventContent
        title="Test Event"
        mobile
        eventHumans={[human("h1", "Baby Ghost", SPOTIFY_ARTIST_A)]}
      />,
    );

    const chip = screen.getByRole("button", { name: "Listen to Baby Ghost" });
    expect(chip.tagName).toBe("BUTTON");

    const panelId = chip.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    const panel = screen.getByTestId("lineup-listen-panel");
    expect(panel).toHaveAttribute("id", panelId as string);
    // Panel is a region labelled by the act's name.
    expect(panel).toHaveAttribute("role", "region");
    expect(panel).toHaveAttribute("aria-label", "Baby Ghost");

    // Accessible name stays constant across states — aria-expanded carries
    // the open/closed state (label-in-name safe).
    fireEvent.click(chip);
    expect(chip).toHaveAccessibleName("Listen to Baby Ghost");
    expect(chip).toHaveAttribute("aria-expanded", "true");
  });
});
