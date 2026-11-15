import { Button } from "@cloudflare/kumo/components/button";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { NotePencilIcon, PaperPlaneTiltIcon, PencilSimpleLineIcon, ShieldCheckIcon, SignOutIcon, TrayIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { ACCESS_LOGOUT_HREF, useLogout } from "../api/queries";
import type { Session } from "../api/schemas";
import { hrefFor, navigate, type Route } from "../lib/router";
import { Brand, StateBadge, cx } from "./ui";

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
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm no-underline",
        current ? "bg-kumo-brand font-semibold text-white" : "text-kumo-default hover:bg-kumo-tint",
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
  drafts: number;
  onCompose: () => void;
  children: ReactNode;
}

/** The frame around every signed-in view: the hull-coloured navigation, the outage banner, and the account controls. */
export function AppShell({ session, route, unread, drafts, onCompose, children }: AppShellProps) {
  const logout = useLogout();
  const banner = BANNER[session.state];
  const folder = route.name === "mail" ? route.folder : null;

  function signOut() {
    // Someone Access let in has no Lifeboat session to end; signing out means leaving Access.
    if (session.via === "access") {
      location.assign(ACCESS_LOGOUT_HREF);

      return;
    }

    logout.mutate(undefined, { onSettled: () => navigate({ name: "login" }) });
  }

  const signOutButton = (
    <Tooltip content="Sign out" render={<Button variant="ghost" shape="square" icon={<SignOutIcon />} onClick={signOut} aria-label="Sign out" />} />
  );

  return (
    <div className="flex h-full flex-col">
      {banner && (
        <div role="status" className={session.state === "active" ? "bg-kumo-danger-tint text-kumo-danger" : "bg-kumo-warning-tint text-kumo-warning"}>
          {session.state === "active" && <div className="reflective-tape" aria-hidden="true" />}
          <p className="m-0 px-4 py-2 text-sm font-medium">{banner}</p>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* The sidebar is the hull: it stays navy in day and night modes. */}
        <aside data-mode="dark" className="flex shrink-0 flex-col gap-3 bg-kumo-base p-3 md:w-72 md:p-4">
          <div className="flex items-center gap-2">
            <Brand />
            <span className="flex-1" />
            <StateBadge state={session.state} />
            <span className="md:hidden">{signOutButton}</span>
          </div>
          <Button variant="primary" icon={<PencilSimpleLineIcon />} onClick={onCompose} className="w-full justify-center md:mt-2">
            New message
          </Button>
          <nav aria-label="Mailbox" className="flex flex-wrap gap-1 md:flex-col">
            <NavItem route={{ name: "mail", folder: "inbox", messageId: null }} current={folder === "inbox"} icon={<TrayIcon size={18} aria-hidden="true" />} label="Inbox" count={unread} />
            <NavItem route={{ name: "mail", folder: "sent", messageId: null }} current={folder === "sent"} icon={<PaperPlaneTiltIcon size={18} aria-hidden="true" />} label="Sent" />
            <NavItem route={{ name: "drafts" }} current={route.name === "drafts"} icon={<NotePencilIcon size={18} aria-hidden="true" />} label="Drafts" count={drafts} />
            {session.user.role === "admin" && (
              <NavItem route={{ name: "admin" }} current={route.name === "admin"} icon={<ShieldCheckIcon size={18} aria-hidden="true" />} label="Admin" />
            )}
          </nav>
          <div className="mt-auto flex items-center gap-2 border-t border-kumo-line pt-3 max-md:hidden">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{session.user.displayName || session.user.email}</div>
              <div className="truncate text-xs text-kumo-subtle">{session.user.email}</div>
            </div>
            {signOutButton}
          </div>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
