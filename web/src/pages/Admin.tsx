import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Surface } from "@cloudflare/kumo/components/surface";
import { Table } from "@cloudflare/kumo/components/table";
import { ShieldCheckIcon } from "@phosphor-icons/react";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiFailure, messageOf } from "../api/client";
import {
  useActivate,
  useAdminUsers,
  useAssignHeld,
  accessLoginHref,
  useAuditLog,
  useCreateUser,
  useDeactivate,
  useDirectoryImport,
  useHeldMail,
  useInvite,
  useOverview,
  useRunSync,
} from "../api/queries";
import type { AdminUser, AuthMode, MessageSummary, Overview } from "../api/schemas";
import { Notice, Spinner, Stencil } from "../components/ui";
import { fullDate, shortDate } from "../lib/format";
import { useTitle } from "../lib/router";

const STATE_LABEL = { standby: "Standby", active: "Outage mode", recovering: "Recovering" };

function Card({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Surface as="section" className="rounded-xl p-5">
      {title && (
        <div className="mb-3 flex items-center gap-3">
          <h2 className="flex-1">
            <Stencil className="text-2xl">{title}</Stencil>
          </h2>
          {action}
        </div>
      )}
      {children}
    </Surface>
  );
}

function DataTable({ headers, empty, children }: { headers: string[]; empty: string; children: ReactNode[] }) {
  if (children.length === 0) return <p className="text-sm text-kumo-subtle">{empty}</p>;

  return (
    <div className="overflow-x-auto">
      <Table>
        <Table.Header>
          <Table.Row>
            {headers.map((header) => (
              <Table.Head key={header}>{header}</Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>{children}</Table.Body>
      </Table>
    </div>
  );
}

function probeSummary(probe: Overview["probe"]): string {
  if (!probe.configured) return "Health probe is not configured. Set the Graph variables and a canary mailbox to enable it.";

  if (probe.status === "unknown") return "The health probe has not run yet.";

  const checked = probe.lastCheckedAt ? `, last checked ${fullDate(probe.lastCheckedAt)}` : "";
  const error = probe.lastError ? `. Last error: ${probe.lastError}` : "";

  return `Microsoft 365 probe: ${probe.status}${checked}${error}`;
}

function FailoverCard({ overview }: { overview: Overview }) {
  const activate = useActivate();
  const deactivate = useDeactivate();
  const [reason, setReason] = useState("");
  const { incident } = overview;

  function declare(event: FormEvent) {
    event.preventDefault();

    const how =
      overview.dnsMode === "api"
        ? "Lifeboat will change the domain's MX records now."
        : "You will then need to change the MX records by hand.";

    if (confirm(`Declare an outage for ${overview.domain}? ${how}`)) activate.mutate(reason);
  }

  function end() {
    if (confirm("End outage mode? Only do this once Microsoft 365 is accepting mail again.")) deactivate.mutate();
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <Stencil className="text-5xl">{STATE_LABEL[overview.state]}</Stencil>
        <span className="text-kumo-subtle">{overview.domain}</span>
        <Badge variant="outline">DNS: {overview.dnsMode}</Badge>
      </div>
      <div className="mt-3 grid gap-3">
        {overview.probe.status === "degraded" ? (
          <Notice kind="warn">{probeSummary(overview.probe)}</Notice>
        ) : (
          <p className="text-sm text-kumo-subtle">{probeSummary(overview.probe)}</p>
        )}
        {incident && overview.state !== "standby" && (
          <p className="text-sm text-kumo-subtle">
            Incident started {fullDate(incident.started_at)} by {incident.started_by}
            {incident.reason && `: ${incident.reason}`}
          </p>
        )}
        {activate.isError && <Notice kind="error">{messageOf(activate.error)}</Notice>}
        {deactivate.isError && <Notice kind="error">{messageOf(deactivate.error)}</Notice>}
        {overview.state === "active" ? (
          <div>
            <Button variant="primary" onClick={end} loading={deactivate.isPending}>
              End outage and sync mail back
            </Button>
          </div>
        ) : (
          <form onSubmit={declare} className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <Input id="reason" label="Reason" className="w-full" placeholder="For example: Exchange Online outage, incident EX123456" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button type="submit" variant="destructive" loading={activate.isPending}>
              Declare outage
            </Button>
          </form>
        )}
        {overview.instructions.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">
              {overview.state === "active" ? "Point mail at Lifeboat" : "Point mail back at Microsoft 365"}
            </h3>
            <ol className="mt-2 grid list-decimal gap-1 pl-5 text-sm">
              {overview.instructions.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </Card>
  );
}

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <Surface className="rounded-xl p-4">
      <Stencil className="text-4xl tabular-nums">{value}</Stencil>
      <div className="mt-1 text-[13px] text-kumo-subtle">{label}</div>
    </Surface>
  );
}

function SyncCard({ overview }: { overview: Overview }) {
  const run = useRunSync();

  return (
    <Card title="Sync-back">
      <div className="grid gap-3">
        <p className="text-sm text-kumo-subtle">
          {overview.graphConfigured
            ? "Copies mail held by Lifeboat into Exchange Online. Runs every 5 minutes while recovering."
            : "Microsoft Graph is not configured, so mail cannot be copied back yet."}
        </p>
        {run.isError && <Notice kind="error">{messageOf(run.error)}</Notice>}
        {run.data?.error && <Notice kind="error">{run.data.error}</Notice>}
        {run.isSuccess && !run.data.error && (
          <Notice kind="info">
            Synced {run.data.synced} of {run.data.attempted} attempted. {run.data.remaining} still waiting.
          </Notice>
        )}
        <div>
          <Button onClick={() => run.mutate(undefined)} loading={run.isPending} disabled={!overview.graphConfigured}>
            Sync a batch now
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** `onInvite` is null when sign-in is through Access only, which hides the password columns. */
function UserRow({ user, onInvite }: { user: AdminUser; onInvite: ((user: AdminUser, send: boolean) => void) | null }) {
  return (
    <Table.Row>
      <Table.Cell className="[overflow-wrap:anywhere]">
        {user.email}
        {user.aliases.length > 0 && <div className="text-xs text-kumo-subtle">Also: {user.aliases.join(", ")}</div>}
      </Table.Cell>
      <Table.Cell>{user.displayName}</Table.Cell>
      <Table.Cell>{user.role}</Table.Cell>
      {onInvite && (
        <>
          <Table.Cell>{user.enrolled ? "Password set" : "Not enrolled"}</Table.Cell>
          <Table.Cell>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <button type="button" className="text-kumo-link underline" onClick={() => onInvite(user, false)}>
                New invite link
              </button>
              <button type="button" className="text-kumo-link underline" onClick={() => onInvite(user, true)}>
                Email invite
              </button>
            </div>
          </Table.Cell>
        </>
      )}
    </Table.Row>
  );
}

function UsersCard({ overview, authMode }: { overview: Overview; authMode: AuthMode }) {
  // With Access as the only way in, nobody sets a Lifeboat password, so there are no invites to issue.
  const invites = authMode !== "access";

  const users = useAdminUsers();
  const create = useCreateUser();
  const invite = useInvite();
  const directory = useDirectoryImport();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("user");
  // The most recent invite link, shown once so the admin can pass it on.
  const [issued, setIssued] = useState<{ email: string; link: string; sent: boolean } | null>(null);

  function add(event: FormEvent) {
    event.preventDefault();
    create.mutate(
      { email, displayName: name, role },
      {
        onSuccess: (result) => {
          if (result.inviteLink) setIssued({ email: result.user.email, link: result.inviteLink, sent: false });

          setEmail("");
          setName("");
        },
      },
    );
  }

  function sendInvite(user: AdminUser, send: boolean) {
    invite.mutate(
      { userId: user.id, send },
      { onSuccess: (result) => setIssued({ email: user.email, link: result.inviteLink, sent: result.sent }) },
    );
  }

  const failed = invite.data && invite.variables?.send && !invite.data.sent;

  return (
    <Card
      title="Users"
      action={
        <Button onClick={() => directory.mutate(undefined)} loading={directory.isPending} disabled={!overview.graphConfigured} title={overview.graphConfigured ? undefined : "Configure Microsoft Graph to enable this"}>
          Import from Microsoft 365
        </Button>
      }
    >
      <div className="grid gap-3">
        {overview.graphConfigured && (
          <p className="text-sm text-kumo-subtle">
            {overview.directory
              ? `Last imported from Microsoft 365 on ${fullDate(overview.directory.at)}: ${overview.directory.found} mailboxes. The import repeats on a schedule while in standby.`
              : "The directory has not been imported yet. It is imported on a schedule while in standby."}
          </p>
        )}
        {directory.isError && <Notice kind="error">{messageOf(directory.error)}</Notice>}
        {directory.isSuccess && (
          <Notice kind="info">
            Directory import finished: {directory.data.found} mailboxes found, {directory.data.created} new users added.
          </Notice>
        )}
        {create.isError && <Notice kind="error">{messageOf(create.error)}</Notice>}
        {invite.isError && <Notice kind="error">{messageOf(invite.error)}</Notice>}
        {failed && <Notice kind="error">The invite email could not be sent. Pass the link below on yourself.</Notice>}
        {issued && (
          <Notice kind="info">
            {issued.sent ? `Invite emailed to ${issued.email}. ` : `Invite link for ${issued.email}. Send it through a channel you trust. `}
            It is valid for 14 days.
            <code className="mt-2 block rounded bg-kumo-control p-2 text-xs text-kumo-default [overflow-wrap:anywhere]">{issued.link}</code>
          </Notice>
        )}
        {users.isPending && <Spinner label="Loading users" />}
        {users.isSuccess && (
          <DataTable headers={invites ? ["Email", "Name", "Role", "Status", "Invite"] : ["Email", "Name", "Role"]} empty="No users yet. Add one below.">
            {users.data.users.map((user) => (
              <UserRow key={user.id} user={user} onInvite={invites ? sendInvite : null} />
            ))}
          </DataTable>
        )}
        <form onSubmit={add} className="flex flex-wrap items-end gap-3 pt-1">
          <div className="min-w-48 flex-[2]">
            <Input id="new-email" label="Email address" className="w-full" type="email" required placeholder={`name@${overview.domain}`} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="min-w-40 flex-[2]">
            <Input id="new-name" label="Name" className="w-full" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="min-w-28 flex-1">
            <Select id="new-role" label="Role" className="w-full" value={role} onValueChange={(value) => setRole(value ?? "user")} items={{ user: "User", admin: "Admin" }} />
          </div>
          <Button type="submit" loading={create.isPending}>
            Add user
          </Button>
        </form>
      </div>
    </Card>
  );
}

function HeldRow({ message }: { message: MessageSummary }) {
  const assign = useAssignHeld();
  const [email, setEmail] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    assign.mutate({ messageId: message.id, email });
  }

  return (
    <Table.Row>
      <Table.Cell className="[overflow-wrap:anywhere]">{message.rcptTo}</Table.Cell>
      <Table.Cell className="[overflow-wrap:anywhere]">{message.from.address}</Table.Cell>
      <Table.Cell className="[overflow-wrap:anywhere]">{message.subject || "(no subject)"}</Table.Cell>
      <Table.Cell className="whitespace-nowrap">{shortDate(message.date)}</Table.Cell>
      <Table.Cell>
        <form onSubmit={submit} className="flex gap-2">
          <Input
            id={`assign-${message.id}`}
            type="email"
            required
            aria-label={`Assign the message for ${message.rcptTo} to a user`}
            size="sm"
            placeholder="user's email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-w-44"
          />
          <Button type="submit" size="sm" loading={assign.isPending}>
            Assign
          </Button>
        </form>
        {assign.isError && <p className="mt-1 text-xs text-kumo-danger">{messageOf(assign.error)}</p>}
      </Table.Cell>
    </Table.Row>
  );
}

function HeldCard() {
  const held = useHeldMail();

  return (
    <Card title="Held mail">
      <p className="mb-3 text-sm text-kumo-subtle">Mail for addresses that match no user. Assign it to deliver it to that user's inbox.</p>
      {held.isPending && <Spinner label="Loading held mail" />}
      {held.isSuccess && (
        <DataTable headers={["Sent to", "From", "Subject", "Received", "Assign to"]} empty="No held mail.">
          {held.data.messages.map((message) => (
            <HeldRow key={message.id} message={message} />
          ))}
        </DataTable>
      )}
    </Card>
  );
}

function AuditCard() {
  const audit = useAuditLog();

  return (
    <Card title="Audit log">
      {audit.isPending && <Spinner label="Loading audit log" />}
      {audit.isSuccess && (
        <DataTable headers={["When", "Who", "Action", "Detail"]} empty="Nothing recorded yet.">
          {audit.data.entries.map((entry) => (
            <Table.Row key={entry.id}>
              <Table.Cell className="whitespace-nowrap">{fullDate(entry.at)}</Table.Cell>
              <Table.Cell className="[overflow-wrap:anywhere]">{entry.actor}</Table.Cell>
              <Table.Cell>{entry.action}</Table.Cell>
              <Table.Cell className="text-[13px] [overflow-wrap:anywhere]">{entry.detail}</Table.Cell>
            </Table.Row>
          ))}
        </DataTable>
      )}
    </Card>
  );
}

/** The continuity console: declare and end an outage, manage users, review held mail. */
export function AdminPage({ authMode }: { authMode: AuthMode }) {
  const overview = useOverview();

  useTitle("Admin");

  if (overview.isPending) return <Spinner label="Loading the console" />;

  if (overview.isError && overview.error instanceof ApiFailure && overview.error.code === "access_required") {
    return (
      <div className="grid w-full place-items-center p-6">
        <Empty
          icon={<ShieldCheckIcon size={48} />}
          title="The bridge is behind Cloudflare Access"
          description="The admin console needs a second sign-in through your organisation's identity provider."
          contents={
            <a href={accessLoginHref("admin")} className="rounded-lg bg-kumo-brand px-3.5 py-2 text-sm font-medium text-white no-underline">
              Continue with Cloudflare Access
            </a>
          }
        />
      </div>
    );
  }

  if (overview.isError) {
    return (
      <div className="w-full p-6">
        <Notice kind="error">{messageOf(overview.error)}</Notice>
      </div>
    );
  }

  const data = overview.data;

  return (
    <div className="min-h-0 w-full overflow-y-auto">
      <div className="mx-auto grid max-w-5xl gap-4 p-4 md:p-8">
        <h1>
          <Stencil className="text-4xl">Continuity control</Stencil>
        </h1>
        <FailoverCard overview={data} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat value={`${data.users.enrolled} / ${data.users.total}`} label="users enrolled" />
          <Stat value={data.sync.pending} label="waiting to sync" />
          <Stat value={data.sync.synced} label="synced to Microsoft 365" />
          <Stat value={data.sync.failed} label="failed to sync" />
          <Stat value={data.held} label="held for review" />
        </div>
        <SyncCard overview={data} />
        <UsersCard overview={data} authMode={authMode} />
        <HeldCard />
        <AuditCard />
      </div>
    </div>
  );
}
