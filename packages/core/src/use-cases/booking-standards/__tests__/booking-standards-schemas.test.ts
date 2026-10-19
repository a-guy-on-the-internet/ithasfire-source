import { describe, expect, it } from "vitest";

import {
  bookingPitchExampleInputSchema,
  bookingPitchExamplesWriteSchema,
  bookingStandardItemInputSchema,
  bookingStandardItemsWriteSchema,
  containsLinkLikeText,
} from "../booking-standards-schemas";

const messages = (result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  result.success ? [] : result.error!.issues.map((i) => [i.message, i.path.join(".")]);

describe("bookingStandardItemInputSchema", () => {
  it("accepts a known field as REQUIRED and normalizes a missing hint to null", () => {
    const parsed = bookingStandardItemInputSchema.parse({
      field: "LINK_MUSIC",
      label: "A link to your music",
      requirement: "REQUIRED",
    });
    expect(parsed).toEqual({
      field: "LINK_MUSIC",
      label: "A link to your music",
      hint: null,
      requirement: "REQUIRED",
    });
  });

  it("sanitizes BEFORE the length checks (NFR-001)", () => {
    const parsed = bookingStandardItemInputSchema.parse({
      field: "GENRE",
      label: "<b>Your</b> genre‮",
      hint: "<script>alert(1)</script>One or two words",
      requirement: "SUGGESTED",
    });
    expect(parsed.label).toBe("Your genre");
    expect(parsed.hint).toBe("One or two words");

    // All markup → empty after sanitize → fails min(1).
    expect(
      bookingStandardItemInputSchema.safeParse({
        field: "GENRE",
        label: "<b></b>",
        requirement: "SUGGESTED",
      }).success,
    ).toBe(false);
    // Markup does not count toward the 80 cap: 80 visible chars pass.
    expect(
      bookingStandardItemInputSchema.safeParse({
        field: "GENRE",
        label: `<i>${"x".repeat(80)}</i>`,
        requirement: "SUGGESTED",
      }).success,
    ).toBe(true);
  });

  it("an empty-after-sanitize hint or an explicit null is stored as null", () => {
    for (const hint of ["", "   ", "<br>", null]) {
      expect(
        bookingStandardItemInputSchema.parse({
          field: "GENRE",
          label: "Genre",
          hint,
          requirement: "SUGGESTED",
        }).hint,
      ).toBeNull();
    }
  });

  it("bounds label at 80 and hint at 240", () => {
    const base = { field: "GENRE", requirement: "SUGGESTED" } as const;
    expect(
      bookingStandardItemInputSchema.safeParse({ ...base, label: "x".repeat(81) }).success,
    ).toBe(false);
    expect(
      bookingStandardItemInputSchema.safeParse({
        ...base,
        label: "ok",
        hint: "y".repeat(241),
      }).success,
    ).toBe(false);
    expect(
      bookingStandardItemInputSchema.safeParse({
        ...base,
        label: "x".repeat(80),
        hint: "y".repeat(240),
      }).success,
    ).toBe(true);
  });

  it.each([
    "https://bandcamp.com/x",
    "hxxp://obfuscated.example",
    "ftp://files.example",
    "www.example.org",
    "bandcamp.com",
    "Send lowporch.bandcamp.com please",
    "example.io/epk",
    "Our list: tinyurl.ly/abc",
    "Instagram.COM/band",
    "radio.fm",
    "venue.co.uk",
  ])("flags URL-ish text: %s", (text) => {
    expect(containsLinkLikeText(text)).toBe(true);
  });

  it.each([
    "St. Louis acts welcome",
    "Sets of 3.5 hours or less",
    "e.g. a live video",
    "No covers.",
    "Tell us about your company.",
    "Bandcamp, Spotify, or SoundCloud",
    "Dates: Fri/Sat",
  ])("leaves ordinary wording alone: %s", (text) => {
    expect(containsLinkLikeText(text)).toBe(false);
  });

  it("refuses links in labels and hints (NFR-001)", () => {
    expect(
      messages(
        bookingStandardItemInputSchema.safeParse({
          field: "LINK_MUSIC",
          label: "Music, e.g. https://bandcamp.com",
          requirement: "SUGGESTED",
        }),
      ),
    ).toEqual([["booking_standard_label_contains_link", "label"]]);
    expect(
      messages(
        bookingStandardItemInputSchema.safeParse({
          field: "LINK_MUSIC",
          label: "Music",
          hint: "See www.example.com for our rules",
          requirement: "SUGGESTED",
        }),
      ),
    ).toEqual([["booking_standard_hint_contains_link", "hint"]]);
  });

  it.each(["CUSTOM", "MESSAGE", "PREFERRED_DATES", "PURPOSE", "REQUESTED_WINDOW"] as const)(
    "%s may be SUGGESTED, never REQUIRED (D2a / schema-mandatory)",
    (field) => {
      expect(
        bookingStandardItemInputSchema.safeParse({
          field,
          label: "A prompt",
          requirement: "SUGGESTED",
        }).success,
      ).toBe(true);
      expect(
        messages(
          bookingStandardItemInputSchema.safeParse({
            field,
            label: "A prompt",
            requirement: "REQUIRED",
          }),
        ),
      ).toEqual([["booking_standard_field_cannot_be_required", "requirement"]]);
    },
  );

  it.each(["BILL", "LINK_MUSIC", "EXPECTED_DRAW", "FEE", "EXPECTED_ATTENDANCE"] as const)(
    "%s may be REQUIRED",
    (field) => {
      expect(
        bookingStandardItemInputSchema.safeParse({
          field,
          label: "Needed",
          requirement: "REQUIRED",
        }).success,
      ).toBe(true);
    },
  );

  it("is strict and rejects unknown fields / requirements", () => {
    expect(
      bookingStandardItemInputSchema.safeParse({
        field: "LINK_MUSIC",
        label: "x",
        requirement: "SUGGESTED",
        sortOrder: 3,
      }).success,
    ).toBe(false);
    expect(
      bookingStandardItemInputSchema.safeParse({
        field: "STAGE_PLOT",
        label: "x",
        requirement: "SUGGESTED",
      }).success,
    ).toBe(false);
    expect(
      bookingStandardItemInputSchema.safeParse({
        field: "GENRE",
        label: "x",
        requirement: "OPTIONAL",
      }).success,
    ).toBe(false);
  });
});

describe("bookingStandardItemsWriteSchema", () => {
  // CUSTOM: the one field that may repeat, so this pins the COUNT cap alone.
  const perform = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      field: "CUSTOM" as const,
      label: `Item ${i}`,
      requirement: "SUGGESTED" as const,
    }));

  it("allows up to 12 items and [] (clear)", () => {
    expect(
      bookingStandardItemsWriteSchema.safeParse({ intent: "PERFORM", items: perform(12) }).success,
    ).toBe(true);
    expect(
      bookingStandardItemsWriteSchema.safeParse({ intent: "PERFORM", items: [] }).success,
    ).toBe(true);
    expect(
      bookingStandardItemsWriteSchema.safeParse({ intent: "PERFORM", items: perform(13) }).success,
    ).toBe(false);
  });

  it("every item's field must apply to the intent", () => {
    expect(
      messages(
        bookingStandardItemsWriteSchema.safeParse({
          intent: "RENT",
          items: [
            { field: "EXPECTED_ATTENDANCE", label: "Headcount", requirement: "REQUIRED" },
            { field: "LINK_MUSIC", label: "Music", requirement: "SUGGESTED" },
            { field: "CUSTOM", label: "Bring your own chairs", requirement: "SUGGESTED" },
          ],
        }),
      ),
    ).toEqual([["booking_standard_field_not_for_intent", "items.1.field"]]);
  });
});

describe("bookingPitchExampleInputSchema", () => {
  it("keeps the body's paragraphs, strips markup, and bounds title 80 / body 1500", () => {
    const parsed = bookingPitchExampleInputSchema.parse({
      title: "<em>Local</em> band",
      body: "Hi,\n\nWe are <b>Low Porch</b>.\n\n\n\nThanks.",
    });
    expect(parsed).toEqual({
      title: "Local band",
      body: "Hi,\n\nWe are Low Porch.\n\nThanks.",
    });
    expect(
      bookingPitchExampleInputSchema.safeParse({ title: "x".repeat(81), body: "b" }).success,
    ).toBe(false);
    expect(
      bookingPitchExampleInputSchema.safeParse({ title: "t", body: "b".repeat(1501) }).success,
    ).toBe(false);
    expect(
      bookingPitchExampleInputSchema.safeParse({ title: "t", body: "  " }).success,
    ).toBe(false);
  });

  it("a pitch body may carry a link (a real pitch does); the TITLE may not", () => {
    expect(
      bookingPitchExampleInputSchema.safeParse({
        title: "Touring act",
        body: "Our music: https://example.bandcamp.com and lowporch.bandcamp.com",
      }).success,
    ).toBe(true);
    expect(
      messages(
        bookingPitchExampleInputSchema.safeParse({
          title: "See lowporch.bandcamp.com",
          body: "Body",
        }),
      ),
    ).toEqual([["booking_pitch_example_title_contains_link", "title"]]);
  });

  it("allows up to 3 examples per write", () => {
    const ex = { title: "t", body: "b" };
    expect(
      bookingPitchExamplesWriteSchema.safeParse({ intent: "USE", examples: [ex, ex, ex] }).success,
    ).toBe(true);
    expect(
      bookingPitchExamplesWriteSchema.safeParse({ intent: "USE", examples: [ex, ex, ex, ex] }).success,
    ).toBe(false);
  });
});

describe("bookingStandardItemsWriteSchema — one row per known field", () => {
  it("refuses a known field listed twice, pathed to the LATER row's field", () => {
    const result = bookingStandardItemsWriteSchema.safeParse({
      intent: "PERFORM",
      items: [
        { field: "LINK_MUSIC", label: "A music link", requirement: "REQUIRED" },
        { field: "EXPECTED_DRAW", label: "Your draw", requirement: "SUGGESTED" },
        { field: "LINK_MUSIC", label: "Music again", requirement: "SUGGESTED" },
      ],
    });
    expect(messages(result)).toEqual([["booking_standard_field_duplicate", "items.2.field"]]);
  });

  it("CUSTOM lines may repeat", () => {
    const result = bookingStandardItemsWriteSchema.safeParse({
      intent: "PERFORM",
      items: [
        { field: "CUSTOM", label: "Bring your own drum kit", requirement: "SUGGESTED" },
        { field: "CUSTOM", label: "No covers nights", requirement: "SUGGESTED" },
      ],
    });
    expect(result.success).toBe(true);
  });
});
