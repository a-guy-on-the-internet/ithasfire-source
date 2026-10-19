import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: passthrough, YStack: passthrough };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Badge: ({ children }: { children?: ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatters: () => ({
    locale: "en",
    number: (n: number) => String(n),
    currency: (n: number) => String(n),
    dateTime: (d: Date) => d.toISOString(),
    getRawMessage: (key: string) => key,
  }),
}));

import { SuggestionDiffCard } from "../SuggestionDiffCard";

describe("SuggestionDiffCard", () => {
  it("renders before/after values with column labels", () => {
    render(
      <SuggestionDiffCard
        fieldKey="title"
        label="Title"
        before="Old title"
        after="New title"
      />,
    );

    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("moderation.before")).toBeInTheDocument();
    expect(screen.getByText("moderation.after")).toBeInTheDocument();
    expect(screen.getByText("Old title")).toBeInTheDocument();
    expect(screen.getByText("New title")).toBeInTheDocument();
    // No conflict tag, no material marker by default.
    expect(screen.queryByTestId("badge")).not.toBeInTheDocument();
    expect(screen.queryByText("moderation.material")).not.toBeInTheDocument();
  });

  it("shows the CONFLICT tag when conflicted", () => {
    render(
      <SuggestionDiffCard
        fieldKey="title"
        label="Title"
        before="Old"
        after="New"
        conflicted
      />,
    );

    expect(screen.getByTestId("badge")).toHaveTextContent(
      "MODERATION.CONFLICT",
    );
  });

  it("shows the material marker for material fields", () => {
    render(
      <SuggestionDiffCard
        fieldKey="addressText"
        label="Address"
        before="1 Old St"
        after="2 New Ave"
        material
      />,
    );

    expect(screen.getByText("moderation.material")).toBeInTheDocument();
  });

  it("renders 'not set' for null values", () => {
    render(
      <SuggestionDiffCard
        fieldKey="ageLimit"
        label="Age limit"
        before={null}
        after={18}
      />,
    );

    expect(screen.getByText("moderation.emptyValue")).toBeInTheDocument();
    expect(screen.getByText("18")).toBeInTheDocument();
  });

  it("renders a plain-text preview for body content without mounting an editor", () => {
    const body = {
      blocks: [
        {
          type: "richText",
          doc: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Weekly acoustic jam" }],
              },
            ],
          },
        },
      ],
    };

    render(
      <SuggestionDiffCard
        fieldKey="content"
        label="Description"
        before={null}
        after={body}
      />,
    );

    expect(screen.getByText("Weekly acoustic jam")).toBeInTheDocument();
  });

  it("falls back to a structured-content note when no text is extractable", () => {
    render(
      <SuggestionDiffCard
        fieldKey="content"
        label="Description"
        before={null}
        after={{ blocks: [{ type: "spacer", size: "md" }] }}
      />,
    );

    expect(
      screen.getByText(/moderation\.bodyPreviewFallback/),
    ).toBeInTheDocument();
  });

  it("renders URL-shaped field values as plain text, never as an image", () => {
    // Suggestion values are anonymous-submittable — an <img> here would let
    // a submitter deanonymize the reviewer (browser GETs the URL on open).
    const { container } = render(
      <SuggestionDiffCard
        fieldKey="title"
        label="Title"
        before="Old title"
        after="https://evil.example/pixel.png"
      />,
    );

    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(
      screen.getByText("https://evil.example/pixel.png"),
    ).toBeInTheDocument();
  });

  it("renders thumbnails only from the explicit imageUrls prop", () => {
    const { container } = render(
      <SuggestionDiffCard
        fieldKey="heroImageId"
        label="Hero image"
        before="0f0f0f0f-aaaa-bbbb-cccc-dddddddddddd"
        after="1a1a1a1a-aaaa-bbbb-cccc-dddddddddddd"
        imageUrls={{ after: "https://cdn.example/hero.jpg" }}
      />,
    );

    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("src", "https://cdn.example/hero.jpg");
    // The before column (no resolved URL) still renders the raw id.
    expect(
      screen.getByText("0f0f0f0f-aaaa-bbbb-cccc-dddddddddddd"),
    ).toBeInTheDocument();
  });

  it("formats date fields via the locale formatter", () => {
    render(
      <SuggestionDiffCard
        fieldKey="startsAt"
        label="Starts"
        before="2026-07-10T19:00:00.000Z"
        after="2026-07-11T19:00:00.000Z"
      />,
    );

    expect(
      screen.getByText("2026-07-10T19:00:00.000Z"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2026-07-11T19:00:00.000Z"),
    ).toBeInTheDocument();
  });
});
