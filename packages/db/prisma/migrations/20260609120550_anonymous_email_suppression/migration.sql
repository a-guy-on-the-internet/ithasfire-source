-- CreateTable
CREATE TABLE "AnonymousEmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'unsubscribe',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnonymousEmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnonymousEmailSuppression_orgId_idx" ON "AnonymousEmailSuppression"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "AnonymousEmailSuppression_email_orgId_key" ON "AnonymousEmailSuppression"("email", "orgId");
