"use client";

import type { CSSProperties } from "react";
import { useTranslations } from "@th/ui";

const LINK_STYLE: CSSProperties = {
  textDecoration: "underline",
  color: "inherit",
};

/**
 * "Terms · Privacy" links that sit at the end of every SMS opt-in disclosure.
 * Carriers reviewing our registered number look for both links next to the
 * opt-in control, so each SMS consent point renders this beside its copy.
 * They open in a new tab so a half-filled form is not lost.
 */
export function SmsLegalLinks() {
  const t = useTranslations();
  return (
    <span>
      <a
        href="/terms#sms"
        target="_blank"
        rel="noopener noreferrer"
        style={LINK_STYLE}
      >
        {String(t("common.smsTermsLink"))}
      </a>
      {" · "}
      <a
        href="/privacy"
        target="_blank"
        rel="noopener noreferrer"
        style={LINK_STYLE}
      >
        {String(t("common.smsPrivacyLink"))}
      </a>
    </span>
  );
}
