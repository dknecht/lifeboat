import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { messageOf } from "../api/client";
import { useSendMessage } from "../api/queries";
import type { Message, Session } from "../api/schemas";
import { fullAddress, fullDate, splitAddresses } from "../lib/format";
import { navigate } from "../lib/router";
import { Button, Field, Input, Notice, Textarea } from "./ui";

/** Reads a chosen file as base64, which is how the API takes attachments. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error(`"${file.name}" could not be read.`));
    reader.readAsDataURL(file);
  });
}

function quote(parent: Message): string {
  const quoted = (parent.body.text ?? "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return `\n\nOn ${fullDate(parent.date)}, ${fullAddress(parent.from)} wrote:\n${quoted}`;
}

const replySubject = (subject: string) => (/^re:/i.test(subject) ? subject : `Re: ${subject}`);

interface ComposeProps {
  session: Session;
  /** The message being answered, or null for a new message. */
  replyTo: Message | null;
  onClose: () => void;
}

/** A modal for writing a new message or a reply. */
export function Compose({ session, replyTo, onClose }: ComposeProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const send = useSendMessage();
  const [from, setFrom] = useState(replyTo?.rcptTo ?? session.user.email);
  const [to, setTo] = useState(replyTo?.from.address ?? "");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(replyTo ? replySubject(replyTo.subject) : "");
  const [text, setText] = useState(replyTo ? quote(replyTo) : "");
  const [fileError, setFileError] = useState("");

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFileError("");

    try {
      const chosen = [...(files.current?.files ?? [])];

      const attachments = await Promise.all(
        chosen.map(async (file) => ({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          contentBase64: await readBase64(file),
        })),
      );

      send.mutate(
        { from, to: splitAddresses(to), cc: splitAddresses(cc), subject, text, inReplyToId: replyTo?.id, attachments },
        {
          onSuccess: () => {
            onClose();
            navigate({ name: "mail", folder: "sent", messageId: null });
          },
        },
      );
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "An attachment could not be read.");
    }
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="compose-title"
      className="m-auto w-[min(44rem,calc(100vw-1.5rem))] rounded-xl border border-line bg-surface p-0 text-ink shadow-xl"
    >
      <form onSubmit={(event) => void submit(event)} className="grid gap-4 p-5">
        <div className="flex items-center">
          <h2 id="compose-title" className="flex-1 text-lg font-semibold">
            {replyTo ? "Reply" : "New message"}
          </h2>
          <Button variant="ghost" onClick={() => dialog.current?.close()} aria-label="Discard" title="Discard" className="px-2">
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
        {send.isError && <Notice kind="error">{messageOf(send.error)}</Notice>}
        {fileError && <Notice kind="error">{fileError}</Notice>}
        {session.addresses.length > 1 && (
          <Field label="From" htmlFor="compose-from">
            <select id="compose-from" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm">
              {session.addresses.map((address) => (
                <option key={address} value={address}>
                  {address}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="To" htmlFor="compose-to">
          <Input id="compose-to" required autoFocus={!replyTo} placeholder="name@example.org, another@example.org" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Cc" htmlFor="compose-cc">
          <Input id="compose-cc" value={cc} onChange={(e) => setCc(e.target.value)} />
        </Field>
        <Field label="Subject" htmlFor="compose-subject">
          <Input id="compose-subject" maxLength={400} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message" htmlFor="compose-text">
          <Textarea id="compose-text" autoFocus={Boolean(replyTo)} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Field label="Attachments (25 MB in total)" htmlFor="compose-files">
          <input id="compose-files" ref={files} type="file" multiple className="text-sm" />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" busy={send.isPending}>
            Send
          </Button>
          <Button onClick={() => dialog.current?.close()}>Discard</Button>
        </div>
      </form>
    </dialog>
  );
}
