import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@th/locale";
import { describe, expect, it } from "vitest";

import { emailStorybookSamples } from "./generated/samples";

describe("email storybook samples", () => {
  it("provides variants for every supported locale", () => {
    expect(emailStorybookSamples.length).toBeGreaterThan(0);

    for (const sample of emailStorybookSamples) {
      expect(sample.variants).toHaveLength(SUPPORTED_LOCALES.length);

      const locales = sample.variants.map((variant) => variant.locale);
      expect([...new Set(locales)].sort()).toEqual(
        [...SUPPORTED_LOCALES].sort(),
      );

      for (const locale of SUPPORTED_LOCALES) {
        const variant = sample.variants.find(
          (candidate) => candidate.locale === locale,
        );
        expect(
          variant,
          `Missing variant for ${sample.id} (${locale})`,
        ).toBeDefined();
        expect(typeof variant?.subject).toBe("string");
        expect(variant?.subject?.length ?? 0).toBeGreaterThan(0);
        expect(typeof variant?.html).toBe("string");
        expect(variant?.html?.length ?? 0).toBeGreaterThan(0);
        expect(typeof variant?.text).toBe("string");
        if (sample.hasTextTemplate) {
          expect(variant?.text?.length ?? 0).toBeGreaterThan(0);
        }
      }

      const defaultVariant = sample.variants.find(
        (variant) => variant.locale === DEFAULT_LOCALE,
      );
      expect(
        defaultVariant,
        `Missing default (${DEFAULT_LOCALE}) variant for ${sample.id}`,
      ).toBeDefined();

      if (defaultVariant) {
        expect(defaultVariant.subject).toBe(sample.subject);
        expect(defaultVariant.html).toBe(sample.html);
        expect(defaultVariant.text).toBe(sample.text);
      }
    }
  });
});
