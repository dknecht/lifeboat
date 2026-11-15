import { ArrowLeft, MailOpen, Paperclip, RefreshCw, Reply, Search } from "lucide-react";
import { useState } from "react";
import { messageOf } from "../api/client";
import { useFolder, useMessage } from "../api/queries";
import type { Folder, Message, MessageSummary } from "../api/schemas";
import { Avatar, Button, Input, Notice, Spinner, cx } from "../components/ui";
import { displayName, fileSize, fullAddress, fullDate, shortDate } from "../lib/format";
import { hrefFor, useTitle } from "../lib/router";

const TITLE = { inbox: "Inbox", sent: "Sent" };

const EMPTY = {
  inbox: "No mail has arrived. Mail lands in Lifeboat only while Microsoft 365 is unavailable.",
  sent: "Messages you send from Lifeboat appear here.",
};

/** The person a list row is about: the sender in the inbox, the first recipient in Sent. */
const counterpart = (message: MessageSummary) =>
  message.folder === "sent" ? (message.to[0] ?? message.from) : message.from;

function matches(message: MessageSummary, needle: string): boolean {
  const haystack = [message.subject, message.snippet, message.from.name, message.from.address, ...message.to.map((p) => p.address)];

  return haystack.some((value) => value.toLowerCase().includes(needle));
}

function Row({ message, selected }: { message: MessageSummary; selected: boolean }) {
  const who = counterpart(message);
  const label = message.folder === "sent" ? `To ${displayName(who)}` : displayName(who);

  return (
    <li>
      <a
        href={hrefFor({ name: "mail", folder: message.folder, messageId: message.id })}
        aria-current={selected ? "true" : undefined}
        className={cx(
          "flex gap-3 border-b border-line px-4 py-3 no-underline",
          selected ? "bg-accent-soft" : "hover:bg-sunken",
        )}
      >
        <Avatar person={who} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cx("min-w-0 flex-1 truncate text-sm", !message.isRead && "font-semibold")}>{label}</span>
            {message.hasAttachments && <Paperclip className="size-3.5 shrink-0 self-center text-muted" aria-label="Has attachments" />}
            <time className="shrink-0 text-xs text-muted tabular-nums">{shortDate(message.date)}</time>
          </div>
          <div className="flex items-center gap-2">
            {!message.isRead && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
            <span className={cx("truncate text-sm", !message.isRead && "font-semibold")}>{message.subject || "(no subject)"}</span>
          </div>
          <div className="truncate text-[13px] text-muted">{message.snippet}</div>
        </div>
      </a>
    </li>
  );
}

function MessageList({ folder, selectedId }: { folder: Folder; selectedId: string | null }) {
  const query = useFolder(folder);
  const [filter, setFilter] = useState("");

  useTitle(TITLE[folder]);

  const loaded = query.data?.pages.flatMap((page) => page.messages) ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = needle ? loaded.filter((message) => matches(message, needle)) : loaded;

  return (
    <section aria-label={TITLE[folder]} className="flex min-h-0 w-full flex-col border-line bg-surface md:w-[24rem] md:shrink-0 md:border-r">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h1 className="flex-1 text-lg font-semibold">{TITLE[folder]}</h1>
        <Button variant="ghost" onClick={() => void query.refetch()} aria-label="Refresh" title="Refresh" className="px-2">
          <RefreshCw className={cx("size-4", query.isFetching && "animate-spin")} aria-hidden="true" />
        </Button>
      </header>
      <div className="relative border-b border-line px-4 py-2">
        <Search className="pointer-events-none absolute top-1/2 left-7 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <Input
          id={`filter-${folder}`}
          type="search"
          aria-label={`Filter ${TITLE[folder]}`}
          placeholder="Filter loaded messages"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-9"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending && <Spinner label="Loading messages" />}
        {query.isError && (
          <div className="p-4">
            <Notice kind="error">{messageOf(query.error)}</Notice>
          </div>
        )}
        {query.isSuccess && visible.length === 0 && (
          <p className="px-6 py-14 text-center text-sm text-muted">{needle ? "No loaded message matches that filter." : EMPTY[folder]}</p>
        )}
        <ul className="m-0 list-none p-0">
          {visible.map((message) => (
            <Row key={message.id} message={message} selected={message.id === selectedId} />
          ))}
        </ul>
        {query.hasNextPage && (
          <div className="p-4 text-center">
            <Button onClick={() => void query.fetchNextPage()} busy={query.isFetchingNextPage}>
              Load older messages
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** Matches an image that would be fetched from another site, which the sandbox refuses to load. */
const REMOTE_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i;

/** Renders an HTML email in a sandboxed frame: no scripts, no remote content. */
function HtmlBody({ html }: { html: string }) {
  const [height, setHeight] = useState(240);

  const document =
    '<!doctype html><meta charset="utf-8">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">" +
    '<base target="_blank"><style>body{font:15px system-ui,sans-serif;margin:16px;color:#17212b;overflow-wrap:anywhere}img{max-width:100%;height:auto}img:not([src^="data:"]){display:none}</style>' +
    html;

  return (
    <>
      {REMOTE_IMAGE.test(html) && (
        <p className="m-0 px-4 pt-3 text-xs text-muted">Images hosted on other sites are hidden to protect your privacy.</p>
      )}
      <iframe
        title="Message body"
      className="w-full rounded-md border-0 bg-white"
      style={{ height }}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={document}
      onLoad={(event) => {
        const page = event.currentTarget.contentDocument?.documentElement;

        if (page) setHeight(page.scrollHeight + 16);
      }}
      />
    </>
  );
}

function Reader({ message, onReply }: { message: Message; onReply: (message: Message) => void }) {
  // Inline images are part of an HTML body; they are listed as files only when there is no HTML to show them in.
  useTitle(message.subject || "(no subject)");

  const files = message.attachments.filter((file) => !file.inline || !message.body.html);

  return (
    <article className="mx-auto w-full max-w-3xl p-5 md:p-8">
      <div className="mb-4 flex items-center gap-2">
        <a
          href={hrefFor({ name: "mail", folder: message.folder, messageId: null })}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-sm no-underline md:hidden"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </a>
        <span className="flex-1" />
        {message.folder === "inbox" && (
          <Button onClick={() => onReply(message)}>
            <Reply className="size-4" aria-hidden="true" />
            Reply
          </Button>
        )}
      </div>
      <h1 className="text-xl font-semibold text-balance">{message.subject || "(no subject)"}</h1>
      <div className="mt-4 flex gap-3">
        <Avatar person={message.from} />
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">{displayName(message.from)}</span>
            <span className="text-muted [overflow-wrap:anywhere]">{message.from.address}</span>
            <time className="ml-auto text-xs text-muted">{fullDate(message.date)}</time>
          </div>
          <div className="text-muted [overflow-wrap:anywhere]">To {message.to.map(fullAddress).join(", ")}</div>
          {message.cc.length > 0 && <div className="text-muted [overflow-wrap:anywhere]">Cc {message.cc.map(fullAddress).join(", ")}</div>}
        </div>
      </div>
      <div className="mt-5 rounded-lg border border-line bg-surface p-1">
        {message.body.html ? (
          <HtmlBody html={message.body.html} />
        ) : (
          <pre className="m-0 p-4 font-sans text-[15px] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {message.body.text || "(This message has no text.)"}
          </pre>
        )}
      </div>
      {files.length > 0 && (
        <ul className="m-0 mt-4 flex list-none flex-wrap gap-2 p-0">
          {files.map((file) => (
            <li key={file.idx}>
              <a
                href={`/api/messages/${message.id}/attachments/${file.idx}`}
                download={file.filename}
                className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm no-underline hover:bg-sunken"
              >
                <Paperclip className="size-4 text-muted" aria-hidden="true" />
                {file.filename}
                <span className="text-xs text-muted">{fileSize(file.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ReadingPane({ messageId, onReply }: { messageId: string | null; onReply: (message: Message) => void }) {
  const query = useMessage(messageId);

  if (messageId === null) {
    return (
      <div className="grid h-full place-items-center p-8 text-center text-sm text-muted">
        <div>
          <MailOpen className="mx-auto mb-3 size-10 opacity-60" strokeWidth={1.25} aria-hidden="true" />
          Select a message to read it here.
        </div>
      </div>
    );
  }

  if (query.isPending) return <Spinner label="Opening message" />;

  if (query.isError) {
    return (
      <div className="p-6">
        <Notice kind="error">{messageOf(query.error)}</Notice>
      </div>
    );
  }

  return <Reader message={query.data} onReply={onReply} />;
}

interface MailPageProps {
  folder: Folder;
  messageId: string | null;
  onReply: (message: Message) => void;
}

/** List and reading pane side by side on a wide screen; one at a time on a phone. */
export function MailPage({ folder, messageId, onReply }: MailPageProps) {
  return (
    <>
      <div className={cx("min-h-0", messageId === null ? "flex w-full md:w-auto" : "hidden md:flex")}>
        <MessageList folder={folder} selectedId={messageId} />
      </div>
      <div className={cx("min-h-0 min-w-0 flex-1 overflow-y-auto", messageId === null && "hidden md:block")}>
        <ReadingPane messageId={messageId} onReply={onReply} />
      </div>
    </>
  );
}
