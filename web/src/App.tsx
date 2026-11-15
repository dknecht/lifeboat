import { useState } from "react";
import { messageOf } from "./api/client";
import { useFolder, useSession } from "./api/queries";
import type { Message, Session } from "./api/schemas";
import { AppShell } from "./components/AppShell";
import { Compose } from "./components/Compose";
import { Notice, Spinner } from "./components/ui";
import { parseRoute, useHash, type Route } from "./lib/router";
import { AdminPage } from "./pages/Admin";
import { InvitePage, LoginPage } from "./pages/Auth";
import { MailPage } from "./pages/Mail";

/** What the compose dialog is doing: closed, a new message, or a reply to `replyTo`. */
type Composing = { readonly open: false } | { readonly open: true; readonly replyTo: Message | null };

function SignedIn({ session, route }: { session: Session; route: Route }) {
  const [composing, setComposing] = useState<Composing>({ open: false });
  // The inbox query is shared with the list, so this adds no request; it feeds the unread badge.
  const inbox = useFolder("inbox");
  const unread = inbox.data?.pages[0]?.unread ?? 0;
  const showAdmin = route.name === "admin" && session.user.role === "admin";

  return (
    <AppShell session={session} route={route} unread={unread} onCompose={() => setComposing({ open: true, replyTo: null })}>
      {showAdmin && <AdminPage />}
      {route.name === "mail" && (
        <MailPage folder={route.folder} messageId={route.messageId} onReply={(replyTo) => setComposing({ open: true, replyTo })} />
      )}
      {composing.open && (
        <Compose
          // A new key per target gives each reply a fresh form.
          key={composing.replyTo?.id ?? "new"}
          session={session}
          replyTo={composing.replyTo}
          onClose={() => setComposing({ open: false })}
        />
      )}
    </AppShell>
  );
}

export function App() {
  const route = parseRoute(useHash());
  const session = useSession();

  if (route.name === "invite") return <InvitePage token={route.token} />;

  if (session.isPending) return <Spinner label="Loading Lifeboat" />;

  if (session.isError) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Notice kind="error">{messageOf(session.error)}</Notice>
      </div>
    );
  }

  if (!session.data) return <LoginPage />;

  // Someone already signed in who follows a link to the sign-in page belongs in their inbox.
  const signedInRoute: Route = route.name === "login" ? { name: "mail", folder: "inbox", messageId: null } : route;

  return <SignedIn session={session.data} route={signedInRoute} />;
}
