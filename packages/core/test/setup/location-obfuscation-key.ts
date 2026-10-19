import { configureLocationObfuscation } from "../../src/lib/location/obfuscation-key";

/**
 * Every production process that serves public locations configures the
 * obfuscation key at boot (apps/api dep.ts, apps/jobs container.ts). Tests run
 * the same way: a fixed, test-only secret, so a circle is a circle. Tests of
 * the keyless fail-closed path reset it explicitly
 * (`resetLocationObfuscationForTests`).
 */
configureLocationObfuscation({ secret: "test-only-location-obfuscation-secret" });
