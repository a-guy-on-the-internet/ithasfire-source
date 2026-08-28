import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

/**
 * `passkey-name.ts` reads react-native's `Platform`, which cannot be loaded in
 * a node vitest run. Swap it for a mutable stub so a single suite can exercise
 * both platforms. `vi.hoisted` is required because `vi.mock` factories are
 * hoisted above the imports.
 */
const mockPlatform = vi.hoisted(() => ({
  OS: "ios" as string,
  isPad: false as boolean | undefined,
}));
vi.mock("react-native", () => ({ Platform: mockPlatform }));

const setPlatform = (os: string, isPad?: boolean) => {
  mockPlatform.OS = os;
  mockPlatform.isPad = isPad;
};

// Safe as a static import: `Platform.OS` is read at call time, not at module
// init, so the stub can be re-pointed between assertions.
import {
  collectExistingPasskeyNames,
  scannerDeviceLabel,
  scannerPasskeyName,
} from "./passkey-name";
import type { PasskeyResult, ScannerPasskey } from "./passkey-client";

const APOSTROPHE = "’";

describe("scannerDeviceLabel", () => {
  it("labels iOS phones and tablets distinctly", () => {
    expect(scannerDeviceLabel({ os: "ios" })).toBe("iPhone scanner");
    expect(scannerDeviceLabel({ os: "ios", isPad: false })).toBe(
      "iPhone scanner",
    );
    expect(scannerDeviceLabel({ os: "ios", isPad: true })).toBe("iPad scanner");
  });

  it("labels the remaining native platforms", () => {
    expect(scannerDeviceLabel({ os: "android" })).toBe("Android scanner");
    expect(scannerDeviceLabel({ os: "macos" })).toBe("Mac scanner");
    expect(scannerDeviceLabel({ os: "windows" })).toBe("Windows scanner");
  });

  it("keeps the app qualifier on every recognised platform", () => {
    // The qualifier is what tells an operator auditing their passkey list on
    // the web that the credential came from the shared/handed-off scanner
    // rather than from their own browser. It must not be dropped from any
    // native platform.
    for (const os of ["ios", "android", "macos", "windows", "web"]) {
      expect(scannerDeviceLabel({ os })?.toLowerCase()).toContain("scanner");
    }
  });

  it("puts the qualifier first on expo web, which is dev-only", () => {
    // "Browser scanner" would read as a product name; here the browser is the
    // incidental detail.
    expect(scannerDeviceLabel({ os: "web" })).toBe("Scanner (browser)");
  });

  it("returns null rather than guessing for an unknown platform", () => {
    // A null label makes the shared helper degrade to "Tom’s passkey" instead
    // of mislabelling the credential as a device the operator doesn't own.
    // Critically it must NOT degrade to a bare "scanner" / "unknown scanner":
    // the qualifier only ever rides along with a device noun we recognised.
    expect(scannerDeviceLabel({ os: "visionos" })).toBeNull();
    expect(scannerDeviceLabel({ os: "" })).toBeNull();
  });
});

describe("scannerPasskeyName", () => {
  it("composes name + device on iOS", () => {
    setPlatform("ios");
    expect(scannerPasskeyName("Tom")).toBe(`Tom${APOSTROPHE}s iPhone scanner`);
  });

  it("composes name + device on Android", () => {
    setPlatform("android");
    expect(scannerPasskeyName("Tom")).toBe(`Tom${APOSTROPHE}s Android scanner`);
  });

  it("uses the tablet label when Platform.isPad is set", () => {
    setPlatform("ios", true);
    expect(scannerPasskeyName("Tom")).toBe(`Tom${APOSTROPHE}s iPad scanner`);
  });

  it("falls back to the bare device label with no user name", () => {
    setPlatform("ios");
    expect(scannerPasskeyName()).toBe("iPhone scanner");
    expect(scannerPasskeyName(null)).toBe("iPhone scanner");
    // Whitespace-only names count as absent, not as "  ’s iPhone scanner".
    expect(scannerPasskeyName("   ")).toBe("iPhone scanner");

    setPlatform("android");
    // Byte-identical to the string the pre-shared-helper settings screen
    // produced for a nameless account.
    expect(scannerPasskeyName(undefined)).toBe("Android scanner");
  });

  it("falls back to a bare passkey name when the platform is unrecognised", () => {
    setPlatform("visionos");
    expect(scannerPasskeyName("Tom")).toBe(`Tom${APOSTROPHE}s passkey`);
    expect(scannerPasskeyName()).toBe("Passkey");
  });

  it("keeps the device + qualifier intact for an absurdly long name", () => {
    setPlatform("android");
    // The qualifier is the load-bearing part (it says "operator app"), so the
    // 64-char cap must eat the NAME, not the tail. Guards the scanner's stake
    // in the shared helper's composition order.
    const derived = scannerPasskeyName("Bartholomew ".repeat(12).trim());
    expect(derived.endsWith(`${APOSTROPHE}s Android scanner`)).toBe(true);
    expect(derived.length).toBeLessThanOrEqual(64);
  });

  it("disambiguates against existing names when they are supplied", () => {
    setPlatform("android");
    expect(
      scannerPasskeyName("Tom", [`Tom${APOSTROPHE}s Android scanner`]),
    ).toBe(`Tom${APOSTROPHE}s Android scanner (2)`);
  });

  /**
   * Documents the contract the two enroll call sites rely on: they pass a NAME
   * and nothing else, so a nameless account must produce a device label rather
   * than anything address-shaped. (The guard that the call sites actually
   * honour that is the source assertion in the `describe` block below — this
   * one only pins the helper's half of the deal.)
   */
  it("never turns a missing name into an address-shaped label", () => {
    setPlatform("ios");
    const derived = scannerPasskeyName(null);
    expect(derived).toBe("iPhone scanner");
    expect(derived).not.toContain("@");

    // And if an email IS handed in as a name (it must not be), it is at least
    // still composed as a person name rather than read as a device.
    expect(scannerPasskeyName("tom@example.com")).toBe(
      `tom@example.com${APOSTROPHE}s iPhone scanner`,
    );
  });
});

describe("collectExistingPasskeyNames", () => {
  const listing =
    (
      passkeys: Partial<ScannerPasskey>[],
    ): (() => Promise<PasskeyResult<ScannerPasskey[]>>) =>
    async () => ({ data: passkeys as ScannerPasskey[], error: null });

  it("returns the non-empty names from the list", async () => {
    await expect(
      collectExistingPasskeyNames(
        listing([{ name: "Tom’s Android scanner" }, { name: "Tom’s iPhone" }]),
      ),
    ).resolves.toEqual(["Tom’s Android scanner", "Tom’s iPhone"]);
  });

  it("drops unusable entries instead of passing null through", async () => {
    await expect(
      collectExistingPasskeyNames(
        listing([{ name: null }, { name: "   " }, { name: "Real one" }]),
      ),
    ).resolves.toEqual(["Real one"]);
    await expect(
      collectExistingPasskeyNames(listing([{ name: null }])),
    ).resolves.toBeUndefined();
    await expect(
      collectExistingPasskeyNames(listing([])),
    ).resolves.toBeUndefined();
  });

  it("suffixes a second same-kind device end to end", async () => {
    setPlatform("android");
    const existingNames = await collectExistingPasskeyNames(
      listing([{ name: `Tom${APOSTROPHE}s Android scanner` }]),
    );
    expect(scannerPasskeyName("Tom", existingNames)).toBe(
      `Tom${APOSTROPHE}s Android scanner (2)`,
    );
  });

  /**
   * The whole point of "best effort": every failure mode below must resolve to
   * `undefined` so the caller still enrolls, with an unsuffixed name. A
   * duplicate label is cosmetic; a dead "Add a passkey" button is not.
   */
  it("resolves undefined when the API returns an error payload", async () => {
    setPlatform("android");
    const existingNames = await collectExistingPasskeyNames(async () => ({
      data: null,
      error: { message: "passkey_list-user-passkeys_failed" },
    }));
    expect(existingNames).toBeUndefined();
    expect(scannerPasskeyName("Tom", existingNames)).toBe(
      `Tom${APOSTROPHE}s Android scanner`,
    );
  });

  it("resolves undefined when the lister rejects", async () => {
    setPlatform("android");
    const existingNames = await collectExistingPasskeyNames(() =>
      Promise.reject(new Error("Network request failed")),
    );
    expect(existingNames).toBeUndefined();
    expect(scannerPasskeyName("Tom", existingNames)).toBe(
      `Tom${APOSTROPHE}s Android scanner`,
    );
  });

  it("resolves undefined when the lister throws synchronously", async () => {
    await expect(
      collectExistingPasskeyNames(() => {
        throw new Error("boom");
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves undefined for a malformed body", async () => {
    await expect(
      collectExistingPasskeyNames(
        async () =>
          ({ data: "not-an-array", error: null }) as unknown as PasskeyResult<
            ScannerPasskey[]
          >,
      ),
    ).resolves.toBeUndefined();
  });

  it("gives up rather than blocking enrollment on a slow list", async () => {
    setPlatform("ios");
    // Real timers with a tiny budget: a hung request must not hold the
    // biometric prompt hostage.
    const existingNames = await collectExistingPasskeyNames(
      () => new Promise<PasskeyResult<ScannerPasskey[]>>(() => {}),
      5,
    );
    expect(existingNames).toBeUndefined();
    expect(scannerPasskeyName("Tom", existingNames)).toBe(
      `Tom${APOSTROPHE}s iPhone scanner`,
    );
  });
});

/**
 * Real regression guard for the drift bug, asserted against the CALL SITE
 * source rather than against a hand-built literal.
 *
 * The bug: `PasskeyEnrollPromptScreen` was handed `user.name ?? user.email`, so
 * an operator with no display name enrolled a credential literally named
 * `tom@example.com`. Nothing in a helper-level test can catch that re-landing —
 * the helper is happy to compose whatever string it is given. So this reads
 * `scanner-app.tsx`, isolates each enroll-screen JSX element, strips comments
 * (the fix itself mentions `user.email` in a comment), and fails if an email
 * ever reaches the prompt's props again.
 */
describe("scanner-app enroll call sites", () => {
  // `.href` rather than passing the `URL` object: this app's tsconfig pulls in
  // the DOM lib, so the global `URL` here is lib.dom's, which is not structurally
  // the `node:url` one `fileURLToPath` is typed against.
  const source = readFileSync(
    fileURLToPath(new URL("../../scanner-app.tsx", import.meta.url).href),
    "utf8",
  );

  /** The props text of `<Tag ... />` or `<Tag ...>`, with comments removed. */
  const propsOf = (tag: string): string => {
    const open = source.indexOf(`<${tag}`);
    expect(
      open,
      `<${tag}> is no longer rendered by scanner-app.tsx — this guard needs updating (or the passkey name is now derived somewhere else).`,
    ).toBeGreaterThan(-1);
    const selfClosing = source.indexOf("/>", open);
    expect(
      selfClosing,
      `<${tag}> is no longer self-closing in scanner-app.tsx — this guard needs updating.`,
    ).toBeGreaterThan(open);
    return source
      .slice(open, selfClosing)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
  };

  it("passes the operator's name — never their email — to the enroll prompt", () => {
    const props = propsOf("PasskeyEnrollPromptScreen");
    expect(props).toContain("userName={user.name}");
    expect(props.toLowerCase()).not.toContain("email");
  });

  it("passes the name to the settings screen the same way", () => {
    // Consistency, per review: one null-handling style across both sites.
    // `userEmail` is legitimate here (it is the signed-in-as subtitle), so this
    // asserts the shape of `userName` instead of the absence of "email".
    expect(propsOf("SettingsScreen")).toContain("userName={user.name}");
  });
});
