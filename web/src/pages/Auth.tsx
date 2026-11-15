import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Surface } from "@cloudflare/kumo/components/surface";
import { useState, type FormEvent, type ReactNode } from "react";
import { messageOf } from "../api/client";
import { FingerprintIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { accessLoginHref, useAcceptInvite, useLogin, usePasskeyLogin } from "../api/queries";
import type { AuthMode } from "../api/schemas";
import { Brand, Notice, Stencil } from "../components/ui";
import { hrefFor, navigate, useTitle } from "../lib/router";

const MIN_PASSWORD_LENGTH = 12;

function AuthCard({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  useTitle(title);

  return (
    <main className="grid min-h-full place-items-center p-6">
      <Surface className="w-full max-w-sm overflow-hidden rounded-xl">
        <div className="reflective-tape" aria-hidden="true" />
        <div className="p-6">
          <Brand />
          <h1 className="mt-6">
            <Stencil className="text-3xl">{title}</Stencil>
          </h1>
          <p className="mt-2 mb-5 text-sm text-kumo-subtle">{lead}</p>
          {children}
        </div>
      </Surface>
    </main>
  );
}

const accessLink = "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium no-underline";

/** Shown instead of the password form when Cloudflare Access is the only way to sign in. */
export function AccessSignInPage() {
  return (
    <AuthCard title="All hands, sign in" lead="This Lifeboat uses Cloudflare Access. Sign in with your organisation's identity provider.">
      <a href={accessLoginHref("inbox")} className={`${accessLink} bg-kumo-brand text-white`}>
        <ShieldCheckIcon aria-hidden="true" />
        Continue with Cloudflare Access
      </a>
    </AuthCard>
  );
}

export function LoginPage({ authMode }: { authMode: AuthMode }) {
  const login = useLogin();
  const passkey = usePasskeyLogin();
  const toInbox = () => navigate({ name: "mail", folder: "inbox", messageId: null });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => navigate({ name: "mail", folder: "inbox", messageId: null }) });
  }

  return (
    <AuthCard title="All hands, sign in" lead="Use the password you set for Lifeboat, not your Microsoft password.">
      <form onSubmit={submit} className="grid gap-4">
        {login.isError && <Notice kind="error">{messageOf(login.error)}</Notice>}
        {passkey.isError && <Notice kind="error">{messageOf(passkey.error)}</Notice>}
        <Input id="email" label="Work email address" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input id="password" label="Lifeboat password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="primary" loading={login.isPending}>
          Sign in
        </Button>
        {browserSupportsWebAuthn() && (
          <Button icon={<FingerprintIcon />} loading={passkey.isPending} onClick={() => passkey.mutate(undefined, { onSuccess: toInbox })}>
            Sign in with a passkey
          </Button>
        )}
      </form>
      {authMode === "both" && (
        <p className="mt-5 border-t border-kumo-line pt-4 text-sm text-kumo-subtle">
          Administrators open the console through{" "}
          <a href={accessLoginHref("admin")} className="text-kumo-link">
            Cloudflare Access
          </a>
          .
        </p>
      )}
    </AuthCard>
  );
}

export function InvitePage({ token }: { token: string }) {
  const accept = useAcceptInvite();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    setMismatch(password !== confirm);

    if (password === confirm) accept.mutate({ token, password });
  }

  if (accept.isSuccess) {
    return (
      <AuthCard title="You have a seat" lead={`Your password is set. Sign in as ${accept.data.email} whenever Microsoft 365 is unavailable.`}>
        <a href={hrefFor({ name: "login" })} className="inline-block rounded-lg bg-kumo-brand px-3.5 py-2 text-sm font-medium text-white no-underline">
          Go to sign in
        </a>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Claim your seat"
      lead="Set the password you will use to read and send email if Microsoft 365 is unavailable. Choose one that is different from your Microsoft password."
    >
      <form onSubmit={submit} className="grid gap-4">
        {mismatch && <Notice kind="error">The two passwords do not match.</Notice>}
        {accept.isError && <Notice kind="error">{messageOf(accept.error)}</Notice>}
        <Input
          id="new-password"
          label={`New password (at least ${MIN_PASSWORD_LENGTH} characters)`}
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Input id="confirm-password" label="Repeat the password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Button type="submit" variant="primary" loading={accept.isPending}>
          Set password
        </Button>
      </form>
    </AuthCard>
  );
}
