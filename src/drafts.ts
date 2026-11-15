import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { badRequest } from "./errors";
import { Db, sql } from "./services";
import type { UserRow } from "./types";
import { now } from "./util";

const MAX_DRAFT_BODY = 1_000_000;
const MAX_DRAFTS_LISTED = 100;

/** The body of `PUT /api/drafts/:id`. Recipients are kept as typed, since a draft may be half-written. */
export const DraftInput = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  cc: Schema.String,
  subject: Schema.String,
  text: Schema.String,
  inReplyToId: Schema.optional(Schema.NullOr(Schema.String)),
});

export type DraftInput = typeof DraftInput.Type;

interface DraftRow {
  id: string;
  from_addr: string;
  to_text: string;
  cc_text: string;
  subject: string;
  body_text: string;
  in_reply_to_id: string | null;
  updated_at: number;
}

const view = (row: DraftRow) => ({
  id: row.id,
  from: row.from_addr,
  to: row.to_text,
  cc: row.cc_text,
  subject: row.subject,
  text: row.body_text,
  inReplyToId: row.in_reply_to_id,
  updatedAt: row.updated_at,
});

export const listDrafts = Effect.fn("listDrafts")(function* (user: UserRow) {
  const db = yield* Db;

  const rows = yield* db.all<DraftRow>(
    sql("SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?", user.id, MAX_DRAFTS_LISTED),
  );

  return rows.map(view);
});

/** Draft IDs are chosen by the client, so that it can keep saving the same draft without a round trip first. */
const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Creates the draft, or replaces it if this user already has one with that ID. */
export const saveDraft = Effect.fn("saveDraft")(function* (user: UserRow, id: string, input: DraftInput) {
  const db = yield* Db;

  if (!VALID_ID.test(id)) return yield* badRequest("The draft could not be saved.");

  if (input.text.length > MAX_DRAFT_BODY) return yield* badRequest("The draft is too long to save.");

  // The WHERE clause on the update keeps one user from overwriting another's draft by guessing its ID.
  const changed = yield* db.run(
    sql(
      `INSERT INTO drafts (id, user_id, from_addr, to_text, cc_text, subject, body_text, in_reply_to_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET from_addr = excluded.from_addr, to_text = excluded.to_text,
         cc_text = excluded.cc_text, subject = excluded.subject, body_text = excluded.body_text,
         in_reply_to_id = excluded.in_reply_to_id, updated_at = excluded.updated_at
       WHERE drafts.user_id = excluded.user_id`,
      id,
      user.id,
      input.from.slice(0, 254),
      input.to.slice(0, 4000),
      input.cc.slice(0, 4000),
      input.subject.slice(0, 998),
      input.text,
      input.inReplyToId ?? null,
      now(),
    ),
  );

  if (!changed) return yield* badRequest("The draft could not be saved.");

  return { id };
});

export const deleteDraft = Effect.fn("deleteDraft")(function* (user: UserRow, id: string) {
  const db = yield* Db;

  yield* db.run(sql("DELETE FROM drafts WHERE id = ? AND user_id = ?", id, user.id));
});
