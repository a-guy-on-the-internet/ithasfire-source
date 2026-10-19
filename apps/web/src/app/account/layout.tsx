import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AccountShell } from "./_components/AccountShell";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AccountLayout({ children }: { children: ReactNode }) {
  return <AccountShell>{children}</AccountShell>;
}
