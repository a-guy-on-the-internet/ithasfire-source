import { describe, expect, it } from "vitest";

import {
  VERIFICATION_LABEL_KEY,
  badgeToneForVerification,
  canRequestPlaceVerification,
  getStatusBadgeTone,
  type EffectiveVerificationStatus,
  type PlaceStatus,
  type PlaceVerificationStatus,
} from "../verification-config";

/**
 * EQUIVALENCE GUARD for the four rules that were centralised here.
 *
 * Before this module owned them, each existed as two-to-four hand-rolled
 * copies: a `VERIFICATION_LABEL_MAP` in `settings/_components/VerificationSection
 * .tsx` AND a `VERIFICATION_LABEL_KEY` in the place editor's aside; a badge
 * ternary chain in VerificationSection, a `badgeToneForVerification` in
 * `places/_components/PlaceMobileCard.tsx` AND a `VERIFICATION_BADGE_TONE`
 * table in the aside; a `getStatusBadgeTone` in PlaceMobileCard AND a
 * `PLACE_STATUS_TONE` table in the aside; and the `UNVERIFIED || REJECTED`
 * predicate written out longhand at every request entry point.
 *
 * The literals below are the values those copies produced at the time of the
 * merge, transcribed from them — so this file is the proof that the extraction
 * changed no behaviour, and the guard against a later edit silently changing
 * it for every consumer at once.
 *
 * It matters more than it looks: `VerificationSection` is MOCKED OUT of the
 * only test that renders its page (`verify/__tests__/verify-page.test.tsx`
 * stubs it to a probe), so these rules have no other coverage on that surface.
 */

const ALL_VERIFICATION: PlaceVerificationStatus[] = [
  "UNVERIFIED",
  "VERIFIED",
  "PENDING",
  "REJECTED",
];

const ALL_EFFECTIVE: EffectiveVerificationStatus[] = [
  ...ALL_VERIFICATION,
  "IN_REVIEW",
];

const ALL_PLACE_STATUS: PlaceStatus[] = ["ACTIVE", "SUSPENDED", "ARCHIVED"];

describe("verification-config", () => {
  describe("VERIFICATION_LABEL_KEY", () => {
    it("matches the map both surfaces used to declare privately", () => {
      expect(VERIFICATION_LABEL_KEY).toEqual({
        VERIFIED: "admin.placeVerifVerified",
        PENDING: "admin.placeVerifPending",
        UNVERIFIED: "admin.placeVerifUnverified",
        REJECTED: "admin.placeVerifRejected",
      });
    });

    it("covers every persisted status (a miss renders the raw key string)", () => {
      for (const status of ALL_VERIFICATION) {
        expect(VERIFICATION_LABEL_KEY[status], status).toMatch(
          /^admin\.placeVerif/,
        );
      }
    });
  });

  describe("badgeToneForVerification", () => {
    it("reproduces VerificationSection's old ternary chain exactly", () => {
      // Old chain: VERIFIED ? success : PENDING ? info : REJECTED ? danger
      //            : warning  (i.e. UNVERIFIED fell through to warning).
      expect(badgeToneForVerification("VERIFIED")).toBe("success");
      expect(badgeToneForVerification("PENDING")).toBe("info");
      expect(badgeToneForVerification("REJECTED")).toBe("danger");
      expect(badgeToneForVerification("UNVERIFIED")).toBe("warning");
    });

    it("keeps IN_REVIEW on the PENDING tone, as PlaceMobileCard had it", () => {
      expect(badgeToneForVerification("IN_REVIEW")).toBe(
        badgeToneForVerification("PENDING"),
      );
    });

    it("returns a tone for every effective status", () => {
      for (const status of ALL_EFFECTIVE) {
        expect(badgeToneForVerification(status), status).toBeTruthy();
      }
    });
  });

  describe("getStatusBadgeTone", () => {
    it("reproduces the Places table / mobile card mapping exactly", () => {
      expect(getStatusBadgeTone("ACTIVE")).toBe("success");
      expect(getStatusBadgeTone("SUSPENDED")).toBe("warning");
      expect(getStatusBadgeTone("ARCHIVED")).toBe("danger");
    });

    it("returns a tone for every place status", () => {
      for (const status of ALL_PLACE_STATUS) {
        expect(getStatusBadgeTone(status), status).toBeTruthy();
      }
    });
  });

  describe("canRequestPlaceVerification", () => {
    it("offers a request only where one can actually be made", () => {
      // PENDING is already queued; VERIFIED is done. Flipping this in one
      // consumer and not the others is what centralising it prevents.
      expect(canRequestPlaceVerification("UNVERIFIED")).toBe(true);
      expect(canRequestPlaceVerification("REJECTED")).toBe(true);
      expect(canRequestPlaceVerification("PENDING")).toBe(false);
      expect(canRequestPlaceVerification("VERIFIED")).toBe(false);
    });

    it("is total over the persisted statuses", () => {
      for (const status of ALL_VERIFICATION) {
        expect(typeof canRequestPlaceVerification(status), status).toBe(
          "boolean",
        );
      }
    });
  });
});
