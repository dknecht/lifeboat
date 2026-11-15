import * as Schema from "effect/Schema";

// The shapes the Worker's API returns. Every response is decoded against one of these before the
// interface uses it, so a mismatch surfaces as one clear error instead of a broken screen.

export const FailoverState = Schema.Literals(["standby", "active", "recovering"]);

export type FailoverState = typeof FailoverState.Type;

/** How people sign in: Lifeboat passwords, Cloudflare Access, or passwords with Access for the admin console. */
export const AuthMode = Schema.Literals(["local", "access", "both"]);

export type AuthMode = typeof AuthMode.Type;

export const Status = Schema.Struct({ state: FailoverState, domain: Schema.String, authMode: AuthMode });

export const Person = Schema.Struct({ address: Schema.String, name: Schema.String });

export type Person = typeof Person.Type;

export const User = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  displayName: Schema.String,
  role: Schema.Literals(["user", "admin"]),
});

export type User = typeof User.Type;

export const Session = Schema.Struct({
  user: User,
  addresses: Schema.Array(Schema.String),
  state: FailoverState,
  authMode: AuthMode,
  /** Whether this visit is backed by a Lifeboat session or by Cloudflare Access. */
  via: Schema.Literals(["session", "access"]),
});

export type Session = typeof Session.Type;

export const Folder = Schema.Literals(["inbox", "sent"]);

export type Folder = typeof Folder.Type;

const summaryFields = {
  id: Schema.String,
  folder: Folder,
  from: Person,
  to: Schema.Array(Person),
  cc: Schema.Array(Person),
  rcptTo: Schema.String,
  subject: Schema.String,
  snippet: Schema.String,
  date: Schema.Number,
  hasAttachments: Schema.Boolean,
  isRead: Schema.Boolean,
  syncStatus: Schema.Literals(["pending", "synced", "failed", "skipped"]),
};

export const MessageSummary = Schema.Struct(summaryFields);

export type MessageSummary = typeof MessageSummary.Type;

export const MessageList = Schema.Struct({
  messages: Schema.Array(MessageSummary),
  nextCursor: Schema.NullOr(Schema.String),
  unread: Schema.Number,
});

export type MessageList = typeof MessageList.Type;

export const Attachment = Schema.Struct({
  idx: Schema.Number,
  filename: Schema.String,
  contentType: Schema.String,
  size: Schema.Number,
  inline: Schema.Boolean,
});

export type Attachment = typeof Attachment.Type;

export const Message = Schema.Struct({
  ...summaryFields,
  messageId: Schema.NullOr(Schema.String),
  body: Schema.Struct({ html: Schema.NullOr(Schema.String), text: Schema.NullOr(Schema.String) }),
  attachments: Schema.Array(Attachment),
});

export type Message = typeof Message.Type;

export const MessageEnvelope = Schema.Struct({ message: Message });

export const LoginResult = Schema.Struct({ user: User });
export const InviteAccepted = Schema.Struct({ email: Schema.String });
export const Sent = Schema.Struct({ id: Schema.String });
export const Done = Schema.Struct({ ok: Schema.Boolean });

// ── Admin ────────────────────────────────────────────────────────────────────

export const Overview = Schema.Struct({
  state: FailoverState,
  domain: Schema.String,
  dnsMode: Schema.Literals(["manual", "api"]),
  autoFailover: Schema.Boolean,
  graphConfigured: Schema.Boolean,
  probe: Schema.Struct({
    configured: Schema.Boolean,
    status: Schema.Literals(["healthy", "degraded", "unknown"]),
    lastCheckedAt: Schema.NullOr(Schema.Number),
    lastError: Schema.NullOr(Schema.String),
  }),
  incident: Schema.NullOr(
    Schema.Struct({ started_at: Schema.Number, started_by: Schema.String, reason: Schema.String }),
  ),
  sync: Schema.Struct({
    pending: Schema.Number,
    synced: Schema.Number,
    failed: Schema.Number,
    skipped: Schema.Number,
  }),
  users: Schema.Struct({ total: Schema.Number, enrolled: Schema.Number }),
  held: Schema.Number,
  instructions: Schema.Array(Schema.String),
});

export type Overview = typeof Overview.Type;

export const AdminUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  displayName: Schema.String,
  role: Schema.String,
  enrolled: Schema.Boolean,
  aliases: Schema.Array(Schema.String),
});

export type AdminUser = typeof AdminUser.Type;

export const AdminUsers = Schema.Struct({ users: Schema.Array(AdminUser) });
export const HeldMail = Schema.Struct({ messages: Schema.Array(MessageSummary) });

export const AuditEntry = Schema.Struct({
  id: Schema.Number,
  at: Schema.Number,
  actor: Schema.String,
  action: Schema.String,
  detail: Schema.String,
});

export type AuditEntry = typeof AuditEntry.Type;

export const AuditLog = Schema.Struct({ entries: Schema.Array(AuditEntry) });

/** `inviteLink` is null when Access is the only way to sign in, since there is no password to set. */
export const UserCreated = Schema.Struct({ user: User, inviteLink: Schema.NullOr(Schema.String) });

export const Invite = Schema.Struct({
  inviteLink: Schema.String,
  sent: Schema.Boolean,
  sendError: Schema.optional(Schema.String),
});

export const DirectoryImport = Schema.Struct({ found: Schema.Number, created: Schema.Number });
export const Transition = Schema.Struct({ state: FailoverState });

export const SyncRun = Schema.Struct({
  attempted: Schema.Number,
  synced: Schema.Number,
  failed: Schema.Number,
  remaining: Schema.Number,
  error: Schema.optional(Schema.String),
  state: FailoverState,
});

export const Failure = Schema.Struct({ error: Schema.String, code: Schema.optional(Schema.String) });
