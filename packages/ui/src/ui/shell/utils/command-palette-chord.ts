/**
 * The command-palette chord, decided in ONE place for every surface that
 * binds it: the web app's Spotlight shortcut (`apps/web` spotlight-store) and
 * the shell's `useCommandPaletteShortcut`.
 *
 * ⌘K on Apple platforms, Ctrl+K everywhere else. On a Mac, Ctrl+K is the OS
 * "kill to end of line" in every text field, so it is left to the OS. The
 * opposite modifier must be up, so ⌃⌘K is nothing on either side, and on
 * Windows the Win key (`metaKey`) does not stand in for Ctrl.
 *
 * Plain DOM, no React / React Native: published as the light `@th/ui/keyboard`
 * subpath so a module that only needs this does not pull in (or trip over a
 * test mock of) the whole `@th/ui` barrel. The e2e helper
 * `apps/web/e2e/helpers/spotlight.ts` mirrors the platform rule in-page; keep
 * the two in step.
 */

/** Minimal shape read here, so callers can pass DOM or React keyboard events. */
export type ChordKeyEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey"
>;

/**
 * Apple platform per the browser. Client-only: call it from an event handler
 * or effect, never during render or on the server (returns false there).
 * `||`, not `??`: a present-but-empty `userAgentData.platform` (it is "" in
 * some embedded / privacy-hardened browsers) must fall back too.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = nav.userAgentData?.platform || nav.platform || "";
  return /mac|iphone|ipad/i.test(platform);
}

/**
 * Is this keydown the platform's command-palette chord (⌘K / Ctrl+K)?
 * `key` is checked at runtime despite its type: Safari's form autofill
 * dispatches a bare `Event("keydown")` with no `key` at all.
 */
export function isCommandPaletteChord(event: ChordKeyEvent): boolean {
  if (event.altKey || typeof event.key !== "string") return false;
  if (event.key.toLowerCase() !== "k") return false;
  return isApplePlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
