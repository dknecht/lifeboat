# Lifeboat: Technical Specification

**Open-source email continuity for Microsoft 365, built on Cloudflare's developer platform.**

When Exchange Online or Entra ID is down, Lifeboat receives your domain's mail, gives every user an emergency web inbox where they can read and reply from their real address, and writes everything back into their Microsoft 365 mailbox once service returns. It is a modern, self-hosted take on what MessageOne Email Continuity did for on-premises Exchange.

Status: v0.1 prototype. Sections marked **Roadmap** are designed but not built.

---

## 1. Goals and non-goals

### Goals for v1

1. **Failover capture.** During a declared outage the domain's MX points at Cloudflare. All inbound mail is stored durably and is readable within seconds.
2. **Emergency webmail.** Users sign in with a credential that does not depend on Microsoft, read inbound mail, and send and reply as their real address with DMARC alignment.
3. **Sync-back.** After recovery, mail received during the outage lands in each user's Exchange Online Inbox, and mail sent from Lifeboat lands in Sent Items.
4. **Self-deploy.** One Cloudflare account, one Worker, one `alchemy deploy`. No servers, no third-party services.

### Non-goals for v1

- A permanent mail archive or journal. Lifeboat holds mail for the length of an incident plus a retention window.
- History from before the outage. Failover-only capture means inboxes start empty (see Roadmap: always-inline mode).
- Calendar, contacts, Teams, or SharePoint continuity.
- Spam and malware filtering beyond the SPF/DKIM/DMARC verdict Cloudflare attaches.

### Design principles

1. **No dependency on Microsoft at outage time.** Everything needed during an outage (directory, credentials, DNS control, sending identity) is provisioned while Microsoft 365 is healthy.
2. **Cloudflare-native.** Workers, D1, R2, Email Routing, Email Sending, Cron Triggers. Nothing else.
3. **The admin decides.** Health probes advise; a person declares the incident and ends it. Automatic failover is opt-in.
4. **Never lose mail.** Raw MIME is written to R2 before the message is acknowledged. Unknown recipients are held, not bounced. If storage fails, the inbound event fails, Cloudflare answers with a temporary SMTP error, and the sending server retries.
5. **Failures are part of the types.** The code is written in Effect: every operation declares how it can fail, dependencies are injected as services, and Graph calls retry transient errors on a schedule.

---

## 2. Platform constraints that shape the design

These were verified against Cloudflare and Microsoft documentation in November 2026.

| Constraint | Consequence |
|---|---|
| Email Routing requires Cloudflare's MX records to be the only MX on the domain. A lower-priority "backup MX" beside Microsoft's is not supported. | Failover is an **MX flip**: at incident start, Microsoft's MX records are replaced by Cloudflare's. The zone's DNS must be hosted on Cloudflare. |
| With MX on Cloudflare, an address that matches no routing rule is rejected permanently. | A **catch-all rule** routes every address at the apex domain to the Worker. Catch-all works on the apex only. |
| Workers cannot open TCP connections on port 25. | Lifeboat cannot re-deliver held mail by SMTP and cannot probe Microsoft's SMTP edge. Sync-back uses Microsoft Graph; SMTP probing needs an external monitor. |
| Cloudflare Email Sending (beta) sends to arbitrary recipients from an onboarded domain on the Workers Paid plan. Its SPF and DKIM records live under `cf-bounce.<domain>`, so they do not collide with Microsoft 365's records. | The sending domain is onboarded **in advance**. DMARC passes through DKIM alignment. |
| Email Sending sets `Message-ID` and `Date` itself. `In-Reply-To` and `References` are allowed. | Replies thread correctly. Lifeboat stores the platform's message ID after sending. |
| Inbound and outbound messages are capped at 25 MiB; 50 recipients per send. | Enforced in the API and UI. |
| Microsoft Graph has no documented call that imports a MIME message as a received (non-draft) item. | Sync-back creates the message through JSON with the `PidTagMessageFlags` extended property (see §7). This is widely used but not officially documented, so it sits behind an adapter interface. |
| Senders retry temporary failures for hours to days, but cache MX records for the record's TTL. | The Microsoft MX record is kept at a **low TTL (300 s)** during normal operation so a flip takes effect quickly. |

---

## 3. Architecture

```
                      NORMAL                                  OUTAGE
   sender ──MX──► Microsoft 365              sender ──MX──► Cloudflare Email Routing
                                                                   │ catch-all
                                                                   ▼
┌──────────────────────────── Lifeboat Worker ────────────────────────────┐
│  email()      parse, store raw MIME + parts, index                      │
│  fetch()      /api/*  (Effect)  +   static SPA (Workers Assets)          │
│  scheduled()  health probe, sync-back drain, retention sweep            │
└───────┬───────────────┬──────────────────┬───────────────┬──────────────┘
        ▼               ▼                  ▼               ▼
   D1 (index,      R2 (raw .eml,     Email Sending    Microsoft Graph
   users, state)   bodies, files)    (outbound)       (directory, sync-back)
```

| Service | Use |
|---|---|
| Workers | Single Worker with `fetch`, `email`, and `scheduled` handlers, written in Effect. |
| Workers Static Assets | The webmail and admin single-page app. No build step. |
| Alchemy | Infrastructure as code. `src/worker.ts` declares the database, bucket, bindings, configuration, and cron trigger beside the code that uses them; `alchemy dev` runs the same stack locally. |
| D1 | Users, addresses, sessions, message index, incidents, audit log, settings. |
| R2 | Raw MIME (`raw/<id>.eml`), parsed bodies (`body/<id>.json`), attachments (`att/<id>/<n>`). |
| Email Routing | Inbound mail to the `email` handler through a catch-all rule. |
| Email Sending | Outbound mail through the `send_email` binding. |
| Cron Triggers | Every 5 minutes: probe, sync, sweep. |

### Failover state machine

```
            activate                 deactivate                 queue empty
 STANDBY ─────────────► ACTIVE ─────────────────► RECOVERING ─────────────► STANDBY
    ▲                                                                          │
    └──────────────────────────────────────────────────────────────────────────┘
```

- **STANDBY.** MX points at Microsoft. Lifeboat is idle. Users can sign in and see an empty inbox, which makes drills possible.
- **ACTIVE.** MX points at Cloudflare. An incident record is open. Webmail shows an outage banner.
- **RECOVERING.** MX points back at Microsoft. The sync job drains pending messages into Exchange Online. Webmail stays readable.

Mail is accepted and stored in every state. A message that reaches the Worker is never refused because of the state.

### MX switching

Two modes, set by `DNS_MODE`:

- **`manual`** (default). Activation changes Lifeboat's state and shows the admin the exact DNS changes to make. Suitable for a first deployment and for drills.
- **`api`** (experimental). Lifeboat calls the Cloudflare API: it saves the current apex MX records, deletes them, enables Email Routing, and points the catch-all rule at the Worker. Deactivation reverses this. It needs an API token with DNS and Email Routing edit rights on the zone. The routing endpoints have not been exercised against a live zone in this prototype; treat this mode as untested until you run a drill.

---

## 4. Data model (D1)

```sql
users        (id, email UNIQUE, display_name, role, password_hash, invite_hash,
              invite_expires_at, failed_logins, locked_until, disabled, created_at)
addresses    (address PRIMARY KEY, user_id)          -- primary address plus aliases
sessions     (token_hash PRIMARY KEY, user_id, expires_at, created_at)
incidents    (id, started_at, ended_at, started_by, reason)
messages     (id, user_id NULL, rcpt_to, direction, folder, incident_id,
              message_id, in_reply_to, refs, thread_id,
              from_addr, from_name, to_json, cc_json, subject, snippet,
              sent_at, received_at, size, has_attachments, is_read, auth_results,
              sync_status, sync_attempts, sync_error, graph_id)
attachments  (id, message_id, idx, filename, content_type, size, content_id, disposition)
settings     (key PRIMARY KEY, value)                -- failover state, saved MX, probe counters
audit_log    (id, at, actor, action, detail)
```

- `messages.user_id` is `NULL` for **held** mail: the recipient matched no known address. Admins can assign held mail to a user.
- `sync_status` is one of `pending`, `synced`, `failed`, `skipped`. Held mail is `skipped` until assigned.
- `thread_id` is the first entry of `References`, else `In-Reply-To`, else the message's own ID. The v1 UI lists messages flat; the column exists so threading can be added without a migration.

---

## 5. Inbound pipeline

1. Email Routing invokes `email(message)`.
2. Reject if `rawSize` exceeds 25 MiB. Otherwise read the raw stream and write it to R2 at `raw/<id>.eml`. This is the durability point.
3. Parse with `postal-mime`. Write `{html, text}` to `body/<id>.json` and each attachment to `att/<id>/<n>`.
4. Resolve the envelope recipient against `addresses`. Unknown recipients are held (`UNKNOWN_RECIPIENT=hold`, default) or rejected (`reject`).
5. Insert the index row with `sync_status = 'pending'`, the open incident's ID, and the `Authentication-Results` header Cloudflare added.

A message with several recipients at the domain is delivered to the Worker once per recipient, so each user gets an independent copy.

If parsing fails, the raw message is still stored and indexed with the envelope data, so nothing is lost.

The email subscription is declared without a zone. Naming a zone would make Alchemy enable Email Routing and the catch-all rule on every deploy, which would switch MX permanently.

---

## 6. Webmail and sending

### Reading

- Folders: Inbox and Sent. Flat list, newest first, cursor pagination, unread state.
- HTML bodies render in an `<iframe sandbox>` with a restrictive Content Security Policy: no scripts, no remote content. Plain text is the fallback.
- Attachments download through an authenticated endpoint with `Content-Disposition: attachment`.

### Sending

- `From` must be one of the user's own addresses. Lifeboat never lets a user send as someone else.
- Up to 50 recipients across To and Cc; up to 25 MiB including attachments.
- Replies carry `In-Reply-To` and `References` so they thread in the recipient's client.
- The message is stored in Sent with `sync_status = 'pending'` once Email Sending accepts it.

### Authentication (v1)

Entra ID cannot be relied on during a Microsoft outage, so v1 uses **local accounts enrolled in advance**:

1. An admin creates users individually, in bulk, or by pulling the directory from Graph (`User.Read.All`).
2. Each user gets an invite link, sent to their work mailbox while Microsoft 365 is healthy, and sets a Lifeboat password.
3. During an outage they sign in at the Lifeboat URL with their email address and that password.

Details: PBKDF2-SHA-256 with 100,000 iterations and a per-user salt; opaque session tokens stored hashed; `HttpOnly`, `Secure`, `SameSite=Strict` cookies; five failed logins lock the account for 15 minutes; state-changing requests require a JSON content type.

Admins are users with `role = 'admin'`. Automation (an external monitor, the first bootstrap) authenticates with the `ADMIN_TOKEN` secret as a bearer token.

---

## 7. Sync-back

Runs on the cron trigger while the state is RECOVERING, and on demand from the admin console. It processes pending messages oldest first in small batches.

For each message:

1. **Idempotency check.** Query the target folder for an item with the same `internetMessageId`. If one exists, mark the message synced.
2. **Create.** `POST /users/{upn}/mailFolders/{inbox|sentitems}/messages` with subject, body, sender, recipients, `internetMessageId`, and these extended properties:
   - `Integer 0x0E07 = 1` (`PidTagMessageFlags`), so the item is not a draft;
   - `SystemTime 0x0E06` and `SystemTime 0x0039`, the original delivery and submit times.
3. **Attachments.** Files under 3 MB are added inline as `fileAttachment`; larger files go through an upload session.
4. Mark `synced` and store the Graph ID. Throttling and gateway errors are retried twice with exponential backoff within the run. On failure, record the error and retry on the next run, up to 8 attempts.

Required application permission: `Mail.ReadWrite`. Scope it to the mailboxes you intend to cover with Exchange RBAC for Applications.

### Known limitations

- The message is rebuilt from parsed parts, so the original transport headers and DKIM signature are not preserved in the mailbox. The raw `.eml` stays in R2 for the retention window and can be downloaded by an admin.
- Inbox rules, transport rules, and Defender scanning do not run on imported items.
- The non-draft flag technique is not officially documented. The sync code is isolated in `src/graph.ts` behind a small interface so another importer can replace it.

---

## 8. Health probing

Every 5 minutes the Worker requests a Graph token and reads the canary mailbox's Inbox folder. Consecutive failures and successes are counted in `settings`.

- In STANDBY, `PROBE_THRESHOLD` consecutive failures (default 3) mark Microsoft 365 as degraded in the admin console. With `AUTO_FAILOVER=true` the Worker activates on its own.
- In ACTIVE, the console shows when probes pass again. Failing back is always a manual decision.

The probe covers Entra ID and Exchange Online's API, not the SMTP edge. Pair Lifeboat with an external monitor that sends a test message over SMTP and calls `POST /api/admin/failover/activate` with the admin token when delivery fails.

---

## 9. HTTP API

All routes are under `/api`. Bodies are JSON.

| Method and path | Purpose |
|---|---|
| `GET /status` | Failover state and whether an incident is open. Public. |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | Session management. |
| `POST /auth/accept-invite` | Set a password from an invite token. |
| `GET /messages?folder=&cursor=` | List a folder. |
| `GET /messages/:id` | Message with body and attachment list; marks it read. |
| `GET /messages/:id/attachments/:idx` | Download an attachment. |
| `POST /messages` | Send a message. |
| `GET /admin/overview` | State, probe health, counts, sync progress. |
| `POST /admin/failover/activate`, `POST /admin/failover/deactivate` | Declare and end an incident. |
| `GET /admin/users`, `POST /admin/users`, `POST /admin/users/:id/invite` | User management. |
| `POST /admin/directory/sync` | Import users and aliases from Graph. |
| `GET /admin/held`, `POST /admin/held/:id/assign` | Review and assign held mail. |
| `POST /admin/sync/run` | Run a sync batch now. |
| `GET /admin/audit` | Recent audit entries. |

---

## 10. Security and privacy

- Lifeboat stores other people's mail. Deploy it to an account with enforced two-factor authentication and restricted membership.
- R2 and D1 encrypt at rest. Message content is not encrypted against the account owner in v1.
- Retention: messages are deleted `RETENTION_DAYS` (default 30) after they are synced. Unsynced mail is never deleted automatically.
- Every admin action and every failover transition is written to `audit_log`.
- Secrets (`ADMIN_TOKEN`, `GRAPH_CLIENT_SECRET`, `CF_API_TOKEN`) are Worker secrets, never configuration variables.
- Consider putting the admin routes behind Cloudflare Access with an identity provider other than Entra ID.

---

## 11. Project structure

```
lifeboat/
├── SPEC.md, README.md
├── alchemy.run.ts      deployment stack
├── migrations/0001_init.sql
├── src/
│   ├── worker.ts       Alchemy Worker: resources, bindings, fetch/email/cron wiring
│   ├── app.ts          platform-independent entry points
│   ├── services.ts     Db, Blobs, Mailer, AppConfig services and their layers
│   ├── errors.ts       tagged errors
│   ├── api.ts          HTTP router and handlers
│   ├── auth.ts         password hashing, sessions, invites
│   ├── inbound.ts      receive, parse, store
│   ├── outbound.ts     send through Email Sending
│   ├── failover.ts     state machine and Cloudflare DNS control
│   ├── graph.ts        Graph token, directory, message import
│   ├── sync.ts         sync-back job and retention sweep
│   ├── health.ts       probe
│   └── settings.ts, http.ts, types.ts, util.ts
├── public/             index.html, app.js, style.css
├── site/index.html     landing page
├── tools/oxlint/       vendored anti-slop lint rules
└── test/               Vitest suites running in the Workers runtime
```

---

## 12. Roadmap

| Item | Notes |
|---|---|
| **Declarative MX switch** | Model the Microsoft MX record, Email Routing, and the catch-all rule as Alchemy resources, so that an outage can be declared with a deploy as well as from the admin console. Needs care over the order in which records are removed and routing is enabled. |
| **Always-inline mode** | MX on Cloudflare permanently. Every message is stored in a rolling window and forwarded to Microsoft 365, so users have recent history the moment an outage starts and no MX flip is needed. Requires a forwarding path that preserves sender authentication (a Microsoft inbound connector). |
| **Journaling mode** | MX stays on Microsoft; a journal rule copies mail to a Lifeboat address for history. Combined with the MX flip for new mail. |
| **Passkeys and a second identity provider** | WebAuthn enrollment, and OIDC sign-in through a non-Microsoft provider. Magic links to a personal address as a fallback. |
| **Scheduled directory sync** | Keep users, aliases, shared mailboxes, and distribution groups current automatically. |
| **Calendar and contacts** | Read-only snapshot of calendars and the global address list, refreshed while healthy. |
| **Threaded conversations, search, drafts** | `thread_id` is already stored. Search through D1 full-text indexing. |
| **Inline images and safe remote content** | Rewrite `cid:` references; proxy remote images. |
| **MIME-faithful import** | Replace the JSON rebuild in sync-back when Microsoft offers a supported MIME import. |
| **Per-user encryption at rest** | Envelope encryption of bodies with keys derived from user credentials. |
| **Outage notifications** | SMS or push to tell users that Lifeboat is active and where to sign in. |
| **Google Workspace** | The same design with Gmail's `messages.import`. |
