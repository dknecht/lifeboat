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
import { useFolder, useMessage } from "../api/queries";
import type { Folder, Message, MessageSummary } from "../api/schemas";
import { Avatar, Notice, Spinner, Stencil, cx } from "../components/ui";
import { displayName, fileSize, fullAddress, fullDate, shortDate } from "../lib/format";
import { hrefFor, useTitle } from "../lib/router";

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
          "flex gap-3 border-b border-l-4 border-b-kumo-line px-4 py-3 text-kumo-default no-underline",
          selected ? "border-l-kumo-brand bg-lifeboat-wash" : "border-l-transparent hover:bg-kumo-tint",
        )}
      >
        <Avatar person={who} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cx("min-w-0 flex-1 truncate text-sm", !message.isRead && "font-semibold")}>{label}</span>
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
  const query = useFolder(folder);
  const [filter, setFilter] = useState("");

  useTitle(TITLE[folder]);

  const loaded = query.data?.pages.flatMap((page) => page.messages) ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = needle ? loaded.filter((message) => matches(message, needle)) : loaded;

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
          id={`filter-${folder}`}
          type="search"
          size="sm"
          className="w-full"
          aria-label={`Filter ${TITLE[folder]}`}
          placeholder="Filter loaded messages"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
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
            {needle ? (
              <Empty size="sm" icon={<BinocularsIcon size={32} />} title="Nothing on the horizon" description="No loaded message matches that filter." />
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
  const [height, setHeight] = useState(240);

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

function Reader({ message, onReply }: { message: Message; onReply: (message: Message) => void }) {
  useTitle(message.subject || "(no subject)");

  // Inline images are part of an HTML body; they are listed as files only when there is no HTML to show them in.
  const files = message.attachments.filter((file) => !file.inline || !message.body.html);

  return (
    <article className="mx-auto w-full max-w-3xl p-5 md:p-8">
      <div className="mb-4 flex items-center gap-2">
        <a
          href={hrefFor({ name: "mail", folder: message.folder, messageId: null })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-kumo-base px-3 py-2 text-sm text-kumo-default no-underline ring ring-kumo-line md:hidden"
        >
          <ArrowLeftIcon aria-hidden="true" />
          Back
        </a>
        <span className="flex-1" />
        {message.folder === "inbox" && (
          <Button icon={<ArrowBendUpLeftIcon />} onClick={() => onReply(message)}>
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
            <span className="text-kumo-subtle [overflow-wrap:anywhere]">{message.from.address}</span>
            <time className="ml-auto text-xs text-kumo-subtle">{fullDate(message.date)}</time>
          </div>
          <div className="text-kumo-subtle [overflow-wrap:anywhere]">To {message.to.map(fullAddress).join(", ")}</div>
          {message.cc.length > 0 && <div className="text-kumo-subtle [overflow-wrap:anywhere]">Cc {message.cc.map(fullAddress).join(", ")}</div>}
        </div>
      </div>
      <Surface className="mt-5 rounded-lg p-1">
        {message.body.html ? (
          <HtmlBody html={message.body.html} />
        ) : (
          <pre className="m-0 p-4 font-sans text-[15px] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {message.body.text || "(This message has no text.)"}
          </pre>
        )}
      </Surface>
      {files.length > 0 && (
        <ul className="m-0 mt-4 flex list-none flex-wrap gap-2 p-0">
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
    </article>
  );
}

function ReadingPane({ messageId, onReply }: { messageId: string | null; onReply: (message: Message) => void }) {
  const query = useMessage(messageId);

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
