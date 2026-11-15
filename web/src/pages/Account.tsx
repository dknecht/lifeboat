import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Surface } from "@cloudflare/kumo/components/surface";
import { FingerprintIcon, TrashIcon } from "@phosphor-icons/react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useState, type FormEvent } from "react";
import { messageOf } from "../api/client";
import { useAddPasskey, useDeletePasskey, usePasskeys } from "../api/queries";
import type { Passkey, Session } from "../api/schemas";
import { Notice, Spinner, Stencil } from "../components/ui";
import { fullDate } from "../lib/format";
import { useTitle } from "../lib/router";

function PasskeyRow({ passkey }: { passkey: Passkey }) {
  const remove = useDeletePasskey();

  return (
    <li className="flex items-center gap-3 border-b border-kumo-line py-3 last:border-b-0">
      <FingerprintIcon size={22} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{passkey.name}</div>
        <div className="text-xs text-kumo-subtle">
          Added {fullDate(passkey.createdAt)}
          {passkey.lastUsedAt ? `, last used ${fullDate(passkey.lastUsedAt)}` : ", not used yet"}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        icon={<TrashIcon />}
        loading={remove.isPending}
        onClick={() => remove.mutate(passkey.id)}
        aria-label={`Remove the passkey "${passkey.name}"`}
      >
        Remove
      </Button>
    </li>
  );
}

/** Where someone manages how they sign in to Lifeboat. */
export function AccountPage({ session }: { session: Session }) {
  const passkeys = usePasskeys();
  const add = useAddPasskey();
  const [name, setName] = useState("");

  useTitle("Account");

  function submit(event: FormEvent) {
    event.preventDefault();
    add.mutate(name, { onSuccess: () => setName("") });
  }

  return (
    <div className="min-h-0 w-full overflow-y-auto">
      <div className="mx-auto grid max-w-2xl gap-4 p-4 md:p-8">
        <h1>
          <Stencil className="text-4xl">Account</Stencil>
        </h1>
        <p className="text-sm text-kumo-subtle">
          Signed in as {session.user.email}. These settings are for Lifeboat only and do not change your Microsoft account.
        </p>
        <Surface as="section" className="rounded-xl p-5">
          <h2>
            <Stencil className="text-2xl">Passkeys</Stencil>
          </h2>
          <p className="mt-2 text-sm text-kumo-subtle">
            A passkey signs you in with your device's fingerprint, face, or PIN. It works without Microsoft, cannot be
            phished, and means there is no password to remember during an outage.
          </p>
          <div className="mt-3 grid gap-3">
            {add.isError && <Notice kind="error">{messageOf(add.error)}</Notice>}
            {passkeys.isPending && <Spinner label="Loading passkeys" />}
            {passkeys.isError && <Notice kind="error">{messageOf(passkeys.error)}</Notice>}
            {passkeys.isSuccess && passkeys.data.length === 0 && (
              <p className="text-sm text-kumo-subtle">You have no passkeys yet. Add one on each device you would use in an outage.</p>
            )}
            {passkeys.isSuccess && passkeys.data.length > 0 && (
              <ul className="m-0 list-none p-0">
                {passkeys.data.map((passkey) => (
                  <PasskeyRow key={passkey.id} passkey={passkey} />
                ))}
              </ul>
            )}
            {browserSupportsWebAuthn() ? (
              <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
                <div className="min-w-56 flex-1">
                  <Input id="passkey-name" label="Name for this device" className="w-full" placeholder="For example: Work laptop" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <Button type="submit" variant="primary" icon={<FingerprintIcon />} loading={add.isPending}>
                  Add a passkey
                </Button>
              </form>
            ) : (
              <Notice kind="warn">This browser does not support passkeys.</Notice>
            )}
          </div>
        </Surface>
      </div>
    </div>
  );
}
