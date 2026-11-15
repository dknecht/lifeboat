import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Input } from "@cloudflare/kumo/components/input";
import { Surface } from "@cloudflare/kumo/components/surface";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import {
  AnchorIcon,
  ArrowBendUpLeftIcon,
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  BinocularsIcon,
  PaperclipIcon,
  SailboatIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { messageOf } from "../api/client";
import { useFolder, useThread } from "../api/queries";
import type { Folder, ListedMessage, Message, MessageSummary } from "../api/schemas";
import { Avatar, Notice, Spinner, Stencil, cx } from "../components/ui";
import { displayName, fileSize, fullAddress, fullDate, shortDate } from "../lib/format";
import { hrefFor, useDebounced, useTitle } from "../lib/router";

const TITLE = { inbox: "Inbox", sent: "Sent" };

const EMPTY = {
  inbox: {
    title: "Calm seas",
    description: "No mail has arrived. Mail lands in Lifeboat only while Microsoft 365 is unavailable.",
  },
  sent: { title: "Nothing launched yet", description: "Messages you send from Lifeboat appear here." },
};

/** The person a list row is about: the sender in the inbox, the first recipient in Sent. */
const counterpart = (message: MessageSummary) =>
  message.folder === "sent" ? (message.to[0] ?? message.from) : message.from;

function Row({ message, selected }: { message: ListedMessage; selected: boolean }) {
  const who = counterpart(message);
  const label = message.folder === "sent" ? `To ${displayName(who)}` : displayName(who);

  return (
    <li>
      <a
        href={hrefFor({ name: "mail", folder: message.folder, messageId: message.id })}
        aria-current={selected ? "true" : undefined}
        className={cx(
          "flex gap-3 border-b border-l-4 border-b-kumo-line px-4 py-3 text-kumo-default no-underline",
          selected ? "border-l-kumo-brand bg-lifeboat-wash" : "border-l-transparent hover:bg-kumo-tint",
        )}
      >
        <Avatar person={who} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cx("min-w-0 flex-1 truncate text-sm", !message.isRead && "font-semibold")}>{label}</span>
            {message.threadCount > 1 && (
              <span aria-label={`${message.threadCount} messages in this conversation`}>
                <Badge variant="outline">{message.threadCount}</Badge>
              </span>
            )}
            {message.hasAttachments && <PaperclipIcon className="size-3.5 shrink-0 self-center text-kumo-subtle" aria-label="Has attachments" />}
            <time className="shrink-0 text-xs text-kumo-subtle tabular-nums">{shortDate(message.date)}</time>
          </div>
          <div className="flex items-center gap-2">
            {!message.isRead && <span className="size-2 shrink-0 rounded-full bg-kumo-brand" aria-label="Unread" />}
            <span className={cx("truncate text-sm", !message.isRead && "font-semibold")}>{message.subject || "(no subject)"}</span>
          </div>
          <div className="truncate text-[13px] text-kumo-subtle">{message.snippet}</div>
        </div>
      </a>
    </li>
  );
}

function MessageList({ folder, selectedId }: { folder: Folder; selectedId: string | null }) {
  const [typed, setTyped] = useState("");
  const search = useDebounced(typed.trim());
  const query = useFolder(folder, search);

  useTitle(TITLE[folder]);

  const visible = query.data?.pages.flatMap((page) => page.messages) ?? [];

  return (
    <section aria-label={TITLE[folder]} className="flex min-h-0 w-full flex-col border-kumo-line bg-kumo-base md:w-[24rem] md:shrink-0 md:border-r">
      <header className="flex items-center gap-2 px-4 pt-4 pb-2">
        <h1 className="flex-1">
          <Stencil className="text-3xl">{TITLE[folder]}</Stencil>
        </h1>
        <Tooltip
          content="Refresh"
          render={
            <Button
              variant="ghost"
              shape="square"
              icon={<ArrowsClockwiseIcon className={query.isFetching ? "animate-spin" : undefined} />}
              onClick={() => void query.refetch()}
              aria-label="Refresh"
            />
          }
        />
      </header>
      <div className="border-b border-kumo-line px-4 pb-3">
        <Input
          id={`search-${folder}`}
          type="search"
          size="sm"
          className="w-full"
          aria-label={`Search ${TITLE[folder]}`}
          placeholder={`Search ${TITLE[folder]}`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
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
          <div className="p-4">
            {search ? (
              <Empty size="sm" icon={<BinocularsIcon size={32} />} title="Nothing on the horizon" description={`No message in ${TITLE[folder]} contains "${search}".`} />
            ) : (
              <Empty size="sm" icon={<SailboatIcon size={32} />} title={EMPTY[folder].title} description={EMPTY[folder].description} />
            )}
          </div>
        )}
        <ul className="m-0 list-none p-0">
          {visible.map((message) => (
            <Row key={message.id} message={message} selected={message.id === selectedId} />
          ))}
        </ul>
        {query.hasNextPage && (
          <div className="p-4 text-center">
            <Button onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
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
  const [height, setHeight] = useState(120);

  const document =
    '<!doctype html><meta charset="utf-8">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">" +
    '<base target="_blank"><style>body{font:15px system-ui,sans-serif;margin:16px;color:#17212b;overflow-wrap:anywhere}img{max-width:100%;height:auto}img:not([src^="data:"]){display:none}</style>' +
    html;

  return (
    <>
      {REMOTE_IMAGE.test(html) && (
        <p className="m-0 px-4 pt-3 text-xs text-kumo-subtle">Images hosted on other sites are hidden to protect your privacy.</p>
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

/** One message of a conversation: a header that is always shown, and the body when expanded. */
function ThreadMessage({ message, expanded, onToggle }: { message: Message; expanded: boolean; onToggle: () => void }) {
  // Inline images are part of an HTML body; they are listed as files only when there is no HTML to show them in.
  const files = message.attachments.filter((file) => !file.inline || !message.body.html);
  const sent = message.folder === "sent";

  return (
    <Surface as="article" className="overflow-hidden rounded-lg">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer gap-3 border-0 bg-transparent p-4 text-left text-kumo-default hover:bg-kumo-tint"
      >
        <Avatar person={message.from} />
        <span className="min-w-0 flex-1 text-sm">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">{sent ? "You" : displayName(message.from)}</span>
            {expanded && <span className="text-kumo-subtle [overflow-wrap:anywhere]">{message.from.address}</span>}
            <time className="ml-auto text-xs text-kumo-subtle">{fullDate(message.date)}</time>
          </span>
          {expanded ? (
            <>
              <span className="block text-kumo-subtle [overflow-wrap:anywhere]">To {message.to.map(fullAddress).join(", ")}</span>
              {message.cc.length > 0 && (
                <span className="block text-kumo-subtle [overflow-wrap:anywhere]">Cc {message.cc.map(fullAddress).join(", ")}</span>
              )}
            </>
          ) : (
            <span className="block truncate text-kumo-subtle">{message.snippet}</span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-kumo-line p-1">
          {message.body.html ? (
            <HtmlBody html={message.body.html} />
          ) : (
            <pre className="m-0 p-4 font-sans text-[15px] whitespace-pre-wrap [overflow-wrap:anywhere]">
              {message.body.text || "(This message has no text.)"}
            </pre>
          )}
          {files.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-3">
              {files.map((file) => (
                <li key={file.idx}>
                  <a
                    href={`/api/messages/${message.id}/attachments/${file.idx}`}
                    download={file.filename}
                    className="inline-flex items-center gap-2 rounded-lg bg-kumo-base px-3 py-2 text-sm text-kumo-default no-underline ring ring-kumo-line hover:bg-kumo-tint"
                  >
                    <PaperclipIcon className="text-kumo-subtle" aria-hidden="true" />
                    {file.filename}
                    <span className="text-xs text-kumo-subtle">{fileSize(file.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Surface>
  );
}

interface ConversationProps {
  messages: ReadonlyArray<Message>;
  /** The message that was opened from the list. */
  selectedId: string;
  onReply: (message: Message) => void;
}

/** A conversation, oldest first. The opened message starts expanded; the rest open on demand. */
function Conversation({ messages, selectedId, onReply }: ConversationProps) {
  const selected = messages.find((message) => message.id === selectedId) ?? messages[messages.length - 1];
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([selectedId]));
  // A reply answers the newest message someone else sent, which is the one a person expects to answer.
  const replyTarget = messages.findLast((message) => message.folder === "inbox");

  useTitle(selected?.subject || "(no subject)");

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);

      if (!next.delete(id)) next.add(id);

      return next;
    });
  }

  if (!selected) return null;

  return (
    <div className="mx-auto w-full max-w-3xl p-5 md:p-8">
      <div className="mb-4 flex items-center gap-2">
        <a
          href={hrefFor({ name: "mail", folder: selected.folder, messageId: null })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-kumo-base px-3 py-2 text-sm text-kumo-default no-underline ring ring-kumo-line md:hidden"
        >
          <ArrowLeftIcon aria-hidden="true" />
          Back
        </a>
        <span className="flex-1" />
        {replyTarget && (
          <Button icon={<ArrowBendUpLeftIcon />} onClick={() => onReply(replyTarget)}>
            Reply
          </Button>
        )}
      </div>
      <h1 className="text-xl font-semibold text-balance">{selected.subject || "(no subject)"}</h1>
      {messages.length > 1 && <p className="mt-1 text-sm text-kumo-subtle">{messages.length} messages in this conversation</p>}
      <div className="mt-4 grid gap-3">
        {messages.map((message) => (
          <ThreadMessage key={message.id} message={message} expanded={expanded.has(message.id)} onToggle={() => toggle(message.id)} />
        ))}
      </div>
    </div>
  );
}

function ReadingPane({ messageId, onReply }: { messageId: string | null; onReply: (message: Message) => void }) {
  const query = useThread(messageId);

  if (messageId === null) {
    return (
      <div className="grid h-full place-items-center p-8">
        <Empty icon={<AnchorIcon size={48} />} title="At anchor" description="Select a message to read it here." />
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

  // The key gives each opened message its own expanded state.
  return <Conversation key={messageId} messages={query.data} selectedId={messageId} onReply={onReply} />;
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
