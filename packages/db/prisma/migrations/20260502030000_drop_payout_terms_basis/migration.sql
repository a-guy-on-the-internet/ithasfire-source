-- Drop the unused `basis` column on PayoutTerms.
--
-- The `basis` field used to control whether payee splits multiplied
-- against gross order amount (`GROSS`) or post-platform-fee net
-- (`NET_AFTER_PLATFORM_FEES`). The codebase now treats splits as ALWAYS
-- dividing 100% of the seller's post-fee net — both the editor, the
-- publish gate, and the settlement pipeline (`computeAgreementBasis`
-- in `finalize-from-payment-intent.ts`) hard-code this rule.
--
-- Any historical row with `basis = 'GROSS'` was already misleading
-- since the editor / publish gate enforced the post-fee-net target;
-- dropping the column eliminates the dead config knob entirely.

ALTER TABLE "PayoutTerms" DROP COLUMN "basis";
DROP TYPE "PayoutTermsBasis";
