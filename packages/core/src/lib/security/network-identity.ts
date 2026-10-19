import { createHmac, hkdfSync } from "node:crypto";
import { isIP } from "node:net";

import { canonicalEmail } from "../event-edit-rights";

/**
 * Keyed hashes for "a ban that sticks" (2026-09-29).
 *
 * WHY HASHES. The owner's constraints: no consent popup, GDPR-sound, secure.
 * So no raw IP address or email is ever written to the database. What is
 * stored is an HMAC-SHA256 under a key only the server holds; a leaked table
 * cannot be reversed, and a guessed address cannot be confirmed against it
 * without the key.
 *
 * KEYS. Each purpose gets its own key, derived from the shared server secret
 * (BETTER_AUTH_SECRET) with HKDF-SHA256 and a distinct `info` label — the same
 * construction as `lib/delegate-invite-token.ts` and
 * `lib/location/obfuscation-key.ts`. A network hash can therefore never be
 * confused with, or replayed as, an email hash or any other HMAC made from the
 * same root secret (domain separation).
 *
 * ROTATION. Changing the root secret changes every hash: existing sightings
 * stop matching new ones and banned emails stop matching. Sightings age out in
 * 30 days; EMAIL bans would need re-recording (re-ban the human) after a
 * rotation.
 */

/** HKDF `info` for sighting / network hashes. Bump the version to rotate. */
export const NETWORK_SIGHTING_KEY_LABEL = "ithasfire.network-sighting.v1";
/** HKDF `info` for banned-email hashes. Bump the version to rotate. */
export const BANNED_EMAIL_KEY_LABEL = "ithasfire.banned-email.v1";
/**
 * HKDF `info` for the IP hash stored with an anonymous edit suggestion. Its
 * OWN key, so a suggestion's hash can never be joined to an account's sign-in
 * sightings. Bump the version to rotate.
 */
export const EDIT_SUGGESTION_IP_KEY_LABEL = "ithasfire.edit-suggestion-ip.v1";

/** Shortest root secret accepted (matches BETTER_AUTH_SECRET's prod floor). */
export const NETWORK_IDENTITY_SECRET_MIN_LENGTH = 32;

/** How long sightings are kept, and how long a NETWORK ban lasts. */
export const NETWORK_SIGHTING_RETENTION_DAYS = 30;
export const NETWORK_SIGHTING_RETENTION_MS =
  NETWORK_SIGHTING_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function isUsableNetworkIdentitySecret(
  secret: string | null | undefined,
): secret is string {
  return (
    typeof secret === "string" &&
    secret.length >= NETWORK_IDENTITY_SECRET_MIN_LENGTH
  );
}

function deriveKey(secret: string, label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), label, 32));
}

function hmacHex(key: Buffer, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

// ── IP normalisation ───────────────────────────────────────────────────────

export type NormalizedIp =
  | { family: 4; address: string; network: string }
  | { family: 6; address: string; network: string };

/** Expand an IPv6 address to 8 lower-case, zero-padded hextets. */
function expandIpv6(address: string): string[] | null {
  let text = address.toLowerCase();
  // An embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) → two hextets.
  const v4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4Tail?.[1]) {
    const octets = v4Tail[1].split(".").map(Number);
    if (octets.some((o) => o > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, -v4Tail[1].length)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0"));
}

/**
 * Canonical form of a client IP plus its network prefix, or null when the
 * value is not an IP address (a forged header, an empty string).
 *
 *  - IPv4 → the dotted quad; network = the /24 (`a.b.c.0/24`).
 *  - IPv6 → fully expanded lower-case hextets (a zone id is dropped);
 *    network = the /48 (first three hextets).
 *  - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is treated as the IPv4 address, so
 *    a dual-stack proxy cannot split one client into two identities.
 */
export function normalizeClientIp(
  raw: string | null | undefined,
): NormalizedIp | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (value.length === 0 || value.length > 64) return null;
  // [v6]:port / v6%zone
  if (value.startsWith("[") && value.includes("]")) {
    value = value.slice(1, value.indexOf("]"));
  }
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);

  const family = isIP(value);
  if (family === 4) {
    const octets = value.split(".").map((o) => String(Number(o)));
    return {
      family: 4,
      address: octets.join("."),
      network: `${octets.slice(0, 3).join(".")}.0/24`,
    };
  }
  if (family === 6) {
    const groups = expandIpv6(value);
    if (!groups) return null;
    // IPv4-mapped (::ffff:0:0/96) → the IPv4 address.
    if (groups.slice(0, 5).every((g) => g === "0000") && groups[5] === "ffff") {
      const hi = parseInt(groups[6]!, 16);
      const lo = parseInt(groups[7]!, 16);
      return normalizeClientIp(
        `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`,
      );
    }
    return {
      family: 6,
      address: groups.join(":"),
      network: `${groups.slice(0, 3).join(":")}::/48`,
    };
  }
  return null;
}

// ── Hashers ────────────────────────────────────────────────────────────────

export type NetworkHashes = { ipHash: string; networkHash: string };

export type NetworkIdentityHasher = {
  /** Null when `rawIp` is not an IP address. */
  hashIp(rawIp: string | null | undefined): NetworkHashes | null;
  /** Null when `email` is empty. Canonicalised as mail is delivered. */
  hashEmail(email: string | null | undefined): string | null;
  /**
   * Null when `rawIp` is not an IP. The full normalised IP under the
   * edit-suggestion key (see {@link EDIT_SUGGESTION_IP_KEY_LABEL}).
   */
  hashSuggestionIp(rawIp: string | null | undefined): string | null;
};

/**
 * Build the hashers for a root secret. The IP and network hashes share a key
 * (a NETWORK ban row copies a sighting's `networkHash` verbatim) but carry
 * distinct message prefixes, so an address's hash never equals a prefix's.
 * Emails get their own derived key.
 */
export function createNetworkIdentityHasher(
  secret: string,
): NetworkIdentityHasher {
  const networkKey = deriveKey(secret, NETWORK_SIGHTING_KEY_LABEL);
  const emailKey = deriveKey(secret, BANNED_EMAIL_KEY_LABEL);
  const suggestionIpKey = deriveKey(secret, EDIT_SUGGESTION_IP_KEY_LABEL);
  return {
    hashIp(rawIp) {
      const ip = normalizeClientIp(rawIp);
      if (!ip) return null;
      return {
        ipHash: hmacHex(networkKey, `ip\u001f${ip.address}`),
        networkHash: hmacHex(networkKey, `net\u001f${ip.network}`),
      };
    },
    hashEmail(email) {
      const canonical = canonicalEmail(email);
      if (!canonical) return null;
      return hmacHex(emailKey, `email\u001f${canonical}`);
    },
    hashSuggestionIp(rawIp) {
      const ip = normalizeClientIp(rawIp);
      if (!ip) return null;
      return hmacHex(suggestionIpKey, `ip\u001f${ip.address}`);
    },
  };
}

// ── Coarse request metadata ────────────────────────────────────────────────

/**
 * Cloudflare's `cf-ipcountry`: an ISO-3166 alpha-2 code, or `XX` (unknown) /
 * `T1` (Tor). Anything else is dropped — the header is client-writable on the
 * direct-to-origin path.
 */
export function normalizeCountryCode(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]$/.test(value) ? value : null;
}

const BROWSER_FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [
    /\bbot\b|crawler|spider|curl\/|wget\/|python-requests|httpclient|okhttp/i,
    "Bot or script",
  ],
  [/Edg(?:e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
  [/Expo|okhttp|CFNetwork|Dalvik/, "App"],
];

const OS_FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [/iPhone|iPad|iPod|iOS/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

/**
 * A coarse "Browser on OS" label — deliberately NOT a fingerprint: no
 * versions, no device model, no build strings. Null when there is no UA;
 * "Other" when nothing matches.
 */
export function userAgentFamily(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const ua = raw.slice(0, 512);
  const browser = BROWSER_FAMILIES.find(([re]) => re.test(ua))?.[1] ?? null;
  const os = OS_FAMILIES.find(([re]) => re.test(ua))?.[1] ?? null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Other";
}
