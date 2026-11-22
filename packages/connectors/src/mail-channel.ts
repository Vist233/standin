import type { Channel, ChannelInbox, Outgoing } from "@standin/contracts";
import { cursorIn } from "./event-source.ts";
import type { MailReader, MailSender, Stop } from "./types.ts";

export interface MailChannelOptions {
  /** The account the bots write from (a provider with a reader for replies and a sender). */
  mail: { reader?: MailReader | undefined; sender: MailSender };
  /** The person's own address: the only one mail goes to, and the only one replies are taken from. */
  person: string;
  /** What is mailed (default: notices and questions; a bot's ordinary messages stay on the page). */
  kinds?: Outgoing["kind"][];
  /** Where the watch of replies keeps its position, so a reply sent while the box was down still arrives. */
  cursorFile?: string | undefined;
}

const TAG = /\[bot ([A-Za-z0-9_-]{1,80})\]/;
const LABEL: Record<Outgoing["kind"], string> = { notice: "result", question: "needs you", message: "message" };

/** `Name <a@b.c>` or `a@b.c`, lower case. */
export function addressOf(from: string): string {
  const match = /<([^>]+)>/.exec(from);
  return (match?.[1] ?? from).trim().toLowerCase();
}

/** The new part of a reply: the text above the quoted message (">" lines, "On ... wrote:", a forwarded header). */
export function replyText(body: string): string {
  const kept: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    if (/^>/.test(line) || /^On .+wrote:\s*$/.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^在.+写道[:：]\s*$/.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * The person's mailbox as a channel (contracts/channels.ts). Out: a mail to the person, its subject naming the bot and carrying `[bot <id>]`.
 * In: a reply from the person's own address whose subject still carries the tag becomes their message to that bot.
 *
 * Trust: the sender address of a mail can be forged. Use an account whose provider checks the sender (SPF/DKIM) or a private address the
 * person alone writes to; anything else that arrives is not a channel message (the mail plugins bring it in as untrusted signals).
 */
export function createMailChannel(options: MailChannelOptions): Channel {
  const person = addressOf(options.person);
  const kinds = new Set(options.kinds ?? ["notice", "question"]);
  let stop: Stop | undefined;
  return {
    name: "mail",
    async deliver(message) {
      if (!kinds.has(message.kind)) return;
      await options.mail.sender.send({
        to: [options.person],
        subject: `${message.from}: ${LABEL[message.kind]} [bot ${message.sessionId}]`,
        body: `${message.text}\n\n-- \n${message.from}. Reply to this mail to answer.`,
      });
    },
    start(inbox: ChannelInbox) {
      const reader = options.mail.reader;
      if (!reader) return;
      stop = reader.watch((mail) => {
        const sessionId = TAG.exec(mail.subject)?.[1];
        if (!sessionId || addressOf(mail.from) !== person) return; // not a reply from the person: not this channel's
        void reader
          .read(mail.id)
          .then((full) => {
            const text = replyText(full.body);
            return text ? inbox.receive(sessionId, text) : undefined;
          })
          .catch(() => undefined); // a mail that cannot be read or a bot that is gone: nothing to deliver
      }, cursorIn(options.cursorFile));
    },
    stop() {
      stop?.();
      stop = undefined;
    },
  };
}
