"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@bprogress/next/app";

import { trpc } from "@/trpc";
import { EventModeChoiceDialog } from "@/components/events/EventModeChoiceDialog";
import {
  buildQuickCreatePrefillQuery,
  sanitizeQuickCreatePrefill,
  type QuickCreatePrefill,
} from "@/lib/quick-create-prefill";
import { guardedNavigate } from "./navigation-guard";
import { useCurrentAdminOwner } from "./useCurrentAdminOwner";

/**
 * Hook that encapsulates the "create an event" entry-point flow. Every
 * "Create Event" button in the admin area should use this.
 *
 * Quick create (event-builder regroup FR-301): `createDraft` navigates to
 * `/admin/:slug/events/new` — a focused 3-field form (title / starts-at /
 * venue) that creates the DRAFT via the draft-upsert procedures and lands in
 * the full builder. No untitled draft is minted from the button anymore; the
 * quick-create page owns the mutation (and its quota-exceeded handling).
 *
 * Community moderators (community-managed-event-listings spec, FR-005) get
 * a mode-choice step first: `createDraft` opens a "Ticketed event vs
 * Community listing" dialog. Choosing Ticketed goes to quick create;
 * choosing Community navigates to `/admin/:slug/events/new/community`.
 * Callers must render the returned `modeChoiceDialog` element (it renders
 * nothing for non-moderators).
 *
 * API note: this hook no longer mutates, so it exposes no pending or
 * quota-exceeded state. Quota feedback belongs to whoever owns the mutation —
 * the quick-create page (`QuickCreateEventForm`) renders its own
 * `<QuotaExceededDialog>`. The inert `isPending` / `quotaMeta` /
 * `clearQuotaMeta` this hook used to return (hard-wired false/null/no-op)
 * were removed along with the caller dialogs and spinners they could never
 * trigger.
 *
 * Calendar-cell create (venue-hierarchy FR-011): `createDraftAt(prefill)` is
 * the same flow with the clicked cell's context appended to the quick-create
 * URL (`?startsAt=…&placeId=…`). It is a SEPARATE function rather than an
 * optional argument on `createDraft` deliberately — `createDraft` is bound
 * straight to `onPress` all over the admin, and an optional first parameter
 * would silently receive a gesture event. (The payload is sanitized anyway;
 * the split just keeps the types honest.) The prefill survives the moderator
 * Ticketed-vs-Community dialog: choosing Ticketed lands on the same prefilled
 * quick-create page.
 *
 * Usage:
 * ```ts
 * const { createDraft, createDraftAt, modeChoiceDialog } = useCreateDraftEvent(slug);
 * <Button onPress={createDraft}>Create Event</Button>
 * {modeChoiceDialog}
 * ```
 */
export function useCreateDraftEvent(slug: string) {
  const router = useRouter();
  const { currentOwner } = useCurrentAdminOwner(slug);

  // Moderator gate for the Community-vs-Ticketed mode choice (community-
  // managed-event-listings spec). Only fired once an owner is resolved
  // (i.e. the viewer is signed in); a pending or errored check falls
  // through to the ticketed quick-create flow so the button never blocks.
  //
  // TESTING NOTE: suites that render components consuming this hook should
  // mock the HOOK wholesale rather than stubbing @/trpc piecemeal (see
  // AdminShell.test.tsx's vi.mock of @/hooks/useCreateDraftEvent for the
  // precedent) — the mock shape must include `modeChoiceDialog: null`.
  const moderatorAccessQuery = trpc.community.checkModeratorAccess.useQuery(
    undefined,
    {
      enabled: !!currentOwner,
      retry: false,
      staleTime: 5 * 60_000,
      meta: { silent: true },
    },
  );
  const isModerator = moderatorAccessQuery.data?.allowed === true;

  const [modeChoiceOpen, setModeChoiceOpen] = useState(false);
  /**
   * Prefill parked while the moderator mode-choice dialog is open. A ref, not
   * state: nothing renders from it, and re-rendering the dialog on every cell
   * click would be pure churn. Cleared once consumed so a later plain
   * "Create Event" press can't inherit a stale date.
   */
  const pendingPrefillRef = useRef<QuickCreatePrefill>({});

  /**
   * The admin context the draft is created UNDER. Normally the hook's own
   * slug; the dashboard calendar passes an ORG's slug when exactly one org is
   * selected on a personal dashboard, so the builder opens in that org's
   * context. Parked alongside the prefill because the moderator mode-choice
   * dialog sits between the click and the navigation, and the choice must
   * land in the same context the click did.
   */
  const pendingSlugRef = useRef<string | null>(null);

  const goToQuickCreate = useCallback(
    (prefill?: QuickCreatePrefill, targetSlug?: string | null) => {
      // Through the open page's unsaved-changes guard, if any.
      guardedNavigate(() =>
        router.push(
          `/admin/${targetSlug || slug}/events/new${buildQuickCreatePrefillQuery(prefill)}`,
        ),
      );
    },
    [router, slug],
  );

  const startDraft = useCallback(
    (prefill: QuickCreatePrefill, targetSlug?: string) => {
      if (!currentOwner) return;
      if (isModerator) {
        // Moderators choose Ticketed vs Community first.
        pendingPrefillRef.current = prefill;
        pendingSlugRef.current = targetSlug ?? null;
        setModeChoiceOpen(true);
        return;
      }
      goToQuickCreate(prefill, targetSlug);
    },
    [currentOwner, isModerator, goToQuickCreate],
  );

  const createDraft = useCallback(() => {
    startDraft({});
  }, [startDraft]);

  /**
   * Prefilled variant — see the hook doc. Payload is sanitized, never trusted.
   * `opts.slug` re-points the draft at another admin context (see
   * `pendingSlugRef`); the moderator chooser still runs first either way.
   */
  const createDraftAt = useCallback(
    (prefill: QuickCreatePrefill, opts?: { slug?: string }) => {
      startDraft(sanitizeQuickCreatePrefill(prefill), opts?.slug);
    },
    [startDraft],
  );

  const closeModeChoice = useCallback(() => {
    setModeChoiceOpen(false);
    pendingPrefillRef.current = {};
    pendingSlugRef.current = null;
  }, []);

  const handleChooseTicketed = useCallback(() => {
    setModeChoiceOpen(false);
    const prefill = pendingPrefillRef.current;
    const targetSlug = pendingSlugRef.current;
    pendingPrefillRef.current = {};
    pendingSlugRef.current = null;
    goToQuickCreate(prefill, targetSlug);
  }, [goToQuickCreate]);

  const handleChooseCommunity = useCallback(() => {
    setModeChoiceOpen(false);
    // The community listing form has no prefill seam — drop the parked
    // payload rather than leaving it to leak into a later Ticketed choice.
    const targetSlug = pendingSlugRef.current;
    pendingPrefillRef.current = {};
    pendingSlugRef.current = null;
    guardedNavigate(() =>
      router.push(`/admin/${targetSlug || slug}/events/new/community`),
    );
  }, [router, slug]);

  // Rendered by callers next to their trigger. Only mounted for moderators
  // so non-moderator surfaces stay byte-identical to the pre-community flow.
  const modeChoiceDialog: ReactNode = isModerator ? (
    <EventModeChoiceDialog
      open={modeChoiceOpen}
      onClose={closeModeChoice}
      onTicketed={handleChooseTicketed}
      onCommunity={handleChooseCommunity}
      pending={false}
    />
  ) : null;

  return {
    createDraft,
    createDraftAt,
    modeChoiceDialog,
  };
}
