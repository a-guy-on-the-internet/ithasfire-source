import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const plugin: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("*", { parseAs: "buffer" }, (req, body, done) =>
    done(null, body),
  );
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      try {
        if (typeof body !== "string") {
          done(null, body);
          return;
        }

        // Webhook signing requires the raw request body.
        // Preserve it as a Buffer specifically for the webhook route so
        // provider SDKs can verify signatures.
        if (
          req.raw.url === "/webhooks/stripe" ||
          req.raw.url === "/webhooks/resend" ||
          req.raw.url === "/webhooks/aws/sms-inbound"
        ) {
          done(null, Buffer.from(body, "utf8"));
          return;
        }

        const parsed = JSON.parse(body) as unknown;

        // E2E/debug helper: log Better Auth sign-up email at parse time.
        // This is the earliest, most reliable place to observe the payload.
        // Intentionally omits password.
        if (
          process.env.NODE_ENV !== "production" &&
          req.raw.url === "/api/auth/sign-up/email"
        ) {
          try {
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              "email" in parsed
            ) {
              const email = (parsed as { email?: unknown }).email;
              if (typeof email === "string") {
                // Use the app's JSON logger so this shows up in detached logs.
                app.log.info(
                  {
                    requestId: (req as unknown as { id?: string }).id,
                    method: req.method,
                    url: req.url,
                    authSignUpEmailAttempt: email,
                  },
                  "e2e_auth_sign_up_email_attempt",
                );
              }
            }
          } catch {
            // ignore
          }
        }

        done(null, parsed);
      } catch (err) {
        done(err as Error);
      }
    },
  );
};

export default fp(plugin as unknown as never) as unknown as never;
