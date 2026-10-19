import type { ReactNode } from "react";
import { Lightbulb, AlertTriangle, ArrowRight } from "lucide-react";
import { ACCENT, STRUCTURAL } from "@/lib/design-tokens";

type CalloutKind = "tip" | "warning" | "action";

const STYLES: Record<
  CalloutKind,
  { icon: typeof Lightbulb; color: string; label: string }
> = {
  tip: { icon: Lightbulb, color: STRUCTURAL, label: "Tip" },
  warning: { icon: AlertTriangle, color: ACCENT, label: "Heads up" },
  action: { icon: ArrowRight, color: ACCENT, label: "Next step" },
};

export function Callout({
  kind,
  children,
}: {
  kind: CalloutKind;
  children: ReactNode;
}) {
  const { icon: Icon, color, label } = STYLES[kind];
  return (
    <aside
      data-callout-rendered={kind}
      style={{
        display: "flex",
        gap: 16,
        padding: "20px 24px",
        margin: "24px 0",
        borderLeft: `3px solid ${color}`,
        background: "rgba(33,28,22,0.05)",
      }}
    >
      <div style={{ flexShrink: 0, paddingTop: 2 }}>
        <Icon size={20} style={{ color }} />
      </div>
      <div
        style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color,
          }}
        >
          {label}
        </span>
        <div
          style={{
            fontSize: 15,
            lineHeight: 1.6,
            color: "var(--color, #211C16)",
          }}
        >
          {children}
        </div>
      </div>
    </aside>
  );
}
