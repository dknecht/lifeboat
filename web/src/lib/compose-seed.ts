import type { DraftContent } from "../api/queries";
import type { Draft, Message, Session } from "../api/schemas";
import { fullAddress, fullDate } from "./format";

function quote(parent: Message): string {
  const quoted = (parent.body.text ?? "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return `\n\nOn ${fullDate(parent.date)}, ${fullAddress(parent.from)} wrote:\n${quoted}`;
}

const replySubject = (subject: string) => (/^re:/i.test(subject) ? subject : `Re: ${subject}`);

/** What the compose dialog opens with. `saved` says whether the server already holds it as a draft. */
export interface ComposeSeed extends DraftContent {
  readonly saved: boolean;
}

export const newMessageSeed = (session: Session): ComposeSeed => ({
  id: crypto.randomUUID(),
  from: session.user.email,
  to: "",
  cc: "",
  subject: "",
  text: "",
  inReplyToId: null,
  saved: false,
});

export const replySeed = (session: Session, parent: Message): ComposeSeed => ({
  id: crypto.randomUUID(),
  // Answer from the address the message was sent to, when it is one of the user's own.
  from: session.addresses.includes(parent.rcptTo) ? parent.rcptTo : session.user.email,
  to: parent.from.address,
  cc: "",
  subject: replySubject(parent.subject),
  text: quote(parent),
  inReplyToId: parent.id,
  saved: false,
});

export const draftSeed = (draft: Draft): ComposeSeed => ({ ...draft, saved: true });
