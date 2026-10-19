import type { Metadata } from "next";

import { ImageModerationQueue } from "./_components/ImageModerationQueue";

export const metadata: Metadata = {
  title: "Flagged Images",
  description: "Review images held by automated moderation.",
};

export default function ModerateImagesPage() {
  return <ImageModerationQueue />;
}
