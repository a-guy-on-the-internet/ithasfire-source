import { describe, expect, it } from "vitest";

import {
  mergeLocalAndNetwork,
  type LocalPersonInput,
  type SearchTicketItem,
  type VolunteerCandidate,
} from "./people-search-merge";

const localAttendee = (
  humanId: string,
  name: string,
  email: string | null = null,
): LocalPersonInput => ({
  humanId,
  kind: "attendee",
  displayName: name,
  email,
  signupStatus: null,
});

const localVolunteer = (
  humanId: string,
  name: string,
  status: string | null = "PENDING",
): LocalPersonInput => ({
  humanId,
  kind: "volunteer",
  displayName: name,
  email: null,
  signupStatus: status,
});

const ticket = (
  over: Partial<SearchTicketItem> & { ticketId: string; ownerHumanId: string },
): SearchTicketItem => ({
  ticketCode: `TKT-${over.ticketId.toUpperCase()}`,
  status: "VALID",
  eventId: "evt_1",
  eventTitle: "Test",
  ticketTypeName: "GA",
  ownerName: null,
  ownerEmail: null,
  issuedAt: new Date(0),
  scannedAt: null,
  seatLabel: null,
  ...over,
});

const volunteer = (
  over: Partial<VolunteerCandidate> & { signupId: string; humanId: string },
): VolunteerCandidate => ({
  humanDisplayName: "V",
  humanContactMasked: "v***@x.com",
  eventId: "evt_1",
  eventTitle: "Test",
  roleId: "r1",
  roleLabel: "Greeter",
  shiftId: "s1",
  shiftLabel: "Morning",
  shiftStartAt: "2025-01-01T09:00:00Z",
  shiftEndAt: "2025-01-01T12:00:00Z",
  status: "APPROVED",
  checkedInAt: null,
  checkedInByHumanId: null,
  window: "within",
  scanWindowNote: "ok",
  alsoHoldsTicket: false,
  ...over,
});

describe("mergeLocalAndNetwork", () => {
  it("returns empty when both local and network are empty", () => {
    expect(mergeLocalAndNetwork([], null)).toEqual([]);
    expect(
      mergeLocalAndNetwork([], {
        tickets: { items: [], pageInfo: { total: 0, offset: 0, limit: 20 } },
        volunteers: [],
      }),
    ).toEqual([]);
  });

  it("returns local rows un-hydrated when network is null (offline)", () => {
    const result = mergeLocalAndNetwork(
      [localAttendee("h1", "Alice", "a@x.com")],
      null,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "attendee",
      humanId: "h1",
      displayName: "Alice",
      email: "a@x.com",
    });
    expect((result[0] as { ticket?: unknown }).ticket).toBeUndefined();
  });

  it("hydrates a local attendee with the network ticket payload", () => {
    const local = [localAttendee("h1", "Alice", "a@x.com")];
    const net = {
      tickets: {
        items: [
          ticket({
            ticketId: "abc",
            ownerHumanId: "h1",
            ownerName: "Alice Smith",
            ownerEmail: "alice@x.com",
          }),
        ],
        pageInfo: { total: 1, offset: 0, limit: 20 },
      },
      volunteers: [],
    };
    const result = mergeLocalAndNetwork(local, net);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "attendee",
      humanId: "h1",
      displayName: "Alice Smith", // network wins on field conflicts
      email: "alice@x.com",
    });
    expect((result[0] as { ticket?: SearchTicketItem }).ticket?.ticketId).toBe(
      "abc",
    );
  });

  it("appends network-only attendees not present in local", () => {
    const local = [localAttendee("h1", "Alice")];
    const net = {
      tickets: {
        items: [
          ticket({ ticketId: "xyz", ownerHumanId: "h2", ownerName: "Bob" }),
        ],
        pageInfo: { total: 1, offset: 0, limit: 20 },
      },
      volunteers: [],
    };
    const result = mergeLocalAndNetwork(local, net);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.humanId)).toEqual(["h1", "h2"]);
    expect((result[1] as { ticket?: SearchTicketItem }).ticket?.ticketId).toBe(
      "xyz",
    );
  });

  it("hydrates a local volunteer and overrides signupStatus from candidate.status", () => {
    const local = [localVolunteer("h3", "Cara", "PENDING")];
    const net = {
      tickets: { items: [], pageInfo: { total: 0, offset: 0, limit: 20 } },
      volunteers: [
        volunteer({ signupId: "su1", humanId: "h3", status: "APPROVED" }),
      ],
    };
    const result = mergeLocalAndNetwork(local, net);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "volunteer",
      humanId: "h3",
      signupStatus: "APPROVED",
    });
    expect(
      (result[0] as { volunteer?: VolunteerCandidate }).volunteer?.signupId,
    ).toBe("su1");
  });

  it("never removes a local row that has no network match", () => {
    const local = [
      localAttendee("h1", "Alice"),
      localVolunteer("h2", "Bob", "PENDING"),
    ];
    const net = {
      tickets: { items: [], pageInfo: { total: 0, offset: 0, limit: 20 } },
      volunteers: [],
    };
    const result = mergeLocalAndNetwork(local, net);
    expect(result).toHaveLength(2);
    expect((result[0] as { ticket?: unknown }).ticket).toBeUndefined();
    expect((result[1] as { volunteer?: unknown }).volunteer).toBeUndefined();
  });

  it("treats attendee and volunteer for the same humanId as separate entries", () => {
    const local = [
      localAttendee("h1", "Alex"),
      localVolunteer("h1", "Alex", "APPROVED"),
    ];
    const net = {
      tickets: {
        items: [
          ticket({ ticketId: "t1", ownerHumanId: "h1", ownerName: "Alex T" }),
        ],
        pageInfo: { total: 1, offset: 0, limit: 20 },
      },
      volunteers: [volunteer({ signupId: "su2", humanId: "h1" })],
    };
    const result = mergeLocalAndNetwork(local, net);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe("attendee");
    expect(result[1].kind).toBe("volunteer");
    expect((result[0] as { ticket?: SearchTicketItem }).ticket?.ticketId).toBe(
      "t1",
    );
    expect(
      (result[1] as { volunteer?: VolunteerCandidate }).volunteer?.signupId,
    ).toBe("su2");
  });

  it("preserves local-first ordering with appended network-only rows after", () => {
    const local = [localAttendee("h1", "A"), localAttendee("h2", "B")];
    const net = {
      tickets: {
        items: [
          ticket({ ticketId: "t3", ownerHumanId: "h3", ownerName: "C" }),
          ticket({ ticketId: "t1", ownerHumanId: "h1", ownerName: "A" }),
        ],
        pageInfo: { total: 2, offset: 0, limit: 20 },
      },
      volunteers: [],
    };
    const result = mergeLocalAndNetwork(local, net);
    expect(result.map((r) => r.humanId)).toEqual(["h1", "h2", "h3"]);
  });
});
