import { describe, expect, it } from "vitest";

import {
  PASSKEY_NAME_MAX_LENGTH,
  derivePasskeyName,
  normalizePasskeyName,
} from "../passkey-name";

// EVERY non-ASCII character in this file is spelled as a code point, never as a
// literal: an invisible zero-width space or a raw C0 control byte in the source
// is unreviewable in a diff (and makes the file read as binary to grep/file),
// an RTL literal reorders the surrounding source in an editor, and a
// typographic apostrophe or a combining mark can be silently downgraded by an
// editor or a copy/paste while leaving the assertion passing against the wrong
// character.

// --- invisibles that MUST be stripped ---------------------------------------
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const BIDI_RTL_OVERRIDE = String.fromCodePoint(0x202e);
const BIDI_LTR_ISOLATE = String.fromCodePoint(0x2066);
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);
const C0_CONTROL = String.fromCodePoint(0x01);

// --- invisibles that MUST survive ------------------------------------------
// U+200C is orthographically required in Persian/Indic scripts; U+200D holds
// emoji sequences together. Both are `\p{Cf}`, which is exactly why this module
// does not strip by property class.
const ZERO_WIDTH_NON_JOINER = String.fromCodePoint(0x200c);
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);
const VARIATION_SELECTOR_16 = String.fromCodePoint(0xfe0f);
const COMBINING_ACUTE_ACCENT = String.fromCodePoint(0x0301);

// --- real-script samples ---------------------------------------------------
const CJK_TOKYO = String.fromCodePoint(0x6771, 0x4eac);
const ARABIC_MUHAMMAD = String.fromCodePoint(0x0645, 0x062d, 0x0645, 0x062f);
const HEBREW_SHALOM = String.fromCodePoint(0x05e9, 0x05dc, 0x05d5, 0x05dd);
/** Persian "my phone": two words joined by a ZWNJ, which must not be removed. */
const PERSIAN_MY_PHONE = `${String.fromCodePoint(0x06af, 0x0648, 0x0634, 0x06cc)}${ZERO_WIDTH_NON_JOINER}${String.fromCodePoint(0x0645, 0x0646)}`;
const E_WITH_ACUTE = String.fromCodePoint(0x00e9);

// --- emoji ------------------------------------------------------------------
const FIRE_EMOJI = String.fromCodePoint(0x1f525);
/** Man technologist: man + ZWJ + laptop. */
const EMOJI_ZWJ_SEQUENCE = `${String.fromCodePoint(0x1f468)}${ZERO_WIDTH_JOINER}${String.fromCodePoint(0x1f4bb)}`;
/** Rainbow flag: white flag + VS16 + ZWJ + rainbow. */
const RAINBOW_FLAG = `${String.fromCodePoint(0x1f3f3)}${VARIATION_SELECTOR_16}${ZERO_WIDTH_JOINER}${String.fromCodePoint(0x1f308)}`;

// --- ill-formed UTF-16 ------------------------------------------------------
// `fromCharCode`, not `fromCodePoint`: these are single code UNITS with no
// partner, the shape `{"name":"\ud83d"}` arrives in as valid JSON.
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd83d);
const LONE_LOW_SURROGATE = String.fromCharCode(0xdc96);

const APOSTROPHE = String.fromCodePoint(0x2019);

// This is the single source of auto-generated passkey display names for all
// four enrollment surfaces (web settings, web sign-up, scanner settings,
// scanner first-run) AND of the web rename field, so it now processes
// USER-TYPED text. Those four each rolled their own string and had already
// drifted apart — pin the exact contract so they cannot drift again.
describe("normalizePasskeyName", () => {
  it("pins the length cap", () => {
    // Asserted as a literal, not via the constant: every other cap assertion in
    // this file is expressed in terms of PASSKEY_NAME_MAX_LENGTH and would stay
    // green if the value itself changed.
    expect(PASSKEY_NAME_MAX_LENGTH).toBe(64);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePasskeyName("  macOS  ")).toBe("macOS");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(normalizePasskeyName("Tom    old   iPhone")).toBe("Tom old iPhone");
    expect(normalizePasskeyName("Tom\niPhone")).toBe("Tom iPhone");
    expect(normalizePasskeyName("Tom\tiPhone")).toBe("Tom iPhone");
  });

  it("strips control characters and invisible format characters", () => {
    expect(
      normalizePasskeyName(
        `mac${ZERO_WIDTH_SPACE}O${BYTE_ORDER_MARK}S${BIDI_RTL_OVERRIDE}`,
      ),
    ).toBe("macOS");
    expect(
      normalizePasskeyName(
        `${BIDI_LTR_ISOLATE}mac${SOFT_HYPHEN}OS${BIDI_LTR_ISOLATE}`,
      ),
    ).toBe("macOS");
    // A non-whitespace control is removed outright, not turned into a space.
    expect(normalizePasskeyName(`mac${C0_CONTROL}OS`)).toBe("macOS");
  });

  it("strips the obscure zero-width format controls too", () => {
    // Enumerating ranges instead of using `\p{Cf}` risks silently narrowing the
    // strip. These are the invisible layout controls that used to be covered by
    // the property class and must stay covered.
    for (const invisible of [
      String.fromCodePoint(0x13430), // Egyptian hieroglyph vertical joiner
      String.fromCodePoint(0x1bca1), // Shorthand format continuing overlap
      String.fromCodePoint(0x1d173), // Musical symbol begin beam
    ]) {
      expect(normalizePasskeyName(`mac${invisible}OS`)).toBe("macOS");
    }
  });

  it("keeps the format characters that actually render", () => {
    // The other half of the same rule: a `\p{Cf}` character that draws a
    // visible mark is content, not a payload.
    const arabicNumberSign = String.fromCodePoint(0x0600); // ARABIC NUMBER SIGN
    const syriacAbbreviation = String.fromCodePoint(0x070f);
    expect(normalizePasskeyName(`${arabicNumberSign}12`)).toBe(
      `${arabicNumberSign}12`,
    );
    expect(normalizePasskeyName(`${syriacAbbreviation}ab`)).toBe(
      `${syriacAbbreviation}ab`,
    );
  });

  it("preserves the zero-width NON-joiner and the zero-width joiner", () => {
    // Both are `\p{Cf}`, but neither is a spoofing vector and both carry
    // meaning: ZWNJ is orthographically required in Persian/Devanagari/Bengali/
    // Malayalam/Sinhala, and ZWJ is what holds an emoji sequence together.
    // Stripping either is silent content corruption of a user-typed name.
    expect(normalizePasskeyName(PERSIAN_MY_PHONE)).toBe(PERSIAN_MY_PHONE);
    expect(normalizePasskeyName(PERSIAN_MY_PHONE)).toContain(
      ZERO_WIDTH_NON_JOINER,
    );
    expect(normalizePasskeyName(EMOJI_ZWJ_SEQUENCE)).toBe(EMOJI_ZWJ_SEQUENCE);
    expect(normalizePasskeyName(RAINBOW_FLAG)).toBe(RAINBOW_FLAG);
    expect(normalizePasskeyName(RAINBOW_FLAG)).toContain(ZERO_WIDTH_JOINER);
  });

  it("leaves real non-Latin names untouched", () => {
    // The rest of this suite feeds ASCII plus deliberately hostile invisibles.
    // This is the assertion that catches "the helper mangles actual names".
    for (const name of [
      CJK_TOKYO,
      `${CJK_TOKYO} iPhone`,
      ARABIC_MUHAMMAD,
      HEBREW_SHALOM,
      `${HEBREW_SHALOM} MacBook`,
      PERSIAN_MY_PHONE,
      FIRE_EMOJI,
      `${FIRE_EMOJI} iPhone`,
      EMOJI_ZWJ_SEQUENCE,
      RAINBOW_FLAG,
    ]) {
      expect(normalizePasskeyName(name)).toBe(name);
    }
  });

  it("preserves a combining mark that has no precomposed form", () => {
    // `q` + U+0301 has no single-code-point equivalent, so NFC cannot fold it.
    // It must survive as two code points, not be stripped as an invisible.
    const qAcute = `q${COMBINING_ACUTE_ACCENT}`;
    expect(normalizePasskeyName(qAcute)).toBe(qAcute);
    expect(normalizePasskeyName(`Ma${qAcute}c`)).toBe(`Ma${qAcute}c`);
  });

  it("applies NFC so decomposed and precomposed spellings compare equal", () => {
    // macOS text input emits NFD. Without normalization the settings list can
    // show two rows whose names are visually identical, which is exactly what
    // the collision suffix exists to prevent.
    const decomposed = `Cafe${COMBINING_ACUTE_ACCENT}`;
    const precomposed = `Caf${E_WITH_ACUTE}`;
    expect(decomposed).not.toBe(precomposed);
    expect(normalizePasskeyName(decomposed)).toBe(
      normalizePasskeyName(precomposed),
    );
    expect(normalizePasskeyName(decomposed)).toBe(precomposed);
    // NFC also makes the cap deterministic: an NFD accent costs two code units.
    expect(normalizePasskeyName(decomposed)).toHaveLength(4);
  });

  it("strips unpaired surrogates from the input", () => {
    // `{"name":"\ud83d"}` is valid JSON, so an unpaired half reaches this
    // function without ever going through the truncation path. Node's UTF-8
    // encoder would substitute U+FFFD and Postgres would store the replacement
    // character.
    expect(normalizePasskeyName(`Tom${LONE_HIGH_SURROGATE}`)).toBe("Tom");
    expect(normalizePasskeyName(`Tom${LONE_LOW_SURROGATE}`)).toBe("Tom");
    expect(normalizePasskeyName(`To${LONE_HIGH_SURROGATE}m`)).toBe("Tom");
    expect(normalizePasskeyName(LONE_HIGH_SURROGATE)).toBeNull();
    expect(normalizePasskeyName(LONE_LOW_SURROGATE)).toBeNull();
    const result = normalizePasskeyName(
      `${LONE_HIGH_SURROGATE}Tom${LONE_LOW_SURROGATE}`,
    );
    expect(result).toBe("Tom");
    expect(/[\uD800-\uDFFF]/u.test(result ?? "")).toBe(false);
  });

  it("keeps valid surrogate pairs while stripping a stray half beside them", () => {
    // The `u` flag makes a real pair one code point above U+FFFF, so astral
    // emoji are untouched — dropping a whole emoji would be its own corruption.
    expect(normalizePasskeyName(FIRE_EMOJI)).toBe(FIRE_EMOJI);
    expect(normalizePasskeyName(`${LONE_HIGH_SURROGATE}${FIRE_EMOJI}`)).toBe(
      FIRE_EMOJI,
    );
    expect(normalizePasskeyName(`${FIRE_EMOJI}${LONE_LOW_SURROGATE}`)).toBe(
      FIRE_EMOJI,
    );
  });

  it("caps over-long input to exactly PASSKEY_NAME_MAX_LENGTH", () => {
    const result = normalizePasskeyName("a".repeat(500));
    expect(result).toHaveLength(PASSKEY_NAME_MAX_LENGTH);
    expect(result).toBe("a".repeat(PASSKEY_NAME_MAX_LENGTH));
  });

  it("returns null for blank and whitespace-only input", () => {
    expect(normalizePasskeyName("")).toBeNull();
    expect(normalizePasskeyName("   ")).toBeNull();
    expect(normalizePasskeyName("\n\t ")).toBeNull();
    // Nothing but zero-width characters normalizes away to nothing.
    expect(normalizePasskeyName(ZERO_WIDTH_SPACE.repeat(3))).toBeNull();
  });

  it("returns null for null and undefined", () => {
    expect(normalizePasskeyName(null)).toBeNull();
    expect(normalizePasskeyName(undefined)).toBeNull();
  });
});

describe("derivePasskeyName", () => {
  it("combines the person name and the device label", () => {
    expect(derivePasskeyName({ userName: "Tom", deviceLabel: "iPhone" })).toBe(
      `Tom${APOSTROPHE}s iPhone`,
    );
  });

  it("uses a typographic apostrophe (U+2019), never ASCII", () => {
    const combined = derivePasskeyName({
      userName: "Tom",
      deviceLabel: "iPhone",
    });
    expect(combined).toContain(APOSTROPHE);
    expect(combined).not.toContain("'");
    expect(combined.codePointAt(3)).toBe(0x2019);

    const userOnly = derivePasskeyName({ userName: "Tom" });
    expect(userOnly).toBe(`Tom${APOSTROPHE}s passkey`);
    expect(userOnly).not.toContain("'");
  });

  it("uses the device label alone when there is no person name", () => {
    expect(derivePasskeyName({ deviceLabel: "macOS" })).toBe("macOS");
    expect(derivePasskeyName({ deviceLabel: "macOS", userName: null })).toBe(
      "macOS",
    );
    // A blank label counts as absent, not as an empty trailing word.
    expect(derivePasskeyName({ deviceLabel: "   ", userName: "Tom" })).toBe(
      `Tom${APOSTROPHE}s passkey`,
    );
  });

  it("falls back to the person name plus 'passkey' when there is no device label", () => {
    expect(derivePasskeyName({ userName: "Tom" })).toBe(
      `Tom${APOSTROPHE}s passkey`,
    );
  });

  it("falls back to 'Passkey' when it has nothing to work with", () => {
    expect(derivePasskeyName({})).toBe("Passkey");
    expect(derivePasskeyName({ userName: null, deviceLabel: undefined })).toBe(
      "Passkey",
    );
    expect(
      derivePasskeyName({ userName: " ", deviceLabel: ZERO_WIDTH_SPACE }),
    ).toBe("Passkey");
    // An unpaired surrogate is not usable content either.
    expect(derivePasskeyName({ userName: LONE_HIGH_SURROGATE })).toBe(
      "Passkey",
    );
  });

  it("normalizes a hostile device label instead of trusting it", () => {
    expect(
      derivePasskeyName({
        deviceLabel: `  mac${ZERO_WIDTH_SPACE}OS\n\nPro  `,
      }),
    ).toBe("macOS Pro");

    const absurd = derivePasskeyName({
      userName: "Tom",
      deviceLabel: "X".repeat(500),
    });
    expect(absurd).toHaveLength(PASSKEY_NAME_MAX_LENGTH);
    // A label with no room left for a name degrades to the BARE label. This
    // assertion used to read `startsWith("Tom’s XXX")`, i.e. it pinned the old
    // behaviour of keeping the name and cutting the label's tail — which is the
    // bug fixed below in "shortens the person name, not the device label".
    expect(absurd).toBe("X".repeat(PASSKEY_NAME_MAX_LENGTH));
  });

  it("keeps a non-Latin person name and device label intact", () => {
    expect(
      derivePasskeyName({ userName: ARABIC_MUHAMMAD, deviceLabel: CJK_TOKYO }),
    ).toBe(`${ARABIC_MUHAMMAD}${APOSTROPHE}s ${CJK_TOKYO}`);
    expect(derivePasskeyName({ deviceLabel: PERSIAN_MY_PHONE })).toBe(
      PERSIAN_MY_PHONE,
    );
  });

  it("leaves the name unsuffixed when there is no collision", () => {
    expect(
      derivePasskeyName({
        deviceLabel: "macOS",
        existingNames: ["iPhone", "Windows PC"],
      }),
    ).toBe("macOS");
  });

  it("appends ' (2)' then ' (3)' on collision", () => {
    expect(
      derivePasskeyName({ deviceLabel: "macOS", existingNames: ["macOS"] }),
    ).toBe("macOS (2)");
    expect(
      derivePasskeyName({
        deviceLabel: "macOS",
        existingNames: ["macOS", "macOS (2)"],
      }),
    ).toBe("macOS (3)");
  });

  it("matches existing names case-insensitively", () => {
    expect(
      derivePasskeyName({ deviceLabel: "macOS", existingNames: ["macos"] }),
    ).toBe("macOS (2)");
    expect(
      derivePasskeyName({
        deviceLabel: "macOS",
        existingNames: ["MACOS", "MacOS (2)"],
      }),
    ).toBe("macOS (3)");
  });

  it("normalizes existing names before comparing", () => {
    expect(
      derivePasskeyName({
        deviceLabel: "macOS",
        existingNames: [`  mac${ZERO_WIDTH_SPACE}OS  `, null, undefined, ""],
      }),
    ).toBe("macOS (2)");
  });

  it("detects a collision between NFD and NFC spellings of one name", () => {
    // The macOS case from `normalizePasskeyName`, end to end: the existing name
    // is decomposed, the derived one precomposed, and they must still collide.
    const decomposed = `Cafe${COMBINING_ACUTE_ACCENT}`;
    const precomposed = `Caf${E_WITH_ACUTE}`;
    expect(
      derivePasskeyName({
        deviceLabel: precomposed,
        existingNames: [decomposed],
      }),
    ).toBe(`${precomposed} (2)`);
  });

  it("fills the first free gap rather than counting past taken names", () => {
    expect(
      derivePasskeyName({
        deviceLabel: "macOS",
        existingNames: ["macOS", "macOS (3)"],
      }),
    ).toBe("macOS (2)");
  });

  it("keeps the suffix and the cap when an over-long base collides", () => {
    const longLabel = "L".repeat(200);
    const first = derivePasskeyName({ deviceLabel: longLabel });
    expect(first).toHaveLength(PASSKEY_NAME_MAX_LENGTH);

    const second = derivePasskeyName({
      deviceLabel: longLabel,
      existingNames: [first],
    });
    expect(second.length).toBeLessThanOrEqual(PASSKEY_NAME_MAX_LENGTH);
    expect(second.endsWith(" (2)")).toBe(true);
    expect(second).toBe(`${"L".repeat(PASSKEY_NAME_MAX_LENGTH - 4)} (2)`);
  });

  it("re-truncates the base when the counter grows to two digits", () => {
    // The suffix width is derived, not hardcoded: " (10)" needs one more
    // character than " (2)". A hardcoded `- 4` passes every other test in this
    // file and produces a 65-character name here.
    const longLabel = "L".repeat(200);
    const base = derivePasskeyName({ deviceLabel: longLabel });
    const existing = [
      base,
      ...Array.from(
        { length: 8 },
        (_, index) =>
          `${"L".repeat(PASSKEY_NAME_MAX_LENGTH - 4)} (${index + 2})`,
      ),
    ];

    const tenth = derivePasskeyName({
      deviceLabel: longLabel,
      existingNames: existing,
    });
    expect(tenth.endsWith(" (10)")).toBe(true);
    expect(tenth.length).toBeLessThanOrEqual(PASSKEY_NAME_MAX_LENGTH);
    expect(tenth).toBe(`${"L".repeat(PASSKEY_NAME_MAX_LENGTH - 5)} (10)`);
  });

  it("never truncates through a surrogate pair", () => {
    // 63 ASCII chars + a 2-code-unit emoji: the cut lands mid-pair.
    const result = derivePasskeyName({
      deviceLabel: `${"a".repeat(63)}${FIRE_EMOJI}`,
    });
    expect(result).toBe("a".repeat(63));
    // No unpaired surrogate survived (invalid UTF-8 in the DB, U+FFFD in the UI).
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false);
  });

  // --- which END gives way when the composed name overflows the cap ---------
  // The device label is the part that carries the meaning: the scanner passes
  // app-qualified labels ("iPhone scanner", "Android scanner") so that a shared
  // or handed-off operator device is distinguishable from someone's personal
  // phone in the web passkey list. Cutting the composed string from the right
  // silently deletes the word "scanner", then "iPhone", destroying exactly that
  // signal. So the person NAME gives way and the label survives whole.
  describe("truncation keeps the device label, not the person name", () => {
    /** 59 characters — long, but a real length for a real human name. */
    const LONG_NAME =
      "Bartholomew Fitzwilliam Montgomery-Habersham the Third Esq.";
    const SCANNER_LABEL = "iPhone scanner";

    it("shortens the person name, not the device label", () => {
      const result = derivePasskeyName({
        userName: LONG_NAME,
        deviceLabel: SCANNER_LABEL,
      });

      // Overhead is 3 (the apostrophe + "s" + a space) plus the 14-character
      // label, leaving room for 47 characters of name.
      expect(result).toBe(
        `${LONG_NAME.slice(0, 47)}${APOSTROPHE}s ${SCANNER_LABEL}`,
      );
      expect(result).toHaveLength(PASSKEY_NAME_MAX_LENGTH);
      // The label survives INTACT, separator included — the word "scanner" is
      // the security signal and must not be shaved to "scan".
      expect(result.endsWith(`${APOSTROPHE}s ${SCANNER_LABEL}`)).toBe(true);
      // ...and the name is what got shortened, while still identifying the human.
      expect(result.startsWith("Bartholomew")).toBe(true);
      expect(result).not.toContain("Esq.");
    });

    it("still keeps the device label when the shortened name also collides", () => {
      const first = derivePasskeyName({
        userName: LONG_NAME,
        deviceLabel: SCANNER_LABEL,
      });
      const second = derivePasskeyName({
        userName: LONG_NAME,
        deviceLabel: SCANNER_LABEL,
        existingNames: [first],
      });

      // The suffix's 4 characters come out of the NAME as well, not the label:
      // budget 60, so 60 - 3 - 14 = 43 characters of name.
      expect(second).toBe(
        `${LONG_NAME.slice(0, 43)}${APOSTROPHE}s ${SCANNER_LABEL} (2)`,
      );
      expect(second.length).toBeLessThanOrEqual(PASSKEY_NAME_MAX_LENGTH);
      expect(second.endsWith(" (2)")).toBe(true);
      expect(second).toContain(`${APOSTROPHE}s ${SCANNER_LABEL}`);
    });

    it("degrades to the bare device label when no room is left for a name", () => {
      // 61 characters of label leaves 64 - 3 - 61 = 0 for the name: emit the
      // label alone rather than an orphaned "’s <label>" with an empty name.
      const label = "X".repeat(61);
      const result = derivePasskeyName({ userName: "Tom", deviceLabel: label });
      expect(result).toBe(label);
      expect(result).not.toContain(APOSTROPHE);
      expect(result).not.toContain("Tom");

      // 62 characters is the negative-room case — a naive `slice(0, -1)` here
      // would silently keep the LAST character of the name instead of the first.
      const negativeRoom = derivePasskeyName({
        userName: "Tom",
        deviceLabel: "Y".repeat(62),
      });
      expect(negativeRoom).toBe("Y".repeat(62));
      expect(negativeRoom.startsWith(`${APOSTROPHE}s `)).toBe(false);
      expect(negativeRoom).not.toContain(APOSTROPHE);
    });

    it("keeps a single character of the name at the boundary", () => {
      // 60 characters of label leaves exactly 1 for the name: 1 + 3 + 60 = 64.
      const label = "X".repeat(60);
      const result = derivePasskeyName({ userName: "Tom", deviceLabel: label });
      expect(result).toBe(`T${APOSTROPHE}s ${label}`);
      expect(result).toHaveLength(PASSKEY_NAME_MAX_LENGTH);
    });

    it("degrades rather than emitting a lone surrogate at the boundary", () => {
      // One code unit of room and a name that starts with an astral emoji: the
      // only character that would fit is half of a surrogate pair, which the
      // surrogate-safe truncation drops. That empties the name, so the result
      // must fall back to the bare label — not to "’s <label>".
      const result = derivePasskeyName({
        userName: `${FIRE_EMOJI}om`,
        deviceLabel: "X".repeat(60),
      });
      expect(result).toBe("X".repeat(60));
      expect(result).not.toContain(APOSTROPHE);
      expect(/[\uD800-\uDFFF]/u.test(result)).toBe(false);
    });

    it("never cuts the name through a surrogate pair", () => {
      // Room is 47; the emoji straddles code units 46-47.
      const result = derivePasskeyName({
        userName: `${"a".repeat(46)}${FIRE_EMOJI}`,
        deviceLabel: SCANNER_LABEL,
      });
      expect(result).toBe(`${"a".repeat(46)}${APOSTROPHE}s ${SCANNER_LABEL}`);
      expect(/[\uD800-\uDFFF]/u.test(result)).toBe(false);
    });

    it("keeps the trailing 'passkey' word for an over-long person name", () => {
      // Same rule with the literal tail: the name gives way, "’s passkey"
      // survives. 64 - 3 - 7 = 54 characters of name.
      const result = derivePasskeyName({ userName: "N".repeat(80) });
      expect(result).toBe(`${"N".repeat(54)}${APOSTROPHE}s passkey`);
      expect(result).toHaveLength(PASSKEY_NAME_MAX_LENGTH);
    });

    it("leaves names that fit comfortably completely alone", () => {
      // This is a tail-case fix; the ordinary path must be untouched.
      expect(
        derivePasskeyName({ userName: "Tom", deviceLabel: SCANNER_LABEL }),
      ).toBe(`Tom${APOSTROPHE}s iPhone scanner`);
      expect(
        derivePasskeyName({
          userName: "Tom",
          deviceLabel: SCANNER_LABEL,
          existingNames: [`Tom${APOSTROPHE}s iPhone scanner`],
        }),
      ).toBe(`Tom${APOSTROPHE}s iPhone scanner (2)`);
    });
  });

  it("returns a best-effort suffixed name when every slot is taken", () => {
    const existing = [
      "macOS",
      ...Array.from({ length: 98 }, (_, index) => `macOS (${index + 2})`),
    ];
    expect(
      derivePasskeyName({ deviceLabel: "macOS", existingNames: existing }),
    ).toBe("macOS (99)");
  });

  it("never returns an empty string", () => {
    for (const input of [
      {},
      { userName: "" },
      { deviceLabel: "" },
      { userName: " ", deviceLabel: ZERO_WIDTH_SPACE },
      { userName: LONE_LOW_SURROGATE, deviceLabel: LONE_HIGH_SURROGATE },
    ]) {
      expect(derivePasskeyName(input).length).toBeGreaterThan(0);
    }
  });
});
