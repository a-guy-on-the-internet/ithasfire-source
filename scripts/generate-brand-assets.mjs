/**
 * generate-brand-assets.mjs
 *
 * Regenerates every favicon, app-icon, splash, lockup and wallet-pass image
 * from the committed brand sources. Run it after any brand artwork change —
 * the raster assets are build output, not hand-edited files.
 *
 * Usage:  node scripts/generate-brand-assets.mjs
 *
 * Requires `sharp` (already in the monorepo dependency graph).
 *
 * ── TWO MARKS, BY SURFACE SIZE (temporary) ──────────────────────────────────
 *
 * The 2026-07 flame (`ithasfire-mark-{black,white}.svg`) is an illustration,
 * not an icon. Its defining feature — the thin rising branch — is ~2.5% of the
 * mark's width, so below ~64px it can't resolve as a line and renders as grey
 * mush; the interior counters close up below ~32px; and its 1:1.96 proportion
 * means it only ever fills half of a square container. It looks great large.
 *
 * So until an *icon cut* of it exists (branch thickened 3–4×, counters opened,
 * proportion pulled toward 1:1.3), assets are split:
 *
 *   EXPRESSIVE  ithasfire-mark-{black,white}.svg   the 2026-07 flame
 *               → lockups, splash screens, wallet logo. Anything that renders
 *                 large enough for the branch to read.
 *
 *   COMPACT     ithasfire-mark-compact.png         the previous flame
 *               → every square icon: favicon, app icons, PWA, CAB tile, QR
 *                 centre, wallet icon. Three thick shapes, generous counters,
 *                 near-square — it survives 16px.
 *
 * This is a known-temporary compromise: the two flames differ enough in
 * character to read as two brands if you look for it. Collapse back to ONE
 * source the moment the icon cut lands, by pointing the COMPACT targets below
 * at the new artwork and deleting ithasfire-mark-compact.png.
 *
 * ── Colour policy ───────────────────────────────────────────────────────────
 *   Web browser chrome (favicon / apple-icon / PWA)  ink on cream
 *     The web app is light-first (Stub). A dark glyph on transparent vanishes
 *     against a light tab strip, and iOS home-screen bookmarks have no
 *     background layer of their own.
 *   Native app icons (mobile + scanner)              white on black
 *     Both app.config.ts files already declare `backgroundColor: "#000000"`
 *     for splash and adaptiveIcon; the icons match that so there is no seam.
 *   Wallet passes + generic brand icon               white on transparent
 *     Apple/Google passes render on the steel-blue card (#35589a) with a white
 *     foreground — see apple-wallet-adapter.ts. Ink-on-cream would be wrong
 *     there, so these deliberately stay white.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "..");
const p = (rel) => path.join(ROOT, rel);

// ─── Palette ─────────────────────────────────────────────────────────────────
// Mirrors packages/ui/src/ui/tamagui/tokens/colors.ts → stubTheme. Kept as
// literals because this script runs outside the TS build graph.
const CREAM = { r: 0xf6, g: 0xf0, b: 0xe4, alpha: 1 }; // stub `background`
const INK = "#211C16"; //                                 stub `color`
const BLACK_BG = { r: 0, g: 0, b: 0, alpha: 1 };
const WHITE = "#FFFFFF";
const EMBER_ORANGE = "#FF5721"; // QR + CAB flame tile
const NONE = { r: 0, g: 0, b: 0, alpha: 0 };

// ─── Geometry ────────────────────────────────────────────────────────────────

/** Mark height as a fraction of a square icon canvas ("contain" fit). */
const ICON_FILL = 0.86;

/**
 * Android masks an adaptive icon's foreground to a circle of 66/108 of the
 * canvas. The largest w:h rect that fits inside that circle has
 * height = 0.611 / sqrt(1 + aspect²). Anything taller gets its tip and base
 * clipped on a Pixel launcher — which is what the previous adaptive-icon.png
 * (a byte copy of icon.png) did.
 */
const adaptiveFill = (aspect) => 0.611 / Math.sqrt(1 + aspect * aspect);

/**
 * Lockup: wordmark cap box / mark height. 0.55 reproduces the wordmark's
 * rendered size in the previous 341×80 lockup exactly, so moving the navbar to
 * the new artwork needs no layout change at the call sites.
 */
const LOCKUP_WORDMARK_RATIO = 0.55;
/** Gap between mark and wordmark, as a fraction of mark height. */
const LOCKUP_GAP = 0.2;

/**
 * Where the wordmark's optical centre sits, as a fraction of mark height.
 *
 * 0.605 is the centre of the flame *body* (the branch occupies the top ~21%).
 * Centring on the mark's bounding box instead leaves the wordmark visibly
 * floating high, because the branch pulls the bbox centre up.
 *
 * Deliberately a constant, not auto-detected: every "find where the body
 * starts" heuristic tried here (absolute run width, run width relative to the
 * mark's widest point) swung by 10+ points as the branch thickness changed,
 * which silently misaligns the lockup. This is a designed relationship — if
 * the artwork changes materially, eyeball it once and re-set it. The generator
 * prints it on every run so a stale value is visible.
 */
const LOCKUP_BODY_ANCHOR = 0.605;

/**
 * Minimum stroke width, in CSS px, for a thin feature to read as a line rather
 * than a smudge. Below ~1px it cannot resolve at all; 1.5px is comfortable.
 */
const MIN_LEGIBLE_STROKE_PX = 1.5;

// ─── Sources ─────────────────────────────────────────────────────────────────

const COMPACT_PATH = p("apps/web/public/brand/ithasfire-mark-compact.png");
const markSvgSource = fs.readFileSync(
  p("apps/web/public/brand/ithasfire-mark-black.svg"),
  "utf8",
);

/**
 * Stroke width applied to the expressive mark's outline, in viewBox units.
 *
 * The artwork ships at 1, which draws the rising branch at 0.55% of mark
 * height — sub-pixel at every surface it's used on, so it renders as a grey
 * smear rather than a line. Because the mark is a single compound path, the
 * only mechanical lever is the outline stroke, which thickens the branch and
 * fattens the (solid, filled) body harmlessly.
 *
 * Measured ceiling: at 22+ the branch fuses into the body and the counters
 * collapse. 15 takes the branch to ~0.82px at the 40px navbar lockup — 1.6–2.5
 * device px on the 2×/3× displays this ships to — while keeping counters at
 * ~21% of the body. It also reads better large.
 *
 * This is a RENDERING decision, deliberately not baked into
 * ithasfire-mark-*.svg, so the source stays as delivered. Set to 1 to get the
 * artwork verbatim. A proper fix redraws the branch thicker *relative* to the
 * body, which no uniform stroke can express — see the audit output.
 */
const EXPRESSIVE_STROKE = 15;

/** The expressive mark recoloured to an arbitrary hex, as an SVG buffer. */
const markSvg = (hex) =>
  Buffer.from(
    markSvgSource
      .replaceAll("#000000", hex)
      .replace(/stroke-width="[\d.]+"/, `stroke-width="${EXPRESSIVE_STROKE}"`),
  );

/**
 * Rasterise the expressive mark at an exact pixel height. `density` scales
 * librsvg's rasterisation so the vector is drawn at target resolution rather
 * than drawn at 96dpi and upsampled.
 */
const renderExpressive = (hex, height) =>
  sharp(markSvg(hex), { density: Math.ceil((96 * height) / 1054) })
    .resize({ height, fit: "contain", background: NONE })
    .png()
    .toBuffer();

/**
 * Rasterise the compact mark at an exact pixel height. The source is a white
 * silhouette, so recolouring means rebuilding the image as a solid fill masked
 * by the source's alpha rather than tinting pixels.
 */
async function renderCompact(hex, height) {
  const width = Math.round(height * compactAspect);
  const alpha = await sharp(COMPACT_PATH)
    .resize(width, height, { fit: "fill" })
    .extractChannel("alpha")
    .raw()
    .toBuffer();
  return sharp({
    create: { width, height, channels: 3, background: hex },
  })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

/** Dispatch by mark variant. `compact` for small squares, `expressive` for big. */
const renderMark = (variant, hex, height) =>
  variant === "compact"
    ? renderCompact(hex, height)
    : renderExpressive(hex, height);

const aspectOf = (variant) =>
  variant === "compact" ? compactAspect : expressive.aspect;

/**
 * Measure the expressive mark's geometry from the artwork itself, so dropping
 * in a redrawn SVG needs no code edits here.
 *
 * Returns:
 *   aspect     w/h of the inked area
 *   strokePct  the thinnest sustained feature (i.e. the branch) as a fraction
 *              of height. Measured as a horizontal run, so it OVERSTATES a
 *              diagonal stroke's true width — a failing audit is genuinely
 *              failing, a passing one is borderline.
 */
async function measureExpressive() {
  const H = 2000;
  const { data, info } = await sharp(await renderExpressive("#000000", H))
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  const runsIn = (y) => {
    const out = [];
    let start = null;
    for (let x = 0; x < w; x++) {
      const on = data[y * w + x] > 128;
      if (on && start === null) start = x;
      if (!on && start !== null) {
        out.push(x - start);
        start = null;
      }
    }
    if (start !== null) out.push(w - start);
    return out;
  };

  // Thinnest quartile of runs above the flame body — that's the branch. The
  // window is derived from LOCKUP_BODY_ANCHOR rather than by detecting where
  // the body starts, so it stays fixed no matter how thick the branch is drawn
  // (a detector moves as the branch grows, which made the metric meaningless).
  const branchBottom = h * (2 * LOCKUP_BODY_ANCHOR - 1);
  const branch = [];
  for (let y = Math.round(h * 0.02); y < branchBottom; y++)
    branch.push(...runsIn(y));
  branch.sort((a, b) => a - b);
  const q = branch.slice(0, Math.max(1, Math.floor(branch.length / 4)));
  const strokePx = q.length ? q[Math.floor(q.length / 2)] : 0;

  return { aspect: w / h, strokePct: strokePx / h };
}

/**
 * Warn when the expressive mark's thinnest feature won't resolve at a surface
 * it actually ships on. Silence here is the signal that a redraw landed well.
 */
function auditExpressive({ strokePct }) {
  // Mark height in CSS px at each surface the EXPRESSIVE mark is used on.
  const surfaces = [
    ["navbar lockup", 40],
    ["shell lockup", 32],
    ["wallet logo @1x", 50],
    ["splash (Embers)", 121],
  ];
  const fails = surfaces.filter(
    ([, mh]) => strokePct * mh < MIN_LEGIBLE_STROKE_PX,
  );
  console.log(
    `\nexpressive mark — thinnest feature ${(strokePct * 100).toFixed(2)}% of height`,
  );
  for (const [label, mh] of surfaces) {
    const px = strokePct * mh;
    const verdict =
      px >= MIN_LEGIBLE_STROKE_PX ? "ok" : px >= 1 ? "weak" : "FAILS";
    console.log(
      `  ${label.padEnd(18)} mark ${String(mh).padStart(4)}px → ${px.toFixed(2)}px  ${verdict}`,
    );
  }
  if (fails.length) {
    const need = MIN_LEGIBLE_STROKE_PX / Math.min(...fails.map(([, mh]) => mh));
    console.log(
      `  ⚠ thin features need ≥${(need * 100).toFixed(2)}% of mark height ` +
        `(${(need / strokePct).toFixed(1)}× current) to read on every surface above.`,
    );
  }
}

/**
 * Mark centred on a square canvas. Passing a `background` produces an opaque
 * RGB icon; passing `null` keeps the alpha channel.
 *
 * `keepAlpha` controls whether an opaque icon still carries a (redundant,
 * all-255) alpha channel. Neither default is universally safe:
 *   - App Store Connect REJECTS an iOS app icon carrying any alpha channel,
 *     even a fully-opaque one — so native icons must drop it. `flatten()`
 *     alone leaves the channel in place; `removeAlpha()` has to follow it.
 *   - Strict ICO decoders (e.g. the Rust `image` crate) REJECT a PNG-in-ICO
 *     entry that isn't 32-bit RGBA — so favicon.ico entries must keep it.
 */
async function squareIcon({
  size,
  hex,
  background,
  variant = "compact",
  fill = ICON_FILL,
  keepAlpha = false,
}) {
  const markHeight = Math.round(size * fill);
  const mark = await renderMark(variant, hex, markHeight);
  const img = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: background ?? NONE,
    },
  }).composite([{ input: mark, gravity: "centre" }]);
  if (!background) return img.png().toBuffer();
  const flat = img.flatten({ background });
  return (keepAlpha ? flat.ensureAlpha() : flat.removeAlpha()).png().toBuffer();
}

const write = (rel, buf) => {
  fs.mkdirSync(path.dirname(p(rel)), { recursive: true });
  fs.writeFileSync(p(rel), buf);
  console.log(`  ✔ ${rel}  (${(buf.length / 1024).toFixed(1)} kB)`);
};

/**
 * Minimal PNG-in-ICO container. sharp can't write ICO, and every browser we
 * support (and Windows Vista+) reads PNG-compressed ICO entries, so we emit
 * the directory by hand rather than pulling in a dependency for 6 bytes of
 * header.
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette size
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
}

// ─── Lockup ──────────────────────────────────────────────────────────────────

/**
 * Expressive flame + wordmark, transparent background. Consumers (AppNavbar,
 * the seller/platform/admin shells) render this at a fixed height with
 * `width: auto`, so the canvas carries no padding — spacing is the navbar's job.
 */
async function buildLockup(variant) {
  const hex = variant === "white" ? WHITE : "#000000";
  // 2× the wordmark's native 80px height. It's the only raster source left in
  // the lockup pipeline and therefore its resolution ceiling; a vector
  // wordmark would let this go to 3×+.
  const wordmarkHeight = 160;
  const markHeight = Math.round(wordmarkHeight / LOCKUP_WORDMARK_RATIO);
  const gap = Math.round(markHeight * LOCKUP_GAP);

  const markBuf = await renderExpressive(hex, markHeight);
  const markWidth = Math.round(markHeight * expressive.aspect);

  const wordmarkSrc = p(
    `apps/web/public/brand/ithasfire-wordmark-${variant}.png`,
  );
  const wordmark = await sharp(wordmarkSrc)
    .trim()
    .resize({ height: wordmarkHeight, fit: "contain", background: NONE })
    .png()
    .toBuffer();
  const { width: wordmarkWidth } = await sharp(wordmark).metadata();

  // Centre the wordmark on the flame BODY, not on the mark's bounding box —
  // the branch pulls the bbox centre up and leaves the wordmark floating.
  const wordmarkTop = Math.round(
    markHeight * LOCKUP_BODY_ANCHOR - wordmarkHeight / 2,
  );

  return sharp({
    create: {
      width: markWidth + gap + wordmarkWidth,
      height: markHeight,
      channels: 4,
      background: NONE,
    },
  })
    .composite([
      { input: markBuf, left: 0, top: 0 },
      { input: wordmark, left: markWidth + gap, top: wordmarkTop },
    ])
    .png()
    .toBuffer();
}

// ─── Generated TypeScript ────────────────────────────────────────────────────

const b64Module = (header, consts) =>
  `${header}\n${consts
    .map(
      ([name, buf]) =>
        `export const ${name} = Buffer.from(\n  "${buf.toString("base64")}",\n  "base64",\n);`,
    )
    .join("\n\n")}\n`;

// ─── Main ────────────────────────────────────────────────────────────────────

let compactAspect;
let expressive;

async function generate() {
  const meta = await sharp(COMPACT_PATH).metadata();
  compactAspect = meta.width / meta.height;
  console.log(
    `compact mark ${meta.width}×${meta.height} (aspect ${compactAspect.toFixed(4)})`,
  );

  // Geometry is measured, not hardcoded — drop in a redrawn SVG and the lockup
  // realigns itself. The audit reports whether the redraw is thick enough.
  expressive = await measureExpressive();
  console.log(
    `expressive mark aspect ${expressive.aspect.toFixed(4)}, ` +
      `stroke ${EXPRESSIVE_STROKE}, lockup anchor ${(LOCKUP_BODY_ANCHOR * 100).toFixed(1)}%`,
  );
  auditExpressive(expressive);

  console.log("\nWeb — browser chrome  [compact, ink on cream]");
  const icoEntries = await Promise.all(
    [16, 32, 48, 64].map(async (size) => ({
      size,
      // RGBA required: see the `keepAlpha` note on squareIcon.
      data: await squareIcon({
        size,
        hex: INK,
        background: CREAM,
        keepAlpha: true,
      }),
    })),
  );
  write("apps/web/src/app/favicon.ico", buildIco(icoEntries));
  write(
    "apps/web/src/app/icon.png",
    await squareIcon({ size: 32, hex: INK, background: CREAM }),
  );
  write(
    "apps/web/src/app/apple-icon.png",
    // No alpha: iOS composites home-screen icons over nothing.
    await squareIcon({ size: 180, hex: INK, background: CREAM }),
  );
  for (const size of [192, 512]) {
    write(
      `apps/web/public/icons/icon-${size}.png`,
      await squareIcon({ size, hex: INK, background: CREAM }),
    );
  }

  console.log("\nWeb — brand marks  [compact, white on transparent]");
  for (const size of [512, 1024, 2048]) {
    write(
      `apps/web/public/brand/ithasfire-icon-${size}.png`,
      await squareIcon({ size, hex: WHITE, background: null }),
    );
  }
  // Natural-aspect marks (no square canvas). 3× the largest rendered size so
  // they stay crisp on a 3× display; HearthFlame draws at 26px.
  write(
    "apps/web/public/brand/hearth-flame-mark.png",
    await renderCompact(WHITE, 198),
  );
  write(
    "apps/web/public/brand/hearth-flame-mark-orange.png",
    await renderCompact(EMBER_ORANGE, 198),
  );

  console.log("\nWeb — lockups  [expressive]");
  const lockupBlack = await buildLockup("black");
  const lockupWhite = await buildLockup("white");
  write("apps/web/public/brand/ithasfire-lockup-black.png", lockupBlack);
  write("apps/web/public/brand/ithasfire-lockup-white.png", lockupWhite);

  console.log(
    "\nNative — mobile + scanner  [compact icons, expressive splash]",
  );
  for (const app of ["mobile", "scanner"]) {
    write(
      `apps/${app}/assets/icon.png`,
      await squareIcon({ size: 1024, hex: WHITE, background: BLACK_BG }),
    );
    write(
      `apps/${app}/assets/adaptive-icon.png`,
      // Transparent foreground — Android supplies the backdrop from
      // android.adaptiveIcon.backgroundColor. Sized to the circular safe zone.
      await squareIcon({
        size: 1024,
        hex: WHITE,
        background: null,
        fill: adaptiveFill(aspectOf("compact")),
      }),
    );
    write(
      `apps/${app}/assets/splash-icon.png`,
      // Transparent: the JS splash (@th/ui Embers) re-tints this silhouette via
      // `tintColor`, so only the alpha channel is meaningful there. Renders
      // large, so it gets the expressive mark.
      await squareIcon({
        size: 1024,
        hex: WHITE,
        background: null,
        variant: "expressive",
      }),
    );
    write(
      `apps/${app}/assets/favicon.png`,
      await squareIcon({ size: 48, hex: WHITE, background: BLACK_BG }),
    );
  }
  // scanner only — app.config.ts points ios.icon here precisely because the
  // shared icon.png used to carry alpha.
  write(
    "apps/scanner/assets/icon-ios.png",
    await squareIcon({ size: 1024, hex: WHITE, background: BLACK_BG }),
  );

  console.log("\nGenerated TypeScript");
  // Apple Wallet pass images — white, transparent, over the steel-blue card.
  // The icons are 29–87px, so they take the compact mark; the logo is the
  // wide lockup.
  const passIcon = (size) => squareIcon({ size, hex: WHITE, background: null });
  const passLogo = async (w, h) =>
    sharp(lockupWhite)
      .resize({ width: w, height: h, fit: "contain", background: NONE })
      .png()
      .toBuffer();
  write(
    "packages/adapters/src/wallet-pass/apple-pass-images.ts",
    Buffer.from(
      b64Module(
        `// Auto-generated by scripts/generate-brand-assets.mjs — do not edit by hand.\n` +
          `// Sized to the Apple Wallet spec. White on transparent: passes render on\n` +
          `// the steel-blue card (#35589a) with a white foreground — see\n` +
          `// apple-wallet-adapter.ts.\n` +
          `import { Buffer } from "node:buffer";\n`,
        [
          ["ICON_1X", await passIcon(29)],
          ["ICON_2X", await passIcon(58)],
          ["ICON_3X", await passIcon(87)],
          ["LOGO_1X", await passLogo(160, 50)],
          ["LOGO_2X", await passLogo(320, 100)],
        ],
      ) +
        `\nexport const PASS_IMAGES: Record<string, Buffer> = {\n` +
        `  "icon.png": ICON_1X,\n` +
        `  "icon@2x.png": ICON_2X,\n` +
        `  "icon@3x.png": ICON_3X,\n` +
        `  "logo.png": LOGO_1X,\n` +
        `  "logo@2x.png": LOGO_2X,\n};\n`,
    ),
  );

  // The standalone QR page inlines the flame because its CSP is
  // `default-src 'none'` — an external href would be blocked. It renders ~30px
  // in the QR centre, so: compact.
  const qrMark = await renderCompact(EMBER_ORANGE, 66);
  write(
    "apps/web/src/app/tickets/qr/[code]/flame-mark.ts",
    Buffer.from(
      `// Auto-generated by scripts/generate-brand-assets.mjs — do not edit by hand.\n` +
        `// Base64 of the warm-orange (${EMBER_ORANGE}) compact flame mark, inlined so\n` +
        `// the standalone QR SVG can embed it under a strict \`default-src 'none'\`\n` +
        `// CSP where an external href would not load.\n` +
        `export const FLAME_MARK_PNG_BASE64 =\n  "${qrMark.toString("base64")}";\n` +
        `\n/** Aspect (w/h) of the mark above — callers size the excavation pad from it. */\n` +
        `export const FLAME_MARK_ASPECT = ${compactAspect.toFixed(4)};\n`,
    ),
  );

  console.log("\nDone.");
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
