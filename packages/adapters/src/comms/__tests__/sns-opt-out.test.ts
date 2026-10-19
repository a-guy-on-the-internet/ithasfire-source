import { describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SNSClient,
  CheckIfPhoneNumberIsOptedOutCommand,
  ListPhoneNumbersOptedOutCommand,
} from "@aws-sdk/client-sns";

import { SnsProviderOptOutAdapter } from "../sns-opt-out";

describe("SnsProviderOptOutAdapter", () => {
  it("reports a number as opted out when SNS says so", async () => {
    const client = new SNSClient({ region: "us-east-1" });
    const snsMock = mockClient(
      SNSClient as unknown as new (...args: any[]) => any,
    );
    snsMock
      .on(CheckIfPhoneNumberIsOptedOutCommand as unknown as new (
        ...args: any[]
      ) => any)
      .resolves({ isOptedOut: true } as any);

    const adapter = new SnsProviderOptOutAdapter({ client });
    await expect(adapter.isOptedOut("+15555550123")).resolves.toBe(true);

    const call = snsMock.commandCalls(
      CheckIfPhoneNumberIsOptedOutCommand as any,
    )[0];
    expect(call?.args[0].input).toMatchObject({
      phoneNumber: "+15555550123",
    });
  });

  it("reports a number as not opted out", async () => {
    const client = new SNSClient({ region: "us-east-1" });
    const snsMock = mockClient(
      SNSClient as unknown as new (...args: any[]) => any,
    );
    snsMock
      .on(CheckIfPhoneNumberIsOptedOutCommand as unknown as new (
        ...args: any[]
      ) => any)
      .resolves({ isOptedOut: false } as any);

    const adapter = new SnsProviderOptOutAdapter({ client });
    await expect(adapter.isOptedOut("+15555550124")).resolves.toBe(false);
  });

  it("treats a missing isOptedOut flag as not opted out", async () => {
    const client = new SNSClient({ region: "us-east-1" });
    const snsMock = mockClient(
      SNSClient as unknown as new (...args: any[]) => any,
    );
    snsMock
      .on(CheckIfPhoneNumberIsOptedOutCommand as unknown as new (
        ...args: any[]
      ) => any)
      .resolves({} as any);

    const adapter = new SnsProviderOptOutAdapter({ client });
    await expect(adapter.isOptedOut("+15555550125")).resolves.toBe(false);
  });

  it("paginates the opted-out list across nextToken pages", async () => {
    const client = new SNSClient({ region: "us-east-1" });
    const snsMock = mockClient(
      SNSClient as unknown as new (...args: any[]) => any,
    );
    snsMock
      .on(ListPhoneNumbersOptedOutCommand as unknown as new (
        ...args: any[]
      ) => any)
      .resolvesOnce({
        phoneNumbers: ["+15555550001", "+15555550002"],
        nextToken: "page-2",
      } as any)
      .resolvesOnce({
        phoneNumbers: ["+15555550003"],
      } as any);

    const adapter = new SnsProviderOptOutAdapter({ client });
    await expect(adapter.listOptedOut()).resolves.toEqual([
      "+15555550001",
      "+15555550002",
      "+15555550003",
    ]);

    expect(
      snsMock.commandCalls(ListPhoneNumbersOptedOutCommand as any).length,
    ).toBe(2);
  });
});
