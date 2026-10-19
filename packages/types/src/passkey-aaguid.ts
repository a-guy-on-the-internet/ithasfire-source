/**
 * AAGUID -> human-recognisable authenticator label.
 *
 * Every WebAuthn credential carries an AAGUID identifying the authenticator
 * MODEL, and Better Auth already persists it (`Passkey.aaguid`, written from
 * SimpleWebAuthn's `registrationInfo` in
 * `@better-auth/passkey/dist/index.mjs:331,363`). It is the only signal that
 * distinguishes iCloud Keychain from 1Password from a YubiKey. The browser
 * sniffing in `apps/web/src/lib/auth/device-label.ts` cannot: it names the
 * BROWSER's host OS, so three credentials from three different providers
 * enrolled on one laptop all come out "macOS".
 *
 * Deliberately NOT re-exported from `@th/types`'s barrel (`src/index.ts`).
 * The lookup table is ~29 KB of source and is needed by exactly one client
 * component; a barrel re-export puts it on the dependency graph of every page
 * that touches `@th/types` and makes it a bundler tree-shaking question rather
 * than a settled one. Import the subpath instead:
 *
 *   import { passkeyAaguidLabel } from "@th/types/passkey-aaguid";
 *
 * Like `./passkey-name`, this module is ENVIRONMENT-PURE: no `navigator`, no
 * `window`, no `Date`. It is a pure string -> string|null function over frozen
 * data, so it runs identically under node, jsdom, and Hermes.
 */

import { PASSKEY_AAGUID_NAMES } from "./passkey-aaguid-data";

export { PASSKEY_AAGUID_NAMES };

/**
 * The all-zero AAGUID, which means "this authenticator declines to identify
 * its model" and must be treated as ABSENT, never looked up and never shown.
 *
 * This is the COMMON path, not an edge case. Reporting a real AAGUID lets a
 * relying party fingerprint which authenticator you use, so privacy-conscious
 * platform authenticators zero it: Chrome on Android historically returned all
 * zeroes for local credentials, and Windows Hello does when the caller has not
 * asked for (and been granted) enterprise attestation. A caller that skipped
 * this check would happily look up 32 zeroes, miss, and — if the table ever
 * grew a zero key by accident — label an unknown authenticator with whatever
 * that row said.
 */
export const ABSENT_AAGUID = "00000000-0000-0000-0000-000000000000";

/** Canonical dashed form: 8-4-4-4-12 lowercase hex. */
const CANONICAL_AAGUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 32 hex digits, no separators — the form a raw CBOR/base64 decode yields. */
const BARE_HEX_AAGUID = /^[0-9a-f]{32}$/;

/**
 * Canonicalise an AAGUID, or return null if it is not one.
 *
 * Accepts the three spellings that actually reach us and rejects everything
 * else. This is client-supplied input reaching a table lookup, so it is an
 * allowlist of SHAPES rather than a tidy-up:
 * - the dashed UUID Better Auth stores, in either case;
 * - the same wrapped in braces, which is how Windows' registry and some
 *   enterprise tooling spell a GUID;
 * - 32 bare hex digits, which is what you get from decoding the authenticator
 *   data field directly without re-inserting the dashes.
 *
 * Note this canonicalises the all-zero AAGUID rather than rejecting it — a
 * normaliser that returned null for a well-formed value would be a trap for
 * the next caller. Absence is {@link ABSENT_AAGUID}'s job and is applied in
 * {@link passkeyAaguidLabel}.
 */
export function normalizeAaguid(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim().toLowerCase();
  // Strip a single surrounding brace pair (the registry `{...}` GUID form).
  const unwrapped =
    trimmed.startsWith("{") && trimmed.endsWith("}")
      ? trimmed.slice(1, -1).trim()
      : trimmed;

  if (CANONICAL_AAGUID.test(unwrapped)) return unwrapped;

  if (BARE_HEX_AAGUID.test(unwrapped)) {
    return [
      unwrapped.slice(0, 8),
      unwrapped.slice(8, 12),
      unwrapped.slice(12, 16),
      unwrapped.slice(16, 20),
      unwrapped.slice(20),
    ].join("-");
  }

  return null;
}

/** True for the all-zero AAGUID in any accepted spelling. */
export function isAbsentAaguid(raw: string | null | undefined): boolean {
  return normalizeAaguid(raw) === ABSENT_AAGUID;
}

/**
 * Product label for an AAGUID, or null when there isn't one.
 *
 * Null — never a guess, never a placeholder — for a malformed value, the
 * all-zero AAGUID, and any model not in the table. Callers fall back down the
 * ladder (browser-derived label, then nothing) and `derivePasskeyName` degrades
 * to `"Tom's passkey"` / `"Passkey"`. Inventing a label here would bake a lie
 * into a stored credential name.
 */
export function passkeyAaguidLabel(
  raw: string | null | undefined,
): string | null {
  const aaguid = normalizeAaguid(raw);
  if (!aaguid || aaguid === ABSENT_AAGUID) return null;

  // `Object.prototype.hasOwnProperty.call`, not `in` and not a bare index
  // read: the key is attacker-influenceable, and a plain object literal
  // inherits `constructor`, `toString`, `valueOf` and friends. A credential
  // claiming AAGUID "tostring" would otherwise resolve to a Function and be
  // stringified into the passkey name. (The shape allowlist above already
  // blocks that spelling; this is the second lock, not the first.)
  if (!Object.prototype.hasOwnProperty.call(PASSKEY_AAGUID_NAMES, aaguid)) {
    return null;
  }

  const name = PASSKEY_AAGUID_NAMES[aaguid];
  if (typeof name !== "string") return null;

  const trimmed = name.trim();
  return trimmed || null;
}
