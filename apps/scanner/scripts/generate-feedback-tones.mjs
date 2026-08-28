#!/usr/bin/env node
/**
 * Synthesizes the four scan-outcome tones bundled with the scanner
 * (`apps/scanner/assets/audio/*.wav`).
 *
 * Why a generator and not four checked-in sound-design files: the tones must
 * be tiny (they ship in the binary), deterministic, and — critically —
 * *provably* distinct from one another. FR-002 of
 * docs/specs/2026-08-04/scan-ticket-redesign.spec.yaml replaces one ~40-byte
 * click replayed at three playback rates, which was indistinguishable over a
 * venue PA. Distinctness here is designed on two axes at once:
 *
 *   valid           2 notes, ASCENDING, high      (880 → 1320 Hz)
 *   already_scanned 2 notes, SAME pitch, mid      (660, 660 Hz) — "seen it"
 *   wrong_event     1 note,  LONG, low-mid        (392 Hz)
 *   rejected        3 notes, DESCENDING, low      (330 → 262 → 196 Hz)
 *
 * A door operator in the dark can tell 2-up from 2-flat from 1-long from
 * 3-down by rhythm alone, before pitch even registers — which is the point:
 * over a loud PA the low frequencies are the first thing masked.
 *
 * Each partial is a sine plus a 3rd-harmonic at 22% to give the tone some
 * bite through crowd noise without turning it into a square-wave rasp, with
 * a short raised-cosine attack/release so nothing clicks.
 *
 * Output: 22.05 kHz, mono, 16-bit PCM WAV. ~5-12 KB per file.
 *
 * Run: node apps/scanner/scripts/generate-feedback-tones.mjs
 * Re-run only if you change the tone design — the WAVs are committed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 22_050;
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "assets", "audio");

/** @typedef {{ freq: number, ms: number, gain?: number }} Note */
/** @typedef {{ notes: Note[], gapMs: number }} ToneSpec */

/** @type {Record<string, ToneSpec>} */
const TONES = {
  // Admit. Bright, rising, over fast — the sound you hear a thousand times
  // a night, so it stays short and unfatiguing.
  valid: {
    gapMs: 0,
    notes: [
      { freq: 880, ms: 70 },
      { freq: 1320, ms: 110 },
    ],
  },
  // Already scanned. Two identical mid pulses with an audible gap between
  // them — a literal "again" rhythm, matching the double-pulse haptic.
  already_scanned: {
    gapMs: 70,
    notes: [
      { freq: 660, ms: 80 },
      { freq: 660, ms: 80 },
    ],
  },
  // Wrong event. One long low-mid note. Nothing else in the set is a single
  // sustained tone, so it reads as "stop and look" without sounding like a
  // failure.
  wrong_event: {
    gapMs: 0,
    notes: [{ freq: 392, ms: 300 }],
  },
  // Rejected / unreadable. Three descending low notes — the universal
  // "nope" cadence, and the only tone in the set with three onsets.
  rejected: {
    gapMs: 25,
    notes: [
      { freq: 330, ms: 80 },
      { freq: 262, ms: 80 },
      { freq: 196, ms: 130 },
    ],
  },
};

const HARMONIC_MIX = 0.22;
const PEAK = 0.72;

/** Raised-cosine attack/release envelope, clamped for very short notes. */
function envelope(i, total) {
  const edge = Math.min(
    Math.floor(total * 0.25),
    Math.floor(SAMPLE_RATE * 0.012),
  );
  if (edge <= 0) return 1;
  if (i < edge) return 0.5 - 0.5 * Math.cos((Math.PI * i) / edge);
  if (i > total - edge) {
    const j = total - i;
    return 0.5 - 0.5 * Math.cos((Math.PI * j) / edge);
  }
  return 1;
}

/** @param {ToneSpec} spec */
function renderSamples(spec) {
  /** @type {number[]} */
  const out = [];
  spec.notes.forEach((note, index) => {
    const count = Math.round((note.ms / 1000) * SAMPLE_RATE);
    for (let i = 0; i < count; i += 1) {
      const t = i / SAMPLE_RATE;
      const base = Math.sin(2 * Math.PI * note.freq * t);
      const third = Math.sin(2 * Math.PI * note.freq * 3 * t) * HARMONIC_MIX;
      const amp = (note.gain ?? 1) * PEAK * envelope(i, count);
      out.push(((base + third) / (1 + HARMONIC_MIX)) * amp);
    }
    if (spec.gapMs > 0 && index < spec.notes.length - 1) {
      const silence = Math.round((spec.gapMs / 1000) * SAMPLE_RATE);
      for (let i = 0; i < silence; i += 1) out.push(0);
    }
  });
  return out;
}

/** @param {number[]} samples */
function toWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => {
    const clamped = Math.max(-1, Math.min(1, s));
    data.writeInt16LE(Math.round(clamped * 32_767), i * 2);
  });

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, spec] of Object.entries(TONES)) {
  const wav = toWav(renderSamples(spec));
  const file = join(OUT_DIR, `${name}.wav`);
  writeFileSync(file, wav);
  // eslint-disable-next-line no-console
  console.log(
    `wrote ${file} (${wav.length} bytes, ${spec.notes.length} note(s))`,
  );
}
