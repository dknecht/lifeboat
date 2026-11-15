# Lifeboat

Open-source email continuity for Microsoft 365, running on Cloudflare Workers.

When Exchange Online or Entra ID is down, Lifeboat receives your domain's mail, gives users an emergency web inbox where they can read and reply from their real address, and copies everything back into their Microsoft 365 mailbox afterwards. See [SPEC.md](SPEC.md) for the design, the platform constraints behind it, and the roadmap.

**Status: prototype.** The Worker, web app, and tests run locally end to end. It has not yet been deployed against a live Cloudflare zone or a live Microsoft 365 tenant; see [What is and is not verified](#what-is-and-is-not-verified).

## How it works

| State | MX points at | What Lifeboat does |
|---|---|---|
| Standby | Microsoft 365 | Nothing. Users can sign in to an empty inbox, which is useful for drills. |
| Outage mode | Cloudflare | Stores inbound mail, serves webmail, sends replies through Cloudflare Email Sending. |
| Recovering | Microsoft 365 | Copies held and sent mail into Exchange Online through Microsoft Graph, then returns to standby. |

An administrator declares and ends the outage. Because Cloudflare Email Routing cannot share a domain's MX with another provider, failover is an MX switch, not a backup MX record.

## Requirements

- The mail domain's DNS zone hosted on Cloudflare.
- Workers Paid plan (Email Sending to arbitrary recipients needs it).
- Deploys use [Alchemy](https://alchemy.run) v2 (beta), which is built on Effect. The Worker itself is plain TypeScript with no Effect runtime in its bundle.
- A Microsoft Entra app registration with the application permissions `Mail.ReadWrite` (sync-back and health probe) and `User.Read.All` (directory import). Optional, but without it there is no sync-back.
- Node.js 22 or later.

## Run it locally

Local development needs no Cloudflare account. [Alchemy](https://alchemy.run) runs the Worker, D1, and R2 on your machine and applies the migrations.

```sh
npm install
cp .env.example .env     # then set ADMIN_TOKEN
npm run dev              # http://localhost:1337
```

Create the first administrator with the admin token. The response contains an invite link; open it to set a password.

```sh
curl -X POST http://localhost:1337/api/admin/users \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"email":"you@example.com","displayName":"You","role":"admin"}'
```

Simulate inbound mail by posting a raw message to the local email handler:

```sh
curl -X POST 'http://localhost:1337/cdn-cgi/handler/email?from=someone@other.test&to=you@example.com' \
  --data-binary $'From: Someone <someone@other.test>\r\nTo: you@example.com\r\nSubject: Hello\r\nMessage-ID: <1@other.test>\r\n\r\nTest message\r\n'
```

Outbound mail is not delivered in local development; it is written to `.alchemy/local/email`.

Run the checks with `npm test` and `npm run typecheck`.

## Deploy

Infrastructure is defined in [`alchemy.run.ts`](alchemy.run.ts). One command creates the D1 database, applies migrations, creates the R2 bucket, and deploys the Worker with its bindings, secrets, static assets, and cron trigger. There is no Wrangler configuration.

Do all of this while Microsoft 365 is healthy.

1. **Give Alchemy Cloudflare credentials.** Run `npx alchemy profile edit --profile default --add Cloudflare`, or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in CI.
2. **Set configuration** in the environment or `.env`: `MAIL_DOMAIN`, `APP_URL`, `ADMIN_TOKEN` (a long random string), and the `GRAPH_*` values. See [.env.example](.env.example). Secrets are bound as Worker secrets.
3. **Preview, then deploy.**
   ```sh
   npm run plan
   npm run deploy
   ```
   Later deploys apply only what changed, including new migrations.
4. **Add a custom domain** for the Worker on a hostname that does not depend on Microsoft, and set `APP_URL` to it.
5. **Onboard the domain for sending.** In the Cloudflare dashboard, add `MAIL_DOMAIN` to Email Sending and publish the DNS records it asks for. They live under `cf-bounce.<domain>` and do not replace Microsoft's SPF or DKIM records. If the domain already has a `_dmarc` record, check what onboarding proposes before accepting it.
6. **Lower the MX TTL.** Set the Microsoft 365 MX record's TTL to 5 minutes so a switch takes effect quickly.
7. **Enroll users.** Create the first admin as shown above, then import the directory from the Admin page and email invites. Users set a Lifeboat password that is separate from their Microsoft password.
8. **Run a drill.** Declare an outage on a test domain, follow the DNS steps the Admin page shows, send mail in, reply, end the outage, and confirm the messages appear in Outlook.

Alchemy keeps deployment state in your Cloudflare account, so any machine or CI job with credentials can update the stack. `npm run destroy` removes everything, including stored mail.

### Limiting Graph access

`Mail.ReadWrite` as an application permission covers every mailbox in the tenant. Restrict it to the mailboxes Lifeboat serves with [RBAC for Applications in Exchange Online](https://learn.microsoft.com/exchange/permissions-exo/application-rbac).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MAIL_DOMAIN` | | The domain Lifeboat covers. |
| `WORKER_NAME` | `lifeboat` | The Worker's script name, which the catch-all routing rule refers to. |
| `APP_URL` | | Public URL, used in invite links. |
| `DNS_MODE` | `manual` | `manual` shows the DNS steps to an admin. `api` changes MX through the Cloudflare API (experimental; needs `CF_ZONE_ID` and `CF_API_TOKEN`). |
| `UNKNOWN_RECIPIENT` | `hold` | `hold` keeps mail for unknown addresses for admin review. `reject` refuses it. |
| `AUTO_FAILOVER` | `false` | Declare an outage automatically after `PROBE_THRESHOLD` failed probes. |
| `PROBE_THRESHOLD` | `3` | Consecutive probe results needed to change health status. |
| `RETENTION_DAYS` | `30` | Days to keep a message after it has been synced. Unsynced mail is never deleted. |
| `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID` | | Entra app registration. |
| `GRAPH_CANARY_MAILBOX` | | Mailbox the health probe reads. |

Secrets: `ADMIN_TOKEN`, `GRAPH_CLIENT_SECRET`, `CF_API_TOKEN`. All of these are read from the environment or `.env` at deploy time.

## What is and is not verified

Verified locally (automated tests in the Workers runtime, plus a browser run against the local dev server):

- Inbound capture, aliases, held mail, attachment storage and download, per-user isolation.
- Enrollment, sign-in, lockout, sessions, admin authorization.
- Sending with threading headers through the local Email Sending binding.
- `npm run dev` through Alchemy: migrations, bindings, secrets, static assets, inbound mail, and the cron handler.
- The failover state machine, health probe counters, retention sweep.
- Sync-back request construction against a stubbed Microsoft Graph.
- HTML mail is rendered with scripts and remote content blocked.

Not yet verified against live services:

- **`npm run deploy`.** The stack type-checks and runs locally, but it has not been deployed to a Cloudflare account. Alchemy v2 is in beta, so pin its version and expect breaking changes.
- **Sync-back against a real tenant.** Creating a message as a delivered (non-draft) item relies on setting the `PidTagMessageFlags` extended property at creation. This is widely used but not documented by Microsoft.
- **`DNS_MODE=api`.** The Email Routing API calls were written from the API reference and have not been run against a live zone. Use `manual` until you have drilled it.
- **Email Sending in production,** including how quickly a new sending domain's daily quota grows. Check the quota before you rely on it for a whole company.

## Limitations to know about

- Users see only mail that arrives after the MX switch. Earlier mail is not available (see the always-inline mode on the roadmap).
- Senders cache MX records. Mail sent to Microsoft before the switch is retried by the sending server and normally arrives once Microsoft recovers.
- Synced messages are rebuilt from their parts; original transport headers are not preserved in Exchange. The raw `.eml` stays in R2 for the retention window.
- The health probe covers Entra ID and the Exchange API, not SMTP delivery. Workers cannot connect on port 25, so pair Lifeboat with an external SMTP monitor.
- Lifeboat does no spam or malware filtering of its own.

## License

MIT
