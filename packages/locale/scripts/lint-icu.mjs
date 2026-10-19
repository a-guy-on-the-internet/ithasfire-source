#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parse } from "@formatjs/icu-messageformat-parser";

const root = path.resolve(
  path.dirname(fileURLToPath(new URL(import.meta.url))),
  "../messages"
);

const walkFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(fullPath);
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        return [fullPath];
      }
      return [];
    })
  );
  return files.flat();
};

const collectMessages = (node, prefix = []) => {
  if (typeof node === "string") {
    return [[prefix.join("."), node]];
  }

  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) =>
      collectMessages(value, [...prefix, key])
    );
  }

  return [];
};

const main = async () => {
  const messageFiles = await walkFiles(root);
  const errors = [];

  for (const filePath of messageFiles) {
    const fileContents = await readFile(filePath, "utf8");
    let json;

    try {
      json = JSON.parse(fileContents);
    } catch (error) {
      errors.push({
        filePath,
        key: "<file>",
        message: "Invalid JSON",
        error,
      });
      continue;
    }

    for (const [key, message] of collectMessages(json)) {
      if (typeof message !== "string") continue;

      try {
        parse(message, { requiresOtherClause: false });
      } catch (error) {
        errors.push({ filePath, key, message, error });
      }
    }
  }

  if (errors.length > 0) {
    for (const { filePath, key, error } of errors) {
      console.error(`Invalid ICU message in ${filePath} at key ${key}: ${error.message}`);
    }
    process.exitCode = 1;
    return;
  }

  if (!process.env.CI) {
    console.log(`Validated ${messageFiles.length} message file(s) without ICU errors.`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
