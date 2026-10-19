import type { ReactNode } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Stripe — decorative horizontal colour-stripe section break
// ─────────────────────────────────────────────────────────────────────────────

export function Stripe({ full = false }: { full?: boolean }) {
  return <hr className={full ? "swiss-stripe--full" : "swiss-stripe"} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// AutoGrid — responsive CSS-grid wrapper
// ─────────────────────────────────────────────────────────────────────────────

export function AutoGrid({
  children,
  minWidth = 280,
  gap = 24,
}: {
  children: ReactNode;
  minWidth?: number;
  gap?: number;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap,
        gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}
