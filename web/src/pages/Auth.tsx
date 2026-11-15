import { useState, type FormEvent, type ReactNode } from "react";
import { messageOf } from "../api/client";
import { useAcceptInvite, useLogin } from "../api/queries";
import { Brand, Button, Field, Input, Notice } from "../components/ui";
import { hrefFor, navigate, useTitle } from "../lib/router";

const MIN_PASSWORD_LENGTH = 12;

function AuthCard({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  useTitle(title);

  return (
    <main className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">
        <Brand />
        <h1 className="mt-5 text-xl font-semibold">{title}</h1>
        <p className="mt-1 mb-5 text-sm text-muted">{lead}</p>
        {children}
      </div>
    </main>
  );
}

export function LoginPage() {
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => navigate({ name: "mail", folder: "inbox", messageId: null }) });
  }

  return (
    <AuthCard title="Emergency email access" lead="Use the password you set for Lifeboat, not your Microsoft password.">
      <form onSubmit={submit} className="grid gap-4">
        {login.isError && <Notice kind="error">{messageOf(login.error)}</Notice>}
        <Field label="Work email address" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Lifeboat password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" busy={login.isPending}>
          Sign in
        </Button>
      </form>
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
      <AuthCard title="Your password is set" lead={`You can now sign in as ${accept.data.email} whenever Microsoft 365 is unavailable.`}>
        <a href={hrefFor({ name: "login" })} className="inline-block rounded-md border border-accent bg-accent px-3.5 py-2 text-sm font-semibold text-accent-ink">
          Go to sign in
        </a>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set your Lifeboat password"
      lead="You will use it to read and send email if Microsoft 365 is unavailable. Choose one that is different from your Microsoft password."
    >
      <form onSubmit={submit} className="grid gap-4">
        {mismatch && <Notice kind="error">The two passwords do not match.</Notice>}
        {accept.isError && <Notice kind="error">{messageOf(accept.error)}</Notice>}
        <Field label={`New password (at least ${MIN_PASSWORD_LENGTH} characters)`} htmlFor="new-password">
          <Input id="new-password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Repeat the password" htmlFor="confirm-password">
          <Input id="confirm-password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" busy={accept.isPending}>
          Set password
        </Button>
      </form>
    </AuthCard>
  );
}
