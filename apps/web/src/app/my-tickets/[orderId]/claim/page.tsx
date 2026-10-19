import type { Metadata } from "next";

import { getHelpTranslator } from "@/app/help/_lib/server-i18n";
import { FileClaim } from "./_components/FileClaim";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getHelpTranslator();
  return {
    title: t("resaleClaim.pageTitle"),
  };
}

type PageProps = {
  params: Promise<{ orderId: string }>;
};

export default async function FileClaimPage({ params }: PageProps) {
  const { orderId } = await params;
  return <FileClaim orderId={orderId} />;
}
