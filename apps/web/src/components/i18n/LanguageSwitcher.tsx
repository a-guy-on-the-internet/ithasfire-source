"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, Check } from "lucide-react";
import { XStack, YStack, styled, useMedia } from "tamagui";
import { Text, useLocale, useTranslations } from "@th/ui";

import {
  SUPPORTED_LOCALES,
  LOCALE_LABELS,
  useSetAppLocale,
  type AppLocale,
} from "@/i18n";

// ── Styled primitives ────────────────────────────────────────────────────

const TriggerButton = styled(XStack, {
  name: "LangSwitcherTrigger",
  alignItems: "center",
  gap: "$2",
  paddingHorizontal: "$3",
  paddingVertical: "$2",
  cursor: "pointer",
  // Maps the nav's ghost Button atom (Theme toggle / Saves / Notifications):
  // transparent, borderless, square, with the ghost hover/press fills — so the
  // language control reads as the same family, not a bordered pill beside them.
  borderWidth: 0,
  borderRadius: 0,
  backgroundColor: "transparent",
  hoverStyle: {
    backgroundColor: "$surfaceRaised",
  },
  pressStyle: {
    backgroundColor: "$accentSoft",
  },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineColor: "$accent",
    outlineOffset: 2,
  },
});

const Dropdown = styled(YStack, {
  name: "LangSwitcherDropdown",
  position: "absolute",
  top: "100%",
  right: 0,
  marginTop: 4,
  minWidth: 140,
  borderWidth: 1,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  zIndex: 999,
  overflow: "hidden",
});

const OptionItem = styled(XStack, {
  name: "LangSwitcherOption",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "$2",
  paddingHorizontal: "$3",
  paddingVertical: "$3",
  cursor: "pointer",
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
  },
  focusVisibleStyle: {
    backgroundColor: "$surfaceMuted",
    outlineWidth: 2,
    outlineColor: "$accent",
    outlineOffset: -2,
  },
});

// ── Native picker (mobile web) ──────────────────────────────────────────

/**
 * On small screens a native <select> triggers the OS-level picker sheet
 * (iOS spinner / Android dialog). The <select> is visually hidden and
 * overlaid on top of a styled trigger so the look stays consistent while
 * the interaction is fully native. The choice applies live through
 * `useSetAppLocale()`; no page reload. On a page with language twins
 * (home, category, about, contact) that setter goes to the chosen language's
 * page instead, so the URL always says the language (FR-004).
 */
const NativeLanguageSwitcher = ({
  currentLocale,
  label,
  iconOnly = false,
}: {
  currentLocale: AppLocale;
  label: string;
  /** Hide the locale label and render the globe icon only (saves horizontal space on cramped mobile bars). */
  iconOnly?: boolean;
}) => {
  const setAppLocale = useSetAppLocale();
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value as AppLocale;
      if (next === currentLocale) return;
      setAppLocale(next);
    },
    [currentLocale, setAppLocale],
  );

  return (
    <div style={{ position: "relative" }}>
      <TriggerButton aria-hidden pointerEvents="none">
        <Globe size={18} strokeWidth={2.25} color="var(--color, #211C16)" />
        {!iconOnly && (
          <Text
            fontSize={11}
            weight="bold"
            letterSpacing={1.5}
            textTransform="uppercase"
          >
            {LOCALE_LABELS[currentLocale] ?? currentLocale}
          </Text>
        )}
      </TriggerButton>

      {/* Native select stretched over the styled trigger */}
      <select
        value={currentLocale}
        onChange={handleChange}
        aria-label={label}
        data-testid="language-switcher"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: 0,
          cursor: "pointer",
          // iOS Safari zooms the page on focus of any control under 16px,
          // even at opacity 0.
          fontSize: 16,
          // Ensure the native element is on top
          zIndex: 1,
        }}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </option>
        ))}
      </select>
    </div>
  );
};

// ── Custom dropdown (desktop web) ────────────────────────────────────────

/**
 * Full custom accessible language switcher — matches the dark Swiss design
 * system. Uses a button + positioned listbox pattern with keyboard
 * navigation (Arrow keys, Enter, Escape). The choice applies live through
 * `useSetAppLocale()`; no page reload. On a page with language twins that
 * setter goes to the chosen language's page instead (FR-004).
 */
const CustomLanguageSwitcher = ({
  currentLocale,
  label,
}: {
  currentLocale: AppLocale;
  label: string;
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

  const setAppLocale = useSetAppLocale();
  const handleSelect = useCallback(
    (locale: AppLocale) => {
      setOpen(false);
      if (locale === currentLocale) return;
      setAppLocale(locale);
    },
    [currentLocale, setAppLocale],
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape; arrow-key navigation within the listbox
  const handleTriggerKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => optionRefs.current[0]?.focus());
    }
  }, []);

  const handleOptionKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        containerRef.current
          ?.querySelector<HTMLElement>("[role='button']")
          ?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = (index + 1) % SUPPORTED_LOCALES.length;
        optionRefs.current[next]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev =
          (index - 1 + SUPPORTED_LOCALES.length) % SUPPORTED_LOCALES.length;
        optionRefs.current[prev]?.focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleSelect(SUPPORTED_LOCALES[index]);
      }
    },
    [handleSelect],
  );

  // Focus the active option when dropdown opens
  useEffect(() => {
    if (!open) return;
    const activeIndex = SUPPORTED_LOCALES.indexOf(currentLocale);
    if (activeIndex >= 0) {
      requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
    }
  }, [open, currentLocale]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <TriggerButton
        role="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        data-testid="language-switcher"
        tabIndex={0}
        onPress={() => setOpen((prev) => !prev)}
        {...({ onKeyDown: handleTriggerKeyDown } as any)}
      >
        <Globe size={18} strokeWidth={2.25} color="var(--color, #211C16)" />
        {/* Match the nav Button atom's label grammar (11px/700/+1.5/uppercase)
            so the trigger doesn't read as a different control family. */}
        <Text
          fontSize={11}
          weight="bold"
          letterSpacing={1.5}
          textTransform="uppercase"
        >
          {LOCALE_LABELS[currentLocale] ?? currentLocale}
        </Text>
      </TriggerButton>

      {open && (
        <Dropdown {...({ role: "listbox" } as any)} aria-label={label}>
          {SUPPORTED_LOCALES.map((locale, index) => {
            const isActive = locale === currentLocale;
            return (
              <OptionItem
                key={locale}
                ref={(el: HTMLDivElement | null) => {
                  optionRefs.current[index] = el;
                }}
                {...({ role: "option" } as any)}
                aria-selected={isActive}
                tabIndex={0}
                onPress={() => handleSelect(locale)}
                backgroundColor={isActive ? "$surfaceMuted" : undefined}
                {...({
                  onKeyDown: (e: React.KeyboardEvent) =>
                    handleOptionKeyDown(e, index),
                } as any)}
              >
                <Text weight={isActive ? "bold" : "regular"} fontSize={13}>
                  {LOCALE_LABELS[locale]}
                </Text>
                {isActive && <Check size={14} color="var(--accent)" />}
              </OptionItem>
            );
          })}
        </Dropdown>
      )}
    </div>
  );
};

// ── Exported component ───────────────────────────────────────────────────

/**
 * On desktop: custom styled dropdown matching the design system.
 * On mobile web (≤ $sm): native <select> so iOS/Android surface their
 * built-in picker sheet (the iOS spinner, Android dialog).
 */
export const LanguageSwitcher = ({
  compact = false,
}: {
  /**
   * When true, the mobile (native-picker) trigger collapses to a globe icon
   * only — no locale label. Use on cramped bars (e.g. the admin navbar, which
   * also carries a hamburger, brand, bell and account avatar) so the trailing
   * controls fit at 360–390px. Desktop is unaffected.
   */
  compact?: boolean;
} = {}) => {
  const currentLocale = useLocale() as AppLocale;
  const t = useTranslations();
  const media = useMedia();

  const label = String(
    t("common.switchLanguage", {
      language: LOCALE_LABELS[currentLocale] ?? currentLocale,
    }),
  );

  // $sm breakpoint — touch devices get the native picker
  if (media.sm) {
    return (
      <NativeLanguageSwitcher
        currentLocale={currentLocale}
        label={label}
        iconOnly={compact}
      />
    );
  }

  return <CustomLanguageSwitcher currentLocale={currentLocale} label={label} />;
};
