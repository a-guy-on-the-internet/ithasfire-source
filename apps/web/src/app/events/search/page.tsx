/**
 * /events/search — permanent redirect to the unified /search route.
 *
 * All query parameters (search, near, place, lat, lng, radius) are forwarded
 * so bookmarks and external links continue to work.
 */
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const resolveSearchParam = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
};

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function EventsSearchRedirect({ searchParams }: Props) {
  const sp = searchParams ? await searchParams : undefined;

  const params = new URLSearchParams();
  const forward = ["search", "near", "place", "lat", "lng", "radius"];
  for (const key of forward) {
    const val = resolveSearchParam(sp?.[key]);
    if (val) params.set(key, val);
  }

  const qs = params.toString();
  redirect(`/search${qs ? `?${qs}` : ""}`);
}
