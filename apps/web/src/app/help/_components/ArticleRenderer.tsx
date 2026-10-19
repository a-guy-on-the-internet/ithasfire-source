import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";

import { remarkCallouts } from "./remarkCallouts";
import { rehypeHeadingIds } from "../_lib/heading-slug";
import { Callout } from "./Callout";
import { ACCENT } from "@/lib/design-tokens";

/**
 * Anchored headings must clear the sticky navbar (68px, pinned on desktop;
 * it hides on mobile scroll-down, where the extra room is harmless).
 */
const HEADING_SCROLL_MARGIN = 88;

const components: Components = {
  h2: ({ children, id }) => (
    <h2
      id={id}
      style={{
        scrollMarginTop: HEADING_SCROLL_MARGIN,
        fontSize: 22,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "-0.01em",
        marginTop: 40,
        marginBottom: 16,
      }}
    >
      {children}
    </h2>
  ),
  h3: ({ children, id }) => (
    <h3
      id={id}
      style={{
        scrollMarginTop: HEADING_SCROLL_MARGIN,
        fontSize: 17,
        fontWeight: 700,
        marginTop: 28,
        marginBottom: 12,
      }}
    >
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p
      style={{
        fontSize: 16,
        lineHeight: 1.7,
        color: "var(--color, #211C16)",
        margin: "12px 0",
      }}
    >
      {children}
    </p>
  ),
  ul: ({ children }) => (
    <ul
      style={{
        fontSize: 16,
        lineHeight: 1.7,
        color: "var(--color, #211C16)",
        margin: "12px 0 12px 24px",
        listStyleType: "disc",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol
      style={{
        fontSize: 16,
        lineHeight: 1.7,
        color: "var(--color, #211C16)",
        margin: "12px 0 12px 24px",
        listStyleType: "decimal",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {children}
    </ol>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      style={{
        color: ACCENT,
        textDecoration: "underline",
        textUnderlineOffset: 3,
      }}
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code
      style={{
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 14,
        padding: "2px 6px",
        background: "var(--surfaceMuted, #EFE7D6)",
        // Strict Swiss: zero radius, even on inline code chips.
        borderRadius: 0,
      }}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre
      style={{
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 14,
        padding: 16,
        background: "var(--surfaceMuted, #EFE7D6)",
        borderLeft: `2px solid ${ACCENT}`,
        overflow: "auto",
        margin: "16px 0",
      }}
    >
      {children}
    </pre>
  ),
  strong: ({ children }) => (
    <strong style={{ color: "var(--color, #211C16)", fontWeight: 700 }}>
      {children}
    </strong>
  ),
  // Callouts: our remarkCallouts plugin wraps blocks with
  // <div data-callout="tip|warning|action">. Intercept that div.
  div: (props) => {
    const { children, ...rest } = props as { children?: ReactNode } & Record<
      string,
      unknown
    >;
    const kind = rest["data-callout"] as string | undefined;
    if (kind === "tip" || kind === "warning" || kind === "action") {
      return <Callout kind={kind}>{children}</Callout>;
    }
    return <div>{children}</div>;
  },
};

export function ArticleRenderer({ content }: { content: string }) {
  return (
    <div style={{ maxWidth: 720 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCallouts]}
        rehypePlugins={[rehypeRaw, rehypeHeadingIds]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
