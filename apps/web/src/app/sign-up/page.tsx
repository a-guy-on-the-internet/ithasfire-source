"use client";

import { Suspense } from "react";

import { StandaloneAuthPageShell } from "@/components/auth/StandaloneAuthPageShell";

const SignUpPageContent = () => (
  <StandaloneAuthPageShell initialPanel="sign-up" />
);

export default function SignUpPage() {
  return (
    <Suspense fallback={null}>
      <SignUpPageContent />
    </Suspense>
  );
}
