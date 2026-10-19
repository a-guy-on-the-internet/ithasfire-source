import { describe, expect, it, vi } from "vitest";

import { SMTPMailAdapter, type NodemailerTransport } from "../smtp-mail";

const HOSTILE = 'x" <evil@x.io>, "y';

describe("SMTPMailAdapter display names", () => {
  it("quote-escapes to/from/replyTo display names so they can't add a mailbox", async () => {
    const sendMail = vi.fn(async () => ({
      messageId: "<m@x>",
      accepted: ["victim@example.com"],
      rejected: [],
      response: "250 OK",
    }));
    const adapter = new SMTPMailAdapter({
      host: "localhost",
      port: 1025,
      defaultFromEmail: "sender@example.com",
      transporter: { sendMail } as unknown as NodemailerTransport,
    });

    await adapter.send({
      to: { to: "victim@example.com", name: HOSTILE },
      from: { to: "sender@example.com", name: HOSTILE },
      replyTo: { to: "reply@example.com", name: HOSTILE },
      subject: "Hello",
      text: "Body",
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = (sendMail.mock.calls[0] as unknown[])[0] as {
      to: string[];
      from: string;
      replyTo: string;
    };
    expect(message.to).toEqual([
      '"x\\" <evil@x.io>, \\"y" <victim@example.com>',
    ]);
    expect(message.from).toBe('"x\\" <evil@x.io>, \\"y" <sender@example.com>');
    expect(message.replyTo).toBe(
      '"x\\" <evil@x.io>, \\"y" <reply@example.com>',
    );
  });

  it("collapses a CR/LF in a display name instead of passing it through", async () => {
    const sendMail = vi.fn(async () => ({
      messageId: "<m@x>",
      accepted: [],
      rejected: [],
      response: "250 OK",
    }));
    const adapter = new SMTPMailAdapter({
      host: "localhost",
      port: 1025,
      defaultFromEmail: "sender@example.com",
      transporter: { sendMail } as unknown as NodemailerTransport,
    });

    await adapter.send({
      to: { to: "victim@example.com", name: "Mallory\r\nBcc: a@b.c" },
      subject: "Hello",
      text: "Body",
    });

    const message = (sendMail.mock.calls[0] as unknown[])[0] as { to: string[] };
    expect(message.to).toEqual(['"Mallory Bcc: a@b.c" <victim@example.com>']);
  });
});
