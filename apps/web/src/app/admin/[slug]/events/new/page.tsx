"use client";

import { use } from "react";

import { QuickCreateEventForm } from "./_components/QuickCreateEventForm";

type PageProps = {
  params: Promise<{ slug: string }>;
};

/**
 * /admin/:slug/events/new — quick create (event-builder regroup FR-301).
 *
 * A focused 3-field form (title / starts-at / venue) that creates a DRAFT
 * through the same `createEventForHuman` / `createEventForOrg` procedures the
 * full builder saves with, then routes to `/admin/:slug/events/:id/edit`
 * (the Build surface). Every "Create Event" entry point routes here via
 * `useCreateDraftEvent` (moderators get the Ticketed-vs-Community choice
 * first; Community goes to `./community` without touching this form).
 *
 * The WORKSPACE rail (not the event rail) renders on this page —
 * `parseEventAdminPath` deliberately nulls `/events/new` (FR-301).
 */
export default function QuickCreateEventPage({ params }: PageProps) {
  const { slug } = use(params);
  return <QuickCreateEventForm slug={slug} />;
}
