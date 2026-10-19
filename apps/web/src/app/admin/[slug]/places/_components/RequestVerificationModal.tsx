"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal, useNotify, useTranslations } from "@th/ui";

import {
  VerificationRequestForm,
  type VerificationFormGuard,
  type VerificationFormState,
} from "./VerificationRequestForm";

// ─────────────────────────────────────────────────────────────────────────────
// FR-012 / FR-013: the modal presentation of the ONE verification-request
// implementation (`VerificationRequestForm`). Opened from the PlacesTable row
// action, so requesting verification from the list does not mean leaving it.
// (It was also opened from the old `/edit` header; that route now redirects
// to the venue settings page, whose Verification section renders the same
// form inline.)
//
// `Modal` already owns the dialog semantics this needs: role="dialog" +
// aria-modal + aria-labelledby wired to the header title, initial focus into
// the panel, Escape to dismiss, backdrop press, and focus RETURN to whatever
// was focused when it opened (the trigger button).
//
// ── Why `open` is a PROP and this component is NOT conditionally mounted ──
// `Modal`'s focus-return lives in a `useEffect(…, [open])` whose ELSE branch
// runs on the true→false transition. A caller that renders
// `{isOpen && <RequestVerificationModal/>}` unmounts the whole Modal instead,
// React runs cleanup rather than the effect body, and focus is silently
// dropped to <body>. Measured in a real browser: `document.activeElement` came
// back as BODY after Escape. Callers must keep this mounted and toggle `open`.
//
// Doing so costs nothing: `Modal` renders NO children while closed
// (`<AnimatePresence>{open && …}`), so `VerificationRequestForm` — and its
// per-place `getPlaceDetail` read — never mounts until the dialog opens.
//
// ── Closing must not silently bin staged uploads ─────────────────────────────
// That same "renders no children while closed" property is a hazard here: the
// form owns `stagedFiles`, so ANY close throws them away. The inline `/verify`
// presentation had no backdrop, so this risk arrived WITH the modal, not with
// the extraction — a stray click beside the panel could discard five 10MB
// files with no warning and no undo.
//
// So closes are graded by intent, using the guard the form reports:
//   · backdrop / Escape (easy to hit by accident) — refused while anything is
//     staged, with a toast saying so, because `Modal` gives both paths the same
//     `onClose` and cannot tell them apart without editing a shared primitive.
//     A refusal the user can SEE beats a dead control.
//   · Cancel / × (unambiguous intent) — confirm, then discard. `window.confirm`
//     matches the precedent set by PromoFormDialog: a Modal-on-Modal for this
//     is heavier than the decision deserves.
//   · mid-upload — nothing closes; a presign/PUT loop must not be orphaned
//     half-way through (Cancel is already disabled while uploading).
//   · successful submit — closes directly; the files were consumed.
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestVerificationModalProps {
  /** Toggle this; do NOT conditionally mount the component (see above). */
  open: boolean;
  placeId: string;
  placeName: string;
  access: { orgIds: string[]; humanIds: string[] };
  /** Values eligibility is judged against — live form state on `/edit`. */
  formState: VerificationFormState;
  /** True when the editor has unsaved edits; blocks submission. */
  isDirty?: boolean;
  onClose: () => void;
}

export function RequestVerificationModal({
  open,
  placeId,
  placeName,
  access,
  formState,
  isDirty = false,
  onClose,
}: RequestVerificationModalProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const [guard, setGuard] = useState<VerificationFormGuard>("none");

  // The form unmounts on close and remounts empty on the next open, so a stale
  // guard from the previous session would wrongly block the first dismiss.
  useEffect(() => {
    if (!open) setGuard("none");
  }, [open]);

  /**
   * @param intent `dismiss` = backdrop/Escape (accidental); `explicit` =
   *               Cancel or the header ×.
   */
  const requestClose = useCallback(
    (intent: "dismiss" | "explicit") => {
      if (guard === "uploading") {
        toast.info({
          id: "verification-upload-in-progress",
          title: t("admin.placeVerifUploadingCloseBlocked") as string,
        });
        return;
      }
      if (guard === "staged") {
        if (intent === "dismiss") {
          toast.info({
            id: "verification-files-kept",
            title: t("admin.placeVerifKeepFilesTitle") as string,
            message: t("admin.placeVerifKeepFilesMessage") as string,
          });
          return;
        }
        if (!window.confirm(String(t("admin.placeVerifDiscardConfirm"))))
          return;
      }
      onClose();
    },
    [guard, onClose, t, toast],
  );

  return (
    <Modal open={open} onClose={() => requestClose("dismiss")}>
      <Modal.Panel width={560}>
        <Modal.Header
          title={String(t("admin.placeVerifModalTitle"))}
          subtitle={placeName}
          onClose={() => requestClose("explicit")}
        />
        <VerificationRequestForm
          placeId={placeId}
          access={access}
          formState={formState}
          isDirty={isDirty}
          onCancel={() => requestClose("explicit")}
          onSubmitted={onClose}
          onGuardChange={setGuard}
          BodySlot={Modal.Body}
          ActionsSlot={Modal.Footer}
        />
      </Modal.Panel>
    </Modal>
  );
}
