/**
 * The event's breadcrumb back up the booking chain.
 *
 * Four things this pins, all of which are ways the surface can be WRONG rather
 * than merely ugly:
 *   1. It renders NOTHING — not an empty panel, not a padded wrapper — when the
 *      event has no provenance. That is the common case; a permanent empty box
 *      on the busiest admin surface is the defect this guards.
 *   2. `direction` decides the sentence. `senderDisplayName` is always the ACT,
 *      but the act ASKED under TO_VENUE and WAS ASKED under TO_PERFORMER. A
 *      single sentence would state the relationship backwards half the time, so
 *      both directions are asserted against the SHIPPED copy.
 *   3. A severed thread (`bookingRequest: null`, which the schema reaches via
 *      `onDelete: SetNull`) degrades to the fact that still holds instead of
 *      vanishing or rendering a broken link.
 *   4. A failed query is invisible and non-fatal — the editor around it keeps
 *      rendering, and the query is `meta: { silent: true }` so the global query
 *      error toast never fires over an editor this cannot affect.
 *
 * MOCKS (enumerated deliberately — a catch-all Proxy that answers `then` turns
 * the module namespace into a thenable and hangs vitest):
 *   - `tamagui`: XStack / YStack / styled → plain divs forwarding data- and
 *     aria- attributes so the test ids are assertable.
 *   - `@th/ui`: Text/Badge → spans, NextLinkAnchor → a real <a>, and
 *     `useTranslations` → an interpolator over the REAL en catalog, so every
 *     assertion below is on shipped copy. A renamed key or argument fails here.
 *   - `@/trpc`: the one query this component owns.
 *   - `lucide-react`: the trailing arrow.
 * `@/lib/booking-agreements` is NOT mocked — the status label/tone mapping is
 * pure and is part of what this renders.
 */
import type { ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AppRouter } from "@th/trpc";

import en from "@/i18n/messages/en";

const useProvenanceQuery = vi.fn();

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex)$/;
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (PASS_PROP.test(key)) domProps[key] = value;
    }
    return React.createElement("div", domProps, children);
  };
  return {
    XStack: Stack,
    YStack: Stack,
    styled: () => Stack,
  };
});

// The admin slug the editor is mounted under — both links are built from it.
const SLUG = "acme";
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: SLUG }),
}));

vi.mock("lucide-react", async () => {
  const React = await import("react");
  return {
    ArrowRight: () => React.createElement("svg", { "data-icon": "arrow-right" }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) =>
      React.createElement(
        "span",
        { "data-testid": rest["data-testid"] },
        children,
      ),
    Badge: ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      [k: string]: unknown;
    }) =>
      React.createElement(
        "span",
        { "data-testid": rest["data-testid"], "data-tone": rest.tone },
        children,
      ),
    NextLinkAnchor: ({
      href,
      children,
      ...rest
    }: {
      href: string;
      children?: ReactNode;
      [k: string]: unknown;
    }) =>
      React.createElement(
        "a",
        { href, "data-testid": rest["data-testid"] },
        children,
      ),
    useFormatters: () => ({
      // Echo the day so a date RANGE is assertable as two distinct values.
      dateTime: (date: Date) =>
        `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`,
      currency: (amount: number, currency: string) =>
        `${currency} ${amount.toFixed(2)}`,
    }),
    useTranslations: () => (key: string, args?: Record<string, string | number>) => {
      const [ns, leaf] = key.split(".");
      const section = (en as Record<string, Record<string, string>>)[
        ns as string
      ];
      let template = section?.[leaf as string];
      if (typeof template !== "string") {
        throw new Error(`missing message: ${key}`);
      }
      // Minimal ICU plural: `{count, plural, one {…} other {…}}`.
      template = template.replace(
        /\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
        (_m, name: string, one: string, other: string) => {
          const n = Number(args?.[name]);
          return (n === 1 ? one : other).replace("#", String(n));
        },
      );
      return template.replace(
        /\{(\w+)\}/g,
        (_m, name: string) => String(args?.[name] ?? `{${name}}`),
      );
    },
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    events: {
      getEventProvenance: {
        useQuery: (...args: unknown[]) => useProvenanceQuery(...args),
      },
    },
  },
}));

const { EventProvenanceNote } = await import("../EventProvenanceNote");

const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const AGREEMENT_ID = "00000000-0000-4000-8000-0000000000a1";
const REQUEST_ID = "00000000-0000-4000-8000-0000000000b1";

/**
 * The REAL inferred output of the procedure this component consumes, so a
 * field the router adds, renames or drops fails here rather than drifting
 * silently behind a hand-rolled shape.
 */
type Provenance = NonNullable<
  inferRouterOutputs<AppRouter>["events"]["getEventProvenance"]
>;

const PLACE_ID = "00000000-0000-4000-8000-0000000000c1";

function provenance(overrides: {
  /** `null` = EVENT-FIRST: the builder's save created the request; no agreement yet. */
  agreement?: Partial<NonNullable<Provenance["agreement"]>> | null;
  bookingRequest?: Partial<NonNullable<Provenance["bookingRequest"]>> | null;
  venueConfirmation?: Partial<Provenance["venueConfirmation"]>;
}): Provenance {
  const bookingRequest =
    overrides.bookingRequest === null
      ? null
      : {
          id: REQUEST_ID,
          status: "ACCEPTED" as const,
          direction: "TO_VENUE" as const,
          senderDisplayName: "The Midnight Hour",
          lastMessageAt: null,
          intent: "PERFORM" as const,
          placeId: PLACE_ID,
          placeName: "The Greek",
          parked: false,
          ...(overrides.bookingRequest ?? {}),
        };
  return {
    agreement:
      overrides.agreement === null
        ? null
        : {
            id: AGREEMENT_ID,
            status: "ACCEPTED",
            linkedVia: "EVENT",
            title: "The Midnight Hour at the Greek",
            proposedDate: new Date("2026-09-04T00:00:00Z"),
            proposedEndDate: null,
            guaranteeCents: 50_000,
            payoutLineCount: 3,
            ...(overrides.agreement ?? {}),
          },
    bookingRequest,
    // The venue's own show by default — the common PERFORM shape, on which
    // the requester's banner must NOT appear.
    venueConfirmation: {
      state: "confirmed",
      ownerSide: "place",
      placeName: "The Greek",
      ...(overrides.venueConfirmation ?? {}),
    },
  };
}

const ADMIN_AGREEMENT_HREF = `/admin/${SLUG}/bookings/agreement/${AGREEMENT_ID}`;
const ADMIN_THREAD_HREF = `/admin/${SLUG}/bookings?request=${REQUEST_ID}`;

/** Shape react-query returns; only `data` is read by the component. */
function resolved(data: Provenance | null) {
  return { data, isLoading: false, isError: false, error: null };
}

beforeEach(() => {
  useProvenanceQuery.mockReset();
});

describe("EventProvenanceNote", () => {
  it("renders NOTHING — no wrapper, no padded band — when the event has no provenance", () => {
    useProvenanceQuery.mockReturnValue(resolved(null));

    const { container } = render(<EventProvenanceNote eventId={EVENT_ID} />);

    expect(screen.queryByTestId("event-provenance-note")).not.toBeInTheDocument();
    // The strong assertion: not merely "no visible content" but no DOM at all,
    // so an ordinary event can't inherit a gap from this.
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the query is still in flight (no skeleton on an event that probably has none)", () => {
    useProvenanceQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });

    const { container } = render(<EventProvenanceNote eventId={EVENT_ID} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("TO_VENUE: says the act asked — 'a booking request FROM {name}'", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(
        provenance({
          bookingRequest: {
            direction: "TO_VENUE",
            senderDisplayName: "The Midnight Hour",
          },
        }),
      ),
    );

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    const note = screen.getByTestId("event-provenance-note");
    expect(note).toHaveTextContent(
      "This event came from a booking request from The Midnight Hour.",
    );
    // The other direction's sentence must NOT be what rendered.
    expect(note).not.toHaveTextContent("sent to The Midnight Hour");
  });

  it("TO_PERFORMER: says the act was asked — 'a booking request SENT TO {name}', not 'from'", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(
        provenance({
          bookingRequest: {
            direction: "TO_PERFORMER",
            senderDisplayName: "The Midnight Hour",
          },
        }),
      ),
    );

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    const note = screen.getByTestId("event-provenance-note");
    expect(note).toHaveTextContent(
      "This event came from a booking request sent to The Midnight Hour.",
    );
    // The relationship stated backwards is the whole bug this guards against:
    // under TO_PERFORMER the ORG did the asking, so "from {act}" is a lie.
    expect(note).not.toHaveTextContent(
      "booking request from The Midnight Hour",
    );
  });

  it("keeps the DIRECTION when the act's name doesn't resolve, rather than collapsing to a directionless line", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(
        provenance({
          bookingRequest: {
            direction: "TO_PERFORMER",
            senderDisplayName: null,
          },
        }),
      ),
    );

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    expect(screen.getByTestId("event-provenance-note")).toHaveTextContent(
      "This event came from a booking request sent to a performer.",
    );
  });

  it("degrades to 'linked to a booking agreement' when the thread was severed (bookingRequest: null)", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(provenance({ bookingRequest: null })),
    );

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    const note = screen.getByTestId("event-provenance-note");
    expect(note).toHaveTextContent(
      "This event is linked to a booking agreement.",
    );
    // The agreement link is the part that still works, so it must survive.
    expect(
      screen.getByTestId("event-provenance-note-agreement-link"),
    ).toHaveAttribute("href", ADMIN_AGREEMENT_HREF);
    // No thread → no last-activity affordance implying one is reachable,
    // and no thread link that would land on an inbox without the row.
    expect(
      screen.queryByTestId("event-provenance-note-last-activity"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("event-provenance-note-thread-link"),
    ).not.toBeInTheDocument();
  });

  it("a failed query is invisible and does not take the surrounding editor down with it", () => {
    useProvenanceQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("FORBIDDEN"),
    });

    render(
      <div>
        <EventProvenanceNote eventId={EVENT_ID} />
        <span data-testid="rest-of-the-editor">Essentials</span>
      </div>,
    );

    expect(screen.queryByTestId("event-provenance-note")).not.toBeInTheDocument();
    expect(screen.getByTestId("rest-of-the-editor")).toBeInTheDocument();
  });

  it("opts out of the global query-error toast — this is progressive enhancement, not an incident", () => {
    useProvenanceQuery.mockReturnValue(resolved(null));

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    expect(useProvenanceQuery).toHaveBeenCalledWith(
      { eventId: EVENT_ID },
      expect.objectContaining({ meta: { silent: true } }),
    );
  });

  it("says the agreement is not finalized yet when the event is only its DRAFT anchor", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(provenance({ agreement: { linkedVia: "DRAFT_EVENT" } })),
    );

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    expect(
      screen.getByTestId("event-provenance-note-draft"),
    ).toHaveTextContent("The agreement isn’t finalized onto this event yet.");
  });

  it("does not imply 'not finalized' on an event the agreement is actually linked to", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(provenance({ agreement: { linkedVia: "EVENT" } })),
    );

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    expect(
      screen.queryByTestId("event-provenance-note-draft"),
    ).not.toBeInTheDocument();
  });

  it("shows the agreement's own status and links to it", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(provenance({ agreement: { status: "PROPOSED" } })),
    );

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    // Whatever the agreements surfaces call PROPOSED, this calls it too — the
    // label comes from the shared `AGREEMENT_STATUS_LABEL_KEYS` map, so the
    // breadcrumb and the agreement page can't drift into two vocabularies.
    expect(screen.getByTestId("event-provenance-note-status")).toHaveTextContent(
      String(
        (en as Record<string, Record<string, string>>).admin!
          .baStatusProposed!,
      ),
    );
    const link = screen.getByTestId("event-provenance-note-agreement-link");
    expect(link).toHaveAttribute("href", ADMIN_AGREEMENT_HREF);
    expect(link).toHaveTextContent("View agreement");
  });

  /**
   * ACTIVITY, NOT "LAST MESSAGE". `lastMessageAt` is bumped by every ledger
   * entry too — `booking_request.viewed` when a colleague merely opens the
   * request, `booking_event.modified` when someone saves a tracked field on
   * THIS event. The old copy ("Last message {date}") therefore date-stamped a
   * message nobody had sent, on the page the reader was looking at. The word
   * is pinned here so it cannot drift back.
   */
  it("surfaces thread recency as ACTIVITY, never as a message that was sent", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(
        provenance({
          bookingRequest: { lastMessageAt: new Date("2026-08-12T10:00:00Z") },
        }),
      ),
    );

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    const recency = screen.getByTestId("event-provenance-note-last-activity");
    expect(recency).toHaveTextContent("Last activity Aug 12, 2026");
    expect(recency).not.toHaveTextContent(/message/i);
  });

  // ── The agreed-terms summary and the thread link ──────────────────────────

  it("summarises the agreement's terms read-only: title, date, guarantee, and how many lines the terms LIST", () => {
    useProvenanceQuery.mockReturnValue(resolved(provenance({})));

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    expect(screen.getByTestId("event-provenance-note-title")).toHaveTextContent(
      "The Midnight Hour at the Greek",
    );
    expect(screen.getByTestId("event-provenance-note-date")).toHaveTextContent(
      "Sep 4, 2026",
    );
    expect(
      screen.getByTestId("event-provenance-note-guarantee"),
    ).toHaveTextContent("USD 500.00");
    const lines = screen.getByTestId("event-provenance-note-lines");
    expect(lines).toHaveTextContent("3 payout lines listed");
    // The count includes declined/countered lines — never call them agreed.
    expect(lines).not.toHaveTextContent(/agreed/i);
  });

  it("renders a date RANGE when the agreement carries an end date", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(
        provenance({
          agreement: {
            proposedDate: new Date("2026-09-04T00:00:00Z"),
            proposedEndDate: new Date("2026-09-06T00:00:00Z"),
          },
        }),
      ),
    );

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    expect(screen.getByTestId("event-provenance-note-date")).toHaveTextContent(
      "Sep 4, 2026 – Sep 6, 2026",
    );
  });

  it("shows an em dash — not a blank, not $0 — for a null guarantee and a null date", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(
        provenance({
          agreement: { guaranteeCents: null, proposedDate: null },
        }),
      ),
    );

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    expect(
      screen.getByTestId("event-provenance-note-guarantee"),
    ).toHaveTextContent("—");
    expect(screen.getByTestId("event-provenance-note-date")).toHaveTextContent(
      "—",
    );
  });

  it("counts zero and one line honestly", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(provenance({ agreement: { payoutLineCount: 0 } })),
    );
    const { rerender } = render(<EventProvenanceNote eventId={EVENT_ID} />);
    expect(screen.getByTestId("event-provenance-note-lines")).toHaveTextContent(
      "0 payout lines listed",
    );

    useProvenanceQuery.mockReturnValue(
      resolved(provenance({ agreement: { payoutLineCount: 1 } })),
    );
    rerender(<EventProvenanceNote eventId={`${EVENT_ID}-2`} />);
    expect(screen.getByTestId("event-provenance-note-lines")).toHaveTextContent(
      "1 payout line listed",
    );
  });

  it("links the agreement to the ADMIN route under the current slug, and the thread to the inbox deep link", () => {
    useProvenanceQuery.mockReturnValue(resolved(provenance({})));

    render(<EventProvenanceNote eventId={EVENT_ID} />);

    expect(
      screen.getByTestId("event-provenance-note-agreement-link"),
    ).toHaveAttribute("href", ADMIN_AGREEMENT_HREF);
    const thread = screen.getByTestId("event-provenance-note-thread-link");
    expect(thread).toHaveAttribute("href", ADMIN_THREAD_HREF);
    expect(thread).toHaveTextContent("Open booking thread");
  });
});

describe("EventProvenanceNote — the requester's venue-confirmation banner", () => {
  it("tells a REQUESTER-owned, venue-confirmed event's owner the venue said yes, naming the place", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(
        provenance({
          venueConfirmation: { state: "confirmed", ownerSide: "requester", placeName: "The Greek" },
        }),
      ),
    );
    render(<EventProvenanceNote eventId={EVENT_ID} />);
    expect(screen.getByTestId("event-provenance-note-venue-confirmed").textContent).toBe(
      "Confirmed by The Greek. Finish the details and publish when ready.",
    );
  });

  it("falls back to 'the place' when the place's name is gone, keeping the sentence", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(
        provenance({
          venueConfirmation: { state: "confirmed", ownerSide: "requester", placeName: null },
        }),
      ),
    );
    render(<EventProvenanceNote eventId={EVENT_ID} />);
    expect(screen.getByTestId("event-provenance-note-venue-confirmed").textContent).toBe(
      "Confirmed by the place. Finish the details and publish when ready.",
    );
  });

  it("says nothing on the venue's OWN show — confirmed by construction is not news", () => {
    useProvenanceQuery.mockReturnValue(resolved(provenance({})));
    render(<EventProvenanceNote eventId={EVENT_ID} />);
    expect(screen.queryByTestId("event-provenance-note-venue-confirmed")).toBeNull();
  });

  it.each(["unconfirmed", "withdrawn", "none"] as const)(
    "says nothing while the stance is %s — the public page is address-only either way",
    (state) => {
      useProvenanceQuery.mockReturnValue(
        resolved(
          provenance({
            venueConfirmation: { state, ownerSide: state === "none" ? null : "requester" },
          }),
        ),
      );
      render(<EventProvenanceNote eventId={EVENT_ID} />);
      expect(screen.queryByTestId("event-provenance-note-venue-confirmed")).toBeNull();
    },
  );

  it("keeps rendering the chain when an older payload carries no stance at all", () => {
    const data = provenance({}) as Omit<Provenance, "venueConfirmation"> & {
      venueConfirmation?: Provenance["venueConfirmation"];
    };
    delete data.venueConfirmation;
    useProvenanceQuery.mockReturnValue(resolved(data as Provenance));
    render(<EventProvenanceNote eventId={EVENT_ID} />);
    expect(screen.getByTestId("event-provenance-note")).toBeTruthy();
    expect(screen.queryByTestId("event-provenance-note-venue-confirmed")).toBeNull();
  });
});

/**
 * EVENT-FIRST (venue-confirmation spec): the builder named a third-party
 * venue and the save created the booking request — no agreement exists until
 * the venue accepts. The note becomes the TIE BAND: where the venue's
 * confirmation of THIS event stands. Four states, the venue named first, and
 * a link into the request. Also rendered straight from the save's result
 * (`bookingRequest` prop) before the provenance refetch lands.
 */
describe("EventProvenanceNote — the event-first tie band", () => {
  const eventFirst = (args: {
    state: "unconfirmed" | "confirmed" | "withdrawn" | "none";
    parked?: boolean;
    placeName?: string | null;
    status?: "PENDING" | "VIEWED" | "ACCEPTED" | "DECLINED" | "WITHDRAWN" | "EXPIRED";
  }) =>
    provenance({
      agreement: null,
      bookingRequest: {
        status: args.status ?? "PENDING",
        parked: args.parked ?? false,
        placeName: args.placeName === undefined ? "The Blue Room" : args.placeName,
      },
      venueConfirmation: {
        state: args.state,
        ownerSide: "requester",
        placeName: args.placeName === undefined ? "The Blue Room" : args.placeName,
      },
    });

  it("AWAITING: the venue has the request; the event is address-only until they confirm; links to the request", () => {
    useProvenanceQuery.mockReturnValue(resolved(eventFirst({ state: "unconfirmed" })));
    render(<EventProvenanceNote eventId={EVENT_ID} />);

    const band = screen.getByTestId("event-provenance-note");
    expect(band).toHaveAttribute("data-state", "awaiting");
    // The live region is the statement (headline + note) only; the link is a
    // sibling OUTSIDE it, so a state change never re-announces a control.
    const status = screen.getByTestId("event-provenance-note-band-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toContainElement(
      screen.getByTestId("event-provenance-note-band-headline"),
    );
    expect(status).toContainElement(
      screen.getByTestId("event-provenance-note-band-note"),
    );
    expect(status).not.toContainElement(
      screen.getByTestId("event-provenance-note-thread-link"),
    );
    expect(band).not.toHaveAttribute("role");
    expect(screen.getByTestId("event-provenance-note-band-headline")).toHaveTextContent(
      "The Blue Room has your request.",
    );
    expect(screen.getByTestId("event-provenance-note-band-note")).toHaveTextContent(
      "Your event shows an address only until they confirm.",
    );
    const link = screen.getByTestId("event-provenance-note-thread-link");
    expect(link).toHaveAttribute("href", ADMIN_THREAD_HREF);
    expect(link).toHaveTextContent("Open the request");
    // No agreement → none of the agreement chrome.
    expect(screen.queryByTestId("event-provenance-note-agreement-link")).toBeNull();
    expect(screen.queryByTestId("event-provenance-note-terms")).toBeNull();
    expect(screen.queryByTestId("event-provenance-note-status")).toBeNull();
  });

  it("PARKED: the venue has not claimed its page — we've asked them to", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(eventFirst({ state: "unconfirmed", parked: true })),
    );
    render(<EventProvenanceNote eventId={EVENT_ID} />);
    expect(screen.getByTestId("event-provenance-note")).toHaveAttribute("data-state", "parked");
    expect(screen.getByTestId("event-provenance-note-band-headline")).toHaveTextContent(
      "The Blue Room hasn’t claimed its page yet — we’ve asked them to.",
    );
    expect(screen.getByTestId("event-provenance-note-band-note")).toHaveTextContent(
      "Your event shows an address only until they confirm.",
    );
  });

  it("CONFIRMED: the venue confirmed this event; its name and link now show publicly", () => {
    useProvenanceQuery.mockReturnValue(resolved(eventFirst({ state: "confirmed" })));
    render(<EventProvenanceNote eventId={EVENT_ID} />);
    expect(screen.getByTestId("event-provenance-note")).toHaveAttribute("data-state", "confirmed");
    expect(screen.getByTestId("event-provenance-note-band-headline")).toHaveTextContent(
      "The Blue Room confirmed this event.",
    );
    expect(screen.getByTestId("event-provenance-note-band-note")).toHaveTextContent(
      "The place’s name and link now show on your event page.",
    );
  });

  it("WITHDRAWN: the venue withdrew its confirmation; address-only, and they can confirm again", () => {
    useProvenanceQuery.mockReturnValue(resolved(eventFirst({ state: "withdrawn" })));
    render(<EventProvenanceNote eventId={EVENT_ID} />);
    expect(screen.getByTestId("event-provenance-note")).toHaveAttribute("data-state", "withdrawn");
    expect(screen.getByTestId("event-provenance-note-band-headline")).toHaveTextContent(
      "The Blue Room withdrew its confirmation.",
    );
    const note = screen.getByTestId("event-provenance-note-band-note");
    expect(note).toHaveTextContent(
      "Your event shows an address only. They can confirm it again.",
    );
    // Not the awaiting copy — "until they confirm" misreads after a withdrawal.
    expect(note).not.toHaveTextContent(/until they confirm/i);
  });

  it.each(["DECLINED", "WITHDRAWN", "EXPIRED"] as const)(
    "a %s request with no confirmation stamp renders NO band — nothing is 'awaiting'",
    (status) => {
      useProvenanceQuery.mockReturnValue(
        resolved(eventFirst({ state: "unconfirmed", status })),
      );
      const { container } = render(<EventProvenanceNote eventId={EVENT_ID} />);
      expect(container).toBeEmptyDOMElement();
    },
  );

  it("the venue's stamp wins over a terminal request status (a confirmed event stays confirmed)", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(eventFirst({ state: "confirmed", status: "EXPIRED" })),
    );
    render(<EventProvenanceNote eventId={EVENT_ID} />);
    expect(screen.getByTestId("event-provenance-note")).toHaveAttribute("data-state", "confirmed");
  });

  it("a withdrawn or confirmed venue is never 'parked' — parking only matters while nothing is decided", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(eventFirst({ state: "withdrawn", parked: true })),
    );
    render(<EventProvenanceNote eventId={EVENT_ID} />);
    expect(screen.getByTestId("event-provenance-note")).toHaveAttribute("data-state", "withdrawn");
  });

  it("falls back to 'the place' when the place's name is gone, keeping the sentence", () => {
    useProvenanceQuery.mockReturnValue(
      resolved(eventFirst({ state: "unconfirmed", placeName: null })),
    );
    render(<EventProvenanceNote eventId={EVENT_ID} />);
    expect(screen.getByTestId("event-provenance-note-band-headline")).toHaveTextContent(
      "the place has your request.",
    );
  });

  it("renders the band from the JUST-SAVED request while the provenance query still says null", () => {
    useProvenanceQuery.mockReturnValue(resolved(null));
    render(
      <EventProvenanceNote
        eventId={EVENT_ID}
        bookingRequest={{
          id: REQUEST_ID,
          placeId: PLACE_ID,
          placeName: "The Blue Room",
          intent: "RENT",
          parked: false,
          outcome: "created",
        }}
      />,
    );
    expect(screen.getByTestId("event-provenance-note")).toHaveAttribute("data-state", "awaiting");
    expect(screen.getByTestId("event-provenance-note-band-headline")).toHaveTextContent(
      "The Blue Room has your request.",
    );
    expect(screen.getByTestId("event-provenance-note-thread-link")).toHaveAttribute(
      "href",
      ADMIN_THREAD_HREF,
    );
  });

  it("a just-saved request at an UNCLAIMED venue renders the parked band, with the 'the place' fallback", () => {
    useProvenanceQuery.mockReturnValue(resolved(null));
    render(
      <EventProvenanceNote
        eventId={EVENT_ID}
        bookingRequest={{
          id: REQUEST_ID,
          placeId: PLACE_ID,
          placeName: null,
          intent: "PERFORM",
          parked: true,
          outcome: "created",
        }}
      />,
    );
    expect(screen.getByTestId("event-provenance-note")).toHaveAttribute("data-state", "parked");
    expect(screen.getByTestId("event-provenance-note-band-headline")).toHaveTextContent(
      "the place hasn’t claimed its page yet — we’ve asked them to.",
    );
  });

  it("the provenance query WINS over the just-saved prop once it has data (a re-save may have found an answered request)", () => {
    useProvenanceQuery.mockReturnValue(resolved(eventFirst({ state: "confirmed" })));
    render(
      <EventProvenanceNote
        eventId={EVENT_ID}
        bookingRequest={{
          id: REQUEST_ID,
          placeId: PLACE_ID,
          placeName: "The Blue Room",
          intent: "PERFORM",
          parked: false,
          outcome: "existing",
        }}
      />,
    );
    expect(screen.getByTestId("event-provenance-note")).toHaveAttribute("data-state", "confirmed");
  });

  it("the request-first note (agreement present) is untouched: no band, the breadcrumb as before", () => {
    useProvenanceQuery.mockReturnValue(resolved(provenance({})));
    render(<EventProvenanceNote eventId={EVENT_ID} bookingRequest={null} />);
    expect(screen.queryByTestId("event-provenance-note-band-headline")).toBeNull();
    expect(screen.getByTestId("event-provenance-note-agreement-link")).toBeInTheDocument();
    expect(screen.getByTestId("event-provenance-note")).not.toHaveAttribute("data-state");
  });

  it("still renders NOTHING for an owned or granted venue's event: no provenance, no just-saved request", () => {
    useProvenanceQuery.mockReturnValue(resolved(null));
    const { container } = render(
      <EventProvenanceNote eventId={EVENT_ID} bookingRequest={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
