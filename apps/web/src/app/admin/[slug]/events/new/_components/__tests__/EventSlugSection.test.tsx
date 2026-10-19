/**
 * The builder's Sharing group: the Public link field (the same component as
 * the top of the builder) while the link works, the plain slug row with Copy /
 * Open while it does not, and "Regenerate slug".
 *
 * What this pins: the Regenerate control renders only when the caller says
 * the viewer may use it (`canRegenerate`). `regenerateEventSlug` asks edit
 * roles on a draft and ORG_ADMIN_ROLES once the event is PUBLISHED, so an
 * EDITOR on a live event must not be offered a button the server refuses —
 * while the link itself stays for everyone.
 *
 * MOCKS: tamagui / @th/ui reduced to DOM elements forwarding data- and aria-
 * attributes; the tRPC mutation is a stub resolving a new slug, which the
 * "offers Regenerate" case presses.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const PASS_PROP = /^(data-|aria-)|^(id|role|disabled)$/;
const domProps = (rest: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (PASS_PROP.test(key)) out[key] = value;
  }
  return out;
};

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => React.createElement("div", domProps(rest), children);
  return {
    XStack: Stack,
    YStack: Stack,
    styled: () => Stack,
    useTheme: () => ({}),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
    Button: ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "button",
        { type: "button", onClick: onPress, ...domProps(rest) },
        children,
      ),
    FormErrorBanner: () => null,
    useNotify: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@/hooks/useFormErrors", () => ({
  useFormErrors: () => ({
    formError: null,
    setError: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

const mutateAsync = vi.fn(async () => ({ newSlug: "fresh-slug" }));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: { getEventForEdit: { invalidate: vi.fn() } },
    }),
    events: {
      regenerateEventSlug: {
        useMutation: () => ({ mutateAsync }),
      },
    },
  },
}));

// The real field is covered by EventPublicLinkField.test.tsx; here it is a
// stub that shows which slug / short ID the group hands it.
vi.mock("../EventPublicLinkField", () => ({
  EventPublicLinkField: ({
    slug,
    shortId,
    onCopy,
  }: {
    slug: string;
    shortId: string | null;
    onCopy: () => void;
  }) => (
    <div data-testid="public-link-field">
      <span>{`/events/${slug}`}</span>
      <span>{shortId ? `/e/${shortId}` : ""}</span>
      <button type="button" data-testid="field-copy" onClick={onCopy} />
    </div>
  ),
}));

const { EventSlugSection } = await import("../EventSlugSection");

const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const PUBLISHED_AT = new Date("2026-09-01T12:00:00.000Z");

describe("EventSlugSection", () => {
  it("offers Regenerate when the viewer may regenerate", async () => {
    render(
      <EventSlugSection
        eventId={EVENT_ID}
        slug="old-slug"
        shortId="abc1"
        eventStatus="PUBLISHED"
        publishedAt={PUBLISHED_AT}
        canRegenerate
        onCopyEventLink={vi.fn()}
      />,
    );

    const button = screen.getByTestId("regenerate-slug-btn");
    fireEvent.click(button);

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: EVENT_ID }),
      ),
    );
    expect(await screen.findByText("/events/fresh-slug")).toBeInTheDocument();
  });

  it("withholds Regenerate (and its explainer) but keeps the link when the viewer may not", () => {
    render(
      <EventSlugSection
        eventId={EVENT_ID}
        slug="old-slug"
        shortId="abc1"
        eventStatus="PUBLISHED"
        publishedAt={PUBLISHED_AT}
        canRegenerate={false}
        onCopyEventLink={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("regenerate-slug-btn")).toBeNull();
    expect(screen.queryByText(/Regenerating creates a new URL/)).toBeNull();
    expect(screen.getByText("/events/old-slug")).toBeInTheDocument();
    expect(screen.getByTestId("public-link-field")).toBeInTheDocument();
  });

  // The field is a promise that the link opens for a stranger. A draft has a
  // slug and short ID from creation but the route 404s it, so the group keeps
  // the plain slug row (Copy, Open) and prints no short link until then.
  describe("the Public link field follows the public-readability rule", () => {
    const onCopyEventLink = vi.fn();
    const renderWith = (
      eventStatus: "DRAFT" | "PUBLISHED" | "CANCELLED",
      publishedAt: Date | null,
    ) =>
      render(
        <EventSlugSection
          eventId={EVENT_ID}
          slug="old-slug"
          shortId="abc1"
          eventStatus={eventStatus}
          publishedAt={publishedAt}
          canRegenerate={false}
          onCopyEventLink={onCopyEventLink}
        />,
      );

    it("a DRAFT gets the plain slug row, no field and no short link", () => {
      renderWith("DRAFT", null);
      expect(screen.queryByTestId("public-link-field")).toBeNull();
      expect(screen.queryByText(/\/e\/abc1/)).toBeNull();
      expect(screen.getByText("/events/old-slug")).toBeInTheDocument();
      expect(screen.getByTestId("copy-event-link-btn")).toBeInTheDocument();
      expect(screen.getByTestId("open-event-link-btn")).toBeInTheDocument();
    });

    it("an unpublished event (back to DRAFT, publishedAt kept) gets the row too", () => {
      renderWith("DRAFT", PUBLISHED_AT);
      expect(screen.queryByTestId("public-link-field")).toBeNull();
    });

    it("a CANCELLED event that was never published gets the row", () => {
      renderWith("CANCELLED", null);
      expect(screen.queryByTestId("public-link-field")).toBeNull();
    });

    it("a PUBLISHED event gets the field, with its short ID and the builder's copy handler", () => {
      renderWith("PUBLISHED", PUBLISHED_AT);
      expect(screen.getByTestId("public-link-field")).toBeInTheDocument();
      expect(screen.getByText("/e/abc1")).toBeInTheDocument();
      expect(screen.queryByTestId("copy-event-link-btn")).toBeNull();
      fireEvent.click(screen.getByTestId("field-copy"));
      expect(onCopyEventLink).toHaveBeenCalledTimes(1);
    });

    it("a CANCELLED event that WAS live keeps the field (its links are out in the world)", () => {
      renderWith("CANCELLED", PUBLISHED_AT);
      expect(screen.getByTestId("public-link-field")).toBeInTheDocument();
    });
  });
});
