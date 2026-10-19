"use client";

/**
 * TicketTypeTemplateControls — the "Save as Template" / "Apply Template" pair
 * for the ticket-type section header of the event builder.
 *
 * Templates belong to the EVENT's owner, not to the workspace in the URL: a
 * delegate editing a principal's event (their URL slug is their own
 * workspace) lists, applies and saves templates in the PRINCIPAL's library.
 * The builder resolves that owner once (`toTemplateOwnerRef` over its
 * `ownerType`/`ownerId`) and passes it down; the server authorizes a delegate
 * against a HUMAN library (`ensureTemplateOwnerAccess`).
 *
 * "Customise" (fork a catalogue template) asks MORE than save/apply: org
 * OWNER/ADMIN, or the owner / an OWNER/ADMIN delegate on a personal library
 * (`fork-platform-ticket-template.ts`). `canCustomiseTemplates` carries that
 * bar — the builder's `canManageEvent` — so an EDITOR is not offered it.
 */

import { useState } from "react";
import { Save, LayoutTemplate } from "lucide-react";

import { Button, useTranslations } from "@th/ui";

import { SaveTicketTypeTemplateDialog } from "./SaveTicketTypeTemplateDialog";
import { ApplyTicketTypeTemplateDialog } from "./ApplyTicketTypeTemplateDialog";
import type {
  TemplateOwnerRef,
  TicketTypeForTemplate,
} from "./ticket-type-template-helpers";

// Re-exported so the dialogs' existing type imports keep resolving; the type
// and its mapper live in the pure helpers module.
export type { TemplateOwnerRef } from "./ticket-type-template-helpers";

export type TicketTypeTemplateControlsProps = {
  eventId: string;
  /** The EVENT's owner — whose template library to list and save into. */
  templateOwner: TemplateOwnerRef;
  /** Offer "Customise" on catalogue templates (the fork's admin bar). */
  canCustomiseTemplates: boolean;
  /** The event's current ticket types (source for "Save as Template"). */
  ticketTypes: readonly TicketTypeForTemplate[];
  /** When true, the apply dialog notes that applied types arrive unseated. */
  hasSeatingLayout?: boolean;
};

export function TicketTypeTemplateControls({
  eventId,
  templateOwner,
  canCustomiseTemplates,
  ticketTypes,
  hasSeatingLayout = false,
}: TicketTypeTemplateControlsProps) {
  const t = useTranslations();

  const [saveOpen, setSaveOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);

  return (
    <>
      {ticketTypes.length > 0 && (
        <Button
          variant="ghost"
          size="$2"
          onPress={() => setSaveOpen(true)}
          data-testid="ticket-type-template-save-btn"
        >
          <Save size={14} aria-hidden />
          {String(t("admin.ttTplSaveButton"))}
        </Button>
      )}
      <Button
        variant="ghost"
        size="$2"
        onPress={() => setApplyOpen(true)}
        data-testid="ticket-type-template-apply-btn"
      >
        <LayoutTemplate size={14} aria-hidden />
        {String(t("admin.ttTplApplyButton"))}
      </Button>

      {saveOpen ? (
        <SaveTicketTypeTemplateDialog
          owner={templateOwner}
          ticketTypes={ticketTypes}
          onClose={() => setSaveOpen(false)}
        />
      ) : null}
      {applyOpen ? (
        <ApplyTicketTypeTemplateDialog
          owner={templateOwner}
          eventId={eventId}
          hasSeatingLayout={hasSeatingLayout}
          canCustomise={canCustomiseTemplates}
          onClose={() => setApplyOpen(false)}
        />
      ) : null}
    </>
  );
}
