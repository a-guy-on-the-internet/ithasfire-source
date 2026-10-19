import type { Metadata } from "next";
import { QRCodeSVG } from "qrcode.react";

import {
  LegalPage,
  LegalSection,
} from "@/components/layout/PagePrimitives";

// The /qr-test page exists solely so Apple App Store reviewers can validate
// the Ithas Fire Scanner app end-to-end during App Store review. It renders a
// large QR code for a deterministic ticket code that's seeded into the
// `apple-review` organization (see apps/api/src/scripts/seed/seed-data.ts).
// QRCodeSVG renders pure SVG so this stays a server component — keeps the
// route lean and lets us export `metadata` with robots:noindex directly.

export const metadata: Metadata = {
  title: "Scanner QR Test",
  description:
    "App Store reviewer page — test QR for the Ithas Fire Scanner app.",
  robots: { index: false, follow: false },
};

const TICKET_CODE = "APPLE-REVIEW-001";

export default function QrTestPage() {
  return (
    <LegalPage title="Scanner QR Test" updatedAt="May 2026">
      <LegalSection title="What is this page?">
        <p>
          App Store Review — Test Ticket QR. This page exists for Apple App
          Store reviewers to validate the Ithas Fire Scanner app. Open the
          Scanner app, sign in with the reviewer account, and point the camera
          at the QR code below.
        </p>
      </LegalSection>

      <LegalSection title="Test ticket QR">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 16,
            padding: 24,
            // True-white quiet zone — required for the scanner to lock on.
            // This page exists to BE scanned by App Store reviewers; do not
            // route it to a theme token.
            backgroundColor: "white",
            border: "2px solid #111",
          }}
        >
          <QRCodeSVG value={TICKET_CODE} size={320} level="M" />
          <code
            style={{
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 16,
              letterSpacing: 1,
            }}
          >
            {TICKET_CODE}
          </code>
        </div>
      </LegalSection>
    </LegalPage>
  );
}
