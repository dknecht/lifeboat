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
- Lifeboat is written in [Effect](https://effect.website) v4 and deployed with [Alchemy](https://alchemy.run) v2. Alchemy is in beta; pin its version and expect breaking changes.
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

Trigger the periodic job by hand with the cron expression it is registered under:

```sh
curl 'http://localhost:1337/cdn-cgi/handler/scheduled?cron=*/5%20*%20*%20*%20*'
```

Run the checks with `npm test`, `npm run typecheck`, and `npm run lint`.

`npm run test:e2e` drives the web client in a real browser against a locally started stack: enrolment, declaring an outage, receiving and reading mail, replying, search, drafts, held mail, the phone layout, and passkeys. It needs Playwright's Chromium (`npx playwright install chromium`) and port 1337 free, and keeps its data in a separate `e2e` stage.

Linting uses [anti-slop](https://github.com/dmmulroy/anti-slop), a set of Oxlint rules vendored under `tools/oxlint/anti-slop/`, with every generic and Effect rule enabled as an error. The rules are yours to edit; `tools/oxlint/anti-slop/UPSTREAM.md` records where they came from.

The project's landing page is a single static file, [`site/index.html`](site/index.html). Open it in a browser or host it anywhere.

## Deploy

The Worker and the resources it needs are declared together in [`src/worker.ts`](src/worker.ts), and [`alchemy.run.ts`](alchemy.run.ts) deploys them. One command creates the D1 database, applies migrations, creates the R2 bucket, and deploys the Worker with its bindings, secrets, static assets, and cron trigger. There is no Wrangler configuration.

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

## Passkeys

Anyone who signs in with a Lifeboat password can add passkeys on the Account page and then sign in with a fingerprint, face, or device PIN. A passkey needs nothing from Microsoft and cannot be phished from another site.

- Passkeys are bound to the hostname in `APP_URL`. Set it to the address people really use; changing it later invalidates existing passkeys.
- The password stays as a fallback. Passkeys are not offered when `AUTH_MODE` is `access`.
- Encourage people to add a passkey on each device they would use in an outage, while everything is healthy.

## Sign-in with Cloudflare Access

`AUTH_MODE` chooses how people sign in.

| Mode | Mail | Admin console | Use it when |
|---|---|---|---|
| `local` (default) | Lifeboat password | Lifeboat password | You have no identity provider other than Microsoft. |
| `both` | Lifeboat password | Cloudflare Access | Admins can be given a non-Microsoft provider; everyone else keeps a password as the fallback. |
| `access` | Cloudflare Access | Cloudflare Access | The whole organisation has a non-Microsoft provider. |

**Access must be able to sign people in without Microsoft.** If Entra ID is the only identity provider configured in Access, an Entra outage locks people out of Lifeboat. Access's one-time PIN does not help either: the code is emailed to the work address, which is the mailbox the person is trying to reach.

To set it up:

1. In Zero Trust, create a self-hosted Access application.
   - For `access`, cover the whole Lifeboat hostname.
   - For `both`, cover only the path `/api/admin` on that hostname.
2. Give it a policy and at least one login method that does not depend on Microsoft.
3. Set `ACCESS_TEAM_DOMAIN` (for example `yourteam.cloudflareaccess.com`) and `ACCESS_AUD` (the application's audience tag).
4. List the administrators in `ACCESS_ADMIN_EMAILS`. They are created, or promoted, the first time they arrive through Access.
5. For an external monitor, create an Access service token, allow it in the policy, and list its client ID in `ACCESS_ADMIN_SERVICE_TOKENS`.

How it behaves:

- The Worker verifies the token Access attaches to each request against your team's published keys, and checks the audience, issuer, and expiry. In `local` mode the header is ignored.
- Someone Access lets in who has no Lifeboat account gets one automatically if their address is in `MAIL_DOMAIN`. Anyone else is refused unless they are a listed administrator.
- In `access` mode there are no Lifeboat passwords, sessions, or invites.
- In `both` mode an administrator signs in with a password to read mail, then passes through Access to open the console.
- `ADMIN_TOKEN` keeps working in every mode as a break-glass credential. With Access in front of the admin path, a request also needs a service token to get past Access.

### Limiting Graph access

`Mail.ReadWrite` as an application permission covers every mailbox in the tenant. Restrict it to the mailboxes Lifeboat serves with [RBAC for Applications in Exchange Online](https://learn.microsoft.com/exchange/permissions-exo/application-rbac).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MAIL_DOMAIN` | | The domain Lifeboat covers. |
| `APP_URL` | | Public URL, used in invite links. |
| `DNS_MODE` | `manual` | `manual` shows the DNS steps to an admin. `api` changes MX through the Cloudflare API (experimental; needs `CF_ZONE_ID` and `CF_API_TOKEN`). |
| `UNKNOWN_RECIPIENT` | `hold` | `hold` keeps mail for unknown addresses for admin review. `reject` refuses it. |
| `AUTO_FAILOVER` | `false` | Declare an outage automatically after `PROBE_THRESHOLD` failed probes. |
| `PROBE_THRESHOLD` | `3` | Consecutive probe results needed to change health status. |
| `RETENTION_DAYS` | `30` | Days to keep a message after it has been synced. Unsynced mail is never deleted. |
| `DIRECTORY_SYNC_HOURS` | `24` | How often users and aliases are re-imported from Microsoft 365 while in standby. `0` turns it off. The import only adds; it never removes a user. |
| `AUTH_MODE` | `local` | `local`, `both`, or `access`. See [Sign-in with Cloudflare Access](#sign-in-with-cloudflare-access). |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | | Your Zero Trust team domain and the Access application's audience tag. |
| `ACCESS_ADMIN_EMAILS` | | Comma-separated administrators, when they sign in through Access. |
| `ACCESS_ADMIN_SERVICE_TOKENS` | | Comma-separated client IDs of Access service tokens allowed to call the admin API. |
| `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID` | | Entra app registration. |
| `GRAPH_CANARY_MAILBOX` | | Mailbox the health probe reads. |

Secrets: `ADMIN_TOKEN`, `GRAPH_CLIENT_SECRET`, `CF_API_TOKEN`. All of these are read from the environment or `.env` at deploy time.

## How the code is organized

The application is a set of Effect programs that depend on four services: `Db` (D1), `Blobs` (R2), `Mailer` (Email Sending), and `AppConfig`.

- `src/app.ts` exposes the three entry points: `handleRequest`, `handleInbound`, and `handleScheduled`. They know nothing about Cloudflare.
- `src/worker.ts` is the only file that touches the platform. It declares the resources, builds the services from the Worker's bindings, and connects fetch, email, and cron events to the entry points.
- `src/errors.ts` lists every way an operation can fail as a tagged error. The API turns them into responses in one place (`handleApi` in `src/api.ts`); an inbound storage failure is left to fail the event so that the sending server retries.
- The tests run the same entry points against local D1 and R2 with a recording mailer, so they exercise the real code paths without the Alchemy runtime.
- `web/` is the browser client: React, Cloudflare's [Kumo](https://github.com/cloudflare/kumo) components, Tailwind, and TanStack Query, built by Vite into `dist/`, which the Worker serves. The Lifeboat look is a Kumo theme: `web/src/styles.css` re-points Kumo's colour tokens at a maritime palette for day and night modes. Every API response is decoded with a schema before the interface uses it. `npm run dev` builds it once; for hot reload while working on the interface, run `npm run dev:web` beside it and open the address Vite prints.

## What is and is not verified

Verified locally (automated tests in the Workers runtime, plus a browser run against the local dev server):

- Inbound capture, aliases, held mail, attachment storage and download, per-user isolation.
- Enrollment, sign-in, lockout, sessions, admin authorization.
- Passkeys: a full registration and sign-in in Chromium with a virtual authenticator, verified by the Worker.
- Drafts, the scheduled directory import, and inline images.
- Cloudflare Access token verification (signature, audience, issuer, expiry), automatic account creation, and the three sign-in modes.
- Sending with threading headers through the local Email Sending binding.
- `npm run dev` through Alchemy's Effect runtime: migrations, bindings, secrets, static assets, inbound mail, sending, and the cron handler.
- The failover state machine, health probe counters, retention sweep.
- Sync-back request construction against a stubbed Microsoft Graph.
- HTML mail is rendered with scripts and remote content blocked.
- The React client, through the end-to-end suite: enrolment, sign-in, declaring and ending an outage, reading HTML mail, replying, conversations, search, assigning held mail, and the phone layout.

Not yet verified against live services:

- **`npm run deploy`.** The stack type-checks and runs locally, but it has not been deployed to a Cloudflare account.
- **Sync-back against a real tenant.** Creating a message as a delivered (non-draft) item relies on setting the `PidTagMessageFlags` extended property at creation. This is widely used but not documented by Microsoft.
- **Cloudflare Access sign-in against a real Access application.** Token verification is tested with locally generated keys, and the prompts are checked in a browser, but the round trip through Access has not been run. In particular, confirm in `both` mode that the Access cookie set for `/api/admin` is sent on the console's background requests.
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
