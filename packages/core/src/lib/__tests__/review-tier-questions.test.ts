import { describe, it, expect } from "vitest";
import {
  TIER_CONFIGS,
  MERCH_JOBS,
  PERFORMER_COPY_VARIANTS,
  getScreenOverride,
  isScreenVisible,
  getPerformerCopy,
} from "../review-tier-questions";
import { PERFORMER_JOBS } from "../human-jobs";

// Every screen ID in the current review form
const ALL_SCREEN_IDS = [
  // core
  "venue",
  "payout",
  "paymentMethod",
  "promotion",
  "sound",
  "audience",
  "playAgain",
  "genre",
  // optional
  "draw",
  "totalAttendance",
  "dayOfWeek",
  "foh",
  "equipment",
  "parking",
  "loadIn",
  "security",
  "booker",
  "merch",
  "staff",
  "independent",
  "comment",
];

describe("tier configs", () => {
  it("performer config hides nothing by default", () => {
    const hidden = ALL_SCREEN_IDS.filter(
      (id) => TIER_CONFIGS.performer[id]?.visibility === "hide",
    );
    expect(hidden).toEqual([]);
  });

  it("crew config hides audience, genre, draw, totalAttendance, merch, promotion", () => {
    const hidden = ALL_SCREEN_IDS.filter(
      (id) => TIER_CONFIGS.crew[id]?.visibility === "hide",
    );
    expect(hidden.sort()).toEqual(
      [
        "audience",
        "draw",
        "genre",
        "merch",
        "promotion",
        "totalAttendance",
      ].sort(),
    );
  });

  it("crew config rewords sound, equipment, foh, playAgain", () => {
    const reworded = ALL_SCREEN_IDS.filter(
      (id) => TIER_CONFIGS.crew[id]?.visibility === "reword",
    );
    expect(reworded.sort()).toEqual(
      ["equipment", "foh", "playAgain", "sound"].sort(),
    );
  });

  it("industry config hides sound, equipment, foh, audience, genre, draw, totalAttendance, merch, loadIn, security, staff", () => {
    const hidden = ALL_SCREEN_IDS.filter(
      (id) => TIER_CONFIGS.industry[id]?.visibility === "hide",
    );
    expect(hidden.sort()).toEqual(
      [
        "audience",
        "draw",
        "equipment",
        "foh",
        "genre",
        "loadIn",
        "merch",
        "security",
        "sound",
        "staff",
        "totalAttendance",
      ].sort(),
    );
  });

  it("industry config rewords playAgain and parking", () => {
    const reworded = ALL_SCREEN_IDS.filter(
      (id) => TIER_CONFIGS.industry[id]?.visibility === "reword",
    );
    expect(reworded.sort()).toEqual(["parking", "playAgain"].sort());
  });

  it("venue, payout, paymentMethod are visible for all tiers", () => {
    const universal = ["venue", "payout", "paymentMethod"];
    for (const tier of ["performer", "crew", "industry"] as const) {
      for (const id of universal) {
        expect(isScreenVisible(tier, id)).toBe(true);
      }
    }
  });
});

describe("isScreenVisible", () => {
  it("returns true for screens not in the tier config", () => {
    expect(isScreenVisible("performer", "venue")).toBe(true);
    expect(isScreenVisible("crew", "venue")).toBe(true);
    expect(isScreenVisible("industry", "venue")).toBe(true);
  });

  it("returns false for hidden screens", () => {
    expect(isScreenVisible("crew", "audience")).toBe(false);
    expect(isScreenVisible("industry", "sound")).toBe(false);
  });

  it("returns true for reworded screens", () => {
    expect(isScreenVisible("crew", "sound")).toBe(true);
    expect(isScreenVisible("industry", "playAgain")).toBe(true);
  });
});

describe("getScreenOverride", () => {
  it("returns undefined for screens without overrides", () => {
    expect(getScreenOverride("performer", "venue")).toBeUndefined();
  });

  it("returns the override with question text for reworded screens", () => {
    const override = getScreenOverride("crew", "sound");
    expect(override?.visibility).toBe("reword");
    expect(override?.question).toBeTruthy();
  });
});

describe("performer copy variants", () => {
  it("covers every performer job", () => {
    for (const job of PERFORMER_JOBS) {
      expect(PERFORMER_COPY_VARIANTS[job]).toBeDefined();
    }
  });

  it("musician uses 'play' verb", () => {
    expect(PERFORMER_COPY_VARIANTS.MUSICIAN.playAgainVerb).toBe("play");
  });

  it("comedian uses 'perform' verb", () => {
    expect(PERFORMER_COPY_VARIANTS.COMEDIAN.playAgainVerb).toBe("perform");
  });

  it("DJ uses 'play' verb", () => {
    expect(PERFORMER_COPY_VARIANTS.DJ.playAgainVerb).toBe("play");
  });

  it("visual artist uses 'show' verb", () => {
    expect(PERFORMER_COPY_VARIANTS.VISUAL_ARTIST.playAgainVerb).toBe("show");
  });
});

describe("getPerformerCopy", () => {
  it("returns specific variant for known job", () => {
    expect(getPerformerCopy("COMEDIAN").playAgainVerb).toBe("perform");
  });

  it("falls back to MUSICIAN for unknown job", () => {
    expect(getPerformerCopy("UNKNOWN_JOB").playAgainVerb).toBe("play");
  });
});

describe("MERCH_JOBS", () => {
  it("only includes MUSICIAN", () => {
    expect([...MERCH_JOBS]).toEqual(["MUSICIAN"]);
  });
});
