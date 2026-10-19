import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  buildDateStubElement,
  formatStubDateParts,
  OG_HEIGHT,
  OG_WIDTH,
} from "../date-stub";
import {
  loadOgFonts,
  OG_FONT_DIR,
  OG_FONT_SPECS,
  renderDateStubResponse,
} from "../render";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Reads width/height out of a PNG's IHDR (bytes 16..24, big-endian). */
const readPngSize = (bytes: Buffer) => {
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const renderToPng = async (
  props: Parameters<typeof renderDateStubResponse>[0],
): Promise<Buffer> => {
  const response = await renderDateStubResponse(props);
  return Buffer.from(await response.arrayBuffer());
};

/**
 * The body column's inner box — everything right of the perforation.
 *
 * The stub column is 34% of 1200 = 408 (border included), so anything from 408
 * rightwards is the white panel; `+ 48` is the body's own horizontal padding.
 * Sampling only here is what keeps `textBands` measuring TEXT: the date column
 * is now a filled accent field, so every one of its 630 rows has "ink" in it.
 */
const BODY_LEFT = 408 + 48;
const BODY_RIGHT = OG_WIDTH - 48;
/**
 * Below this sits the bottom block — the place line, pinned to the foot of the
 * body while the title block takes the free space above it.
 *
 * MEASURED, not derived. Lowest title ink across every fixture here: y=453
 * (three lines centred above a place line) and y=479 (three lines centred in
 * the WHOLE body, no place line). The place line's own ink starts at y=536.
 * 495 sits in that gap with ~40px of margin on both sides.
 */
const BOTTOM_BLOCK_TOP = 495;

type Band = { top: number; bottom: number };

/**
 * Contiguous runs of rows that contain ink inside the body column — i.e. the
 * rendered LINE BOXES.
 *
 * Asserting on these is the point. The previous version of the truncation test
 * asserted only that the PNG was 1200x630, which `ImageResponse` is CONSTRUCTED
 * with: it passed just as happily with `lineClamp` deleted. A test that cannot
 * fail is worse than no test, because it is counted.
 */
const textBands = (bytes: Buffer): Band[] => {
  const png = PNG.sync.read(bytes);
  const bands: Band[] = [];
  let start: number | null = null;

  for (let y = 0; y < png.height; y += 1) {
    let hasInk = false;
    for (let x = BODY_LEFT; x < BODY_RIGHT; x += 1) {
      const i = (png.width * y + x) << 2;
      const [r, g, b, a] = [
        png.data[i] as number,
        png.data[i + 1] as number,
        png.data[i + 2] as number,
        png.data[i + 3] as number,
      ];
      if (a > 16 && (r < 200 || g < 200 || b < 200)) {
        hasInk = true;
        break;
      }
    }
    if (hasInk && start === null) start = y;
    if (!hasInk && start !== null) {
      bands.push({ top: start, bottom: y - 1 });
      start = null;
    }
  }
  if (start !== null) bands.push({ top: start, bottom: png.height - 1 });
  return bands;
};

/** Title line boxes: everything above the bottom block. */
const titleLines = (bands: Band[]): Band[] =>
  bands.filter((band) => band.bottom < BOTTOM_BLOCK_TOP);

const bottomBlock = (bands: Band[]): Band[] =>
  bands.filter((band) => band.top >= BOTTOM_BLOCK_TOP);

// Satori + resvg is genuinely slow on a cold module graph.
const RENDER_TIMEOUT_MS = 30_000;

describe("OG fonts", () => {
  it("ships all four faces at the weights the stub registers", () => {
    const dir = path.join(process.cwd(), OG_FONT_DIR);
    for (const spec of OG_FONT_SPECS) {
      const file = path.join(dir, spec.file);
      expect(existsSync(file), `${spec.file} is missing`).toBe(true);

      const bytes = readFileSync(file);
      // OS/2 table: `usWeightClass` is a uint16 at offset 4 of the table.
      // Reading it proves the file really is the weight we register it as,
      // rather than a same-named copy of another cut.
      const numTables = bytes.readUInt16BE(4);
      let os2Offset: number | null = null;
      let hasFvar = false;
      for (let i = 0; i < numTables; i += 1) {
        const rec = 12 + i * 16;
        const tag = bytes.subarray(rec, rec + 4).toString("latin1");
        if (tag === "OS/2") os2Offset = bytes.readUInt32BE(rec + 8);
        // `fvar` is present on VARIABLE fonts only — Satori will not instance
        // a weight axis, so a variable file here would silently render one cut.
        if (tag === "fvar") hasFvar = true;
      }
      expect(os2Offset, `${spec.file} has no OS/2 table`).not.toBeNull();
      expect(hasFvar, `${spec.file} is a VARIABLE font`).toBe(false);
      expect(bytes.readUInt16BE((os2Offset as number) + 4)).toBe(spec.weight);
    }
  });

  it("memoises the buffers across calls", async () => {
    const first = await loadOgFonts();
    const second = await loadOgFonts();
    expect(second).toBe(first);
    expect(first).toHaveLength(4);
  });
});

describe("formatStubDateParts", () => {
  it("formats in the venue's zone, not the machine's", () => {
    // 2026-03-01T02:00Z is still Feb 28 in Los Angeles. Asserting the LA answer
    // (not `new Date().getTimezoneOffset()`) keeps this independent of where
    // the test runs.
    const parts = formatStubDateParts(
      new Date("2026-03-01T02:00:00.000Z"),
      "America/Los_Angeles",
    );
    expect(parts).toEqual({ month: "FEB", day: "28", weekday: "SAT" });
  });

  it("falls back to UTC for an absent or bogus zone", () => {
    const utc = formatStubDateParts(new Date("2026-03-01T02:00:00.000Z"), null);
    expect(utc).toEqual({ month: "MAR", day: "1", weekday: "SUN" });
    expect(
      formatStubDateParts(
        new Date("2026-03-01T02:00:00.000Z"),
        "Not/A_Real_Zone",
      ),
    ).toEqual(utc);
  });

  it("returns null for missing or unparseable dates", () => {
    expect(formatStubDateParts(null)).toBeNull();
    expect(formatStubDateParts(undefined)).toBeNull();
    expect(formatStubDateParts(new Date("nonsense"))).toBeNull();
    expect(formatStubDateParts("not-a-date")).toBeNull();
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(formatStubDateParts("2026-07-04T18:00:00.000Z", "UTC")).toEqual({
      month: "JUL",
      day: "4",
      weekday: "SAT",
    });
  });
});

describe("Date Stub render", () => {
  it(
    "produces a 1200x630 PNG for an ordinary event",
    async () => {
      const png = await renderToPng({
        title: "Sunset Session Vol. 03",
        startsAt: new Date("2026-09-20T18:00:00.000Z"),
        timezone: "America/Los_Angeles",
        venueLine: "Skyline Rooftop \u00b7 Los Angeles, CA",
      });
      expect(readPngSize(png)).toEqual({ width: OG_WIDTH, height: OG_HEIGHT });
      expect(png.byteLength).toBeGreaterThan(1000);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "fills the date column and leaves the body panel clean",
    async () => {
      // The single biggest thing the redesign changed, and the one thing a
      // band count cannot see: the stub column is now a FILLED accent field
      // with white type, not a white column with accent type. Sampled from
      // decoded pixels rather than from the element tree, because a Satori
      // style it silently drops would still be in the tree.
      const png = PNG.sync.read(
        await renderToPng({
          title: "Sunset Session Vol. 03",
          startsAt: new Date("2026-09-20T18:00:00.000Z"),
          timezone: "America/Los_Angeles",
            venueLine: "Skyline Rooftop \u00b7 Los Angeles, CA",
        }),
      );
      const at = (x: number, y: number) => {
        const i = (png.width * y + x) << 2;
        return [png.data[i], png.data[i + 1], png.data[i + 2]] as number[];
      };

      // `structure` / `onStructure` from the token file: ink #211C16 behind
      // paper #FDFAF3. Stub theme — the app's default — NOT swiss.
      const [r, g, b] = at(40, 40) as [number, number, number];
      expect([r, g, b]).toEqual([0x21, 0x1c, 0x16]);
      // Top-left of the body is the panel, unpainted.
      expect(at(700, 20)).toEqual([0xfd, 0xfa, 0xf3]);

      // The perforation is a DASHED rule in the panel colour ON that field:
      // scanning the column's last few pixels finds both paper dashes and ink
      // gaps. A solid rule, or no rule, fails one half or the other.
      const edge = 408 - 3;
      let paper = 0;
      let fill = 0;
      for (let y = 0; y < OG_HEIGHT; y += 1) {
        const [pr, pg, pb] = at(edge, y) as [number, number, number];
        if (pr > 240 && pg > 240 && pb > 240) paper += 1;
        if (pr === 0x21 && pg === 0x1c && pb === 0x16) fill += 1;
      }
      expect(paper).toBeGreaterThan(50);
      expect(fill).toBeGreaterThan(50);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "clamps a very long title to three line boxes and keeps the place line on the canvas",
    async () => {
      const bands = textBands(
        await renderToPng({
          title:
            "An Extremely Long Event Title That Would Absolutely Overflow The Available Column If Nothing Clamped It, Featuring A Great Many Words And Then Several More Just To Be Certain",
          startsAt: new Date("2026-12-31T23:30:00.000Z"),
          timezone: "America/New_York",
          venueLine:
            "The Exceedingly Verbose Memorial Amphitheatre And Community Performance Annexe, East Wing, Second Floor \u00b7 Nashville, TN",
        }),
      );

      // It really did wrap (so the fixture is long enough to be a test)…
      expect(titleLines(bands).length).toBeGreaterThan(1);
      // …and `lineClamp: 3` really did stop it.
      expect(titleLines(bands)).toHaveLength(3);
      // The composition survives: the place line is still drawn at the foot of
      // the body. Exactly one band down there — the wordmark row and its accent
      // rule are gone with the redesign.
      expect(bottomBlock(bands)).toHaveLength(1);

      // Three title lines + the place line, and nothing else.
      expect(bands).toHaveLength(4);
      // And nothing reaches the body's 52px bottom padding, let alone the edge.
      expect(Math.max(...bands.map((band) => band.bottom))).toBeLessThanOrEqual(
        OG_HEIGHT - 52,
      );

      // ── PROVEN TO BITE ──────────────────────────────────────────────────
      // Deleting `lineClamp: 3` and re-running fails this test on the
      // `toHaveLength(3)` above (4 title lines), and would also fail the two
      // assertions immediately above. Measured unclamped:
      //   71-161 | 185-271 | 286-362 | 401-472 | 511-601 | 620-629
      // — six bands, the last running into the bottom edge of the canvas, and
      // the place line pushed off it entirely.
      //
      // Worth knowing: under the PREVIOUS top-anchored layout none of these
      // bit on their own. The surplus lines slid past `BOTTOM_BLOCK_TOP`, so
      // `titleLines` still counted three and `bottomBlock` still counted one —
      // they just counted different bands. Centring the title block is what
      // keeps the overflow inside the region these assertions look at.
      // And the frame is still the frame.
      expect(
        readPngSize(
          await renderToPng({
            title: "x",
            startsAt: new Date("2026-12-31T23:30:00.000Z"),
          }),
        ),
      ).toEqual({ width: OG_WIDTH, height: OG_HEIGHT });
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "leaves a short title on a single line",
    async () => {
      const bands = textBands(
        await renderToPng({
          // Short enough to be genuinely one line at the 96px title measure
          // (696px inner / 7.25 ems), which is the point of the assertion.
          title: "Open Mic",
          startsAt: new Date("2026-12-31T23:30:00.000Z"),
          timezone: "America/New_York",
            venueLine: "Skyline Rooftop \u00b7 Nashville, TN",
        }),
      );

      // The clamp is a ceiling, not a layout: a short title must not gain
      // phantom lines, which is what distinguishes "clamped" from "cropped".
      expect(titleLines(bands)).toHaveLength(1);
      expect(bottomBlock(bands)).toHaveLength(1);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "drops the place line entirely when nothing about the place is public",
    async () => {
      // The population this feature serves: a community listing at an
      // unconfirmed venue, where `location.name` is withheld. `City, ST` keeps
      // the line alive; with neither, the foot of the body is simply empty and
      // nothing stands in for it.
      const withPlace = textBands(
        await renderToPng({
          title: "Comedy Night at Larry's",
          startsAt: new Date("2026-09-14T01:30:00.000Z"),
          timezone: "America/Chicago",
          venueLine: "Nashville, TN",
        }),
      );
      const withNothing = textBands(
        await renderToPng({
          title: "Comedy Night at Larry's",
          startsAt: new Date("2026-09-14T01:30:00.000Z"),
          timezone: "America/Chicago",
          venueLine: null,
        }),
      );

      expect(bottomBlock(withPlace)).toHaveLength(1);
      expect(bottomBlock(withNothing)).toHaveLength(0);
      // Nothing stands in for an undisclosed place: the title block simply
      // takes the whole body and centres in it, which is the same rule the
      // other cases follow rather than a second layout.
      expect(titleLines(withNothing).length).toBeGreaterThan(0);
    },
    RENDER_TIMEOUT_MS,
  );

  it.each([
    ["null startsAt", { title: "No date", startsAt: null }],
    ["undefined startsAt", { title: "No date", startsAt: undefined }],
    ["an Invalid Date", { title: "Bad date", startsAt: new Date("garbage") }],
    [
      "a bogus timezone",
      {
        title: "Bad zone",
        startsAt: new Date("2026-05-05T12:00:00.000Z"),
        timezone: "Mars/Olympus_Mons",
      },
    ],
    [
      "an empty title",
      { title: "", startsAt: new Date("2026-05-05T12:00:00.000Z") },
    ],
    [
      "a missing venue",
      {
        title: "Venueless",
        startsAt: new Date("2026-05-05T12:00:00.000Z"),
        venueLine: null,
      },
    ],
  ])(
    "still renders a valid 1200x630 PNG with %s",
    async (_label, props) => {
      const png = await renderToPng(props);
      expect(readPngSize(png)).toEqual({ width: OG_WIDTH, height: OG_HEIGHT });
    },
    RENDER_TIMEOUT_MS,
  );

  it("builds an element tree with an explicit display on every branch", () => {
    // Satori mis-draws (silently) when a multi-child node has no explicit
    // `display`, and defaults `flexDirection` to `row` unlike React Native.
    // Walking the tree is cheaper than eyeballing every render.
    const tree = buildDateStubElement({
      title: "Check the tree",
      startsAt: new Date("2026-05-05T12:00:00.000Z"),
      venueLine: "Somewhere \u00b7 Nashville, TN",
    });

    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const el = node as {
        props?: { style?: Record<string, unknown>; children?: unknown };
      };
      const props = el.props;
      if (!props) return;
      const children = props.children;
      const childCount = Array.isArray(children)
        ? children.filter(Boolean).length
        : children
          ? 1
          : 0;
      const style = props.style ?? {};
      if (childCount > 1) {
        expect(style.display).toBeDefined();
        // Only meaningful once a node actually stacks siblings — a leaf holding
        // one text run is unaffected by the row/column default.
        expect(style.flexDirection).toBeDefined();
      }
      if (Array.isArray(children)) children.forEach(visit);
      else visit(children);
    };

    visit(tree);
  });

  it("draws NO caption row", () => {
    // `eventStubCaption` is inert (see `@th/types`), and the element tree has
    // no caption node at all — the body is the artifact's card html, title over
    // place line. Asserted on the tree because "an absent row" has no pixels to
    // look for, and this is the regression that would come back the day someone
    // wires a category up without reading why the row was dropped.
    const texts: string[] = [];
    const visit = (node: unknown): void => {
      if (typeof node === "string") {
        texts.push(node);
        return;
      }
      if (!node || typeof node !== "object") return;
      const children = (node as { props?: { children?: unknown } }).props
        ?.children;
      if (Array.isArray(children)) children.forEach(visit);
      else visit(children);
    };
    visit(
      buildDateStubElement({
        title: "No eyebrow",
        startsAt: new Date("2026-09-10T18:00:00.000Z"),
        timezone: "America/Chicago",
        venueLine: "Carol Ann's \u00b7 Nashville, TN",
      }),
    );

    expect(texts).toEqual([
      "THU",
      "10",
      "SEP",
      "No eyebrow",
      "Carol Ann's \u00b7 Nashville, TN",
    ]);
  });

  it("draws the date labels in DOW / DD / MO order", () => {
    // The artifact reverses `DateBlock`'s MO / DD / DOW. Read off the tree
    // because the rendered pixels cannot tell "THU" from "SEP" by band shape.
    const texts: string[] = [];
    const visit = (node: unknown): void => {
      if (typeof node === "string") {
        texts.push(node);
        return;
      }
      if (!node || typeof node !== "object") return;
      const children = (node as { props?: { children?: unknown } }).props
        ?.children;
      if (Array.isArray(children)) children.forEach(visit);
      else visit(children);
    };
    visit(
      buildDateStubElement({
        title: "Order check",
        // 2026-09-10T18:00Z is a Thursday in Chicago.
        startsAt: new Date("2026-09-10T18:00:00.000Z"),
        timezone: "America/Chicago",
      }),
    );

    expect(texts.slice(0, 3)).toEqual(["THU", "10", "SEP"]);
  });
});
