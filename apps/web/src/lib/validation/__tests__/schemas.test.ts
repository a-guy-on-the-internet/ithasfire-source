import { describe, expect, it } from "vitest";

import {
  emailFieldSchema,
  phoneFieldSchema,
  contactPairSchema,
  loginSchema,
  signUpSchema,
  contactFormSchema,
  createOrgSchema,
} from "../schemas";

// ─────────────────────────────────────────────────────────────────────────────
// emailFieldSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("emailFieldSchema", () => {
  it("accepts a valid email", () => {
    const result = emailFieldSchema.safeParse("alice@example.com");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("alice@example.com");
  });

  it("trims whitespace", () => {
    const result = emailFieldSchema.safeParse("  bob@test.io  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("bob@test.io");
  });

  it('returns "" for an empty string', () => {
    const result = emailFieldSchema.safeParse("");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("");
  });

  it('returns "" for whitespace-only input', () => {
    const result = emailFieldSchema.safeParse("   ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("");
  });

  it("rejects an invalid email", () => {
    const result = emailFieldSchema.safeParse("not-an-email");
    expect(result.success).toBe(false);
  });

  it("rejects an email exceeding 320 chars", () => {
    const longLocal = "a".repeat(310);
    const result = emailFieldSchema.safeParse(`${longLocal}@example.com`);
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phoneFieldSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("phoneFieldSchema", () => {
  it("accepts a valid phone number", () => {
    const result = phoneFieldSchema.safeParse("+15551234567");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("+15551234567");
  });

  it("trims whitespace", () => {
    const result = phoneFieldSchema.safeParse("  12345  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("12345");
  });

  it('returns "" for an empty string', () => {
    const result = phoneFieldSchema.safeParse("");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("");
  });

  it("rejects a phone shorter than 5 characters", () => {
    const result = phoneFieldSchema.safeParse("1234");
    expect(result.success).toBe(false);
  });

  it("rejects a phone longer than 50 characters", () => {
    const result = phoneFieldSchema.safeParse("1".repeat(51));
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// contactPairSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("contactPairSchema", () => {
  it("accepts email only", () => {
    const result = contactPairSchema.safeParse({
      contactEmail: "a@b.com",
      contactPhone: "",
    });
    expect(result.success).toBe(true);
  });

  it("accepts phone only", () => {
    const result = contactPairSchema.safeParse({
      contactEmail: "",
      contactPhone: "+15551234567",
    });
    expect(result.success).toBe(true);
  });

  it("accepts both", () => {
    const result = contactPairSchema.safeParse({
      contactEmail: "a@b.com",
      contactPhone: "+15551234567",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when both are empty", () => {
    const result = contactPairSchema.safeParse({
      contactEmail: "",
      contactPhone: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("contactEmail");
      expect(fields).toContain("contactPhone");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loginSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("loginSchema", () => {
  it("accepts valid email credentials", () => {
    const result = loginSchema.safeParse({
      identifier: "a@b.com",
      password: "secret",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid username credentials", () => {
    const result = loginSchema.safeParse({
      identifier: "alice",
      password: "secret",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty identifier", () => {
    const result = loginSchema.safeParse({
      identifier: "",
      password: "secret",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path[0]).toBe("identifier");
    }
  });

  it("rejects empty password", () => {
    const result = loginSchema.safeParse({
      identifier: "a@b.com",
      password: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path[0]).toBe("password");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// signUpSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("signUpSchema", () => {
  // Step 1 of sign-up asks for email + password ONLY. Display name and
  // username moved to the profile step (4 of 4); confirm-password was dropped
  // because the reveal toggle makes it redundant.
  const valid = { email: "alice@example.com", password: "supersecret" };

  it("accepts valid data", () => {
    expect(signUpSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an invalid email", () => {
    const result = signUpSchema.safeParse({ ...valid, email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty password", () => {
    const result = signUpSchema.safeParse({ ...valid, password: "" });
    expect(result.success).toBe(false);
  });

  it("trims and still requires the email", () => {
    expect(signUpSchema.safeParse({ ...valid, email: "   " }).success).toBe(false);
  });

  it("strips the fields that no longer belong to step 1 rather than failing on them", () => {
    // A stale caller sending the old five-field shape must not be rejected —
    // the extra keys are simply not part of this step any more.
    const result = signUpSchema.safeParse({
      ...valid,
      displayName: "Alice",
      username: "alice",
      confirmPassword: "supersecret",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(["email", "password"]);
    }
  });
});


describe("contactFormSchema", () => {
  it("accepts valid data", () => {
    const result = contactFormSchema.safeParse({
      name: "Bob",
      email: "bob@test.com",
      message: "Hello!",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = contactFormSchema.safeParse({
      name: "",
      email: "b@b.com",
      message: "hi",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path[0]).toBe("name");
  });

  it("rejects invalid email", () => {
    const result = contactFormSchema.safeParse({
      name: "Bob",
      email: "nope",
      message: "hi",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty message", () => {
    const result = contactFormSchema.safeParse({
      name: "Bob",
      email: "b@b.com",
      message: "  ",
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createOrgSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("createOrgSchema", () => {
  it("accepts a name with 2+ characters", () => {
    const result = createOrgSchema.safeParse({ name: "AB" });
    expect(result.success).toBe(true);
  });

  it("trims before checking length", () => {
    const result = createOrgSchema.safeParse({ name: "  Hi  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Hi");
  });

  it("rejects a name shorter than 2 characters", () => {
    const result = createOrgSchema.safeParse({ name: "A" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("org_name_too_short");
    }
  });

  it("rejects an empty name", () => {
    const result = createOrgSchema.safeParse({ name: " " });
    expect(result.success).toBe(false);
  });
});
