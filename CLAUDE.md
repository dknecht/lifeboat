# Lifeboat: notes for whoever works on this next

Lifeboat is email continuity for Microsoft 365 on Cloudflare. During an outage it receives a domain's mail, serves an emergency web inbox, and writes the mail back into Exchange Online afterwards. `README.md` covers running and deploying it; `SPEC.md` covers the design, the platform constraints behind it, and the roadmap. Read both before changing behaviour.

This file holds what those two do not: how to work in the repo, the traps already found, and where things stand.

## Working in the repo

```sh
npm install
npm run dev          # whole stack locally on http://localhost:1337, no Cloudflare account needed
npm test             # Worker tests, in the Workers runtime
npm run test:e2e     # browser tests; needs port 1337 free and Playwright's Chromium
npm run typecheck
npm run lint
```

All four checks must pass before a commit. `npm run test:e2e` starts its own server, so stop `npm run dev` first.

- **Effect v4 and Alchemy v2 are both recent and Alchemy is in beta.** Do not write their APIs from memory. Read the types and doc comments under `node_modules/effect/dist` and `node_modules/@alchemy.run/cloudflare/src`; the Alchemy sources carry worked examples for every resource.
- **Kumo has a built-in reference:** `npx @cloudflare/kumo doc <Component>`.
- **Lint is anti-slop, vendored under `tools/oxlint/anti-slop/`, every rule an error.** Fix findings in the code. Do not suppress a rule, lower its severity, or add a cast to get past it. The rules that bite most often: no `as` casts without a `SAFETY:` comment, no `unknown` or `object` parameters, no chained ternaries, no `typeof` checks, and decode external JSON with a schema. One local change to the vendored rules is recorded in `tools/oxlint/anti-slop/UPSTREAM.md`.
- **`src/worker.ts` is the only file that touches Cloudflare or Alchemy.** Application logic lives in the other `src/` modules as Effect programs over the services in `src/services.ts`, and the tests run those directly. Keep it that way; it is why the tests do not need the Alchemy runtime.
- **Database changes are new numbered files in `migrations/`.** Never edit an applied migration.
- **The web client decodes every API response** against `web/src/api/schemas.ts`. Change the Worker's response and the schema together, or the page reports an unreadable response.

## Traps already found

- **Never give the email subscription a zone.** `Cloudflare.Workers.email()` in `src/worker.ts` is called with no arguments on purpose. Passing a zone makes every deploy enable Email Routing and the catch-all rule, which switches the domain's MX to Cloudflare permanently.
- **Cloudflare Email Routing cannot share a domain's MX with another provider.** Failover is an MX switch, not a backup MX record. See SPEC §2 before proposing otherwise.
- **Workers cannot open port 25.** Held mail goes back through Microsoft Graph, not SMTP.
- **Kumo theme rules must stay outside any cascade layer** and name `:root`, or Kumo's defaults win. See the comment at the top of `web/src/styles.css`.
- **Passkeys are bound to the hostname in `APP_URL`.** Changing it invalidates every registered passkey.
- **Alchemy from behind an HTTPS proxy** needs `NODE_USE_ENV_PROXY=1`, or its requests to the Cloudflare API fail with a transport error.
- **`alchemy deploy` without a terminal** needs `--no-input --yes`.

## What is proven and what is not

Proven locally, by the test suites: receiving and storing mail, the inbox with conversations, search and drafts, sending, enrolment, passwords, passkeys, the failover state machine, the health probe, the scheduled directory import, sync-back request construction against a stubbed Graph, and Cloudflare Access token verification.

Proven on a real Cloudflare account: `alchemy deploy` creates the database, bucket, Workers, cron trigger, and Access applications, and Access turns anonymous visitors away.

Not proven anywhere:

1. **Sync-back into a real Exchange mailbox.** It relies on setting `PidTagMessageFlags` at creation so the item is not a draft. Microsoft does not document this.
2. **`DNS_MODE=api`,** the automatic MX switch in `src/failover.ts`.
3. **Signing in through Access on the deployed instance.** Nobody has done it. The step where the Worker reads the verified address from `Cloudflare.Access.Context` is the part to watch.
4. **Email Sending in production,** and real inbound mail through Email Routing.
5. **`AUTH_MODE=both`** against a real path-scoped Access application.

A live drill on a spare domain with a test Microsoft 365 tenant settles items 1, 2, and 4. The owner has chosen not to run one yet.

## The live deployment

A demo instance is deployed to the owner's Cloudflare account, stage `prod`, behind Access:

- App: `https://lifeboat-worker-prod-54gn6honspbuwoss.dknechtchina.workers.dev`
- Landing page: `https://lifeboat-landing-prod-dwpiehf3565rwlrl.dknechtchina.workers.dev`

It was deployed with `AUTH_MODE=access`, `MAIL_DOMAIN=cloudflare.com`, an Access allow-list of one personal address plus the `cloudflare.com` domain, and that same address as the only administrator. No domain's MX points at it, Microsoft Graph is not configured, and no real mail flows through it.

**Those settings are not in the repo.** They were passed as environment variables at deploy time. Running `npm run deploy` without them redeploys with different settings and removes the Access applications, leaving the instance open. Before any redeploy, ask the owner for the allow-list and admin address, and set at least:

```sh
MAIL_DOMAIN  APP_URL  AUTH_MODE=access  ADMIN_TOKEN
ACCESS_ALLOW_EMAILS  ACCESS_ALLOW_DOMAINS  ACCESS_ADMIN_EMAILS
```

The `ADMIN_TOKEN` in use was generated at random and not kept. Setting a new one on redeploy is fine.

Alchemy keeps deployment state in the account's `alchemy-state-store` Worker. The same account holds unrelated projects (Flaresign, Flarecast). Do not touch their resources.

## Open with the owner

- **The landing page has no link to the code.** It can point at this repository now; a private repo's link only works for people with access.
- **A draft email to Cloudflare's Email team** asks for backup-MX support, a relay-to-upstream action, health-based MX failover, and preserved `Message-ID` on send. Always-inline mode on the roadmap depends on the answers. Whether it was sent is not known.
- **An older copy of the landing page is published publicly as a claude.ai artifact** and is out of date. `site/index.html` here is the current text.
- **The Cloudflare Artifacts repo** (`default/lifeboat`) holds the same history up to `9d5703f` and has not been updated since; its write token expired.
- **An earlier copy of this project** sits in `dknecht/flaresign` under `lifeboat/` on the branch `claude/messageone-cloudflare-office365-b5t7ps`. This repository supersedes it.

## Preferences the owner has stated

- Effect for the Worker, Alchemy for deploys, Kumo for the interface, anti-slop for lint. These were explicit choices; do not swap them out.
- The interface theme is meant to be playful: maritime palette, stencil headings, reflective-tape stripes, nautical empty states. Keep new screens in that voice, with a plain explanation beside any joke.
- No live drill for now.
