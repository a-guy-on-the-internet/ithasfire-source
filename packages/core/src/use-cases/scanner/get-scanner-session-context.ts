import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";

import { parseInput } from "../../lib/io";
import { requireScannerAccessOnOrg } from "../../lib/rbac";
import { fail } from "@th/errors";
import {
  getScannerSessionContextInputSchema,
  SCANNER_OPERATOR_ROLES,
} from "./schemas";

export type GetScannerSessionContextDeps = {
  repos: Repos;
  authz: AuthZPort;
  logger?: LoggerPort;
};

export type ScannerSessionOperator = {
  humanId: string;
  displayName: string;
  email: string;
  /**
   * Scanner POS terms acknowledgement state (spec 2026-05-14/pos-attestation).
   * The scanner app compares `scannerTermsAckVersion` against the current
   * `SCANNER_TERMS_VERSION` to decide whether to block POS entry with the
   * terms modal. UX only — the POS use cases re-check server-side.
   */
  scannerTermsAckAt: Date | null;
  scannerTermsAckVersion: string | null;
};

export type ScannerSessionOrg = {
  orgId: string;
  orgName: string;
  role: OrgRole;
};

export type ScannerSessionCurrentEvent = {
  eventId: string;
  orgId: string;
  eventName: string;
  role: OrgRole;
  startAt: Date | null;
  endAt: Date | null;
  status: string;
};

export type GetScannerSessionContextOutput = {
  operator: ScannerSessionOperator;
  orgs: ScannerSessionOrg[];
  currentEvent?: ScannerSessionCurrentEvent;
  /**
   * True when the operator only sees these orgs/events because they hold
   * the platform `ADMIN` staff role (not because of org membership). The
   * scanner shell renders an "elevated mode" banner when this is true so
   * platform admins know any sale or scan they perform is recorded as a
   * platform-admin action.
   */
  viaPlatformAdmin: boolean;
};

/**
 * Resolve operator identity, the orgs they can scan for, and (optionally) the
 * current event summary for the scanner shell.
 *
 * Read-only. Throws:
 *   - `forbidden`  — actor has zero scanner-eligible memberships
 *   - `not_found`  — `eventId` supplied but no such event
 *   - `forbidden`  — `eventId` supplied but actor lacks scanner-eligible role
 *                    on that event's org (or event is not org-owned)
 */
export async function getScannerSessionContext(
  deps: GetScannerSessionContextDeps,
  rawInput: unknown,
): Promise<GetScannerSessionContextOutput> {
  const input = parseInput(getScannerSessionContextInputSchema, rawInput);

  const human = await deps.repos.humans.getByIdWithIdentity(input.actorHumanId);
  if (!human) {
    throw fail("HUMAN_NOT_FOUND");
  }

  const memberships = await deps.repos.authz.listOrgMembershipsByHumanId({
    humanId: input.actorHumanId,
    roles: [...SCANNER_OPERATOR_ROLES],
  });

  // Platform-admin override: operators with no SCANNER memberships may still
  // enter the shell if they hold the platform ADMIN staff role. We synthesize
  // OWNER on every active org so the existing UI flows (org picker, event
  // picker) work without special-casing. Mutating actions audit-log the
  // override at write time — see POS use cases.
  let viaPlatformAdmin = false;
  if (memberships.length === 0) {
    const staff = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: ["ADMIN"],
    });
    // A platform ADMIN with no second factor enrolled has no override; the
    // code says why, so a client can tell it from "not an operator".
    if (staff.secondFactorRequired) {
      throw fail("SECOND_FACTOR_REQUIRED");
    }
    if (!staff.allowed) {
      throw fail("INSUFFICIENT_ROLE");
    }
    viaPlatformAdmin = true;
  }

  // Highest-privilege role per org wins.
  const roleByOrg = new Map<string, OrgRole>();
  const rolePriority: Record<OrgRole, number> = {
    OWNER: 4,
    ADMIN: 3,
    EDITOR: 2,
    FINANCE: 2,
    SCANNER: 1,
    VIEWER: 0,
  };
  for (const m of memberships) {
    const current = roleByOrg.get(m.orgId);
    if (!current || rolePriority[m.role] > rolePriority[current]) {
      roleByOrg.set(m.orgId, m.role);
    }
  }

  let orgsList: ScannerSessionOrg[];
  if (viaPlatformAdmin) {
    // List active orgs (capped) and synthesize OWNER role.
    const { items } = await deps.repos.organizations.listActive({
      limit: 200,
      offset: 0,
    });
    orgsList = items.map((org) => ({
      orgId: org.id,
      orgName: org.name,
      role: "OWNER",
    }));
  } else {
    const orgIds = [...roleByOrg.keys()];
    const orgs = await deps.repos.organizations.getByIds(orgIds);
    orgsList = orgs
      .map((org) => {
        const role = roleByOrg.get(org.id);
        if (!role) return null;
        return { orgId: org.id, orgName: org.name, role };
      })
      .filter((value): value is ScannerSessionOrg => value !== null);
  }

  let currentEvent: ScannerSessionCurrentEvent | undefined;
  if (input.eventId) {
    const ev = await deps.repos.events.getById(input.eventId);
    if (!ev) {
      throw fail("EVENT_NOT_FOUND");
    }
    if (!ev.orgId) {
      // Personal events are not scanner-shell candidates — there is no org
      // membership to authorize against.
      throw fail("EVENT_NOT_ORG_OWNED");
    }
    const access = await requireScannerAccessOnOrg({
      repos: deps.repos,
      authz: deps.authz,
      orgId: ev.orgId,
      actorHumanId: input.actorHumanId,
      roles: SCANNER_OPERATOR_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    currentEvent = {
      eventId: ev.id,
      orgId: ev.orgId,
      eventName: ev.title,
      role: access.role,
      startAt: ev.startsAt ?? null,
      endAt: ev.endsAt ?? null,
      status: ev.status,
    };
  }

  const operator: ScannerSessionOperator = {
    humanId: human.human.id,
    displayName: human.human.name ?? human.identity.email,
    email: human.identity.email,
    scannerTermsAckAt: human.human.scannerTermsAckAt ?? null,
    scannerTermsAckVersion: human.human.scannerTermsAckVersion ?? null,
  };

  deps.logger?.info("scanner.get_session_context", {
    actorHumanId: input.actorHumanId,
    orgCount: orgsList.length,
    hasCurrentEvent: !!currentEvent,
    viaPlatformAdmin,
  });

  return { operator, orgs: orgsList, currentEvent, viaPlatformAdmin };
}
