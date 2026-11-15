import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { PaperPlaneTiltIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { messageOf } from "../api/client";
import { useDeleteDraft, useSaveDraft, useSendMessage, type DraftContent } from "../api/queries";
import type { Session } from "../api/schemas";
import type { ComposeSeed } from "../lib/compose-seed";
import { splitAddresses } from "../lib/format";
import { navigate, useDebounced } from "../lib/router";
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

const SAVE_DELAY_MS = 1200;

interface ComposeProps {
  session: Session;
  seed: ComposeSeed;
  onClose: () => void;
}

/** A dialog for writing a message. What is typed is saved as a draft until it is sent or discarded. */
export function Compose({ session, seed, onClose }: ComposeProps) {
  const files = useRef<HTMLInputElement>(null);
  const send = useSendMessage();
  const save = useSaveDraft();
  const discard = useDeleteDraft();
  const toasts = useKumoToastManager();
  const [from, setFrom] = useState(seed.from);
  const [to, setTo] = useState(seed.to);
  const [cc, setCc] = useState(seed.cc);
  const [subject, setSubject] = useState(seed.subject);
  const [text, setText] = useState(seed.text);
  const [fileError, setFileError] = useState("");
  // Nothing is saved until the person changes something, so opening and closing a reply leaves no draft.
  const [edited, setEdited] = useState(false);
  const [stored, setStored] = useState(seed.saved);
  const content: DraftContent = { id: seed.id, from, to, cc, subject, text, inReplyToId: seed.inReplyToId };
  // The debounced fingerprint says when typing has paused; the ref holds what to save at that moment.
  const fingerprint = JSON.stringify(content);
  const settled = useDebounced(fingerprint, SAVE_DELAY_MS);
  const latest = useRef(content);
  const saveDraft = save.mutate;
  const sending = send.isPending || send.isSuccess;

  latest.current = content;

  useEffect(() => {
    if (!edited || sending) return;

    saveDraft(latest.current, { onSuccess: () => setStored(true) });
  }, [settled, edited, sending, saveDraft]);

  const change = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setEdited(true);
  };

  /** Closes the dialog, saving first if the last keystrokes have not been saved yet. */
  function close() {
    if (edited && !sending && settled !== fingerprint) save.mutate(content);

    onClose();
  }

  function discardDraft() {
    if (stored) discard.mutate(seed.id);

    onClose();
  }

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
        {
          from,
          to: splitAddresses(to),
          cc: splitAddresses(cc),
          subject,
          text,
          inReplyToId: seed.inReplyToId ?? undefined,
          draftId: seed.id,
          attachments,
        },
        {
          onSuccess: () => {
            // The server removes the draft on send; this also clears one a late autosave may have re-created.
            discard.mutate(seed.id);
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

  const replying = seed.inReplyToId !== null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !send.isPending && close()}>
      <Dialog size="xl" className="max-h-[92dvh] overflow-y-auto p-6">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <div className="flex items-center gap-3">
            <Dialog.Title className="flex-1">
              <Stencil className="text-3xl">{replying ? "Reply" : "New message"}</Stencil>
            </Dialog.Title>
            <span role="status" className="text-xs text-kumo-subtle">
              {save.isPending ? "Saving draft" : stored && "Draft saved"}
            </span>
            <Dialog.Close render={(props) => <Button {...props} variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />} />
          </div>
          {send.isError && <Notice kind="error">{messageOf(send.error)}</Notice>}
          {save.isError && <Notice kind="warn">This draft could not be saved: {messageOf(save.error)}</Notice>}
          {fileError && <Notice kind="error">{fileError}</Notice>}
          {session.addresses.length > 1 && (
            <Select
              id="compose-from"
              label="From"
              className="w-full"
              value={from}
              onValueChange={(value) => change(setFrom)(value ?? session.user.email)}
              items={Object.fromEntries(session.addresses.map((address) => [address, address]))}
            />
          )}
          <Input id="compose-to" label="To" required autoFocus={!replying} placeholder="name@example.org, another@example.org" value={to} onChange={(e) => change(setTo)(e.target.value)} />
          <Input id="compose-cc" label="Cc" value={cc} onChange={(e) => change(setCc)(e.target.value)} />
          <Input id="compose-subject" label="Subject" maxLength={400} value={subject} onChange={(e) => change(setSubject)(e.target.value)} />
          <InputArea id="compose-text" label="Message" rows={10} autoFocus={replying} value={text} onChange={(e) => change(setText)(e.target.value)} />
          <div className="grid gap-1.5">
            <label htmlFor="compose-files" className="text-sm font-medium">
              Attachments (25 MB in total, not kept with a draft)
            </label>
            <input id="compose-files" ref={files} type="file" multiple className="text-sm" />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" icon={<PaperPlaneTiltIcon />} loading={send.isPending}>
              Send
            </Button>
            <Button onClick={discardDraft}>Discard</Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
