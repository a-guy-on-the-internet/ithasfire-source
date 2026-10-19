import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AdminSlugIndex({
  params,
}: {
  params?: Promise<{ slug: string }>;
}) {
  const resolvedParams = await (params ?? Promise.resolve({ slug: "" }));
  const slug = resolvedParams.slug;

  // Redirect to the dashboard - the dashboard page and shell handle auth.
  redirect(`/admin/${slug}/dashboard`);
}
