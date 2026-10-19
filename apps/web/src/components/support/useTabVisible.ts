"use client";

import { useEffect, useState } from "react";

/**
 * `true` while the tab is foregrounded (document not hidden).
 *
 * Used to pause support polling when the user backgrounds the tab so we never
 * hold an instance warm for nothing (NFR-001 / scale-to-zero discipline).
 */
export function useTabVisible(): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);

  return visible;
}
