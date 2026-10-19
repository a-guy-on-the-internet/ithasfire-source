export {
  sendSupportMessage,
  sendSupportMessageInputSchema,
  sendSupportMessageOutputSchema,
  type SendSupportMessageInput,
  type SendSupportMessageOutput,
  type SendSupportMessageDeps,
} from "./send-support-message";

export {
  getSupportMessages,
  getSupportMessagesInputSchema,
  getSupportMessagesOutputSchema,
  type GetSupportMessagesInput,
  type GetSupportMessagesOutput,
  type GetSupportMessagesDeps,
} from "./get-support-messages";

export {
  listSupportThreads,
  listSupportThreadsInputSchema,
  listSupportThreadsOutputSchema,
  type ListSupportThreadsInput,
  type ListSupportThreadsOutput,
  type ListSupportThreadsDeps,
} from "./list-support-threads";

export {
  replyToSupportThread,
  replyToSupportThreadInputSchema,
  replyToSupportThreadOutputSchema,
  type ReplyToSupportThreadInput,
  type ReplyToSupportThreadOutput,
  type ReplyToSupportThreadDeps,
} from "./reply-to-support-thread";

export {
  setSupportThreadStatus,
  setSupportThreadStatusInputSchema,
  setSupportThreadStatusOutputSchema,
  type SetSupportThreadStatusInput,
  type SetSupportThreadStatusOutput,
  type SetSupportThreadStatusDeps,
} from "./set-support-thread-status";

export {
  getMyActiveThread,
  getMyActiveThreadInputSchema,
  getMyActiveThreadOutputSchema,
  type GetMyActiveThreadInput,
  type GetMyActiveThreadOutput,
  type GetMyActiveThreadDeps,
} from "./get-my-active-thread";

export {
  markThreadRead,
  markThreadReadInputSchema,
  markThreadReadOutputSchema,
  type MarkThreadReadInput,
  type MarkThreadReadOutput,
  type MarkThreadReadDeps,
} from "./mark-thread-read";

export {
  purgeResolvedSupportThreads,
  purgeResolvedSupportThreadsInputSchema,
  purgeResolvedSupportThreadsOutputSchema,
  type PurgeResolvedSupportThreadsInput,
  type PurgeResolvedSupportThreadsOutput,
  type PurgeResolvedSupportThreadsDeps,
} from "./purge-resolved-threads";

export {
  SUPPORT_MESSAGE_MAX,
  supportThreadSchema,
  supportThreadStaffSchema,
  supportMessageSchema,
  type SupportThreadDto,
  type SupportThreadStaffDto,
  type SupportMessageDto,
  type NotifySupportFn,
  type NotifySupportInput,
  type SupportAlertReason,
} from "./schemas";

export { SUPPORT_STAFF_ROLES } from "./roles";
