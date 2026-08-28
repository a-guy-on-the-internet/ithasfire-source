// import fp from "fastify-plugin";
// import { stripe } from "../../lib/stripe";

// export default fp(async (app) => {
//   app.post("/payees/:subjectType/:subjectId/connect/express/start", async (req, reply) => {
//     const { subjectType, subjectId } = req.params as any;
//     const { email, business_type = "individual" } = (req.body ?? {}) as any;

//     const acct = await stripe.accounts.create({
//       type: "express", email, business_type,
//       capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
//     });

//     const link = await stripe.accountLinks.create({
//       account: acct.id, type: "account_onboarding",
//       refresh_url: `${process.env.APP_BASE_URL}/connect/refresh`,
//       return_url: `${process.env.APP_BASE_URL}/connect/return`,
//     });

//     return reply.send({ subjectType, subjectId, accountId: acct.id, url: link.url });
//   });
// });
