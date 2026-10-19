import { beforeEach, describe, expect, it, vi } from "vitest";

import { provisionHumanForAuthUser } from "../provision-human-for-auth-user";
import type { ProvisionHumanForAuthUserDeps } from "../provision-human-for-auth-user";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { HumansRepo } from "@th/ports/repos/humans";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const AUTH_USER_ID = "auth_user_1";
const HUMAN_ID = "11111111-1111-4111-8111-111111111111";

function makeDeps(humansImpl: Partial<HumansRepo> = {}) {
  const humans = {
    getByEmail: vi.fn(),
    getById: vi.fn(),
    getByIdWithIdentity: vi.fn(),
    getByPhone: vi.fn(),
    lockForAuthUser: vi.fn(async () => undefined),
    getHumanIdForAuthUserId: vi.fn(),
    getAuthUserById: vi.fn(),
    linkAuthUserToHuman: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    ensureByProvider: vi.fn(),
    listForSearchIndex: vi.fn(),
    ...humansImpl,
  } as unknown as HumansRepo;

  const entityPages = {
    getByOwner: vi.fn(async () => null),
    upsert: vi.fn(
      async (input: {
        ownerType: string;
        ownerId: string;
        slug: string;
        displayName: string | null;
        avatarUrl?: string | null;
        bannerUrl?: string | null;
      }) => ({
        id: "page-1",
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        slug: input.slug,
        displayName: input.displayName,
        bio: null,
        avatarUrl: input.avatarUrl ?? null,
        bannerUrl: input.bannerUrl ?? null,
        visibility: "PUBLIC",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ),
  };

  const txRepos: TxRepos = {
    humans,
    entityPages: entityPages as any,
    audit: { log: vi.fn(async () => undefined) } as any,
    tickets: {} as any,
    seats: {} as any,
    agreements: {} as any,
    feePolicies: {} as any,
    events: {} as any,
    orders: {} as any,
    splits: {} as any,
    payees: {} as any,
    settlements: {} as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    authz: {} as any,
    apiKeys: {} as any,
    organizations: {} as any,
    places: {} as any,
    savedLocations: {} as any,
    eventApplications: {} as any,
    eventWaitlists: {} as any,
    inviteLists: {} as any,
    categories: {} as any,
    featuredEvents: {} as any,
    eventTemplates: {} as any,
    eventHumans: {} as any,
    series: {} as any,
    seriesOccurrences: {} as any,
    pushDevices: {} as any,
    notificationPrefs: {} as any,
    notificationDigests: {} as any,
    notifications: {} as any,
    placeLayouts: {} as any,
    placeLayoutBlobs: {} as any,
    placeLayoutStatuses: {} as any,
  } as unknown as TxRepos;

  const repos: Repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const deps: ProvisionHumanForAuthUserDeps = {
    repos,
    clock: { now: () => new Date() },
    logger: createTestLogger(),
  };

  return { deps, humans, entityPages };
}

describe("provisionHumanForAuthUser", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("no-ops when already linked", async () => {
    const { deps, humans } = makeDeps({
      getHumanIdForAuthUserId: vi.fn(async () => ({ humanId: HUMAN_ID })),
    });

    const out = await provisionHumanForAuthUser(deps, {
      actorSystem: "service",
      authUserId: AUTH_USER_ID,
      email: "user@example.com",
      name: "User",
      clientKey: "test",
    });

    expect(out).toEqual({ humanId: HUMAN_ID, created: false, linked: false });
    expect(humans.linkAuthUserToHuman).not.toHaveBeenCalled();
  });

  it("creates a new human and links auth user", async () => {
    const { deps, humans, entityPages } = makeDeps({
      getHumanIdForAuthUserId: vi.fn(async () => null),
      getByEmail: vi.fn(async () => null),
      create: vi.fn(async () => ({
        id: HUMAN_ID,
        name: "User",
        status: "ACTIVE" as const,
        roles: ["USER"],
        locale: null,
        phone: null,
        billingAddressLine1: null,
        billingAddressLine2: null,
        billingCity: null,
        billingState: null,
        billingPostalCode: null,
        billingCountry: null,
        defaultPrimaryPayoutTermsId: null,
        defaultResalePayoutTermsId: null,
        trustTier: "NEW" as const,
        trustBadgeLabel: null,
        trustBadgeIcon: null,
        createdAt: new Date(),
      })),
      linkAuthUserToHuman: vi.fn(async () => ({ humanId: HUMAN_ID })),
    });

    const out = await provisionHumanForAuthUser(deps, {
      actorSystem: "service",
      authUserId: AUTH_USER_ID,
      email: "user@example.com",
      name: "User",
      clientKey: "test",
    });

    expect(out).toEqual({ humanId: HUMAN_ID, created: true, linked: true });
    expect(humans.create).toHaveBeenCalled();
    expect(humans.linkAuthUserToHuman).toHaveBeenCalledWith({
      authUserId: AUTH_USER_ID,
      humanId: HUMAN_ID,
    });
  });

  it("acquires the per-authUser advisory lock BEFORE reading the link or creating a human", async () => {
    // Concurrency can't be simulated in a pure unit test, so we assert the
    // serialization point exists and runs first: the advisory lock must be
    // taken before the null-link read and the create, so the second waiter
    // (in production) sees the first's committed link and no-ops.
    const { deps, humans } = makeDeps({
      lockForAuthUser: vi.fn(async () => undefined),
      getHumanIdForAuthUserId: vi.fn(async () => null),
      getByEmail: vi.fn(async () => null),
      create: vi.fn(async () => ({
        id: HUMAN_ID,
        name: "User",
        status: "ACTIVE" as const,
        roles: ["USER"],
        locale: null,
        phone: null,
        billingAddressLine1: null,
        billingAddressLine2: null,
        billingCity: null,
        billingState: null,
        billingPostalCode: null,
        billingCountry: null,
        defaultPrimaryPayoutTermsId: null,
        defaultResalePayoutTermsId: null,
        trustTier: "NEW" as const,
        trustBadgeLabel: null,
        trustBadgeIcon: null,
        createdAt: new Date(),
      })),
      linkAuthUserToHuman: vi.fn(async () => ({ humanId: HUMAN_ID })),
    });

    await provisionHumanForAuthUser(deps, {
      actorSystem: "service",
      authUserId: AUTH_USER_ID,
      email: "user@example.com",
      name: "User",
      clientKey: "test",
    });

    expect(humans.lockForAuthUser).toHaveBeenCalledWith(AUTH_USER_ID);

    const lockOrder = (humans.lockForAuthUser as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;
    const readOrder = (
      humans.getHumanIdForAuthUserId as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0]!;
    const createOrder = (humans.create as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]!;

    expect(lockOrder).toBeLessThan(readOrder);
    expect(lockOrder).toBeLessThan(createOrder);
  });

  it("no-ops (no create) when the link already exists after acquiring the lock", async () => {
    // Models the second concurrent request: by the time it holds the lock the
    // first has committed the link, so it must NOT create a duplicate Human.
    const lockForAuthUser = vi.fn(async () => undefined);
    const { deps, humans } = makeDeps({
      lockForAuthUser,
      getHumanIdForAuthUserId: vi.fn(async () => ({ humanId: HUMAN_ID })),
    });

    const out = await provisionHumanForAuthUser(deps, {
      actorSystem: "service",
      authUserId: AUTH_USER_ID,
      email: "user@example.com",
      name: "User",
      clientKey: "test",
    });

    expect(lockForAuthUser).toHaveBeenCalledWith(AUTH_USER_ID);
    expect(out).toEqual({ humanId: HUMAN_ID, created: false, linked: false });
    expect(humans.create).not.toHaveBeenCalled();
    expect(humans.linkAuthUserToHuman).not.toHaveBeenCalled();
  });

  it("reuses existing human (by email) and links auth user", async () => {
    const existingHuman = {
      id: HUMAN_ID,
      name: null,
      status: "ACTIVE" as const,
      roles: ["USER"],
      locale: null,
      phone: null,
      billingAddressLine1: null,
      billingAddressLine2: null,
      billingCity: null,
      billingState: null,
      billingPostalCode: null,
      billingCountry: null,
      defaultPrimaryPayoutTermsId: null,
      defaultResalePayoutTermsId: null,
      trustTier: "NEW" as const,
      trustBadgeLabel: null,
      trustBadgeIcon: null,
      createdAt: new Date(),
    };
    const existingIdentity = {
      authUserId: HUMAN_ID,
      email: "user@example.com",
      emailVerified: false,
      phone: null,
      phoneVerified: false,
      username: null,
      displayUsername: null,
      image: null,
    };

    const { deps, humans } = makeDeps({
      getHumanIdForAuthUserId: vi.fn(async () => null),
      getByEmail: vi.fn(async () => ({
        human: existingHuman,
        identity: existingIdentity,
      })),
      update: vi.fn(async () => ({
        id: HUMAN_ID,
        name: "User",
        status: "ACTIVE" as const,
        roles: ["USER"],
        locale: null,
        phone: null,
        billingAddressLine1: null,
        billingAddressLine2: null,
        billingCity: null,
        billingState: null,
        billingPostalCode: null,
        billingCountry: null,
        defaultPrimaryPayoutTermsId: null,
        defaultResalePayoutTermsId: null,
        trustTier: "NEW" as const,
        trustBadgeLabel: null,
        trustBadgeIcon: null,
        createdAt: new Date(),
      })),
      linkAuthUserToHuman: vi.fn(async () => ({ humanId: HUMAN_ID })),
    });

    const out = await provisionHumanForAuthUser(deps, {
      actorSystem: "service",
      authUserId: AUTH_USER_ID,
      email: "user@example.com",
      name: "User",
      clientKey: "test",
    });

    expect(out).toEqual({ humanId: HUMAN_ID, created: false, linked: true });
    expect(humans.update).toHaveBeenCalledWith(HUMAN_ID, { name: "User" });
    expect(humans.linkAuthUserToHuman).toHaveBeenCalledWith({
      authUserId: AUTH_USER_ID,
      humanId: HUMAN_ID,
    });
  });
});
