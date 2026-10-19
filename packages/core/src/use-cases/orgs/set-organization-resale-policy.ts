/**
 * DEPRECATED alias: renamed to `setDefaultAgreement` (organiser-resale-share
 * FR-012). Kept while the web settings page still calls the old tRPC
 * procedure `orgs.setOrganizationResalePolicy`; remove both when C2 moves the
 * page to `default-agreement/` and `orgs.setDefaultAgreement`.
 */
export {
  setDefaultAgreement as setOrganizationResalePolicy,
  setDefaultAgreementInputSchema as setOrganizationResalePolicyInputSchema,
  setDefaultAgreementOutputSchema as setOrganizationResalePolicyOutputSchema,
  type SetDefaultAgreementDeps as SetOrganizationResalePolicyDeps,
  type SetDefaultAgreementInput as SetOrganizationResalePolicyInput,
  type SetDefaultAgreementOutput as SetOrganizationResalePolicyOutput,
} from "./set-default-agreement";
