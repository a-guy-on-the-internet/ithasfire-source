"use client";

import { type ReactNode, type RefObject } from "react";
import { styled, XStack } from "tamagui";
import { Text, Button, NextLinkAnchor, useTranslations } from "@th/ui";
import { ArrowLeft, Plus } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EditorHeaderProps {
  title: string;
  backHref?: string;
  /** Slot rendered next to the title (e.g. verification badge). */
  headerBadge?: ReactNode;
  /** Controls rendered in the action group, before "Add Block". */
  headerActions?: ReactNode;
  /** Slug shown as the `/p/{slug}` caption. The "View page" control lives in
   *  PageEditorView's toolbar, so the header carries no second link. */
  slug?: string | null;
  isAddingBlock?: boolean;
  /** When false, hide the Add Block button (e.g. on Profile/Theme tabs). */
  showAddBlock?: boolean;
  /** Controlled open state for the Add Block palette (optional). */
  addBlockOpen?: boolean;
  onAddBlockOpenChange?: (open: boolean) => void;
  /**
   * Attached to the STICKY wrapper so the caller can measure its rendered
   * height and stack its own sticky chrome underneath. Do not wrap this
   * component in a short div to measure it instead — a sticky element inside a
   * wrapper only as tall as itself has no travel and silently stops sticking.
   */
  stickyRef?: RefObject<HTMLDivElement | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styled
// ─────────────────────────────────────────────────────────────────────────────

// Wraps so a narrow viewport moves the badge and slug under the title instead
// of squeezing the title to one letter per line.
const HeaderLeft = styled(XStack, {
  columnGap: "$4",
  rowGap: "$2",
  alignItems: "center",
  flexWrap: "wrap",
  flex: 1,
  minWidth: 0,
});

const HeaderActions = styled(XStack, {
  gap: "$2",
  alignItems: "center",
  flexWrap: "wrap",
  justifyContent: "flex-end",
});

const Header = styled(XStack, {
  justifyContent: "space-between",
  alignItems: "center",
  paddingVertical: "$3",
  paddingHorizontal: "$5",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColorStrong",
  flexWrap: "wrap",
  gap: "$4",
  minHeight: 64,
  backgroundColor: "$surface",
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function EditorHeader({
  title,
  backHref,
  headerBadge,
  headerActions,
  slug,
  isAddingBlock = false,
  showAddBlock = true,
  addBlockOpen,
  onAddBlockOpenChange,
  stickyRef,
}: EditorHeaderProps) {
  const t = useTranslations();
  const paletteOpen = addBlockOpen ?? false;
  const setPaletteOpen = (open: boolean) => {
    onAddBlockOpenChange?.(open);
  };

  return (
    // Sticky wrapper is a plain div so RNW doesn't strip `position: sticky`.
    <div
      ref={stickyRef}
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        backgroundColor: "var(--surface, #FDFAF3)",
      }}
    >
      <Header>
        <HeaderLeft>
          {backHref ? (
            <NextLinkAnchor href={backHref}>
              <XStack
                padding={6}
                borderRadius={0}
                cursor="pointer"
                hoverStyle={{ backgroundColor: "$surfaceMuted" }}
              >
                <ArrowLeft size={20} />
                <span
                  style={{
                    position: "absolute",
                    width: 1,
                    height: 1,
                    padding: 0,
                    margin: -1,
                    overflow: "hidden",
                    clip: "rect(0, 0, 0, 0)",
                    whiteSpace: "nowrap",
                    border: 0,
                  }}
                >
                  {String(t("admin.peBack") ?? "Back")}
                </span>
              </XStack>
            </NextLinkAnchor>
          ) : null}
          <Text
            variant="h3"
            weight="bold"
            // `break-word`, not `anywhere`: it keeps the title's min-content at
            // its longest word, so the row wraps before the title breaks words.
            style={{ overflowWrap: "break-word" as const, minWidth: 0 }}
          >
            {title}
          </Text>
          {headerBadge}
          {slug ? (
            <Text
              variant="caption"
              color="$colorMuted"
              style={{ overflowWrap: "anywhere" as const, minWidth: 0 }}
            >
              /p/{slug}
            </Text>
          ) : null}
        </HeaderLeft>

        <HeaderActions>
          {headerActions}
          {showAddBlock && (
            <Button
              variant={paletteOpen ? "secondary" : "primary"}
              size="$2"
              // A 44px tap target at the $2 type size.
              minHeight={44}
              onPress={() => setPaletteOpen(!paletteOpen)}
              aria-expanded={paletteOpen}
              aria-controls="entity-page-block-palette"
              aria-pressed={paletteOpen}
              disabled={isAddingBlock && !paletteOpen}
            >
              <Plus size={14} />
              {String(t("admin.peAddBlock") ?? "Add Block")}
            </Button>
          )}
        </HeaderActions>
      </Header>
    </div>
  );
}

EditorHeader.displayName = "EditorHeader";
