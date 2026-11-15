import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { PaperPlaneTiltIcon, XIcon } from "@phosphor-icons/react";
import { useRef, useState, type FormEvent } from "react";
import { messageOf } from "../api/client";
import { useSendMessage } from "../api/queries";
import type { Message, Session } from "../api/schemas";
import { fullAddress, fullDate, splitAddresses } from "../lib/format";
import { navigate } from "../lib/router";
import { Notice, Stencil } from "./ui";

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

/** A dialog for writing a new message or a reply. */
export function Compose({ session, replyTo, onClose }: ComposeProps) {
  const files = useRef<HTMLInputElement>(null);
  const send = useSendMessage();
  const toasts = useKumoToastManager();
  const [from, setFrom] = useState(replyTo?.rcptTo ?? session.user.email);
  const [to, setTo] = useState(replyTo?.from.address ?? "");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(replyTo ? replySubject(replyTo.subject) : "");
  const [text, setText] = useState(replyTo ? quote(replyTo) : "");
  const [fileError, setFileError] = useState("");

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
            toasts.add({ title: "Message sent", variant: "success" });
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
    <Dialog.Root open onOpenChange={(open) => !open && !send.isPending && onClose()}>
      <Dialog size="xl" className="max-h-[92dvh] overflow-y-auto p-6">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <div className="flex items-center">
            <Dialog.Title className="flex-1">
              <Stencil className="text-3xl">{replyTo ? "Reply" : "New message"}</Stencil>
            </Dialog.Title>
            <Dialog.Close render={(props) => <Button {...props} variant="ghost" shape="square" icon={<XIcon />} aria-label="Discard" />} />
          </div>
          {send.isError && <Notice kind="error">{messageOf(send.error)}</Notice>}
          {fileError && <Notice kind="error">{fileError}</Notice>}
          {session.addresses.length > 1 && (
            <Select
              id="compose-from"
              label="From"
              className="w-full"
              value={from}
              onValueChange={(value) => setFrom(value ?? session.user.email)}
              items={Object.fromEntries(session.addresses.map((address) => [address, address]))}
            />
          )}
          <Input id="compose-to" label="To" required autoFocus={!replyTo} placeholder="name@example.org, another@example.org" value={to} onChange={(e) => setTo(e.target.value)} />
          <Input id="compose-cc" label="Cc" value={cc} onChange={(e) => setCc(e.target.value)} />
          <Input id="compose-subject" label="Subject" maxLength={400} value={subject} onChange={(e) => setSubject(e.target.value)} />
          <InputArea id="compose-text" label="Message" rows={10} autoFocus={Boolean(replyTo)} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="grid gap-1.5">
            <label htmlFor="compose-files" className="text-sm font-medium">
              Attachments (25 MB in total)
            </label>
            <input id="compose-files" ref={files} type="file" multiple className="text-sm" />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" icon={<PaperPlaneTiltIcon />} loading={send.isPending}>
              Send
            </Button>
            <Dialog.Close render={(props) => <Button {...props}>Discard</Button>} />
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
