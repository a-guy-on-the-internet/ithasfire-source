"use client";

import { highlight } from "sugar-high";
import { Button } from "@th/ui";
import { Check, Copy } from "lucide-react";

/**
 * Dark, syntax-highlighted embed-snippet block with a floating copy button.
 *
 * Extracted verbatim from `EmbedsView`'s `EmbedCard` so the org embeds page
 * and the place booking-button section (booking-request-embed-button FR-009)
 * render byte-identical snippet chrome instead of forking it.
 *
 * The hex palette is deliberate: this is a code-editor surface (always dark,
 * regardless of app theme), matching the sugar-high token colors — not app
 * content, so theme tokens don't apply here.
 */
export function EmbedCodeBlock({
  code,
  isCopied,
  onCopy,
  copyLabel,
}: {
  code: string;
  isCopied: boolean;
  onCopy: () => void;
  copyLabel: string;
}) {
  return (
    <div
      style={
        {
          position: "relative",
          overflow: "hidden",
          backgroundColor: "#1e1e2e",
          borderRadius: 0,
          "--sh-class": "#e5c07b",
          "--sh-identifier": "#abb2bf",
          "--sh-keyword": "#c678dd",
          "--sh-string": "#98c379",
          "--sh-property": "#d19a66",
          "--sh-entity": "#61afef",
          "--sh-jsxliterals": "#e06c75",
          "--sh-sign": "#abb2bf",
          "--sh-comment": "#5c6370",
        } as React.CSSProperties
      }
    >
      <div style={{ overflowX: "auto", padding: 16 }}>
        <pre
          style={{
            margin: 0,
            fontFamily:
              'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
            fontSize: "12.5px",
            lineHeight: 1.7,
            whiteSpace: "pre",
            color: "#abb2bf",
          }}
          dangerouslySetInnerHTML={{ __html: highlight(code) }}
        />
      </div>
      <Button
        size="$2"
        variant="ghost"
        onPress={onCopy}
        aria-label={copyLabel}
        icon
        style={
          {
            position: "absolute",
            right: 8,
            top: 8,
            backgroundColor: "rgba(255,255,255,0.08)",
            color: "#abb2bf",
          } as React.CSSProperties
        }
      >
        {isCopied ? <Check size={14} /> : <Copy size={14} />}
      </Button>
    </div>
  );
}
