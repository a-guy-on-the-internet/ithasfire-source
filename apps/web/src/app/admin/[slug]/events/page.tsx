"use client";

import { use, useMemo, useCallback } from "react";
import { useTranslations } from "@th/ui";
import { ORG_EDIT_ROLES, ORG_ADMIN_ROLES } from "@th/types";

import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";
import { EventsManager } from "./_components/EventsManager";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { useCreateDraftEvent } from "@/hooks/useCreateDraftEvent";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export default function AdminEventsPage({ params }: PageProps) {
  const { slug } = use(params);
  const t = useTranslations();
  const { currentOwner, isLoading } = useCurrentAdminOwner(slug);

  const ownerContext = useMemo(() => {
    if (!currentOwner) return null;
    return currentOwner.kind === "human"
      ? { kind: "human" as const, humanId: currentOwner.humanId }
      : { kind: "org" as const, orgId: currentOwner.orgId };
  }, [currentOwner]);

  const { gates } = useFeatureGates();
  const canCreateEvents = gates?.createEvents !== false;

  // Content-edit capability. Humans editing their own profile-owned events
  // always have edit rights; for orgs, only ORG_EDIT_ROLES (OWNER/ADMIN/EDITOR)
  // may create/edit/comp. VIEWER/FINANCE/SCANNER reach the list for read +
  // share. Mirrors admin/[slug]/events/[id]/page.tsx's canEditEvent.
  // Server-side use-case checks remain the authorization boundary.
  const canEdit = useMemo(() => {
    if (!currentOwner) return false;
    return (
      currentOwner.kind === "human" ||
      ORG_EDIT_ROLES.includes(currentOwner.role)
    );
  }, [currentOwner]);

  // Destructive management capability (Cancel/Delete event). Narrower than
  // canEdit: the server use-cases enforce ORG_ADMIN_ROLES (OWNER/ADMIN only —
  // cancel-event.ts / delete-event.ts), so an EDITOR must NOT see these or the
  // action would 403. Profile-owner humans manage their own events.
  const canManage = useMemo(() => {
    if (!currentOwner) return false;
    return (
      currentOwner.kind === "human" ||
      ORG_ADMIN_ROLES.includes(currentOwner.role)
    );
  }, [currentOwner]);

  const { createDraft: handleCreateEvent, modeChoiceDialog } =
    useCreateDraftEvent(slug);

  const getEditUrl = useCallback(
    (event: { id: string }) => `/admin/${slug}/events/${event.id}/edit`,
    [slug],
  );

  const getViewUrl = useCallback(
    (event: { slug: string | null; id: string }) =>
      event.slug ? `/events/${event.slug}` : `/events/${event.id}`,
    [],
  );

  const getAttendeesUrl = useCallback(
    (event: { id: string }) =>
      `/admin/${slug}/events/${event.id}/attendees`,
    [slug],
  );

  const getVolunteersUrl = useCallback(
    (event: { id: string }) =>
      `/admin/${slug}/events/${event.id}/volunteers`,
    [slug],
  );

  const getCompUrl = useCallback(
    (event: { id: string }) =>
      `/admin/${slug}/events/${event.id}/comp-tickets`,
    [slug],
  );

  const getDatesUrl = useCallback(
    (event: { id: string }) => `/admin/${slug}/events/${event.id}/dates`,
    [slug],
  );

  if (isLoading) {
    return (
      <div style={{ padding: "1.5rem" }}>
        <p>{String(t("admin.loadingEvents"))}</p>
      </div>
    );
  }

  if (!ownerContext) {
    return (
      <div style={{ padding: "1.5rem" }}>
        <p>{String(t("admin.unableToDetermineOwner"))}</p>
      </div>
    );
  }

  return (
    <>
      <AdminEmailVerificationGate mode="block">
        <EventsManager
          ownerContext={ownerContext}
          title={String(t("admin.myEvents"))}
          onCreateEvent={handleCreateEvent}
          getEditUrl={getEditUrl}
          getViewUrl={getViewUrl}
          getAttendeesUrl={getAttendeesUrl}
          getVolunteersUrl={getVolunteersUrl}
          getCompUrl={getCompUrl}
          getDatesUrl={getDatesUrl}
          showCreateButton={canCreateEvents}
          canEdit={canEdit}
          canManage={canManage}
        />
      </AdminEmailVerificationGate>

      {modeChoiceDialog}
    </>
  );
}
