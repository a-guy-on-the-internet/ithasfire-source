import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const getVenueCalendarMock = vi.fn();
const createPrismaReposMock = vi.fn();
const withGuardedReposMock = vi.fn((repos) => repos);
const logAndReportMock = vi.fn(async () => undefined);
const captureExceptionMock = vi.fn();

vi.mock("@th/core/use-cases/events", () => ({
  getVenueCalendar: getVenueCalendarMock,
}));

// Mocked for the same reason as use-cases/events above: the volunteering
// dir-subpath doesn't resolve under apps/api vitest (exports-wildcard issue).
vi.mock("@th/core/use-cases/volunteering", () => ({
  exportMyVolunteeringIcs: vi.fn(),
}));

vi.mock("@th/adapters/db/prisma-repos", () => ({
  createPrismaRepos: createPrismaReposMock,
}));

vi.mock("@th/adapters/decorators/with-dependency-guard", () => ({
  withGuardedRepos: withGuardedReposMock,
}));

vi.mock("@th/adapters/infra/discord-alerts", () => ({
  logAndReport: logAndReportMock,
}));

vi.mock("@th/db", () => ({
  prisma: {},
}));

vi.mock("../src/instrument", () => ({
  Sentry: {
    captureException: captureExceptionMock,
  },
}));

function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn(),
    ),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return logger;
}

describe("ical route observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPrismaReposMock.mockReturnValue({});
  });

  it("returns 500 and reports venue feed failures through the wrapper", async () => {
    getVenueCalendarMock.mockRejectedValueOnce(new Error("calendar exploded"));

    const { default: icalRoutes } = await import("../src/routes/ical");

    const app = Fastify({ logger: false });
    app.decorate("deps", {
      logger: makeLogger(),
    } as any);

    await app.register(icalRoutes as any);

    const response = await app.inject({
      method: "GET",
      url: "/api/venues/place-123/calendar.ics",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_error" });
    expect(logAndReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "ical_venue_feed_error",
        extra: expect.objectContaining({
          placeId: "place-123",
          error: "calendar exploded",
        }),
        report: expect.objectContaining({
          captureException: captureExceptionMock,
          error: expect.any(Error),
        }),
      }),
    );

    await app.close();
  });
});
