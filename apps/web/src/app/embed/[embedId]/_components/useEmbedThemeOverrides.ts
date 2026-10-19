"use client";

import { useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";

import {
  deriveHostVars,
  HOST_VAR_NAMES,
  type PlatformColors,
} from "./embed-host-vars";
import type { EmbedThemeOverrides } from "./embed-theme";

const HEX_RE = /^[0-9a-fA-F]{6}$/;

// ── Param → CSS var mapping ─────────────────────────────────────────────────

type ThemeOverrides = EmbedThemeOverrides;

function readParam(params: URLSearchParams, key: string): string | null {
  const v = params.get(key);
  if (v && HEX_RE.test(v)) return v;
  return null;
}

/**
 * Reads optional `brandColor`, `bg`, `fontColor`, `accentColor` query
 * parameters (6-char hex, no `#`) and sets corresponding `--hf-*` CSS custom
 * properties on `<html>`. embed-theme.ts reads each `--hf-*` BEFORE the
 * platform token, so an override wins over the platform theme; an unset knob
 * leaves the platform value showing.
 *
 * Runs once on mount — embed URL params never change within a session.
 * Returns the resolved overrides for programmatic use.
 */
export function useEmbedThemeOverrides(): ThemeOverrides {
  const searchParams = useSearchParams();

  const overrides = useMemo((): ThemeOverrides => {
    return {
      brandColor: readParam(searchParams, "brandColor"),
      bg: readParam(searchParams, "bg"),
      fontColor: readParam(searchParams, "fontColor"),
      accentColor: readParam(searchParams, "accentColor"),
    };
  }, [searchParams]);

  useEffect(() => {
    const root = document.documentElement;
    // The live platform accent (Stub + the active preset), which the link
    // colour starts from when the host set no brand. `ActiveThemeInjector`
    // mirrors the theme onto <body> as inline vars, and re-mirrors when the
    // preset loads or changes, so watch that and re-derive.
    const readPlatform = (): PlatformColors => ({
      accent: getComputedStyle(document.body).getPropertyValue("--accent").trim(),
    });
    let lastAccent: string | null | undefined;
    const apply = () => {
      const platform = readPlatform();
      if (platform.accent === lastAccent) return;
      lastAccent = platform.accent;
      // Every colour decision (labels on host fills, the ground that host
      // text sits on, muted text, links) lives in embed-host-vars.ts, where
      // it is tested.
      for (const [name, value] of Object.entries(
        deriveHostVars(overrides, platform),
      )) {
        root.style.setProperty(name, value);
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    return () => {
      observer.disconnect();
      for (const name of HOST_VAR_NAMES) root.style.removeProperty(name);
    };
  }, [overrides]);

  return overrides;
}
