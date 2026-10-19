import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMBED_RECEIPT_SECRET_MS,
  embedReceiptSecretKey,
  forgetEmbedReceiptSecretsInMemory,
  heldEmbedReceiptSecret,
  rememberEmbedReceiptSecret,
  sweepExpiredEmbedReceiptSecrets,
} from "./embed-receipt-secret";

// Fake fixtures, not real secrets.
const CLIENT_SECRET = "pi_3Receipt1_secret_FakeFixtureNotReal";
const OTHER_CLIENT_SECRET = "pi_3Receipt2_secret_FakeFixtureNotReal";
const RECEIPT = "FakeReceiptSecretFixture_NotReal-0123456789A";
const OTHER_RECEIPT = "FakeReceiptSecretFixture_Other--0123456789A";

/** A new tab: nothing in memory, nothing in its own sessionStorage. */
const freshTab = () => {
  forgetEmbedReceiptSecretsInMemory();
  window.sessionStorage.clear();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T18:00:00.000Z"));
  freshTab();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("embed receipt secret — where it is kept", () => {
  it("is read back for the same embed and PaymentIntent, from memory and from sessionStorage", () => {
    rememberEmbedReceiptSecret("embed-1", CLIENT_SECRET, RECEIPT);

    expect(heldEmbedReceiptSecret("embed-1", CLIENT_SECRET)).toBe(RECEIPT);
    // A reload of the iframe's page (a same-tab redirect return): memory is
    // gone, sessionStorage is not.
    forgetEmbedReceiptSecretsInMemory();
    expect(heldEmbedReceiptSecret("embed-1", CLIENT_SECRET)).toBe(RECEIPT);
  });

  it("is keyed per embed and per PaymentIntent id, and the storage never holds the client secret", () => {
    rememberEmbedReceiptSecret("embed-1", CLIENT_SECRET, RECEIPT);

    const key = embedReceiptSecretKey("embed-1", "pi_3Receipt1");
    expect(key).toBe("hf:embed:receipt:embed-1:pi_3Receipt1");
    expect(window.sessionStorage.getItem(key)).toContain(RECEIPT);
    const everything = JSON.stringify({ ...window.sessionStorage });
    expect(everything).not.toContain("_secret_");
    expect(heldEmbedReceiptSecret("embed-2", CLIENT_SECRET)).toBeNull();
    expect(heldEmbedReceiptSecret("embed-1", OTHER_CLIENT_SECRET)).toBeNull();
  });

  it("is never written to localStorage", () => {
    const localSet = vi.spyOn(Storage.prototype, "setItem");
    rememberEmbedReceiptSecret("embed-1", CLIENT_SECRET, RECEIPT);

    expect(localSet).toHaveBeenCalledTimes(1);
    for (const call of localSet.mock.instances) {
      expect(call).toBe(window.sessionStorage);
    }
    expect(window.localStorage.length).toBe(0);
  });

  it("a fresh tab has none: the server is asked without it", () => {
    rememberEmbedReceiptSecret("embed-1", CLIENT_SECRET, RECEIPT);
    freshTab();

    expect(heldEmbedReceiptSecret("embed-1", CLIENT_SECRET)).toBeNull();
  });

  it("the first secret kept for an order stays (a replayed create answers with one that does not match)", () => {
    rememberEmbedReceiptSecret("embed-1", CLIENT_SECRET, RECEIPT);
    rememberEmbedReceiptSecret("embed-1", CLIENT_SECRET, OTHER_RECEIPT);

    expect(heldEmbedReceiptSecret("embed-1", CLIENT_SECRET)).toBe(RECEIPT);
  });

  it.each([
    ["missing (an older API)", undefined],
    ["null (a free order)", null],
    ["too short", "abc"],
    ["outside base64url", "FakeReceipt Secret Fixture NotReal 012345"],
  ])("a receipt secret that is %s is not kept", (_label, receiptSecret) => {
    rememberEmbedReceiptSecret("embed-1", CLIENT_SECRET, receiptSecret);

    expect(heldEmbedReceiptSecret("embed-1", CLIENT_SECRET)).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("a client secret with no PaymentIntent id keeps nothing", () => {
    rememberEmbedReceiptSecret("embed-1", "not-a-client-secret", RECEIPT);

    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("embed receipt secret — storage that throws", () => {
  it("setItem throws: the in-frame confirm still finds it in memory, and nothing throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(() =>
      rememberEmbedReceiptSecret("embed-1", CLIENT_SECRET, RECEIPT),
    ).not.toThrow();
    expect(heldEmbedReceiptSecret("embed-1", CLIENT_SECRET)).toBe(RECEIPT);
  });

  it("every storage call throws: remember, read and sweep never throw; a reload finds nothing", () => {
    for (const method of ["setItem", "getItem", "removeItem", "key"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    }

    expect(() => {
      rememberEmbedReceiptSecret("embed-1", CLIENT_SECRET, RECEIPT);
      sweepExpiredEmbedReceiptSecrets();
    }).not.toThrow();
    expect(heldEmbedReceiptSecret("embed-1", CLIENT_SECRET)).toBe(RECEIPT);
    forgetEmbedReceiptSecretsInMemory();
    expect(heldEmbedReceiptSecret("embed-1", CLIENT_SECRET)).toBeNull();
  });
});

describe("embed receipt secret — expiry", () => {
  it("is gone after the window, from memory and storage, on the read itself", () => {
    rememberEmbedReceiptSecret("embed-1", CLIENT_SECRET, RECEIPT);
    vi.advanceTimersByTime(EMBED_RECEIPT_SECRET_MS - 1);
    expect(heldEmbedReceiptSecret("embed-1", CLIENT_SECRET)).toBe(RECEIPT);

    vi.advanceTimersByTime(1);
    expect(heldEmbedReceiptSecret("embed-1", CLIENT_SECRET)).toBeNull();
    expect(
      window.sessionStorage.getItem(
        embedReceiptSecretKey("embed-1", "pi_3Receipt1"),
      ),
    ).toBeNull();
  });

  it("the sweep deletes every embed's expired and unusable entries, keeps fresh ones, and leaves other keys alone", () => {
    rememberEmbedReceiptSecret("embed-old", CLIENT_SECRET, RECEIPT);
    vi.advanceTimersByTime(EMBED_RECEIPT_SECRET_MS);
    rememberEmbedReceiptSecret("embed-new", OTHER_CLIENT_SECRET, OTHER_RECEIPT);
    window.sessionStorage.setItem("hf:embed:receipt:embed-junk:pi_x", "{not json");
    window.sessionStorage.setItem("hf:embed:pending-redirect:embed-old", "{}");

    sweepExpiredEmbedReceiptSecrets();

    expect(
      window.sessionStorage.getItem(
        embedReceiptSecretKey("embed-old", "pi_3Receipt1"),
      ),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem("hf:embed:receipt:embed-junk:pi_x"),
    ).toBeNull();
    expect(heldEmbedReceiptSecret("embed-new", OTHER_CLIENT_SECRET)).toBe(
      OTHER_RECEIPT,
    );
    expect(
      window.sessionStorage.getItem("hf:embed:pending-redirect:embed-old"),
    ).toBe("{}");
  });

  it("an entry dated in the future is not trusted", () => {
    window.sessionStorage.setItem(
      embedReceiptSecretKey("embed-1", "pi_3Receipt1"),
      JSON.stringify({ secret: RECEIPT, at: Date.now() + 60_000 }),
    );

    expect(heldEmbedReceiptSecret("embed-1", CLIENT_SECRET)).toBeNull();
  });
});
