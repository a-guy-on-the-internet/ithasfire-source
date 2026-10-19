import { describe, expect, it, vi } from "vitest";
import { FOLLOW_NOTICE_RETENTION_DAYS, purgeFollowNotices } from "../purge-follow-notices";

const now = new Date("2026-10-01T04:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
function deps() {
  const purgeStartedBefore = vi.fn(async () => ({ notices: 4 }));
  return { purgeStartedBefore, deps: { repos: { entityEventNotices: { purgeStartedBefore } }, clock: { now: () => now } } as any };
}

describe("purgeFollowNotices", () => {
  it("deletes by EVENT start, 30 days back by default", async () => {
    const d = deps();
    const result = await purgeFollowNotices(d.deps, {});
    expect(FOLLOW_NOTICE_RETENTION_DAYS).toBe(30);
    expect(d.purgeStartedBefore).toHaveBeenCalledWith(new Date(now.getTime() - 30 * DAY));
    expect(result).toEqual({ deletedNotices: 4, cutoff: new Date(now.getTime() - 30 * DAY) });
  });
  it("honours a one-off retention override", async () => {
    const d = deps();
    await purgeFollowNotices(d.deps, { retentionDays: 7 });
    expect(d.purgeStartedBefore).toHaveBeenCalledWith(new Date(now.getTime() - 7 * DAY));
  });
  it("rejects a zero or negative window", async () => {
    await expect(purgeFollowNotices(deps().deps, { retentionDays: 0 })).rejects.toBeTruthy();
  });
});
