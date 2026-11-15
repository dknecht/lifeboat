import * as Effect from "effect/Effect";
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

/** Reads a response body as JSON, yielding null when it is empty or malformed. */
export const readJson = <T>(response: Response): Effect.Effect<T | null> =>
  Effect.promise(() => response.json().then((v) => v as T, () => null));

export const readText = (response: Response): Effect.Effect<string> =>
  Effect.promise(() => response.text().catch(() => ""));
