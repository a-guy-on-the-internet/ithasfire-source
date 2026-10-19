import type { Metadata } from "next";

import { SurpriseMe } from "./_components/SurpriseMe";

export const metadata: Metadata = {
  title: "Surprise me",
  description: "Discover a random event happening near you.",
};

export default async function LuckyPage() {
  return <SurpriseMe />;
}
