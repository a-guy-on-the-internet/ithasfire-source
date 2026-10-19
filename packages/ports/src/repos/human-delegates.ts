import type {
  AddHumanDelegateInput,
  CountHumanDelegatesByRoleInput,
  GetHumanDelegationInput,
  HumanDelegateRecord,
  ListHumanDelegatesInput,
  ListHumanDelegatesResult,
  ListPrincipalsForDelegateInput,
  RemoveHumanDelegateInput,
} from "@th/types/repos/human-delegates";

export interface HumanDelegatesRepo {
  /** Upsert a delegation (create or update role). */
  addDelegate(input: AddHumanDelegateInput): Promise<HumanDelegateRecord>;

  /** Get the delegation between a principal and delegate, if any. */
  getDelegation(
    input: GetHumanDelegationInput,
  ): Promise<HumanDelegateRecord | null>;

  /**
   * The reverse of `getDelegation`: the principal ids for whom `delegateId`
   * is a delegate holding one of `roles`, sorted ascending. One query. See
   * {@link ListPrincipalsForDelegateInput}.
   */
  listPrincipalsForDelegate(
    input: ListPrincipalsForDelegateInput,
  ): Promise<string[]>;

  /** List delegates of a principal with human identity info. */
  listDelegates(
    input: ListHumanDelegatesInput,
  ): Promise<ListHumanDelegatesResult>;

  /** Remove a delegate from a principal. Returns true if a row was deleted. */
  removeDelegate(input: RemoveHumanDelegateInput): Promise<boolean>;

  /** Count delegates of a principal with a specific role. */
  countDelegatesByRole(input: CountHumanDelegatesByRoleInput): Promise<number>;
}

export type {
  AddHumanDelegateInput,
  CountHumanDelegatesByRoleInput,
  GetHumanDelegationInput,
  HumanDelegateItem,
  HumanDelegateRecord,
  ListHumanDelegatesInput,
  ListHumanDelegatesResult,
  ListPrincipalsForDelegateInput,
  RemoveHumanDelegateInput,
} from "@th/types/repos/human-delegates";
