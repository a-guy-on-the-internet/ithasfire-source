/**
 * The shared address-privacy control: the venue editor and the public
 * "add a venue" form both render THIS, so the mapping it performs between the
 * three on-screen choices and the stored `(locationMode, locationRadiusMeters,
 * locationLabel)` triple is the only place that mapping exists.
 *
 * The seeding half is the one with teeth: it is fail-closed, and a regression
 * there shows an owner "Exact address" for a venue that is actually withheld —
 * which their next unrelated save would then make true.
 *
 * The CREATE half runs the other way on purpose (ruled 2026-09-17): a venue
 * that does not exist yet starts with its address SHOWN, and the protection
 * for a home is the question the create surfaces ask, not a hidden default.
 */
import type { ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";

import enMessages from "@/i18n/messages/en";
import {
  DEFAULT_PLACE_OBFUSCATION_RADIUS_METERS,
  PlaceLocationPrivacyFields,
  newPlacePrivacyValue,
  placePrivacyToUpsertInput,
  placePrivacyValueFromRecord,
  type PlaceLocationPrivacyValue,
} from "../PlaceLocationPrivacyFields";

describe("newPlacePrivacyValue — a new venue starts SHOWN", () => {
  it("starts on the exact address, matching the server's create default", () => {
    // core's NEW_PLACE_DEFAULT_LOCATION_PRIVACY is EXACT; the form must not
    // disagree with it and send a hide nobody picked.
    expect(newPlacePrivacyValue()).toEqual({
      choice: "exact",
      radiusMeters: DEFAULT_PLACE_OBFUSCATION_RADIUS_METERS,
      areaLabel: "",
    });
    expect(placePrivacyToUpsertInput(newPlacePrivacyValue())).toEqual({
      locationMode: "EXACT",
      locationRadiusMeters: null,
      locationLabel: null,
    });
  });

  it("hands every form its own object", () => {
    const a = newPlacePrivacyValue();
    const b = newPlacePrivacyValue();
    expect(a).not.toBe(b);
  });
});

describe("placePrivacyValueFromRecord — fail closed", () => {
  it("reads an empty record as WITHHELD with no map", () => {
    // An EXISTING row this form cannot classify, and the admin editor's
    // placeholder while the row is still loading. Not a new venue: those
    // start from `newPlacePrivacyValue()` (see above).
    expect(placePrivacyValueFromRecord({}).choice).toBe("hidden");
  });

  it("reads an unrecognised mode as withheld, not exact", () => {
    expect(
      placePrivacyValueFromRecord({ locationMode: "APPROXIMATE" }).choice,
    ).toBe("hidden");
    expect(placePrivacyValueFromRecord({ locationMode: null }).choice).toBe(
      "hidden",
    );
  });

  it("reads OBSCURED with a radius as the circle choice", () => {
    const value = placePrivacyValueFromRecord({
      locationMode: "OBSCURED",
      locationRadiusMeters: 1200,
      locationLabel: "East Nashville",
    });
    expect(value).toEqual({
      choice: "area",
      radiusMeters: 1200,
      areaLabel: "East Nashville",
    });
  });

  it("reads OBSCURED with a null radius as fully hidden", () => {
    expect(
      placePrivacyValueFromRecord({
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
      }).choice,
    ).toBe("hidden");
  });

  it("reads the literal EXACT as exact", () => {
    expect(placePrivacyValueFromRecord({ locationMode: "EXACT" }).choice).toBe(
      "exact",
    );
  });
});

describe("placePrivacyToUpsertInput", () => {
  it("sends a null radius for the fully hidden choice — the MEANINGFUL null", () => {
    expect(
      placePrivacyToUpsertInput({
        choice: "hidden",
        radiusMeters: 1000,
        areaLabel: "East Nashville",
      }),
    ).toEqual({
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      locationLabel: "East Nashville",
    });
  });

  it("sends the radius only for the circle choice", () => {
    expect(
      placePrivacyToUpsertInput({
        choice: "area",
        radiusMeters: 1200,
        areaLabel: "",
      }),
    ).toEqual({
      locationMode: "OBSCURED",
      locationRadiusMeters: 1200,
      locationLabel: null,
    });
  });

  it("drops the radius entirely under the exact choice", () => {
    expect(
      placePrivacyToUpsertInput({
        choice: "exact",
        radiusMeters: 1200,
        areaLabel: "ignored",
      }),
    ).toMatchObject({ locationMode: "EXACT", locationRadiusMeters: null });
  });

  it("normalises a whitespace-only area label to null", () => {
    expect(
      placePrivacyToUpsertInput({
        choice: "hidden",
        radiusMeters: 1000,
        areaLabel: "   ",
      }).locationLabel,
    ).toBeNull();
  });
});

const renderFields = (
  props: Partial<Parameters<typeof PlaceLocationPrivacyFields>[0]> = {},
) => {
  const onChange = vi.fn();
  const utils = render(
    (
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <PlaceLocationPrivacyFields
            value={newPlacePrivacyValue()}
            onChange={onChange}
            {...props}
          />
        </TranslationProvider>
      </IthasFireProvider>
    ) as ReactElement,
  );
  return { ...utils, onChange };
};

describe("PlaceLocationPrivacyFields", () => {
  it("exposes the three choices as a real radio group", () => {
    renderFields();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    // Native radios: one group name, arrow-key navigation and the
    // "one of three" announcement come for free.
    const names = new Set(radios.map((r) => r.getAttribute("name")));
    expect(names.size).toBe(1);
  });

  const checkedChoice = () =>
    (screen.getAllByRole("radio") as HTMLInputElement[]).find((r) => r.checked)
      ?.value;

  it("starts on the exact address for a new place", () => {
    renderFields({ newPlace: true });
    expect(checkedChoice()).toBe("exact");
  });

  it("keeps an existing place on its stored value", () => {
    // An existing withheld venue must never be shown the new-place default:
    // its owner's next unrelated save would publish the address.
    const { unmount } = renderFields({
      value: placePrivacyValueFromRecord({
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
      }),
    });
    expect(checkedChoice()).toBe("hidden");
    unmount();

    const circle = renderFields({
      value: placePrivacyValueFromRecord({
        locationMode: "OBSCURED",
        locationRadiusMeters: 1200,
      }),
    });
    expect(checkedChoice()).toBe("area");
    circle.unmount();

    renderFields({
      value: placePrivacyValueFromRecord({ locationMode: "EXACT" }),
    });
    expect(checkedChoice()).toBe("exact");
  });

  it("asks the home question on a create surface, and only there", () => {
    const { unmount } = renderFields({ newPlace: true });
    expect(screen.getByTestId("place-privacy-prompt").textContent).toBe(
      "Is this someone's home? You can hide the address.",
    );
    // The retired note described a withheld default that no longer exists.
    expect(screen.queryByText(/start with the address withheld/i)).toBeNull();
    unmount();

    renderFields();
    expect(screen.queryByTestId("place-privacy-prompt")).toBeNull();
    expect(
      screen.getByText("How much of this place's location is public."),
    ).toBeInTheDocument();
  });

  describe("free-text warning (bio, area name, house rules, descriptions)", () => {
    const WARNING = "place-privacy-free-text-warning";
    const cases: Array<[PlaceLocationPrivacyValue["choice"], boolean]> = [
      ["exact", false],
      ["area", true],
      ["hidden", true],
    ];

    it.each(cases)("choice %s shows the warning: %s", (choice, shown) => {
      renderFields({
        value: { choice, radiusMeters: 1000, areaLabel: "" },
      });
      const warning = screen.queryByTestId(WARNING);
      if (shown) {
        expect(warning?.textContent).toBe(
          "Don't name the street in your bio, area name, house rules or event descriptions \u2014 those are shown as written.",
        );
      } else {
        expect(warning).toBeNull();
      }
    });

    it("describes the choice group while it is shown", () => {
      renderFields({
        value: { choice: "hidden", radiusMeters: 1000, areaLabel: "" },
      });
      const group = screen.getByTestId("place-privacy-group");
      const warning = screen.getByTestId(WARNING);
      expect(warning.id).not.toBe("");
      expect(group.getAttribute("aria-describedby")).toBe(warning.id);
    });

    it("appears the moment someone switches away from exact", () => {
      const onChange = vi.fn();
      const { rerender } = render(
        (
          <IthasFireProvider>
            <TranslationProvider locale="en-US" messages={enMessages}>
              <PlaceLocationPrivacyFields
                value={newPlacePrivacyValue()}
                onChange={onChange}
                newPlace
              />
            </TranslationProvider>
          </IthasFireProvider>
        ) as ReactElement,
      );
      expect(screen.queryByTestId(WARNING)).toBeNull();

      const hidden = (screen.getAllByRole("radio") as HTMLInputElement[]).find(
        (r) => r.value === "hidden",
      )!;
      fireEvent.click(hidden);
      const next = onChange.mock.calls[0]![0] as PlaceLocationPrivacyValue;
      expect(next.choice).toBe("hidden");

      rerender(
        (
          <IthasFireProvider>
            <TranslationProvider locale="en-US" messages={enMessages}>
              <PlaceLocationPrivacyFields
                value={next}
                onChange={onChange}
                newPlace
              />
            </TranslationProvider>
          </IthasFireProvider>
        ) as ReactElement,
      );
      expect(screen.getByTestId(WARNING)).toBeInTheDocument();
    });
  });

  it("tells the owner the area name is public", () => {
    renderFields({
      value: { choice: "hidden", radiusMeters: 1000, areaLabel: "" },
    });
    expect(screen.getByText(/^Public\. Anyone can see it/)).toBeInTheDocument();
  });

  it("states what visitors will see, and the ceiling it puts on events here", () => {
    renderFields({
      value: { choice: "hidden", radiusMeters: 1000, areaLabel: "East Nashville" },
    });
    expect(screen.getByTestId("place-privacy-preview").textContent).toContain(
      "East Nashville",
    );
    expect(screen.getByText(/Events at this place can't publish an address/i))
      .toBeInTheDocument();
  });

  it("does not claim a ceiling on events when the address is exact", () => {
    renderFields({
      value: { choice: "exact", radiusMeters: 1000, areaLabel: "" },
    });
    expect(
      screen.queryByText(/Events at this place can't publish an address/i),
    ).toBeNull();
  });

  it("shows the radius slider only for the circle choice", () => {
    const { rerender } = renderFields();
    expect(screen.queryByTestId("place-privacy-radius")).toBeNull();

    rerender(
      (
        <IthasFireProvider>
          <TranslationProvider locale="en-US" messages={enMessages}>
            <PlaceLocationPrivacyFields
              value={{
                choice: "area",
                radiusMeters: DEFAULT_PLACE_OBFUSCATION_RADIUS_METERS,
                areaLabel: "",
              }}
              onChange={vi.fn()}
            />
          </TranslationProvider>
        </IthasFireProvider>
      ) as ReactElement,
    );
    expect(screen.getByTestId("place-privacy-radius")).toBeInTheDocument();
  });

  it("hides the area-name field under the exact choice — the address IS the label there", () => {
    renderFields({
      value: { choice: "exact", radiusMeters: 1000, areaLabel: "" },
    });
    expect(screen.queryByTestId("place-privacy-area-label")).toBeNull();
  });

  it("reports a choice change without losing the radius the owner picked", () => {
    const { onChange } = renderFields({
      value: { choice: "hidden", radiusMeters: 2500, areaLabel: "Wedgewood" },
    });
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    expect(onChange).toHaveBeenCalledWith({
      choice: "area",
      radiusMeters: 2500,
      areaLabel: "Wedgewood",
    });
  });

  it("shows a legacy off-ladder radius at the rung the public circle is drawn at", () => {
    // Metric ("DE") so the strings are unambiguous.
    renderFields({
      countryCode: "DE",
      value: { choice: "area", radiusMeters: 700, areaLabel: "" },
    });
    // The public map draws 700 m at the next rung up, 1 km.
    const preview = screen.getByTestId("place-privacy-preview");
    expect(preview.textContent).toContain("1 km");
    expect(preview.textContent).not.toContain("700");
    const slider = screen.getByTestId("place-privacy-radius");
    expect(slider.getAttribute("aria-valuetext")).toBe("1 km");
  });
});
