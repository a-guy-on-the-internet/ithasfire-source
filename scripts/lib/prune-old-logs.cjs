const { existsSync, readdirSync, rmSync, statSync, unlinkSync } = require("node:fs");
const { resolve, extname } = require("node:path");

const HOURS_48_IN_MS = 1000 * 60 * 60 * 48;

const defaultFilter = (entryName, fullPath) => {
  const extension = extname(entryName).toLowerCase();
  if (extension === ".log") {
    return true;
  }

  return false;
};

const pruneOldLogs = (targetDir, options = {}) => {
  const {
    maxAgeMs = HOURS_48_IN_MS,
    shouldDelete = defaultFilter,
    removeEmptyDirectories = true,
    onDelete,
  } = options;

  if (!targetDir || !existsSync(targetDir)) {
    return { removed: 0 };
  }

  const threshold = Date.now() - maxAgeMs;
  let removed = 0;

  const pruneRecursive = (currentDir) => {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry.name);

      if (entry.isDirectory()) {
        pruneRecursive(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!shouldDelete(entry.name, fullPath)) {
        continue;
      }

      const stats = statSync(fullPath);
      if (stats.mtimeMs >= threshold) {
        continue;
      }

      try {
        unlinkSync(fullPath);
        removed += 1;
        if (typeof onDelete === "function") {
          onDelete(fullPath);
        }
      } catch (error) {
        console.warn(`Failed to delete old log ${fullPath}:`, error.message);
      }
    }

    if (removeEmptyDirectories && currentDir !== targetDir) {
      const remainingEntries = readdirSync(currentDir);
      if (remainingEntries.length === 0) {
        try {
          rmSync(currentDir);
        } catch (error) {
          console.warn(`Failed to remove empty log directory ${currentDir}:`, error.message);
        }
      }
    }
  };

  pruneRecursive(targetDir);
  return { removed };
};

module.exports = { pruneOldLogs };
