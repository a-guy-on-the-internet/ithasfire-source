import { describe, expect, it, vi } from "vitest";

import {
  AVAILABILITY_SETUP_NEEDED_VARIANT,
  availabilitySetupIdempotencyKey,
  notifyAvailabilitySetupNeeded,
} from "../notify-availability-setup-needed";
import type { NotifyAvailabilitySetupNeededDeps } from "../notify-availability-setup-needed";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const PUBLIC_APP_URL = "https://ithasfire.test";

type BuildOptions = {
  availabilityRowCount?: number;
  place?: Record<string, unknown> | null;
  /** Simulates the durable claim already being held/committed. */
  beginResult?: boolean;
  username?: string | null;
  pageSlug?: string | null;
  membership?: { orgId: string; humanId: string; role: string } | null;
  orgSlug?: string | null;
  publicAppUrl?: string | null;
};

function buildDeps(options: BuildOptions = {}) {
  const place =
    options.place === undefined
      ? {
          id: PLACE_ID,
          name: "Drk Basement",
          humanIdsWithAccess: [ACTOR_ID],
          orgIdsWithAccess: [],
        }
      : options.place;

  const idempotency = {
    begin: vi.fn(async () => options.beginResult ?? true),
    commit: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    get: vi.fn(async () => null),
  };
  const notify = vi.fn(async () => ({ ok: true }));
  const repos = {
    calendars: {
      countAvailabilityForPlace: vi.fn(
        async () => options.availabilityRowCount ?? 0,
      ),
    },
    places: { getById: vi.fn(async () => place) },
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        human: { id: ACTOR_ID },
        identity: { username: options.username ?? null },
      })),
    },
    entityPages: {
      getByOwner: vi.fn(async () =>
        options.pageSlug ? { slug: options.pageSlug } : null,
      ),
    },
    authz: {
      getOrgMemberships: vi.fn(async () =>
        options.membership ? [options.membership] : [],
      ),
    },
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, slug: options.orgSlug ?? null })),
    },
  };

  const deps = {
    repos,
    notify,
    idempotency,
    publicAppUrl:
      options.publicAppUrl === undefined ? PUBLIC_APP_URL : options.publicAppUrl,
  } as unknown as NotifyAvailabilitySetupNeededDeps;

  return { deps, mocks: { idempotency, notify, repos } };
}

const args = { placeId: PLACE_ID, actorHumanId: ACTOR_ID };

describe("notifyAvailabilitySetupNeeded", () => {
  it("sends ONE in-app-only nudge to the acting human and commits the durable claim", async () => {
    const { deps, mocks } = buildDeps({ username: "venue-owner" });

    await notifyAvailabilitySetupNeeded(deps, args);

    const key = availabilitySetupIdempotencyKey(PLACE_ID);
    expect(mocks.idempotency.begin).toHaveBeenCalledWith(key, 60);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith({
      humanId: ACTOR_ID,
      variant: AVAILABILITY_SETUP_NEEDED_VARIANT,
      idempotencyKey: key,
      payload: {
        placeId: PLACE_ID,
        placeName: "Drk Basement",
        calendarsUrl: `${PUBLIC_APP_URL}/admin/@venue-owner/places/${PLACE_ID}/calendars`,
      },
      channels: {
        email: { enabled: false },
        push: { enabled: false },
        sms: { enabled: false },
      },
    });
    expect(mocks.idempotency.commit).toHaveBeenCalledWith(
      key,
      { placeId: PLACE_ID, notifiedHumanId: ACTOR_ID },
      60 * 60 * 24 * 365,
    );
  });

  it("SUPPRESSES entirely when the place is already configured", async () => {
    const { deps, mocks } = buildDeps({ availabilityRowCount: 3 });

    await notifyAvailabilitySetupNeeded(deps, args);

    expect(mocks.idempotency.begin).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("is IDEMPOTENT: a second trigger while the claim is held/committed sends nothing", async () => {
    // A second OFF→ON re-toggle lands here: begin() refuses because the
    // committed record (or an in-flight claim) still owns the key.
    const { deps, mocks } = buildDeps({ beginResult: false });

    await notifyAvailabilitySetupNeeded(deps, args);

    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.idempotency.commit).not.toHaveBeenCalled();
  });

  it("routes an org-member actor to the org-slug admin path", async () => {
    const { deps, mocks } = buildDeps({
      place: {
        id: PLACE_ID,
        name: "Drk Basement",
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      },
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" },
      orgSlug: "drkmttr",
    });

    await notifyAvailabilitySetupNeeded(deps, args);

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          calendarsUrl: `${PUBLIC_APP_URL}/admin/drkmttr/places/${PLACE_ID}/calendars`,
        }),
      }),
    );
  });

  it("frees the claim (fail) and rethrows when the send throws, so a later trigger can retry", async () => {
    const { deps, mocks } = buildDeps();
    mocks.notify.mockRejectedValueOnce(new Error("notify down"));

    await expect(notifyAvailabilitySetupNeeded(deps, args)).rejects.toThrow(
      "notify down",
    );

    const key = availabilitySetupIdempotencyKey(PLACE_ID);
    expect(mocks.idempotency.fail).toHaveBeenCalledWith(key, "notify down");
    expect(mocks.idempotency.commit).not.toHaveBeenCalled();
  });

  it("throws (for the caller's swallow-and-report) when publicAppUrl is missing", async () => {
    const { deps, mocks } = buildDeps({ publicAppUrl: null });

    await expect(notifyAvailabilitySetupNeeded(deps, args)).rejects.toThrow(
      /publicAppUrl/,
    );
    expect(mocks.notify).not.toHaveBeenCalled();
    // The claim was taken before the failure, so it is freed for retry.
    expect(mocks.idempotency.fail).toHaveBeenCalled();
  });
});
