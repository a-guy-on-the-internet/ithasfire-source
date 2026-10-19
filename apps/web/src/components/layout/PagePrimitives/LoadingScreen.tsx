"use client";

import { Spinner } from "@th/ui";
import { LABEL, MUTED } from "./tokens";

// LoadingScreen lives in its own client-component file so that `feedback.tsx`
// (which exports the server-safe StatusScreen used by static legal/not-found
// pages) does not transitively pull `@th/ui` into server-component bundles.

export function LoadingScreen({ message }: { message?: string }) {
  return (
    <main
      style={{
        display: "flex",
        minHeight: "60vh",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        padding: "0 24px",
        textAlign: "center",
      }}
    >
      <Spinner
        size="lg"
        indicatorColor={LABEL}
        screenReaderLabel={message ? `Loading: ${message}` : "Loading"}
      />
      {message && (
        <p style={{ maxWidth: 384, fontSize: 15, color: MUTED }}>{message}</p>
      )}
    </main>
  );
}
