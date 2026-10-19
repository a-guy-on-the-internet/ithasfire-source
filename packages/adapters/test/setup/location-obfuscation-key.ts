import { configureLocationObfuscation } from "@th/core/lib/location/obfuscation-key";

/**
 * Same as packages/core/test/setup: production roots configure the
 * obfuscation key at boot, so adapter tests do too (fixed test-only secret).
 */
configureLocationObfuscation({ secret: "test-only-location-obfuscation-secret" });
