import { Prisma } from "@prisma/client";
import { verifyPassword as verifyPasswordHash } from "better-auth/crypto";

import { fail } from "@th/errors";
import {
  buildOffsetPaginatedResult,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";
import type {
  AuthIdentityRecord,
  HumanRecord,
  HumanWithIdentity,
  HumanWithPage,
  HumanWithMemberships,
  HumanOrgMembershipSummary,
  ListAllHumansWithMembershipsInput,
  HumansRepo,
  UpdateHumanJobsInput,
} from "@th/ports/repos/humans";

import type { PrismaClientOrTx } from "./types";
import {
  holdsEmailAttachedRowsInDb,
  listHumanIdsHoldingEmailAttachedRowsInDb,
} from "./email-attached-rows";

export function makeHumansRepo(p: PrismaClientOrTx): HumansRepo {
  const select = {
    id: true,
    name: true,
    status: true,
    roles: true,
    locale: true,
    themeMode: true,
    phone: true,
    billingAddressLine1: true,
    billingAddressLine2: true,
    billingCity: true,
    billingState: true,
    billingPostalCode: true,
    billingCountry: true,
    defaultPrimaryPayoutTermsId: true,
    defaultResalePayoutTermsId: true,
    trustTier: true,
    trustBadgeLabel: true,
    trustBadgeIcon: true,
    chargebackTermsVersion: true,
    chargebackTermsAcceptedAt: true,
    scannerTermsAckAt: true,
    scannerTermsAckVersion: true,
    scannerTermsAckIp: true,
    scannerTermsAckUserAgent: true,
    jobs: true,
    genreTags: true,
    otherJobDescription: true,
    createdAt: true,
  } as const;

  const authUserSelect = {
    id: true,
    email: true,
    emailVerified: true,
    phoneNumber: true,
    phoneNumberVerified: true,
    username: true,
    displayUsername: true,
    image: true,
  } as const;

  const mapToIdentity = (authUser: {
    id: string;
    email: string;
    emailVerified: boolean;
    phoneNumber: string | null;
    phoneNumberVerified: boolean;
    username: string | null;
    displayUsername: string | null;
    image: string | null;
  }): AuthIdentityRecord => ({
    authUserId: authUser.id,
    email: authUser.email,
    emailVerified: authUser.emailVerified,
    phone: authUser.phoneNumber,
    phoneVerified: authUser.phoneNumberVerified,
    username: authUser.username,
    displayUsername: authUser.displayUsername,
    image: authUser.image,
  });

  return {
    getById: (id: string) => p.human.findUnique({ where: { id }, select }),

    getByIds: async (ids: string[]) => {
      if (ids.length === 0) return [];
      const records = await p.human.findMany({
        where: { id: { in: ids } },
        select,
      });
      return records.filter((r): r is NonNullable<typeof r> => r !== null);
    },

    getByIdWithIdentity: async (
      id: string,
    ): Promise<HumanWithIdentity | null> => {
      const result = await p.human.findUnique({
        where: { id },
        select: {
          ...select,
          authUser: { select: authUserSelect },
        },
      });
      if (!result || !result.authUser) return null;
      return {
        human: {
          id: result.id,
          name: result.name,
          status: result.status,
          roles: result.roles,
          locale: result.locale,
          themeMode: result.themeMode,
          phone: result.phone,
          billingAddressLine1: result.billingAddressLine1,
          billingAddressLine2: result.billingAddressLine2,
          billingCity: result.billingCity,
          billingState: result.billingState,
          billingPostalCode: result.billingPostalCode,
          billingCountry: result.billingCountry,
          defaultPrimaryPayoutTermsId:
            result.defaultPrimaryPayoutTermsId ?? null,
          defaultResalePayoutTermsId: result.defaultResalePayoutTermsId ?? null,
          trustTier: result.trustTier,
          trustBadgeLabel: result.trustBadgeLabel,
          trustBadgeIcon: result.trustBadgeIcon,
          chargebackTermsVersion: result.chargebackTermsVersion ?? null,
          chargebackTermsAcceptedAt: result.chargebackTermsAcceptedAt ?? null,
          scannerTermsAckAt: result.scannerTermsAckAt ?? null,
          scannerTermsAckVersion: result.scannerTermsAckVersion ?? null,
          scannerTermsAckIp: result.scannerTermsAckIp ?? null,
          scannerTermsAckUserAgent: result.scannerTermsAckUserAgent ?? null,
          jobs: result.jobs,
          genreTags: result.genreTags,
          otherJobDescription: result.otherJobDescription,
          createdAt: result.createdAt,
        },
        identity: mapToIdentity(result.authUser),
      };
    },

    getAccountCreatedAt: async (humanId: string): Promise<Date | null> => {
      // When the person first signed in (owner ruling 2026-10-07: "A new
      // account is new the moment it gets created"). Stored once in
      // auth_user.first_signed_in_at by better-auth's session.create.after
      // hook and never cleared (one exception: the unproven-account sweep
      // clears it so the inbox prover's sign-in dates the account), so
      // deleting sessions (sign-out, expiry, "sign out everywhere") no longer
      // makes an account look new. The earliest
      // auth_account / auth_session / passkey row still takes part in the
      // LEAST: it covers an account whose stamp is missing (stamp write
      // failed) and can only move the date earlier. LEAST skips NULLs.
      // NOT auth_user.created_at: a guest checkout's `ensureGuestHuman` makes
      // that row (no sign-in) and a later sign-in takes it over. One
      // statement: human_id is unique on auth_user, and the three tables are
      // indexed on user_id.
      const rows = await p.$queryRaw<Array<{ createdAt: Date | null }>>(
        Prisma.sql`
          SELECT LEAST(
            u.first_signed_in_at,
            (SELECT MIN(a.created_at) FROM auth_account a WHERE a.user_id = u.id),
            (SELECT MIN(s.created_at) FROM auth_session s WHERE s.user_id = u.id),
            (SELECT MIN(k.created_at) FROM passkey k WHERE k.user_id = u.id)
          ) AS "createdAt"
          FROM auth_user u
          WHERE u.human_id = ${humanId}
        `,
      );
      return rows[0]?.createdAt ?? null;
    },

    stampFirstSignInIfUnset: async (
      authUserId: string,
      at: Date,
    ): Promise<void> => {
      // Set-once: the NULL guard is in the WHERE, so a concurrent or later
      // sign-in matches no row and the first stamp stands.
      await p.authUser.updateMany({
        where: { id: authUserId, firstSignedInAt: null },
        data: { firstSignedInAt: at },
      });
    },

    getByEmail: async (email: string): Promise<HumanWithIdentity | null> => {
      const authUser = await p.authUser.findUnique({
        where: { email },
        select: {
          ...authUserSelect,
          human: { select },
        },
      });
      if (!authUser || !authUser.human) return null;
      return {
        human: authUser.human,
        identity: mapToIdentity(authUser),
      };
    },

    getByPhone: async (phone: string): Promise<HumanWithIdentity | null> => {
      const authUser = await p.authUser.findUnique({
        where: { phoneNumber: phone },
        select: {
          ...authUserSelect,
          human: { select },
        },
      });
      if (!authUser || !authUser.human) return null;
      return {
        human: authUser.human,
        identity: mapToIdentity(authUser),
      };
    },

    getByUsername: async (
      username: string,
    ): Promise<HumanWithIdentity | null> => {
      // Case-insensitive exact match against `username` (the canonical key
      // Better Auth uses) — `displayUsername` is a presentation alias and
      // not guaranteed unique, so we don't search it here.
      const normalized = username.trim().toLowerCase();
      if (!normalized) return null;
      const authUser = await p.authUser.findFirst({
        where: { username: normalized },
        select: {
          ...authUserSelect,
          human: { select },
        },
      });
      if (!authUser || !authUser.human) return null;
      return {
        human: authUser.human,
        identity: mapToIdentity(authUser),
      };
    },

    batchLookupHumanIdsByEmail: async (
      emails: string[],
    ): Promise<Map<string, string>> => {
      if (!emails.length) return new Map();
      const rows = await p.authUser.findMany({
        where: { email: { in: emails }, humanId: { not: null } },
        select: { email: true, humanId: true },
      });
      const map = new Map<string, string>();
      for (const row of rows) {
        if (row.humanId) {
          map.set(row.email, row.humanId);
        }
      }
      return map;
    },

    lockForAuthUser: async (authUserId: string) => {
      // Transaction-scoped advisory lock so concurrent provisions for the SAME
      // auth user serialize. `hashtext` maps the id deterministically to a
      // bigint key; `pg_advisory_xact_lock` releases automatically when the
      // surrounding transaction commits or rolls back, so the next waiter then
      // sees the committed `AuthUser.humanId` link and no-ops (preventing a
      // duplicate Human). Parameterized to avoid SQL injection.
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${authUserId}))`;
    },

    getHumanIdForAuthUserId: async (authUserId: string) => {
      const row = await p.authUser.findUnique({
        where: { id: authUserId },
        select: { humanId: true },
      });
      return row?.humanId ? { humanId: row.humanId } : null;
    },

    getAuthActorForAuthUserId: async (authUserId, opts) => {
      const sessionId = opts?.sessionId;
      const row = await p.authUser.findUnique({
        where: { id: authUserId },
        select: {
          humanId: true,
          human: { select: { status: true } },
          // Same findUnique: the session-binding check rides the status read.
          ...(sessionId
            ? {
                sessions: {
                  where: {
                    id: sessionId,
                    expiresAt: { gt: opts?.now ?? new Date() },
                  },
                  select: { id: true },
                  take: 1,
                },
              }
            : {}),
        },
      });
      if (!row?.humanId || !row.human) return null;
      const sessions = (row as { sessions?: { id: string }[] }).sessions;
      return {
        humanId: row.humanId,
        status: row.human.status,
        sessionActive: sessionId ? (sessions?.length ?? 0) > 0 : null,
      };
    },

    linkAuthUserToHuman: async ({ authUserId, humanId }) => {
      const updated = await p.authUser.update({
        where: { id: authUserId },
        data: { humanId },
        select: { humanId: true },
      });
      if (!updated.humanId) {
        throw new Error("Failed to link auth user to human");
      }
      return { humanId: updated.humanId };
    },

    create: async ({ name, status, locale, source }) =>
      p.human.create({
        data: {
          name: name ?? undefined,
          status,
          locale: locale ?? null,
          ...(source ? { source } : {}),
        },
        select,
      }),

    update: async (id: string, updates: Partial<HumanRecord>) => {
      const data: Record<string, unknown> = {};
      if (Object.prototype.hasOwnProperty.call(updates, "name")) {
        data.name = updates.name ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(updates, "status")) {
        data.status = updates.status ?? "ACTIVE";
      }
      if (Object.prototype.hasOwnProperty.call(updates, "locale")) {
        data.locale = updates.locale ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(updates, "themeMode")) {
        data.themeMode = updates.themeMode ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(updates, "phone")) {
        data.phone = updates.phone ?? null;
      }
      if (
        Object.prototype.hasOwnProperty.call(updates, "billingAddressLine1")
      ) {
        data.billingAddressLine1 = updates.billingAddressLine1 ?? null;
      }
      if (
        Object.prototype.hasOwnProperty.call(updates, "billingAddressLine2")
      ) {
        data.billingAddressLine2 = updates.billingAddressLine2 ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(updates, "billingCity")) {
        data.billingCity = updates.billingCity ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(updates, "billingState")) {
        data.billingState = updates.billingState ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(updates, "billingPostalCode")) {
        data.billingPostalCode = updates.billingPostalCode ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(updates, "billingCountry")) {
        data.billingCountry = updates.billingCountry ?? null;
      }
      if (
        Object.prototype.hasOwnProperty.call(
          updates,
          "defaultPrimaryPayoutTermsId",
        )
      ) {
        data.defaultPrimaryPayoutTermsId =
          updates.defaultPrimaryPayoutTermsId ?? null;
      }
      if (
        Object.prototype.hasOwnProperty.call(
          updates,
          "defaultResalePayoutTermsId",
        )
      ) {
        data.defaultResalePayoutTermsId =
          updates.defaultResalePayoutTermsId ?? null;
      }

      return p.human.update({ where: { id }, data, select });
    },

    setDefaultPrimaryPayoutTermsIdIfNull: async (input: {
      id: string;
      payoutTermsId: string;
    }) => {
      // Guarded compare-and-swap (mirrors payout-terms `activate`): the WHERE
      // pins the pointer to NULL, so a concurrent transaction that already set
      // it results in a 0-match instead of a silent overwrite. Callers re-read
      // and adopt the winner's row on `false`.
      const result = await p.human.updateMany({
        where: { id: input.id, defaultPrimaryPayoutTermsId: null },
        data: { defaultPrimaryPayoutTermsId: input.payoutTermsId },
      });
      return result.count === 1;
    },

    setThemeMode: async (humanId: string, mode: "light" | "dark") => {
      await p.human.update({
        where: { id: humanId },
        data: { themeMode: mode },
        select: { id: true },
      });
    },

    acceptChargebackTerms: async ({ humanId, version, acceptedAt }) => {
      return p.human.update({
        where: { id: humanId },
        data: {
          chargebackTermsVersion: version,
          chargebackTermsAcceptedAt: acceptedAt,
        },
        select,
      });
    },

    acknowledgeScannerTerms: async ({
      humanId,
      version,
      acknowledgedAt,
      ipAddress,
      userAgent,
    }) => {
      return p.human.update({
        where: { id: humanId },
        data: {
          scannerTermsAckAt: acknowledgedAt,
          scannerTermsAckVersion: version,
          scannerTermsAckIp: ipAddress,
          scannerTermsAckUserAgent: userAgent,
        },
        select,
      });
    },

    updateJobs: async (id: string, input: UpdateHumanJobsInput) => {
      return p.human.update({
        where: { id },
        data: {
          // TODO: Prisma expects its own enum array type; cast is safe because input is Zod-validated
          jobs: input.jobs as any,
          genreTags: input.genreTags,
          otherJobDescription: input.otherJobDescription,
        },
        select,
      });
    },

    searchByQuery: async (
      query: string,
      opts?: { limit?: number; excludeHumanId?: string },
    ): Promise<HumanWithIdentity[]> => {
      const trimmed = query.trim();
      if (!trimmed) return [];

      const limit = Math.min(opts?.limit ?? 10, 50);

      // Exact email match OR case-insensitive prefix on username / displayUsername / name
      const isEmail = trimmed.includes("@");
      const where: Record<string, unknown> = {
        humanId: opts?.excludeHumanId
          ? { not: opts.excludeHumanId } // implicitly excludes null
          : { not: null }, // must be linked to a Human
        human: { status: "ACTIVE" },
      };

      let rows: Array<{
        id: string;
        email: string;
        emailVerified: boolean;
        phoneNumber: string | null;
        phoneNumberVerified: boolean;
        username: string | null;
        displayUsername: string | null;
        image: string | null;
        human: {
          id: string;
          name: string | null;
          status: string;
          roles: string[];
          locale: string | null;
          defaultPrimaryPayoutTermsId: string | null;
          defaultResalePayoutTermsId: string | null;
          trustTier: string;
          trustBadgeLabel: string | null;
          trustBadgeIcon: string | null;
          createdAt: Date;
        };
      }>;

      if (isEmail) {
        // Exact email match
        rows = (await p.authUser.findMany({
          where: { ...where, email: trimmed.toLowerCase() },
          select: { ...authUserSelect, human: { select } },
          take: limit,
        })) as typeof rows;
      } else {
        // Case-insensitive search on username, displayUsername, name
        rows = (await p.authUser.findMany({
          where: {
            ...where,
            OR: [
              { username: { startsWith: trimmed, mode: "insensitive" } },
              { displayUsername: { startsWith: trimmed, mode: "insensitive" } },
              { name: { contains: trimmed, mode: "insensitive" } },
            ],
          },
          select: { ...authUserSelect, human: { select } },
          take: limit,
        })) as typeof rows;
      }

      return rows
        .filter((r) => r.human != null)
        .filter(
          (r) => !opts?.excludeHumanId || r.human.id !== opts.excludeHumanId,
        )
        .map((r) => ({
          human: r.human as HumanRecord,
          identity: mapToIdentity(r),
        }));
    },

    // Provider linkage — now goes through AuthUser
    ensureByProvider: async ({ email, name }) => {
      if (!email)
        throw new Error("email is required to ensure human by provider");

      // Look up by AuthUser email
      const authUser = await p.authUser.findUnique({
        where: { email },
        select: { humanId: true, id: true },
      });

      if (authUser?.humanId) {
        // Human exists and is linked
        if (name) {
          await p.human.update({
            where: { id: authUser.humanId },
            data: { name },
            select: { id: true },
          });
        }
        return { humanId: authUser.humanId, created: false };
      }

      // Create new Human and link to AuthUser
      const created = await p.human.create({
        data: { name: name ?? undefined },
        select: { id: true },
      });

      if (authUser) {
        // Link existing AuthUser to new Human
        await p.authUser.update({
          where: { id: authUser.id },
          data: { humanId: created.id },
        });
      }

      return { humanId: created.id, created: true };
    },

    ensureGuestHuman: async ({ email, name }) => {
      // 1. Check if an AuthUser already exists for this email
      const existing = await p.authUser.findUnique({
        where: { email },
        select: { humanId: true },
      });

      if (existing?.humanId) {
        // Already linked: resolve, never rename. Whoever passes `name` here
        // (a guest form, an organiser, a door sale) is not the account
        // holder, so a guest purchase must not overwrite the account's name
        // (B2, owner ruling 2026-10-16). `name` is used only when this call
        // mints the Human below.
        return { humanId: existing.humanId, created: false };
      }

      // 2. Create a Human + shadow AuthUser in one shot.
      //
      // `name` is OPTIONAL and applies only here, on a Human this call
      // creates (the branch above never renames). `AuthUser.name` is NOT NULL,
      // so when it is omitted the column falls back to the address's local
      // part — auth-layer metadata only, never rendered as a profile name.
      // `Human.name` is nullable and stays NULL, so the caller can set a
      // display name itself on the `created: true` branch.
      const human = await p.human.create({
        data: {
          name: name ?? null,
          status: "ACTIVE",
          authUser: {
            create: {
              name: name ?? email.split("@")[0] ?? email,
              email,
              emailVerified: false,
            },
          },
        },
        select: { id: true },
      });

      return { humanId: human.id, created: true };
    },

    getAuthUserById: async (authUserId: string) => {
      const row = await p.authUser.findUnique({
        where: { id: authUserId },
        select: { id: true, email: true, name: true, image: true },
      });
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        name: row.name ?? null,
        image: row.image ?? null,
      };
    },

    listForSearchIndex: async ({ limit, offset }) => {
      const page = sanitizeOffsetPagination({
        limit,
        offset,
        defaultLimit: 100,
        maxLimit: 1000,
      });

      const where = {
        ownerType: "HUMAN" as const,
        visibility: "PUBLIC" as const,
      };

      const [total, pages] = await Promise.all([
        p.entityPage.count({ where }),
        p.entityPage.findMany({
          where,
          select: {
            ownerId: true,
            displayName: true,
            slug: true,
            avatarUrl: true,
            bannerUrl: true,
          },
          orderBy: [{ ownerId: "asc" }],
          take: page.limit,
          skip: page.offset,
        }),
      ]);

      // Fetch associated humans + auth users in bulk
      const ownerIds = pages.map((pg) => pg.ownerId);
      const humans = await p.human.findMany({
        where: { id: { in: ownerIds }, status: "ACTIVE" },
        select: {
          ...select,
          authUser: { select: authUserSelect },
        },
      });
      const humanMap = new Map(humans.map((h) => [h.id, h]));

      const items: HumanWithPage[] = pages
        .filter((pg) => humanMap.has(pg.ownerId))
        .map((pg) => {
          const human = humanMap.get(pg.ownerId)!;
          return {
            human: {
              id: human.id,
              name: human.name,
              status: human.status,
              roles: human.roles,
              locale: human.locale,
              phone: human.phone,
              billingAddressLine1: human.billingAddressLine1,
              billingAddressLine2: human.billingAddressLine2,
              billingCity: human.billingCity,
              billingState: human.billingState,
              billingPostalCode: human.billingPostalCode,
              billingCountry: human.billingCountry,
              defaultPrimaryPayoutTermsId:
                human.defaultPrimaryPayoutTermsId ?? null,
              defaultResalePayoutTermsId:
                human.defaultResalePayoutTermsId ?? null,
              trustTier: human.trustTier,
              trustBadgeLabel: human.trustBadgeLabel,
              trustBadgeIcon: human.trustBadgeIcon,
              jobs: human.jobs,
              genreTags: human.genreTags,
              otherJobDescription: human.otherJobDescription,
              createdAt: human.createdAt,
            },
            page: {
              ownerId: pg.ownerId,
              displayName: pg.displayName,
              slug: pg.slug,
              avatarUrl: pg.avatarUrl,
              bannerUrl: pg.bannerUrl,
            },
            identity: human.authUser
              ? mapToIdentity(human.authUser)
              : undefined,
          };
        });

      return buildOffsetPaginatedResult({
        items,
        total,
        limit: page.limit,
        offset: page.offset,
      });
    },

    listAllWithMemberships: async (
      input: ListAllHumansWithMembershipsInput,
    ) => {
      const page = sanitizeOffsetPagination({
        limit: input.limit,
        offset: input.offset,
        defaultLimit: 25,
        maxLimit: 100,
      });

      // Build where clause for Human
      const humanWhere: Record<string, unknown> = {};
      if (input.status) {
        humanWhere.status = input.status;
      }
      if (input.humanIds) {
        humanWhere.id = { in: input.humanIds };
      }

      // If searching, we need to join through AuthUser
      const hasSearchOrEmailFilter =
        Boolean(input.searchQuery?.trim()) || input.emailVerified !== undefined;

      // Build AuthUser sub-filter
      const authUserWhere: Record<string, unknown> | undefined =
        hasSearchOrEmailFilter ? {} : undefined;

      if (input.emailVerified !== undefined && authUserWhere) {
        authUserWhere.emailVerified = input.emailVerified;
      }

      if (input.searchQuery?.trim() && authUserWhere) {
        const q = input.searchQuery.trim();
        const isEmail = q.includes("@");
        if (isEmail) {
          authUserWhere.email = { contains: q, mode: "insensitive" };
        } else {
          // Wrap the OR inside the authUser filter
          authUserWhere.OR = [
            { username: { contains: q, mode: "insensitive" } },
            { displayUsername: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ];
        }
      }

      if (input.searchQuery?.trim() && !input.searchQuery.includes("@")) {
        // Also search on Human.name
        const q = input.searchQuery.trim();
        const nameFilter = {
          name: { contains: q, mode: "insensitive" as const },
        };

        if (authUserWhere) {
          // Human must match name OR have authUser matching
          humanWhere.OR = [nameFilter, { authUser: authUserWhere }];
        } else {
          humanWhere.OR = [nameFilter];
        }
      } else if (authUserWhere) {
        humanWhere.authUser = authUserWhere;
      }

      // Sort
      type OrderByItem = Record<string, "asc" | "desc">;
      let orderBy: OrderByItem[] = [{ createdAt: "desc" }];
      if (input.sort === "createdAt_asc") orderBy = [{ createdAt: "asc" }];
      else if (input.sort === "name_asc") orderBy = [{ name: "asc" }];
      else if (input.sort === "name_desc") orderBy = [{ name: "desc" }];

      const [total, humans] = await Promise.all([
        p.human.count({ where: humanWhere }),
        p.human.findMany({
          where: humanWhere,
          select: {
            ...select,
            authUser: { select: authUserSelect },
            orgMembers: {
              select: {
                orgId: true,
                role: true,
                org: {
                  select: {
                    name: true,
                    slug: true,
                  },
                },
              },
            },
          },
          orderBy,
          take: page.limit,
          skip: page.offset,
        }),
      ]);

      const items: HumanWithMemberships[] = humans.map((h) => ({
        human: {
          id: h.id,
          name: h.name,
          status: h.status,
          roles: h.roles,
          locale: h.locale,
          phone: h.phone,
          billingAddressLine1: h.billingAddressLine1,
          billingAddressLine2: h.billingAddressLine2,
          billingCity: h.billingCity,
          billingState: h.billingState,
          billingPostalCode: h.billingPostalCode,
          billingCountry: h.billingCountry,
          defaultPrimaryPayoutTermsId: h.defaultPrimaryPayoutTermsId ?? null,
          defaultResalePayoutTermsId: h.defaultResalePayoutTermsId ?? null,
          trustTier: h.trustTier,
          trustBadgeLabel: h.trustBadgeLabel,
          trustBadgeIcon: h.trustBadgeIcon,
          jobs: h.jobs,
          genreTags: h.genreTags,
          otherJobDescription: h.otherJobDescription,
          createdAt: h.createdAt,
        },
        identity: h.authUser ? mapToIdentity(h.authUser) : null,
        memberships: (h.orgMembers ?? []).map(
          (m: {
            orgId: string;
            role: string;
            org: { name: string; slug: string };
          }): HumanOrgMembershipSummary => ({
            orgId: m.orgId,
            orgName: m.org.name,
            orgSlug: m.org.slug,
            role: m.role as HumanOrgMembershipSummary["role"],
          }),
        ),
      }));
      return buildOffsetPaginatedResult({
        items,
        total,
        limit: page.limit,
        offset: page.offset,
      });
    },

    // ── Admin methods (platform human management) ──────────────────────

    listEmailVerifiedIds: async (humanIds: readonly string[]) => {
      const ids = Array.from(new Set(humanIds));
      if (ids.length === 0) return [];
      const rows = await p.authUser.findMany({
        where: { humanId: { in: ids }, emailVerified: true },
        select: { humanId: true },
      });
      return rows.flatMap((row) => (row.humanId ? [row.humanId] : []));
    },

    listAuthAccounts: async (humanId: string) => {
      const authUser = await p.authUser.findFirst({
        where: { humanId },
        select: { id: true },
      });
      if (!authUser) return [];

      const accounts = await p.authAccount.findMany({
        where: { userId: authUser.id },
        select: {
          providerId: true,
          accountId: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      });

      return accounts;
    },

    unlinkAuthAccount: async ({ humanId, providerId }) => {
      const authUser = await p.authUser.findFirst({
        where: { humanId },
        select: { id: true },
      });
      if (!authUser) {
        throw { code: "not_found", message: "human_not_found" } as const;
      }

      // Count remaining accounts — prevent removing the last one
      const accounts = await p.authAccount.findMany({
        where: { userId: authUser.id },
        select: { providerId: true },
      });

      if (accounts.length <= 1) {
        throw {
          code: "conflict",
          message: "cannot_remove_last_auth_method",
        } as const;
      }

      const target = accounts.find(
        (a: { providerId: string }) => a.providerId === providerId,
      );
      if (!target) {
        throw { code: "not_found", message: "provider_not_linked" } as const;
      }

      await p.authAccount.deleteMany({
        where: { userId: authUser.id, providerId },
      });
    },

    hasPasswordCredential: async (humanId: string) => {
      const authUser = await p.authUser.findFirst({
        where: { humanId },
        select: { id: true },
      });
      if (!authUser) return false;

      // Better Auth convention: for the `credential` provider, `accountId`
      // is the AuthUser id (see shadow-upgrade.ts / apps/api/src/auth/better-auth.ts).
      const credential = await p.authAccount.findUnique({
        where: {
          providerId_accountId: {
            providerId: "credential",
            accountId: authUser.id,
          },
        },
        select: { id: true },
      });
      return credential !== null;
    },

    hasSecondFactorEnrolled: async (humanId: string) => {
      // Single row read: `twoFactorEnabled` is Better Auth's own signal for a
      // verified TOTP secret (mirrors `customSession`'s `user.twoFactorEnabled`
      // in apps/api/src/auth/better-auth.ts — trust it directly rather than
      // re-deriving from AuthTwoFactor.verified), and `_count.passkeys` is a
      // cheap EXISTS-style count (no full credential rows fetched) for the
      // WebAuthn passkey signal. No linked AuthUser at all → no second factor.
      const authUser = await p.authUser.findFirst({
        where: { humanId },
        select: {
          twoFactorEnabled: true,
          _count: { select: { passkeys: true } },
        },
      });
      if (!authUser) return false;

      return authUser.twoFactorEnabled || authUser._count.passkeys > 0;
    },

    verifyPassword: async (humanId: string, password: string) => {
      const authUser = await p.authUser.findFirst({
        where: { humanId },
        select: { id: true },
      });
      if (!authUser) return false;

      const credential = await p.authAccount.findUnique({
        where: {
          providerId_accountId: {
            providerId: "credential",
            accountId: authUser.id,
          },
        },
        select: { password: true },
      });
      if (!credential?.password) return false;

      return verifyPasswordHash({ hash: credential.password, password });
    },

    forceVerifyEmail: async (humanId: string) => {
      const authUser = await p.authUser.findFirst({
        where: { humanId },
        select: { id: true },
      });
      if (!authUser) {
        throw { code: "not_found", message: "human_not_found" } as const;
      }

      await p.authUser.update({
        where: { id: authUser.id },
        data: { emailVerified: true },
      });
    },

    getSignInFootprint: async (humanId: string) => {
      const user = await p.authUser.findFirst({
        where: { humanId },
        select: {
          phoneNumber: true,
          phoneNumberVerified: true,
          twoFactorEnabled: true,
          accounts: { select: { providerId: true } },
          _count: { select: { passkeys: true } },
        },
      });
      if (!user) return null;
      const [activeApiKeys, delegateGrants] = await Promise.all([
        p.apiKey.count({ where: { humanId, revokedAt: null } }),
        p.humanDelegate.count({ where: { principalId: humanId } }),
      ]);
      const providers = user.accounts.map((a) => a.providerId);
      return {
        hasPasswordCredential: providers.includes("credential"),
        linkedProviders: providers.filter((id) => id !== "credential"),
        passkeys: user._count.passkeys,
        hasPhoneNumber: Boolean(user.phoneNumber),
        phoneNumberVerified: user.phoneNumberVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        activeApiKeys,
        delegateGrants,
      };
    },

    holdsEmailAttachedRows: (humanId: string) =>
      holdsEmailAttachedRowsInDb(p, humanId),

    listHumanIdsHoldingEmailAttachedRows: (humanIds: string[]) =>
      listHumanIdsHoldingEmailAttachedRowsInDb(p, humanIds),

    listAuthUsersByCanonicalEmail: async (canonicalEmail: string) => {
      // SQL mirror of core's `canonicalEmail` (lib/event-edit-rights.ts):
      // lowercase + trim, `+tag` dropped for every domain, and for Gmail the
      // dots dropped and googlemail.com folded into gmail.com. Pinned against
      // the TS function in banned-owner.integration.test.ts. A full scan of
      // auth_user, run only inside a ban.
      return p.$queryRaw<Array<{ authUserId: string; humanId: string | null }>>(
        Prisma.sql`
          WITH e AS (
            SELECT id, human_id, lower(btrim(email)) AS em FROM auth_user
          ), parts AS (
            SELECT id, human_id,
              split_part(regexp_replace(em, '@[^@]*$', ''), '+', 1) AS loc,
              substring(em FROM '@([^@]*)$') AS dom
            FROM e
            WHERE position('@' IN em) > 1
          )
          SELECT id AS "authUserId", human_id AS "humanId"
          FROM parts
          WHERE loc <> ''
            AND CASE
                  WHEN dom IN ('gmail.com', 'googlemail.com')
                    THEN replace(loc, '.', '') || '@gmail.com'
                  ELSE loc || '@' || dom
                END = ${canonicalEmail}
        `,
      );
    },

    invalidateSessionsForAuthUsers: async (authUserIds: string[]) => {
      if (authUserIds.length === 0) return { count: 0 };
      const { count } = await p.authSession.deleteMany({
        where: { userId: { in: authUserIds } },
      });
      return { count };
    },

    invalidateAllSessions: async (humanId: string) => {
      const authUser = await p.authUser.findFirst({
        where: { humanId },
        select: { id: true },
      });
      if (!authUser) {
        throw { code: "not_found", message: "human_not_found" } as const;
      }

      const result = await p.authSession.deleteMany({
        where: { userId: authUser.id },
      });

      return { count: result.count };
    },

    hasDeletionBlockingHistory: async (humanId: string) => {
      // Every FK column below is `ON DELETE RESTRICT` against `Human` — a hard
      // delete would otherwise crash with an unhandled Postgres FK-constraint
      // violation. Cheap existence checks in parallel; correctness over a
      // single mega-query.
      //
      // This is the *complete* set of Restrict relations against Human,
      // verified by full enumeration of every `Human @relation(...)` field
      // across packages/db/prisma/*.prisma — 10 explicit Restrict, all
      // FINANCIAL records retained for accounting/audit:
      //   Order.buyer, Ticket.owner, TicketScan.actor,
      //   TicketTransfer.from/to, PendingTicketTransfer.from,
      //   Claim.claimant/respondent, ResaleListing.seller,
      //   ResaleListingHold.buyer
      //
      // The 8 non-financial creator-attribution relations that used to be
      // Restrict (Embed.creator, PlaceLayout/EventTemplate/EventSeries/Image/
      // AudioUpload.createdByHuman, EventAttestation.attestedBy,
      // PlaceVerificationRequest.submittedBy) are now nullable SetNull — see
      // migration 20260706120000_human_deletion_detach_creator_fks — so
      // creating content never permanently blocks account deletion. Every
      // other Human relation in the schema is Cascade or SetNull and does not
      // block a hard delete.
      const [
        buyerOrder,
        ownedTicket,
        ticketScanActor,
        transferFrom,
        transferTo,
        pendingTransferFrom,
        claimant,
        respondent,
        resaleSeller,
        resaleHoldBuyer,
      ] = await Promise.all([
        p.order.findFirst({
          where: { buyerHumanId: humanId },
          select: { id: true },
        }),
        p.ticket.findFirst({
          where: { ownerHumanId: humanId },
          select: { id: true },
        }),
        p.ticketScan.findFirst({
          where: { actorHumanId: humanId },
          select: { id: true },
        }),
        p.ticketTransfer.findFirst({
          where: { fromHumanId: humanId },
          select: { id: true },
        }),
        p.ticketTransfer.findFirst({
          where: { toHumanId: humanId },
          select: { id: true },
        }),
        p.pendingTicketTransfer.findFirst({
          where: { fromHumanId: humanId },
          select: { id: true },
        }),
        p.claim.findFirst({
          where: { claimantId: humanId },
          select: { id: true },
        }),
        p.claim.findFirst({
          where: { respondentId: humanId },
          select: { id: true },
        }),
        p.resaleListing.findFirst({
          where: { sellerHumanId: humanId },
          select: { id: true },
        }),
        p.resaleListingHold.findFirst({
          where: { buyerHumanId: humanId },
          select: { id: true },
        }),
      ]);

      return [
        buyerOrder,
        ownedTicket,
        ticketScanActor,
        transferFrom,
        transferTo,
        pendingTransferFrom,
        claimant,
        respondent,
        resaleSeller,
        resaleHoldBuyer,
      ].some((row) => row !== null);
    },

    deleteHuman: async (humanId: string) => {
      // Prisma cascades handle AuthUser → AuthAccount, AuthSession.
      // We just delete the Human row.
      const exists = await p.human.findUnique({
        where: { id: humanId },
        select: { id: true },
      });
      if (!exists) {
        throw { code: "not_found", message: "human_not_found" } as const;
      }

      try {
        await p.human.delete({ where: { id: humanId } });
      } catch (error) {
        // Guard→delete race: hasDeletionBlockingHistory ran clean, but a
        // financial row (order/ticket/…, all ON DELETE RESTRICT) landed
        // before the delete. Surface the same friendly conflict the guard
        // raises instead of a raw P2003 FK-violation 500. Known trade-off:
        // a WaiverTemplate cascade blocked by another human's acceptance
        // (waiver.prisma, Restrict) also lands here and gets the order-
        // history label — acceptable until the planned waiver removal.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2003"
        ) {
          throw fail("CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY", {
            cause: error,
          });
        }
        throw error;
      }
    },

    getHumanTrustStats: async (humanId: string) => {
      const human = await p.human.findUnique({
        where: { id: humanId },
        select: {
          createdAt: true,
          authUser: { select: { email: true } },
        },
      });
      if (!human)
        throw { code: "not_found", message: "human_not_found" } as const;

      const [completedEventCount, totalTicketsSold, disputeCount, orderCount] =
        await Promise.all([
          p.event.count({
            where: { humanId, status: "COMPLETED" },
          }),
          p.ticket.count({
            where: { event: { humanId } },
          }),
          p.order.count({
            where: { event: { humanId }, status: "DISPUTED" },
          }),
          p.order.count({
            where: { event: { humanId }, status: { not: "CANCELLED" } },
          }),
        ]);

      const accountAgeDays = Math.floor(
        (Date.now() - human.createdAt.getTime()) / (1000 * 60 * 60 * 24),
      );

      return {
        completedEventCount,
        totalTicketsSold,
        disputeRate: orderCount > 0 ? disputeCount / orderCount : 0,
        accountAgeDays,
        hasContactEmail: !!human.authUser?.email,
        hasVerifiedVenue: false, // TODO: implement venue verification check
      };
    },
  };
}
