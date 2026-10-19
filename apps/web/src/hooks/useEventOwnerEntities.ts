"use client";

import { useMemo } from "react";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";

export type UseEventOwnerEntitiesOptions = {
  enabled?: boolean;
};

export type AdminOwnerEntitySlug = string;

export type OwnerEntityWithSlug =
  | {
      kind: "human";
      humanId: string;
      humanName: string;
      humanUsername: string | null;
      avatarUrl: string | null;
      adminSlug: AdminOwnerEntitySlug;
    }
  | {
      kind: "org";
      orgId: string;
      orgName: string;
      orgSlug: string;
      role: "OWNER" | "ADMIN" | "EDITOR" | "FINANCE" | "VIEWER" | "SCANNER";
      avatarUrl: string | null;
      adminSlug: AdminOwnerEntitySlug;
    };

const toHumanAdminSlug = (human: {
  humanUsername: string | null;
  humanProfileSlug: string | null;
  humanId: string;
}): string =>
  human.humanUsername
    ? `@${human.humanUsername}`
    : human.humanProfileSlug
      ? `@${human.humanProfileSlug}`
      : `@${human.humanId}`;

const toOrgAdminSlug = (org: { orgSlug: string; orgId: string }): string =>
  org.orgSlug || org.orgId;

/**
 * Shared owner-entities query for places we need to derive the current "operating entity".
 *
 * This centralizes two things:
 * - which tRPC procedure we call (canonical: `events.listEventOwnerEntities`)
 * - slug rules (human: `@username` fallback `@id`; org: `orgSlug` fallback `orgId`)
 */
export const useEventOwnerEntities = (
  options?: UseEventOwnerEntitiesOptions,
) => {
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const isSignedIn = Boolean(session?.user);

  const query = trpc.events.listEventOwnerEntities.useQuery(
    {},
    {
      staleTime: 60_000,
      retry: false,
      // Don't fire until the session has resolved and the user is authed.
      // Callers can further restrict via options.enabled.
      enabled: isSignedIn && !isSessionPending && (options?.enabled ?? true),
    },
  );

  if (process.env.NODE_ENV !== "production") {
    const owners = query.data?.owners;
    for (const owner of owners ?? []) {
      if (owner.kind === "human" && owner.humanUsername?.includes("%")) {
        throw new Error(
          `Invariant: humanUsername must be a raw string, got possibly-encoded value: ${owner.humanUsername}`,
        );
      }
      if (
        owner.kind === "org" &&
        (owner.orgSlug?.includes("%") || owner.orgName?.includes?.("%"))
      ) {
        throw new Error(
          `Invariant: orgSlug/orgName must be raw strings, got orgSlug=${owner.orgSlug} orgName=${owner.orgName}`,
        );
      }
    }
  }

  const ownersWithSlugs = useMemo<OwnerEntityWithSlug[] | undefined>(() => {
    const owners = query.data?.owners;
    if (!owners?.length) return undefined;

    return owners.map((owner) => {
      if (owner.kind === "human") {
        return {
          kind: "human",
          humanId: owner.humanId,
          humanName: owner.humanName,
          humanUsername: owner.humanUsername,
          avatarUrl: owner.avatarUrl,
          adminSlug: toHumanAdminSlug(owner),
        };
      }

      return {
        kind: "org",
        orgId: owner.orgId,
        orgName: owner.orgName,
        orgSlug: owner.orgSlug ?? owner.orgId,
        role: owner.role,
        avatarUrl: owner.avatarUrl,
        adminSlug: toOrgAdminSlug({
          orgId: owner.orgId,
          orgSlug: owner.orgSlug ?? owner.orgId,
        }),
      };
    });
  }, [query.data?.owners]);

  const preferredAdminSlug = useMemo(() => {
    const owners = ownersWithSlugs ?? [];
    const firstOrg = owners.find((o) => o.kind === "org");
    if (firstOrg) return firstOrg.adminSlug;
    const human = owners.find((o) => o.kind === "human");
    return human?.adminSlug ?? null;
  }, [ownersWithSlugs]);

  return {
    ...query,
    ownersWithSlugs,
    preferredAdminSlug,
  };
};
