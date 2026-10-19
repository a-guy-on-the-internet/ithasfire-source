import { describe, expect, it } from "vitest";

import { buildScreensForJobs } from "../index";

// The venue is derivable from the surface the user clicked through (the place
// page's "Rate this place" block, a ?placeId= deep link), so the flow must not
// ask them which venue they mean. Everything else stays identical.

const ids = (jobs: string[], opts?: { knownPlace?: boolean }) =>
  buildScreensForJobs(jobs, opts).map((s) => s.id);

describe("buildScreensForJobs — knownPlace", () => {
  it("keeps the venue picker when no place is known", () => {
    expect(ids([])).toContain("venue");
    expect(ids(["MUSICIAN"])).toContain("venue");
  });

  it("drops the venue picker when the place came from context", () => {
    expect(ids([], { knownPlace: true })).not.toContain("venue");
    expect(ids(["MUSICIAN"], { knownPlace: true })).not.toContain("venue");
  });

  it("drops exactly one screen and leaves the rest of the flow intact", () => {
    for (const jobs of [[], ["MUSICIAN"], ["SOUND_ENGINEER"], ["PROMOTER"]]) {
      const full = ids(jobs);
      const known = ids(jobs, { knownPlace: true });
      expect(known).toEqual(full.filter((id) => id !== "venue"));
    }
  });

  it("still starts on About You and ends on the review screen", () => {
    const known = buildScreensForJobs(["MUSICIAN"], { knownPlace: true });
    expect(known[0]!.id).toBe("aboutYou");
    expect(known.at(-1)!.phase).toBe("review");
  });
});
