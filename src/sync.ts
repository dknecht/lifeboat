import * as Effect from "effect/Effect";
import { GraphError } from "./errors";
import { getGraphToken, importMessage } from "./graph";
import { AppConfig, Blobs, Db, sql } from "./services";
import { audit, getState, setSetting } from "./settings";
import type { AttachmentRow, MessageRow, StoredBody } from "./types";
import { now } from "./util";

const MAX_ATTEMPTS = 8;

export interface SyncSummary {
  attempted: number;
  synced: number;
  failed: number;
  remaining: number;
  /** Set when the batch could not start at all, for example because Graph is unreachable. */
  error?: string;
}

export const countPending = Effect.gen(function* () {
  const db = yield* Db;
  const row = yield* db.first<{ n: number }>(sql("SELECT COUNT(*) AS n FROM messages WHERE sync_status = 'pending'"));
  return row?.n ?? 0;
});

/** Writes one stored message into its owner's mailbox. */
const syncOne = Effect.fn("syncOne")(function* (
  token: Effect.Success<typeof getGraphToken>,
  row: MessageRow & { mailbox: string },
) {
  const db = yield* Db;
  const blobs = yield* Blobs;
  const body = (yield* blobs.getJson<StoredBody>(`body/${row.id}.json`)) ?? { html: null, text: row.snippet };
  const attachments = yield* db.all<AttachmentRow>(
    sql("SELECT * FROM attachments WHERE message_id = ? ORDER BY idx", row.id),
  );
  return yield* importMessage(token, {
    mailbox: row.mailbox,
    row,
    body,
    attachments,
    loadAttachment: (att) =>
      blobs
        .getBytes(`att/${row.id}/${att.idx}`)
        .pipe(
          Effect.flatMap((bytes) =>
            bytes
              ? Effect.succeed(bytes)
              : Effect.fail(new GraphError({ message: `Attachment ${att.idx} is missing from storage.`, status: 0 })),
          ),
        ),
  });
});

/** Writes a batch of pending messages into Exchange Online, oldest first. */
export const runSyncBatch = Effect.fn("runSyncBatch")(function* (limit = 10) {
  const db = yield* Db;
  const summary: SyncSummary = { attempted: 0, synced: 0, failed: 0, remaining: yield* countPending };
  if (!summary.remaining) return summary;

  const token = yield* getGraphToken.pipe(Effect.result);
  if (token._tag === "Failure") return { ...summary, error: token.failure.message };

  const rows = yield* db.all<MessageRow & { mailbox: string }>(
    sql(
      `SELECT m.*, u.email AS mailbox FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.sync_status = 'pending' ORDER BY m.received_at LIMIT ?`,
      limit,
    ),
  );

  // One message failing must not stop the rest of the batch.
  for (const row of rows) {
    summary.attempted++;
    const outcome = yield* syncOne(token.success, row).pipe(Effect.result);
    if (outcome._tag === "Success") {
      yield* db.run(
        sql(
          "UPDATE messages SET sync_status = 'synced', synced_at = ?, graph_id = ?, sync_error = NULL WHERE id = ?",
          now(),
          outcome.success,
          row.id,
        ),
      );
      summary.synced++;
    } else {
      const attempts = row.sync_attempts + 1;
      const error = outcome.failure;
      const message = error._tag === "GraphError" ? error.message : `Storage error (${error._tag}).`;
      yield* db.run(
        sql(
          "UPDATE messages SET sync_attempts = ?, sync_error = ?, sync_status = ? WHERE id = ?",
          attempts,
          message.slice(0, 500),
          attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          row.id,
        ),
      );
      summary.failed++;
    }
  }

  summary.remaining = yield* countPending;
  return summary;
});

/** Returns to standby once recovery has drained the queue. */
export const finishRecoveryIfDrained = Effect.gen(function* () {
  if ((yield* getState) !== "recovering") return false;
  if ((yield* countPending) > 0) return false;
  yield* setSetting("state", "standby");
  yield* audit("system", "failover.standby", "Sync-back finished; returned to standby.");
  return true;
});

/** Deletes messages that were synced more than the retention window ago. Unsynced mail is never deleted. */
export const retentionSweep = Effect.fn("retentionSweep")(function* (limit = 50) {
  const db = yield* Db;
  const blobs = yield* Blobs;
  const { retentionDays } = yield* AppConfig;
  const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000;
  const rows = yield* db.all<{ id: string }>(
    sql("SELECT id FROM messages WHERE sync_status = 'synced' AND synced_at < ? LIMIT ?", cutoff, limit),
  );
  for (const { id } of rows) {
    const attachmentKeys = yield* blobs.list(`att/${id}/`);
    yield* blobs.delete([`raw/${id}.eml`, `body/${id}.json`, ...attachmentKeys]);
    yield* db.batch([
      sql("DELETE FROM attachments WHERE message_id = ?", id),
      sql("DELETE FROM messages WHERE id = ?", id),
    ]);
  }
  return rows.length;
});
