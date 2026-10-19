"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ComponentProps,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import {
  useEditor,
  useEditorState,
  EditorContent,
  Extension,
} from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { CharacterCount } from "@tiptap/extensions/character-count";
import Typography from "@tiptap/extension-typography";
import TextAlign from "@tiptap/extension-text-align";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { XStack, YStack, styled } from "tamagui";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Highlighter,
  Link as LinkIcon,
  List,
  ListOrdered,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  Minus,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ImagePlus,
  Music,
  Link2,
  Undo2,
  Redo2,
  RemoveFormatting,
  ExternalLink,
  Unlink,
  Check,
  X,
  Ellipsis,
} from "lucide-react";

import {
  Text,
  Button,
  TextInput,
  Spinner,
  Popover,
  useTranslations,
  forms,
} from "@th/ui";
import type { UploadMode } from "@th/ui";
import type { ProseMirrorDoc } from "@th/schema";
import { PROSE_HEADING_LEVELS } from "@th/schema";
import { parseEmbedUrl } from "@th/core/lib/embeds";
import { ImageBlock, type ImageBlockAttributes } from "./extensions";
import { AudioBlock, type AudioBlockAttributes } from "./extensions";
import { EVENT_IMAGE_UPLOAD_ACCEPT } from "@/lib/images/event-image-upload";
import {
  MediaEmbed,
  PasteMediaEmbed,
  mediaEmbedAttrsFromParsed,
} from "./extensions";
import { MOD_KEY as MOD, SHIFT_KEY as SHIFT } from "@/lib/platform";
import type { AudioUrlMapEntry } from "./prose-utils";
import {
  BUBBLE_MENU_Z_INDEX,
  bubbleMenuOptions,
} from "./bubble-menu-placement";
import { ROVING_ITEM_ATTR, useRovingTabStops } from "./toolbar-roving";
import { HighlightNoCarry } from "./highlight-no-carry";
import { SlashMenu } from "./extensions/SlashMenu";
import { BlockMove } from "./extensions/BlockMove";
import { BlockGutter } from "./extensions/BlockGutter";
import type { InsertMenuItem } from "./extensions/insert-menu-items";

// The description typography the public page uses; the ProseMirror root
// carries its `.event-content-body` class by default (`typographyClassName`).
import "@/components/events/event-body-typography.css";
import "./prose-editor.css";

// ─── Helpers ─────────────────────────────────────────────────────────────────

export type ImageUploadHandler = (
  file: File,
) => Promise<ImageBlockAttributes | null>;
export type AudioUploadHandler = (
  file: File,
) => Promise<AudioBlockAttributes | null>;

// Re-export AudioUrlMapEntry from prose-utils for convenience
export type { AudioUrlMapEntry } from "./prose-utils";

export type ProseEditorProps = {
  /** Initial content as ProseMirror JSON */
  initialContent?: ProseMirrorDoc | null;
  /** Called when content changes with the new ProseMirror JSON */
  onChange?: (content: ProseMirrorDoc) => void;
  /**
   * Called ONCE when the editor instance is created, with the mount-normalized
   * doc (`editor.getJSON()`). TipTap fills defaults (e.g. `attrs.textAlign:
   * null`) and rebuilds the envelope at create time, so this is the doc every
   * subsequent `onChange` is measured against. Consumers that diff edits
   * against a stored/raw doc MUST use this as their baseline rather than the
   * first `onChange` — the first update is NOT guaranteed to fire before the
   * user's first edit (a single-transaction paste can be the first emission),
   * whereas `onCreate` is deterministic.
   */
  onReady?: (content: ProseMirrorDoc) => void;
  /** Placeholder text when editor is empty */
  placeholder?: string;
  /** Whether the editor is disabled */
  disabled?: boolean;
  /**
   * Minimum height for the editor.
   * Set to 0 or "auto" for infinite scroll behavior.
   */
  minHeight?: number | "auto";
  /**
   * Enable image upload functionality.
   * When provided, shows the image upload button in toolbar.
   */
  onImageUpload?: ImageUploadHandler;
  /**
   * Map of imageId to resolved public URL.
   * Used to display images in the editor.
   */
  imageUrlMap?: Record<string, string>;
  /**
   * Show the image button in toolbar even when disabled.
   * When true without onImageUpload, shows a disabled button with tooltip.
   */
  showImageButton?: boolean;
  /**
   * Tooltip text when image button is disabled.
   */
  imageButtonDisabledTooltip?: string;
  /**
   * Whether an image upload is currently in progress.
   * When true, displays a loading overlay at the bottom of the editor.
   */
  isUploading?: boolean;
  /**
   * Enable audio upload functionality.
   * When provided, shows the audio upload button in toolbar.
   */
  onAudioUpload?: AudioUploadHandler;
  /**
   * Map of audioUploadId → resolved URLs and status.
   * Used to display audio players and track transcoding progress.
   */
  audioUrlMap?: Record<string, AudioUrlMapEntry>;
  /**
   * Show the audio button in toolbar even when disabled.
   */
  showAudioButton?: boolean;
  /**
   * Tooltip text when audio button is disabled.
   */
  audioButtonDisabledTooltip?: string;
  /**
   * Whether an audio upload is currently in progress.
   */
  isUploadingAudio?: boolean;
  /**
   * Optional hard limit on the number of characters.
   * When set, a character counter is shown in the footer.
   */
  maxCharacters?: number;
  /**
   * Show a word count in the footer (enabled by default when maxCharacters is set,
   * but can be shown independently).
   */
  showWordCount?: boolean;
  /** Offset for the sticky toolbar when the page has its own sticky header stack. */
  stickyTopOffset?: number;
  /**
   * Class(es) on the ProseMirror root that set the content's typography, so
   * the editor looks like where the text ends up. Defaults to the public
   * event page's (`event-content-body`, event-body-typography.css). The
   * announcement composer passes the email variant, since announcements are
   * sent as email and never show the page's flourishes.
   */
  typographyClassName?: string;
};

const EditorContainer = styled(YStack, {
  width: "100%",
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$background",
  // NOTE: overflow: "hidden" would break position: sticky on ToolbarContainer.
});

// Wraps the toolbar AND any conditional insert bars (image / media-embed)
// so the whole header — including the affordance the user just clicked —
// stays stuck to the top of the viewport while scrolling the editor body.
// Without this only the toolbar stuck and the URL/file-picker inputs would
// scroll away mid-action.
const StickyHeader = styled(YStack, {
  position: "sticky" as unknown as undefined,
  top: 0,
  zIndex: 40,
  backgroundColor: "$backgroundHover",
});

const ToolbarContainer = styled(XStack, {
  paddingHorizontal: "$2",
  paddingVertical: "$1",
  gap: 1,
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
  backgroundColor: "$backgroundHover",
  flexWrap: "wrap",
  alignItems: "center",
  variants: {
    // Narrow editors pack the buttons edge to edge: at 320px the editor is
    // 206px wide, 188px inside the padding, and seven 26px buttons need 182px
    // with no gap but 188px with the 1px one, which wraps on any rounding.
    compact: {
      true: { gap: 0 },
    },
  },
});

/**
 * Below this editor width the toolbar folds its less-used controls into a
 * "More" popover. Measured editor widths in the event builder (10-14):
 * 206px at a 320px viewport, 261 at 375, 286 at 400, 254 at 768 (the builder
 * puts the preview beside it there), then 438 at 1024 and 521 at 1280. 360
 * sits in the gap, so every phone and that tablet layout fold, and every
 * desktop width keeps the full toolbar it had.
 */
export const COMPACT_TOOLBAR_MAX_WIDTH = 360;

const ToolbarButtonStyled = styled(XStack, {
  padding: "$1",
  borderRadius: 0,
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  pressStyle: { opacity: 0.7 },
  hoverStyle: { backgroundColor: "$backgroundFocus" },
  // Focus ring: the system one (3px, accent, ink on an accent fill), from the
  // `.th-pe-btn` rules in prose-editor.css. It used to be a bespoke 2px
  // `$accentHard` ring here, the same colour as a pressed button's fill.
  variants: {
    active: {
      true: {
        backgroundColor: "$accentHard",
      },
    },
    disabled: {
      true: {
        opacity: 0.4,
        cursor: "not-allowed",
      },
    },
  },
});

type ToolbarButtonProps = ComponentProps<typeof ToolbarButtonStyled> & {
  onPress?: () => void;
  disabled?: boolean;
  /**
   * Makes this a toggle button: `aria-pressed` plus the active fill. Leave
   * undefined for plain actions (Undo, Insert rule) and for buttons that open
   * something, which pass `active` and their own `aria-expanded`.
   */
  pressed?: boolean;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
};

/**
 * True inside a roving-tabindex group (the toolbar, the More panel, the
 * selection menu). Buttons there render `tabIndex={-1}` and leave the one
 * tab stop to `useRovingTabStops`; the link popover's buttons stay plain.
 */
const RovingGroupContext = createContext(false);

/**
 * Wraps the styled XStack with the a11y attributes a real `<button>` would
 * have for free: tab-stop, button role, and Enter/Space activation. Tamagui
 * `XStack` renders as a `<div>` so without this the toolbar buttons aren't
 * reachable by keyboard-only users.
 */
const ToolbarButton = ({
  onPress,
  disabled,
  pressed,
  active,
  onKeyDown,
  ...rest
}: ToolbarButtonProps) => {
  const roving = useContext(RovingGroupContext);
  const isActive = pressed ?? active;
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!disabled) onPress?.();
    }
  };
  return (
    <ToolbarButtonStyled
      role="button"
      className="th-pe-btn"
      tabIndex={roving || disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-pressed={pressed}
      data-active={isActive ? "true" : undefined}
      active={isActive}
      onPress={onPress}
      disabled={disabled}
      {...(roving ? { [ROVING_ITEM_ATTR]: "" } : {})}
      {...({ onKeyDown: handleKeyDown } as Record<string, unknown>)}
      {...rest}
    />
  );
};

/** The main toolbar: its ToolbarButtons share one roving tab stop. */
const RovingToolbar = ({
  children,
  ...rest
}: ComponentProps<typeof ToolbarContainer>) => (
  <RovingGroupContext.Provider value={true}>
    <ToolbarContainer {...rest}>{children}</ToolbarContainer>
  </RovingGroupContext.Provider>
);

const ToolbarDivider = styled(YStack, {
  width: 1,
  height: 16,
  backgroundColor: "$borderColor",
  marginHorizontal: 2,
});

const EditorContentWrapper = styled(YStack, {
  padding: "$3",
  // The block gutter (BlockGutter: the "+" and the grip) lives in this
  // padding, so it is wide enough for a 24px control at every width and on
  // every mount, editable or not: the text never shifts when it appears.
  paddingLeft: 28,
  position: "relative",
  // When minHeight is "auto", the editor expands based on content
  variants: {
    autoExpand: {
      true: {
        minHeight: "auto",
      },
    },
  },
});

const BubbleMenuContainer = styled(XStack, {
  padding: "$1",
  gap: "$1",
  backgroundColor: "$background",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColor",
});

/** The selection menu: its ToolbarButtons share one roving tab stop. */
const RovingBubbleMenu = ({
  children,
  ...rest
}: ComponentProps<typeof BubbleMenuContainer>) => (
  <RovingGroupContext.Provider value={true}>
    <BubbleMenuContainer {...rest}>{children}</BubbleMenuContainer>
  </RovingGroupContext.Provider>
);

const FooterBar = styled(XStack, {
  padding: "$2",
  paddingHorizontal: "$3",
  justifyContent: "flex-end",
  alignItems: "center",
  gap: "$2",
  borderTopWidth: 1,
  borderTopColor: "$borderColor",
  backgroundColor: "$backgroundHover",
});

// ─── Inline link-editor popover ──────────────────────────────────────────────

const LinkPopoverContainer = styled(YStack, {
  position: "absolute",
  zIndex: 50,
  padding: "$2",
  backgroundColor: "$background",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColor",
  gap: "$2",
  minWidth: 320,
});

/** Renders a floating popover that lets the user edit or remove a link. */
const LinkPopover = ({
  initialHref,
  onSave,
  onRemove,
  onClose,
  editorView,
}: {
  initialHref: string;
  onSave: (url: string) => void;
  onRemove: () => void;
  onClose: () => void;
  /** When provided, the popover is positioned beneath the current selection. */
  editorView?: import("@tiptap/pm/view").EditorView | null;
}) => {
  const [url, setUrl] = useState(initialHref);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const t = useTranslations();

  useEffect(() => {
    // Auto-focus the input when the popover mounts
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Position the popover beneath the selection
  useEffect(() => {
    if (!editorView || !containerRef.current) return;
    const { from, to } = editorView.state.selection;
    const start = editorView.coordsAtPos(from);
    const end = editorView.coordsAtPos(to);
    const editorRect = editorView.dom
      .closest("[data-testid='prose-editor']")
      ?.getBoundingClientRect();
    if (!editorRect) return;

    const left = Math.min(start.left, end.left) - editorRect.left;
    const top = Math.max(start.bottom, end.bottom) - editorRect.top + 8;
    const el = containerRef.current;
    el.style.left = `${Math.max(0, Math.min(left, editorRect.width - 340))}px`;
    el.style.top = `${top}px`;
  }, [editorView]);

  const handleSave = () => {
    const trimmed = url.trim();
    if (trimmed) onSave(trimmed);
    else onRemove();
  };

  return (
    <LinkPopoverContainer ref={containerRef} data-testid="prose-link-popover">
      <XStack gap="$2" alignItems="center">
        <YStack flex={1}>
          <input
            ref={inputRef}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSave();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="https://..."
            data-testid="prose-link-popover-input"
            style={{
              width: "100%",
              padding: "6px 8px",
              border: "1px solid var(--borderColor, #211C16)",
              borderRadius: 0,
              fontSize: 13,
              fontFamily: "inherit",
            }}
          />
        </YStack>
        <ToolbarButton
          onPress={handleSave}
          aria-label={t("admin.peConfirmLink") as string}
        >
          <Check size={14} />
        </ToolbarButton>
        <ToolbarButton
          onPress={() => {
            if (url.trim())
              window.open(url.trim(), "_blank", "noopener,noreferrer");
          }}
          aria-label={t("admin.peOpenLink") as string}
        >
          <ExternalLink size={14} />
        </ToolbarButton>
        <ToolbarButton
          onPress={onRemove}
          aria-label={t("admin.peRemoveLink") as string}
        >
          <Unlink size={14} />
        </ToolbarButton>
        <ToolbarButton
          onPress={onClose}
          aria-label={t("admin.peCancel") as string}
        >
          <X size={14} />
        </ToolbarButton>
      </XStack>
    </LinkPopoverContainer>
  );
};

// ─── Shortcut label helper ───────────────────────────────────────────────────

/** Build a human-readable shortcut string, e.g. "Bold (⌘B)" */
function tip(label: string, ...keys: string[]) {
  if (keys.length === 0) return label;
  return `${label} (${keys.join("+")})`;
}

/**
 * Wraps a ToolbarButton with a native `title` attribute for a lightweight
 * hover-label.  Using the `<Tooltip>` component here adds wrapper nodes
 * (`TooltipRoot` / `TooltipAnchorFrame`) that disrupt the toolbar flex
 * layout and break sticky positioning.  A plain `title` gives us the hint
 * without any DOM overhead.
 */
const TipBtn = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement;
}) => (
  <div title={label} style={{ display: "contents" }}>
    {children}
  </div>
);

/**
 * One of the controls that render inline on a wide editor and inside the
 * More panel on a narrow one. Described once so both places get the same
 * label, shortcut hint, pressed state and command.
 */
type FoldableTool = {
  id: string;
  label: string;
  /** The hover hint, with the shortcut when there is one. */
  hint: string;
  icon: ReactNode;
  /** Defined for toggles (`aria-pressed`); undefined for one-shot actions. */
  pressed?: boolean;
  run: () => void;
};

// ─── Toolbar state ───────────────────────────────────────────────────────────

/**
 * Everything the toolbars show as on/off or enabled/disabled. Read through
 * `useEditorState`, so the editor re-renders when one of these flips, and a
 * caret moving into bold text updates Bold's `aria-pressed` and fill. Before,
 * the toolbar re-rendered only when a parent did (typing, via onChange), so
 * a selection change alone left the pressed states stale.
 */
export type FormatState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  highlight: boolean;
  link: boolean;
  h1: boolean;
  h2: boolean;
  h3: boolean;
  alignLeft: boolean;
  alignCenter: boolean;
  alignRight: boolean;
  bulletList: boolean;
  orderedList: boolean;
  blockquote: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export function readFormatState(editor: Editor): FormatState {
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    highlight: editor.isActive("highlight"),
    link: editor.isActive("link"),
    h1: editor.isActive("heading", { level: 1 }),
    h2: editor.isActive("heading", { level: 2 }),
    h3: editor.isActive("heading", { level: 3 }),
    alignLeft: editor.isActive({ textAlign: "left" }),
    alignCenter: editor.isActive({ textAlign: "center" }),
    alignRight: editor.isActive({ textAlign: "right" }),
    bulletList: editor.isActive("bulletList"),
    orderedList: editor.isActive("orderedList"),
    blockquote: editor.isActive("blockquote"),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
  };
}

/**
 * The More panel is portalled to <body> by Popover. It has to clear Modal
 * (z 10000) for the announcement composer, where the editor sits in a dialog.
 */
const MORE_PANEL_Z_INDEX = 10001;

/** Farther than this between touch down and up is a swipe, not a tap. */
const TOUCH_TAP_SLOP_PX = 10;
/** A tap's compatibility mousedown arrives within this of its pointerup. */
const TOUCH_TAP_COMPAT_MS = 800;

/**
 * True for a press on the editor body's own padding or empty tail: inside
 * `body` in the real DOM (React also bubbles presses from the portalled
 * menus to it), not on the text (ProseMirror places that caret) and not on
 * the block gutter's "+" or grip (they handle their own presses).
 */
function isPaddingPress(body: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !body.contains(target)) return false;
  if (target.closest(".th-pe-gutter-btn")) return false;
  const editable = body.querySelector(".ProseMirror");
  return !!editable && !editable.contains(target);
}

export const ProseEditor = ({
  initialContent,
  onChange,
  onReady,
  placeholder: placeholderProp,
  disabled = false,
  minHeight = 200,
  onImageUpload,
  imageUrlMap,
  showImageButton = false,
  imageButtonDisabledTooltip: tooltipProp,
  isUploading = false,
  onAudioUpload,
  audioUrlMap,
  showAudioButton = false,
  audioButtonDisabledTooltip: audioTooltipProp,
  isUploadingAudio = false,
  maxCharacters,
  showWordCount = false,
  stickyTopOffset = 0,
  typographyClassName = "event-content-body",
}: ProseEditorProps) => {
  const t = useTranslations();
  const placeholder =
    placeholderProp ?? (t("admin.peDefaultPlaceholder") as string);
  const imageButtonDisabledTooltip =
    tooltipProp ?? (t("admin.peImageDisabledTooltip") as string);
  const audioButtonDisabledTooltip =
    audioTooltipProp ?? (t("admin.peAudioDisabledTooltip") as string);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const isAutoExpand = minHeight === "auto" || minHeight === 0;
  const actualMinHeight = isAutoExpand ? 100 : minHeight;

  // Image insert state — allows switching between file upload and URL paste
  const [imageInsertMode, setImageInsertMode] = useState<UploadMode>("file");
  const [imageUrlInput, setImageUrlInput] = useState("");
  const [showImageInsertBar, setShowImageInsertBar] = useState(false);

  // Media embed insert state — URL is parsed through @th/core before insertion
  const [mediaEmbedUrlInput, setMediaEmbedUrlInput] = useState("");
  const [showMediaEmbedInsertBar, setShowMediaEmbedInsertBar] = useState(false);
  const [mediaEmbedError, setMediaEmbedError] = useState<string | null>(null);
  // Esc closes the media-embed insert bar and returns focus to the toolbar
  // button that opened it. Without this the popover only closes on toolbar
  // click, which is a keyboard-trap for screen-reader users.
  useEffect(() => {
    if (!showMediaEmbedInsertBar) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // Capture-phase listener — also stop bubbling so TipTap's editor view
      // doesn't grab focus on the same Escape (which would race our
      // .focus() call below).
      event.stopPropagation();
      setShowMediaEmbedInsertBar(false);
      setMediaEmbedError(null);
      // Defer the focus call to the next frame so it lands AFTER React has
      // finished unmounting the popover and any focus-trap teardown.
      requestAnimationFrame(() => {
        const btn = document.querySelector<HTMLElement>(
          '[data-testid="prose-media-embed-btn"]',
        );
        btn?.focus();
      });
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [showMediaEmbedInsertBar]);

  // Link popover state
  const [linkPopover, setLinkPopover] = useState<{ href: string } | null>(null);

  const imageEnabled = Boolean(onImageUpload) || showImageButton;
  const audioEnabled = Boolean(onAudioUpload) || showAudioButton;

  // The block insert menu ("/" and the "+"). The plugin reads the items
  // through this ref, so they can carry this render's handlers without the
  // extensions (and the editor) being rebuilt.
  const insertListboxId = useId();
  const insertItemsRef = useRef<readonly InsertMenuItem[]>([]);

  // A press on the editor body's padding puts the caret at the end. On
  // touch it waits for the TAP (pointerup close to where it went down), so
  // a scroll swipe starting beside a block neither moves the caret nor
  // raises the keyboard. Mouse presses go through onMouseDown below.
  const [editorBodyEl, setEditorBodyEl] = useState<HTMLElement | null>(null);
  const editorBodyRef = useCallback((node: unknown) => {
    setEditorBodyEl(node instanceof HTMLElement ? node : null);
  }, []);
  const lastTouchTapAt = useRef(0);

  // ─── Drag-and-drop / paste image handling via ProseMirror plugin ──────────

  /** Extract the first image File from a DataTransfer (drag or paste). */
  const extractImageFile = useCallback(
    (dataTransfer: DataTransfer | null): File | undefined => {
      if (!dataTransfer) return undefined;
      for (const item of Array.from(dataTransfer.files)) {
        if (item.type.startsWith("image/")) return item;
      }
      return undefined;
    },
    [],
  );

  /**
   * ProseMirror plugin that intercepts drop and paste events containing images,
   * delegates to `onImageUpload`, then inserts the resulting imageBlock node.
   */
  const imageDropPastePlugin = useMemo(() => {
    if (!onImageUpload) return null;

    return Extension.create({
      name: "imageDropPaste",
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: new PluginKey("imageDropPaste"),
            props: {
              handleDrop(view, event) {
                const file = extractImageFile(event.dataTransfer);
                if (!file) return false;
                event.preventDefault();
                onImageUpload(file).then((attrs) => {
                  if (!attrs) return;
                  const { state } = view;
                  const pos =
                    view.posAtCoords({
                      left: event.clientX,
                      top: event.clientY,
                    })?.pos ?? state.selection.from;
                  const node = state.schema.nodes.imageBlock?.create(attrs);
                  if (node) {
                    const tr = state.tr.insert(pos, node);
                    view.dispatch(tr);
                  }
                });
                return true;
              },
              handlePaste(view, event) {
                const file = extractImageFile(event.clipboardData);
                if (!file) return false;
                event.preventDefault();
                onImageUpload(file).then((attrs) => {
                  if (!attrs) return;
                  const { state } = view;
                  const node = state.schema.nodes.imageBlock?.create(attrs);
                  if (node) {
                    const tr = state.tr.replaceSelectionWith(node);
                    view.dispatch(tr);
                  }
                });
                return true;
              },
            },
          }),
        ];
      },
    });
  }, [onImageUpload, extractImageFile]);

  // Memoize extensions so TipTap doesn't destroy/recreate the editor on
  // every parent re-render (e.g., from resolveAudio polling or query updates).
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: {
          levels: [...PROSE_HEADING_LEVELS],
        },
        codeBlock: false,
        code: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
          // Strict protocol allowlist — defends against `javascript:` and
          // similar schemes ever landing in a saved doc, even via a buggy
          // upstream client or pasted markdown.
          protocols: ["http", "https", "mailto", "tel"],
          isAllowedUri: (url: string) => /^(https?:|mailto:|tel:)/i.test(url),
          HTMLAttributes: {
            rel: "noopener noreferrer nofollow",
          },
        },
      }),
      Placeholder.configure({
        placeholder: placeholder,
      }),
      Typography,
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      HighlightNoCarry.configure({
        multicolor: false,
      }),
      ...(maxCharacters != null
        ? [CharacterCount.configure({ limit: maxCharacters })]
        : showWordCount
          ? [CharacterCount]
          : []),
      ...(imageEnabled ? [ImageBlock] : []),
      ...(audioEnabled ? [AudioBlock] : []),
      MediaEmbed,
      PasteMediaEmbed,
      ...(imageDropPastePlugin ? [imageDropPastePlugin] : []),
      SlashMenu.configure({
        getItems: () => insertItemsRef.current,
        listboxId: insertListboxId,
      }),
      BlockMove,
    ],
    // Only recreate extensions when these capabilities actually change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      placeholder,
      maxCharacters,
      showWordCount,
      imageEnabled,
      audioEnabled,
      imageDropPastePlugin,
    ],
  );

  // The content's typography, shared with the public event page and the
  // builder's Preview (components/events/event-body-typography.css).
  // Memoised: useEditor compares options by reference on every render and
  // calls setOptions on any change, so a fresh object here meant a
  // setOptions per keystroke.
  const editorProps = useMemo(
    () => ({ attributes: { class: typographyClassName } }),
    [typographyClassName],
  );

  const editor = useEditor({
    extensions,
    content: initialContent ?? {
      type: "doc",
      content: [{ type: "paragraph" }],
    },
    editable: !disabled,
    editorProps,
    onCreate: ({ editor }) => {
      // Fires exactly once, deterministically, with the mount-normalized doc.
      if (onReady) {
        onReady(editor.getJSON() as ProseMirrorDoc);
      }
    },
    onUpdate: ({ editor }) => {
      if (onChange) {
        onChange(editor.getJSON() as ProseMirrorDoc);
      }
    },
    // Prevent SSR hydration mismatch
    immediatelyRender: false,
  });

  const format = useEditorState({
    editor,
    selector: ({ editor: ed }) => (ed ? readFormatState(ed) : null),
  });

  // ─── Narrow toolbar ("More" fold) ─────────────────────────────────────────
  // Measured on the editor's own box, not the viewport: the builder puts the
  // editor beside its preview at 768px, and the announcement composer puts
  // it in a dialog, so the viewport says little about the space it has.
  const [containerEl, setContainerEl] = useState<HTMLElement | null>(null);
  const containerRef = useCallback((node: unknown) => {
    setContainerEl(node instanceof HTMLElement ? node : null);
  }, []);
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(compact);
  // The control that had focus when the fold flipped, by test id, so focus
  // can follow it across the flip instead of dropping to <body> (which,
  // inside a Modal, is outside its focus trap). Set just BEFORE the flip,
  // while the focused button still exists; read after the commit.
  const focusToRestore = useRef<string | null>(null);
  const morePanelId = useId();
  useLayoutEffect(() => {
    if (!containerEl) return;
    const measure = () => {
      const width = containerEl.getBoundingClientRect().width;
      // 0 = not laid out (hidden tab, jsdom): keep the last answer.
      if (width <= 0) return;
      const next = width < COMPACT_TOOLBAR_MAX_WIDTH;
      if (next === compactRef.current) return;
      compactRef.current = next;
      const active = document.activeElement as HTMLElement | null;
      const inToolbar = !!active?.closest('[role="toolbar"]') &&
        containerEl.contains(active);
      const inPanel = !!document.getElementById(morePanelId)?.contains(active);
      focusToRestore.current =
        active && (inToolbar || inPanel)
          ? (active.getAttribute("data-testid") ?? "")
          : null;
      setCompact(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(containerEl);
    return () => observer.disconnect();
  }, [containerEl]);

  const [moreOpen, setMoreOpen] = useState(false);
  const [moreButtonEl, setMoreButtonEl] = useState<HTMLElement | null>(null);
  const moreButtonRef = useCallback((node: unknown) => {
    setMoreButtonEl(node instanceof HTMLElement ? node : null);
  }, []);
  const [morePanelEl, setMorePanelEl] = useState<HTMLElement | null>(null);
  const morePanelRovingRef = useRovingTabStops("both");
  const morePanelRef = useCallback(
    (node: unknown) => {
      setMorePanelEl(node instanceof HTMLElement ? node : null);
      morePanelRovingRef(node);
    },
    [morePanelRovingRef],
  );
  const toolbarRovingRef = useRovingTabStops("horizontal");
  const bubbleRovingRef = useRovingTabStops("horizontal");

  // A widened editor shows the folded controls inline again; drop the panel.
  useEffect(() => {
    if (!compact) setMoreOpen(false);
  }, [compact]);

  // After the fold flips, put focus back on the same control where it now
  // lives: a folded tool shown inline again (widening, from the panel), or
  // More for an inline tool that just folded away (narrowing). Anything
  // else lands on the toolbar's tab stop. Declared after the roving hooks so
  // their tab-stop sync for this commit has already run.
  useLayoutEffect(() => {
    const id = focusToRestore.current;
    focusToRestore.current = null;
    if (id === null || !containerEl) return;
    // The focused control survived the flip (Bold, say): leave it be.
    const still = document.activeElement;
    if (still && still !== document.body && still.isConnected) return;
    const byId = (testId: string) =>
      testId
        ? containerEl.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
        : null;
    const target =
      byId(id) ??
      (compact ? byId("prose-more-btn") : null) ??
      containerEl.querySelector<HTMLElement>(
        `[role="toolbar"] [${ROVING_ITEM_ATTR}][tabindex="0"]`,
      );
    target?.focus();
  }, [compact, containerEl]);

  const closeMore = useCallback(
    (returnFocus: boolean) => {
      setMoreOpen(false);
      if (returnFocus) moreButtonEl?.focus();
    },
    [moreButtonEl],
  );

  // Opening moves focus to the panel's first control; a click anywhere
  // outside the panel and its trigger closes it.
  useEffect(() => {
    if (!moreOpen || !morePanelEl) return;
    const first = morePanelEl.querySelector<HTMLElement>(
      `[${ROVING_ITEM_ATTR}]:not([aria-disabled="true"])`,
    );
    first?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (morePanelEl.contains(target) || moreButtonEl?.contains(target)) {
        return;
      }
      setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [moreOpen, morePanelEl, moreButtonEl]);

  // Keep a ref to the current editor so async callbacks (like audio upload)
  // always operate on the live instance, not a stale closure capture.
  const editorRef = useRef(editor);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // The bubble menu measures the sticky header on every position update so it
  // can flip below a selection that has the toolbar directly above it.
  const stickyHeaderRef = useRef<HTMLDivElement>(null);
  const bubbleOptions = useMemo(
    () => bubbleMenuOptions(() => stickyHeaderRef.current, stickyTopOffset),
    [stickyTopOffset],
  );
  // BubbleMenu puts its `style` prop on an inner static <div>, where z-index
  // does nothing. Its ref is the absolutely positioned element Tiptap moves
  // around, so the z-index goes there.
  const bubbleMenuRef = useCallback((el: HTMLDivElement | null) => {
    if (el) el.style.zIndex = String(BUBBLE_MENU_Z_INDEX);
  }, []);

  // Update editable state when disabled prop changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled);
    }
  }, [editor, disabled]);

  // Resolve image URLs when imageUrlMap changes
  useEffect(() => {
    if (!editor || !imageUrlMap) return;

    // Walk through the document and update image src attributes
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "imageBlock" && node.attrs.imageId) {
        const src = imageUrlMap[node.attrs.imageId];
        if (src && node.attrs.src !== src) {
          // Update the node's src attribute
          const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            src,
          });
          editor.view.dispatch(tr);
        }
      }
      return true;
    });
  }, [editor, imageUrlMap]);

  // Resolve audio URLs/status when audioUrlMap changes
  useEffect(() => {
    if (!editor || !audioUrlMap) return;

    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "audioBlock" && node.attrs.audioUploadId) {
        const entry = audioUrlMap[node.attrs.audioUploadId];
        if (!entry) return true;

        const entryStartedAt = entry.createdAt
          ? new Date(entry.createdAt).toISOString()
          : null;

        const needsUpdate =
          node.attrs.hlsPlaylistUrl !== (entry.hlsPlaylistUrl ?? null) ||
          node.attrs.sourceUrl !== (entry.sourceUrl ?? null) ||
          node.attrs.status !== (entry.status ?? "PENDING") ||
          node.attrs.uploadStartedAt !== entryStartedAt;

        if (needsUpdate) {
          const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            hlsPlaylistUrl: entry.hlsPlaylistUrl ?? null,
            sourceUrl: entry.sourceUrl ?? null,
            status: entry.status ?? "PENDING",
            uploadStartedAt: entryStartedAt,
          });
          // Keep this OUT of the undo stack. It is a server-state sync, not an
          // authored edit. It matters more than it used to: `sourceUrl` is now
          // a freshly-minted presigned URL on every read, so its signature
          // differs each poll (every 10s while transcoding) and `needsUpdate`
          // is effectively always true. Without this, an organiser who leaves
          // the builder open finds their first Ctrl+Z undoes an invisible URL
          // rewrite instead of their last real edit.
          tr.setMeta("addToHistory", false);
          editor.view.dispatch(tr);
        }
      }
      return true;
    });
  }, [editor, audioUrlMap]);

  const setLink = useCallback(() => {
    if (!editor) return;

    const previousUrl = editor.getAttributes("link").href ?? "";
    if (previousUrl || editor.isActive("link")) {
      setLinkPopover({ href: previousUrl });
    } else {
      setLinkPopover({ href: "https://" });
    }
  }, [editor]);

  /** Save from the link popover. */
  const handleLinkSave = useCallback(
    (url: string) => {
      if (!editor) return;
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: url })
        .run();
      setLinkPopover(null);
    },
    [editor],
  );

  /** Remove the link from the popover. */
  const handleLinkRemove = useCallback(() => {
    if (!editor) return;
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setLinkPopover(null);
  }, [editor]);

  /** Close the link popover without changes. */
  const handleLinkClose = useCallback(() => {
    setLinkPopover(null);
    editor?.commands.focus();
  }, [editor]);

  const handleImageUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!editor || !onImageUpload) return;

      const file = e.target.files?.[0];
      if (!file) return;

      // Reset the input so the same file can be selected again
      e.target.value = "";

      // Validate file type
      if (!file.type.startsWith("image/")) {
        console.warn("Invalid file type:", file.type);
        return;
      }

      try {
        const attrs = await onImageUpload(file);
        if (attrs) {
          editor.commands.insertImageBlock(attrs);
        }
      } catch (err) {
        console.error("Image upload failed:", err);
      }
    },
    [editor, onImageUpload],
  );

  /** Insert an image from a pasted URL (no server upload). */
  const handleImageUrlSubmit = useCallback(() => {
    if (!editor) return;
    const trimmed = imageUrlInput.trim();
    if (!trimmed) return;

    try {
      new URL(trimmed); // validate
    } catch {
      return; // silently ignore malformed URLs
    }

    // Derive a best-effort alt from the URL filename
    const segments = trimmed.split("/");
    const filename = segments[segments.length - 1]?.split("?")[0] ?? "";
    const alt = filename.replace(/\.[^/.]+$/, "") || "Image";

    editor.commands.insertImageBlock({
      imageId: "", // no server-managed ID
      src: trimmed,
      alt,
      align: "center",
      width: "100%",
    });

    setImageUrlInput("");
    setShowImageInsertBar(false);
  }, [editor, imageUrlInput]);

  /** Toggle the image-insert bar open, starting in the given mode. */
  const handleToggleImageBar = useCallback(() => {
    setShowImageInsertBar((prev) => !prev);
  }, []);

  const handleToggleMediaEmbedBar = useCallback(() => {
    setShowMediaEmbedInsertBar((prev) => !prev);
    setMediaEmbedError(null);
  }, []);

  useEffect(() => {
    const dom = editor?.view.dom as HTMLElement | undefined;
    if (!dom) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === "E" || e.key === "e")) {
        e.preventDefault();
        handleToggleMediaEmbedBar();
      }
    };
    dom.addEventListener("keydown", onKeyDown);
    return () => dom.removeEventListener("keydown", onKeyDown);
  }, [editor, handleToggleMediaEmbedBar]);

  const handleMediaEmbedSubmit = useCallback(() => {
    if (!editor) return;
    const parsed = parseEmbedUrl(mediaEmbedUrlInput);
    if (!parsed) {
      setMediaEmbedError(
        String(
          t("admin.peMediaEmbedInvalid") ?? "Paste a supported media URL.",
        ),
      );
      return;
    }

    editor.commands.insertMediaEmbed(mediaEmbedAttrsFromParsed(parsed));
    setMediaEmbedUrlInput("");
    setMediaEmbedError(null);
    setShowMediaEmbedInsertBar(false);
  }, [editor, mediaEmbedUrlInput, t]);

  // ─── Audio upload handlers ────────────────────────────────────────────────

  const handleAudioUploadClick = useCallback(() => {
    audioFileInputRef.current?.click();
  }, []);

  const handleAudioFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!editorRef.current || !onAudioUpload) return;

      const file = e.target.files?.[0];
      if (!file) return;

      // Reset the input so the same file can be selected again
      e.target.value = "";

      // Validate file type
      if (!file.type.startsWith("audio/")) {
        console.warn("Invalid file type for audio:", file.type);
        return;
      }

      try {
        const attrs = await onAudioUpload(file);
        if (attrs) {
          // Use editorRef to get the CURRENT editor instance — the closure's
          // `editor` may have gone stale during the async upload.
          editorRef.current?.commands.insertAudioBlock(attrs);
        }
      } catch (err) {
        console.error("Audio upload failed:", err);
      }
    },
    [onAudioUpload],
  );

  // The blocks the "/" menu and the "+" offer: the toolbar's block tools,
  // gated the same way and running the same handlers (image and embed open
  // the same insert bars, audio the same file picker).
  const insertItems = useMemo<InsertMenuItem[]>(() => {
    if (!editor || disabled) return [];
    const label = (key: string) => String(t(key));
    const chain = () => editor.chain().focus();
    // Picking image or embed opens its insert bar; put focus in it, as a
    // toolbar click leaves it on the button right above.
    const focusInBar = (testId: string) =>
      requestAnimationFrame(() => {
        const el = containerEl?.querySelector<HTMLElement>(
          `[data-testid="${testId}"]`,
        );
        const target = el?.matches("input, button")
          ? el
          : el?.querySelector<HTMLElement>("input, button");
        target?.focus();
      });
    const headingIcons = { 1: Heading1, 2: Heading2, 3: Heading3 } as const;
    const list: InsertMenuItem[] = [
      ...PROSE_HEADING_LEVELS.map((level) => ({
        id: `heading-${level}`,
        label: label(`admin.peHeading${level}`),
        aliases: [`Heading ${level}`, `h${level}`, "title"],
        icon: headingIcons[level],
        run: () => chain().toggleHeading({ level }).run(),
      })),
      {
        id: "bullet-list",
        label: label("admin.peBulletList"),
        aliases: ["Bullet list", "ul", "unordered"],
        icon: List,
        run: () => chain().toggleBulletList().run(),
      },
      {
        id: "numbered-list",
        label: label("admin.peNumberedList"),
        aliases: ["Numbered list", "ol", "ordered"],
        icon: ListOrdered,
        run: () => chain().toggleOrderedList().run(),
      },
      {
        id: "quote",
        label: label("admin.peQuote"),
        aliases: ["Quote", "blockquote"],
        icon: Quote,
        run: () => chain().toggleBlockquote().run(),
      },
      {
        id: "divider",
        label: label("admin.peHorizontalRule"),
        aliases: ["Divider", "Horizontal rule", "hr", "line"],
        icon: Minus,
        run: () => chain().setHorizontalRule().run(),
      },
    ];
    if (imageEnabled && !isUploading) {
      list.push({
        id: "image",
        label: label("admin.peBlockImage"),
        aliases: ["Image", "photo", "picture"],
        icon: ImagePlus,
        run: () => {
          setShowImageInsertBar(true);
          if (onImageUpload) focusInBar("prose-image-file-btn");
        },
      });
    }
    list.push({
      id: "embed",
      label: label("admin.peBlockEmbed"),
      aliases: ["Embed", "Media embed", "video", "youtube", "spotify"],
      icon: Link2,
      run: () => {
        setShowMediaEmbedInsertBar(true);
        setMediaEmbedError(null);
        focusInBar("prose-media-embed-url-input");
      },
    });
    if (audioEnabled && onAudioUpload && !isUploadingAudio) {
      list.push({
        id: "audio",
        label: label("admin.peBlockAudio"),
        aliases: ["Audio", "sound", "music", "song"],
        icon: Music,
        run: handleAudioUploadClick,
      });
    }
    return list;
  }, [
    editor,
    disabled,
    t,
    containerEl,
    imageEnabled,
    isUploading,
    onImageUpload,
    audioEnabled,
    onAudioUpload,
    isUploadingAudio,
    handleAudioUploadClick,
  ]);
  useEffect(() => {
    insertItemsRef.current = insertItems;
  }, [insertItems]);

  // (The effect for touch taps on the padding; see `editorBodyRef`.)
  useEffect(() => {
    if (!editorBodyEl || !editor) return;
    let down: { id: number; x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      down =
        event.pointerType === "mouse"
          ? null
          : { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      if (start?.id !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (moved > TOUCH_TAP_SLOP_PX) return;
      if (!isPaddingPress(editorBodyEl, event.target)) return;
      lastTouchTapAt.current = Date.now();
      editor.commands.focus("end");
    };
    const onPointerCancel = () => {
      down = null;
    };
    editorBodyEl.addEventListener("pointerdown", onPointerDown);
    editorBodyEl.addEventListener("pointerup", onPointerUp);
    editorBodyEl.addEventListener("pointercancel", onPointerCancel);
    return () => {
      editorBodyEl.removeEventListener("pointerdown", onPointerDown);
      editorBodyEl.removeEventListener("pointerup", onPointerUp);
      editorBodyEl.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [editorBodyEl, editor]);

  if (!editor) {
    return (
      // Same ref as the ready editor below: React keeps this container's
      // instance when the editor arrives (same type, same place), and the
      // Tamagui stack never attaches a ref that only appears on an update.
      // Measured live: without it the fold never engaged at 320px.
      <EditorContainer ref={containerRef}>
        <EditorContentWrapper
          style={{ minHeight: actualMinHeight }}
          autoExpand={isAutoExpand}
        >
          <Text tag="span" tone="muted">
            {placeholder}
          </Text>
        </EditorContentWrapper>
      </EditorContainer>
    );
  }

  const tool = (
    id: string,
    labelKey: string,
    icon: ReactNode,
    run: () => void,
    pressed?: boolean,
    ...keys: string[]
  ): FoldableTool => {
    const label = t(labelKey) as string;
    return { id, label, hint: tip(label, ...keys), icon, pressed, run };
  };
  const tools = {
    underline: tool(
      "underline",
      "admin.peUnderline",
      <UnderlineIcon size={18} />,
      () => editor.chain().focus().toggleUnderline().run(),
      !!format?.underline,
      MOD,
      "U",
    ),
    strike: tool(
      "strike",
      "admin.peStrikethrough",
      <Strikethrough size={18} />,
      () => editor.chain().focus().toggleStrike().run(),
      !!format?.strike,
      MOD,
      SHIFT,
      "S",
    ),
    highlight: tool(
      "highlight",
      "admin.peHighlight",
      <Highlighter size={18} />,
      () => editor.chain().focus().toggleHighlight().run(),
      !!format?.highlight,
      MOD,
      SHIFT,
      "H",
    ),
    h3: tool(
      "h3",
      "admin.peHeading3",
      <Heading3 size={18} />,
      () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
      !!format?.h3,
      MOD,
      "Alt",
      "3",
    ),
    alignLeft: tool(
      "align-left",
      "admin.peAlignLeft",
      <AlignLeft size={18} />,
      () => editor.chain().focus().setTextAlign("left").run(),
      !!format?.alignLeft,
      MOD,
      SHIFT,
      "L",
    ),
    alignCenter: tool(
      "align-center",
      "admin.peAlignCenter",
      <AlignCenter size={18} />,
      () => editor.chain().focus().setTextAlign("center").run(),
      !!format?.alignCenter,
      MOD,
      SHIFT,
      "E",
    ),
    alignRight: tool(
      "align-right",
      "admin.peAlignRight",
      <AlignRight size={18} />,
      () => editor.chain().focus().setTextAlign("right").run(),
      !!format?.alignRight,
      MOD,
      SHIFT,
      "R",
    ),
    horizontalRule: tool(
      "horizontal-rule",
      "admin.peHorizontalRule",
      <Minus size={18} />,
      () => editor.chain().focus().setHorizontalRule().run(),
    ),
    clearFormatting: tool(
      "clear-formatting",
      "admin.peClearFormatting",
      <RemoveFormatting size={18} />,
      () => editor.chain().focus().clearNodes().unsetAllMarks().run(),
    ),
  };
  const renderTool = (def: FoldableTool, after?: () => void) => (
    <TipBtn key={def.id} label={def.hint}>
      <ToolbarButton
        pressed={def.pressed}
        disabled={disabled}
        onPress={() => {
          def.run();
          after?.();
        }}
        aria-label={def.label}
        data-testid={`prose-tool-${def.id}`}
      >
        {def.icon}
      </ToolbarButton>
    </TipBtn>
  );

  return (
    <EditorContainer ref={containerRef} data-testid="prose-editor">
      {/* Hidden file input for image upload */}
      {imageEnabled && (
        <input
          ref={fileInputRef}
          type="file"
          accept={EVENT_IMAGE_UPLOAD_ACCEPT}
          style={{ display: "none" }}
          onChange={handleFileChange}
          data-testid="prose-image-file-input"
        />
      )}

      {/* Hidden file input for audio upload */}
      {audioEnabled && (
        <input
          ref={audioFileInputRef}
          type="file"
          accept="audio/mpeg,audio/mp3,audio/mp4,audio/wav,audio/ogg,audio/aac,audio/flac,audio/webm"
          style={{ display: "none" }}
          onChange={handleAudioFileChange}
          data-testid="prose-audio-file-input"
        />
      )}

      {/* Sticky header: toolbar + active insert bar travel together as the user scrolls. */}
      <StickyHeader
        ref={stickyHeaderRef}
        style={{ top: stickyTopOffset }}
      >
        <RovingToolbar
          ref={toolbarRovingRef}
          role="toolbar"
          aria-label={t("admin.peToolbar") as string}
          compact={compact}
        >
          {/* Undo / Redo */}
          <TipBtn label={tip(t("admin.peUndo") as string, MOD, "Z")}>
            <ToolbarButton
              disabled={disabled || !format?.canUndo}
              onPress={() => editor.chain().focus().undo().run()}
              aria-label={t("admin.peUndo") as string}
            >
              <Undo2 size={18} />
            </ToolbarButton>
          </TipBtn>
          <TipBtn label={tip(t("admin.peRedo") as string, MOD, SHIFT, "Z")}>
            <ToolbarButton
              disabled={disabled || !format?.canRedo}
              onPress={() => editor.chain().focus().redo().run()}
              aria-label={t("admin.peRedo") as string}
            >
              <Redo2 size={18} />
            </ToolbarButton>
          </TipBtn>

          {!compact && <ToolbarDivider />}

          {/* Text formatting */}
          <TipBtn label={tip(t("admin.peBold") as string, MOD, "B")}>
            <ToolbarButton
              pressed={!!format?.bold}
              disabled={disabled}
              onPress={() => editor.chain().focus().toggleBold().run()}
              aria-label={t("admin.peBold") as string}
            >
              <Bold size={18} />
            </ToolbarButton>
          </TipBtn>
          <TipBtn label={tip(t("admin.peItalic") as string, MOD, "I")}>
            <ToolbarButton
              pressed={!!format?.italic}
              disabled={disabled}
              onPress={() => editor.chain().focus().toggleItalic().run()}
              aria-label={t("admin.peItalic") as string}
            >
              <Italic size={18} />
            </ToolbarButton>
          </TipBtn>
          {!compact && renderTool(tools.underline)}
          {!compact && renderTool(tools.strike)}
          {!compact && renderTool(tools.highlight)}
          <TipBtn label={tip(t("admin.peLink") as string, MOD, "K")}>
            <ToolbarButton
              pressed={!!format?.link}
              disabled={disabled}
              onPress={setLink}
              aria-label={t("admin.peLink") as string}
            >
              <LinkIcon size={18} />
            </ToolbarButton>
          </TipBtn>

          {!compact && <ToolbarDivider />}

          {/* Headings */}
          <TipBtn label={tip(t("admin.peHeading1") as string, MOD, "Alt", "1")}>
            <ToolbarButton
              pressed={!!format?.h1}
              disabled={disabled}
              onPress={() =>
                editor.chain().focus().toggleHeading({ level: 1 }).run()
              }
              aria-label={t("admin.peHeading1") as string}
            >
              <Heading1 size={18} />
            </ToolbarButton>
          </TipBtn>
          <TipBtn label={tip(t("admin.peHeading2") as string, MOD, "Alt", "2")}>
            <ToolbarButton
              pressed={!!format?.h2}
              disabled={disabled}
              onPress={() =>
                editor.chain().focus().toggleHeading({ level: 2 }).run()
              }
              aria-label={t("admin.peHeading2") as string}
            >
              <Heading2 size={18} />
            </ToolbarButton>
          </TipBtn>
          {!compact && renderTool(tools.h3)}

          {!compact && (
            <>
              <ToolbarDivider />
              {/* Text alignment */}
              {renderTool(tools.alignLeft)}
              {renderTool(tools.alignCenter)}
              {renderTool(tools.alignRight)}
              <ToolbarDivider />
            </>
          )}

          {/* Lists */}
          <TipBtn
            label={tip(t("admin.peBulletList") as string, MOD, SHIFT, "8")}
          >
            <ToolbarButton
              pressed={!!format?.bulletList}
              disabled={disabled}
              onPress={() => editor.chain().focus().toggleBulletList().run()}
              aria-label={t("admin.peBulletList") as string}
            >
              <List size={18} />
            </ToolbarButton>
          </TipBtn>
          <TipBtn
            label={tip(t("admin.peNumberedList") as string, MOD, SHIFT, "7")}
          >
            <ToolbarButton
              pressed={!!format?.orderedList}
              disabled={disabled}
              onPress={() => editor.chain().focus().toggleOrderedList().run()}
              aria-label={t("admin.peNumberedList") as string}
            >
              <ListOrdered size={18} />
            </ToolbarButton>
          </TipBtn>

          {!compact && <ToolbarDivider />}

          {/* Block formatting */}
          <TipBtn label={tip(t("admin.peQuote") as string, MOD, SHIFT, "B")}>
            <ToolbarButton
              pressed={!!format?.blockquote}
              disabled={disabled}
              onPress={() => editor.chain().focus().toggleBlockquote().run()}
              aria-label={t("admin.peQuote") as string}
            >
              <Quote size={18} />
            </ToolbarButton>
          </TipBtn>
          {!compact && renderTool(tools.horizontalRule)}

          {/* Clear formatting */}
          {!compact && renderTool(tools.clearFormatting)}

          {/* Image upload button - always shown when showImageButton is true or onImageUpload is provided */}
          {imageEnabled && (
            <>
              {!compact && <ToolbarDivider />}
              <TipBtn
                label={
                  !onImageUpload && imageInsertMode === "file"
                    ? imageButtonDisabledTooltip
                    : (t("admin.peInsertImage") as string)
                }
              >
                <ToolbarButton
                  disabled={disabled || isUploading}
                  onPress={handleToggleImageBar}
                  active={showImageInsertBar}
                  aria-expanded={showImageInsertBar}
                  aria-label={t("admin.peInsertImage") as string}
                  data-testid="prose-image-upload-btn"
                >
                  {isUploading ? (
                    <Spinner width={18} height={18} borderWidth={2} />
                  ) : (
                    <ImagePlus size={18} />
                  )}
                </ToolbarButton>
              </TipBtn>
            </>
          )}

          {!compact && <ToolbarDivider />}
          <TipBtn
            label={`${String(t("admin.peInsertMediaEmbed") ?? "Embed link")} · ⌘⇧E`}
          >
            <ToolbarButton
              disabled={disabled}
              onPress={handleToggleMediaEmbedBar}
              active={showMediaEmbedInsertBar}
              aria-expanded={showMediaEmbedInsertBar}
              aria-label={String(
                t("admin.peInsertMediaEmbed") ?? "Insert media embed",
              )}
              data-testid="prose-media-embed-btn"
            >
              <Link2 size={18} />
            </ToolbarButton>
          </TipBtn>

          {/* Audio upload button */}
          {audioEnabled && (
            <>
              {!compact && <ToolbarDivider />}
              <TipBtn
                label={
                  !onAudioUpload
                    ? audioButtonDisabledTooltip
                    : (t("admin.peInsertAudio") as string)
                }
              >
                <ToolbarButton
                  disabled={disabled || isUploadingAudio || !onAudioUpload}
                  onPress={handleAudioUploadClick}
                  aria-label={t("admin.peInsertAudio") as string}
                  data-testid="prose-audio-upload-btn"
                >
                  {isUploadingAudio ? (
                    <Spinner width={18} height={18} borderWidth={2} />
                  ) : (
                    <Music size={18} />
                  )}
                </ToolbarButton>
              </TipBtn>
            </>
          )}

          {/* Narrow editors: the folded controls, behind one button. */}
          {compact && (
            <TipBtn label={t("admin.peMoreFormatting") as string}>
              <ToolbarButton
                ref={moreButtonRef}
                disabled={disabled}
                onPress={() => setMoreOpen((open) => !open)}
                active={moreOpen}
                aria-expanded={moreOpen}
                aria-controls={moreOpen ? morePanelId : undefined}
                aria-label={t("admin.peMoreFormatting") as string}
                data-testid="prose-more-btn"
              >
                <Ellipsis size={18} />
              </ToolbarButton>
            </TipBtn>
          )}
        </RovingToolbar>

        {compact && (
          <Popover
            open={moreOpen}
            anchorElement={moreButtonEl}
            placement="bottom-end"
            matchAnchorWidth={false}
            contentProps={{ zIndex: MORE_PANEL_Z_INDEX }}
          >
            <XStack
              ref={morePanelRef}
              id={morePanelId}
              role="group"
              aria-label={t("admin.peMoreFormatting") as string}
              data-testid="prose-more-panel"
              // $2 (8px), not $1: Popover's frame clips (overflow hidden),
              // and the focus ring reaches 5px outside a button (3px stroke
              // at a 2px offset), so a $1 inset cut the edge buttons' rings.
              padding="$2"
              gap={1}
              flexWrap="wrap"
              // Five 26px buttons a row (plus 1px gaps and the 8px padding
              // each side): two short rows, and still narrower than the
              // 320px screen, so the panel never overhangs it.
              maxWidth={5 * 26 + 4 * 1 + 2 * 8}
              backgroundColor="$backgroundHover"
              {...({
                onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
                  if (event.key === "Escape") {
                    // Stop here: inside a Modal, Escape would also close the
                    // whole dialog (its listener is on window).
                    event.preventDefault();
                    event.stopPropagation();
                    closeMore(true);
                  } else if (event.key === "Tab") {
                    // The panel is portalled to <body>, so the browser's next
                    // Tab stop is nowhere near the editor. Hand focus back to
                    // More; the next Tab leaves the toolbar from there.
                    event.preventDefault();
                    closeMore(true);
                  }
                },
              } as Record<string, unknown>)}
            >
              <RovingGroupContext.Provider value={true}>
                {[
                  tools.underline,
                  tools.strike,
                  tools.highlight,
                  tools.h3,
                  tools.alignLeft,
                  tools.alignCenter,
                  tools.alignRight,
                  tools.horizontalRule,
                  tools.clearFormatting,
                ].map((tool) => renderTool(tool, () => closeMore(false)))}
              </RovingGroupContext.Provider>
            </XStack>
          </Popover>
        )}

        {/* Image insert bar — file/url mode toggle + input */}
        {showImageInsertBar && imageEnabled && (
          <YStack
            padding="$2"
            gap="$2"
            borderBottomWidth={1}
            borderBottomColor="$borderColor"
            backgroundColor="$backgroundHover"
            data-testid="prose-image-insert-bar"
          >
            <forms.UploadModeToggle
              mode={imageInsertMode}
              onChange={setImageInsertMode}
              fileLabel={String(t("admin.peUploadFile") ?? "Upload File")}
              urlLabel={String(t("admin.peImageUrl") ?? "Image URL")}
              data-testid="prose-image-mode-toggle"
            />

            {imageInsertMode === "file" ? (
              <XStack gap="$2" alignItems="center">
                <Button
                  variant="primary"
                  size="$2"
                  onPress={handleImageUploadClick}
                  disabled={disabled || !onImageUpload || isUploading}
                  data-testid="prose-image-file-btn"
                >
                  {isUploading
                    ? String(t("admin.peUploading") ?? "Uploading...")
                    : String(t("admin.peChooseFile") ?? "Choose file")}
                </Button>
                {!onImageUpload && (
                  <Text variant="caption" tone="muted">
                    {imageButtonDisabledTooltip}
                  </Text>
                )}
              </XStack>
            ) : (
              <XStack gap="$2" alignItems="flex-end">
                <YStack flex={1}>
                  <TextInput
                    value={imageUrlInput}
                    onChangeText={setImageUrlInput}
                    placeholder="https://example.com/image.jpg"
                    fullWidth
                    testId="prose-image-url-input"
                    onSubmitEditing={handleImageUrlSubmit}
                  />
                </YStack>
                <Button
                  variant="primary"
                  size="$2"
                  onPress={handleImageUrlSubmit}
                  disabled={!imageUrlInput.trim()}
                  data-testid="prose-image-url-submit"
                >
                  {String(t("admin.peInsert") ?? "Insert")}
                </Button>
              </XStack>
            )}
          </YStack>
        )}

        {/* Media embed insert bar — URL-only, canonicalized through parseEmbedUrl */}
        {showMediaEmbedInsertBar && (
          <YStack
            padding="$2"
            gap="$2"
            borderBottomWidth={1}
            borderBottomColor="$borderColor"
            backgroundColor="$backgroundHover"
            data-testid="prose-media-embed-insert-bar"
          >
            <XStack gap="$2" alignItems="flex-end">
              <YStack flex={1} gap="$1">
                <Text
                  tag="label"
                  style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                  weight="bold"
                  tone="muted"
                >
                  {String(t("admin.peMediaEmbedUrl") ?? "Media URL")}
                </Text>
                <TextInput
                  value={mediaEmbedUrlInput}
                  onChangeText={(value) => {
                    setMediaEmbedUrlInput(value);
                    if (mediaEmbedError) setMediaEmbedError(null);
                  }}
                  placeholder="https://..."
                  fullWidth
                  testId="prose-media-embed-url-input"
                  aria-label={String(t("admin.peMediaEmbedUrl") ?? "Media URL")}
                  onSubmitEditing={handleMediaEmbedSubmit}
                />
              </YStack>
              <Button
                variant="primary"
                size="$2"
                onPress={handleMediaEmbedSubmit}
                disabled={!mediaEmbedUrlInput.trim()}
                data-testid="prose-media-embed-submit"
              >
                {String(t("admin.peInsert") ?? "Insert")}
              </Button>
            </XStack>
            {mediaEmbedError && (
              <Text
                tag="span"
                role="alert"
                aria-live="assertive"
                style={{ fontSize: 12 }}
                tone="error"
                weight="bold"
              >
                {mediaEmbedError}
              </Text>
            )}
            <Text tag="span" style={{ fontSize: 12 }} tone="muted">
              {String(
                t("admin.peMediaEmbedHelp") ??
                  "Supports YouTube, Spotify, Apple Music, SoundCloud, Vimeo, and Bandcamp links.",
              )}
            </Text>
          </YStack>
        )}
      </StickyHeader>

      {/* Bubble Menu (appears on text selection) — but only on actual text.
          Image / audio / media-embed blocks are NodeSelections that Tiptap
          would otherwise treat as a normal selection and float the
          bold/italic/strike menu over them, which is meaningless for media. */}
      <BubbleMenu
        editor={editor}
        ref={bubbleMenuRef}
        options={bubbleOptions}
        shouldShow={({ editor: ed, from, to }) => {
          if (from === to) return false; // empty selection
          const NON_TEXT_NODES = new Set([
            "imageBlock",
            "audioBlock",
            "mediaEmbed",
          ]);
          // Any NodeSelection — hide outright. On a media block the marks
          // mean nothing; on a text block it is the grip's drag (and the
          // drop), which selects the whole block it moves.
          const selNode = (
            ed.state.selection as { node?: { type: { name: string } } }
          ).node;
          if (selNode) return false;
          // Range selection that contains a media block (e.g. select-all over
          // a paragraph + an image) — also hide so the toolbar can't apply
          // text marks across nodes that don't accept them.
          let touchesMedia = false;
          ed.state.doc.nodesBetween(from, to, (node) => {
            if (NON_TEXT_NODES.has(node.type.name)) {
              touchesMedia = true;
              return false;
            }
            return true;
          });
          return !touchesMedia;
        }}
      >
        <RovingBubbleMenu
          ref={bubbleRovingRef}
          role="toolbar"
          aria-label={t("admin.peSelectionToolbar") as string}
        >
          <ToolbarButton
            pressed={!!format?.bold}
            onPress={() => editor.chain().focus().toggleBold().run()}
            aria-label={t("admin.peBold") as string}
          >
            <Bold size={14} />
          </ToolbarButton>
          <ToolbarButton
            pressed={!!format?.italic}
            onPress={() => editor.chain().focus().toggleItalic().run()}
            aria-label={t("admin.peItalic") as string}
          >
            <Italic size={14} />
          </ToolbarButton>
          <ToolbarButton
            pressed={!!format?.underline}
            onPress={() => editor.chain().focus().toggleUnderline().run()}
            aria-label={t("admin.peUnderline") as string}
          >
            <UnderlineIcon size={14} />
          </ToolbarButton>
          <ToolbarButton
            pressed={!!format?.strike}
            onPress={() => editor.chain().focus().toggleStrike().run()}
            aria-label={t("admin.peStrikethrough") as string}
          >
            <Strikethrough size={14} />
          </ToolbarButton>
          <ToolbarButton
            pressed={!!format?.highlight}
            onPress={() => editor.chain().focus().toggleHighlight().run()}
            aria-label={t("admin.peHighlight") as string}
          >
            <Highlighter size={14} />
          </ToolbarButton>
          <ToolbarButton
            pressed={!!format?.link}
            onPress={setLink}
            aria-label={t("admin.peLink") as string}
          >
            <LinkIcon size={14} />
          </ToolbarButton>
        </RovingBubbleMenu>
      </BubbleMenu>

      {/* Editor Content - auto-expands based on content.
          The wrapper has ~$3 of padding around the ProseMirror surface and
          can extend tall when minHeight kicks in; without this handler,
          clicking that padding area is a no-op because the click never
          reaches a contenteditable node. Forward those clicks into the
          editor so users can click anywhere in the box to start typing. */}
      <EditorContentWrapper
        style={{ minHeight: actualMinHeight }}
        autoExpand={isAutoExpand}
        ref={editorBodyRef}
        onMouseDown={(e) => {
          // Tamagui runs this as onPressIn, on touchstart too, where React's
          // listener is passive (preventDefault is an error) and a swipe
          // that starts in the padding must not move the caret. Touch taps
          // are handled on pointerup (the effect above); so is the
          // compatibility mousedown a tap sends after it.
          if (e.nativeEvent?.type !== "mousedown") return;
          if (
            editor &&
            isPaddingPress(e.currentTarget as HTMLElement, e.target)
          ) {
            // Only the padding / empty tail: a press on the text is
            // ProseMirror's own caret placement. Always stop the default:
            // after a tap, the compatibility mousedown on this unfocusable
            // box would otherwise blur the editor the tap just focused
            // (Android Chrome), closing the keyboard.
            e.preventDefault();
            const tapCompat =
              Date.now() - lastTouchTapAt.current < TOUCH_TAP_COMPAT_MS;
            if (!tapCompat) editor.commands.focus("end");
          }
        }}
      >
        <EditorContent editor={editor} style={{ outline: "none" }} />
        <BlockGutter
          editor={editor}
          items={insertItems}
          listboxId={insertListboxId}
          editable={!disabled}
        />
      </EditorContentWrapper>

      {/* Inline link editor popover */}
      {linkPopover && (
        <LinkPopover
          initialHref={linkPopover.href}
          onSave={handleLinkSave}
          onRemove={handleLinkRemove}
          onClose={handleLinkClose}
          editorView={editor.view}
        />
      )}

      {/* Upload loading indicator */}
      {isUploading && (
        <XStack
          padding="$3"
          gap="$2"
          alignItems="center"
          borderTopWidth={1}
          borderTopColor="$borderColor"
          backgroundColor="$backgroundHover"
          data-testid="prose-upload-indicator"
        >
          <Spinner width={18} height={18} borderWidth={2} />
          <Text tag="span" style={{ fontSize: 13 }} tone="muted">
            {t("admin.peUploading") as string}
          </Text>
        </XStack>
      )}

      {/* Audio upload loading indicator */}
      {isUploadingAudio && (
        <XStack
          padding="$3"
          gap="$2"
          alignItems="center"
          borderTopWidth={1}
          borderTopColor="$borderColor"
          backgroundColor="$backgroundHover"
          data-testid="prose-audio-upload-indicator"
        >
          <Spinner width={18} height={18} borderWidth={2} />
          <Text tag="span" style={{ fontSize: 13 }} tone="muted">
            {t("admin.peUploadingAudio") as string}
          </Text>
        </XStack>
      )}

      {/* Word / character count footer */}
      {(showWordCount || maxCharacters != null) &&
        editor.storage.characterCount && (
          <FooterBar data-testid="prose-footer">
            {showWordCount && (
              <Text tag="span" style={{ fontSize: 12 }} tone="muted">
                {t("admin.peWords", {
                  count: editor.storage.characterCount.words(),
                })}
              </Text>
            )}
            {maxCharacters != null && (
              <Text
                tag="span"
                style={{ fontSize: 12 }}
                color={
                  editor.storage.characterCount.characters() > maxCharacters
                    ? "$danger"
                    : "$colorMuted"
                }
              >
                {editor.storage.characterCount.characters()} / {maxCharacters}
              </Text>
            )}
          </FooterBar>
        )}
    </EditorContainer>
  );
};

ProseEditor.displayName = "ProseEditor";
