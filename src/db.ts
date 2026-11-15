import type { Env, FailoverState } from "./types";
import { now } from "./util";

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, value)
    .run();
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

export async function getState(env: Env): Promise<FailoverState> {
  const value = await getSetting(env, "state");
  return value === "active" || value === "recovering" ? value : "standby";
}

export async function getOpenIncidentId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT id FROM incidents WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
  ).first<{ id: string }>();
  return row?.id ?? null;
}

export async function audit(env: Env, actor: string, action: string, detail = ""): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)")
    .bind(now(), actor, action, detail.slice(0, 2000))
    .run();
}
