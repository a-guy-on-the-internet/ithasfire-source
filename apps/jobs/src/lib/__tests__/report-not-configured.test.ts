import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  reportNotConfiguredOnce,
  resetNotConfiguredReportsForTests,
} from "../report-not-configured";

const SEARCH = { job: "search.full-reindex", reason: "search_not_configured" };

describe("reportNotConfiguredOnce", () => {
  beforeEach(() => {
    resetNotConfiguredReportsForTests();
  });

  it("reports an Error named for the job and reason, tagged so Sentry can group it", () => {
    const reportError = vi.fn();

    reportNotConfiguredOnce({ reportError }, SEARCH);

    expect(reportError).toHaveBeenCalledTimes(1);
    const [error, context] = reportError.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "search.full-reindex: search_not_configured",
    );
    expect(context).toEqual({
      tags: {
        area: "job-not-configured",
        job: "search.full-reindex",
        reason: "search_not_configured",
      },
    });
  });

  it("reports a (job, reason) pair once per process, however often the job runs", () => {
    const reportError = vi.fn();

    reportNotConfiguredOnce({ reportError }, SEARCH);
    reportNotConfiguredOnce({ reportError }, SEARCH);
    // A later run arrives with a different ctx object (app.ts builds one per
    // run): the latch is the module's, not the ctx's.
    const laterRun = vi.fn();
    reportNotConfiguredOnce({ reportError: laterRun }, SEARCH);

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(laterRun).not.toHaveBeenCalled();
  });

  it("reports again for another job with the same reason, and for another reason on the same job", () => {
    const reportError = vi.fn();

    reportNotConfiguredOnce({ reportError }, SEARCH);
    reportNotConfiguredOnce(
      { reportError },
      { job: "search.index-event", reason: "search_not_configured" },
    );
    reportNotConfiguredOnce(
      { reportError },
      { job: "attendee-review-digests.send", reason: "mailer_unconfigured" },
    );
    reportNotConfiguredOnce(
      { reportError },
      {
        job: "attendee-review-digests.send",
        reason: "unsubscribe_secret_unconfigured",
      },
    );

    expect(
      reportError.mock.calls.map(([, context]) => context.tags),
    ).toEqual([
      expect.objectContaining({ job: "search.full-reindex" }),
      expect.objectContaining({ job: "search.index-event" }),
      expect.objectContaining({ reason: "mailer_unconfigured" }),
      expect.objectContaining({ reason: "unsubscribe_secret_unconfigured" }),
    ]);
  });

  it("swallows a throwing reporter, and does not call it again on the next run", () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry transport down");
    });

    expect(() => reportNotConfiguredOnce({ reportError }, SEARCH)).not.toThrow();
    expect(() => reportNotConfiguredOnce({ reportError }, SEARCH)).not.toThrow();

    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("the test reset behaves like a fresh process", () => {
    const reportError = vi.fn();

    reportNotConfiguredOnce({ reportError }, SEARCH);
    resetNotConfiguredReportsForTests();
    reportNotConfiguredOnce({ reportError }, SEARCH);

    expect(reportError).toHaveBeenCalledTimes(2);
  });
});
