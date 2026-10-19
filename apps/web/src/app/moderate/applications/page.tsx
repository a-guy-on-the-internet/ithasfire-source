import type { Metadata } from "next";

import { ApplicationsQueue } from "./_components/ApplicationsQueue";

export const metadata: Metadata = {
  title: "Moderator Applications",
  description: "Review community moderator applications.",
};

export default function ModerateApplicationsPage() {
  return <ApplicationsQueue />;
}
