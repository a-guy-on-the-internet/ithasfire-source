"use client";

import { Button, useTranslations } from "@th/ui";
import { RotateCcw } from "lucide-react";

/**
 * Rerun one dead-letter-queue entry.
 *
 * Two different "off" states:
 *
 * - `pending`: this entry's rerun is in flight. A rerun is synchronous and can
 *   take as long as the job (minutes), so the button reads the pending label
 *   and says `aria-busy`. It is `aria-disabled`, NOT `disabled`: the Button's
 *   disabled style is 45% opacity, which would dim the one label that says
 *   work is happening for the whole run (the pattern is documented in the
 *   Button atom). The press is blocked here by passing no handler, and it
 *   keeps its place in the tab order, so focus stays put.
 * - `blocked`: Rerun is off for another reason (another entry in this queue
 *   is being rerun, or this entry already ran). That is an ordinary disabled
 *   button.
 *
 * Stable width: the idle and pending labels differ in length, and by a
 * different amount in each locale ("Rerun" / "Rerunning…", "Reintentar" /
 * "Reintentando…"). Both labels are laid out in one grid cell, so the cell is
 * as wide as the longer one and the row does not move when the label swaps.
 * The copy that is not showing is an invisible sizer: `visibility: hidden`
 * takes it out of the accessibility tree, the tab order and hit testing.
 *
 * `flexShrink: 0` on the wrapper is load-bearing. It is a plain `div` inside
 * the cell's flex row, so it shrinks by default, and a Button's min-content
 * width is its padding and icon only (the label is a shrinkable ellipsis
 * span). Measured in Chrome without it: the wrapper collapsed to 38.9px and
 * the button rendered as a blank accent square.
 */
export function DlqRerunButton({
  pending,
  blocked = false,
  onRerun,
}: {
  pending: boolean;
  blocked?: boolean;
  onRerun: () => void;
}) {
  const t = useTranslations();
  const idleLabel = String(t("admin.jobsDlqRerun"));
  const pendingLabel = String(t("admin.jobsDlqRerunning"));

  return (
    <div style={{ display: "grid", flexShrink: 0 }}>
      <Button
        size="$2"
        aria-hidden
        disabled
        data-testid="dlq-rerun-sizer"
        style={{
          gridArea: "1 / 1",
          visibility: "hidden",
          pointerEvents: "none",
        }}
      >
        <RotateCcw size={14} />
        {pending ? idleLabel : pendingLabel}
      </Button>
      <Button
        size="$2"
        disabled={blocked && !pending}
        aria-busy={pending ? true : undefined}
        aria-disabled={pending ? true : undefined}
        // Measured in Chrome: `aria-disabled` alone still gets the Button's
        // `disabledStyle`, so the pending label faded toward 45% within a
        // few frames. Holding opacity at 1 keeps it legible; the not-allowed
        // cursor from the same style stays.
        disabledStyle={pending ? { opacity: 1 } : undefined}
        onPress={pending || blocked ? undefined : onRerun}
        style={{ gridArea: "1 / 1", width: "100%" }}
      >
        <RotateCcw size={14} aria-hidden />
        {pending ? pendingLabel : idleLabel}
      </Button>
    </div>
  );
}
