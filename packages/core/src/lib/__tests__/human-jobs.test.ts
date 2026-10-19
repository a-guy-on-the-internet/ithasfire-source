import { describe, it, expect } from "vitest";
import {
  GENRE_JOBS,
  PERFORMER_JOBS,
  CREW_JOBS,
  INDUSTRY_JOBS,
  HUMAN_JOB_LABELS,
  getReviewTier,
} from "../human-jobs";

describe("human-jobs constants", () => {
  it("GENRE_JOBS contains only MUSICIAN", () => {
    expect([...GENRE_JOBS]).toEqual(["MUSICIAN"]);
  });

  it("tier sets are disjoint", () => {
    for (const job of PERFORMER_JOBS) {
      expect(CREW_JOBS.has(job as any)).toBe(false);
      expect(INDUSTRY_JOBS.has(job as any)).toBe(false);
    }
    for (const job of CREW_JOBS) {
      expect(PERFORMER_JOBS.has(job as any)).toBe(false);
      expect(INDUSTRY_JOBS.has(job as any)).toBe(false);
    }
    for (const job of INDUSTRY_JOBS) {
      expect(PERFORMER_JOBS.has(job as any)).toBe(false);
      expect(CREW_JOBS.has(job as any)).toBe(false);
    }
  });

  it("all 15 jobs are covered by exactly one tier", () => {
    const allJobs = [...PERFORMER_JOBS, ...CREW_JOBS, ...INDUSTRY_JOBS];
    expect(allJobs).toHaveLength(15);
    expect(new Set(allJobs).size).toBe(15);
  });

  it("HUMAN_JOB_LABELS covers every job", () => {
    const allJobs = [...PERFORMER_JOBS, ...CREW_JOBS, ...INDUSTRY_JOBS];
    for (const job of allJobs) {
      expect(HUMAN_JOB_LABELS[job]).toBeDefined();
      expect(typeof HUMAN_JOB_LABELS[job]).toBe("string");
    }
  });
});

describe("getReviewTier", () => {
  it("returns null for empty jobs", () => {
    expect(getReviewTier([])).toBeNull();
  });

  it("returns 'performer' for MUSICIAN", () => {
    expect(getReviewTier(["MUSICIAN"])).toBe("performer");
  });

  it("returns 'performer' for COMEDIAN", () => {
    expect(getReviewTier(["COMEDIAN"])).toBe("performer");
  });

  it("returns 'performer' for DJ", () => {
    expect(getReviewTier(["DJ"])).toBe("performer");
  });

  it("returns 'performer' for all performer jobs", () => {
    for (const job of PERFORMER_JOBS) {
      expect(getReviewTier([job])).toBe("performer");
    }
  });

  it("returns 'crew' for SOUND_ENGINEER", () => {
    expect(getReviewTier(["SOUND_ENGINEER"])).toBe("crew");
  });

  it("returns 'crew' for all crew jobs", () => {
    for (const job of CREW_JOBS) {
      expect(getReviewTier([job])).toBe("crew");
    }
  });

  it("returns 'industry' for PROMOTER", () => {
    expect(getReviewTier(["PROMOTER"])).toBe("industry");
  });

  it("returns 'industry' for OTHER", () => {
    expect(getReviewTier(["OTHER"])).toBe("industry");
  });

  it("returns 'industry' for all industry jobs", () => {
    for (const job of INDUSTRY_JOBS) {
      expect(getReviewTier([job])).toBe("industry");
    }
  });

  it("performer wins over crew when both present", () => {
    expect(getReviewTier(["SOUND_ENGINEER", "MUSICIAN"])).toBe("performer");
  });

  it("crew wins over industry when both present", () => {
    expect(getReviewTier(["PROMOTER", "PHOTOGRAPHER"])).toBe("crew");
  });

  it("performer wins over all tiers", () => {
    expect(getReviewTier(["BOOKING_AGENT", "VIDEOGRAPHER", "DJ"])).toBe(
      "performer",
    );
  });
});
