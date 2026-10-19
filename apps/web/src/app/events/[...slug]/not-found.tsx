"use client";

import NotFound from "../../not-found";
import { HolderEventRecheck } from "./_components/HolderEventRecheck";
import { InviteParamScrubber } from "./_components/InviteParamScrubber";

/**
 * The event route's 404: byte-for-byte the site-wide 404 for everyone, plus
 * one post-paint, uncached re-check that lets a TICKET HOLDER of an event
 * hidden only because its owner is banned see the event (owner ruling,
 * ban-that-sticks 2026-09-29). See `HolderEventRecheck`.
 */
export default function EventNotFound() {
  return (
    <HolderEventRecheck>
      {/* A dead or mistyped invite link: no token left in the URL. */}
      <InviteParamScrubber />
      <NotFound />
    </HolderEventRecheck>
  );
}
