import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { mapZodErrors, validateForm, type TFn } from "../map-zod-errors";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a real ZodError from a schema + data that we know will fail. */
function buildError(schema: z.ZodType, data: unknown): z.ZodError {
  const result = schema.safeParse(data);
  if (result.success) throw new Error("Expected schema to fail");
  return result.error;
}

/**
 * A simple t() mock that returns `[key]` so we can assert the i18n key was
 * resolved without needing the full i18n setup.
 */
const mockT: TFn = (key) => `[${key}]`;

const testSchema = z.object({
  email: z.string().min(1, "required").email("invalid_email"),
  password: z.string().min(1, "required"),
});

// ─────────────────────────────────────────────────────────────────────────────
// mapZodErrors
// ─────────────────────────────────────────────────────────────────────────────

describe("mapZodErrors", () => {
  it("maps issues to per-field errors using t()", () => {
    const error = buildError(testSchema, { email: "", password: "" });
    const result = mapZodErrors({ error, t: mockT });

    expect(result.email).toBe("[common.required]");
    expect(result.password).toBe("[common.required]");
  });

  it("keeps only the first issue per field", () => {
    // email: "" triggers "required" but not "invalid_email"
    // If we supply a non-empty but invalid email we get only "invalid_email"
    const error = buildError(testSchema, { email: "bad", password: "ok" });
    const result = mapZodErrors({ error, t: mockT });

    expect(result.email).toBe("[admin.validationInvalidEmail]");
    expect(result.password).toBeUndefined();
  });

  it("falls back to raw message when t is omitted", () => {
    const error = buildError(testSchema, { email: "", password: "ok" });
    const result = mapZodErrors({ error });

    // Without t(), raw Zod message string is returned
    expect(result.email).toBe("required");
  });

  it("falls back to raw message for unknown message codes", () => {
    const customSchema = z.object({
      foo: z.string().min(3, "custom_unknown_code"),
    });
    const error = buildError(customSchema, { foo: "ab" });
    const result = mapZodErrors({ error, t: mockT });

    // Not in DEFAULT_MESSAGE_MAP → raw message
    expect(result.foo).toBe("custom_unknown_code");
  });

  it("uses custom messageMap overrides", () => {
    const error = buildError(testSchema, { email: "", password: "ok" });
    const result = mapZodErrors({
      error,
      t: mockT,
      messageMap: { required: "myApp.fieldRequired" },
    });

    expect(result.email).toBe("[myApp.fieldRequired]");
  });

  it("calls t() with the resolved i18n key", () => {
    const tSpy = vi.fn<Parameters<TFn>, ReturnType<TFn>>(
      (key) => `translated:${key}`,
    );
    const error = buildError(testSchema, { email: "", password: "ok" });
    mapZodErrors({ error, t: tSpy });

    expect(tSpy).toHaveBeenCalledWith("common.required");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateForm
// ─────────────────────────────────────────────────────────────────────────────

describe("validateForm", () => {
  it("returns success with parsed data on valid input", () => {
    const result = validateForm({
      schema: testSchema,
      data: { email: "alice@test.com", password: "s3cret" },
      t: mockT,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        email: "alice@test.com",
        password: "s3cret",
      });
      expect(result.fieldErrors).toBeUndefined();
    }
  });

  it("returns fieldErrors on invalid input", () => {
    const result = validateForm({
      schema: testSchema,
      data: { email: "", password: "" },
      t: mockT,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors.email).toBe("[common.required]");
      expect(result.fieldErrors.password).toBe("[common.required]");
      expect(result.data).toBeUndefined();
    }
  });

  it("works without t (raw messages)", () => {
    const result = validateForm({
      schema: testSchema,
      data: { email: "bad", password: "ok" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors.email).toBe("invalid_email");
    }
  });
});
