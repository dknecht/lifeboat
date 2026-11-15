import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NetworkError } from "./errors";

/**
 * Performs an outbound HTTP request.
 *
 * Only a failure to get any response is an error here; callers decide what a non-2xx status means.
 * The request is aborted if the calling fiber is interrupted.
 */
export const request = (url: string, init: RequestInit = {}): Effect.Effect<Response, NetworkError> =>
  Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal }),
    catch: (cause) => new NetworkError({ url, cause }),
  });

/** Reads a response body as JSON and decodes it, yielding null when it is empty or does not match. */
export const readJson = <S extends Schema.Top>(response: Response, schema: S) =>
  Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.orElseSucceed(() => null),
  );

export const readText = (response: Response): Effect.Effect<string> =>
  Effect.promise(() => response.text().catch(() => ""));
