#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT_DIR = resolve(new URL("../messages", import.meta.url).pathname);
const CHECK_MODE = process.argv.includes("--check");

const sortObject = (value) => {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .reduce((acc, key) => {
        acc[key] = sortObject(value[key]);
        return acc;
      }, {});
  }
  return value;
};

const ensureTrailingNewline = (content) => (content.endsWith("\n") ? content : `${content}\n`);

const main = async () => {
  const entries = await readdir(ROOT_DIR, { withFileTypes: true });
  let hasDiff = false;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

    const filePath = join(ROOT_DIR, entry.name);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const sorted = ensureTrailingNewline(JSON.stringify(sortObject(parsed), null, 2));

    if (sorted !== raw) {
      if (CHECK_MODE) {
        hasDiff = true;
      } else {
        await writeFile(filePath, sorted, "utf8");
      }
    }
  }

  if (CHECK_MODE && hasDiff) {
    console.error("Message catalogs are not sorted. Run `pnpm -F @th/locale format:messages` to fix.");
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
