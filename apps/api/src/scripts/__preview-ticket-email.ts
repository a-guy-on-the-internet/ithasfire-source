/**
 * TEMP preview script — sends the ticket.issued email to Mailpit twice so the
 * claim-link change can be eyeballed. Delete after use.
 *
 *   pnpm -F api exec tsx src/scripts/__preview-ticket-email.ts <orderId>
 */
import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createMailerFromConfig } from "@th/adapters/comms/mail";
import { sendTicketIssuedEmail } from "@th/core/use-cases/orders/send-ticket-issued-email";

async function main() {
  const orderId = process.argv[2];
  if (!orderId) throw new Error("usage: __preview-ticket-email.ts <orderId>");

  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);
  const mailer = createMailerFromConfig({
    defaultFromEmail: process.env.SMTP_DEFAULT_FROM_EMAIL ?? "no-reply@tickethunter.local",
    smtpHost: process.env.SMTP_HOST ?? "127.0.0.1",
    smtpPort: Number(process.env.SMTP_PORT ?? 1025),
    smtpSecure: false,
    plainSmtp: true,
    blockReservedTestDomains: false, // seed buyers are @example.com
  } as never);
  if (!mailer) throw new Error("mailer not configured");

  const base = { repos, mailer } as never;
  const common = {
    orderId,
    publicAppUrl: "http://localhost:3000",
    supportUrl: "http://localhost:3000/support",
  };

  // A) Exactly what production sends for THIS order. The buyer has an auth
  //    account, so the derivation yields no claim link.
  const a = await sendTicketIssuedEmail(base, common);
  console.log("A (as-is, real derivation) ->", a.recipientEmail, "| claim link: none expected");

  // B) The guest variant. Passing accountCompletionUrl explicitly is a real
  //    supported path (grant-volunteer-reward.ts does exactly this); it renders
  //    the same block the derivation produces for a guest buyer.
  const b = await sendTicketIssuedEmail(base, {
    ...common,
    accountCompletionUrl:
      "http://localhost:3000/auth/complete?email=guest%40example.com&src=guest-checkout",
  });
  console.log("B (claim-link variant)    ->", b.recipientEmail, "| claim block rendered");

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
