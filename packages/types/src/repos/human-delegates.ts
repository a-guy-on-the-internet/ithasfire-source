import type { OrgRole } from "./authz";

// ─── Records ────────────────────────────────────────────────────────────────

export interface HumanDelegateRecord {
  id: string;
  principalId: string;
  delegateId: string;
  role: OrgRole;
  createdAt: Date;
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface AddHumanDelegateInput {
  principalId: string;
  delegateId: string;
  role: OrgRole;
}

export interface RemoveHumanDelegateInput {
  principalId: string;
  delegateId: string;
}

export interface GetHumanDelegationInput {
  principalId: string;
  delegateId: string;
}

/**
 * The reverse read (holds-without-a-request FR-002, the booker gate): the
 * principals for whom `delegateId` is a delegate holding one of `roles`.
 * `principalIds` narrows to those candidates (omitted = every principal of
 * the delegate; empty = none, no DB read). `roles` empty = none.
 */
export interface ListPrincipalsForDelegateInput {
  delegateId: string;
  roles: readonly OrgRole[];
  principalIds?: readonly string[];
}

export interface ListHumanDelegatesInput {
  principalId: string;
  limit: number;
  offset: number;
}

export interface CountHumanDelegatesByRoleInput {
  principalId: string;
  role: OrgRole;
}

// ─── Results ────────────────────────────────────────────────────────────────

export interface HumanDelegateItem {
  humanId: string;
  name: string | null;
  email: string | null;
  role: OrgRole;
  joinedAt: Date;
}

export interface ListHumanDelegatesResult {
  items: HumanDelegateItem[];
  total: number;
}
