import { Suspense, lazy, useState } from "react";
import { messageOf } from "./api/client";
import { useDrafts, useFolder, useSession, useStatus } from "./api/queries";
import type { Session } from "./api/schemas";
import { draftSeed, newMessageSeed, replySeed, type ComposeSeed } from "./lib/compose-seed";
import { AppShell } from "./components/AppShell";
import { Notice, Spinner } from "./components/ui";
import { parseRoute, useHash, type Route } from "./lib/router";
import { AccessSignInPage, InvitePage, LoginPage } from "./pages/Auth";
import { DraftsPage } from "./pages/Drafts";
import { MailPage } from "./pages/Mail";

// The admin console and the compose dialog are loaded when first opened, which keeps them out of
// the code everyone downloads just to read mail.
const AdminPage = lazy(() => import("./pages/Admin").then((module) => ({ default: module.AdminPage })));
const AccountPage = lazy(() => import("./pages/Account").then((module) => ({ default: module.AccountPage })));
const Compose = lazy(() => import("./components/Compose").then((module) => ({ default: module.Compose })));

function SignedIn({ session, route }: { session: Session; route: Route }) {
  // What the compose dialog is writing, or null while it is closed.
  const [composing, setComposing] = useState<ComposeSeed | null>(null);
  // The inbox query is shared with the list, so this adds no request; it feeds the unread badge.
  const inbox = useFolder("inbox");
  const drafts = useDrafts();
  const unread = inbox.data?.pages[0]?.unread ?? 0;
  const showAdmin = route.name === "admin" && session.user.role === "admin";

  return (
    <AppShell
      session={session}
      route={route}
      unread={unread}
      drafts={drafts.data?.length ?? 0}
      onCompose={() => setComposing(newMessageSeed(session))}
    >
      {showAdmin && (
        <Suspense fallback={<Spinner label="Loading the console" />}>
          <AdminPage authMode={session.authMode} />
        </Suspense>
      )}
      {route.name === "mail" && (
        <MailPage folder={route.folder} messageId={route.messageId} onReply={(parent) => setComposing(replySeed(session, parent))} />
      )}
      {route.name === "account" && (
        <Suspense fallback={<Spinner label="Loading your account" />}>
          <AccountPage session={session} />
        </Suspense>
      )}
      {route.name === "drafts" && <DraftsPage onOpen={(draft) => setComposing(draftSeed(draft))} />}
      {composing && (
        <Suspense fallback={null}>
          {/* A new key per message gives each one a fresh form. */}
          <Compose key={composing.id} session={session} seed={composing} onClose={() => setComposing(null)} />
        </Suspense>
      )}
    </AppShell>
  );
}

export function App() {
  const route = parseRoute(useHash());
  const session = useSession();
  const status = useStatus();

  if (route.name === "invite") return <InvitePage token={route.token} />;

  if (session.isPending) return <Spinner label="Loading Lifeboat" />;

  if (session.isError) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Notice kind="error">{messageOf(session.error)}</Notice>
      </div>
    );
  }

  if (!session.data) {
    if (status.isPending) return <Spinner label="Loading Lifeboat" />;

    // If the status cannot be read, fall back to the password form, which reports its own errors.
    const authMode = status.data?.authMode ?? "local";

    return authMode === "access" ? <AccessSignInPage /> : <LoginPage authMode={authMode} />;
  }

  // Someone already signed in who follows a link to the sign-in page belongs in their inbox.
  const signedInRoute: Route = route.name === "login" ? { name: "mail", folder: "inbox", messageId: null } : route;

  return <SignedIn session={session.data} route={signedInRoute} />;
}
