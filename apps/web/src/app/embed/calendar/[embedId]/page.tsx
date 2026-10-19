"use client";

import { EmbedWidget } from "@/app/embed/[embedId]/_components/EmbedWidget";

// ─────────────────────────────────────────────────────────────────────────────
// Calendar widget route — the SAME in-iframe purchase flow as
// /embed/[embedId], with a month calendar as its browse view. Clicking a
// checkout-eligible event enters the in-iframe detail → checkout screens;
// linkOut embeds and ineligible events open the canonical event page in a
// new tab instead (see embed-calendar-helpers.ts).
//
// The route URL is a live-embed contract (snippets on third-party sites
// reference it) — do not move or rename it. It is now a LEGACY ALIAS: the
// admin page emits /embed/[embedId]?view=calendar instead, but this path
// stays forever and PINS the calendar view, so it never consults the embed's
// stored `defaultView` (FR-003 / D-002 — a pasted URL that named a view keeps
// that view no matter what the organiser later configures).
// ─────────────────────────────────────────────────────────────────────────────

export default function EmbedCalendarPage() {
  return <EmbedWidget routeView="calendar" />;
}
