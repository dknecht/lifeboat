import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createUser } from "./auth";
import { getGraphToken, listDirectoryUsers } from "./graph";
import { AppConfig } from "./services";
import { audit, getSetting, getState, setSetting } from "./settings";
import { now } from "./util";

/** The outcome of the most recent directory import, kept in the settings table. */
const DirectoryRecord = Schema.Struct({ at: Schema.Number, found: Schema.Number, created: Schema.Number });

export type DirectoryRecord = typeof DirectoryRecord.Type;

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(DirectoryRecord));

export const getLastDirectoryImport = Effect.gen(function* () {
  return Option.getOrNull(decodeRecord(yield* getSetting("directory")));
});

/**
 * Reads the Microsoft 365 directory and creates a Lifeboat user for every mailbox that lacks one,
 * adding any new aliases to existing users. It never removes or disables anyone: a user missing
 * from one read is not evidence that they should lose their emergency access.
 */
export const importDirectory = Effect.gen(function* () {
  const directory = yield* getGraphToken.pipe(Effect.flatMap(listDirectoryUsers));
  const results = yield* Effect.forEach(directory, (entry) => createUser(entry));

  const record: DirectoryRecord = {
    at: now(),
    found: directory.length,
    created: results.filter((result) => result.created).length,
  };

  yield* setSetting("directory", JSON.stringify(record));

  return record;
});

/**
 * Runs the import on a schedule. It only runs in standby, when Microsoft 365 is expected to be
 * healthy, and a failure is recorded without stopping the rest of the periodic job.
 */
export const importDirectoryIfDue = Effect.gen(function* () {
  const config = yield* AppConfig;

  if (!config.graph || config.directorySyncHours <= 0) return;

  if ((yield* getState) !== "standby") return;

  const last = yield* getLastDirectoryImport;

  if (last && now() - last.at < config.directorySyncHours * 60 * 60 * 1000) return;

  const failed = (reason: string) => audit("system", "directory.sync_failed", reason);

  yield* importDirectory.pipe(
    Effect.flatMap((record) => audit("system", "directory.sync", `${record.found} found, ${record.created} new`)),
    Effect.catchTags({
      GraphError: (error) => failed(error.message),
      GraphNotConfigured: (error) => failed(error.message),
    }),
  );
});
