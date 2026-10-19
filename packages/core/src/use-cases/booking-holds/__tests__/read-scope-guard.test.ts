import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// NFR-001 — BookingHold is read by EXACTLY the surfaces in FR-011..014.
//
// Public place page, embeds, search, stats, availability and sitemap must
// never read the hold table. This greps core for `bookingHolds` and fails on
// any module outside the allow-list below, so a future public read cannot
// quietly appear. Extend the list deliberately, with the spec FR it serves.
// ─────────────────────────────────────────────────────────────────────────────

const CORE_SRC = join(__dirname, "..", "..", "..");

// The platform merge of two duplicate places (ADMIN only). It lives under
// `use-cases/places`, a public-surface folder, so the public-surface check
// below exempts exactly these files and nothing else in that folder.
const PLACE_MERGE_FILES = [
  "use-cases/places/merge-places.ts",
  "use-cases/places/preview-place-merge.ts",
  "use-cases/places/_shared/place-merge-plan.ts",
];

const ALLOWED_PREFIXES = [
  // The hold use cases + their shared helpers (FR-002..FR-010, FR-012/13).
  "use-cases/booking-holds/",
  // FR-009: request closure releases holds (decline / withdraw / expire).
  "use-cases/booking-requests/respond-to-booking-request.ts",
  "use-cases/booking-requests/withdraw-booking-request.ts",
  "use-cases/booking-requests/expire-booking-requests.ts",
  // FR-011 / FR-013: the inbox + sent-list projection.
  "use-cases/booking-requests/list-booking-requests.ts",
  // FR-014: the ADMIN calendar overlays (the public branches never call it).
  "use-cases/events/_shared/booking-hold-overlay.ts",
  "use-cases/events/get-venue-calendar.ts",
  "use-cases/events/get-calendar-events.ts",
  // booking-the-night FR-002 / FR-003: the terms editor's send checks the
  // night's line (N6) and defaults the night to the request's position-1
  // hold. Both are gated on the terms editor before any hold is read.
  "use-cases/booking-agreements/send-booking-agreement-for-review.ts",
  "use-cases/booking-agreements/send-booking-terms.ts",
  // booking-the-night NFR-001 (review W1 / W2): the manual "Create event"
  // reads this request's holds and the night's line (under its lock) before
  // minting. Venue-side authority is checked before it runs.
  "use-cases/booking-agreements/create-event-from-agreement.ts",
  // booking-the-night P2c. FR-010: the exits after accept (withdraw / close)
  // read the request's holds under its booking lock to refuse a booked night;
  // close releases them. FR-009: Cancel booking releases the booked hold.
  // Each is gated on the venue side or the sender pair before any refusal
  // or output says anything about the holds.
  "use-cases/booking-requests/_shared/accepted-request-exit.ts",
  "use-cases/booking-requests/close-booking-request.ts",
  "use-cases/booking-requests/cancel-booking.ts",
  // booking-the-night P2c (review round 1, upstream of BLOCKING 1): finalize
  // links a booked night's terms only to THAT night's event. It reads the
  // request's CONFIRMED hold after the finalize gates authorize the actor
  // on both the agreement and the event.
  "use-cases/booking-agreements/finalize-booking-agreement.ts",
  // booking-the-night P2c (review round 3, W4): the accept takes the
  // request's booking lock and reads its own holds under it, so a request
  // whose booking was CANCELLED is never accepted into new terms. The read
  // runs after the venue is authorized on the request (respond's gates).
  "use-cases/booking-requests/_shared/accept-in-tx.ts",
  // ── P3b (asks) ── venue-booking-standards v1.1 FR-009b: an ask on a
  // cancelled booking refuses (BOOKING_CANCELLED). The ask takes the
  // request's booking lock and learns only "cancelled or not", through
  // `booking-holds/_shared/request-booking-lock.ts`; it runs after the venue
  // side is authorized on the thread.
  "use-cases/booking-requests/asks/ask-on-booking-request.ts",
  // ── P3b (asks), entered for P3a ── venue-confirmation-and-booking-intents
  // 08-27 amendment, point 3: requests parked at an unclaimed venue before
  // the amendment are expired by an ops use case, which releases their holds
  // (FR-009's closure rule). Ops-only; no public surface.
  "use-cases/booking-requests/expire-parked-booking-requests.ts",  // merge-duplicate-places FR-003b / FR-006: an ADMIN merge counts the
  // merged place's holds, refuses an overlapping line and moves the rest onto
  // the survivor. ADMIN staff is checked before any read; no public surface.
  ...PLACE_MERGE_FILES,
  // holds-without-a-request FR-003 / H15: the grant's managers (direct owner,
  // owning-org OWNER / ADMIN) preview and revoke a booking grant, which reads
  // and settles the booker's holds riding it; narrowing a grant's scope
  // checks the same holds. The manager gate runs before any hold is read;
  // staff surfaces only.
  "use-cases/place-booking-grants/preview-revoke.ts",
  "use-cases/place-booking-grants/revoke.ts",
  "use-cases/place-booking-grants/update.ts",
];

/**
 * Helpers inside booking-holds/ that READ holds on a caller's behalf and hand
 * back a narrower answer. Importing one is a hold read by another name, so
 * the same allow-list applies to their importers — otherwise a helper could
 * launder hold reads into any module (review W5b).
 */
const HOLD_READING_HELPERS = [
  "booking-holds/_shared/request-booking-lock",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("BookingHold read scope (NFR-001)", () => {
  it("no module outside the FR-011..014 allow-list touches the bookingHolds port", () => {
    const offenders: string[] = [];
    for (const file of walk(CORE_SRC)) {
      const rel = relative(CORE_SRC, file);
      if (rel.includes("/__tests__/")) continue;
      const source = readFileSync(file, "utf8");
      if (!/\bbookingHolds\b/.test(source)) continue;
      if (!ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  // ── P3b (asks) ── review W5b.
  it("no module outside the allow-list imports a hold-reading helper", () => {
    const offenders: string[] = [];
    for (const file of walk(CORE_SRC)) {
      const rel = relative(CORE_SRC, file);
      if (rel.includes("/__tests__/")) continue;
      const source = readFileSync(file, "utf8");
      const imports = [
        ...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ].map((m) => m[1] ?? m[2] ?? "");
      const launders = imports.some((spec) =>
        HOLD_READING_HELPERS.some(
          (helper) =>
            spec.endsWith(helper) ||
            // a relative import from inside booking-holds/_shared itself
            spec.endsWith(`./${helper.split("/").pop()}`),
        ),
      );
      if (launders && !ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the public calendar/event surfaces do not import the overlay helper", () => {
    const publicSurfaces = [
      "use-cases/events/get-place-booking-availability.ts",
      "use-cases/embeds",
      "use-cases/search",
      "use-cases/places",
    ];
    const offenders: string[] = [];
    for (const file of walk(CORE_SRC)) {
      const rel = relative(CORE_SRC, file);
      if (!publicSurfaces.some((p) => rel.startsWith(p))) continue;
      if (PLACE_MERGE_FILES.includes(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (/booking-hold-overlay|\bbookingHolds\b/.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
