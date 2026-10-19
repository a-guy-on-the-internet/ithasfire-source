declare module "nodemailer" {
  import SMTPTransport = require("nodemailer/lib/smtp-transport");

  type AddressLike = string | { name?: string; address: string };

  export interface SendMailOptions {
    from?: AddressLike;
    to?: AddressLike | AddressLike[];
    subject?: string;
    text?: string;
    html?: string;
    replyTo?: AddressLike;
    headers?: Record<string, string | number | Date>;
    attachments?: SMTPTransport.Attachment[];
  }

  export interface Transporter<T = SMTPTransport.SentMessageInfo> {
    sendMail(mailOptions: SendMailOptions): Promise<T>;
    verify(): Promise<void>;
    close?(): void;
  }

  export function createTransport(
    opts?: SMTPTransport.Options | string,
  ): Transporter<SMTPTransport.SentMessageInfo>;
}

declare module "nodemailer/lib/smtp-transport" {
  namespace SMTPTransport {
    type AddressLike = string | { name?: string; address: string };

    interface AuthOptions {
      user?: string;
      pass?: string;
    }

    type TlsOptions = Record<string, unknown>;

    interface Envelope {
      from?: string;
      to?: string[];
    }

    type AddressList = Array<AddressLike>;

    interface SentMessageInfo {
      messageId?: string;
      accepted: AddressList;
      rejected: AddressList;
      pending?: AddressList;
      response: string;
      envelope?: Envelope;
    }

    interface Attachment {
      filename?: string;
      content?: unknown;
      contentType?: string;
    }

    interface Options {
      host?: string;
      port?: number;
      secure?: boolean;
      auth?: AuthOptions;
      pool?: boolean;
      connectionTimeout?: number;
      greetingTimeout?: number;
      socketTimeout?: number;
      disableFileAccess?: boolean;
      disableUrlAccess?: boolean;
      tls?: TlsOptions;
    }
  }

  export = SMTPTransport;
}

declare module "html-to-text" {
  export interface HtmlToTextOptions {
    selectors?: Array<{
      selector: string;
      format?: string;
      options?: Record<string, unknown>;
    }>;
    // Kept loose here; packages/ui-email/src/types/html-to-text.d.ts types the
    // callbacks it registers. The root typecheck sees both declarations.
    formatters?: Record<string, unknown>;
    wordwrap?: number | false;
  }

  export function htmlToText(html: string, options?: HtmlToTextOptions): string;
}

declare module "*.eta" {
  const templateSource: string;
  export default templateSource;
}
