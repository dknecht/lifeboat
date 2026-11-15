// Lifeboat web client. Plain ES modules, no build step.
// All DOM is built with h(), which sets text through textContent, so message data is never parsed as HTML.

const root = document.getElementById("app");
let session = null; // { user, addresses, state }

// ── Helpers ──────────────────────────────────────────────────────────────────

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === false || value == null) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined && method === "GET" ? {} : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && session) {
    session = null;
    location.hash = "#/login";
  }
  if (!res.ok) throw new Error(data.error || `The request failed (HTTP ${res.status}).`);
  return data;
}

const notice = (kind, text) => h("div", { class: `notice ${kind}`, role: kind === "error" ? "alert" : "status" }, text);

function formatDate(ms, long = false) {
  const d = new Date(ms);
  if (long) return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const personLabel = (p) => (p.name ? `${p.name} <${p.address}>` : p.address);
const STATE_LABEL = { standby: "Standby", active: "Outage mode", recovering: "Recovering" };

/** Runs an async action from a button, disabling it meanwhile and reporting failures into `status`. */
function busy(button, status, action) {
  return async (event) => {
    event?.preventDefault();
    button.disabled = true;
    status.replaceChildren();
    try {
      await action();
    } catch (err) {
      status.replaceChildren(notice("error", err.message));
    } finally {
      button.disabled = false;
    }
  };
}

const logo = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "m5.6 5.6 3.6 3.6m5.6 5.6 3.6 3.6m0-12.8-3.6 3.6m-5.6 5.6-3.6 3.6"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
};
const brand = () => h("div", { class: "brand" }, logo(), "Lifeboat");

// ── Signed-out views ─────────────────────────────────────────────────────────

function loginView() {
  document.title = "Sign in · Lifeboat";
  const status = h("div");
  const email = h("input", { type: "email", id: "email", autocomplete: "username", required: true });
  const password = h("input", { type: "password", id: "password", autocomplete: "current-password", required: true });
  const submit = h("button", { class: "primary", type: "submit" }, "Sign in");
  const form = h(
    "form",
    {},
    h("div", { class: "field" }, h("label", { for: "email" }, "Work email address"), email),
    h("div", { class: "field" }, h("label", { for: "password" }, "Lifeboat password"), password),
    submit,
  );
  form.addEventListener(
    "submit",
    busy(submit, status, async () => {
      await api("/auth/login", { method: "POST", body: { email: email.value, password: password.value } });
      await loadSession();
      location.hash = "#/inbox";
    }),
  );
  root.replaceChildren(
    h(
      "div",
      { class: "center" },
      h(
        "div",
        { class: "card auth" },
        brand(),
        h("h1", { style: "margin-top:1rem" }, "Emergency email access"),
        h("p", { class: "muted lead" }, "Use the password you set for Lifeboat, not your Microsoft password."),
        status,
        form,
      ),
    ),
  );
  email.focus();
}

function inviteView(token) {
  document.title = "Set your password · Lifeboat";
  const status = h("div");
  const password = h("input", { type: "password", id: "new-password", autocomplete: "new-password", required: true, minlength: "12" });
  const confirm = h("input", { type: "password", id: "confirm-password", autocomplete: "new-password", required: true });
  const submit = h("button", { class: "primary", type: "submit" }, "Set password");
  const form = h(
    "form",
    {},
    h("div", { class: "field" }, h("label", { for: "new-password" }, "New password (at least 12 characters)"), password),
    h("div", { class: "field" }, h("label", { for: "confirm-password" }, "Repeat the password"), confirm),
    submit,
  );
  form.addEventListener(
    "submit",
    busy(submit, status, async () => {
      if (password.value !== confirm.value) throw new Error("The two passwords do not match.");
      const { email } = await api("/auth/accept-invite", { method: "POST", body: { token, password: password.value } });
      form.replaceWith(
        notice("ok", `Your password is set for ${email}.`),
        h("a", { class: "btn", href: "#/login" }, "Go to sign in"),
      );
    }),
  );
  root.replaceChildren(
    h(
      "div",
      { class: "center" },
      h(
        "div",
        { class: "card auth" },
        brand(),
        h("h1", { style: "margin-top:1rem" }, "Set your Lifeboat password"),
        h(
          "p",
          { class: "muted lead" },
          "You will use it to read and send email if Microsoft 365 is unavailable. Choose one that is different from your Microsoft password.",
        ),
        status,
        form,
      ),
    ),
  );
  password.focus();
}

// ── App shell ────────────────────────────────────────────────────────────────

function shell(current, content, unread) {
  const { user, state } = session;
  // Following a link to the view that is already open reloads it, so "Inbox" doubles as a refresh.
  const link = (hash, label, extra) =>
    h(
      "a",
      { href: hash, "aria-current": current === hash ? "page" : null, onclick: () => location.hash === hash && route() },
      h("span", {}, label),
      extra,
    );
  const signOut = h("button", {}, "Sign out");
  signOut.addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    session = null;
    location.hash = "#/login";
  });
  const banner =
    state === "active"
      ? h("div", { class: "banner active", role: "status" }, "Microsoft 365 email is unavailable. New mail is arriving here, and you can reply from this page.")
      : state === "recovering"
        ? h("div", { class: "banner recovering", role: "status" }, "Microsoft 365 is back. Mail from the outage is being copied to your mailbox; new mail arrives in Outlook.")
        : null;
  const parts = [
    h(
      "header",
      { class: "top" },
      brand(),
      h("span", { class: `pill ${state}` }, STATE_LABEL[state]),
      h("span", { class: "spacer" }),
      h("span", { class: "muted small email" }, user.email),
      signOut,
    ),
    banner,
    h(
      "div",
      { class: "shell" },
      h(
        "nav",
        { class: "side", "aria-label": "Mailbox" },
        h("a", { class: "btn compose", href: "#/compose" }, "New message"),
        link("#/inbox", "Inbox", unread ? h("span", { class: "count" }, unread) : null),
        link("#/sent", "Sent"),
        user.role === "admin" ? link("#/admin", "Admin") : null,
      ),
      h("main", {}, content),
    ),
  ];
  // replaceChildren would render a missing banner as the text "null".
  root.replaceChildren(...parts.filter(Boolean));
}

// ── Mail views ───────────────────────────────────────────────────────────────

async function folderView(folder) {
  const title = folder === "sent" ? "Sent" : "Inbox";
  document.title = `${title} · Lifeboat`;
  const list = h("div", { class: "card list" });
  const more = h("div", { style: "margin-top:0.8rem" });
  const status = h("div");
  let unread = 0;

  const render = (m) => {
    const who = folder === "sent" ? `To: ${m.to.map((p) => p.name || p.address).join(", ")}` : m.from.name || m.from.address;
    return h(
      "a",
      { class: `item${m.isRead ? "" : " unread"}`, href: `#/m/${m.id}` },
      h("span", { class: "who" }, who),
      h(
        "span",
        { class: "what" },
        h("span", { class: "subject" }, m.subject || "(no subject)"),
        m.snippet ? h("span", { class: "muted" }, ` — ${m.snippet}`) : null,
      ),
      h("span", { class: "when" }, m.hasAttachments ? "📎 " : "", formatDate(m.date)),
    );
  };

  async function load(cursor) {
    const data = await api(`/messages?folder=${folder}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    unread = data.unread;
    if (!cursor && !data.messages.length) {
      list.replaceChildren(
        h(
          "div",
          { class: "empty" },
          folder === "sent"
            ? "Messages you send from Lifeboat appear here."
            : session.state === "standby"
              ? "Nothing here. Mail arrives in Lifeboat only while Microsoft 365 is unavailable."
              : "No mail has arrived yet.",
        ),
      );
    } else {
      list.append(...data.messages.map(render));
    }
    more.replaceChildren();
    if (data.nextCursor) {
      const button = h("button", {}, "Load older messages");
      button.addEventListener("click", busy(button, status, () => load(data.nextCursor)));
      more.append(button);
    }
  }

  const refresh = h("button", {}, "Refresh");
  refresh.addEventListener("click", () => folderView(folder));
  await load();
  shell(`#/${folder}`, [h("div", { class: "head" }, h("h1", {}, title), h("span", { class: "spacer" }), refresh), status, list, more], unread);
}

/** Renders an HTML email in a sandboxed frame: no scripts, no remote content. */
function htmlFrame(html) {
  const frame = h("iframe", {
    class: "body-html",
    title: "Message body",
    sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    referrerpolicy: "no-referrer",
  });
  frame.srcdoc =
    `<!doctype html><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
    `<base target="_blank"><style>body{font:15px system-ui,sans-serif;margin:12px;color:#17212b;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>` +
    html;
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    if (doc) frame.style.height = `${doc.documentElement.scrollHeight + 16}px`;
  });
  return frame;
}

async function messageView(id) {
  const { message: m } = await api(`/messages/${id}`);
  document.title = `${m.subject || "(no subject)"} · Lifeboat`;
  const back = `#/${m.folder}`;
  const body = m.body.html
    ? htmlFrame(m.body.html)
    : h("pre", { class: "body-text" }, m.body.text || "(This message has no text.)");
  const files = m.attachments.filter((a) => !a.inline || !m.body.html);
  shell(back, [
    h(
      "div",
      { class: "head" },
      h("a", { class: "btn", href: back }, "← Back"),
      h("span", { class: "spacer" }),
      m.folder === "inbox" ? h("a", { class: "btn", href: `#/compose/reply/${m.id}` }, "Reply") : null,
    ),
    h(
      "article",
      { class: "card" },
      h("h1", {}, m.subject || "(no subject)"),
      h(
        "dl",
        { class: "meta" },
        h("dt", {}, "From"),
        h("dd", {}, personLabel(m.from)),
        h("dt", {}, "To"),
        h("dd", {}, m.to.map(personLabel).join(", ")),
        m.cc.length ? [h("dt", {}, "Cc"), h("dd", {}, m.cc.map(personLabel).join(", "))] : null,
        h("dt", {}, "Date"),
        h("dd", {}, formatDate(m.date, true)),
      ),
      body,
      files.length
        ? h(
            "div",
            { class: "files" },
            files.map((a) =>
              h("a", { class: "btn file", href: `/api/messages/${m.id}/attachments/${a.idx}`, download: a.filename }, `📎 ${a.filename} (${formatSize(a.size)})`),
            ),
          )
        : null,
    ),
  ]);
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error(`"${file.name}" could not be read.`));
    reader.readAsDataURL(file);
  });
}

async function composeView(replyToId) {
  document.title = "New message · Lifeboat";
  let parent = null;
  if (replyToId) parent = (await api(`/messages/${replyToId}`)).message;

  const from = h("select", { id: "from" }, session.addresses.map((a) => h("option", { value: a, selected: a === (parent?.rcptTo ?? session.user.email) }, a)));
  const to = h("input", { type: "text", id: "to", required: true, placeholder: "name@example.org, another@example.org" });
  const cc = h("input", { type: "text", id: "cc" });
  const subject = h("input", { type: "text", id: "subject", maxlength: "400" });
  const text = h("textarea", { id: "text" });
  const files = h("input", { type: "file", id: "files", multiple: true });
  const status = h("div");
  const submit = h("button", { class: "primary", type: "submit" }, "Send");

  if (parent) {
    to.value = parent.from.address;
    subject.value = /^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`;
    const quoted = (parent.body.text || "").split("\n").map((line) => `> ${line}`).join("\n");
    text.value = `\n\nOn ${formatDate(parent.date, true)}, ${personLabel(parent.from)} wrote:\n${quoted}`;
  }

  const split = (value) => value.split(/[,;\s]+/).filter(Boolean);
  const form = h(
    "form",
    { class: "card" },
    session.addresses.length > 1 ? h("div", { class: "field" }, h("label", { for: "from" }, "From"), from) : null,
    h("div", { class: "field" }, h("label", { for: "to" }, "To"), to),
    h("div", { class: "field" }, h("label", { for: "cc" }, "Cc"), cc),
    h("div", { class: "field" }, h("label", { for: "subject" }, "Subject"), subject),
    h("div", { class: "field" }, h("label", { for: "text" }, "Message"), text),
    h("div", { class: "field" }, h("label", { for: "files" }, "Attachments (25 MB in total)"), files),
    h("div", { class: "row" }, submit, h("a", { class: "btn", href: parent ? `#/m/${parent.id}` : "#/inbox" }, "Discard")),
  );
  form.addEventListener(
    "submit",
    busy(submit, status, async () => {
      const attachments = [];
      for (const file of files.files) {
        attachments.push({ filename: file.name, contentType: file.type || "application/octet-stream", contentBase64: await readFileBase64(file) });
      }
      await api("/messages", {
        method: "POST",
        body: { from: from.value, to: split(to.value), cc: split(cc.value), subject: subject.value, text: text.value, inReplyToId: parent?.id, attachments },
      });
      location.hash = "#/sent";
    }),
  );
  shell("#/compose", [h("div", { class: "head" }, h("h1", {}, parent ? "Reply" : "New message")), status, form]);
  if (parent) {
    text.focus();
    text.setSelectionRange(0, 0);
  } else {
    to.focus();
  }
}

// ── Admin view ───────────────────────────────────────────────────────────────

async function adminView() {
  document.title = "Admin · Lifeboat";
  const [overview, { users }, held, { entries }] = await Promise.all([
    api("/admin/overview"),
    api("/admin/users"),
    api("/admin/held"),
    api("/admin/audit"),
  ]);
  session.state = overview.state;
  const status = h("div");
  const reload = () => adminView();

  // Failover control
  const control = h("div", { class: "row", style: "margin-top:0.8rem" });
  if (overview.state === "active") {
    const end = h("button", { class: "primary" }, "End outage and sync mail back");
    end.addEventListener(
      "click",
      busy(end, status, async () => {
        if (!confirm("End outage mode? Only do this once Microsoft 365 is accepting mail again.")) return;
        await api("/admin/failover/deactivate", { method: "POST" });
        await reload();
      }),
    );
    control.append(end);
  } else {
    const reason = h("input", { type: "text", id: "reason", placeholder: "For example: Exchange Online outage, incident EX123456", style: "flex:1;min-width:14rem" });
    const start = h("button", { class: "danger", type: "submit" }, "Declare outage");
    const form = h("form", { class: "row", style: "flex:1" }, h("label", { for: "reason", style: "margin:0" }, "Reason"), reason, start);
    form.addEventListener(
      "submit",
      busy(start, status, async () => {
        const how = overview.dnsMode === "api" ? "Lifeboat will change the domain's MX records now." : "You will then need to change the MX records by hand.";
        if (!confirm(`Declare an outage for ${overview.domain}? ${how}`)) return;
        await api("/admin/failover/activate", { method: "POST", body: { reason: reason.value } });
        await reload();
      }),
    );
    control.append(form);
  }

  const probe = overview.probe;
  const probeText = !probe.configured
    ? "Health probe is not configured. Set the Graph variables and a canary mailbox to enable it."
    : probe.status === "unknown"
      ? "Health probe has not run yet."
      : `Microsoft 365 probe: ${probe.status}${probe.lastCheckedAt ? `, last checked ${formatDate(probe.lastCheckedAt, true)}` : ""}${probe.lastError ? `. Last error: ${probe.lastError}` : ""}`;

  const stateCard = h(
    "section",
    { class: "card section" },
    h("div", { class: "state-line" }, h("span", { class: "big" }, STATE_LABEL[overview.state]), h("span", { class: "muted" }, overview.domain), h("span", { class: `pill ${overview.state}` }, `DNS: ${overview.dnsMode}`)),
    h("p", { class: probe.status === "degraded" ? "notice warn" : "muted small" }, probeText),
    overview.incident && overview.state !== "standby"
      ? h("p", { class: "small muted" }, `Incident started ${formatDate(overview.incident.started_at, true)} by ${overview.incident.started_by}${overview.incident.reason ? `: ${overview.incident.reason}` : ""}`)
      : null,
    control,
    overview.instructions.length
      ? h("div", { style: "margin-top:1rem" }, h("h2", {}, overview.state === "active" ? "Point mail at Lifeboat" : "Point mail back at Microsoft 365"), h("ol", { class: "steps" }, overview.instructions.map((s) => h("li", {}, s))))
      : null,
  );

  // Counters and sync
  const stat = (n, label) => h("div", { class: "card stat" }, h("div", { class: "n" }, n), h("div", { class: "muted small" }, label));
  const syncStatus = h("div");
  const runSync = h("button", { disabled: !overview.graphConfigured }, "Sync a batch now");
  runSync.addEventListener(
    "click",
    busy(runSync, syncStatus, async () => {
      const r = await api("/admin/sync/run", { method: "POST", body: { retryFailed: true } });
      if (r.error) throw new Error(r.error);
      await reload();
    }),
  );

  // Users
  const inviteOut = h("div");
  const showInvite = (email, link, sent) =>
    inviteOut.replaceChildren(
      notice("ok", sent ? `Invite emailed to ${email}. The link is also shown below.` : `Invite link for ${email}. Send it to them through a channel you trust; it is valid for 14 days.`),
      h("code", { class: "copy" }, link),
    );
  const userRows = users.map((u) => {
    const link = h("button", { class: "link" }, "New invite link");
    link.addEventListener("click", busy(link, inviteOut, async () => showInvite(u.email, (await api(`/admin/users/${u.id}/invite`, { method: "POST" })).inviteLink, false)));
    const send = h("button", { class: "link" }, "Email invite");
    send.addEventListener(
      "click",
      busy(send, inviteOut, async () => {
        const r = await api(`/admin/users/${u.id}/invite`, { method: "POST", body: { send: true } });
        if (!r.sent) throw new Error(`The invite email could not be sent${r.sendError ? `: ${r.sendError}` : "."}`);
        showInvite(u.email, r.inviteLink, true);
      }),
    );
    return h(
      "tr",
      {},
      h("td", { class: "wrap" }, u.email, u.aliases.length ? h("div", { class: "muted small" }, `Also: ${u.aliases.join(", ")}`) : null),
      h("td", {}, u.displayName),
      h("td", {}, u.role),
      h("td", {}, u.enrolled ? "Password set" : "Not enrolled"),
      h("td", {}, h("div", { class: "row" }, link, send)),
    );
  });

  const newEmail = h("input", { type: "email", id: "new-email", required: true, placeholder: `name@${overview.domain}` });
  const newName = h("input", { type: "text", id: "new-name" });
  const newRole = h("select", { id: "new-role" }, h("option", { value: "user" }, "User"), h("option", { value: "admin" }, "Admin"));
  const add = h("button", { type: "submit" }, "Add user");
  const addForm = h(
    "form",
    { class: "row", style: "align-items:flex-end;margin-top:0.9rem" },
    h("div", { style: "flex:2;min-width:12rem" }, h("label", { for: "new-email" }, "Email address"), newEmail),
    h("div", { style: "flex:2;min-width:10rem" }, h("label", { for: "new-name" }, "Name"), newName),
    h("div", { style: "flex:1;min-width:7rem" }, h("label", { for: "new-role" }, "Role"), newRole),
    add,
  );
  addForm.addEventListener(
    "submit",
    busy(add, inviteOut, async () => {
      const r = await api("/admin/users", { method: "POST", body: { email: newEmail.value, displayName: newName.value, role: newRole.value } });
      await reload();
      alert(`User added. Invite link (valid 14 days):\n\n${r.inviteLink}`);
    }),
  );
  const dirSync = h("button", { disabled: !overview.graphConfigured, title: overview.graphConfigured ? null : "Configure Microsoft Graph to enable this" }, "Import from Microsoft 365");
  dirSync.addEventListener(
    "click",
    busy(dirSync, inviteOut, async () => {
      const r = await api("/admin/directory/sync", { method: "POST" });
      await reload();
      alert(`Directory import finished: ${r.found} mailboxes found, ${r.created} new users added.`);
    }),
  );

  // Held mail
  const heldStatus = h("div");
  const heldRows = held.messages.map((m) => {
    const who = h("input", { type: "email", "aria-label": `Assign message for ${m.rcptTo} to user`, placeholder: "user's email address", style: "min-width:12rem" });
    const assign = h("button", { type: "submit" }, "Assign");
    const form = h("form", { class: "row" }, who, assign);
    form.addEventListener(
      "submit",
      busy(assign, heldStatus, async () => {
        await api(`/admin/held/${m.id}/assign`, { method: "POST", body: { email: who.value } });
        await reload();
      }),
    );
    return h("tr", {}, h("td", { class: "wrap" }, m.rcptTo), h("td", { class: "wrap" }, m.from.address), h("td", { class: "wrap" }, m.subject || "(no subject)"), h("td", {}, formatDate(m.date)), h("td", {}, form));
  });

  const table = (headers, rows, empty) =>
    rows.length
      ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, headers.map((t) => h("th", { scope: "col" }, t)))), h("tbody", {}, rows)))
      : h("p", { class: "muted" }, empty);

  shell("#/admin", [
    h("div", { class: "head" }, h("h1", {}, "Continuity control")),
    status,
    stateCard,
    h("div", { class: "grid" }, stat(`${overview.users.enrolled} / ${overview.users.total}`, "users enrolled"), stat(overview.sync.pending, "waiting to sync"), stat(overview.sync.synced, "synced to Microsoft 365"), stat(overview.sync.failed, "failed to sync"), stat(overview.held, "held for review")),
    h(
      "section",
      { class: "card section" },
      h("h2", {}, "Sync-back"),
      h("p", { class: "muted small", style: "margin-bottom:0.7rem" }, overview.graphConfigured ? "Copies mail held by Lifeboat into Exchange Online. Runs every 5 minutes while recovering." : "Microsoft Graph is not configured, so mail cannot be copied back yet."),
      syncStatus,
      runSync,
    ),
    h("section", { class: "card section" }, h("div", { class: "head" }, h("h2", {}, "Users"), h("span", { class: "spacer" }), dirSync), inviteOut, table(["Email", "Name", "Role", "Status", "Invite"], userRows, "No users yet. Add one below."), addForm),
    h("section", { class: "card section" }, h("h2", {}, "Held mail"), h("p", { class: "muted small", style: "margin-bottom:0.7rem" }, "Mail for addresses that match no user. Assign it to deliver it to that user's inbox."), heldStatus, table(["Sent to", "From", "Subject", "Received", "Assign to"], heldRows, "No held mail.")),
    h(
      "section",
      { class: "card section" },
      h("h2", {}, "Audit log"),
      table(["When", "Who", "Action", "Detail"], entries.map((e) => h("tr", {}, h("td", {}, formatDate(e.at, true)), h("td", { class: "wrap" }, e.actor), h("td", {}, e.action), h("td", { class: "wrap small" }, e.detail))), "Nothing recorded yet."),
    ),
  ]);
}

// ── Router ───────────────────────────────────────────────────────────────────

async function loadSession() {
  try {
    session = await api("/auth/me");
  } catch {
    session = null;
  }
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "invite" && parts[1]) return inviteView(parts[1]);
  if (!session) await loadSession();
  if (!session) return loginView();
  try {
    if (parts[0] === "sent") return await folderView("sent");
    if (parts[0] === "m" && parts[1]) return await messageView(parts[1]);
    if (parts[0] === "compose") return await composeView(parts[1] === "reply" ? parts[2] : null);
    if (parts[0] === "admin" && session.user.role === "admin") return await adminView();
    if (parts[0] === "login") return void (location.hash = "#/inbox");
    return await folderView("inbox");
  } catch (err) {
    if (!session) return loginView();
    shell("", [notice("error", err.message), h("a", { class: "btn", href: "#/inbox" }, "Go to inbox")]);
  }
}

window.addEventListener("hashchange", route);
route();
