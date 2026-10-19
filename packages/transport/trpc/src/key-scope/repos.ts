import { TRPCError } from "@trpc/server";
import type { ApiKeyScope } from "@th/ports/authn";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { AuthZRepo, OrgMembership } from "@th/ports/repos/authz";

type ScopedKey = Extract<ApiKeyScope, { kind: "scoped" }>;

/**
 * The role reads of `repos.authz`, narrowed to one scoped key (FR-006 c/d,
 * spec risk 1). Most of core authorises through these reads, not through
 * the authz port: `rbac.ts` (`requireOrgMembership`, `requireOwnerAccess`,
 * `requireScannerAccessOnOrg`), ~50 direct `getOrgMembership` callers, and a
 * few routers. `scopeAuthzToKey` alone would leave all of them answering
 * with the holder's full roles.
 *
 * - `getOrgMembership`: the real row only for the ORG key's own org; null
 *   for any other org and under any other subject.
 * - `getOrgMemberships` / `listOrgMembershipsByHumanId`: filtered to the ORG
 *   key's org; empty under any other subject.
 * - `getStaffRolesForHumanId`: the real roles under a STAFF key; [] otherwise.
 * - `getHumanDelegation`: null under every key. A delegation lets one human
 *   act with another's role, which no key subject covers.
 *
 * Like `scopeAuthzToKey`, every read is narrowed whoever it asks about.
 * Untouched: `listHumanIdsByStaffRole` (notification fan-out, grants the
 * caller nothing), `listSecondFactorStaffAuthUsers` (only the ops sweep
 * reads it), the resource lookups (`getEventOrgId`, ...), and the
 * writes (`grantHumanRole`, ...; their callers are denylisted or staff-gated
 * through the narrowed reads).
 *
 * The real authz PORT is built in the composition root over the unwrapped
 * repos, so the gate's live-role probe and `scopeAuthzToKey`'s pass-through
 * still see the holder's real roles: this wrapper narrows what a USE CASE
 * sees, never what the authz adapter sees.
 */
export function scopeAuthzRepoToKey(
  authz: AuthZRepo,
  key: ScopedKey,
): AuthZRepo {
  const keyOrg =
    key.subject === "ORG" && key.orgId !== null ? key.orgId : null;
  const inKeyOrg = (m: OrgMembership) => keyOrg !== null && m.orgId === keyOrg;

  const narrowed: Partial<AuthZRepo> = {
    async getOrgMembership(input) {
      if (keyOrg === null || input.orgId !== keyOrg) return null;
      const membership = await authz.getOrgMembership(input);
      return membership && inKeyOrg(membership) ? membership : null;
    },
    async getOrgMemberships(input) {
      if (keyOrg === null || !input.orgIds.includes(keyOrg)) return [];
      const rows = await authz.getOrgMemberships({
        ...input,
        orgIds: [keyOrg],
      });
      return rows.filter(inKeyOrg);
    },
    async listOrgMembershipsByHumanId(input) {
      if (keyOrg === null) return [];
      return (await authz.listOrgMembershipsByHumanId(input)).filter(inKeyOrg);
    },
    async getStaffRolesForHumanId(humanId) {
      if (key.subject !== "STAFF") return [];
      return authz.getStaffRolesForHumanId(humanId);
    },
    async getHumanDelegation() {
      return null;
    },
  };

  return new Proxy(authz, {
    get(target, prop) {
      if (typeof prop === "string" && Object.hasOwn(narrowed, prop)) {
        return narrowed[prop as keyof AuthZRepo];
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Wrap one repo so the named methods are replaced and the rest pass through
 * bound to the real repo.
 */
const overrideMethods = <T extends object>(
  repo: T,
  overrides: Partial<T>,
): T =>
  new Proxy(repo, {
    get(target, prop) {
      if (typeof prop === "string" && Object.hasOwn(overrides, prop)) {
        return overrides[prop as keyof T];
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/**
 * Authority that lives outside `repos.authz` and belongs to a PERSON, not to
 * an org or a staff role:
 *
 * - `humanDelegates.getDelegation` / `listPrincipalsForDelegate`: null / []
 *   under every key. A delegation lets one human act with another's role
 *   (`resolve-ask-ownership.ts`, the delegate use cases, the booker gate's
 *   reverse read), which no key subject covers; the same rule as
 *   `getHumanDelegation` above.
 * - `placeBookingGrants.findActiveForActor` / `listActiveForActor`: null /
 *   [] unless the key is PERSONAL. A booking grant authorises its grantee
 *   at a place (the booker gate, `place-access.ts` `findPlaceBookerGrant` /
 *   `listPlaceBookerGrants`, read by `builder-venue-trust.ts`,
 *   `saved-snippet-owner.ts` and
 *   `create-booking-request-from-event.ts`); an ORG or STAFF key acts for
 *   the org or the role, never as that person. An ORG key does not act
 *   under its org's grant either (holds-without-a-request step 4): giving a
 *   key subject booker authority is its own decision, refused until made.
 *
 * - the grant LIFECYCLE (holds-without-a-request FR-003, plan step 5,
 *   carried item j): giving, answering, editing and revoking a grant, and
 *   the reads behind them, are session-only under EVERY key subject,
 *   PERSONAL included. A grant changes who may make events at a place; a
 *   grantee's yes is a person's consent (R32), and a place's give / revoke
 *   is a members-and-roles decision (R4). The writes (`create`, `accept`,
 *   `decline`, `update`, `revoke`) throw the gate's FORBIDDEN shape; the
 *   reads (`getForPlace`, `getForGrantee`, `listForPlace`,
 *   `listForGrantee`) answer null / [] so a key sees no grant to act on.
 *   This override covers every SCOPED key wherever the use cases are
 *   reached from; LEGACY keys (no subject) get the unwrapped repos
 *   (gate.ts) and are covered by the denylist instead: step 9 adds the
 *   `placeBookingGrants.` router prefix with the router (no procedure
 *   exists before it, and `procedure-tags.test.ts` refuses a prefix that
 *   matches nothing). The expiry job (`listExpiring`, `markExpiryWarned`)
 *   runs with no key and passes through, as does `lockPlace` (a lock
 *   writes nothing; `create` behind it is refused).
 *
 * `listDelegates` / `countDelegatesByRole` grant nothing (lists and
 * notification fan-out) and their management callers are denylisted
 * (`delegates.`), so they pass through.
 */
export const GRANT_LIFECYCLE_SESSION_ONLY = "place_booking_grant_session_only";

const grantLifecycleRefused = (): never => {
  throw new TRPCError({
    code: "FORBIDDEN",
    message: `API_KEY_SCOPE: ${GRANT_LIFECYCLE_SESSION_ONLY}`,
  });
};

const personalAuthorityOverrides = (
  repos: TxRepos,
  key: ScopedKey,
): {
  humanDelegates: TxRepos["humanDelegates"];
  placeBookingGrants: TxRepos["placeBookingGrants"];
} => ({
  humanDelegates: overrideMethods(repos.humanDelegates, {
    async getDelegation() {
      return null;
    },
    async listPrincipalsForDelegate() {
      return [];
    },
  }),
  placeBookingGrants: overrideMethods(repos.placeBookingGrants, {
    // Booker authority: a PERSONAL key acts as its holder (step 4).
    ...(key.subject === "PERSONAL"
      ? {}
      : {
          async findActiveForActor() {
            return null;
          },
          async listActiveForActor() {
            return [];
          },
        }),
    // The lifecycle: session-only under every subject (see above).
    async getForPlace() {
      return null;
    },
    async getForGrantee() {
      return null;
    },
    async listForPlace() {
      return [];
    },
    async listForGrantee() {
      return [];
    },
    async create() {
      return grantLifecycleRefused();
    },
    async accept() {
      return grantLifecycleRefused();
    },
    async decline() {
      return grantLifecycleRefused();
    },
    async update() {
      return grantLifecycleRefused();
    },
    async revoke() {
      return grantLifecycleRefused();
    },
  }),
});

const narrowRepos = <R extends TxRepos>(repos: R, key: ScopedKey): R => {
  let authz: AuthZRepo | undefined;
  let personal: ReturnType<typeof personalAuthorityOverrides> | undefined;
  return new Proxy(repos, {
    get(target, prop) {
      if (prop === "authz") {
        authz ??= scopeAuthzRepoToKey(target.authz, key);
        return authz;
      }
      if (prop === "humanDelegates" || prop === "placeBookingGrants") {
        personal ??= personalAuthorityOverrides(target, key);
        return personal[prop];
      }
      if (prop === "tx" && "tx" in target) {
        const tx = (target as unknown as Repos).tx.bind(target);
        const wrapped: Repos["tx"] = <T>(
          fn: (txRepos: TxRepos) => Promise<T>,
          options?: Parameters<Repos["tx"]>[1],
        ) => tx<T>((txRepos) => fn(narrowRepos(txRepos, key)), options);
        return wrapped;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

/**
 * `ctx.repos` for one scoped-key call: `repos.authz` narrowed (see
 * {@link scopeAuthzRepoToKey}), delegations and place booking grants
 * narrowed (see `personalAuthorityOverrides`), and every `repos.tx(...)`
 * hands its callback narrowed tx repos too. Everything else passes through.
 */
export function scopeReposToKey(repos: Repos, key: ScopedKey): Repos {
  return narrowRepos(repos, key);
}
