import * as Effect from "effect/Effect";
import { GraphError, type GraphNotConfigured } from "./errors";
import { getGraphToken, importMessage, type GraphToken } from "./graph";
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

type PendingRow = MessageRow & { mailbox: string };

/** Loads one stored message and writes it into its owner's mailbox. */
const importStored = Effect.fn("importStored")(function* (token: GraphToken, row: PendingRow) {
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

/** A message Lifeboat cannot read back from its own storage is reported like any other failed import. */
const storageFailure = () =>
  Effect.fail(new GraphError({ message: "The stored message could not be read back from storage.", status: 0 }));

const syncOne = (token: GraphToken, row: PendingRow) =>
  importStored(token, row).pipe(Effect.catchTags({ DbError: storageFailure, BlobError: storageFailure }));

/** Writes a batch of pending messages into Exchange Online, oldest first. */
export const runSyncBatch = Effect.fn("runSyncBatch")(function* (limit = 10) {
  const db = yield* Db;
  const summary: SyncSummary = { attempted: 0, synced: 0, failed: 0, remaining: yield* countPending };

  if (!summary.remaining) return summary;

  const recordSynced = (row: MessageRow, graphId: string) =>
    db
      .run(
        sql(
          "UPDATE messages SET sync_status = 'synced', synced_at = ?, graph_id = ?, sync_error = NULL WHERE id = ?",
          now(),
          graphId,
          row.id,
        ),
      )
      .pipe(Effect.tap(() => Effect.sync(() => summary.synced++)));

  const recordFailed = (row: MessageRow, error: GraphError) => {
    const attempts = row.sync_attempts + 1;

    return db
      .run(
        sql(
          "UPDATE messages SET sync_attempts = ?, sync_error = ?, sync_status = ? WHERE id = ?",
          attempts,
          error.message.slice(0, 500),
          attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          row.id,
        ),
      )
      .pipe(Effect.tap(() => Effect.sync(() => summary.failed++)));
  };

  const batch = Effect.gen(function* () {
    const token = yield* getGraphToken;

    const rows = yield* db.all<PendingRow>(
      sql(
        `SELECT m.*, u.email AS mailbox FROM messages m JOIN users u ON u.id = m.user_id
         WHERE m.sync_status = 'pending' ORDER BY m.received_at LIMIT ?`,
        limit,
      ),
    );

    // One message failing must not stop the rest of the batch.
    for (const row of rows) {
      summary.attempted++;
      yield* syncOne(token, row).pipe(
        Effect.matchEffect({
          onSuccess: (graphId) => recordSynced(row, graphId),
          onFailure: (error) => recordFailed(row, error),
        }),
      );
    }

    summary.remaining = yield* countPending;

    return summary;
  });

  // Without a token nothing can be attempted, so the batch reports why and leaves the queue as it is.
  const unavailable = (error: GraphError | GraphNotConfigured) => Effect.succeed({ ...summary, error: error.message });

  return yield* batch.pipe(Effect.catchTags({ GraphError: unavailable, GraphNotConfigured: unavailable }));
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
