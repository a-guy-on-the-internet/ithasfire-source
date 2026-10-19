import type { ReactNode } from "react";
import { BORDER, MUTED } from "./tokens";
import { PageContainer } from "./page-layout";
import { SectionTitle } from "./typography";

// ─────────────────────────────────────────────────────────────────────────────
// LegalPage — wrapper for Privacy / Terms / Cookie pages
// ─────────────────────────────────────────────────────────────────────────────

export function LegalPage({
  title,
  updatedAt,
  children,
}: {
  title: string;
  updatedAt: string;
  children: ReactNode;
}) {
  return (
    <PageContainer maxWidth={768} gap={32} padding="32px 0">
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          paddingBottom: 24,
          borderBottom: `2px solid ${BORDER}`,
        }}
      >
        <span className="swiss-overline">Legal</span>
        <h1 className="swiss-display-md" style={{ color: "var(--foreground)" }}>
          {title}
        </h1>
        <p
          style={{ fontSize: 14, color: MUTED }}
        >{`Last updated: ${updatedAt}`}</p>
      </section>
      {children}
    </PageContainer>
  );
}

export function LegalSection({
  id,
  title,
  children,
}: {
  /** Anchor target, e.g. `id="sms"` makes `/terms#sms` land on the section. */
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      style={{
        // Keeps an anchored section clear of the sticky header.
        scrollMarginTop: 80,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        // Swiss structural rule: top-edge between legal sections
        borderTop: `1px solid ${BORDER}`,
        paddingTop: 20,
      }}
    >
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  );
}

export function LegalList({ children }: { children: ReactNode }) {
  return (
    <ul
      style={{
        marginLeft: 24,
        listStyleType: "disc",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {children}
    </ul>
  );
}
