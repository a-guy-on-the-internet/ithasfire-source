/**
 * Pure merge helper for local + network people search results.
 *
 * Lives in its own file (no React, no expo-sqlite, no NetInfo) so it can be
 * unit-tested in plain node via vitest. The hook in `use-people-search.ts`
 * imports from here.
 */

// ── Inline types (mirroring unified-search-screen.tsx) ──────────────────────
// `@th/core` types don't reach this app via RouterOutputs because of the
// path-alias resolution issue documented in slice 2 — keep these shapes in
// sync with the screen and the server's `scan.searchUnified` response.

export type SearchTicketItem = {
  ticketId: string;
  ticketCode: string;
  status: string;
  eventId: string;
  eventTitle: string;
  ticketTypeName: string | null;
  ownerHumanId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  issuedAt: Date;
  scannedAt: Date | null;
  seatLabel: string | null;
};

export type VolunteerCandidate = {
  signupId: string;
  humanId: string;
  humanDisplayName: string;
  humanContactMasked: string;
  eventId: string;
  eventTitle: string;
  roleId: string;
  roleLabel: string;
  shiftId: string;
  shiftLabel: string;
  shiftStartAt: string;
  shiftEndAt: string;
  status: "APPROVED" | "CHECKED_IN" | "NO_SHOW";
  checkedInAt: string | null;
  checkedInByHumanId: string | null;
  window: "before" | "within" | "after";
  scanWindowNote: string;
  alsoHoldsTicket: boolean;
};

export type SearchUnifiedResult = {
  tickets: {
    items: SearchTicketItem[];
    pageInfo: { total: number; offset: number; limit: number };
  };
  volunteers: VolunteerCandidate[];
};

export type LocalPersonInput = {
  humanId: string;
  kind: "attendee" | "volunteer";
  displayName: string | null;
  email: string | null;
  signupStatus: string | null;
};

export type PeopleSearchResult =
  | {
      kind: "attendee";
      humanId: string;
      displayName: string | null;
      email: string | null;
      signupStatus?: null;
      ticket?: SearchTicketItem;
    }
  | {
      kind: "volunteer";
      humanId: string;
      displayName: string | null;
      email: string | null;
      signupStatus: string | null;
      volunteer?: VolunteerCandidate;
    };

/**
 * Merge local people-index rows with the network `scan.searchUnified`
 * response. Local rows establish the visible set (so operators see results
 * instantly while offline); network rows hydrate matching local rows with
 * their rich `ticket` / `volunteer` payloads and append any network-only
 * rows not present in the local index. Network never *removes* a local row.
 */
export function mergeLocalAndNetwork(
  local: LocalPersonInput[],
  network: SearchUnifiedResult | null,
): PeopleSearchResult[] {
  const keyOf = (kind: "attendee" | "volunteer", humanId: string) =>
    `${kind}:${humanId}`;

  // Seed with local rows in their existing order.
  const ordered: string[] = [];
  const byKey = new Map<string, PeopleSearchResult>();

  for (const row of local) {
    const k = keyOf(row.kind, row.humanId);
    if (byKey.has(k)) continue;
    ordered.push(k);
    if (row.kind === "volunteer") {
      byKey.set(k, {
        kind: "volunteer",
        humanId: row.humanId,
        displayName: row.displayName,
        email: row.email,
        signupStatus: row.signupStatus,
      });
    } else {
      byKey.set(k, {
        kind: "attendee",
        humanId: row.humanId,
        displayName: row.displayName,
        email: row.email,
      });
    }
  }

  if (!network) {
    return ordered.map((k) => byKey.get(k)!);
  }

  for (const ticket of network.tickets.items) {
    const k = keyOf("attendee", ticket.ownerHumanId);
    const existing = byKey.get(k);
    if (existing && existing.kind === "attendee") {
      byKey.set(k, {
        ...existing,
        // Network wins on field conflicts.
        displayName: ticket.ownerName ?? existing.displayName,
        email: ticket.ownerEmail ?? existing.email,
        ticket,
      });
    } else {
      ordered.push(k);
      byKey.set(k, {
        kind: "attendee",
        humanId: ticket.ownerHumanId,
        displayName: ticket.ownerName,
        email: ticket.ownerEmail,
        ticket,
      });
    }
  }

  for (const candidate of network.volunteers) {
    const k = keyOf("volunteer", candidate.humanId);
    const existing = byKey.get(k);
    if (existing && existing.kind === "volunteer") {
      byKey.set(k, {
        ...existing,
        displayName: candidate.humanDisplayName ?? existing.displayName,
        // VolunteerCandidate doesn't carry an email; preserve local.
        signupStatus: candidate.status,
        volunteer: candidate,
      });
    } else {
      ordered.push(k);
      byKey.set(k, {
        kind: "volunteer",
        humanId: candidate.humanId,
        displayName: candidate.humanDisplayName,
        email: null,
        signupStatus: candidate.status,
        volunteer: candidate,
      });
    }
  }

  return ordered.map((k) => byKey.get(k)!);
}
