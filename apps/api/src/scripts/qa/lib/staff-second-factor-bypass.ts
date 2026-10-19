/**
 * Dev-only staff second-factor bypass for QA seed scripts that call
 * staff-gated use cases (`requirePlatformStaff`) as the seeded admin, who has
 * no enrolled passkey/TOTP. Returns the flag to pass to
 * `createDbAuthZAdapter({ repos, staffSecondFactorBypass })`, the same wiring
 * as apps/api/src/lib/dep.ts. The production rule is untouched.
 *
 * `dotenv/config` loads only apps/api/.env; the flag lives in
 * apps/api/.env.local (the root .env.local is the fallback), so read it from
 * there when the process env lacks it. The DECISION stays with
 * `resolveStaffSecondFactorBypass` (Cloud Run and non-local NODE_ENV are
 * still refused).
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { resolveStaffSecondFactorBypass } from "@th/trpc/dev-staff-2fa-bypass";

export function requireStaffSecondFactorBypass(): true {
  let flag = process.env.DEV_BYPASS_STAFF_2FA;
  let source = "process env";
  if (flag === undefined) {
    const candidates = [
      fileURLToPath(new URL("../../../../.env.local", import.meta.url)),
      fileURLToPath(new URL("../../../../../../.env.local", import.meta.url)),
    ];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const value = dotenv.parse(fs.readFileSync(file)).DEV_BYPASS_STAFF_2FA;
      if (value !== undefined) {
        flag = value;
        source = file;
        break;
      }
    }
  }
  const enabled = resolveStaffSecondFactorBypass({
    ...process.env,
    DEV_BYPASS_STAFF_2FA: flag,
  });
  if (!enabled) {
    throw new Error(
      `Staff second-factor bypass is OFF (DEV_BYPASS_STAFF_2FA=${flag ?? "<unset>"} from ${source}, ` +
        `NODE_ENV=${process.env.NODE_ENV ?? "<unset>"}).\n` +
        `The seeded admin has no enrolled second factor, so every staff use case refuses with SECOND_FACTOR_REQUIRED.\n` +
        `Set DEV_BYPASS_STAFF_2FA=true in apps/api/.env.local (or prefix the command with it), ` +
        `with NODE_ENV unset or "development", and re-run.`,
    );
  }
  return true;
}
