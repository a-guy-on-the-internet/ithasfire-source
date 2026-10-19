import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";

import type { PreparedEventTaxRate } from "../_shared/resolve-event-tax-rate";
import {
  finalizeSaveEvent,
  finalizeSaveEventInCallerTx,
  type FinalizeParams,
  type FinalizeSaveEventInCallerTxParams,
  type SaveEventDeferredWork,
} from "../_shared/save-event-shared";

// ─────────────────────────────────────────────────────────────────────────────
// FR-004 (docs/specs/2026-09-05/completed/booking-accept-is-the-mint-point.spec.md): the
// event mint can join a transaction the CALLER already opened — the accept
// path, which holds advisory locks on hold lines while it mints.
//
// TWO ENTRY POINTS, TWO NAMES. The spec asked for an optional `tx?: TxRepos` on
// `finalizeSaveEvent`; that shape did not survive review, because the two paths
// have different RETURN types and overload resolution binds the FIRST
// applicable signature for a named variable — so caller-tx params silently got
// the standalone result type and the deferred work was never run. So:
//   · `finalizeSaveEvent(deps, logger, params)` — standalone, unchanged.
//   · `finalizeSaveEventInCallerTx(deps, logger, params)` — joins the caller's
//     transaction, returns the deferred post-commit work.
// A runtime guard in the former refuses caller-tx params, because structural
// subtyping means the type system cannot (see the last case here).
//
// Nothing in production passes `tx` yet. These tests ARE the caller: they
// exercise the capability directly, and they pin the three interactions the
// spec text leaves implicit.
//
//  1. NO NESTING. `repos.tx` always opens a FRESH transaction off the root
//     Prisma client, so calling it from inside one takes a second connection
//     that blocks on the first's advisory locks. On the caller-tx path
//     `deps.repos` must not be touched AT ALL during the save.
//  2. POST-COMMIT WORK IS RETURNED, NOT RUN. The caller's transaction has not
//     committed when the save returns, so the slug-at-create step comes back as
//     deferred work for the caller to run after ITS commit.
//  3. NO INNER IDEMPOTENCY ENVELOPE (FR-005), and NO tax-provider call — the
//     caller prepared the rate before it opened the transaction (P-1).
//
// The no-tx path is unchanged, and that is asserted here too (the envelope
// runs, the deferred handle is absent) on top of the 114 existing event suites
// that pin its ordering — `save-event-tax-stamp.test.ts` in particular carries
// P-1's sequence recorder for "provider call precedes tx-open".
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = ReturnType<typeof makeCreateEventTestContext>;

const PLACE_LOCATION = {
  kind: "place" as const,
  placeId: DEFAULT_PLACE_ID,
};

/**
 * The prepared rate a caller hands in: what `prepareEventTaxRate` returns for a
 * place whose cached rate was empty and whose provider answered.
 */
function makePreparedRate(now: Date): PreparedEventTaxRate {
  return {
    stamp: {
      rateBps: 812,
      source: "caller-prepared",
      situs: { countryCode: "US", region: "ST", postalCode: "12345" },
    },
    fresh: { rateBps: 812, source: "caller-prepared", fetchedAt: now },
    cacheTarget: { kind: "place", placeId: DEFAULT_PLACE_ID },
    // What `prepareEventTaxRate` records alongside a fresh answer: the
    // harness place's address as read, which the in-tx write re-checks.
    cacheAddress: { postalCode: "12345", countryCode: "US" },
    stampAddress: { postalCode: "12345", countryCode: "US", region: "ST" },
  };
}

/** A stored DRAFT, for the update path. Mirrors the fixture in `save-event-tax-stamp.test.ts`. */
function makeExistingEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Existing",
    status: "DRAFT",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2026-10-10T00:00:00.000Z"),
    endsAt: new Date("2026-10-10T03:00:00.000Z"),
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    countryCode: null,
    region: null,
    locality: null,
    postalCode: null,
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    defaultLocale: "en-US",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    currency: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as EventRecord;
}

function baseParams(overrides: Partial<FinalizeParams> = {}): FinalizeParams {
  return {
    owner: { kind: "org", orgId: DEFAULT_ORG_ID },
    actorHumanId: DEFAULT_ACTOR_ID,
    eventId: null,
    existingEvent: null,
    title: "Accepted Show",
    startsAt: new Date("2026-10-10T00:00:00.000Z"),
    endsAt: new Date("2026-10-10T03:00:00.000Z"),
    location: PLACE_LOCATION,
    clientKey: "caller-tx-client-key",
    ...overrides,
  };
}

/**
 * The caller's transaction handle: the fakes' own `TxRepos`, wrapped so every
 * `<repo>.<method>` that goes THROUGH it is recorded.
 *
 * Deliberately NOT `{ tx } as unknown as Repos` — that shape is the trap that
 * has bitten this repo four times: it leaves `deps.repos.<x>` undefined, the
 * resulting TypeError is eaten by a `catch`, and the test goes green over dead
 * code. Here the underlying fake mocks still fire, so an assertion on
 * `mocks.events.upsertDraft` and one on `calls` corroborate each other.
 */
async function makeCallerTx(
  repos: Repos,
): Promise<{ tx: TxRepos; calls: string[] }> {
  const base = await repos.tx(async (tx) => tx);
  const calls: string[] = [];
  const handle = new Proxy(base as unknown as Record<string, unknown>, {
    get(target, repoName) {
      const repo = Reflect.get(target, repoName);
      if (typeof repoName !== "string") return repo;
      if (repo === null || typeof repo !== "object") return repo;
      return new Proxy(repo as Record<string, unknown>, {
        get(inner, method) {
          const value = Reflect.get(inner, method);
          if (typeof value !== "function" || typeof method !== "string") {
            return value;
          }
          return (...args: unknown[]) => {
            calls.push(`${repoName}.${method}`);
            return (value as (...a: unknown[]) => unknown).apply(inner, args);
          };
        },
      });
    },
  }) as unknown as TxRepos;
  return { tx: handle, calls };
}

/**
 * Replace `deps.repos` with a recorder over the real bag.
 *
 * `touches` is the load-bearing one: on the caller-tx path the save must not
 * read a single property off the root bag — not `tx`, not `savedLocations`.
 * `txSpy` wraps `repos.tx` so "a transaction was opened" is countable, which is
 * what makes the deferred slug work observable AFTER the caller commits.
 *
 * `armed` is dropped before the deferred work runs, because deferred work is
 * SUPPOSED to use the root bag — that is the whole reason it is deferred.
 */
function guardRootRepos(deps: Ctx["deps"]) {
  const real = deps.repos;
  const txSpy = vi.fn(real.tx.bind(real)) as unknown as Repos["tx"];
  real.tx = txSpy;
  const touches: string[] = [];
  let armed = true;
  deps.repos = new Proxy(real, {
    get(target, prop) {
      if (armed && typeof prop === "string") touches.push(prop);
      return Reflect.get(target, prop);
    },
  }) as Repos;
  return {
    touches,
    txSpy: txSpy as unknown as ReturnType<typeof vi.fn>,
    disarm: () => {
      armed = false;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPE-LEVEL REGRESSION — this is a compile-time assertion, not a runtime one.
//
// NOTHING IN THE REPO RUNS IT. `tsconfig.base.json` excludes `**/*.test.ts`
// everywhere, so `pnpm typecheck` walks past this file; `packages/core/
// vitest.config.ts` has no `typecheck` block, so `vitest run` only transpiles.
// There is no config to point you at — you have to make one. It is three lines,
// anywhere outside the repo:
//
//   {"extends":"<repo>/tsconfig.base.json","include":[],
//    "files":["<repo>/packages/core/src/use-cases/events/__tests__/save-event-caller-tx.test.ts"]}
//
//   pnpm exec tsc -p <that file> --noEmit
//
// Errors from `packages/test-utils/**` in that run are pre-existing record-shape
// drift (the base config excludes that package); only lines naming THIS file
// count. Run it after any change to either save entry point's signature.
//
// WHAT IT PINS. The caller-tx entry point must be reachable through a NAMED
// VARIABLE, not only a fresh object literal, and must yield a result carrying
// `deferred`. This was a real defect: while the two entry points were OVERLOADS
// of one name, `FinalizeSaveEventInCallerTxParams` — an intersection, hence a
// SUBTYPE of `FinalizeParams` — bound the FIRST applicable overload for a
// variable (no excess-property check applies to a variable, unlike a literal),
// so the call type-checked as the standalone save and `.deferred` was
// `TS2339: Property 'deferred' does not exist`. Nine of the ten runtime cases
// below pass fresh LITERALS and cannot catch it: literals DO get the
// excess-property check, so they bound the caller-tx signature and went green
// over the hole. (The tenth deliberately passes a variable — but it asserts the
// runtime guard on the WRONG entry point, a different residual, so it does not
// cover this one either.)
//
// The consequence was silent: `runAfterCommit()` never called because the type
// said there was nothing to call ⇒ an accepted booking mints a draft with
// `slug === null` ⇒ its public page 500s on the "Open preview in a new tab"
// link the builder shows pre-publish (`assign-slug-on-create.ts`).
// ─────────────────────────────────────────────────────────────────────────────
async function _typeLevelCallerTxParamsVariableKeepsDeferred(
  deps: Ctx["deps"],
  params: FinalizeSaveEventInCallerTxParams,
): Promise<SaveEventDeferredWork> {
  const result = await finalizeSaveEventInCallerTx(deps, deps.logger, params);
  // If this ever resolves to the standalone return type, `.deferred` stops
  // existing and the scoped test tsconfig fails.
  return result.deferred;
}
void _typeLevelCallerTxParamsVariableKeepsDeferred;

describe("finalizeSaveEvent — caller-supplied transaction (FR-004)", () => {
  it("runs every write through the supplied handle and never opens a transaction of its own", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const { tx, calls } = await makeCallerTx(deps.repos);
    const root = guardRootRepos(deps);

    const result = await finalizeSaveEventInCallerTx(deps, deps.logger, {
      ...baseParams(),
      tx,
      preparedTaxRate: makePreparedRate(deps.clock.now()),
    });

    expect(result.eventId).toBeTruthy();
    // The nesting guard, stated two ways: no transaction was opened, and the
    // root bag was never even reached for.
    expect(root.txSpy).not.toHaveBeenCalled();
    expect(root.touches).toEqual([]);
    // ...and the writes did happen — through the handle that was passed in.
    expect(calls).toContain("events.upsertDraft");
    expect(calls).toContain("events.updateTaxRate");
    expect(calls).toContain("audit.log");
    expect(mocks.events.upsertDraft).toHaveBeenCalledTimes(1);
  });

  it("returns the post-commit work instead of running it, and runs it only when the caller invokes it after committing", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const { tx } = await makeCallerTx(deps.repos);
    const root = guardRootRepos(deps);

    // The marker that flips when the CALLER'S transaction commits. Ordering is
    // asserted against it rather than against call counts, because "the slug
    // ran" and "the slug ran after the commit" are different claims and only
    // the second one is the requirement.
    let txCommitted = false;
    const sequence: string[] = [];
    vi.mocked(mocks.events.assignSlug).mockImplementation(async () => {
      sequence.push(txCommitted ? "slug-after-commit" : "slug-before-commit");
      return {} as never;
    });

    const result = await finalizeSaveEventInCallerTx(deps, deps.logger, {
      ...baseParams(),
      tx,
      preparedTaxRate: makePreparedRate(deps.clock.now()),
    });

    expect(result.deferred.steps).toEqual(["assign-slug-on-create"]);
    expect(mocks.events.assignSlug).not.toHaveBeenCalled();
    expect(sequence).toEqual([]);

    // The caller commits, then drains what the save handed back.
    txCommitted = true;
    root.disarm();
    await result.deferred.runAfterCommit();

    expect(sequence).toEqual(["slug-after-commit"]);
    expect(mocks.events.assignSlug).toHaveBeenCalledTimes(1);
    // The slug takes its OWN transaction off the root bag — which is exactly
    // why it could not run inline while the caller's was still open.
    expect(root.txSpy).toHaveBeenCalledTimes(1);
  });

  it("owes nothing post-commit on an UPDATE, and draining it is a no-op", async () => {
    // Location unchanged AND a rate already stamped — the restamp gate says
    // "leave it alone", so the caller owes no prepared rate at all.
    const existingEvent = makeExistingEvent({
      placeId: DEFAULT_PLACE_ID,
      admissionTaxRateBps: 700,
      taxRateSource: "ziptax",
    });
    const { deps, mocks } = makeCreateEventTestContext({ existingEvent });
    const { tx } = await makeCallerTx(deps.repos);
    const root = guardRootRepos(deps);

    const result = await finalizeSaveEventInCallerTx(deps, deps.logger, {
      ...baseParams({ eventId: existingEvent.id, existingEvent }),
      tx,
    });

    expect(result.deferred.steps).toEqual([]);
    await result.deferred.runAfterCommit();
    expect(mocks.events.assignSlug).not.toHaveBeenCalled();
    expect(mocks.events.updateTaxRate).not.toHaveBeenCalled();
    expect(root.txSpy).not.toHaveBeenCalled();
  });

  it("does not begin, commit or fail an idempotency envelope of its own (FR-005)", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const { tx } = await makeCallerTx(deps.repos);
    guardRootRepos(deps);

    await finalizeSaveEventInCallerTx(deps, deps.logger, {
      ...baseParams(),
      tx,
      preparedTaxRate: makePreparedRate(deps.clock.now()),
    });

    // Including `get`: the replay short-circuit is skipped too, so a caller
    // whose own envelope replayed can never get a half-answer from this one.
    expect(mocks.idempotency.__mocks.get).not.toHaveBeenCalled();
    expect(mocks.idempotency.__mocks.begin).not.toHaveBeenCalled();
    expect(mocks.idempotency.__mocks.commit).not.toHaveBeenCalled();
    expect(mocks.idempotency.__mocks.fail).not.toHaveBeenCalled();
    expect(mocks.idempotency.__store.size).toBe(0);
  });

  it("still runs its own envelope on the no-tx path (the control)", async () => {
    const { deps, mocks } = makeCreateEventTestContext();

    const result = await finalizeSaveEvent(deps, deps.logger, baseParams());

    expect(mocks.idempotency.__mocks.begin).toHaveBeenCalledTimes(1);
    expect(mocks.idempotency.__mocks.commit).toHaveBeenCalledTimes(1);
    // No deferred handle: the standalone path did its own post-commit work.
    expect(result).not.toHaveProperty("deferred");
    expect(mocks.events.assignSlug).toHaveBeenCalledTimes(1);
  });

  it("throws a programmer error — and never calls the tax provider — when a restamp is needed with no prepared rate", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const { tx } = await makeCallerTx(deps.repos);
    guardRootRepos(deps);

    await expect(
      finalizeSaveEventInCallerTx(deps, deps.logger, { ...baseParams(), tx }),
    ).rejects.toThrow(/preparedTaxRate/);

    // The whole point: the fallback is NOT "call the provider anyway". A 5s
    // ZipTax round trip inside the caller's transaction is what P-1 removed.
    expect(mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    // And it refuses BEFORE writing anything, so the caller's rollback has
    // nothing to undo.
    expect(mocks.events.upsertDraft).not.toHaveBeenCalled();
  });

  it("honours the caller's prepared rate: stamped on the event and cached on the place, inside the caller's tx", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const { tx, calls } = await makeCallerTx(deps.repos);
    guardRootRepos(deps);
    const now = deps.clock.now();

    await finalizeSaveEventInCallerTx(deps, deps.logger, {
      ...baseParams(),
      tx,
      preparedTaxRate: makePreparedRate(now),
    });

    expect(mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: expect.any(String),
      admissionTaxRateBps: 812,
      taxRateSource: "caller-prepared",
    });
    // The prepared read ran before the caller's tx, so the cache write is the
    // compare-and-set, matched on the address that read saw.
    expect(mocks.places.fillTaxRateIfUnset).toHaveBeenCalledWith({
      id: DEFAULT_PLACE_ID,
      expectedPostalCode: "12345",
      expectedCountryCode: "US",
      admissionTaxRateBps: 812,
      taxRateSource: "caller-prepared",
      taxRateFetchedAt: now,
    });
    expect(mocks.places.updateTaxRate).not.toHaveBeenCalled();
    // Both writes went through the caller's handle, not a second transaction.
    expect(calls).toContain("places.fillTaxRateIfUnset");
    expect(calls).toContain("events.updateTaxRate");
  });

  it("re-reads the place for the stamp AFTER taking the shared place-location lock, through the caller's handle", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const { tx, calls } = await makeCallerTx(deps.repos);
    guardRootRepos(deps);
    const now = deps.clock.now();
    const getByIdCallsBefore = mocks.places.getById.mock.calls.length;

    await finalizeSaveEventInCallerTx(deps, deps.logger, {
      ...baseParams(),
      tx,
      preparedTaxRate: makePreparedRate(now),
    });

    const lock = vi.mocked(mocks.events.lockLocationsAtPlace);
    expect(lock).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      mode: "shared",
    });
    expect(mocks.places.getById.mock.calls.length).toBeGreaterThan(
      getByIdCallsBefore,
    );
    // The stamp block's re-check: after the lock, before the stamp write.
    // (Later venue-trust code reads the place again, so the stamp's read is
    // the last one BEFORE the stamp write, not the last one overall.)
    const stampWrite = vi.mocked(mocks.events.updateTaxRate).mock
      .invocationCallOrder[0]!;
    const readsBeforeStamp = mocks.places.getById.mock.invocationCallOrder.filter(
      (order) => order < stampWrite,
    );
    const stampRead = readsBeforeStamp[readsBeforeStamp.length - 1]!;
    expect(lock.mock.invocationCallOrder[0]!).toBeLessThan(stampRead);
    expect(stampRead).toBeLessThan(stampWrite);
    // Same order on the handle, so none of it went around the caller's tx.
    const handleStampRead = calls
      .slice(0, calls.indexOf("events.updateTaxRate"))
      .lastIndexOf("places.getById");
    expect(calls.indexOf("events.lockLocationsAtPlace")).toBeGreaterThanOrEqual(
      0,
    );
    expect(calls.indexOf("events.lockLocationsAtPlace")).toBeLessThan(
      handleStampRead,
    );
  });

  // The one branch on this path that could still reach the ROOT bag. The
  // standalone path does this same pre-read on `deps.repos` (it has to — it has
  // not opened its transaction yet), and mirroring that line here would open a
  // SECOND connection that blocks on the caller's advisory hold-line locks:
  // precisely the failure FR-004 exists to prevent, and invisible to every
  // other case here because they are all place-linked and never enter the
  // freeform branch at all.
  it("does the freeform SavedLocation pre-read through the caller's handle, not the root bag", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const { tx, calls } = await makeCallerTx(deps.repos);
    const root = guardRootRepos(deps);
    const now = deps.clock.now();

    await finalizeSaveEventInCallerTx(deps, deps.logger, {
      ...baseParams({
        location: {
          kind: "freeform",
          addressText: "500 Congress Ave, Austin, TX 78701",
          lat: 30.2672,
          lng: -97.7431,
          locality: "Austin",
          region: "TX",
          countryCode: "US",
          postalCode: "78701",
        },
      }),
      tx,
      // An address with no SavedLocation yet: the caller resolved it INLINE, so
      // there is no row to name as a cache target until the save mints one.
      preparedTaxRate: {
        stamp: {
          rateBps: 812,
          source: "caller-prepared",
          situs: { countryCode: "US", region: "TX", postalCode: "78701" },
        },
        fresh: { rateBps: 812, source: "caller-prepared", fetchedAt: now },
        cacheTarget: null,
        cacheAddress: { postalCode: "78701", countryCode: "US" },
      },
    });

    // TWO reads, both through the handle: the gate's pre-read and the body's
    // authoritative one (the standalone path issues the same pair, one on the
    // root bag and one in-tx). Counting them is what makes this assertion
    // load-bearing — a pre-read leaked to the root bag still leaves ONE here.
    expect(
      calls.filter((c) => c === "savedLocations.findByOwnerAndAddress"),
    ).toHaveLength(2);
    expect(root.touches).toEqual([]);
    expect(root.txSpy).not.toHaveBeenCalled();
    // ...and the fresh answer landed on the row the save minted, in the
    // caller's transaction.
    expect(calls).toContain("savedLocations.create");
    expect(calls).toContain("savedLocations.fillTaxRateIfUnset");
    expect(mocks.savedLocations.fillTaxRateIfUnset).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPostalCode: "78701",
        expectedCountryCode: "US",
        admissionTaxRateBps: 812,
        taxRateSource: "caller-prepared",
      }),
    );
  });

  // The residual the two-function split cannot close at the type level.
  // `FinalizeSaveEventInCallerTxParams` is a structural SUBTYPE of
  // `FinalizeParams`, and a named variable gets no excess-property check, so
  // handing caller-tx params to the STANDALONE function compiles with zero
  // errors (measured with a throwaway probe). Without the guard it would ignore
  // the handle, call `deps.repos.tx`, and block on the caller's own advisory
  // locks until Prisma's `maxWait` gives up — a plausible copy-paste for the
  // FR-001 accept caller.
  it("refuses caller-tx params handed to the STANDALONE entry point, without opening a transaction", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const { tx } = await makeCallerTx(deps.repos);
    const root = guardRootRepos(deps);

    // Deliberately the wrong entry point. Typed as the caller-tx params a real
    // mis-dial would carry, then widened, because TS is exactly what fails to
    // catch this.
    const callerTxParams: FinalizeSaveEventInCallerTxParams = {
      ...baseParams(),
      tx,
      preparedTaxRate: makePreparedRate(deps.clock.now()),
    };

    await expect(
      finalizeSaveEvent(
        deps,
        deps.logger,
        callerTxParams as unknown as FinalizeParams,
      ),
    ).rejects.toThrow(/finalizeSaveEventInCallerTx/);

    // The whole point of the guard: it fires BEFORE any transaction is opened,
    // so the nested-transaction stall never happens.
    expect(root.txSpy).not.toHaveBeenCalled();
    expect(root.touches).toEqual([]);
    expect(mocks.events.upsertDraft).not.toHaveBeenCalled();
    // Nor does it touch the envelope on the way out.
    expect(mocks.idempotency.__mocks.begin).not.toHaveBeenCalled();
    expect(mocks.idempotency.__mocks.fail).not.toHaveBeenCalled();
  });

  it("propagates a mid-save failure to the caller and hands back no deferred work", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const { tx } = await makeCallerTx(deps.repos);
    const root = guardRootRepos(deps);
    const boom = new Error("audit write exploded");
    mocks.audit.log.mockRejectedValueOnce(boom);

    await expect(
      finalizeSaveEventInCallerTx(deps, deps.logger, {
        ...baseParams(),
        tx,
        preparedTaxRate: makePreparedRate(deps.clock.now()),
      }),
    ).rejects.toBe(boom);

    // Nothing post-commit can have run: the caller's transaction is about to
    // roll back, and there is no result to carry deferred work on.
    expect(mocks.events.assignSlug).not.toHaveBeenCalled();
    expect(root.txSpy).not.toHaveBeenCalled();
    // No envelope to mark failed either — the caller owns the only one.
    expect(mocks.idempotency.__mocks.fail).not.toHaveBeenCalled();
  });
});
