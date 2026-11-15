export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  ASSETS: Fetcher;
  EMAIL: Mailer;

  MAIL_DOMAIN: string;
  APP_URL: string;
  DNS_MODE: string;
  UNKNOWN_RECIPIENT: string;
  AUTO_FAILOVER: string;
  PROBE_THRESHOLD: string;
  RETENTION_DAYS: string;
  GRAPH_TENANT_ID: string;
  GRAPH_CLIENT_ID: string;
  GRAPH_CANARY_MAILBOX: string;
  CF_ZONE_ID: string;

  ADMIN_TOKEN?: string;
  GRAPH_CLIENT_SECRET?: string;
  CF_API_TOKEN?: string;
}

/** The structured send API of the Cloudflare Email Sending binding. */
export interface Mailer {
  send(message: OutgoingEmail): Promise<{ messageId?: string }>;
}

export interface OutgoingEmail {
  from: string | { email: string; name?: string };
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: {
    content: string;
    filename: string;
    type: string;
    disposition: "attachment" | "inline";
  }[];
}

export type FailoverState = "standby" | "active" | "recovering";

export interface Person {
  address: string;
  name: string;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: "user" | "admin";
  password_hash: string | null;
  invite_hash: string | null;
  invite_expires_at: number | null;
  failed_logins: number;
  locked_until: number | null;
  disabled: number;
  created_at: number;
}

export interface MessageRow {
  id: string;
  user_id: string | null;
  rcpt_to: string;
  direction: "in" | "out";
  folder: "inbox" | "sent";
  incident_id: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  thread_id: string | null;
  from_addr: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  subject: string;
  snippet: string;
  sent_at: number;
  received_at: number;
  size: number;
  has_attachments: number;
  is_read: number;
  auth_results: string | null;
  sync_status: "pending" | "synced" | "failed" | "skipped";
  sync_attempts: number;
  sync_error: string | null;
  synced_at: number | null;
  graph_id: string | null;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  idx: number;
  filename: string;
  content_type: string;
  size: number;
  content_id: string | null;
  disposition: string;
}

export interface StoredBody {
  html: string | null;
  text: string | null;
}

export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const MAX_RECIPIENTS = 50;
