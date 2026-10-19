"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { Button, useNotify, useTranslations } from "@th/ui";
import { MapPin } from "lucide-react";

import { useFeatureGates } from "@/hooks/useFeatureGates";
import { trpc } from "@/trpc";
import {
  PlaceDialog,
  REFUSAL_COPY,
  type PlaceDialogMode,
} from "@/components/places/PlaceDialog";
import { toRefusalReason } from "@/components/places/place-or-address.helpers";
import { formatErrorMessage } from "@/lib/format-error-message";
import { moderatorPlacePageHref } from "@/lib/places/moderator-place-page-href";

/**
 * Whether "Edit place details" is offered: the same read the control makes
 * (React Query shares it), so the editor's name hint can point at it.
 * "loading" until the check answers; a failed check reads as "locked".
 */
export type PlaceFactsEditable = "loading" | "editable" | "locked";

export function usePlaceFactsEditable(placeId: string): PlaceFactsEditable {
  const editabilityQuery = trpc.community.getPlaceEditability.useQuery(
    { placeId },
    { staleTime: 0, retry: false, meta: { silent: true } },
  );
  if (editabilityQuery.data) {
    return editabilityQuery.data.canEdit ? "editable" : "locked";
  }
  return editabilityQuery.isError ? "locked" : "loading";
}

/**
 * "Edit place details" in the moderator page editor's header: the place's
 * name, address and pin, which stay outside the page draft (owner ruling,
 * moderator-place-page spec). It opens the shared community PlaceDialog
 * (`community.updatePlace`, COMMUNITY_MODERATOR or ADMIN, refused once the
 * place is owned or a claim is in review).
 *
 * Shown only while `community.getPlaceEditability` says the facts can change,
 * and asked again right before the dialog opens (the dialog's contract), so a
 * claim landing in between is said instead of offered.
 */
export function ModeratorPlaceFactsControl({ placeId }: { placeId: string }) {
  const t = useTranslations();
  const tr = useCallback((key: string) => String(t(key)), [t]);
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const { gates } = useFeatureGates();
  const arrivalAreasEnabled = gates?.arrivalAreas === true;
  const router = useRouter();
  const [dialog, setDialog] = useState<PlaceDialogMode | null>(null);
  const [opening, setOpening] = useState(false);
  // The double-press guard: a ref, so a second press in the same tick (before
  // the `opening` state re-renders) is still caught.
  const openingRef = useRef(false);
  const editable = usePlaceFactsEditable(placeId);

  const open = useCallback(async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      const [e, { place }] = await Promise.all([
        utils.community.getPlaceEditability.fetch({ placeId }, { staleTime: 0 }),
        utils.places.getPlacePublic.fetch({ placeId }, { staleTime: 0 }),
      ]);
      if (e.status === "ARCHIVED") {
        // Archived since the editor opened (whatever `reason` says, e.g. a
        // restore-only DUPLICATE_ACTIVE): say so, and let the editor's gate
        // show its archived state.
        toast.danger({
          title: tr("communityPlacePage.refusedArchivedTitle"),
          message: tr("communityPlacePage.refusedArchivedBody"),
        });
        void utils.entityPages.placePageEditAccess.invalidate({ placeId });
        void utils.community.getPlaceEditability.invalidate({ placeId });
        return;
      }
      if (!e.canEdit) {
        // Unknown or restore-only reasons read as "can't be changed here".
        const copy = REFUSAL_COPY[toRefusalReason(e.reason)];
        toast.danger({ title: tr(copy.title), message: tr(copy.body) });
        void utils.community.getPlaceEditability.invalidate({ placeId });
        return;
      }
      setDialog({
        kind: "edit",
        place: {
          placeId: place.placeId,
          name: place.name,
          formattedAddress: place.formattedAddress,
          city: place.city,
          region: place.region,
          lat: place.lat,
          lng: place.lng,
          timezone: null,
          status: place.status,
          verificationStatus: place.verificationStatus,
        },
        canEdit: true,
        canArchive: e.canArchive,
        linkedListingCount: e.linkedListingCount,
        startAt: "form",
        // Not offered here (orchestrator decision): archiving would drop
        // unsaved page edits, and the archived editor offers no restore.
        // Moderators archive from the place panel and the listing form.
        hideArchive: true,
      });
    } catch (err) {
      toast.danger({
        title: tr("communityCreate.pfEditabilityFailed"),
        message: formatErrorMessage(err, t),
      });
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }, [placeId, t, toast, tr, utils]);

  if (editable !== "editable") return null;

  return (
    <>
      <Button
        variant="secondary"
        size="$2"
        // A 44px tap target, matching "Add Block" beside it.
        minHeight={44}
        onPress={() => void open()}
        disabled={opening}
        aria-haspopup="dialog"
        data-testid="moderator-place-facts-edit"
      >
        <MapPin size={14} aria-hidden />
        {tr("communityPlacePage.editPlaceDetails")}
      </Button>
      <PlaceDialog
        mode={dialog}
        onClose={() => {
          setDialog(null);
          void utils.community.getPlaceEditability.invalidate({ placeId });
        }}
        onSaved={() => {
          setDialog(null);
          toast.success({ title: tr("admin.ppDetailUpdated") });
          // The canvas renders the place's name and address from these.
          void utils.entityPages.getMyPage.invalidate({
            ownerType: "PLACE",
            ownerId: placeId,
          });
          void utils.places.getPlacePublic.invalidate({ placeId });
          void utils.community.getPlaceEditability.invalidate({ placeId });
          // A new address moves the pin Getting there draws around (FR-014).
          if (arrivalAreasEnabled) {
            void utils.arrivalAreas.listForEditor.invalidate({ placeId });
          }
        }}
        // A rename that collides with another place: "Use this place" opens
        // that place's page editor, whose own gate answers for it.
        onUseExisting={(existing) => {
          setDialog(null);
          router.push(moderatorPlacePageHref(existing.placeId));
        }}
        onArchived={() => {
          setDialog(null);
          void utils.entityPages.placePageEditAccess.invalidate({ placeId });
        }}
      />
    </>
  );
}
