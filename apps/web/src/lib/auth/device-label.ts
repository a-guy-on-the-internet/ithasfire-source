/**
 * Friendly, human-readable label for the device the browser is running on.
 *
 * Feeds `derivePasskeyName({ deviceLabel })` from `@th/types`, which is
 * deliberately environment-pure and never touches `navigator` itself — the
 * platform sniffing has to live app-side, and it lives here ONCE so the two
 * web enrollment call sites (account settings + sign-up) can't drift apart
 * again.
 *
 * Why not `navigator.platform`? It's deprecated and returns opaque build
 * strings rather than product names: `"MacIntel"` on every Mac (including
 * Apple Silicon), `"Win32"` on 64-bit Windows, `"Linux armv8l"` on Android.
 * Passing those straight into a passkey name made the settings list read like
 * debug output.
 */

/**
 * The one field we read from the User-Agent Client Hints API.
 *
 * `navigator.userAgentData` is Chromium-only and is NOT in TypeScript's default
 * DOM lib, so it's declared narrowly here — one local interface plus one cast
 * at the single read site below — rather than widening the global `Navigator`
 * or reaching for `any`.
 */
interface UserAgentDataLike {
  readonly platform?: string;
}

/**
 * UA / legacy-platform patterns → product label.
 *
 * ORDER MATTERS:
 * - `Android` must precede `Linux`: every Android UA also says "Linux".
 * - `CrOS` must precede `Linux`: ChromeOS UAs say "X11; CrOS ...".
 * - `iPhone`/`iPad` precede the Mac probes so an explicit iOS tell wins.
 */
const PLATFORM_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/iPhone|iPod/i, "iPhone"],
  [/iPad/i, "iPad"],
  [/Android/i, "Android"],
  [/CrOS/i, "ChromeOS"],
  [/Macintosh|Mac OS X|MacIntel/i, "macOS"],
  [/Windows|Win32|Win64|WinCE/i, "Windows"],
  [/Linux|X11/i, "Linux"],
];

/**
 * Client-Hints `platform` → product label.
 *
 * An ALLOWLIST, not a passthrough. The spec fixes the set of values Chromium
 * may report — `"Android"`, `"Chrome OS"`, `"Chromium OS"`, `"iOS"`, `"Linux"`,
 * `"macOS"`, `"Windows"` and the `"Unknown"` sentinel — and every one of them
 * needs a decision here:
 * - The two ChromeOS spellings squash to one label.
 * - `"iOS"` is an OS name, not a product name: passing it through produced
 *   `Tom’s iOS`, where every other branch produces a device (`Tom’s iPhone`).
 * - `"Unknown"` is Chromium's own "I can't tell" sentinel and must fall through
 *   to the UA probe rather than becoming a passkey named "Unknown".
 *
 * Anything NOT in this table also falls through to the UA probe. Letting an
 * unrecognized value out verbatim is how a future spec addition (or a spoofed
 * hint — this is client-controlled input) would end up as the stored credential
 * name; the UA probe is a better guess than a string we've never seen.
 *
 * The whole hint path is Chromium-only, so today it never fires on Apple
 * hardware: iOS/iPadOS browsers are all WebKit and expose no
 * `navigator.userAgentData`. That makes the `"ios"` row unreachable in practice
 * — and it is why it can safely resolve to `iPhone` rather than trying to split
 * iPhone from iPad, which only the UA probe below can do.
 */
const HINTED_PLATFORM_LABELS: Readonly<Record<string, string>> = {
  android: "Android",
  "chrome os": "ChromeOS",
  chromeos: "ChromeOS",
  "chromium os": "ChromeOS",
  ios: "iPhone",
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

function normalizeHintedPlatform(raw: string | undefined): string | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value) return null;
  return HINTED_PLATFORM_LABELS[value] ?? null;
}

/**
 * Best-effort product label for the current device, or `null` when it genuinely
 * cannot be determined.
 *
 * Returning `null` (never a placeholder like `"Device"`) is load-bearing:
 * `derivePasskeyName` degrades correctly on a null label — it falls back to
 * `"Tom’s passkey"` or `"Passkey"` — whereas a fake label would bake the
 * placeholder into the stored credential name.
 *
 * Safe to call on the server, but NOT because of the `navigator` guard: Node
 * >= 21 defines a global `navigator` (`userAgent: "Node.js/22"`, no `platform`,
 * no `userAgentData`), so under a modern server render the guard does not fire
 * at all. The result is still `null` — "Node.js/22" matches no pattern — which
 * is correct, just not for the reason the guard suggests. The guard still earns
 * its keep on older runtimes and in non-DOM test environments.
 */
export function detectDeviceLabel(): string | null {
  if (typeof navigator === "undefined") return null;

  // Single narrow cast for the non-standard Client Hints field. See
  // `UserAgentDataLike` above.
  const nav = navigator as Navigator & {
    userAgentData?: UserAgentDataLike;
  };

  const hinted = normalizeHintedPlatform(nav.userAgentData?.platform);
  if (hinted) return hinted;

  const userAgent = typeof nav.userAgent === "string" ? nav.userAgent : "";
  const legacyPlatform = typeof nav.platform === "string" ? nav.platform : "";
  const haystack = `${userAgent} ${legacyPlatform}`;

  // iPadOS 13+ deliberately reports a desktop-Safari UA ("Macintosh; Intel Mac
  // OS X ..."), so a Mac-looking UA that ALSO reports multi-touch is the only
  // reliable iPad tell — no Mac reports more than one touch point.
  if (
    /Macintosh|MacIntel/i.test(haystack) &&
    (typeof nav.maxTouchPoints === "number" ? nav.maxTouchPoints : 0) > 1
  ) {
    return "iPad";
  }

  for (const [pattern, label] of PLATFORM_PATTERNS) {
    if (pattern.test(haystack)) return label;
  }

  return null;
}
