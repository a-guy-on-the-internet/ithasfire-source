import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";

import { createJoseVolunteerScanTokenAdapter } from "./jose-volunteer-scan-token-adapter";

const SECRET = "test-secret-must-be-at-least-32-bytes-long-padding";
const HUMAN_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "00000000-0000-4000-8000-000000000002";
const JTI = "00000000-0000-4000-8000-0000000000ff";

describe("createJoseVolunteerScanTokenAdapter", () => {
  it("signs and verifies a token round-trip", async () => {
    const adapter = createJoseVolunteerScanTokenAdapter({ secret: SECRET });

    const { token, expiresAt } = await adapter.sign({
      humanId: HUMAN_ID,
      eventId: EVENT_ID,
      kind: "short",
      ttlSeconds: 3600,
      jti: JTI,
    });

    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const payload = await adapter.verify(token);
    expect(payload.humanId).toBe(HUMAN_ID);
    expect(payload.eventId).toBe(EVENT_ID);
    expect(payload.kind).toBe("short");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    // Round-trips so a recovered QR can be joined to its audit row.
    expect(payload.jti).toBe(JTI);
  });

  it("still verifies a legacy token minted before `jti` existed", async () => {
    // Outstanding organizer print tokens can run to event end + 24h (capped at
    // 90 days), so tokens without a `jti` are in circulation with live
    // expiries. Hard-failing them here would void every one of them the moment
    // this deploys — the exact platform-wide revocation the port warns about.
    const adapter = createJoseVolunteerScanTokenAdapter({ secret: SECRET });
    const key = new TextEncoder().encode(SECRET);
    const legacy = await new SignJWT({
      humanId: HUMAN_ID,
      eventId: EVENT_ID,
      kind: "print",
    })
      .setProtectedHeader({ alg: "HS256", kid: "v1" })
      .setIssuer("ithasfire:volunteer-scan")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);

    const payload = await adapter.verify(legacy);
    expect(payload.humanId).toBe(HUMAN_ID);
    expect(payload.kind).toBe("print");
    expect(payload.jti).toBeUndefined();
  });

  it("mints a distinct jti per call so two same-second tokens differ", async () => {
    const adapter = createJoseVolunteerScanTokenAdapter({ secret: SECRET });
    const args = {
      humanId: HUMAN_ID,
      eventId: EVENT_ID,
      kind: "short" as const,
      ttlSeconds: 3600,
    };

    const a = await adapter.sign({ ...args, jti: JTI });
    const b = await adapter.sign({
      ...args,
      jti: "00000000-0000-4000-8000-0000000000ee",
    });

    expect(a.token).not.toBe(b.token);
    expect((await adapter.verify(a.token)).jti).not.toBe(
      (await adapter.verify(b.token)).jti,
    );
  });

  it("rejects an expired token with `volunteer_qr_expired`", async () => {
    const adapter = createJoseVolunteerScanTokenAdapter({ secret: SECRET });

    const { token } = await adapter.sign({
      humanId: HUMAN_ID,
      eventId: EVENT_ID,
      kind: "short",
      ttlSeconds: -10,
      jti: JTI,
    });

    await expect(adapter.verify(token)).rejects.toMatchObject({
      code: "volunteer_qr_expired",
    });
  });

  it("rejects a token signed with a different secret with `volunteer_qr_invalid`", async () => {
    const a = createJoseVolunteerScanTokenAdapter({ secret: SECRET });
    const b = createJoseVolunteerScanTokenAdapter({
      secret: "another-secret-padding-padding-padding",
    });

    const { token } = await a.sign({
      humanId: HUMAN_ID,
      eventId: EVENT_ID,
      kind: "short",
      ttlSeconds: 3600,
      jti: JTI,
    });

    await expect(b.verify(token)).rejects.toMatchObject({
      code: "volunteer_qr_invalid",
    });
  });

  it("rejects a malformed token with `volunteer_qr_invalid`", async () => {
    const adapter = createJoseVolunteerScanTokenAdapter({ secret: SECRET });
    await expect(adapter.verify("not.a.jwt")).rejects.toMatchObject({
      code: "volunteer_qr_invalid",
    });
  });

  it("rejects a token signed with a foreign issuer with `volunteer_qr_invalid`", async () => {
    const adapter = createJoseVolunteerScanTokenAdapter({ secret: SECRET });
    const key = new TextEncoder().encode(SECRET);
    const foreign = await new SignJWT({
      humanId: HUMAN_ID,
      eventId: EVENT_ID,
      kind: "short",
    })
      .setProtectedHeader({ alg: "HS256", kid: "v1" })
      .setIssuer("not:ithasfire:volunteer-scan")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);

    await expect(adapter.verify(foreign)).rejects.toMatchObject({
      code: "volunteer_qr_invalid",
    });
  });
});
