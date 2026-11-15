import * as Effect from "effect/Effect";
import { Db, sql } from "./services";
import type { FailoverState } from "./types";
import { now } from "./util";

export const getSetting = Effect.fn("getSetting")(function* (key: string) {
  const db = yield* Db;
  const row = yield* db.first<{ value: string }>(sql("SELECT value FROM settings WHERE key = ?", key));
  return row?.value ?? null;
});

export const setSetting = Effect.fn("setSetting")(function* (key: string, value: string) {
  const db = yield* Db;
  yield* db.run(
    sql(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    ),
  );
});

export const deleteSetting = Effect.fn("deleteSetting")(function* (key: string) {
  const db = yield* Db;
  yield* db.run(sql("DELETE FROM settings WHERE key = ?", key));
});

export const getState = Effect.gen(function* () {
  const value = yield* getSetting("state");
  return (value === "active" || value === "recovering" ? value : "standby") as FailoverState;
});

export const getOpenIncidentId = Effect.gen(function* () {
  const db = yield* Db;
  const row = yield* db.first<{ id: string }>(
    sql("SELECT id FROM incidents WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1"),
  );
  return row?.id ?? null;
});

export const audit = Effect.fn("audit")(function* (actor: string, action: string, detail = "") {
  const db = yield* Db;
  yield* db.run(
    sql(
      "INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)",
      now(),
      actor,
      action,
      detail.slice(0, 2000),
    ),
  );
});
