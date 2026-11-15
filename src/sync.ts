import { audit, getState, setSetting } from "./db";
import { getGraphToken, graphConfigured, importMessage } from "./graph";
import type { AttachmentRow, Env, MessageRow, StoredBody } from "./types";
import { intVar, now } from "./util";

const MAX_ATTEMPTS = 8;

export interface SyncSummary {
  attempted: number;
  synced: number;
  failed: number;
  remaining: number;
  error?: string;
}

export async function countPending(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE sync_status = 'pending'",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Writes a batch of pending messages into Exchange Online, oldest first. */
export async function runSyncBatch(env: Env, limit = 10): Promise<SyncSummary> {
  const summary: SyncSummary = { attempted: 0, synced: 0, failed: 0, remaining: await countPending(env) };
  if (!summary.remaining) return summary;
  if (!graphConfigured(env)) return { ...summary, error: "Microsoft Graph is not configured." };

  let token: string;
  try {
    token = await getGraphToken(env);
  } catch (err) {
    return { ...summary, error: (err as Error).message };
  }

  const { results } = await env.DB.prepare(
    `SELECT m.*, u.email AS mailbox FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.sync_status = 'pending' ORDER BY m.received_at LIMIT ?`,
  )
    .bind(limit)
    .all<MessageRow & { mailbox: string }>();

  for (const row of results) {
    summary.attempted++;
    try {
      const bodyObject = await env.MAIL.get(`body/${row.id}.json`);
      const body: StoredBody = bodyObject
        ? await bodyObject.json<StoredBody>()
        : { html: null, text: row.snippet };
      const attachments = (
        await env.DB.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY idx")
          .bind(row.id)
          .all<AttachmentRow>()
      ).results;

      const graphId = await importMessage(token, {
        mailbox: row.mailbox,
        row,
        body,
        attachments,
        loadAttachment: async (att) => {
          const object = await env.MAIL.get(`att/${row.id}/${att.idx}`);
          if (!object) throw new Error(`Attachment ${att.idx} is missing from storage.`);
          return new Uint8Array(await object.arrayBuffer());
        },
      });
      await env.DB.prepare(
        "UPDATE messages SET sync_status = 'synced', synced_at = ?, graph_id = ?, sync_error = NULL WHERE id = ?",
      )
        .bind(now(), graphId, row.id)
        .run();
      summary.synced++;
    } catch (err) {
      const attempts = row.sync_attempts + 1;
      await env.DB.prepare(
        "UPDATE messages SET sync_attempts = ?, sync_error = ?, sync_status = ? WHERE id = ?",
      )
        .bind(attempts, (err as Error).message.slice(0, 500), attempts >= MAX_ATTEMPTS ? "failed" : "pending", row.id)
        .run();
      summary.failed++;
    }
  }

  summary.remaining = await countPending(env);
  return summary;
}

/** Returns to standby once recovery has drained the queue. */
export async function finishRecoveryIfDrained(env: Env): Promise<boolean> {
  if ((await getState(env)) !== "recovering") return false;
  if ((await countPending(env)) > 0) return false;
  await setSetting(env, "state", "standby");
  await audit(env, "system", "failover.standby", "Sync-back finished; returned to standby.");
  return true;
}

/** Deletes messages that were synced more than RETENTION_DAYS ago. Unsynced mail is never deleted. */
export async function retentionSweep(env: Env, limit = 50): Promise<number> {
  const cutoff = now() - intVar(env.RETENTION_DAYS, 30) * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    "SELECT id FROM messages WHERE sync_status = 'synced' AND synced_at < ? LIMIT ?",
  )
    .bind(cutoff, limit)
    .all<{ id: string }>();
  for (const { id } of results) {
    const keys = [`raw/${id}.eml`, `body/${id}.json`];
    const listed = await env.MAIL.list({ prefix: `att/${id}/` });
    keys.push(...listed.objects.map((o) => o.key));
    await env.MAIL.delete(keys);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(id),
      env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id),
    ]);
  }
  return results.length;
}
