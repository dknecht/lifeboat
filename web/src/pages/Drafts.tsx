import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { NotePencilIcon, TrashIcon } from "@phosphor-icons/react";
import { messageOf } from "../api/client";
import { useDeleteDraft, useDrafts } from "../api/queries";
import type { Draft } from "../api/schemas";
import { Notice, Spinner, Stencil } from "../components/ui";
import { shortDate } from "../lib/format";
import { useTitle } from "../lib/router";

function DraftRow({ draft, onOpen }: { draft: Draft; onOpen: (draft: Draft) => void }) {
  const remove = useDeleteDraft();

  return (
    <li className="flex items-center gap-2 border-b border-kumo-line pr-3 hover:bg-kumo-tint">
      <button
        type="button"
        onClick={() => onOpen(draft)}
        className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent px-4 py-3 text-left text-kumo-default"
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{draft.to ? `To ${draft.to}` : "No recipient yet"}</span>
          <time className="shrink-0 text-xs text-kumo-subtle tabular-nums">{shortDate(draft.updatedAt)}</time>
        </span>
        <span className="block truncate text-sm">{draft.subject || "(no subject)"}</span>
        <span className="block truncate text-[13px] text-kumo-subtle">{draft.text.trim().slice(0, 160)}</span>
      </button>
      <Tooltip
        content="Delete draft"
        render={
          <Button
            variant="ghost"
            shape="square"
            icon={<TrashIcon />}
            loading={remove.isPending}
            onClick={() => remove.mutate(draft.id)}
            aria-label={`Delete the draft "${draft.subject || "(no subject)"}"`}
          />
        }
      />
    </li>
  );
}

/** The messages someone has started and not sent. Opening one continues it in the compose dialog. */
export function DraftsPage({ onOpen }: { onOpen: (draft: Draft) => void }) {
  const drafts = useDrafts();

  useTitle("Drafts");

  return (
    <section aria-label="Drafts" className="flex min-h-0 w-full flex-col bg-kumo-base md:max-w-3xl md:border-r md:border-kumo-line">
      <header className="px-4 pt-4 pb-3">
        <h1>
          <Stencil className="text-3xl">Drafts</Stencil>
        </h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-kumo-line">
        {drafts.isPending && <Spinner label="Loading drafts" />}
        {drafts.isError && (
          <div className="p-4">
            <Notice kind="error">{messageOf(drafts.error)}</Notice>
          </div>
        )}
        {drafts.isSuccess && drafts.data.length === 0 && (
          <div className="p-4">
            <Empty size="sm" icon={<NotePencilIcon size={32} />} title="Nothing in the logbook" description="Messages you start writing are kept here until you send or discard them." />
          </div>
        )}
        <ul className="m-0 list-none p-0">
          {drafts.data?.map((draft) => (
            <DraftRow key={draft.id} draft={draft} onOpen={onOpen} />
          ))}
        </ul>
      </div>
    </section>
  );
}
