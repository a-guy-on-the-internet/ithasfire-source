#!/usr/bin/env node
/**
 * Batch-fix inline record literals in test files.
 *
 * Adds missing required fields to inline EventRecord, OrderRecord,
 * PlaceRecord, TicketRecord, and SavedLocationRecord object literals.
 *
 * Run from repo root:
 *   node scripts/dev/fix-test-record-literals.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Get all files with TS errors
const raw = execSync(
  `cd packages/core && npx tsc --noEmit 2>&1 || true`,
  { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
);

const errorLines = raw.split("\n").filter(l => l.includes("error TS"));

// Parse file:line:col from each error
const fileErrors = new Map();
for (const line of errorLines) {
  const m = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.*)/);
  if (!m) continue;
  const [, file, lineNo, col, code, msg] = m;
  const absFile = `packages/core/${file}`;
  if (!fileErrors.has(absFile)) fileErrors.set(absFile, []);
  fileErrors.get(absFile).push({ line: +lineNo, col: +col, code, msg });
}

let totalFixes = 0;

for (const [file, errors] of fileErrors) {
  let content;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    continue;
  }

  let lines = content.split("\n");
  let modified = false;

  // ── Fix 1: EventRecord missing `currency` ──────────────────────────────
  // Look for lines with `placeLayoutId:` that are NOT followed by `currency:`
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (/placeLayoutId\s*:/.test(line) && !/currency\s*:/.test(lines[i + 1] || "")) {
      // Check if this is inside an EventRecord-like literal
      // (has typical event fields nearby)
      const contextBefore = lines.slice(Math.max(0, i - 15), i).join("\n");
      if (/title\s*:/.test(contextBefore) && /status\s*:/.test(contextBefore)) {
        const indent = line.match(/^(\s*)/)[1];
        lines.splice(i + 1, 0, `${indent}currency: null,`);
        modified = true;
        totalFixes++;
        i++; // skip inserted line
      }
    }
  }

  // ── Fix 2: OrderRecord missing fields ──────────────────────────────────
  // Look for `parentOrderId:` followed by `items:` without shortId/billing
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (/parentOrderId\s*:/.test(line)) {
      const contextBefore = lines.slice(Math.max(0, i - 10), i).join("\n");
      // Make sure this is an OrderRecord (has buyerHumanId or feesPlatformCents)
      if (!/buyerHumanId|feesPlatformCents/.test(contextBefore)) continue;

      // Check if shortId is already present nearby
      const contextAfter = lines.slice(i, Math.min(lines.length, i + 5)).join("\n");
      const contextAll = lines.slice(Math.max(0, i - 15), Math.min(lines.length, i + 5)).join("\n");
      if (/shortId\s*:/.test(contextAll)) continue;

      const indent = line.match(/^(\s*)/)[1];
      // Find where to insert — before parentOrderId or after it
      // We need: shortId, taxAmountCents, billingAddress*, stripeTaxCalculationId
      // Insert after the line with `source:` if it exists before parentOrderId
      const insertions = [
        `${indent}shortId: null,`,
        `${indent}taxAmountCents: 0,`,
      ];

      // Check if billingAddressLine1 already exists
      if (!/billingAddressLine1/.test(contextAll)) {
        insertions.push(
          `${indent}billingAddressLine1: null,`,
          `${indent}billingAddressLine2: null,`,
          `${indent}billingCity: null,`,
          `${indent}billingState: null,`,
          `${indent}billingPostalCode: null,`,
          `${indent}billingCountry: null,`,
          `${indent}stripeTaxCalculationId: null,`,
        );
      }

      // Find the line with `id:` for the order and insert shortId right after
      // Actually, insert all missing fields just before `items:` or after `parentOrderId:`
      let insertIdx = i + 1;
      // If items: is the next line, insert before items
      if (/items\s*:/.test(lines[i + 1] || "")) {
        insertIdx = i + 1;
      }

      lines.splice(insertIdx, 0, ...insertions);
      modified = true;
      totalFixes += insertions.length;
      i += insertions.length;
    }
  }

  // ── Fix 3: PlaceRecord missing `slug` ──────────────────────────────────
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    // PlaceRecord pattern: has `name:` and `formattedAddress:` nearby
    if (/formattedAddress\s*:/.test(line)) {
      const contextBefore = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
      const contextAfter = lines.slice(i, Math.min(lines.length, i + 15)).join("\n");
      if (/slug\s*:/.test(contextBefore + contextAfter)) continue;
      // Only if it looks like a PlaceRecord (has addressLine1 nearby)
      if (!/addressLine1/.test(contextAfter)) continue;

      const indent = line.match(/^(\s*)/)[1];
      // Insert `slug: "test-place",` after name: line
      // Find the `name:` line before formattedAddress
      let nameIdx = -1;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (/^\s*name\s*:/.test(lines[j])) {
          nameIdx = j;
          break;
        }
      }
      if (nameIdx >= 0) {
        const nameIndent = lines[nameIdx].match(/^(\s*)/)[1];
        lines.splice(nameIdx + 1, 0, `${nameIndent}slug: "test-place",`);
        modified = true;
        totalFixes++;
        i++; // skip inserted line
      }
    }
  }

  // ── Fix 4: TicketRecord missing `orderItemId` ─────────────────────────
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (/orderId\s*:/.test(line) && !/orderItemId/.test(line)) {
      const contextBefore = lines.slice(Math.max(0, i - 8), i).join("\n");
      const contextAfter = lines.slice(i + 1, Math.min(lines.length, i + 5)).join("\n");
      // Check it's a TicketRecord: has `code:` and `issuedAt:` nearby
      if (!/code\s*:/.test(contextAfter) && !/code\s*:/.test(contextBefore)) continue;
      if (/orderItemId\s*:/.test(contextAfter) || /orderItemId\s*:/.test(contextBefore)) continue;

      const indent = line.match(/^(\s*)/)[1];
      lines.splice(i + 1, 0, `${indent}orderItemId: null,`);
      modified = true;
      totalFixes++;
      i++;
    }
  }

  // ── Fix 5: SavedLocationRecord missing new fields ─────────────────────
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (/ownerType\s*:\s*"HUMAN"/.test(line) || /ownerType\s*:\s*"ORGANIZATION"/.test(line)) {
      const contextAfter = lines.slice(i, Math.min(lines.length, i + 8)).join("\n");
      const contextBefore = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
      // Check it's a SavedLocationRecord: has usageCount nearby but NOT name:
      if (!/usageCount\s*:/.test(contextAfter)) continue;
      if (/name\s*:/.test(contextBefore)) continue; // already has expanded fields

      const indent = line.match(/^(\s*)/)[1];
      // Find the `id:` line
      let idIdx = -1;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (/^\s*id\s*:/.test(lines[j])) {
          idIdx = j;
          break;
        }
      }
      if (idIdx >= 0) {
        const idIndent = lines[idIdx].match(/^(\s*)/)[1];
        const newFields = [
          `${idIndent}name: "Test Location",`,
          `${idIndent}address: "123 Test St, City, ST 12345",`,
          `${idIndent}countryCode: "US",`,
          `${idIndent}region: "ST",`,
          `${idIndent}locality: "City",`,
          `${idIndent}postalCode: "12345",`,
          `${idIndent}lat: null,`,
          `${idIndent}lng: null,`,
        ];
        lines.splice(idIdx + 1, 0, ...newFields);
        modified = true;
        totalFixes += newFields.length;
        i += newFields.length;

        // Also add tax fields after usageCount if missing
        for (let k = i; k < Math.min(lines.length, i + 10); k++) {
          if (/usageCount\s*:/.test(lines[k])) {
            const ucIndent = lines[k].match(/^(\s*)/)[1];
            const taxContextAfter = lines.slice(k + 1, Math.min(lines.length, k + 5)).join("\n");
            if (!/admissionTaxRateBps/.test(taxContextAfter)) {
              const taxFields = [
                `${ucIndent}admissionTaxRateBps: null,`,
                `${ucIndent}taxRateFetchedAt: null,`,
                `${ucIndent}taxRateSource: null,`,
              ];
              lines.splice(k + 1, 0, ...taxFields);
              modified = true;
              totalFixes += taxFields.length;
            }
            break;
          }
        }
      }
    }
  }

  if (modified) {
    writeFileSync(file, lines.join("\n"), "utf-8");
    console.log(`✓ ${file}`);
  }
}

console.log(`\nDone. Applied ${totalFixes} fixes.`);
