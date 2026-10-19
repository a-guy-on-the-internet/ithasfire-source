"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Generic fade-in / slide-up transition wrapper for all admin pages.
 *
 * Applied once inside `AdminShell` so every admin route gets the animation
 * automatically — no per-page boilerplate needed.
 */
export function AdminPageTransition({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      style={{
        width: "100%",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 350ms ease-out, transform 350ms ease-out",
      }}
    >
      {children}
    </div>
  );
}
