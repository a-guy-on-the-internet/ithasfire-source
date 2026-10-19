import { describe, expect, it } from "vitest";

import { entityPageImageContentTypeToExtension } from "../page-image-upload-helpers";
import {
  PAGE_IMAGE_CANCEL_CHUNK_SIZE,
  PAGE_IMAGE_KEY_EXTENSIONS,
  chunkPageImageKeys,
  collectStrings,
  ownedPageImageKeyFromUrl,
  ownedPageImageKeysIn,
  ownedStrippedPageImageKeyFromUrl,
  pageImageKeysMentionedIn,
} from "../page-image-urls";

const scope = {
  publicBaseUrl: "https://cdn.test",
  keyPrefix: "entity-pages/place/place-1/",
};
const KEY = "entity-pages/place/place-1/2026-10-08/abc.jpg";
/** The shapes the server mints: a stripped copy and a raw upload. */
const STRIPPED_KEY = `entity-pages/place/place-1/2026-10-08/${"0123456789abcdef".repeat(2)}.jpg`;
const RAW_KEY =
  "entity-pages/place/place-1/2026-10-08/0b9a2c3e-4d5f-4a6b-8c7d-9e0f1a2b3c4d.png";

describe("ownedPageImageKeyFromUrl", () => {
  it("returns the key of an object under the prefix at the storage origin", () => {
    expect(ownedPageImageKeyFromUrl(`https://cdn.test/${KEY}`, scope)).toBe(
      KEY,
    );
  });

  it("handles a base URL with a path and a trailing slash", () => {
    const withPath = {
      ...scope,
      publicBaseUrl: "http://localhost:9000/bucket/",
    };
    expect(
      ownedPageImageKeyFromUrl(`http://localhost:9000/bucket/${KEY}`, withPath),
    ).toBe(KEY);
    expect(
      ownedPageImageKeyFromUrl(`http://localhost:9000/${KEY}`, withPath),
    ).toBeNull();
  });

  it.each([
    ["another host", `https://evil.test/${KEY}`],
    ["a lookalike host", `https://cdn.test.evil.test/${KEY}`],
    ["another port", `https://cdn.test:8443/${KEY}`],
    ["another scheme", `http://cdn.test/${KEY}`],
    ["another owner's prefix", "https://cdn.test/entity-pages/place/place-2/x.jpg"],
    ["a sibling prefix", "https://cdn.test/entity-pages/place/place-10/x.jpg"],
    ["the bare prefix", "https://cdn.test/entity-pages/place/place-1/"],
    ["dot-dot", "https://cdn.test/entity-pages/place/place-1/../place-2/x.jpg"],
    ["encoded dot-dot", "https://cdn.test/entity-pages/place/place-1/%2e%2e/place-2/x.jpg"],
    ["encoded slash", "https://cdn.test/entity-pages/place/place-1%2fx.jpg"],
    ["a backslash", "https://cdn.test/entity-pages/place/place-1\\..\\x.jpg"],
    ["userinfo", `https://user:pw@cdn.test/${KEY}`],
    ["a query", `https://cdn.test/${KEY}?x=1`],
    ["a fragment", `https://cdn.test/${KEY}#x`],
    ["whitespace", `https://cdn.test/${KEY} `],
    ["a javascript URL", "javascript:alert(1)"],
    ["not a URL", "entity-pages/place/place-1/x.jpg"],
    // Non-canonical spellings: the parser would rewrite them, so what is
    // stored would differ from the key derived from it.
    ["a /./ segment", "https://cdn.test/entity-pages/place/place-1/./2026-10-08/abc.jpg"],
    ["a trailing /.", "https://cdn.test/entity-pages/place/place-1/2026-10-08/."],
    ["an explicit default port", `https://cdn.test:443/${KEY}`],
    ["an upper-case host", `https://CDN.test/${KEY}`],
    ["an upper-case scheme", `HTTPS://cdn.test/${KEY}`],
    ["an empty segment", "https://cdn.test/entity-pages/place/place-1//abc.jpg"],
  ])("refuses %s", (_label, url) => {
    expect(ownedPageImageKeyFromUrl(url, scope)).toBeNull();
  });

  it("owns nothing when the storage has no public base URL", () => {
    expect(
      ownedPageImageKeyFromUrl(`https://cdn.test/${KEY}`, {
        ...scope,
        publicBaseUrl: null,
      }),
    ).toBeNull();
  });

  it("ignores non-strings", () => {
    expect(ownedPageImageKeyFromUrl(42, scope)).toBeNull();
    expect(ownedPageImageKeyFromUrl(null, scope)).toBeNull();
  });
});

describe("ownedStrippedPageImageKeyFromUrl", () => {
  it("accepts a stripped copy (32-hex name)", () => {
    expect(
      ownedStrippedPageImageKeyFromUrl(`https://cdn.test/${STRIPPED_KEY}`, scope),
    ).toBe(STRIPPED_KEY);
  });

  it("refuses a raw upload key (uuid name): it still holds EXIF/GPS", () => {
    expect(
      ownedStrippedPageImageKeyFromUrl(`https://cdn.test/${RAW_KEY}`, scope),
    ).toBeNull();
    // The delete side still owns it (Discard queues raw draft-only keys).
    expect(ownedPageImageKeyFromUrl(`https://cdn.test/${RAW_KEY}`, scope)).toBe(
      RAW_KEY,
    );
  });

  it("refuses everything ownedPageImageKeyFromUrl refuses", () => {
    expect(
      ownedStrippedPageImageKeyFromUrl(`https://cdn.test/${STRIPPED_KEY}?w=800`, scope),
    ).toBeNull();
    expect(
      ownedStrippedPageImageKeyFromUrl(`https://other.test/${STRIPPED_KEY}`, scope),
    ).toBeNull();
  });
});

describe("ownedPageImageKeysIn", () => {
  it("finds owned keys at any depth, deduplicated", () => {
    const other = "entity-pages/place/place-1/2026-10-08/def.png";
    expect(
      ownedPageImageKeysIn(
        [
          { "page.avatarUrl": `https://cdn.test/${KEY}` },
          {
            photos: [
              { url: `https://cdn.test/${other}` },
              { url: `https://cdn.test/${KEY}` },
              { url: "https://elsewhere.test/x.jpg" },
            ],
          },
        ],
        scope,
      ),
    ).toEqual([KEY, other]);
  });
});

describe("pageImageKeysMentionedIn (generous about where: for cancelling deletes only)", () => {
  const prefix = scope.keyPrefix;

  it.each([
    ["a canonical URL", `https://cdn.test/${STRIPPED_KEY}`],
    ["a query-string variant", `https://cdn.test/${STRIPPED_KEY}?w=800`],
    ["another host", `https://elsewhere.test/${STRIPPED_KEY}`],
    ["an HTML attribute", `<img src="https://cdn.test/${STRIPPED_KEY}" alt="">`],
    ["a key at the end of a sentence", `see https://cdn.test/${STRIPPED_KEY}.`],
    ["a key followed by a path", `https://cdn.test/${STRIPPED_KEY}/variant`],
    ["a bare key", STRIPPED_KEY],
  ])("finds the key in %s", (_label, text) => {
    expect(pageImageKeysMentionedIn([{ deep: [text] }], prefix)).toContain(
      STRIPPED_KEY,
    );
  });

  it("finds a raw upload key too (a draft may have named one)", () => {
    expect(pageImageKeysMentionedIn([`x ${RAW_KEY} y`], prefix)).toEqual([
      RAW_KEY,
    ]);
  });

  it("matches only the key shapes the server mints", () => {
    expect(pageImageKeysMentionedIn([`https://cdn.test/${KEY}`], prefix)).toEqual(
      [],
    );
  });

  it("ignores another owner's prefix, including a longer id", () => {
    const name = `2026-10-08/${"a".repeat(32)}.jpg`;
    expect(
      pageImageKeysMentionedIn(
        [
          `https://cdn.test/entity-pages/place/place-10/${name}`,
          `https://cdn.test/entity-pages/place/place-2/${name}`,
        ],
        prefix,
      ),
    ).toEqual([]);
  });

  it("is bounded and fast on a 64 KB dotted run", () => {
    const run = `${prefix}${"a.".repeat(32 * 1024)}`;
    const started = performance.now();
    const keys = pageImageKeysMentionedIn([run, { deep: [run, run] }], prefix);
    expect(keys).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("is never capped: 5,000 mentioned keys all come back", () => {
    const text = Array.from(
      { length: 5_000 },
      (_, i) => `${prefix}2026-10-08/${i.toString(16).padStart(32, "0")}.jpg`,
    ).join(" ");
    expect(pageImageKeysMentionedIn([text], prefix)).toHaveLength(5_000);
  });

  it("matches the minted extension exactly: <key>.jpgabc yields <key>.jpg", () => {
    expect(
      pageImageKeysMentionedIn([`https://cdn.test/${STRIPPED_KEY}abc`], prefix),
    ).toEqual([STRIPPED_KEY]);
  });

  it("ignores an extension the server never mints", () => {
    const jpeg = STRIPPED_KEY.replace(/\.jpg$/, ".jpeg");
    const bmp = STRIPPED_KEY.replace(/\.jpg$/, ".bmp");
    expect(pageImageKeysMentionedIn([jpeg, bmp], prefix)).toEqual([]);
  });
});

describe("minted extensions", () => {
  it("are exactly the upload helper's extensions", () => {
    expect([...PAGE_IMAGE_KEY_EXTENSIONS].sort()).toEqual(
      Object.values(entityPageImageContentTypeToExtension).sort(),
    );
  });

  it("a stripped name with another extension is not a stripped copy", () => {
    const bmp = STRIPPED_KEY.replace(/\.jpg$/, ".bmp");
    expect(
      ownedStrippedPageImageKeyFromUrl(`https://cdn.test/${bmp}`, scope),
    ).toBeNull();
  });
});

describe("chunkPageImageKeys", () => {
  it("splits into chunks of the cancel size, keeping every key in order", () => {
    const keys = Array.from({ length: 1_234 }, (_, i) => `k${i}`);
    const chunks = chunkPageImageKeys(keys);
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      PAGE_IMAGE_CANCEL_CHUNK_SIZE,
      PAGE_IMAGE_CANCEL_CHUNK_SIZE,
      1_234 - 2 * PAGE_IMAGE_CANCEL_CHUNK_SIZE,
    ]);
    expect(chunks.flat()).toEqual(keys);
    expect(chunkPageImageKeys([])).toEqual([]);
  });
});

describe("collectStrings", () => {
  it("walks objects and arrays and skips Dates and numbers", () => {
    expect(
      collectStrings({ a: "x", b: [1, "y", { c: "z" }], d: new Date(0) }),
    ).toEqual(["x", "y", "z"]);
  });
});
