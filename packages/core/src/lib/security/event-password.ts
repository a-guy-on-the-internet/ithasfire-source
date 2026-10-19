import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const PASSWORD_PREFIX = "scrypt-v1";
const KEY_LEN = 32;

export function hashEventPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LEN);
  return [PASSWORD_PREFIX, salt.toString("hex"), derived.toString("hex")].join(
    ":",
  );
}

export function verifyEventPassword(
  password: string,
  storedHash: string | null | undefined,
): boolean {
  if (!storedHash) {
    return false;
  }

  const parts = storedHash.split(":");
  if (parts.length === 3 && parts[0] === PASSWORD_PREFIX) {
    const [, saltHex, hashHex] = parts;
    if (!saltHex || !hashHex) {
      return false;
    }
    const derived = scryptSync(password, Buffer.from(saltHex, "hex"), KEY_LEN);
    const expected = Buffer.from(hashHex, "hex");
    return safeCompare(derived, expected);
  }

  return false;
}

export function isEventPasswordSet(hash: string | null | undefined): boolean {
  return Boolean(hash && hash.length > 0);
}

function safeCompare(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}
