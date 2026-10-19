import type { Metadata } from "next";
import { Search } from "lucide-react";

import {
  StatusScreen,
  ButtonPrimary,
  ButtonRow,
  STATUS_ICON,
  STATUS_ICON_BG,
} from "@/components/layout/PagePrimitives";

export const metadata: Metadata = {
  title: "Access Denied",
};

export default function AccessDeniedPage() {
  return (
    <StatusScreen
      icon={Search}
      iconColor={STATUS_ICON}
      iconBg={STATUS_ICON_BG}
      title="Access denied"
      description="You don't have permission to access this page."
    >
      <ButtonRow>
        <ButtonPrimary href="/">Go home</ButtonPrimary>
      </ButtonRow>
    </StatusScreen>
  );
}
