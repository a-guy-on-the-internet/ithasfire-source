import type { Metadata } from "next";
import { FeaturesContent } from "./_components/FeaturesContent";

export const metadata: Metadata = {
  title: "Features",
  description:
    "Everything Ithas Fire can do — ticketing and checkout, artist booking, place tools, payments and payouts, scanning, reviews, and discovery. One connected platform for organizers, artists, places, and fans.",
};

export default function FeaturesPage() {
  return <FeaturesContent />;
}
