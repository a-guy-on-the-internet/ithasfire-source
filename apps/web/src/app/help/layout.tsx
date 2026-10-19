import type { ReactNode } from "react";

export default function HelpLayout({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        margin: "0 auto",
        maxWidth: 1200,
        padding: "32px 24px 80px",
      }}
    >
      {children}
    </div>
  );
}
