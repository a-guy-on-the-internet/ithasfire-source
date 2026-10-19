"use client";

import type { ReactNode } from "react";
import { ArrowRight, Circle, AlertCircle, CheckCircle2 } from "lucide-react";
import { ACCENT } from "@/lib/design-tokens";
import { BORDER, MUTED, FG, ERROR_RED } from "../_shared/tokens";
import type { FormData, ScreenDef, ScreenStatus } from "../_shared/types";
import { getScreenStatus } from "../_shared/types";

// ─────────────────────────────────────────────────────────────────────────────
// Review screen (20) — summary with status icons, jump-to-edit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the review screen. Needs access to the full SCREENS array so it can
 * iterate and render each screen's status. We accept `allScreens` as a
 * parameter to avoid a circular dependency (screens → index → screens).
 */
export function buildReviewScreen(allScreens: ScreenDef[]): ScreenDef {
  function getStatusSummary(d: FormData) {
    let answered = 0;
    let total = 0;
    let requiredMissing = 0;
    for (const s of allScreens) {
      if (s.phase === "bridge" || s.phase === "review") continue;
      total++;
      const status = getScreenStatus(s.id, d);
      if (status === "complete") answered++;
      if (status === "required-empty") requiredMissing++;
    }
    return { answered, total, requiredMissing };
  }

  return {
    id: "review",
    phase: "review",
    question: "Review your answers",
    helper:
      "Tap any item to jump back and edit it. When you're happy, hit submit.",
    render: (d, _onChange, _error, jumpTo) => {
      const { answered, total, requiredMissing } = getStatusSummary(d);

      const STATUS_ICON: Record<ScreenStatus, ReactNode> = {
        complete: <CheckCircle2 size={16} color="var(--success)" />,
        empty: <Circle size={16} color={MUTED} />,
        "required-empty": <AlertCircle size={16} color={ERROR_RED} />,
      };

      const PHASE_LABELS: Record<string, string> = {
        core: "CORE",
        optional: "OPTIONAL",
        connect: "CONNECT",
      };

      let lastPhase = "";

      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {/* Summary bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 0 16px",
              borderBottom: `1px solid ${BORDER}`,
              marginBottom: 8,
            }}
          >
            <span
              style={{
                fontWeight: 800,
                fontSize: 28,
                fontFamily: "var(--th-font-body, 'Inter', sans-serif)",
                color: answered === total ? "var(--success)" : ACCENT,
                lineHeight: 1,
              }}
            >
              {answered}/{total}
            </span>
            <span style={{ fontSize: 13, color: MUTED, fontWeight: 500 }}>
              {requiredMissing > 0
                ? `${requiredMissing} required ${requiredMissing === 1 ? "field" : "fields"} remaining`
                : answered === total
                  ? "All questions answered — nice work"
                  : "answered"}
            </span>
          </div>

          {/* Question list */}
          {allScreens.map((s, idx) => {
            if (s.phase === "bridge" || s.phase === "review") return null;
            const status = getScreenStatus(s.id, d);
            const showPhaseLabel = s.phase !== lastPhase;
            if (showPhaseLabel) lastPhase = s.phase;

            return (
              <div key={s.id}>
                {showPhaseLabel && (
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      color: s.phase === "core" ? ACCENT : MUTED,
                      padding: "14px 0 6px",
                      borderBottom: `1px solid ${BORDER}`,
                    }}
                  >
                    {PHASE_LABELS[s.phase] ?? s.phase.toUpperCase()}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => jumpTo?.(idx)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    padding: "10px 4px",
                    background: "none",
                    border: "none",
                    borderBottom: `1px solid ${BORDER}`,
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 150ms ease-out",
                  }}
                  onMouseEnter={(e) => {
                    // Ink tint — a hover wash on the cream stub surface.
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "rgba(33,28,22,0.04)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "none";
                  }}
                  aria-label={`Edit: ${s.question}. Status: ${status === "complete" ? "answered" : status === "required-empty" ? "required, not answered" : "not answered"}`}
                >
                  <span style={{ flexShrink: 0 }}>{STATUS_ICON[status]}</span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 13,
                      fontWeight: status === "complete" ? 500 : 400,
                      color:
                        status === "complete"
                          ? FG
                          : status === "required-empty"
                            ? ERROR_RED
                            : MUTED,
                      lineHeight: 1.4,
                    }}
                  >
                    {s.question}
                  </span>
                  <ArrowRight
                    size={14}
                    color={MUTED}
                    style={{ flexShrink: 0, opacity: 0.5 }}
                  />
                </button>
              </div>
            );
          })}
        </div>
      );
    },
  };
}
