#!/usr/bin/env node
/**
 * Generate Apple Sign In Client Secret (JWT)
 * 
 * Apple's client secret is a JWT signed with your private key.
 * It expires after max 6 months - you'll need to regenerate it periodically.
 * 
 * Usage:
 *   node scripts/generate-apple-client-secret.js
 * 
 * Required environment variables (or edit the constants below):
 *   APPLE_TEAM_ID      - Your Apple Developer Team ID (10 chars, e.g., "FJG7F43395")
 *   APPLE_KEY_ID       - The Key ID from your .p8 file (e.g., "8948D3M65T")
 *   APPLE_CLIENT_ID    - Your Services ID (e.g., "com.example.app.service")
 *   APPLE_PRIVATE_KEY  - Contents of your .p8 file (with newlines as \n)
 *   
 * Or provide the .p8 file path:
 *   APPLE_PRIVATE_KEY_PATH - Path to your AuthKey_XXXXX.p8 file
 */

const crypto = require("crypto");
const fs = require("fs");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration - edit these or set via environment variables
// ─────────────────────────────────────────────────────────────────────────────
const TEAM_ID = process.env.APPLE_TEAM_ID || "FJG7F43395";
const KEY_ID = process.env.APPLE_KEY_ID || "8948D3M65T";
const CLIENT_ID = process.env.APPLE_CLIENT_ID || "com.ithasfire.service";
const PRIVATE_KEY_PATH = process.env.APPLE_PRIVATE_KEY_PATH || "secrets/AuthKey_8948D3M65T.p8";

// Max expiration is 6 months (180 days)
const EXPIRATION_DAYS = 180;

// ─────────────────────────────────────────────────────────────────────────────

function base64UrlEncode(data) {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateClientSecret() {
  // Get private key
  let privateKey = process.env.APPLE_PRIVATE_KEY;
  
  if (!privateKey && PRIVATE_KEY_PATH) {
    if (!fs.existsSync(PRIVATE_KEY_PATH)) {
      console.error(`❌ Private key file not found: ${PRIVATE_KEY_PATH}`);
      process.exit(1);
    }
    privateKey = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
  }
  
  if (!privateKey) {
    console.error("❌ No private key provided.");
    console.error("   Set APPLE_PRIVATE_KEY or APPLE_PRIVATE_KEY_PATH environment variable.");
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + (EXPIRATION_DAYS * 24 * 60 * 60);

  // JWT Header
  const header = {
    alg: "ES256",
    kid: KEY_ID,
    typ: "JWT",
  };

  // JWT Payload
  const payload = {
    iss: TEAM_ID,
    iat: now,
    exp: exp,
    aud: "https://appleid.apple.com",
    sub: CLIENT_ID,
  };

  // Create JWT
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Sign with ES256 (ECDSA using P-256 and SHA-256)
  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  sign.end();

  const signature = sign.sign(privateKey);
  
  // Convert DER signature to raw format (r || s)
  // DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
  const rLength = signature[3];
  const rStart = 4;
  const rEnd = rStart + rLength;
  const sLength = signature[rEnd + 1];
  const sStart = rEnd + 2;
  
  let r = signature.slice(rStart, rEnd);
  let s = signature.slice(sStart, sStart + sLength);
  
  // Remove leading zeros if present (DER uses them for positive numbers)
  if (r[0] === 0 && r.length > 32) r = r.slice(1);
  if (s[0] === 0 && s.length > 32) s = s.slice(1);
  
  // Pad to 32 bytes if needed
  if (r.length < 32) r = Buffer.concat([Buffer.alloc(32 - r.length), r]);
  if (s.length < 32) s = Buffer.concat([Buffer.alloc(32 - s.length), s]);
  
  const rawSignature = Buffer.concat([r, s]);
  const signatureB64 = base64UrlEncode(rawSignature);

  return `${signingInput}.${signatureB64}`;
}

// ─────────────────────────────────────────────────────────────────────────────

console.log("🍎 Apple Sign In - Client Secret Generator\n");
console.log(`   Team ID:    ${TEAM_ID}`);
console.log(`   Key ID:     ${KEY_ID}`);
console.log(`   Client ID:  ${CLIENT_ID}`);
console.log(`   Expires in: ${EXPIRATION_DAYS} days\n`);

try {
  const clientSecret = generateClientSecret();
  
  const expDate = new Date(Date.now() + EXPIRATION_DAYS * 24 * 60 * 60 * 1000);
  
  console.log("✅ Client Secret generated successfully!\n");
  console.log("─".repeat(70));
  console.log(clientSecret);
  console.log("─".repeat(70));
  console.log(`\n⚠️  This secret expires on: ${expDate.toISOString().split("T")[0]}`);
  console.log("   Set a reminder to regenerate it before then!\n");
  console.log("Add to your .env.local:\n");
  console.log(`APPLE_CLIENT_ID=${CLIENT_ID}`);
  console.log(`APPLE_CLIENT_SECRET=${clientSecret}`);
  console.log(`APPLE_APP_BUNDLE_IDENTIFIER=com.ithasfire.app`);
} catch (err) {
  console.error("❌ Failed to generate client secret:", err.message);
  process.exit(1);
}
