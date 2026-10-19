import { afterEach, describe, expect, it, vi } from "vitest";

import { generateClientKey } from "./embed-helpers";

/**
 * The embed's checkout key. The server takes it as an idempotency key and,
 * for a guest, as part of the proof that an order is theirs, and holds it
 * to a minimum length. So: a v4 UUID from the browser's cryptographic
 * generator, on the browsers that have `crypto.randomUUID` and on the ones
 * that do not (older Safari, a page outside a secure context).
 */

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** As the key generator calls it: 16 bytes in, the same array back. */
type GetRandomValues = (array: Uint8Array) => Uint8Array;

/** `crypto` as a browser without `randomUUID` has it. */
const withoutRandomUuid = (getRandomValues: GetRandomValues) =>
  vi.stubGlobal("crypto", { getRandomValues });

/** The real generator, held before `crypto` is stubbed. */
const realCrypto = globalThis.crypto;
const reallyRandom: GetRandomValues = (array) => {
  array.set(realCrypto.getRandomValues(new Uint8Array(array.length)));
  return array;
};
/** Every byte the same: what the fallback does with the bits it must set. */
const allBytes =
  (value: number): GetRandomValues =>
  (array) =>
    array.fill(value);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("generateClientKey", () => {
  it("is what crypto.randomUUID gives, where the browser has it", () => {
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("3f2b8c1e-7a4d-4e9b-a1c2-0d5e6f7a8b9c");

    expect(generateClientKey()).toBe("3f2b8c1e-7a4d-4e9b-a1c2-0d5e6f7a8b9c");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("with randomUUID: a v4 UUID, 36 characters", () => {
    const key = generateClientKey();

    expect(key).toMatch(UUID_V4);
    expect(key).toHaveLength(36);
  });

  it("without randomUUID: a v4 UUID, 36 characters, built from crypto.getRandomValues", () => {
    const getRandomValues = vi.fn(reallyRandom);
    withoutRandomUuid(getRandomValues);

    const key = generateClientKey();

    expect(key).toMatch(UUID_V4);
    expect(key).toHaveLength(36);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it("without randomUUID: the version and variant bits are set whatever the random bytes are", () => {
    withoutRandomUuid(allBytes(0xff));
    expect(generateClientKey()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");

    withoutRandomUuid(allBytes(0x00));
    expect(generateClientKey()).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("never asks Math.random, on either branch", () => {
    const mathRandom = vi.spyOn(Math, "random");

    generateClientKey();
    withoutRandomUuid(reallyRandom);
    generateClientKey();

    expect(mathRandom).not.toHaveBeenCalled();
  });

  it.each([
    ["with randomUUID", false],
    ["without randomUUID", true],
  ])("1,000 keys are 1,000 different keys (%s)", (_which, fallback) => {
    if (fallback) withoutRandomUuid(reallyRandom);

    const keys = new Set(Array.from({ length: 1000 }, generateClientKey));

    expect(keys.size).toBe(1000);
    for (const key of keys) expect(key).toMatch(UUID_V4);
  });
});
