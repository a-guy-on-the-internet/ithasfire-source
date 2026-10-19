/**
 * `t()` returns the key verbatim on a miss, so a typo'd or missing key would
 * put "common.notificationsInboxTab" on screen. These resolve every label the
 * hooks hand the notifications panel against the REAL catalogs.
 */
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "@th/ui";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import {
  useAlertsSidebarI18n,
  useNotificationInboxI18n,
} from "../useAlertsSidebarI18n";

function wrapperFor(locale: string, messages: typeof enMessages) {
  return ({ children }: { children: ReactNode }) => (
    <TranslationProvider locale={locale} messages={messages}>
      {children}
    </TranslationProvider>
  );
}

/** Every string a label set resolves to, functions called with a subject. */
function resolved(labels: Record<string, unknown>): [string, string][] {
  return Object.entries(labels).map(([key, value]) => [
    key,
    typeof value === "function"
      ? String((value as (s: string) => string)("Pago"))
      : String(value),
  ]);
}

const isRawKey = (value: string) => /^(common|account)\./.test(value);

describe("notification panel labels against the real es catalog", () => {
  const wrapper = wrapperFor("es", esMessages);

  it("resolves every sidebar label and the bell name", () => {
    const { result } = renderHook(() => useAlertsSidebarI18n(), { wrapper });
    for (const [key, value] of resolved({ ...result.current.labels })) {
      expect(value, key).not.toBe("");
      expect(isRawKey(value), `${key} = ${value}`).toBe(false);
    }
    expect(result.current.formatButtonLabel(3)).toBe(
      "Abrir notificaciones, 3 sin leer",
    );
  });

  it("resolves every inbox and row label, and hands Intl the locale", () => {
    const { result } = renderHook(() => useNotificationInboxI18n(), {
      wrapper,
    });
    for (const [key, value] of [
      ...resolved({ ...result.current.labels }),
      ...resolved({ ...result.current.itemLabels }),
    ]) {
      expect(value, key).not.toBe("");
      expect(isRawKey(value), `${key} = ${value}`).toBe(false);
    }
    expect(result.current.itemLabels.dismissNamed("Pago")).toBe(
      "Descartar: Pago",
    );
    expect(result.current.locale).toBe("es");
  });
});

describe("English timestamps", () => {
  it("hands no locale for English, so the hand-rolled strings stay", () => {
    for (const locale of ["en", "en-US"]) {
      const { result } = renderHook(() => useNotificationInboxI18n(), {
        wrapper: wrapperFor(locale, enMessages),
      });
      expect(result.current.locale, locale).toBeUndefined();
    }
  });
});
