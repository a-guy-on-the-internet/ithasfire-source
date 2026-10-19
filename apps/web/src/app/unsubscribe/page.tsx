import type { Metadata } from "next";
import { UnsubscribeClient } from "./_components/UnsubscribeClient";

export const metadata: Metadata = {
  title: "Unsubscribe",
};

type Props = {
  searchParams: Promise<{
    kind?: string;
    listId?: string;
    eventId?: string;
    orgId?: string;
    humanId?: string;
    email?: string;
    token?: string;
  }>;
};

export default async function UnsubscribePage({ searchParams }: Props) {
  const params = await searchParams;
  return (
    <UnsubscribeClient
      kind={
        (params.kind as
          | "contact_list"
          | "waitlist"
          | "org"
          | "review-prompts") ?? null
      }
      listId={params.listId ?? null}
      eventId={params.eventId ?? null}
      orgId={params.orgId ?? null}
      humanId={params.humanId ?? null}
      email={params.email ?? null}
      token={params.token ?? null}
    />
  );
}
