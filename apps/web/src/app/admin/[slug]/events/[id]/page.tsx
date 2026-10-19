import { redirect } from "next/navigation";

/**
 * `/admin/:slug/events/:id` is a pure redirector (event-builder regroup
 * FR-201): the tab-driven builder that lived here moved to real routes.
 * Legacy `?tab=` deep links (emails, bookmarks) map to the new
 * routes; any OTHER query params are preserved across the redirect.
 *
 * `?tab=seating` is special: the seating editor is a full-screen takeover
 * over the Build surface (FR-205), so it redirects to the edit surface with
 * `?seating=legacy`, which opens the takeover on mount.
 */
const TAB_ROUTE_SEGMENTS: Record<string, string> = {
  edit: "edit",
  attendees: "attendees",
  volunteers: "volunteers",
  comp: "comp-tickets",
  suggestions: "suggestions",
  feedback: "feedback",
};

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminEventDetailRedirect({
  params,
  searchParams,
}: PageProps) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const tab = typeof sp.tab === "string" ? sp.tab : undefined;

  // Preserve every non-`tab` query param so deep links like
  // `?tab=comp&foo=1` land on `/comp-tickets?foo=1`.
  const passthrough = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key === "tab") continue;
    if (typeof value === "string") {
      passthrough.append(key, value);
    } else if (Array.isArray(value)) {
      for (const v of value) passthrough.append(key, v);
    }
  }

  let segment: string;
  if (tab === "seating") {
    segment = "edit";
    passthrough.set("seating", "legacy");
  } else if (tab === "preview") {
    // The old preview tab is back as an in-view toggle on the edit surface
    // (D4 reversed 2026-07-28) — deep-link straight into it.
    segment = "edit";
    passthrough.set("view", "preview");
  } else {
    // Unknown / missing tab → the edit surface.
    segment = (tab && TAB_ROUTE_SEGMENTS[tab]) || "edit";
  }

  const query = passthrough.toString();
  redirect(
    `/admin/${slug}/events/${id}/${segment}${query ? `?${query}` : ""}`,
  );
}
