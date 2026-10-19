import { createHash, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  deriveInviteTokenSecret,
  hashInviteToken,
  INVITE_TOKEN_KEY_LABEL,
  INVITE_TOKEN_LENGTH,
  mintInviteToken,
  parseInviteToken,
  verifyInviteToken,
} from "../invite-token";

const SECRET = "k".repeat(48);
const OTHER_SECRET = "j".repeat(48);
const ID = "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_ID = "1f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";

describe("invite tokens", () => {
  it("round-trips: mint → verify gives the invite id back", () => {
    const token = mintInviteToken(ID, SECRET);
    expect(token).toMatch(/^inv_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
    expect(token).toHaveLength(INVITE_TOKEN_LENGTH);
    expect(verifyInviteToken(token, SECRET)).toEqual({ inviteId: ID });
  });

  it("is re-derivable: the same id and secret always mint the same token", () => {
    expect(mintInviteToken(ID, SECRET)).toBe(mintInviteToken(ID, SECRET));
    expect(mintInviteToken(ID, SECRET)).not.toBe(mintInviteToken(OTHER_ID, SECRET));
  });

  it("rejects a token minted with a different secret", () => {
    const token = mintInviteToken(ID, OTHER_SECRET);
    expect(verifyInviteToken(token, SECRET)).toBeNull();
  });

  it("rejects a tampered MAC", () => {
    const token = mintInviteToken(ID, SECRET);
    const last = token.at(-2) === "A" ? "B" : "A";
    const tampered = `${token.slice(0, -2)}${last}${token.at(-1)}`;
    expect(verifyInviteToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a valid MAC moved onto another invite id", () => {
    const token = mintInviteToken(ID, SECRET);
    const swapped = token.replace(ID, OTHER_ID);
    expect(parseInviteToken(swapped)).toEqual({ inviteId: OTHER_ID });
    expect(verifyInviteToken(swapped, SECRET)).toBeNull();
  });

  it("rejects a non-canonical base64url tail that decodes to the same bytes", () => {
    const token = mintInviteToken(ID, SECRET);
    // The last char carries 2 unused bits; flipping them keeps the bytes.
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const idx = alphabet.indexOf(token.at(-1) as string);
    const sibling = alphabet[idx ^ 1] as string;
    const variant = `${token.slice(0, -1)}${sibling}`;
    expect(variant).not.toBe(token);
    expect(verifyInviteToken(variant, SECRET)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["wrong prefix", mintInviteToken(ID, SECRET).replace("inv_", "inx_")],
    ["uppercase uuid", mintInviteToken(ID, SECRET).replace(ID, ID.toUpperCase())],
    ["too long", `${mintInviteToken(ID, SECRET)}A`],
    ["too short", mintInviteToken(ID, SECRET).slice(0, -1)],
    ["padding", `${mintInviteToken(ID, SECRET).slice(0, -1)}=`],
    ["junk", "inv_not-a-uuid_xxx"],
    ["whitespace", ` ${mintInviteToken(ID, SECRET).slice(1)}`],
  ])("parse and verify return null for a malformed token (%s)", (_, token) => {
    expect(parseInviteToken(token)).toBeNull();
    expect(verifyInviteToken(token, SECRET)).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(parseInviteToken(undefined)).toBeNull();
    expect(parseInviteToken(123)).toBeNull();
    expect(verifyInviteToken({}, SECRET)).toBeNull();
  });

  it("refuses a short secret and a malformed invite id when minting", () => {
    expect(() => mintInviteToken(ID, "short")).toThrow(
      "invite_token_secret_too_short",
    );
    expect(() => verifyInviteToken(mintInviteToken(ID, SECRET), "")).toThrow(
      "invite_token_secret_too_short",
    );
    expect(() => mintInviteToken("nope", SECRET)).toThrow(
      "invite_token_bad_invite_id",
    );
  });

  it("hashInviteToken is the SHA-256 hex of the raw token", () => {
    const token = mintInviteToken(ID, SECRET);
    expect(hashInviteToken(token)).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(hashInviteToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deriveInviteTokenSecret", () => {
  const ROOT = "r".repeat(40);

  it("is HKDF-SHA256(root, no salt, the invite label, 32 bytes) as base64url", () => {
    const expected = Buffer.from(
      hkdfSync("sha256", ROOT, Buffer.alloc(0), "th-event-invite-token.v1", 32),
    ).toString("base64url");
    expect(INVITE_TOKEN_KEY_LABEL).toBe("th-event-invite-token.v1");
    expect(deriveInviteTokenSecret(ROOT)).toBe(expected);
  });

  it("is stable, ≥32 chars, never the root itself, and usable as a token key", () => {
    const derived = deriveInviteTokenSecret(ROOT);
    expect(derived).toBe(deriveInviteTokenSecret(ROOT));
    expect(derived).toHaveLength(43);
    expect(derived).not.toBe(ROOT);
    const token = mintInviteToken(ID, derived!);
    expect(verifyInviteToken(token, derived!)).toEqual({ inviteId: ID });
    // A token minted under the ROOT secret does not verify under the derived key.
    expect(verifyInviteToken(mintInviteToken(ID, ROOT), derived!)).toBeNull();
  });

  it("differs per root secret", () => {
    expect(deriveInviteTokenSecret("s".repeat(40))).not.toBe(
      deriveInviteTokenSecret(ROOT),
    );
  });

  it("returns null for a missing or short root secret (→ NOT_CONFIGURED downstream)", () => {
    expect(deriveInviteTokenSecret(undefined)).toBeNull();
    expect(deriveInviteTokenSecret(null)).toBeNull();
    expect(deriveInviteTokenSecret("")).toBeNull();
    expect(deriveInviteTokenSecret("x".repeat(31))).toBeNull();
  });
});
