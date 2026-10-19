import { z } from "zod";

export type MessageLeaf = string;

export type MessageNode = MessageLeaf | MessageDictionary;

export type MessageDictionary = {
  [key: string]: MessageNode;
};

const messageNodeSchema: z.ZodType<MessageNode> = z.lazy(() =>
  z.union([z.string(), z.record(z.string(), messageNodeSchema)]),
);

export const messageDictionarySchema = z.record(z.string(), messageNodeSchema);

export type MessageCatalog = z.infer<typeof messageDictionarySchema>;
