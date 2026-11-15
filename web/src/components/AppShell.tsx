import { Inbox, LogOut, PenSquare, Send, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useLogout } from "../api/queries";
import type { Session } from "../api/schemas";
import { hrefFor, navigate, type Route } from "../lib/router";
import { Brand, Button, Pill, cx } from "./ui";

const STATE_LABEL = { standby: "Standby", active: "Outage mode", recovering: "Recovering" };

const BANNER = {
  standby: null,
  active: "Microsoft 365 email is unavailable. New mail is arriving here, and you can reply from this page.",
  recovering: "Microsoft 365 is back. Mail from the outage is being copied to your mailbox; new mail arrives in Outlook.",
};

interface NavItemProps {
  route: Route;
  current: boolean;
  icon: ReactNode;
  label: string;
  count?: number;
}

function NavItem({ route, current, icon, label, count = 0 }: NavItemProps) {
  return (
    <a
      href={hrefFor(route)}
      aria-current={current ? "page" : undefined}
      className={cx(
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm no-underline",
        current ? "bg-accent-soft font-semibold text-accent" : "text-ink hover:bg-sunken",
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {count > 0 && <span className="text-xs font-semibold tabular-nums">{count}</span>}
    </a>
  );
}

interface AppShellProps {
  session: Session;
  route: Route;
  unread: number;
  onCompose: () => void;
  children: ReactNode;
}

/** The frame around every signed-in view: navigation, the outage banner, and the account controls. */
export function AppShell({ session, route, unread, onCompose, children }: AppShellProps) {
  const logout = useLogout();
  const banner = BANNER[session.state];
  const folder = route.name === "mail" ? route.folder : null;
  const icon = "size-[18px] shrink-0";

  function signOut() {
    logout.mutate(undefined, { onSettled: () => navigate({ name: "login" }) });
  }

  return (
    <div className="flex h-full flex-col">
      {banner && (
        <div role="status" className={cx("px-4 py-2 text-sm", session.state === "active" ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn")}>
          {banner}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex shrink-0 flex-col gap-3 border-line bg-surface p-3 max-md:border-b md:w-64 md:border-r md:p-4">
          <div className="flex items-center gap-3">
            <Brand />
            <span className="flex-1" />
            <Pill tone={session.state}>{STATE_LABEL[session.state]}</Pill>
            <Button variant="ghost" onClick={signOut} aria-label="Sign out" title="Sign out" className="px-2 md:hidden">
              <LogOut className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <Button variant="primary" onClick={onCompose} className="md:mt-2">
            <PenSquare className="size-4" aria-hidden="true" />
            New message
          </Button>
          <nav aria-label="Mailbox" className="flex gap-1 md:flex-col">
            <NavItem route={{ name: "mail", folder: "inbox", messageId: null }} current={folder === "inbox"} icon={<Inbox className={icon} aria-hidden="true" />} label="Inbox" count={unread} />
            <NavItem route={{ name: "mail", folder: "sent", messageId: null }} current={folder === "sent"} icon={<Send className={icon} aria-hidden="true" />} label="Sent" />
            {session.user.role === "admin" && (
              <NavItem route={{ name: "admin" }} current={route.name === "admin"} icon={<ShieldCheck className={icon} aria-hidden="true" />} label="Admin" />
            )}
          </nav>
          <div className="mt-auto flex items-center gap-2 border-t border-line pt-3 max-md:hidden">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{session.user.displayName || session.user.email}</div>
              <div className="truncate text-xs text-muted">{session.user.email}</div>
            </div>
            <Button variant="ghost" onClick={signOut} aria-label="Sign out" title="Sign out" className="px-2">
              <LogOut className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
