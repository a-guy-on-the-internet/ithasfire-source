"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChipGroup } from "@th/ui";
import { trpc } from "@/trpc";
import { FG, FG_MUTED } from "./checkout-tokens";

// KEEP IN SYNC WITH packages/core/src/lib/event-human-roles.ts
const PERFORMER_ROLES = ["PERFORMER", "DJ", "SPEAKER", "INSTRUCTOR"];

/**
 * Fisher-Yates shuffle over a copy of `ids`. Used to randomize the attribution
 * option order per buyer (FR-011) so the headliner isn't always listed first,
 * which systematically deflates opener attributions (position bias).
 */
export function shuffleIds(ids: readonly string[]): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export type ArtistAttributionPickerProps = {
  eventId: string;
  value: string;
  onChange: (value: string) => void;
};

export function ArtistAttributionPicker({
  eventId,
  value,
  onChange,
}: ArtistAttributionPickerProps) {
  const { data: performers } = trpc.eventHumans.listPublic.useQuery(
    { eventId },
    { enabled: !!eventId },
  );

  // HYDRATION-SAFE: the server (and the first client render) sees `order === null`
  // and renders the server's `sortOrder: asc` order, so SSR and first-client
  // markup match exactly. The shuffle is applied only after mount, in an effect,
  // then a re-render reorders the chips. Randomizes display order ONLY — the
  // stored lineup order is untouched.
  const [order, setOrder] = useState<string[] | null>(null);

  // Latch the shuffle to run exactly ONCE (when the lineup first loads). Without
  // this, a background refetch (e.g. window refocus) yields a new `performers`
  // reference and would re-shuffle the chips under the buyer mid-checkout.
  const hasShuffled = useRef(false);
  useEffect(() => {
    if (hasShuffled.current || !performers) return;
    hasShuffled.current = true;
    const ids = performers
      .filter((p) => PERFORMER_ROLES.includes(p.role))
      .map((p) => p.id);
    setOrder(shuffleIds(ids));
  }, [performers]);

  const options = useMemo(() => {
    if (!performers) return null;
    const filtered = performers.filter((p) => PERFORMER_ROLES.includes(p.role));
    if (filtered.length < 2) return null;

    let artists = filtered;
    if (order) {
      const rank = new Map(order.map((id, index) => [id, index] as const));
      artists = [...filtered].sort(
        (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
      );
    }

    return [
      ...artists.map((p) => ({ key: p.id, label: p.name })),
      { key: "ALL_OF_THEM", label: "All of them" },
      { key: "JUST_EXPLORING", label: "Just exploring" },
    ];
  }, [performers, order]);

  if (!options) return null;

  return (
    <div style={{ padding: "16px 0" }}>
      <p
        style={{
          color: FG,
          fontWeight: 600,
          marginBottom: 4,
          fontSize: 14,
          margin: "0 0 4px",
        }}
      >
        Who are you most excited to see?
      </p>
      <p
        style={{
          color: FG_MUTED,
          fontSize: 12,
          marginBottom: 12,
          margin: "4px 0 12px",
        }}
      >
        Optional – helps artists connect with their fans
      </p>
      <ChipGroup
        options={options}
        value={value}
        onChange={onChange}
        testIdBase="attribution-artist"
      />
    </div>
  );
}
