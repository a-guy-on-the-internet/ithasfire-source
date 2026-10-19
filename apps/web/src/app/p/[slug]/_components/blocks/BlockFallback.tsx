"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import styles from "./block-primitives.module.css";

type Props = {
  block: PageBlockRecord;
};

/**
 * Rendered when a block kind has no registered component.
 * Hidden in production; shows a yellow warning box in development so devs
 * notice the missing renderer immediately.
 */
export function BlockFallback({ block }: Props) {
  if (process.env.NODE_ENV !== "development") {
    return null;
  }

  return (
    <div className={styles.devFallback}>
      <strong>Unknown block kind:</strong> &ldquo;{block.kind}&rdquo;
      <br />
      <span className={styles.muted}>
        Register a component in <code>block-registry.ts</code> to render this
        block.
      </span>
    </div>
  );
}
