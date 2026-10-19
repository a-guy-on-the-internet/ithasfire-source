"use client";

import { motion } from "framer-motion";
import { EventGridCard } from "@th/ui";

import { BORDER, SURFACE, TEXT, TEXT_MUTED } from "./embed-theme";
import { mapEventItemToSummary } from "./embed-helpers";
import type { EventItem } from "./embed-types";

// ─────────────────────────────────────────────────────────────────────────────
// Embed event grid — the widget's browse screen.
//
// Renders the REAL design-system event card (`EventGridCard` — the organism
// `EventGrid` shows on every site surface) composed into the embed's own CSS
// grid. We deliberately do NOT wrap `EventGrid` itself: its "Showing N events"
// count line would duplicate the header below, and its `auto` variant flips to
// a carousel at iframe widths. Each card keeps its framer-motion `layoutId` so
// the card→detail morph (EmbedWidget's matching `embed-card-${id}` panel)
// still works.
//
// Theming: no wrapper. `/embed/*` is locked to the platform's light theme
// (Stub + the active preset — see lib/route-context.ts), so the cards render
// exactly as they do in the platform's own poster grid. Host `--hf-*`
// overrides reach them through the bridge on EmbedWidget's root.
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  orgName: string;
  events: EventItem[];
  onSelectEvent: (event: EventItem) => void;
  /** When true, cards open the event on Ithas Fire in a new tab instead of
   * morphing into the in-iframe detail/checkout panel. */
  linkOut?: boolean;
  buildEventUrl?: (slugOrId: string) => string;
};

export function EmbedEventGrid({
  orgName,
  events,
  onSelectEvent,
  linkOut = false,
  buildEventUrl,
}: Props) {
  const openEvent = (event: EventItem) => {
    if (linkOut && buildEventUrl) {
      window.open(
        buildEventUrl(event.slug ?? event.id),
        "_blank",
        "noopener,noreferrer",
      );
      return;
    }
    onSelectEvent(event);
  };

  return (
    <div style={{ padding: "20px 16px 16px" }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: TEXT, margin: 0 }}>
          {orgName}
        </h2>
        <p style={{ fontSize: 13, color: TEXT_MUTED, margin: "2px 0 0" }}>
          {events.length} upcoming event{events.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Empty state — the header alone over a blank grid box reads as broken,
          so show an on-brand placeholder when there is nothing to list. */}
      {events.length === 0 ? (
        <div
          style={{
            border: `1px solid ${BORDER}`,
            background: SURFACE,
            padding: "40px 20px",
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
          }}
        >
          <p style={{ fontSize: 15, fontWeight: 700, color: TEXT, margin: 0 }}>
            No upcoming events
          </p>
          <p style={{ fontSize: 13, color: TEXT_MUTED, margin: 0 }}>
            Check back soon — new events will appear here.
          </p>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            // Design-system-v2 card-collection template. `min(272px, 100%)`
            // keeps the spec's 272px floor everywhere it fits while letting
            // the track shrink inside iframes narrower than ~304px instead
            // of overflowing the host page sideways.
            gridTemplateColumns:
              "repeat(auto-fill, minmax(min(272px, 100%), 1fr))",
            // EventGrid's own defaults: $5/$4 → 24px row / 16px column.
            gap: "24px 16px",
            // Every row the same height, so every card is the same height —
            // matching `EventGrid`, which sets this for the same reason.
            // Without it a row whose tallest card carries an extra meta line
            // (a gated event) is taller than the row above it.
            gridAutoRows: "1fr",
          }}
        >
          {events.map((event) => (
            <motion.div
              key={event.id}
              layoutId={`embed-card-${event.id}`}
              transition={{
                layout: { type: "spring", bounce: 0.2, duration: 0.5 },
              }}
              // Flex column + the card's flexGrow keeps equal-height cards
              // across a grid row (footer buttons on a shared baseline),
              // mirroring EventGrid's own GRID_CARD_OVERRIDES. No hover/
              // keyboard/role props here: the card brings its own hover
              // lift, role, tabIndex and keyboard handling — duplicating
              // them would double the lift and nest two interactive
              // elements.
              style={{
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
              }}
            >
              <EventGridCard
                event={mapEventItemToSummary(event)}
                size="md"
                showFavorite={false}
                showBadge={false}
                flexGrow={1}
                onPress={() => openEvent(event)}
                // Overrides the card's default `accessibilityLabel={title}`
                // (spread order: rest lands after the default) so link-out
                // cards keep announcing the new-tab behaviour.
                {...(linkOut
                  ? {
                      accessibilityLabel: `${event.title} — opens on Ithas Fire in a new tab`,
                    }
                  : {})}
              />
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
