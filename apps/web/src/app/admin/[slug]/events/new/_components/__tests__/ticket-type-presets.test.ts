import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import { resolveTicketAmountField } from "../TicketTypeEditor";
import {
  TICKET_TYPE_PRESETS,
  TICKET_TYPE_PRESET_CUSTOM_ID,
  applyPresetToForm,
  buildPresetMetaLine,
  findTicketTypePreset,
  presetDollarsToCents,
  type TicketTypePreset,
} from "../ticket-type-presets";

/**
 * Stand-in for the component's `t()`: echoes the key so assertions can prove a
 * value came from i18n rather than a hardcoded English literal.
 */
const echoKey = (key: string) => `«${key}»`;

/**
 * The converter `TicketTypeEditor` itself runs on submit, imported FROM the
 * component module (precedent: `ticket-card-meta.test.ts`).
 *
 * This used to be a hand-copied `Math.round(parseFloat(x || "0") * 100)` — the
 * very converter that silently turned an es-locale "15,50" into $15.00 — and
 * then, briefly, a direct call to `parseMoneyInputToCents`. Both versions
 * tested a lookalike rather than the shipped seam: reverting `handleAdd` to
 * `parseFloat` would have left this suite green. Going through
 * `resolveTicketAmountField` means these assertions fail if the editor stops
 * using the shared reader.
 *
 * Returns the cents a submit would send, or `null` where a submit would be
 * REFUSED with an error toast.
 */
const submitToCents = (dollars: string): number | null => {
  const field = resolveTicketAmountField(dollars, "price");
  return field.kind === "cents" ? field.cents : null;
};

const adminCatalog = (messages: { admin: unknown }) =>
  messages.admin as Record<string, string>;

const presetsWithoutCustom = TICKET_TYPE_PRESETS.filter(
  (preset) => preset.id !== TICKET_TYPE_PRESET_CUSTOM_ID,
);

const custom = TICKET_TYPE_PRESETS[0]!;

describe("TICKET_TYPE_PRESETS catalog", () => {
  it("leads with the custom (blank) entry — it is the default selection", () => {
    expect(custom.id).toBe(TICKET_TYPE_PRESET_CUSTOM_ID);
    expect(custom.priceDollars).toBe("");
    expect(custom.capacity).toBe("");
    expect(custom.minimumDollars).toBe("");
    expect(custom.suggestedDollars).toBe("");
  });

  it("ships the eight documented presets, with unique ids and name keys", () => {
    expect(presetsWithoutCustom.map((p) => p.id)).toEqual([
      "ga",
      "advance",
      "door",
      "vip",
      "student",
      "pwyw",
      "sliding",
      "industry",
    ]);
    expect(new Set(TICKET_TYPE_PRESETS.map((p) => p.id)).size).toBe(
      TICKET_TYPE_PRESETS.length,
    );
    expect(new Set(TICKET_TYPE_PRESETS.map((p) => p.nameKey)).size).toBe(
      TICKET_TYPE_PRESETS.length,
    );
  });

  it("names every preset through an admin.ttPreset* i18n key, never a literal", () => {
    for (const preset of TICKET_TYPE_PRESETS) {
      expect(preset.nameKey).toMatch(/^admin\.ttPreset[A-Z]/);
    }
  });

  it.each([
    ["en", enMessages],
    ["es", esMessages],
  ])("resolves every preset name in the %s catalog", (_locale, messages) => {
    const admin = adminCatalog(messages as { admin: unknown });
    for (const preset of TICKET_TYPE_PRESETS) {
      const key = preset.nameKey.replace(/^admin\./, "");
      expect(typeof admin[key]).toBe("string");
      expect(admin[key]!.length).toBeGreaterThan(0);
    }
  });
});

describe("catalog values satisfy the upsert schema the add form submits", () => {
  it.each(presetsWithoutCustom.map((p) => [p.id, p] as const))(
    "%s parses to an integer capacity >= 1",
    (_id, preset: TicketTypePreset) => {
      const capacity = parseInt(preset.capacity, 10);
      expect(Number.isNaN(capacity)).toBe(false);
      expect(Number.isInteger(capacity)).toBe(true);
      expect(capacity).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(presetsWithoutCustom.map((p) => [p.id, p] as const))(
    "%s carries a price that is a non-negative amount, or empty when adjustable",
    (_id, preset: TicketTypePreset) => {
      if (preset.pricingMode === "ADJUSTABLE") {
        // The form hides Price in adjustable mode and `handleAdd` sends 0.
        expect(preset.priceDollars).toBe("");
        return;
      }
      expect(preset.priceDollars).not.toBe("");
      const cents = submitToCents(preset.priceDollars);
      // `null` here would mean the submit path REFUSES a shipped preset.
      expect(cents).not.toBeNull();
      expect(cents).toBeGreaterThanOrEqual(0);
    },
  );

  it.each(
    presetsWithoutCustom
      .filter((p) => p.pricingMode === "ADJUSTABLE")
      .map((p) => [p.id, p] as const),
  )("%s has minimum <= suggested, both non-negative", (_id, preset) => {
    const min = submitToCents(preset.minimumDollars);
    const suggested = submitToCents(preset.suggestedDollars);
    expect(min).not.toBeNull();
    expect(suggested).not.toBeNull();
    expect(min).toBeGreaterThanOrEqual(0);
    expect(suggested).toBeGreaterThanOrEqual(0);
    expect(min).toBeLessThanOrEqual(suggested!);
  });

  it("leaves minimum/suggested empty for every fixed-price preset", () => {
    for (const preset of TICKET_TYPE_PRESETS.filter(
      (p) => p.pricingMode === "FIXED",
    )) {
      expect(preset.minimumDollars).toBe("");
      expect(preset.suggestedDollars).toBe("");
    }
  });

  it("never enables resale — no preset even carries a resale field", () => {
    for (const preset of TICKET_TYPE_PRESETS) {
      expect(preset).not.toHaveProperty("resaleAllowed");
      expect(preset).not.toHaveProperty("resaleCapDollars");
      expect(preset).not.toHaveProperty("resaleCapCents");
      expect(preset).not.toHaveProperty("seatSectionId");
      expect(JSON.stringify(preset).toLowerCase()).not.toContain("resale");
    }
  });
});

describe("applyPresetToForm", () => {
  it("fills exactly the six add-form fields a preset owns", () => {
    const ga = findTicketTypePreset("ga");
    expect(applyPresetToForm(ga, echoKey)).toEqual({
      name: "«admin.ttPresetGa»",
      priceDollars: "15.00",
      capacity: "100",
      pricingMode: "FIXED",
      minimumDollars: "",
      suggestedDollars: "",
    });
  });

  it("returns no resale (or seating) keys, so a preset can never smuggle them on", () => {
    for (const preset of TICKET_TYPE_PRESETS) {
      const values = applyPresetToForm(preset, echoKey);
      expect(Object.keys(values).sort()).toEqual([
        "capacity",
        "minimumDollars",
        "name",
        "priceDollars",
        "pricingMode",
        "suggestedDollars",
      ]);
    }
  });

  it("switches an adjustable preset into ADJUSTABLE with min/suggested and no price", () => {
    expect(applyPresetToForm(findTicketTypePreset("pwyw"), echoKey)).toEqual({
      name: "«admin.ttPresetPwyw»",
      priceDollars: "",
      capacity: "100",
      pricingMode: "ADJUSTABLE",
      minimumDollars: "0.00",
      suggestedDollars: "10.00",
    });
    expect(applyPresetToForm(findTicketTypePreset("sliding"), echoKey)).toEqual({
      name: "«admin.ttPresetSliding»",
      priceDollars: "",
      capacity: "100",
      pricingMode: "ADJUSTABLE",
      minimumDollars: "10.00",
      suggestedDollars: "20.00",
    });
  });

  it("takes the saved name from the caller's locale, not a hardcoded literal", () => {
    const es = adminCatalog(esMessages as { admin: unknown });
    const translate = (key: string) => es[key.replace(/^admin\./, "")] ?? key;
    expect(applyPresetToForm(findTicketTypePreset("ga"), translate).name).toBe(
      "Entrada general",
    );
  });

  it("clears cleanly when Custom (blank) follows a preset", () => {
    const filled = applyPresetToForm(findTicketTypePreset("vip"), echoKey);
    expect(filled).not.toEqual(
      expect.objectContaining({ name: "", capacity: "" }),
    );

    const cleared = applyPresetToForm(custom, echoKey);
    expect(cleared).toEqual({
      // "Custom (blank)" is a UI affordance, never a ticket-type name.
      name: "",
      priceDollars: "",
      capacity: "",
      pricingMode: "FIXED",
      minimumDollars: "",
      suggestedDollars: "",
    });
  });

  it("round-trips preset → custom → preset without leaking the previous pick", () => {
    const sequence = ["sliding", "custom", "door"] as const;
    const results = sequence.map((id) =>
      applyPresetToForm(findTicketTypePreset(id), echoKey),
    );
    expect(results[1]!.pricingMode).toBe("FIXED");
    expect(results[1]!.minimumDollars).toBe("");
    expect(results[2]).toEqual({
      name: "«admin.ttPresetDoor»",
      priceDollars: "20.00",
      capacity: "50",
      pricingMode: "FIXED",
      minimumDollars: "",
      suggestedDollars: "",
    });
  });
});

describe("findTicketTypePreset", () => {
  it("falls back to the custom (blank) entry for an unknown or missing id", () => {
    expect(findTicketTypePreset(null).id).toBe(TICKET_TYPE_PRESET_CUSTOM_ID);
    expect(findTicketTypePreset(undefined).id).toBe(
      TICKET_TYPE_PRESET_CUSTOM_ID,
    );
  });
});

describe("presetDollarsToCents", () => {
  it("rounds to cents and coerces blank/unreadable input to zero", () => {
    expect(presetDollarsToCents("15.00")).toBe(1500);
    expect(presetDollarsToCents("0.00")).toBe(0);
    expect(presetDollarsToCents("")).toBe(0);
    expect(presetDollarsToCents("  ")).toBe(0);
    expect(presetDollarsToCents("nonsense")).toBe(0);
  });

  it("reads the same separators the submit path does", () => {
    // Both sides run parseMoneyInputToCents, so the meta line renders an
    // es-locale amount identically to how a submit would bank it.
    expect(presetDollarsToCents("15,50")).toBe(1550);
    expect(presetDollarsToCents("1.234,56")).toBe(123456);
  });

  it("quotes exactly what the submit path would send, for every catalog value", () => {
    // The guarantee that matters: a dropdown meta line must never advertise an
    // amount the add form wouldn't actually create. Delegation makes this true
    // by construction; the assertion keeps it true if either side is edited.
    for (const preset of TICKET_TYPE_PRESETS) {
      for (const dollars of [
        preset.priceDollars,
        preset.minimumDollars,
        preset.suggestedDollars,
      ].filter((value) => value !== "")) {
        expect(presetDollarsToCents(dollars)).toBe(submitToCents(dollars));
      }
    }
  });

  it("diverges from the submit path ONLY by coercing a refusal to zero", () => {
    // The two converters are now the same reader; what differs is the
    // fallback. Display has to render something (0), a submit must REFUSE
    // (null here, an error toast + no mutation in the component). Nobody
    // should "simplify" that away — coercing a typo to 0 on submit is the
    // silent-$0-ticket bug.
    for (const unreadable of ["nonsense", "-5.00", "1,500", "15abc"]) {
      expect(presetDollarsToCents(unreadable)).toBe(0);
      expect(submitToCents(unreadable)).toBeNull();
    }
    // Blank is the same shape of divergence: 0 for display, "caller decides"
    // for the submit path (where a blank price specifically means free).
    expect(presetDollarsToCents("")).toBe(0);
    expect(submitToCents("")).toBeNull();
  });
});

describe("buildPresetMetaLine", () => {
  const deps = {
    translate: (key: string, values?: Record<string, string | number>) =>
      values
        ? `${key}(${Object.entries(values)
            .map(([k, v]) => `${k}=${v}`)
            .join(",")})`
        : key,
    formatAmount: (cents: number) => `$${(cents / 100).toFixed(2)}`,
    formatPrice: (cents: number) =>
      cents === 0 ? "Free" : `$${(cents / 100).toFixed(2)}`,
  };

  it("describes a fixed-price preset with price and capacity", () => {
    expect(buildPresetMetaLine(findTicketTypePreset("ga"), deps)).toBe(
      "admin.ttPresetMetaFixed(price=$15.00,capacity=100)",
    );
  });

  it("uses the Free word for a zero-price preset", () => {
    expect(buildPresetMetaLine(findTicketTypePreset("industry"), deps)).toBe(
      "admin.ttPresetMetaFixed(price=Free,capacity=10)",
    );
  });

  it("keeps a $0.00 pay-what-you-want minimum as an exact amount, not 'Free'", () => {
    expect(buildPresetMetaLine(findTicketTypePreset("pwyw"), deps)).toBe(
      "admin.ttPresetMetaAdjustable(min=$0.00,suggested=$10.00,capacity=100)",
    );
  });

  it("describes the custom entry without quoting money it does not have", () => {
    expect(buildPresetMetaLine(custom, deps)).toBe("admin.ttPresetCustomMeta");
  });

  it.each([
    ["en", enMessages],
    ["es", esMessages],
  ])(
    "has every meta-line message present in the %s catalog",
    (_locale, messages) => {
      const admin = adminCatalog(messages as { admin: unknown });
      for (const key of [
        "ttPresetLabel",
        "ttPresetHelp",
        "ttPresetCustomMeta",
        "ttPresetMetaFixed",
        "ttPresetMetaAdjustable",
      ]) {
        expect(typeof admin[key]).toBe("string");
        expect(admin[key]!.length).toBeGreaterThan(0);
      }
      // The placeholders the builder feeds must exist in the copy.
      expect(admin.ttPresetMetaFixed).toContain("{price}");
      expect(admin.ttPresetMetaFixed).toContain("{capacity}");
      expect(admin.ttPresetMetaAdjustable).toContain("{min}");
      expect(admin.ttPresetMetaAdjustable).toContain("{suggested}");
      expect(admin.ttPresetMetaAdjustable).toContain("{capacity}");
    },
  );
});
