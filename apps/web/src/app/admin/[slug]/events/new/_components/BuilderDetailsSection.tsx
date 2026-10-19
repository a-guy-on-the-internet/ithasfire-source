"use client";

import { memo, useCallback, useRef, useState } from "react";

import { Text, useTranslations } from "@th/ui";
import type { ProseMirrorDoc } from "@th/schema";

import { BlocksSection, BlocksSectionHeader } from "./_builder-styled";
import { DescriptionStarters } from "./DescriptionStarters";
import {
  buildDescriptionStarterDoc,
  type DescriptionStarterKind,
} from "./description-starters";
import {
  hasContent,
  ProseEditor,
  type AudioUploadHandler,
  type AudioUrlMapEntry,
  type ImageUploadHandler,
} from "./prose-editor";

/**
 * Event details — the prose body block.
 *
 * Memoized so typing in Title (or any other builder field) no longer
 * re-renders the ProseEditor's toolbar/chrome. `bodyContent` and the resolved
 * media maps DO change while the user edits prose, which is exactly when this
 * section should re-render; the upload handlers are stable ref-wrappers owned
 * by EventBuilder (the raw `useEventImageUpload` handlers depend on tRPC
 * mutation objects, whose identity churns every render).
 */

export type BuilderDetailsSectionProps = {
  /**
   * Remount key source: the editor is seeded from `initialContent` once, so it
   * has to remount when the persisted body arrives.
   */
  hasLoadedExisting: boolean;
  bodyContent: ProseMirrorDoc;
  onBodyChange: (doc: ProseMirrorDoc) => void;
  /** Sticky-header height, so the editor's own sticky toolbar clears it. */
  stickyTopOffset: number;
  onImageUpload: ImageUploadHandler;
  imageUrlMap: Record<string, string>;
  isUploading: boolean;
  onAudioUpload: AudioUploadHandler;
  audioUrlMap: Record<string, AudioUrlMapEntry>;
  isUploadingAudio: boolean;
  /**
   * Offer the audio-insert toolbar button. Defaults to `true`, and no caller
   * passes `false` today — the escape hatch is kept because the reason it once
   * existed is worth not re-learning.
   *
   * COMMUNITY listings used to pass `false`, and the reason was a READ gap
   * rather than a write one: `events.requestAudioUpload` /
   * `finalizeAudioUpload` both carried a COMMUNITY branch, so the upload
   * landed, but `resolveEventAudio` returned an EMPTY list unless the event
   * was PUBLISHED or `authz.canEditEvent` allowed the viewer — and that probe
   * is false for every ownerless row, at every status. A track dropped onto a
   * DRAFT listing therefore never resolved a player, in the editor or the
   * preview, and a button that swallows a file is worse than no button.
   *
   * `resolveEventAudio` now has the moderator branch its siblings have (the
   * same `COMMUNITY_MODERATION_ROLES` gate `getEventForEdit` uses), so the
   * read side works and the button is offered everywhere. If you are about to
   * set this `false` again, fix the read path instead.
   */
  allowAudio?: boolean;
  /**
   * Once per editor mount: the editor's mount-normalised doc (`ProseEditor`'s
   * `onReady`), and the doc that editor was mounted WITH. The builder's
   * unsaved-changes check measures the body in the normalised shape.
   * `mountedWith` is passed back rather than read from `bodyContent` because
   * the editor's URL sync can emit `onChange` before `onReady` fires.
   */
  onReady?: (doc: ProseMirrorDoc, mountedWith: ProseMirrorDoc) => void;
  /**
   * Offer the description starters. The builder holds them back until its
   * unsaved-changes baseline exists, so a pick can never be absorbed into it.
   * Defaults to `true`.
   */
  startersReady?: boolean;
  /** The starter that fits the event's category; shown first and marked. */
  suggestedStarter?: DescriptionStarterKind | null;
};

function BuilderDetailsSectionImpl({
  hasLoadedExisting,
  bodyContent,
  onBodyChange,
  stickyTopOffset,
  onImageUpload,
  imageUrlMap,
  isUploading,
  onAudioUpload,
  audioUrlMap,
  isUploadingAudio,
  allowAudio = true,
  onReady,
  startersReady = true,
  suggestedStarter = null,
}: BuilderDetailsSectionProps) {
  const t = useTranslations();

  // ProseEditor is seeded from `initialContent` once and has no external
  // `value` sync, so a starter is applied the way the persisted body is: set
  // the builder's body, then remount the editor so it seeds from it.
  const [starterNonce, setStarterNonce] = useState(0);
  // After a pick the button that had focus unmounts with the row, so focus
  // moves into the new editor. Its fresh state's selection sits at the start
  // of the doc, and ProseMirror maps DOM focus onto that selection.
  const focusAfterRemountRef = useRef(false);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const handleStarterPick = useCallback(
    (kind: DescriptionStarterKind) => {
      onBodyChange(buildDescriptionStarterDoc(kind, t));
      focusAfterRemountRef.current = true;
      setStarterNonce((n) => n + 1);
    },
    [onBodyChange, t],
  );
  const handleEditorReady = useCallback(() => {
    if (!focusAfterRemountRef.current) return;
    focusAfterRemountRef.current = false;
    requestAnimationFrame(() => {
      editorWrapRef.current
        ?.querySelector<HTMLElement>('[contenteditable="true"]')
        ?.focus();
    });
  }, []);

  const editorKey = `${hasLoadedExisting ? "loaded" : "fresh"}-${starterNonce}`;
  // The doc the current editor instance was seeded with: captured on the
  // render that gives it its key, since `initialContent` is read once.
  const mountedWithRef = useRef<{ key: string; doc: ProseMirrorDoc } | null>(
    null,
  );
  if (mountedWithRef.current?.key !== editorKey) {
    mountedWithRef.current = { key: editorKey, doc: bodyContent };
  }
  const handleReady = useCallback(
    (doc: ProseMirrorDoc) => {
      handleEditorReady();
      onReady?.(doc, mountedWithRef.current?.doc ?? doc);
    },
    [handleEditorReady, onReady],
  );

  // An image or audio upload inserts into the editor instance that started
  // it; a remount would drop the finished upload from the body. So no
  // starters while one is in flight.
  const showStarters =
    startersReady &&
    !hasContent(bodyContent) &&
    !isUploading &&
    !isUploadingAudio;

  return (
    <BlocksSection>
      <BlocksSectionHeader>
        <Text variant="h4" weight="bold">
          {String(t("admin.ebEventDetails"))}
        </Text>
      </BlocksSectionHeader>
      {showStarters ? (
        <DescriptionStarters
          onPick={handleStarterPick}
          suggestedStarter={suggestedStarter}
        />
      ) : null}
      {/* `display: contents` keeps this wrapper out of layout (and out of the
          sticky toolbar's containing block); it only scopes the focus query. */}
      <div ref={editorWrapRef} style={{ display: "contents" }}>
        <ProseEditor
          key={editorKey}
          initialContent={bodyContent}
          onChange={onBodyChange}
          onReady={handleReady}
          placeholder={t("admin.ebProseEditorPlaceholder") as string}
          minHeight="auto"
          stickyTopOffset={stickyTopOffset}
          onImageUpload={onImageUpload}
          imageUrlMap={imageUrlMap}
          showImageButton
          imageButtonDisabledTooltip={
            t("admin.ebImageUploadDisabled") as string
          }
          isUploading={isUploading}
          {...(allowAudio
            ? {
                onAudioUpload,
                showAudioButton: true as const,
                audioButtonDisabledTooltip: t(
                  "admin.ebAudioUploadDisabled",
                ) as string,
              }
            : {})}
          audioUrlMap={audioUrlMap}
          isUploadingAudio={isUploadingAudio}
        />
      </div>
    </BlocksSection>
  );
}

export const BuilderDetailsSection = memo(BuilderDetailsSectionImpl);

BuilderDetailsSection.displayName = "BuilderDetailsSection";
